import type { ReactNode } from 'react'
import { Text, View } from '@tarojs/components'
import './index.less'

interface AppButtonProps {
  /** 块级：占满父容器宽度（默认 inline-flex，宽度由内容撑开） */
  block?: boolean
  /** 配色：primary = 品牌渐变，default = 中性灰 */
  type?: 'primary' | 'default'
  /** 尺寸：large = 46px 高（主操作），small = 34px 高（浮层内的次级操作） */
  size?: 'large' | 'small'
  /** 填充：solid = 实心，outline = 描边透明底 */
  fill?: 'solid' | 'outline'
  disabled?: boolean
  onClick?: () => void
  children?: ReactNode
}

/**
 * 跨端按钮：只用 View + Text 自绘，不依赖任何 UI 库。
 *
 * ⚠️ 为什么不用 nutui 的 Button：
 * nutui-react-taro 的 Button 内部直接 `React.createElement("button")` 再套
 * `createElement("div", { className: "nut-button-wrap" })`，是原生 HTML 标签。
 * 小程序端节点靠 `dist/base.wxml` 的模板按组件编号渲染，而 `@tarojs/plugin-html`
 * 的 HTML→小程序标签映射与模板登记只在编译期处理**项目源码的 .tsx**
 * （见 @tarojs/vite-runner/dist/mini/native-support.js 的 moduleParsed），
 * node_modules 里已编译的 nutui .js 不参与 —— 于是 `button`(编号 14) 与 `div`
 * 都没有对应模板，运行时模板引用静默失败，整棵子树渲染成空节点。
 * 换成 View + Text 后两端都走项目源码，模板会被正常登记。
 */
function AppButton({
  block = false,
  type = 'primary',
  size = 'large',
  fill = 'solid',
  disabled = false,
  onClick,
  children,
}: AppButtonProps) {
  const cls = [
    'app-btn',
    `is-${size}`,
    `is-${type}`,
    fill === 'outline' ? 'is-outline' : '',
    block ? 'is-block' : '',
    disabled ? 'is-disabled' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <View
      className={cls}
      hoverClass={disabled ? undefined : 'is-pressed'}
      hoverStayTime={80}
      onClick={() => {
        if (disabled) return
        onClick?.()
      }}
    >
      <Text className='app-btn-text'>{children}</Text>
    </View>
  )
}

export default AppButton
