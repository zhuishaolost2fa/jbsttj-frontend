/**
 * 分片上传相关常量。
 *
 * 对接后端 jbsttj-backend 的 `/api/v1/uploads` 系列接口（task_id 驱动的四步流程）。
 * 前端不持有任何 AccessKey，全部通过后端签发的预签名 URL 直传 OSS。
 *
 * ⚠️ 分片大小由**服务端**决定（init 响应里的 chunk_size），前端必须按它切片。
 *    本文件里的 CHUNK_SIZE 仅作为「期望值」发给服务端，服务端可能上调（比如
 *    文件过大导致分片数超过 10000 时）。切片计算一律用服务端返回值。
 */

/** 后端接口基址统一收敛到 constants/api.ts，这里重新导出保持既有引用可用 */
export { API_BASE_URL } from './api'

/** 上传类型：临时文件写入 temp/ 前缀，受 OSS 生命周期规则自动清理 */
export type UploadType = 'temporary' | 'permanent'

/**
 * 接口路径。带路径参数的用函数构造，避免各处手拼字符串。
 * 对应后端 app/api/v1/uploads.py 与 files.py。
 */
export const API_PATH = {
  /** 初始化上传（永久文件，写入 uploads/ 前缀） */
  init: '/uploads/init',
  /** 初始化上传（临时文件，写入 temp/ 前缀，受生命周期规则清理） */
  tempInit: '/uploads/temp/init',
  /** 批量签发分片直传地址 */
  presign: (taskId: string) => `/uploads/${taskId}/presign`,
  /** 批量上报分片上传结果 */
  reportParts: (taskId: string) => `/uploads/${taskId}/parts/callback`,
  /** 查询任务状态（OSS 侧实际落盘的分片） */
  taskStatus: (taskId: string) => `/uploads/${taskId}`,
  /** 合并分片 */
  complete: (taskId: string) => `/uploads/${taskId}/complete`,
  /** 取消任务并清理 OSS 碎片（DELETE，返回 204） */
  abort: (taskId: string) => `/uploads/${taskId}`,
  /** 获取文件临时下载/预览地址 */
  downloadUrl: (fileId: string) => `/files/${fileId}/download-url`,
  /** 小文件 multipart 整文件经服务端中转（小程序端唯一可用通道） */
  simpleUpload: '/files/simple-upload',
} as const

/**
 * 期望分片大小 5MB，与后端 upload_chunk_size 默认值一致。
 * OSS 约束：除最后一片外每片 >= 100KB，单次上传最多 10000 片。
 * 最终以服务端返回的 chunk_size 为准。
 */
export const CHUNK_SIZE = 5 * 1024 * 1024

/**
 * 并发上传数。浏览器对同一域名的并发连接数上限通常是 6，
 * 留出余量给签名接口，取 4 比较稳。
 */
export const UPLOAD_CONCURRENCY = 4

/** 单片失败最大重试次数（指数退避） */
export const MAX_RETRY_PER_PART = 3

/**
 * 每次向后端换取签名 URL 的分片数量。
 * 后端 max_presign_batch 上限 200，签名有效期 presign_expire_seconds 默认 1 小时。
 * 分批签而不是一次性签完，避免大文件传到后半程时签名已过期。
 */
export const SIGN_BATCH_SIZE = 50

/**
 * complete 遇到「缺片」时的自愈轮数。
 * 后端会重新列举 OSS 分片做完整性校验，返回 409 + missing_parts。
 * 补传缺失分片后重新 complete，最多重复这么多轮。
 */
export const MAX_COMPLETE_REPAIR_ROUNDS = 2

/** 分片直传（H5）允许的文件大小上限 500MB（业务预期 400MB 左右，留 25% 余量） */
export const MAX_FILE_SIZE = 500 * 1024 * 1024

/**
 * simple-upload 通道的文件大小上限 20MB。
 *
 * 与后端 `app/api/v1/files.py::SIMPLE_UPLOAD_LIMIT` 严格对齐 —— 那是 multipart
 * 整文件中转的硬上限（防止应用服务器内存被打爆），前端超了只会被 400 拦下，
 * 不如提前拦下来给句人话。
 *
 * 小程序端只能走这条通道（没有 XHR、也不能直连 OSS），所以这就是小程序端的上限。
 * DM 手册是 Word 文档，实际多在 10MB 以内，够用。
 */
export const SIMPLE_UPLOAD_MAX_SIZE = 20 * 1024 * 1024

/**
 * DM 指南允许导入的格式白名单。
 *
 * 上传引擎（ossMultipartUpload）本身不限制文件类型，这里的白名单只用于
 * 前端「文件选择框」的 accept 提示 + 用户选完之后的格式校验。
 *
 * ⚠️ 仅支持 Word（.doc / .docx）文档，不再接受 PDF。
 *   新增 / 调整格式时，需要同步改动三处：
 *   1. 本白名单（exts / mimes / label）
 *   2. filePicker 的校验与 content-type 推导
 *   3. 后端 content_type 白名单（jbsttj-backend 若不放开会 400 拒绝 init）
 */
export const DM_GUIDE_ACCEPT = {
  /** 文件选择框 accept 用的后缀 */
  exts: ['.doc', '.docx'] as const,
  /** 文件选择框 accept 用的 MIME（部分系统选出来的文件没有 type，后缀名才是可靠依据） */
  mimes: [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ] as const,
  /** 给用户看的格式说明 */
  label: 'Word（.doc .docx）',
} as const

/**
 * DM 指南按「临时文件」上传：对象写入 temp/ 前缀，
 * 由运维在 OSS Bucket 上对该前缀配置「7 天后删除」的生命周期规则。
 * 前端无法也不应该设置单个对象的过期时间。
 */
export const DM_GUIDE_UPLOAD_TYPE: UploadType = 'temporary'

/** 下载链接有效期（秒），后端上限 86400 */
export const DOWNLOAD_URL_EXPIRES = 7200
