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

/* 只在品牌三色（墨 / 纸白 / 品牌黄）+ 极少量 danger 内取色，
 * 不引入第四种色相；同一色系内部靠明度差做渐变，保证整屏配色收敛。
 * 索引与后端 profiles.avatar_color (0~7) 一一对应，顺序不可调整。 */
export const AVATAR_THEMES: AvatarTheme[] = [
  { gradient: 'linear-gradient(135deg, #181818, #3A3A3A)', text: '#FFFFFF' },
  { gradient: 'linear-gradient(135deg, #FFD342, #E8B923)', text: '#181818' },
  { gradient: 'linear-gradient(135deg, #3A3A3A, #181818)', text: '#FFFFFF' },
  { gradient: 'linear-gradient(135deg, #FFF6DE, #FFECB8)', text: '#181818' },
  { gradient: 'linear-gradient(135deg, #EDEDED, #D4D4D4)', text: '#181818' },
  { gradient: 'linear-gradient(135deg, #181818, #181818)', text: '#FFD342' },
  { gradient: 'linear-gradient(135deg, #E8B923, #FFD342)', text: '#181818' },
  { gradient: 'linear-gradient(135deg, #C0392B, #A5301F)', text: '#FFFFFF' },
]

export const AVATAR_COLOR_COUNT = AVATAR_THEMES.length

export function getAvatarTheme(color: number | null | undefined): AvatarTheme {
  const idx = typeof color === 'number' && color >= 0 && color < AVATAR_COLOR_COUNT ? color : 0
  return AVATAR_THEMES[idx]
}

/** 取展示用首字母：中文取首字，英文取首字母大写 */
export function getInitial(name?: string | null): string {
  const text = (name || '').trim()
  if (!text) return '?'
  return text[0].toUpperCase()
}
