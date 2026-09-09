import { Image } from '@tarojs/components'
import { ICON_MAP } from './icons'
import type { IconName, IconTone } from './icons'
import './index.less'

export type { IconName, IconTone }

interface AppIconProps {
  /** 图标名，见 src/components/AppIcon/icons.ts 的 IconName */
  name: IconName
  /** 色调（预渲染好的多份 PNG），默认 ink（浅底深色） */
  tone?: IconTone
  /** 显示尺寸 px，默认 20 */
  size?: number
  className?: string
}

/**
 * 跨端图标：构建期把 SVG 光栅化成多份 PNG，这里按 name + tone 取对应资源。
 *
 * ⚠️ 为什么不用内联 SVG / 图标字体 / emoji：
 *  - 小程序端不支持内联 <svg>，只认 <image>；图标字体需网络字体文件，
 *    小程序 @font-face 不支持 base64 内联；emoji 各端字形不一、还掺杂色。
 * 因此统一走「SVG -> 多色 PNG + 静态 import」这条最稳的路。
 */
function AppIcon({ name, tone = 'ink', size = 20, className = '' }: AppIconProps) {
  const src = ICON_MAP[name]?.[tone] ?? ICON_MAP[name]?.ink
  if (!src) return null
  return (
    <Image
      className={`app-icon ${className}`}
      style={{ width: `${size}px`, height: `${size}px` }}
      src={src}
      mode='aspectFit'
    />
  )
}

export default AppIcon
