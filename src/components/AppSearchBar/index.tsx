import { Input, View } from '@tarojs/components'
import AppIcon from '../AppIcon'
import './index.less'

interface AppSearchBarProps {
  value: string
  placeholder?: string
  /** 输入变化（受控：输入 + 清空都要回调，父级负责更新 value） */
  onChange?: (value: string) => void
  /** 键盘「搜索」键 / 回车 */
  onSearch?: (value: string) => void
  /** 点右侧清除按钮 */
  onClear?: () => void
}

/**
 * 跨端搜索框：View + Input + AppIcon 自绘，不依赖任何 UI 库。
 *
 * ⚠️ 为什么不用 nutui 的 SearchBar：
 * 它内部的 Search / MaskClose 图标渲染 `<i>` 标签 + CSS `mask` 内嵌 base64 SVG，
 * `i` 不是小程序组件 → 节点直接为空，wxss 也不支持 mask 画法。
 *
 * 图标统一走 AppIcon（构建期光栅化的 PNG），跨端可靠。
 */
function AppSearchBar({
  value,
  placeholder = '搜索剧本名',
  onChange,
  onSearch,
  onClear,
}: AppSearchBarProps) {
  return (
    <View className='app-searchbar'>
      <View className='app-searchbar-leading'>
        <AppIcon name='search' tone='mute' size={18} />
      </View>
      <Input
        className='app-searchbar-input'
        value={value}
        placeholder={placeholder}
        placeholderClass='app-searchbar-placeholder'
        confirmType='search'
        onInput={(e) => onChange?.(e.detail.value)}
        onConfirm={(e) => onSearch?.(e.detail.value)}
      />
      {value.length > 0 && (
        <View
          className='app-searchbar-clear'
          onClick={() => onClear?.()}
          ariaRole='button'
          ariaLabel='清除搜索内容'
        >
          <AppIcon name='x' tone='mute' size={16} />
        </View>
      )}
    </View>
  )
}

export default AppSearchBar
