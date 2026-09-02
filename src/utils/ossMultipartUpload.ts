/**
 * OSS 分片直传引擎（对接后端 task_id 驱动的四步流程）。
 *
 * ## 链路
 *
 *   1. 算文件指纹（抽样 SHA-256）
 *   2. POST /uploads/temp/init      → task_id、chunk_size、已传分片
 *        ├─ instant=true  秒传命中，直接跳到第 5 步
 *        └─ resumed=true  断点续传，跳过 uploaded_parts
 *   3. POST /uploads/{id}/presign   → 分批换预签名 URL
 *      PUT  <oss-url>               → 浏览器直传，数据不经过业务后端
 *      POST /uploads/{id}/parts/callback → 批量上报（仅审计，失败不影响正确性）
 *   4. POST /uploads/{id}/complete  → 服务端重新列举 OSS 分片校验后合并
 *   5. GET  /files/{fileId}/download-url → 换取可访问链接
 *
 * ## 三个必须遵守的约束
 *
 * **① 切片大小以服务端为准。** init 响应里的 chunk_size 才是权威值，
 *    服务端会在分片数超过 10000 时上调它。用本地常量切片会导致
 *    分片边界错位，合并出来的文件直接损坏。
 *
 * **② PUT 分片时绝不能带 Content-Type。** 后端 presign_part 调 OSS SDK 时
 *    没有传 content_type，签名里不含该头。请求一旦带上（哪怕是浏览器自动加的）
 *    就是 SignatureDoesNotMatch(403)。file.slice() 产出的 Blob 的 type 为空串，
 *    XHR 不会自动附加该头 —— 这是刻意为之，不要"顺手"补上。
 *
 * **③ 断点续传由服务端负责。** 不要再往 localStorage 里存 uploadId/ETag：
 *    OSS 才是进度的唯一可信来源，本地记录会和 OSS 实际状态漂移。
 *    带上 file_hash 调 init，服务端会自动匹配未完成的任务并返回已传分片。
 */

import {
  CHUNK_SIZE,
  DM_GUIDE_UPLOAD_TYPE,
  MAX_COMPLETE_REPAIR_ROUNDS,
  MAX_RETRY_PER_PART,
  SIGN_BATCH_SIZE,
  UPLOAD_CONCURRENCY,
  type UploadType,
} from '../constants/upload'
import { resolveContentType } from './filePicker'
import { ApiError } from '../services/request'
import {
  abortUpload,
  completeUpload,
  fetchDownloadUrl,
  initUpload,
  presignParts,
  reportParts,
  type ApiUploadedPart,
  type InitUploadParams,
} from '../services/upload'
import { computeFileFingerprint } from './fileHash'

/* -------------------------------------------------------------------------- */
/*                                   类型                                      */
/* -------------------------------------------------------------------------- */

export type UploadStage =
  | 'idle'
  | 'hashing'
  | 'preparing'
  | 'uploading'
  | 'merging'
  | 'finishing'
  | 'done'
  | 'error'
  | 'canceled'

export interface UploadProgress {
  /** 0 - 100，保留一位小数 */
  percent: number
  loaded: number
  total: number
  uploadedParts: number
  totalParts: number
  /** 瞬时速度 B/s（EMA 平滑） */
  speed: number
  /** 预计剩余秒数，无法估算时为 -1 */
  remainSeconds: number
}

export interface UploadResult {
  /** files 表主键，后续查询/删除/换链接都用它 */
  fileId: string
  fileName: string
  objectKey: string
  fileSize: number
  /** 临时访问链接（带签名，会过期） */
  fileUrl: string
  /** 链接有效期，单位秒 */
  urlExpiresIn: number
  /** true 表示命中秒传，没有真正传输数据 */
  instant: boolean
}

export interface MultipartUploadOptions {
  onProgress?: (progress: UploadProgress) => void
  onStage?: (stage: UploadStage) => void
  signal?: AbortSignal
  /**
   * 是否计算文件指纹。关掉会同时失去秒传和服务端断点续传能力，
   * 一般只在指纹计算异常时临时排查用。
   */
  fingerprint?: boolean
  /** temporary 写入 temp/ 前缀受生命周期清理，permanent 长期保留 */
  uploadType?: UploadType
  contentType?: string
  metadata?: Record<string, unknown>
}

/** 用户主动取消 —— 与「上传失败」区分开，取消不重试 */
export class UploadAbortError extends Error {
  constructor() {
    super('上传已取消')
    this.name = 'UploadAbortError'
  }
}

/* -------------------------------------------------------------------------- */
/*                                  基础工具                                    */
/* -------------------------------------------------------------------------- */

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadAbortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new UploadAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 判断错误是否值得重试：4xx 是入参/权限问题，重试多少次都一样 */
function isRetryable(err: unknown): boolean {
  if (err instanceof UploadAbortError) return false
  if (err instanceof ApiError) {
    // 网络层失败(status=0) 和 5xx 值得重试
    return err.status === 0 || err.status >= 500
  }
  return true
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new UploadAbortError()
    try {
      return await fn()
    } catch (err) {
      if (err instanceof UploadAbortError) throw err
      lastError = err
      if (!isRetryable(err)) throw err
      if (attempt < retries) {
        // 指数退避：1s → 2s → 4s，上限 8s
        await delay(Math.min(1000 * 2 ** attempt, 8000), signal)
      }
    }
  }
  throw lastError
}

/** 简易并发池：任一任务抛错立即停止派发新任务 */
async function runWithPool(
  tasks: Array<() => Promise<void>>,
  concurrency: number
): Promise<void> {
  let cursor = 0
  let failure: unknown = null

  const worker = async (): Promise<void> => {
    while (cursor < tasks.length && !failure) {
      const current = cursor++
      try {
        await tasks[current]()
      } catch (err) {
        failure = err
      }
    }
  }

  const size = Math.max(1, Math.min(concurrency, tasks.length))
  await Promise.all(Array.from({ length: size }, () => worker()))

  if (failure) throw failure
}

function splitIntoBatches<T>(list: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < list.length; i += size) {
    batches.push(list.slice(i, i + size))
  }
  return batches
}

/** 取小写扩展名（含点），无扩展名返回空串。用于判断秒传命中是否跨格式 */
function getFileExt(name: string): string {
  const i = name.lastIndexOf('.')
  if (i < 0) return ''
  return name.slice(i).toLowerCase()
}

/** 从 409 incomplete_parts 的 details 里取出缺失分片号 */
function extractMissingParts(details: unknown): number[] {
  if (!details || typeof details !== 'object') return []
  const raw = (details as { missing_parts?: unknown }).missing_parts
  if (!Array.isArray(raw)) return []
  return raw.filter((n): n is number => typeof n === 'number' && n >= 1)
}

/* -------------------------------------------------------------------------- */
/*                            单个分片 PUT 到 OSS                              */
/* -------------------------------------------------------------------------- */

/**
 * 用原生 XHR 而不是 Taro.request，三个原因：
 *   1. 需要 xhr.upload.onprogress 拿实时上传进度
 *   2. 需要 getResponseHeader('ETag')，Taro.request 读不到响应头
 *   3. 需要直接 send(Blob) 走流式，避免把几百 MB 读进内存
 *
 * ⚠️ 不要在这里调用 setRequestHeader —— 见文件头注释「约束 ②」。
 */
function putPart(
  url: string,
  blob: Blob,
  handlers: {
    onProgress: (loaded: number) => void
    signal?: AbortSignal
  }
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const { signal, onProgress } = handlers

    if (signal?.aborted) {
      reject(new UploadAbortError())
      return
    }

    const xhr = new XMLHttpRequest()
    const onAbort = () => xhr.abort()
    const cleanup = () => signal?.removeEventListener('abort', onAbort)

    xhr.open('PUT', url, true)
    xhr.timeout = 10 * 60 * 1000

    xhr.upload.onprogress = (event: ProgressEvent) => {
      if (event.lengthComputable) onProgress(event.loaded)
    }

    xhr.onload = () => {
      cleanup()
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag')
        if (!etag) {
          reject(
            new Error(
              '读取不到分片 ETag。请在 OSS 跨域规则(CORS)的 ExposeHeaders 中添加 ETag'
            )
          )
          return
        }
        onProgress(blob.size)
        // OSS 返回的 ETag 带双引号，剥掉后再上报，与后端 _strip_quotes 保持一致
        resolve(etag.replace(/^"|"$/g, ''))
      } else {
        const body = (xhr.responseText || '').slice(0, 300)
        // 签名类错误单独提示，否则很难从一堆 XML 里看出问题
        const hint = /SignatureDoesNotMatch/.test(body)
          ? '（签名不匹配：请检查是否给分片请求添加了 Content-Type 等额外请求头）'
          : ''
        reject(new Error(`分片上传失败（HTTP ${xhr.status}）${hint}${body}`))
      }
    }

    xhr.onerror = () => {
      cleanup()
      reject(new Error('分片上传网络错误，请检查网络或 OSS 跨域规则是否放行当前域名'))
    }
    xhr.ontimeout = () => {
      cleanup()
      reject(new Error('分片上传超时'))
    }
    xhr.onabort = () => {
      cleanup()
      reject(new UploadAbortError())
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    // 传 Blob 且 blob.type 为空串时，浏览器不会自动加 Content-Type —— 这正是我们要的
    xhr.send(blob)
  })
}

/* -------------------------------------------------------------------------- */
/*                                  主流程                                     */
/* -------------------------------------------------------------------------- */

export async function multipartUploadToOss(
  file: File,
  options: MultipartUploadOptions = {}
): Promise<UploadResult> {
  const {
    onProgress,
    onStage,
    signal,
    fingerprint = true,
    uploadType = DM_GUIDE_UPLOAD_TYPE,
    // resolveContentType 收的是 PickedFile（H5 / 小程序双形态），
    // 这一层拿到的是裸 File，包一层再传，别让它取不到 file.type
    contentType = resolveContentType({ name: file.name, size: file.size, file }),
    metadata,
  } = options

  const ensureAlive = () => {
    if (signal?.aborted) throw new UploadAbortError()
  }

  /* --------------------------- 1. 文件指纹 --------------------------- */
  onStage?.('hashing')
  ensureAlive()
  const fileHash = fingerprint ? await computeFileFingerprint(file) : ''

  /* --------------------------- 2. 初始化任务 -------------------------- */
  onStage?.('preparing')
  ensureAlive()

  const initParams: InitUploadParams = {
    filename: file.name,
    fileSize: file.size,
    contentType,
    fileHash: fileHash || undefined,
    chunkSize: CHUNK_SIZE,
    uploadType,
    metadata,
  }

  let init = await initUpload(initParams)

  /**
   * 防御「跨格式秒传误命中」。
   *
   * DM 指南按 temporary 上传（temp/ 前缀，OSS 7 天生命周期），剧本删除并不会立刻
   * 清掉底层文件对象。后端若按文件名（或 文件名+大小）去重，会出现这种场景：
   * 先传了 山鬼母.pdf 并删除，再传同名 山鬼母.docx 时，init 返回 instant=true
   * 并带上**旧 PDF** 的 file 信息。若直接复用，就会拿旧文件去解析，解析状态里
   * 文件名也仍然是 PDF。
   *
   * 扩展名是文件类型的硬标识：秒传命中文件的扩展名与本地所选不一致，说明命中的
   * 是「另一个文件」。此时放弃秒传、不带 file_hash 重新 init，强制真实上传当前
   * 选中的文件，避免解析错文件、状态显示错类型。
   */
  const localExt = getFileExt(file.name)
  if (init.instant && init.file && getFileExt(init.file.filename || '') !== localExt) {
    init = await initUpload({ ...initParams, fileHash: undefined })
  }

  const taskId = init.task_id
  // ⚠️ 一律以服务端返回的 chunk_size 切片，本地常量只是「期望值」
  const chunkSize = init.chunk_size
  const totalParts = init.total_parts

  /* --------------------------- 秒传直接收尾 --------------------------- */
  if (init.instant) {
    if (!init.file) {
      throw new Error('服务端返回秒传命中但缺少文件信息，请重试')
    }
    onStage?.('finishing')
    onProgress?.({
      percent: 100,
      loaded: file.size,
      total: file.size,
      uploadedParts: 0,
      totalParts: 0,
      speed: 0,
      remainSeconds: 0,
    })
    const link = await fetchDownloadUrl(init.file.id)
    onStage?.('done')
    return {
      fileId: init.file.id,
      fileName: init.file.filename || file.name,
      objectKey: init.file.object_key,
      fileSize: init.file.file_size,
      fileUrl: link.url,
      urlExpiresIn: link.expires_in,
      instant: true,
    }
  }

  if (!init.upload_id) {
    throw new Error('服务端未返回分片上传上下文，无法继续上传')
  }

  /* ----------------------------- 进度统计 ----------------------------- */
  const safeTotal = Math.max(1, file.size)
  const partSizeOf = (partNumber: number) =>
    Math.min(chunkSize, file.size - (partNumber - 1) * chunkSize)

  // 服务端已确认落盘的分片（断点续传时非空）
  const donePartNumbers = new Set<number>(
    init.uploaded_parts.map((p) => p.part_number)
  )
  let baseLoaded = init.uploaded_parts.reduce(
    (sum, p) => sum + (p.size || partSizeOf(p.part_number)),
    0
  )

  // 传输中分片的实时字节数
  const inflightLoaded = new Map<number, number>()

  let lastEmitTime = Date.now()
  let lastEmitLoaded = baseLoaded
  let smoothSpeed = 0

  const emitProgress = (force = false) => {
    if (!onProgress) return
    const now = Date.now()
    // 节流 200ms，避免几百 MB 上传时把 React 刷爆
    if (!force && now - lastEmitTime < 200) return

    let loaded = baseLoaded
    inflightLoaded.forEach((v) => {
      loaded += v
    })
    loaded = Math.min(loaded, file.size)

    const elapsed = (now - lastEmitTime) / 1000
    if (elapsed > 0) {
      const instantSpeed = Math.max(0, loaded - lastEmitLoaded) / elapsed
      // EMA 平滑，避免速度数字剧烈跳动
      smoothSpeed =
        smoothSpeed === 0 ? instantSpeed : smoothSpeed * 0.7 + instantSpeed * 0.3
    }

    lastEmitTime = now
    lastEmitLoaded = loaded

    const remain = file.size - loaded
    onProgress({
      percent: Math.min(100, Math.round((loaded / safeTotal) * 1000) / 10),
      loaded,
      total: file.size,
      uploadedParts: donePartNumbers.size,
      totalParts,
      speed: smoothSpeed,
      remainSeconds: smoothSpeed > 1024 ? Math.ceil(remain / smoothSpeed) : -1,
    })
  }

  emitProgress(true)

  /* --------------------------- 分片上传实现 --------------------------- */

  /** 上传指定的一组分片；主流程和「缺片自愈」都走这里 */
  const uploadPartNumbers = async (partNumbers: number[]): Promise<void> => {
    if (!partNumbers.length) return

    // 分批换签名，避免大文件传到后半程时先签的 URL 已过期
    for (const batch of splitIntoBatches(partNumbers, SIGN_BATCH_SIZE)) {
      ensureAlive()

      const signed = await withRetry(() => presignParts(taskId, batch), 2, signal)
      const urlMap = new Map(signed.map((item) => [item.part_number, item.url]))
      const finished: ApiUploadedPart[] = []

      const tasks = batch.map((partNumber) => async () => {
        const url = urlMap.get(partNumber)
        if (!url) throw new Error(`分片 ${partNumber} 未获取到上传地址`)

        const start = (partNumber - 1) * chunkSize
        // 不传第三个参数，保证 Blob.type 为空 —— 见文件头「约束 ②」
        const blob = file.slice(start, Math.min(start + chunkSize, file.size))

        const etag = await withRetry(
          () =>
            putPart(url, blob, {
              signal,
              onProgress: (loaded) => {
                inflightLoaded.set(partNumber, loaded)
                emitProgress()
              },
            }),
          MAX_RETRY_PER_PART,
          signal
        )

        // 分片落定：从 inflight 转入 base，保证进度不回退也不重复计算
        inflightLoaded.delete(partNumber)
        if (!donePartNumbers.has(partNumber)) {
          donePartNumbers.add(partNumber)
          baseLoaded += blob.size
        }
        finished.push({ part_number: partNumber, etag, size: blob.size })
        emitProgress(true)
      })

      try {
        await runWithPool(tasks, UPLOAD_CONCURRENCY)
      } finally {
        // 即使这批有失败，也把已成功的分片上报掉，让服务端进度查询保持准确。
        // 上报仅用于展示与审计，合并时后端以 OSS 实际列举为准，失败可以忽略。
        if (finished.length) {
          reportParts(taskId, finished).catch(() => void 0)
        }
      }
    }
  }

  try {
    /* ---------------------------- 3. 传分片 ---------------------------- */
    onStage?.('uploading')

    const pending: number[] = []
    for (let i = 1; i <= totalParts; i++) {
      if (!donePartNumbers.has(i)) pending.push(i)
    }
    await uploadPartNumbers(pending)

    ensureAlive()

    /* ---------------------------- 4. 合并 ------------------------------ */
    onStage?.('merging')

    let merged = null as Awaited<ReturnType<typeof completeUpload>> | null
    for (let round = 0; round <= MAX_COMPLETE_REPAIR_ROUNDS; round++) {
      try {
        merged = await completeUpload(taskId)
        break
      } catch (err) {
        // 服务端列举 OSS 后发现缺片：补传缺失的再合并一次。
        // 这种情况通常是分片 PUT 返回 2xx 但 OSS 侧最终没落盘（极少见但确实会发生）。
        const isIncomplete =
          err instanceof ApiError && err.code === 'incomplete_parts'
        if (!isIncomplete || round >= MAX_COMPLETE_REPAIR_ROUNDS) throw err

        const missing = extractMissingParts((err as ApiError).details)
        if (!missing.length) throw err

        onStage?.('uploading')
        missing.forEach((n) => {
          donePartNumbers.delete(n)
          baseLoaded -= partSizeOf(n)
        })
        baseLoaded = Math.max(0, baseLoaded)
        emitProgress(true)

        await uploadPartNumbers(missing)
        ensureAlive()
        onStage?.('merging')
      }
    }

    if (!merged) throw new Error('合并分片失败，请重试')

    /* ------------------------- 5. 换取访问链接 -------------------------- */
    onStage?.('finishing')
    const link = await fetchDownloadUrl(merged.file.id)

    onStage?.('done')
    return {
      fileId: merged.file.id,
      fileName: merged.file.filename || file.name,
      objectKey: merged.file.object_key,
      fileSize: merged.file.file_size,
      fileUrl: link.url,
      urlExpiresIn: link.expires_in,
      instant: false,
    }
  } catch (err) {
    if (err instanceof UploadAbortError) {
      // 主动取消：通知服务端清理 OSS 碎片，否则碎片会一直占用存储计费
      abortUpload(taskId).catch(() => void 0)
      onStage?.('canceled')
    } else {
      // 非主动取消：保留任务（status 仍是 uploading），
      // 重试时带同样的 file_hash 调 init 就会命中服务端断点续传
      onStage?.('error')
    }
    throw err
  }
}
