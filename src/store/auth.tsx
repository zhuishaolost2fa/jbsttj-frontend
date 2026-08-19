/**
 * 全局登录态。
 *
 * 会话真相由 tokenManager 持有，这里只是把它桥接成 React 状态：
 * 订阅 tokenManager 的变更 → 驱动 UI 更新。
 * 这样在非 React 环境（如 request 拦截器）里刷新/清除会话，UI 也能同步。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import Taro from '@tarojs/taro'
import { ApiError } from '../services/request'
import { tokenManager, type LogoutReason } from '../services/tokenManager'
import * as authApi from '../services/auth'
import type { AuthSession, AuthUser } from '../utils/authStorage'
import { LOGIN_PAGE } from '../constants/auth'

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

interface AuthContextValue {
  status: AuthStatus
  user: AuthUser | null
  isAuthenticated: boolean
  login: (email: string, password: string) => Promise<AuthSession>
  register: (email: string, password: string) => Promise<authApi.RegisterResult>
  logout: () => void
  /** 主动拉取一次身份信息，用于校验本地凭证是否仍有效 */
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

const LOGOUT_TIP: Record<LogoutReason, string> = {
  manual: '',
  expired: '登录已过期，请重新登录',
  refresh_failed: '登录状态失效，请重新登录',
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // 初始态直接读本地会话，避免刷新页面时 UI 从「未登录」闪一下再变「已登录」
  const initial = tokenManager.init()
  const [user, setUser] = useState<AuthUser | null>(initial?.user ?? null)
  const [status, setStatus] = useState<AuthStatus>(
    initial?.refreshToken ? 'loading' : 'unauthenticated'
  )
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // 订阅会话变化：其他模块（如 401 拦截）改动会话时同步到 UI
  useEffect(() => {
    return tokenManager.subscribe((session, reason) => {
      if (!mounted.current) return
      setUser(session?.user ?? null)
      setStatus(session ? 'authenticated' : 'unauthenticated')

      if (!session && reason && LOGOUT_TIP[reason]) {
        Taro.showToast({ title: LOGOUT_TIP[reason], icon: 'none', duration: 2500 })
      }
    })
  }, [])

  const refreshUser = useCallback(async () => {
    if (!tokenManager.isAuthenticated()) {
      if (mounted.current) setStatus('unauthenticated')
      return
    }
    try {
      const me = await authApi.fetchProfile()
      const session = tokenManager.getSession()
      const prevUser = session?.user
      const nextUser: AuthUser = {
        id: me.id,
        // 后端优先返回 email；缺省时沿用登录响应里解析到的
        email: me.email ?? prevUser?.email,
        role: me.role,
        // 验证状态来自 JWT 的 email_verified 声明，保留登录时解析出的
        emailVerified: me.email_verified ?? prevUser?.emailVerified,
        nickname: me.nickname ?? null,
        avatarUrl: me.avatar_url ?? null,
        avatarColor: me.avatar_color ?? 0,
        bio: me.bio ?? null,
        gender: me.gender ?? null,
        birthday: me.birthday ?? null,
        region: me.region ?? null,
      }
      // 回写到会话，保证刷新页面后仍有用户信息
      if (session) {
        tokenManager.setSession({ ...session, user: nextUser })
      }
      if (mounted.current) {
        setUser(nextUser)
        setStatus('authenticated')
      }
    } catch (err) {
      // 只有确实是鉴权失败才登出；网络不通时保留会话，等网络恢复后重试
      if (err instanceof ApiError && err.isAuthError) {
        tokenManager.clear('expired')
      } else if (mounted.current) {
        setStatus('authenticated')
      }
    }
  }, [])

  // 启动时校验一次本地凭证
  useEffect(() => {
    if (initial?.refreshToken) {
      void refreshUser()
    }
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const session = await authApi.login(email, password)
    return session
  }, [])

  const register = useCallback(async (email: string, password: string) => {
    return authApi.register(email, password)
  }, [])

  const logout = useCallback(() => {
    authApi.logout()
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      isAuthenticated: status === 'authenticated',
      login,
      register,
      logout,
      refreshUser,
    }),
    [status, user, login, register, logout, refreshUser]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth 必须在 <AuthProvider> 内部使用')
  }
  return ctx
}

/** 跳转登录页，登录成功后可回到 redirect 指定的页面 */
export function goLogin(redirect?: string): void {
  const url = redirect
    ? `${LOGIN_PAGE}?redirect=${encodeURIComponent(redirect)}`
    : LOGIN_PAGE
  void Taro.navigateTo({ url })
}
