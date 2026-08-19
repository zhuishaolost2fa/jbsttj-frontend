/**
 * 通用头像组件。
 *
 * 优先展示自定义图片（avatarUrl）；未设置时按 avatarColor 渲染「渐变底 + 首字母」默认头像。
 * 大小、是否显示文字均可配置，便于在个人中心、编辑页预览等处复用。
 */

import { View, Image, Text } from '@tarojs/components'
import { getAvatarTheme, getInitial } from '../../constants/avatar'
import './index.less'

interface AvatarProps {
  /** 展示名（昵称 / 邮箱），用于默认头像的首字母 */
  name?: string | null
  /** 自定义头像图片地址 */
  url?: string | null
  /** 默认头像配色索引 0~7 */
  color?: number | null
  /** 边长（px），默认 48 */
  size?: number
  /** 是否显示首字母（默认头像时） */
  showText?: boolean
  /** 圆角（px），默认与 size 相同即为正圆 */
  radius?: number
}

export default function Avatar({
  name,
  url,
  color,
  size = 48,
  showText = true,
  radius,
}: AvatarProps) {
  const dimension = { width: `${size}px`, height: `${size}px`, borderRadius: `${radius ?? size}px` }
  const textSize = Math.max(12, Math.round(size * 0.42))

  if (url) {
    return (
      <Image
        className='avatar-img'
        src={url}
        style={dimension}
        mode='aspectFill'
      />
    )
  }

  const theme = getAvatarTheme(color)
  return (
    <View className='avatar-default' style={{ ...dimension, background: theme.gradient }}>
      {showText && (
        <Text className='avatar-initial' style={{ color: theme.text, fontSize: `${textSize}px` }}>
          {getInitial(name)}
        </Text>
      )}
    </View>
  )
}
