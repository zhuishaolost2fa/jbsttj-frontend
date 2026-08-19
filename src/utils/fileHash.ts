/**
 * 文件内容指纹。
 *
 * 后端用它做两件事：
 *   1. 秒传    —— 同一用户传过同样的文件，直接复用 OSS 对象
 *   2. 断点续传 —— 匹配到未完成的历史任务，跳过已传分片
 *
 * ## 为什么是抽样而不是全量 SHA-256
 *
 * 400MB 全量哈希要把整个文件读一遍，慢（低端机 10s+）且吃内存，
 * 用户点完「导入」要干等着，体验极差。后端 schema 也明确写了
 * 「大文件可用抽样哈希」。
 *
 * 抽样取 头 / 中 / 尾 各 2MB，并把文件总大小混进摘要。
 * 碰撞需要同时满足：同一用户 + 大小完全相同 + 这三段 6MB 字节完全一致。
 * 后端 find_by_hash 还会再校验一次 file_size 且限定 user_id，
 * 对 PDF 这种带唯一元数据/交叉引用表的格式，误命中概率可以忽略。
 *
 * ## 降级
 *
 * crypto.subtle 只在安全上下文（HTTPS / localhost）可用。
 * 局域网 HTTP 调试时会拿不到，此时退化为 JS 实现的双种子 FNV-1a。
 * 降级哈希强度较低，但它只影响「秒传/续传能否命中」，
 * 命不中最多是重传一次，不会损坏数据。
 */

/** 单段采样长度 */
const SAMPLE_SIZE = 2 * 1024 * 1024

/** 小于这个体积就全量读，反正也不慢 */
const FULL_HASH_THRESHOLD = 3 * SAMPLE_SIZE

function hasSubtleCrypto(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof crypto.subtle.digest === 'function'
  )
}

/** Blob → ArrayBuffer，优先用原生方法，老浏览器回退 FileReader */
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer()
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsArrayBuffer(blob)
  })
}

/** 按 头/中/尾 切出待哈希的片段；小文件直接整份 */
function pickSampleRanges(size: number): Array<[number, number]> {
  if (size <= FULL_HASH_THRESHOLD) return [[0, size]]
  const middle = Math.floor(size / 2 - SAMPLE_SIZE / 2)
  return [
    [0, SAMPLE_SIZE],
    [middle, middle + SAMPLE_SIZE],
    [size - SAMPLE_SIZE, size],
  ]
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

/**
 * 双种子 FNV-1a，输出 16 位十六进制。
 * 仅在 crypto.subtle 不可用时兜底。
 */
function fallbackHash(bytes: Uint8Array, size: number): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    h1 ^= b
    // FNV 质数 16777619，用移位相加避免 32 位整数溢出丢精度
    h1 = (h1 + (h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24)) >>> 0
    h2 = ((h2 ^ b) * 0x85ebca6b) >>> 0
    h2 = (h2 ^ (h2 >>> 13)) >>> 0
  }

  // 把文件大小也搅进去，避免仅靠抽样字节判定
  h1 = (h1 ^ size) >>> 0
  h2 = (h2 ^ Math.floor(size / 0x100000000)) >>> 0

  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/**
 * 计算文件指纹。
 *
 * 失败时返回空字符串而不是抛错 —— 拿不到指纹只是失去秒传/续传能力，
 * 不该阻断整个上传流程。
 */
export async function computeFileFingerprint(file: File): Promise<string> {
  try {
    const ranges = pickSampleRanges(file.size)
    const buffers: ArrayBuffer[] = []
    for (const [start, end] of ranges) {
      buffers.push(await readBlob(file.slice(start, end)))
    }

    // 把各段拼起来，末尾追加 8 字节的文件大小（小端），让大小参与摘要
    const totalLen = buffers.reduce((sum, b) => sum + b.byteLength, 0)
    const merged = new Uint8Array(totalLen + 8)
    let offset = 0
    for (const buf of buffers) {
      merged.set(new Uint8Array(buf), offset)
      offset += buf.byteLength
    }
    new DataView(merged.buffer).setFloat64(totalLen, file.size, true)

    if (hasSubtleCrypto()) {
      const digest = await crypto.subtle.digest('SHA-256', merged)
      return toHex(digest)
    }
    return fallbackHash(merged, file.size)
  } catch {
    // 读取失败（权限/文件被移动）不影响主流程，退化为不带指纹上传
    return ''
  }
}
