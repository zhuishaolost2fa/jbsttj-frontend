/**
 * 默认头像配色。
 *
 * 用户未设置自定义头像图片（avatar_url）时，前端按 avatar_color 索引渲染
 * 「渐变底 + 昵称首字母」的默认头像，与微信 / Telegram 的默认头像思路一致。
 * 索引范围与后端 profiles.avatar_color (0~7) 对应。
 */

export interface AvatarTheme {
  /** CSS 渐变，用于头像底色 */
  gradient: string
  /** 该配色下的文字颜色（一般取浅色保证对比度） */
  text: string
}

export const AVATAR_THEMES: AvatarTheme[] = [
  { gradient: 'linear-gradient(135deg, #5b7cfa, #8b5cf6)', text: '#ffffff' },
  { gradient: 'linear-gradient(135deg, #ff7a59, #ff5e8e)', text: '#ffffff' },
  { gradient: 'linear-gradient(135deg, #34d399, #059669)', text: '#ffffff' },
  { gradient: 'linear-gradient(135deg, #38bdf8, #2563eb)', text: '#ffffff' },
  { gradient: 'linear-gradient(135deg, #fbbf24, #f97316)', text: '#ffffff' },
  { gradient: 'linear-gradient(135deg, #f472b6, #db2777)', text: '#ffffff' },
  { gradient: 'linear-gradient(135deg, #a78bfa, #6366f1)', text: '#ffffff' },
  { gradient: 'linear-gradient(135deg, #2dd4bf, #0d9488)', text: '#ffffff' },
]

export const AVATAR_COLOR_COUNT = AVATAR_THEMES.length

export function getAvatarTheme(color: number | null | undefined): AvatarTheme {
  const idx = typeof color === 'number' && color >= 0 && color < AVATAR_COLOR_COUNT ? color : 0
  return AVATAR_THEMES[idx]
}

/** 取展示用首字母：中文取首字，英文取首字母大写 */
export function getInitial(name?: string | null): string {
  const text = (name || '').trim()
  if (!text) return '👤'
  return text[0].toUpperCase()
}
