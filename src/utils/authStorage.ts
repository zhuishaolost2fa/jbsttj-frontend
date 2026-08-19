/**
 * 会话持久化。
 *
 * 用 Taro 的 Storage API 而不是直接用 localStorage，
 * 这样 H5 / 微信小程序 / 抖音小程序三端同一套代码。
 */

import Taro from '@tarojs/taro'
import { AUTH_STORAGE_KEY } from '../constants/auth'

export interface AuthUser {
  id: string
  email?: string
  role?: string
  /** 邮箱是否已验证（来自 user_metadata.email_verified / email_confirmed_at） */
  emailVerified?: boolean
  /** 昵称 */
  nickname?: string | null
  /** 自定义头像图片地址（为空时按 avatarColor 渲染默认头像） */
  avatarUrl?: string | null
  /** 默认头像配色索引 0~7 */
  avatarColor?: number | null
  /** 个人简介 */
  bio?: string | null
  /** 性别 */
  gender?: 'male' | 'female' | 'other' | null
  /** 生日 YYYY-MM-DD */
  birthday?: string | null
  /** 地区「省份 城市」 */
  region?: string | null
}

export interface AuthSession {
  accessToken: string
  refreshToken: string
  /** 绝对过期时间戳（毫秒），由 expires_in 换算而来 */
  expiresAt: number
  user: AuthUser | null
}

/** 从存储读取会话，数据损坏或结构不完整时返回 null */
export function loadSession(): AuthSession | null {
  try {
    const raw = Taro.getStorageSync(AUTH_STORAGE_KEY)
    if (!raw) return null

    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!parsed || typeof parsed !== 'object') return null

    const s = parsed as Partial<AuthSession>
    // refreshToken 是续命的唯一凭据，缺了这条记录就没有保留价值
    if (!s.accessToken || !s.refreshToken || typeof s.expiresAt !== 'number') {
      return null
    }
    return {
      accessToken: s.accessToken,
      refreshToken: s.refreshToken,
      expiresAt: s.expiresAt,
      user: s.user ?? null,
    }
  } catch {
    return null
  }
}

export function saveSession(session: AuthSession): void {
  try {
    Taro.setStorageSync(AUTH_STORAGE_KEY, JSON.stringify(session))
  } catch (err) {
    // 存储写满或隐私模式下会抛错，此时降级为「仅本次会话有效」，不影响当前使用
    console.warn('[auth] 会话持久化失败，本次登录状态不会保留:', err)
  }
}

export function clearSession(): void {
  try {
    Taro.removeStorageSync(AUTH_STORAGE_KEY)
  } catch {
    /* 清理失败无需打断流程 */
  }
}

/** access_token 是否已过期（或即将在 aheadMs 内过期） */
export function isExpired(session: AuthSession, aheadMs = 0): boolean {
  return Date.now() + aheadMs >= session.expiresAt
}
