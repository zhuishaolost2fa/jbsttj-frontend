import { Input, Text, View } from '@tarojs/components'
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
 * 跨端搜索框：只用 View + Input + Text 自绘，不依赖任何 UI 库。
 *
 * ⚠️ 为什么不用 nutui 的 SearchBar：
 * 它本身用的是 `@tarojs/components` 的 View/Input（能渲染），但内部的
 * Search / ArrowLeft / MaskClose 图标来自 `@nutui/icons-react-taro`，
 * 后者统一渲染 `<i>` 标签 + CSS `mask` 内嵌 base64 SVG：
 *   1. `i` 不是小程序组件，`dist/base.wxml` 里没有对应模板 → 节点直接为空；
 *   2. 即便标签能映射，wxss 也不支持 `mask` + base64 SVG 这种画法。
 * 小程序端 `<image>` 同样不支持 SVG，所以图标改用文本字符（与站内
 * 「📄 导入 DM 指南」「💬 问答」等用法一致）。
 */
function AppSearchBar({
  value,
  placeholder = '搜索...',
  onChange,
  onSearch,
  onClear,
}: AppSearchBarProps) {
  return (
    <View className='app-searchbar'>
      <Text className='app-searchbar-icon'>🔍</Text>
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
        <View className='app-searchbar-clear' onClick={() => onClear?.()}>
          <Text className='app-searchbar-clear-text'>✕</Text>
        </View>
      )}
    </View>
  )
}

export default AppSearchBar
