/**
 * 轻量 JWT 解析工具（只解码 payload，**不做签名验证**）。
 *
 * 为什么需要它：登录 / 刷新响应里的 `expires_in` 是「相对当前」的秒数，
 * 依赖客户端收到响应的时刻来折算过期时间，会受网络耗时和本机时钟漂移影响。
 * 而 access_token 本身是 JWT，其 payload 里的 `exp` 是**服务端会真正校验的
 * 绝对过期时间**，用它作为过期基准更准，续签时机也更可靠。
 *
 * 跨端注意：微信 / 抖音小程序环境没有全局 `atob` / `Buffer`，
 * 这里手写 base64url + UTF-8 解码，保证 H5 / 微信 / 抖音三端表现一致。
 */

const B64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** base64url 字符串 → 字节数组 */
function base64UrlToBytes(input: string): number[] {
  // base64url → 标准 base64，并补齐 padding
  let str = input.replace(/-/g, '+').replace(/_/g, '/')
  while (str.length % 4 !== 0) str += '='

  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '=') break
    const idx = B64_CHARS.indexOf(ch)
    if (idx === -1) continue // 跳过换行等非法字符
    buffer = (buffer << 6) | idx
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return bytes
}

/** 字节数组按 UTF-8 解码成字符串（手写，避免依赖 escape/TextDecoder） */
function utf8BytesToString(bytes: number[]): string {
  let result = ''
  let i = 0
  while (i < bytes.length) {
    const b1 = bytes[i++]
    if (b1 < 0x80) {
      result += String.fromCharCode(b1)
    } else if (b1 >= 0xc0 && b1 < 0xe0) {
      const b2 = bytes[i++] & 0x3f
      result += String.fromCharCode(((b1 & 0x1f) << 6) | b2)
    } else if (b1 >= 0xe0 && b1 < 0xf0) {
      const b2 = bytes[i++] & 0x3f
      const b3 = bytes[i++] & 0x3f
      result += String.fromCharCode(((b1 & 0x0f) << 12) | (b2 << 6) | b3)
    } else {
      // 4 字节序列（Unicode 补充平面）→ 转成 UTF-16 代理对
      const b2 = bytes[i++] & 0x3f
      const b3 = bytes[i++] & 0x3f
      const b4 = bytes[i++] & 0x3f
      let cp = ((b1 & 0x07) << 18) | (b2 << 12) | (b3 << 6) | b4
      cp -= 0x10000
      result += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    }
  }
  return result
}

/** Supabase access_token 常见声明（只列用得到的，其余透传） */
export interface JwtPayload {
  /** 用户 id */
  sub?: string
  email?: string
  phone?: string
  role?: string
  /** 绝对过期时间（秒级 Unix 时间戳） */
  exp?: number
  /** 签发时间（秒级 Unix 时间戳） */
  iat?: number
  session_id?: string
  is_anonymous?: boolean
  user_metadata?: Record<string, any>
  app_metadata?: Record<string, any>
  [key: string]: any
}

/**
 * 解码 JWT 的 payload。
 * 失败（格式非法 / 解析异常）时返回 null —— 不抛错，交给调用方走兜底逻辑。
 */
export function decodeJwt(token: string): JwtPayload | null {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const json = utf8BytesToString(base64UrlToBytes(parts[1]))
    const payload = JSON.parse(json)
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

/**
 * 取 JWT 的绝对过期时间（**毫秒**）。
 * 无 `exp` 声明或解码失败时返回 null。
 */
export function getJwtExpiryMs(token: string): number | null {
  const payload = decodeJwt(token)
  if (payload && typeof payload.exp === 'number' && payload.exp > 0) {
    return payload.exp * 1000
  }
  return null
}
