/**
 * 设计令牌（TS 版）—— 与 src/styles/tokens.less 严格一一对应。
 *
 * 用途：.tsx 里的**内联样式**拿不到 less 变量（小程序端也拿不到 CSS 变量），
 * 需要颜色时从这里取。改色只需改这两个文件。
 *
 * ⚠️ 任何改动都要同步 tokens.less，否则两端会不一致。
 */
export const C = {
  /* 品牌三色 */
  ink: '#181818',
  paper: '#ffffff',
  accent: '#FFD342',

  /* ink 派生 */
  ink2: '#2E2E2E',
  inkSoft: '#3A3A3A',
  inkMute: '#6E6E6E',
  inkFaint: '#8C8C8C',

  /* 线条 */
  line: '#E6E6E6',
  lineMid: '#C9C9C9',
  lineStrong: '#D4D4D4',

  /* 填充 */
  canvas: '#F7F7F7',
  fill: '#F5F5F5',
  fillDeep: '#EDEDED',

  /* accent 派生 */
  accentDeep: '#E8B923',
  accentInk: '#7A5C00',
  accentSoft: '#FFF6DE',
  accentLine: '#FFECB8',

  /* 语义 */
  danger: '#C0392B',
  dangerSoft: '#FDECEA',

  /* 深色底反色 */
  onInk: '#FFFFFF',
  onInkMute: 'rgba(255,255,255,0.66)',
  onInkFaint: 'rgba(255,255,255,0.42)',
  onInkLine: 'rgba(255,255,255,0.16)',
  onInkFill: 'rgba(255,255,255,0.08)',
} as const

/** 间距：4 的倍数 */
export const SP = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const

export const R = {
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
} as const
