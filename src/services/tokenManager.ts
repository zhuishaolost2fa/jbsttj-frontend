/**
 * Token 管理器：全局唯一的会话真相来源。
 *
 * 职责：
 *   1. 内存 + Storage 双层持有会话
 *   2. access_token 临期自动续签，且并发请求下**只发一次**刷新请求（单飞）
 *   3. 会话变化时通知订阅者（React 层据此更新 UI）
 *
 * 设计要点：刷新接口用**裸 Taro.request** 调用，不走 services/request.ts。
 * 否则 request → tokenManager → request 会形成循环依赖，且刷新请求自身返回 401 时
 * 会触发递归刷新。这里直连是最简单可靠的解法。
 */

import Taro from '@tarojs/taro'
import { buildApiUrl } from '../constants/api'
import {
  AUTH_PATH,
  DEFAULT_EXPIRES_IN,
  TOKEN_REFRESH_AHEAD_MS,
} from '../constants/auth'
import {
  clearSession,
  isExpired,
  loadSession,
  saveSession,
  type AuthSession,
  type AuthUser,
} from '../utils/authStorage'
import { decodeJwt, getJwtExpiryMs } from '../utils/jwt'

/** 后端 TokenResponse（snake_case） */
export interface TokenResponse {
  access_token: string
  refresh_token?: string | null
  token_type?: string
  expires_in?: number | null
  user?: Record<string, any> | null
}

/** 会话失效原因，用于给用户不同的提示文案 */
export type LogoutReason = 'manual' | 'expired' | 'refresh_failed'

type Listener = (session: AuthSession | null, reason?: LogoutReason) => void

/**
 * 从 TokenResponse.user 与 access_token（JWT）中提炼本地会话所需的用户信息。
 *
 * 取值优先级：响应体的 user 对象 > JWT claims。二者互为兜底——
 * 刷新接口有时只返回 token 不带 user，此时靠 JWT claims 也能拿到 id/email/role。
 *
 * 注意：Supabase 顶层 `role` 恒为 "authenticated"（Postgres 角色，非业务角色），
 * 这里仅作占位，真正的业务角色由 /auth/me 的 MeResponse 覆盖（见 store/auth.tsx）。
 */
function pickUser(
  raw: Record<string, any> | null | undefined,
  accessToken: string
): AuthUser | null {
  const claims = decodeJwt(accessToken)
  const src = raw && typeof raw === 'object' ? raw : {}
  // user_metadata 既可能在响应体的 user 上，也可能只在 JWT claims 里
  // （刷新接口常常不带 user），两处都取一遍互为兜底。
  const meta =
    (src.user_metadata as Record<string, any>) ??
    (claims?.user_metadata as Record<string, any>) ??
    {}

  const id = src.id ?? src.sub ?? claims?.sub
  if (!id) return null

  const email =
    (typeof src.email === 'string' && src.email) ||
    (typeof meta.email === 'string' && meta.email) ||
    (typeof claims?.email === 'string' && claims.email) ||
    undefined

  const role =
    (typeof src.role === 'string' && src.role) ||
    (typeof claims?.role === 'string' && claims.role) ||
    undefined

  // email_verified 在 user_metadata 里；email_confirmed_at 有值也代表已验证
  const emailVerified =
    meta.email_verified === true || !!src.email_confirmed_at
      ? true
      : undefined

  // 登录来源（'wechat' = 微信登录）。后端建号时写进 user_metadata 并随 JWT 下发，
  // 这样登录响应里就能直接判定来源，不必等 /auth/me 返回。
  const provider =
    (typeof meta.provider === 'string' && meta.provider) || undefined

  return { id: String(id), email, role, emailVerified, provider }
}

/**
 * 把后端 TokenResponse 转成本地会话。
 * @param fallbackRefreshToken 刷新接口有时不返回新的 refresh_token，此时沿用旧的
 */
export function toSession(
  data: TokenResponse,
  fallbackRefreshToken = ''
): AuthSession | null {
  if (!data?.access_token) return null

  // 过期时间优先取 JWT 自带的 exp（服务端权威，不受网络耗时/本机时钟影响），
  // 其次用响应体的 expires_in 折算，最后兜底默认值。
  const jwtExpiry = getJwtExpiryMs(data.access_token)
  const expiresIn = data.expires_in && data.expires_in > 0 ? data.expires_in : DEFAULT_EXPIRES_IN
  const expiresAt = jwtExpiry ?? Date.now() + expiresIn * 1000

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || fallbackRefreshToken,
    expiresAt,
    user: pickUser(data.user, data.access_token),
  }
}

class TokenManager {
  private session: AuthSession | null = null
  private initialized = false
  private refreshing: Promise<AuthSession | null> | null = null
  private listeners = new Set<Listener>()

  /** 惰性从 Storage 恢复，App 启动时调用一次即可 */
  init(): AuthSession | null {
    if (!this.initialized) {
      this.session = loadSession()
      this.initialized = true
    }
    return this.session
  }

  getSession(): AuthSession | null {
    return this.init()
  }

  isAuthenticated(): boolean {
    const s = this.getSession()
    // 只要 refresh_token 还在就算「有会话」，access_token 过期可以续
    return !!s?.refreshToken
  }

  setSession(session: AuthSession | null): void {
    this.initialized = true
    this.session = session
    if (session) {
      saveSession(session)
    } else {
      clearSession()
    }
    this.emit(session)
  }

  clear(reason: LogoutReason = 'manual'): void {
    this.initialized = true
    this.session = null
    this.refreshing = null
    clearSession()
    this.emit(null, reason)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(session: AuthSession | null, reason?: LogoutReason): void {
    this.listeners.forEach((fn) => {
      try {
        fn(session, reason)
      } catch (err) {
        console.error('[auth] 订阅回调执行出错:', err)
      }
    })
  }

  /**
   * 取一个可用的 access_token。
   * 临期（<5 分钟）会先续签再返回；没有会话或续签失败返回 null。
   */
  async getAccessToken(): Promise<string | null> {
    const session = this.getSession()
    if (!session) return null

    if (!isExpired(session, TOKEN_REFRESH_AHEAD_MS)) {
      return session.accessToken
    }
    const refreshed = await this.refresh()
    return refreshed?.accessToken ?? null
  }

  /**
   * 用 refresh_token 换新会话。并发调用共享同一个 Promise，避免重复刷新
   * ——Supabase 的 refresh_token 会滚动失效，并发刷新会导致后发的请求直接失败。
   */
  refresh(): Promise<AuthSession | null> {
    if (this.refreshing) return this.refreshing

    const current = this.getSession()
    if (!current?.refreshToken) {
      return Promise.resolve(null)
    }

    this.refreshing = this.doRefresh(current.refreshToken).finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async doRefresh(refreshToken: string): Promise<AuthSession | null> {
    try {
      const res = await Taro.request<TokenResponse | { error?: { message?: string } }>({
        url: buildApiUrl(AUTH_PATH.refresh),
        method: 'POST',
        data: { refresh_token: refreshToken },
        timeout: 15000,
        header: { 'Content-Type': 'application/json' },
      })

      if (res.statusCode < 200 || res.statusCode >= 300) {
        // refresh_token 也失效了，只能重新登录
        this.clear('refresh_failed')
        return null
      }

      const next = toSession(res.data as TokenResponse, refreshToken)
      if (!next) {
        this.clear('refresh_failed')
        return null
      }

      // 刷新只更新 token：用户信息以现有会话为准。
      // 现有 user 的 role 可能来自 /auth/me（真实业务角色），比刷新响应/JWT 里
      // 的占位 role（恒为 "authenticated"）更准；仅当本地没有用户信息时才回退。
      next.user = this.session?.user ?? next.user
      this.setSession(next)
      return next
    } catch (err) {
      // 网络异常不清会话：可能只是暂时断网，保留 refresh_token 供下次重试
      console.warn('[auth] 刷新 token 失败:', err)
      return null
    }
  }
}

export const tokenManager = new TokenManager()
