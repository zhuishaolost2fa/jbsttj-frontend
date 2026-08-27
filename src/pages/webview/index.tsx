/**
 * 小程序内嵌 H5 页面（web-view）。
 *
 * 用途：DM 指南导入是重操作（几百 MB 分片直传），小程序端无法处理
 * （wx.chooseMessageFile 拿不到大文件、wx.request 单包仅 10MB），
 * 因此点击「导入 DM 指南」后跳转到本站 H5（https://jbs-ttj.store）完成导入。
 *
 * 注意：微信小程序 web-view 只能加载「业务域名」白名单内的站点。
 * 若小程序后台未配置 jbs-ttj.store，页面会加载失败（白屏），
 * 此时用顶部「复制链接」兜底，引导用户在手机浏览器/电脑端打开完成导入。
 */
import { useCallback, useState } from 'react'
import { View, Text, WebView } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import './index.less'

/** 导入 DM 指南的 H5 落地页 */
const DEFAULT_H5_URL = 'https://jbs-ttj.store'

function WebviewPage() {
  const router = useRouter()
  const [loadFailed, setLoadFailed] = useState(false)
  const url = router.params.url ? decodeURIComponent(router.params.url) : DEFAULT_H5_URL

  const handleCopyLink = useCallback(() => {
    Taro.setClipboardData({
      data: url,
      success: () => {
        Taro.showToast({ title: '链接已复制', icon: 'success' })
      },
    })
  }, [url])

  return (
    <View className='webview-page'>
      <View className='webview-tip'>
        <View className='webview-tip-body'>
          <Text className='webview-tip-title'>💡 请在下方 H5 页面登录后导入</Text>
          <Text className='webview-tip-sub'>
            小程序无法处理数百 MB 的分片上传，导入需在浏览器环境完成
          </Text>
          {loadFailed && (
            <Text className='webview-tip-error'>
              页面加载失败：请检查小程序后台是否已配置 jbs-ttj.store 为业务域名，或复制链接到浏览器打开
            </Text>
          )}
        </View>
        <View className='webview-copy-btn' onClick={handleCopyLink}>
          <Text className='webview-copy-text'>复制链接</Text>
        </View>
      </View>
      <WebView className='webview-body' src={url} onError={() => setLoadFailed(true)} />
    </View>
  )
}

export default WebviewPage
