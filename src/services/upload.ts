/**
 * 分片上传接口层。
 *
 * 一比一映射后端 app/api/v1/uploads.py + files.py 的契约，
 * 字段刻意保持 snake_case 与后端 pydantic 模型一致 —— 后端改字段时
 * TypeScript 能立刻在编译期定位到所有受影响的地方。
 *
 * 上层（ossMultipartUpload）负责把它转成 camelCase 的领域模型。
 */

import { get, request } from './request'
import { API_PATH, DOWNLOAD_URL_EXPIRES, type UploadType } from '../constants/upload'

/* -------------------------------------------------------------------------- */
/*                              后端契约类型                                    */
/* -------------------------------------------------------------------------- */

/** 对应后端 schemas/upload.py::UploadedPart */
export interface ApiUploadedPart {
  part_number: number
  /** OSS 分片 ETag，后端已剥掉双引号 */
  etag: string
  size: number
}

/** 对应后端 schemas/file.py::FileInfo */
export interface ApiFileInfo {
  id: string
  filename: string
  object_key: string
  bucket: string
  content_type?: string | null
  file_size: number
  file_hash?: string | null
  etag?: string | null
  metadata?: Record<string, unknown>
  created_at?: string | null
}

/** 对应后端 InitUploadResponse */
export interface ApiInitUploadResponse {
  task_id: string
  object_key: string
  /** 秒传命中时为空 */
  upload_id?: string | null
  /** 服务端最终决定的分片大小，前端必须按此切片 */
  chunk_size: number
  total_parts: number
  file_size: number
  status: string
  /** true 表示命中秒传，无需上传任何数据 */
  instant: boolean
  /** true 表示命中断点续传 */
  resumed: boolean
  upload_type: string
  /** 已上传成功的分片，需跳过 */
  uploaded_parts: ApiUploadedPart[]
  /** 秒传时直接返回文件信息 */
  file?: ApiFileInfo | null
  /**
   * ⚠️ 仅作信息展示，**不要**用它设置 PUT 请求头。
   * 后端 presign_part 调用 OSS SDK 时没有传 content_type，签名里不含该头，
   * 请求一旦带上 Content-Type 就会 SignatureDoesNotMatch(403)。
   */
  part_content_type: string
}

/** 对应后端 PresignedPart */
export interface ApiPresignedPart {
  part_number: number
  url: string
}

/** 对应后端 PresignPartsResponse */
export interface ApiPresignPartsResponse {
  task_id: string
  object_key: string
  upload_id: string
  expires_in: number
  part_content_type: string
  parts: ApiPresignedPart[]
}

/** 对应后端 TaskStatusResponse */
export interface ApiTaskStatusResponse {
  task_id: string
  object_key: string
  upload_id?: string | null
  filename: string
  file_size: number
  chunk_size: number
  total_parts: number
  status: 'uploading' | 'completed' | 'aborted' | 'failed' | string
  uploaded_parts: ApiUploadedPart[]
  uploaded_bytes: number
  progress: number
  error_message?: string | null
}

/** 对应后端 CompleteUploadResponse */
export interface ApiCompleteUploadResponse {
  task_id: string
  file: ApiFileInfo
  message: string
}

/** 对应后端 DownloadUrlResponse */
export interface ApiDownloadUrlResponse {
  file_id: string
  filename: string
  url: string
  expires_in: number
  inline: boolean
}

export interface InitUploadParams {
  filename: string
  fileSize: number
  contentType?: string
  /** 内容指纹，秒传与断点续传的匹配依据；不传则两者都不会命中 */
  fileHash?: string
  /** 期望分片大小，服务端可能上调 */
  chunkSize?: number
  uploadType?: UploadType
  metadata?: Record<string, unknown>
}

/* -------------------------------------------------------------------------- */
/*                                  接口调用                                    */
/* -------------------------------------------------------------------------- */

/**
 * 1. 初始化上传任务。
 *
 * 三种结果：
 *   - instant=true  秒传命中，file 字段直接可用
 *   - resumed=true  断点续传，uploaded_parts 里的分片跳过
 *   - 都为 false    全新任务，需要上传全部 total_parts 片
 */
export function initUpload(params: InitUploadParams): Promise<ApiInitUploadResponse> {
  const uploadType: UploadType = params.uploadType ?? 'permanent'
  return request<ApiInitUploadResponse>({
    // temporary 走独立入口，对象写入 temp/ 前缀以命中生命周期清理规则
    url: uploadType === 'temporary' ? API_PATH.tempInit : API_PATH.init,
    data: {
      filename: params.filename,
      file_size: params.fileSize,
      content_type: params.contentType,
      file_hash: params.fileHash,
      chunk_size: params.chunkSize,
      upload_type: uploadType,
      metadata: params.metadata,
    },
    // 秒传/续传要访问 OSS 做 head_object / list_parts，给足时间
    timeout: 60000,
  })
}

/** 2. 批量换取分片预签名 PUT 地址（后端单次上限 200 片） */
export async function presignParts(
  taskId: string,
  partNumbers: number[],
  expires?: number
): Promise<ApiPresignedPart[]> {
  const res = await request<ApiPresignPartsResponse>({
    url: API_PATH.presign(taskId),
    data: { part_numbers: partNumbers, expires },
    timeout: 60000,
  })
  return res.parts
}

/**
 * 3. 批量上报已完成的分片。
 *
 * 只用于进度展示与审计 —— 合并时后端以 OSS 实际列举结果为准，
 * 所以这个接口失败不影响上传正确性，调用方可以静默忽略。
 */
export function reportParts(
  taskId: string,
  parts: ApiUploadedPart[]
): Promise<{ message: string }> {
  return request<{ message: string }>({
    url: API_PATH.reportParts(taskId),
    data: { parts },
  })
}

/** 4. 查询任务状态。返回 OSS 端实际落盘的分片，断网重连后据此续传 */
export function getTaskStatus(taskId: string): Promise<ApiTaskStatusResponse> {
  return get<ApiTaskStatusResponse>(API_PATH.taskStatus(taskId), undefined, 60000)
}

/**
 * 5. 合并分片。
 *
 * 不传 parts —— 后端会重新列举 OSS 分片，比前端上报的更可靠，
 * 传了反而可能因为 ETag 大小写/引号差异触发 etag_mismatch 误报。
 *
 * 缺片时返回 409 + code=incomplete_parts + details.missing_parts。
 * 接口幂等，重复调用返回同一结果。
 */
export function completeUpload(taskId: string): Promise<ApiCompleteUploadResponse> {
  return request<ApiCompleteUploadResponse>({
    url: API_PATH.complete(taskId),
    data: { verify_size: true },
    // 大文件合并 OSS 侧耗时较久
    timeout: 180000,
  })
}

/** 6. 取消任务，同时清理 OSS 碎片（避免碎片长期计费）。返回 204 */
export function abortUpload(taskId: string): Promise<void> {
  return request<void>({
    url: API_PATH.abort(taskId),
    method: 'DELETE',
  })
}

/** 7. 获取文件的临时访问地址（合并接口本身不返回 URL，需要单独换） */
export async function fetchDownloadUrl(
  fileId: string,
  options: { inline?: boolean; expires?: number } = {}
): Promise<ApiDownloadUrlResponse> {
  const { inline = true, expires = DOWNLOAD_URL_EXPIRES } = options
  return get<ApiDownloadUrlResponse>(API_PATH.downloadUrl(fileId), {
    inline,
    expires,
  })
}
