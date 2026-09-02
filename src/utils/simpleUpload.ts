/**
 * 整文件中转上传引擎（对接后端 `POST /files/simple-upload`）。
 *
 * ## 为什么需要它
 *
 * 小程序端两条路都走不通：
 *   1. **分片直传 OSS** —— 需要 `XMLHttpRequest` 发 PUT 并读响应头 `ETag`，
 *      小程序没有 XHR；而且直传域名是阿里云 OSS，得单独配进小程序
 *      「服务器域名 → request 合法域名」白名单。
 *   2. **代理分片** `PUT /uploads/{id}/parts/{n}` —— 得用 `Taro.request` 传
 *      ArrayBuffer，微信对大数据量请求体支持不稳，且 `request` 没有上传进度回调。
 *
 * 于是走第三条：整文件 multipart 交给自家后端，后端写 OSS 并落 files 表。
 * `Taro.uploadFile` 是小程序一等公民，有真实上传进度、可 abort，
 * 走的还是已经在白名单里的后端域名。
 *
 * ## 代价
 *
 * 数据要经过应用服务器中转，占用服务端带宽 —— 所以后端把上限压在 20MB。
 * DM 手册是 Word 文档，实际多在 10MB 以内，这个上限够用。
 *
 * ## 与分片链路的差异
 *
 * 秒传由后端负责（它对整份内容算全量 SHA-256 后查重），前端不需要算指纹，
 * 也拿不到「是否命中秒传」的标记，统一按真实上传回报。
 */

import Taro from '@tarojs/taro'
import { buildApiUrl } from '../constants/api'
import { API_PATH } from '../constants/upload'
import { tokenManager } from '../services/tokenManager'
import { fetchDownloadUrl } from '../services/upload'
import type { PickedFile } from './filePicker'
import { UploadAbortError, type UploadProgress, type UploadResult, type UploadStage } from './ossMultipartUpload'

export interface SimpleUploadOptions {
  onProgress?: (progress: UploadProgress) => void
  onStage?: (stage: UploadStage) => void
  signal?: AbortSignal
  /** temporary 写入 temp/ 前缀受 OSS 生命周期清理，permanent 长期保留 */
  uploadType?: 'temporary' | 'permanent'
}

interface SimpleUploadResponse {
  file: {
    id: string
    filename?: string | null
    object_key: string
    file_size: number
    content_type?: string | null
  }
  message?: string
}

/** 后端返回的是字符串，需要自己拆包；失败体统一是 { error: { code, message } } */
function parseResponse(
  raw: string,
  statusCode: number
): SimpleUploadResponse {
  let body: any = null
  try {
    body = JSON.parse(raw)
  } catch {
    /* 非 JSON（如网关错误页）走下面的兜底 */
  }

  if (statusCode < 200 || statusCode >= 300 || !body?.file) {
    const err = body?.error
    throw new Error(
      err?.message || `导入失败（HTTP ${statusCode}）${raw.slice(0, 120)}`
    )
  }
  return body as SimpleUploadResponse
}

/**
 * 整文件上传。stage 序列与分片链路对齐（hashing / merging 是瞬时的），
 * 这样 ImportDmGuide 的五步指示器不用为两条链路写两套。
 */
export async function simpleUploadToOss(
  file: PickedFile,
  options: SimpleUploadOptions = {}
): Promise<UploadResult> {
  const { onProgress, onStage, signal, uploadType = 'temporary' } = options

  if (!file.path) {
    throw new Error('缺少文件本地路径，无法上传')
  }

  // 校验/准备：这一条链路不需要前端算指纹，瞬时推进
  onStage?.('hashing')
  if (signal?.aborted) throw new UploadAbortError()
  onStage?.('preparing')

  // getAccessToken 在 token 临期（<5 分钟）时会先续签，所以这里拿到的一定是新鲜 token；
  // 返回 null 只可能是会话真的没了（刷新失败 / 被清掉）。
  // 必须提前拦：uploadFile 不走 services/request.ts，没有 401 重放与会话清理，
  // 硬发只会拿到一个用户看不懂的 401，还让 UI 继续停在「已登录」状态。
  const token = await tokenManager.getAccessToken()
  if (!token) {
    throw new Error('登录状态已失效，请重新登录后重试')
  }

  const task = Taro.uploadFile({
    url: buildApiUrl(API_PATH.simpleUpload),
    filePath: file.path,
    // 后端 FastAPI 的形参名就是 file
    name: 'file',
    // formData 只能是 string 值，微信会把它编进 multipart 的各个 part
    formData: {
      filename: file.name,
      upload_type: uploadType,
    },
    header: { Authorization: `Bearer ${token}` },
    timeout: 5 * 60 * 1000,
  })

  onStage?.('uploading')

  // 取消：把 AbortSignal 转接到 UploadTask.abort()
  let aborted = false
  const onAbort = () => {
    aborted = true
    try {
      task.abort()
    } catch {
      /* 任务可能已经结束，忽略 */
    }
  }
  if (signal?.aborted) {
    onAbort()
    throw new UploadAbortError()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  const startedAt = Date.now()
  task.onProgressUpdate((res) => {
    const loaded = Math.min(res.totalBytesSent, file.size)
    const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000)
    const speed = loaded / elapsed
    onProgress?.({
      percent: Math.min(100, res.progress),
      loaded,
      total: file.size,
      // 整文件是一次请求，分片维度退化为 0/1，UI 靠百分比驱动
      uploadedParts: res.progress >= 100 ? 1 : 0,
      totalParts: 1,
      speed,
      // -1 = 无法估算（formatDuration 渲染成「--」）。
      // 别用 0 兜底：上传刚开始时速度还没测出来，显示「剩余 0 秒」很荒谬。
      remainSeconds:
        speed > 1024 && res.progress < 100
          ? Math.ceil((file.size - loaded) / speed)
          : -1,
    })
  })

  try {
    const res = await task
    const body = parseResponse(res.data, res.statusCode)

    onProgress?.({
      percent: 100,
      loaded: file.size,
      total: file.size,
      uploadedParts: 1,
      totalParts: 1,
      speed: 0,
      remainSeconds: 0,
    })

    // 合并步骤在服务端上传时就一并完成了，这里只是让指示器走完
    onStage?.('merging')
    onStage?.('finishing')

    const link = await fetchDownloadUrl(body.file.id)

    onStage?.('done')
    return {
      fileId: body.file.id,
      fileName: body.file.filename || file.name,
      objectKey: body.file.object_key,
      fileSize: body.file.file_size,
      fileUrl: link.url,
      urlExpiresIn: link.expires_in,
      // 后端对整份内容算哈希查重，命中与否对前端透明，统一按真实上传处理
      instant: false,
    }
  } catch (err: any) {
    if (aborted || signal?.aborted) {
      onStage?.('canceled')
      throw new UploadAbortError()
    }
    onStage?.('error')
    const rawMsg: string = err?.errMsg || err?.message || ''
    // 「域名不在 uploadFile 合法域名白名单」是上线最容易踩的坑，
    // 微信原话（url not in domain list）对普通用户毫无意义，翻成能行动的提示
    if (/domain/i.test(rawMsg)) {
      throw new Error('上传域名未加入小程序白名单，请稍后再试')
    }
    // 微信/Taro 的网络失败是 { errMsg } 普通对象，不是 Error 实例。
    // 原样往上抛的话上层 err?.message 取不到值，只能显示兜底文案，
    // 用户看不到「网络超时」这类真正的原因。
    throw err instanceof Error ? err : new Error(rawMsg || '导入失败，请重试')
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
