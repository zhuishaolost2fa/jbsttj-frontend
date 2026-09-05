/**
 * 鉴权接口层。
 *
 * 对接 jbsttj-backend 的 /api/v1/auth/*，其底层是 Supabase GoTrue。
 * 这里额外做两件事：
 *   1. snake_case 响应 → 前端会话模型
 *   2. Supabase 的英文错误 → 中文提示
 */

import Taro from '@tarojs/taro'
import { AUTH_PATH, IS_WEAPP } from '../constants/auth'
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
  /**
   * 登录来源：'wechat'=微信登录，其余为 null / 缺省（邮箱注册）。
   * 微信用户起初只有占位邮箱，前端据此把「修改邮箱」换成「绑定邮箱」。
   */
  provider?: string | null
  /** 当前账号是否已绑定微信身份；已绑定则不再显示「绑定微信」入口 */
  wechat_bound?: boolean
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

/**
 * 微信登录错误码 → 中文。
 *
 * 后端把微信返回的 errcode 原样编码成 `wechat_{errcode}`
 * （见 app/services/wechat.py），这里按 code 精确匹配，比匹配英文文案可靠。
 */
const WECHAT_ERROR_TEXT: Record<string, string> = {
  wechat_40029: '登录凭证已失效，请重新登录',
  wechat_45011: '操作过于频繁，请稍后再试',
  wechat_40226: '该微信账号已被限制登录',
  'wechat_-1': '微信服务暂时不可用，请稍后重试',
  wechat_login_failed: '微信登录失败，请确认小程序已配置真实 AppID',
  unsupported_env: '当前环境不支持微信登录',
}

/** 把接口异常转成可直接展示的中文提示 */
export function toFriendlyMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return '网络连接失败，请检查网络或确认后端服务已启动'
    if (err.code === 'service_unavailable') return '服务配置不完整，请联系管理员'
    if (err.code === 'stale_profile') return '资料已被他人修改，请刷新页面后重新编辑'
    if (err.code === 'invalid_credentials') return '当前密码不正确'
    if (err.code === 'validation_error') return '输入内容不符合要求，请检查后重试'
    // 绑定场景的结构化错误码
    if (err.code === 'wechat_already_bound') return '该微信已绑定到其他账号，请先解绑或直接登录那个账号'
    if (err.code === 'email_taken') return '该邮箱已被其他账号使用，请换一个'
    // Supabase 内置 SMTP 限流很紧（约 60 秒 1 封），绑定邮箱时最容易撞上
    if (err.code === 'over_email_send_rate_limit') return '发送过于频繁，请稍后再试'

    // 微信错误码是结构化的，优先按 code 命中；其余 wechat_* 用服务端原文兜底
    const wxText = WECHAT_ERROR_TEXT[err.code]
    if (wxText) return wxText
    if (err.code.startsWith('wechat_')) return err.message || '微信登录失败，请重试'

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

/**
 * 微信小程序一键登录：wx.login() 拿 code → 后端换 token → 写入全局会话。
 *
 * 返回的 token 由 Supabase GoTrue 签发，与邮箱登录**完全同构**，
 * 所以续期、401 拦截、退出登录、RLS 全都不需要额外适配。
 *
 * 两个注意点：
 *   1. code 一次性且 5 分钟有效。失败必须重新 Taro.login() 换新 code，
 *      不能拿同一个 code 重试 —— 后端会直接报 40029。
 *   2. 不收昵称 / 头像：后端建号时会用默认资料，用户可随后在资料页自行修改。
 *      登录时强弹授权会明显拖慢首次进入的转化。
 */
export async function loginWithWechat(): Promise<AuthSession> {
  if (!IS_WEAPP) {
    throw new ApiError('当前环境不支持微信登录', 400, 'unsupported_env')
  }
  const code = await getWxLoginCode()

  const data = await request<TokenResponse>({
    url: AUTH_PATH.wechatLogin,
    data: { code },
    auth: false,
  })

  const session = toSession(data)
  if (!session) {
    throw new ApiError('登录失败：服务端未返回有效凭证', 500, 'invalid_token_response')
  }
  tokenManager.setSession(session)
  return session
}

/**
 * 取一次 wx.login 的 code。
 *
 * 单独抽出来是因为登录与绑定都要用，且失败原因高度集中（AppID 未配置），
 * 提示语必须统一，不能让 wx.login 的英文原生错误直接抛给用户。
 */
async function getWxLoginCode(): Promise<string> {
  let code = ''
  try {
    const res = await Taro.login()
    code = res?.code || ''
  } catch (err) {
    // 最常见原因：project.config.json 里还是 touristappid
    console.warn('[auth] wx.login 调用失败:', err)
    throw new ApiError(
      '微信登录失败，请确认小程序已配置真实 AppID',
      500,
      'wechat_login_failed',
      err
    )
  }
  if (!code) {
    throw new ApiError('微信登录失败，未取到登录凭证', 500, 'wechat_login_failed')
  }
  return code
}

/**
 * 把微信绑定到**当前已登录**的账号上。
 *
 * 用途：老用户（邮箱注册）绑了微信之后，下次就能用微信一键登录进同一个账号，
 * 不会新建一个空账号把历史数据丢掉。要求登录态，后端绝不建新账号。
 */
export async function bindWechat(): Promise<void> {
  if (!IS_WEAPP) {
    throw new ApiError('当前环境不支持微信登录', 400, 'unsupported_env')
  }
  const code = await getWxLoginCode()
  await request<MessageResult>({
    url: AUTH_PATH.wechatBind,
    method: 'POST',
    data: { code },
  })
}

/** 发起绑定邮箱：向目标邮箱发 6 位验证码 */
export function startBindEmail(email: string): Promise<MessageResult> {
  return request<MessageResult>({
    url: AUTH_PATH.emailBindStart,
    method: 'POST',
    data: { email: email.trim() },
  })
}

/**
 * 确认绑定邮箱：校验验证码并改登录邮箱。
 *
 * 后端会返回**新签发的 token** —— 改邮箱后旧 token 里的 email claim 仍是
 * 占位邮箱，不换发的话前端要等下次刷新才看得到正确邮箱。
 */
export async function confirmBindEmail(email: string, code: string): Promise<AuthSession> {
  const data = await request<TokenResponse>({
    url: AUTH_PATH.emailBindConfirm,
    method: 'POST',
    data: { email: email.trim(), code: code.trim() },
  })
  const session = toSession(data)
  if (!session) {
    throw new ApiError('绑定成功但未拿到有效凭证，请重新登录', 500, 'invalid_token_response')
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

/**
 * 设置登录密码（微信用户专用）。
 *
 * 与 changePassword 的区别：不校验当前密码。微信用户建号时的密码是随机生成
 * 后即丢弃的，本人无从得知，要求输入当前密码等于把这条路堵死。
 */
export function setPassword(newPassword: string): Promise<MessageResult> {
  return request<MessageResult>({
    url: AUTH_PATH.setPassword,
    method: 'POST',
    data: { new_password: newPassword },
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
