import Taro from '@tarojs/taro'
import {
  DM_GUIDE_ACCEPT,
  MAX_FILE_SIZE,
  SIMPLE_UPLOAD_MAX_SIZE,
} from '../constants/upload'
import { formatBytes } from './format'

/**
 * 选择到的 DM 指南文件，抹平 H5 / 小程序的差异。
 *
 * 两端拿到的东西形态完全不同：
 *   - H5：`File` 对象，可以 `slice()` 出 Blob 流式分片直传 OSS
 *   - 小程序：`chooseMessageFile` 只给一个本地临时路径（wxfile://...），
 *     没有 File/Blob，也读不到内容，只能整文件交给 `Taro.uploadFile`
 *
 * 上层按 `file` 是否存在决定走哪条上传链路，不用到处写 `process.env.TARO_ENV`。
 */
export interface PickedFile {
  name: string
  size: number
  /** H5 端：浏览器 File 对象（分片直传链路需要它） */
  file?: File
  /** 小程序端：本地临时文件路径（整文件中转链路需要它） */
  path?: string
}

/**
 * 该文件在当前平台上走哪条上传通道。
 *
 * `direct`   —— H5：分片 + 预签名 URL 直传 OSS，上限 500MB
 * `relayed`  —— 小程序：整文件 multipart 经后端中转（simple-upload），上限 20MB
 */
export function pickChannel(file: PickedFile): 'direct' | 'relayed' {
  return file.file ? 'direct' : 'relayed'
}

/** 当前文件在该通道下的体积上限 */
export function maxSizeOf(file: PickedFile): number {
  return pickChannel(file) === 'direct' ? MAX_FILE_SIZE : SIMPLE_UPLOAD_MAX_SIZE
}

/**
 * H5 端选择 DM 指南文件（仅 Word：.doc / .docx）。
 * 动态创建 input 而不是在 JSX 里放隐藏 input，避免小程序端编译时产生无用节点。
 * 返回 null 表示用户取消了选择。
 */
function pickDmGuideFileH5(): Promise<File | null> {
  const accept = [...DM_GUIDE_ACCEPT.mimes, ...DM_GUIDE_ACCEPT.exts].join(',')
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = false
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    document.body.appendChild(input)

    let settled = false
    const finish = (file: File | null) => {
      if (settled) return
      settled = true
      if (input.parentNode) input.parentNode.removeChild(input)
      resolve(file)
    }

    input.onchange = () => finish(input.files && input.files[0] ? input.files[0] : null)
    // Chrome 113+ 支持，用户点「取消」时触发
    input.oncancel = () => finish(null)

    input.click()
  })
}

/**
 * 小程序端选择 DM 指南文件。
 *
 * ⚠️ 微信只有 `chooseMessageFile`，它**只能从聊天记录里选文件**，够不到手机本地
 * 文件管理器 / 网盘。用户需要先把 Word 文档发进任意微信会话（推荐「文件传输助手」）
 * 才能在这里选到 —— 这是微信的能力边界，绕不过去。
 *
 * `extension` 过滤需要基础库 2.6.0+；老版本上该参数被忽略，用户可能选到别的格式，
 * 所以后面的 `validateDmGuideFile` 校验不能省。
 */
async function pickDmGuideFileMini(): Promise<PickedFile | null> {
  try {
    const res = await Taro.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: [...DM_GUIDE_ACCEPT.exts.map((e) => e.replace(/^\./, ''))],
    })
    const picked = res.tempFiles?.[0]
    if (!picked) return null
    return { name: picked.name || '未命名文档', size: picked.size, path: picked.path }
  } catch (err: any) {
    // 用户主动取消：errMsg 形如 "chooseMessageFile:fail cancel"
    if (/cancel/i.test(err?.errMsg || '')) return null
    Taro.showToast({ title: '选择文件失败，请重试', icon: 'none' })
    return null
  }
}

/** 选择 DM 指南文件，返回 null 表示用户取消或选择失败 */
export async function pickDmGuideFile(): Promise<PickedFile | null> {
  if (process.env.TARO_ENV === 'h5') {
    const file = await pickDmGuideFileH5()
    return file ? { name: file.name, size: file.size, file } : null
  }
  return pickDmGuideFileMini()
}

/** 前端侧校验，返回错误信息；通过则返回 null */
export function validateDmGuideFile(file: PickedFile): string | null {
  const name = file.name.toLowerCase()
  const isAllowedExt = DM_GUIDE_ACCEPT.exts.some((ext) => name.endsWith(ext))
  // 部分系统选出来的文件没有 type（尤其是 .doc），放宽到后缀名判断
  const isAllowedMime = DM_GUIDE_ACCEPT.mimes.includes(
    (file.file?.type ?? '') as (typeof DM_GUIDE_ACCEPT.mimes)[number]
  )
  if (!isAllowedExt && !isAllowedMime) {
    return `只能导入 ${DM_GUIDE_ACCEPT.label} 格式的 DM 指南`
  }
  if (file.size === 0) {
    return '文件内容为空，请重新选择'
  }
  const limit = maxSizeOf(file)
  if (file.size > limit) {
    const hint =
      pickChannel(file) === 'relayed'
        ? '小程序端暂不支持更大的文件，请在网页版导入'
        : ''
    return `文件不能超过 ${formatBytes(limit)}，当前 ${formatBytes(file.size)}${
      hint ? `。${hint}` : ''
    }`
  }
  return null
}

/**
 * 根据文件名推导 OSS 对象的 Content-Type（用于 init 的 content_type）。
 * 浏览器对 .doc 经常返回空 type，必须兜底按后缀名映射，否则会落到 octet-stream，
 * 影响后端存储的 content_type 与下载时的预览/附件行为。
 *
 * 仅允许 Word 类型（.doc / .docx），与 DM_GUIDE_ACCEPT 白名单保持一致。
 */
export function resolveContentType(file: PickedFile): string {
  const name = file.name.toLowerCase()
  if (name.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  if (name.endsWith('.doc')) return 'application/msword'
  if (file.file?.type) return file.file.type
  return 'application/octet-stream'
}
