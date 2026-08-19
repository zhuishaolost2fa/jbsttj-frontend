import { DM_GUIDE_ACCEPT, MAX_FILE_SIZE } from '../constants/upload'
import { formatBytes } from './format'

/**
 * H5 端选择 DM 指南文件（仅 Word：.doc / .docx）。
 * 动态创建 input 而不是在 JSX 里放隐藏 input，避免小程序端编译时产生无用节点。
 * 返回 null 表示用户取消了选择。
 */
export function pickDmGuideFile(): Promise<File | null> {
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

/** 前端侧校验，返回错误信息；通过则返回 null */
export function validateDmGuideFile(file: File): string | null {
  const name = file.name.toLowerCase()
  const isAllowedExt = DM_GUIDE_ACCEPT.exts.some((ext) => name.endsWith(ext))
  // 部分系统选出来的文件没有 type（尤其是 .doc），放宽到后缀名判断
  const isAllowedMime = DM_GUIDE_ACCEPT.mimes.includes(
    file.type as (typeof DM_GUIDE_ACCEPT.mimes)[number]
  )
  if (!isAllowedExt && !isAllowedMime) {
    return `只能导入 ${DM_GUIDE_ACCEPT.label} 格式的 DM 指南`
  }
  if (file.size === 0) {
    return '文件内容为空，请重新选择'
  }
  if (file.size > MAX_FILE_SIZE) {
    return `文件不能超过 ${formatBytes(MAX_FILE_SIZE)}，当前 ${formatBytes(file.size)}`
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
export function resolveContentType(file: File): string {
  const name = file.name.toLowerCase()
  if (name.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  if (name.endsWith('.doc')) return 'application/msword'
  if (file.type) return file.type
  return 'application/octet-stream'
}
