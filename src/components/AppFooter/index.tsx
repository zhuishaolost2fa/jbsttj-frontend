import { Text, View } from '@tarojs/components'
import './index.less'

/**
 * 全站页脚 —— ICP 备案号。
 *
 * 合规要求：域名完成 ICP 备案后，必须在网站页面底部悬挂备案号，
 * 并链接到工信部备案查询系统（beian.miit.gov.cn）。腾讯云会抽查。
 *
 * 跨端差异：
 *   - H5：备案号 + 可点击跳转工信部的链接
 *   - 小程序：小程序不允许跳外部网页链接，只展示备案号文本（符合要求）
 *
 * 备案信息（2026-09-15 通过）
 *   主体备案号：浙ICP备2026072486号
 */
const IS_H5 = process.env.TARO_ENV === 'h5'

const BEIAN_NO = '浙ICP备2026072486号'
const BEIAN_URL = 'https://beian.miit.gov.cn/'

export default function AppFooter() {
  const openBeian = () => {
    // 双保险：编译期常量 + 运行时守卫，避免小程序端误触 window
    if (!IS_H5) return
    if (typeof window === 'undefined') return
    window.open(BEIAN_URL, '_blank', 'noopener,noreferrer')
  }

  return (
    <View className='app-footer'>
      <Text className='app-footer__no'>{BEIAN_NO}</Text>
      {IS_H5 ? (
        // ariaRole 只有 View 支持（Text 的 TextProps 没有这个字段），所以这里用 View 包一层
        <View
          className='app-footer__link'
          onClick={openBeian}
          ariaRole='link'
          ariaLabel='工信部备案查询'
        >
          <Text>工信部备案查询</Text>
        </View>
      ) : null}
    </View>
  )
}
