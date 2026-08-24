import { createElement, useEffect } from 'react'
import { useDidShow, useDidHide, getEnv, ENV_TYPE } from '@tarojs/taro'
import { AuthProvider } from './store/auth'
// 阿里云 ARMS 前端监控（H5 / 小程序按构建平台自动分流）
import { initArms } from './monitor/arms'
// 全局样式
import './app.less'

/**
 * H5 运行时注入 favicon link 标签。
 * Taro 构建会篡改 index.html 中的 <link href>，所以改为 JS 注入；
 * 实际文件由 config/index.ts 的 copy.patterns（dev + build）拷到 dist 根目录，
 * scripts/copy-favicon.js 仅作 postbuild 兜底。
 */
function injectFavicon() {
  if (getEnv() !== ENV_TYPE.WEB || typeof document === 'undefined') return
  const links = [
    { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    { rel: 'icon', href: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
    { rel: 'icon', href: '/favicon.ico', sizes: 'any' },
    { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
  ]
  for (const { rel, href, ...attrs } of links) {
    // 已存在则跳过（dev HMR 可能多次调用）
    const existing = document.querySelector(`link[rel="${rel}"][href="${href}"]`)
    if (existing) continue
    const el = document.createElement('link')
    el.rel = rel
    el.href = href
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v as string)
    document.head.appendChild(el)
  }
}

/**
 * H5 禁用用户缩放（iOS Safari 自 iOS 10 起忽略 meta 的 user-scalable=no，
 * 必须拦截 gesturestart/gesturechange 才能阻止双指捏合缩放；
 * 双击缩放由 app.less 的 touch-action: manipulation 关闭）。
 */
function disablePinchZoom() {
  if (getEnv() !== ENV_TYPE.WEB || typeof document === 'undefined') return
  for (const type of ['gesturestart', 'gesturechange'] as const) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false })
  }
}

// ARMS 监控需在应用最早处初始化，以捕获启动期 JS 错误与首屏性能数据
initArms()
disablePinchZoom()

function App(props) {
  // 可以使用所有的 React Hooks
  useEffect(() => {
    injectFavicon()
  })

  // 对应 onShow
  useDidShow(() => {})

  // 对应 onHide
  useDidHide(() => {})

  // 全局登录态：包一层 Provider，任意页面可用 useAuth() 读取
  return createElement(AuthProvider, null, props.children)
}

export default App
