import { createElement, useEffect } from 'react'
import { useDidShow, useDidHide } from '@tarojs/taro'
import { AuthProvider } from './store/auth'
// 全局样式
import './app.less'

function App(props) {
  // 可以使用所有的 React Hooks
  useEffect(() => {})

  // 对应 onShow
  useDidShow(() => {})

  // 对应 onHide
  useDidHide(() => {})

  // 全局登录态：包一层 Provider，任意页面可用 useAuth() 读取
  return createElement(AuthProvider, null, props.children)
}

export default App
