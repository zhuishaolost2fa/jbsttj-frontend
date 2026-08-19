/**
 * 鉴权接口层。
 *
 * 对接 jbsttj-backend 的 /api/v1/auth/*，其底层是 Supabase GoTrue。
 * 这里额外做两件事：
 *   1. snake_case 响应 → 前端会话模型
 *   2. Supabase 的英文错误 → 中文提示
 */

import { AUTH_PATH } from '../constants/auth'
import { ApiError, get, request } from './request'
import { buildApiUrl } from '../constants/api'
import { toSession, tokenManager, type TokenResponse } from './tokenManager'
import type { AuthSession } from '../utils/authStorage'

export type Gender = 'male' | 'female' | 'other'

/** 后端 ProfileResponse：当前用户的完整资料 */
export interface Profile {
  id: string
  email?: string | null
  role: string
  is_service: boolean
  email_verified?: boolean
  nickname?: string | null
  avatar_url?: string | null
  avatar_color?: number
  bio?: string | null
  gender?: Gender | null
  birthday?: string | null
  region?: string | null
  created_at?: string | null
  updated_at?: string | null
}

/** PATCH /auth/me 的入参：所有字段可选，只传要改的 */
export interface ProfilePatch {
  nickname?: string | null
  avatar_url?: string | null
  /** 设为 null 表示清空渐变头像（已有真实图片时） */
  avatar_color?: number | null
  bio?: string | null
  gender?: Gender | null
  birthday?: string | null
  region?: string | null
}

export interface RegisterResult {
  /** 是否已直接拿到登录态。Supabase 开启邮箱验证时为 false */
  loggedIn: boolean
  session: AuthSession | null
  /** 需要邮箱验证时给用户看的提示 */
  message: string
}

/** 通用提示响应（改密 / 改邮箱等） */
export interface MessageResult {
  message: string
}

/** Supabase 常见错误文案 → 中文，避免把英文原文糊到用户脸上 */
const ERROR_TEXT_MAP: Array<[RegExp, string]> = [
  [/invalid login credentials/i, '邮箱或密码不正确'],
  [/email not confirmed/i, '邮箱尚未验证，请先到邮箱点击验证链接'],
  [/user already registered|already been registered/i, '该邮箱已注册，请直接登录'],
  [/password should be at least/i, '密码长度不足，至少 6 位'],
  [/unable to validate email address/i, '邮箱格式不正确'],
  [/for security purposes.*after (\d+) seconds/i, '操作过于频繁，请稍后再试'],
  [/email rate limit exceeded/i, '邮件发送过于频繁，请稍后再试'],
  [/signups not allowed|signup is disabled/i, '当前未开放注册，请联系管理员'],
  [/weak password/i, '密码强度不足，请使用更复杂的密码'],
]

/** 把接口异常转成可直接展示的中文提示 */
export function toFriendlyMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return '网络连接失败，请检查网络或确认后端服务已启动'
    if (err.code === 'service_unavailable') return '服务配置不完整，请联系管理员'
    if (err.code === 'stale_profile') return '资料已被他人修改，请刷新页面后重新编辑'
    if (err.code === 'invalid_credentials') return '当前密码不正确'
    if (err.code === 'validation_error') return '输入内容不符合要求，请检查后重试'

    for (const [pattern, text] of ERROR_TEXT_MAP) {
      if (pattern.test(err.message)) return text
    }
    return err.message || '请求失败，请稍后重试'
  }
  if (err instanceof Error) return err.message
  return '未知错误，请稍后重试'
}

/** 注册。成功且未开启邮箱验证时会直接写入登录态 */
export async function register(email: string, password: string): Promise<RegisterResult> {
  const data = await request<TokenResponse>({
    url: AUTH_PATH.register,
    data: { email: email.trim(), password },
    auth: false,
  })

  const session = toSession(data)
  if (session) {
    tokenManager.setSession(session)
    return { loggedIn: true, session, message: '注册成功' }
  }

  // access_token 为空 = Supabase 开启了邮箱验证，需要用户先去邮箱确认
  return {
    loggedIn: false,
    session: null,
    message: '注册成功，请前往邮箱完成验证后再登录',
  }
}

/** 邮箱密码登录，成功后写入全局会话 */
export async function login(email: string, password: string): Promise<AuthSession> {
  const data = await request<TokenResponse>({
    url: AUTH_PATH.login,
    data: { email: email.trim(), password },
    auth: false,
  })

  const session = toSession(data)
  if (!session) {
    throw new ApiError('登录失败：服务端未返回有效凭证', 500, 'invalid_token_response')
  }
  tokenManager.setSession(session)
  return session
}

/** 查询当前登录身份与资料，返回完整 Profile */
export function fetchProfile(): Promise<Profile> {
  return get<Profile>(AUTH_PATH.me, undefined, 15000)
}

/**
 * 部分更新个人资料。
 * @param patch   只含要修改的字段
 * @param ifMatch 乐观并发令牌（GET 拿到的 updated_at）；传了则服务端做冲突检测
 */
export async function updateProfile(patch: ProfilePatch, ifMatch?: string | null): Promise<Profile> {
  return request<Profile>({
    url: AUTH_PATH.updateProfile,
    method: 'PATCH',
    data: patch,
    headers: ifMatch ? { 'If-Match': ifMatch } : undefined,
  })
}

/** 修改登录密码（需当前密码校验） */
export async function changePassword(currentPassword: string, newPassword: string): Promise<MessageResult> {
  return request<MessageResult>({
    url: AUTH_PATH.changePassword,
    method: 'POST',
    data: { current_password: currentPassword, new_password: newPassword },
  })
}

/** 修改登录邮箱（需当前密码校验，向新邮箱发验证邮件） */
export async function changeEmail(currentPassword: string, newEmail: string): Promise<MessageResult> {
  return request<MessageResult>({
    url: AUTH_PATH.changeEmail,
    method: 'POST',
    data: { current_password: currentPassword, new_email: newEmail.trim() },
  })
}

/**
 * 上传头像图片（裁剪后的 Blob）。
 *
 * 走「后端中转上传」：直接把图片以 multipart/form-data 提交给
 * ``POST /auth/me/avatar``，后端复用文件服务的 simple_upload 写入 OSS 并落库，
 * 返回更新后的完整 Profile。这种方式不需要前端持有 OSS 凭证，也不依赖
 * bucket 公开读 / CORS 配置，最稳。
 *
 * 字段名使用后端约定的 ``file``；图片类型按 Blob.type 推导文件名后缀。
 */
export async function uploadAvatar(file: Blob): Promise<Profile> {
  const accessToken = await tokenManager.getAccessToken()
  const ext =
    file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
  const form = new FormData()
  form.append('file', file, `avatar.${ext}`)

  const res = await fetch(buildApiUrl(AUTH_PATH.uploadAvatar), {
    method: 'POST',
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
    body: form,
  })

  if (!res.ok) {
    let body: any = {}
    try {
      body = await res.json()
    } catch {
      /* 忽略非 JSON 响应 */
    }
    const e = body?.error
    throw new ApiError(
      e?.message || `上传失败（HTTP ${res.status}）`,
      res.status,
      e?.code || `http_${res.status}`,
      e?.details
    )
  }

  return (await res.json()) as Profile
}

/**
 * 退出登录。
 * 后端未提供 logout 接口（Supabase 的 token 是无状态 JWT），本地清除即可。
 */
export function logout(): void {
  tokenManager.clear('manual')
}
