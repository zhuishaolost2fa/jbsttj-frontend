/**
 * 鉴权相关常量。
 *
 * 后端基于 Supabase GoTrue：
 *   POST /auth/register  → TokenResponse（开启邮箱验证时 access_token 为空）
 *   POST /auth/login     → TokenResponse
 *   POST /auth/refresh   → TokenResponse
 *   GET  /auth/me        → MeResponse
 */

export const AUTH_PATH = {
  register: '/auth/register',
  login: '/auth/login',
  refresh: '/auth/refresh',
  me: '/auth/me',
  /** PATCH /auth/me：部分更新个人资料，支持 If-Match 乐观并发 */
  updateProfile: '/auth/me',
  changePassword: '/auth/change-password',
  changeEmail: '/auth/change-email',
  /** POST /auth/me/avatar：上传头像图片（multipart/form-data，字段名 file） */
  uploadAvatar: '/auth/me/avatar',
  /** POST /auth/wechat/login：wx.login 的 code 换 token（仅微信小程序端可用） */
  wechatLogin: '/auth/wechat/login',
  /** POST /auth/wechat/bind：把微信绑到**当前登录账号**上，不建新号 */
  wechatBind: '/auth/wechat/bind',
  /** POST /auth/me/email/bind/start：向目标邮箱发验证码 */
  emailBindStart: '/auth/me/email/bind/start',
  /** POST /auth/me/email/bind/confirm：校验验证码并改邮箱，返回新 token */
  emailBindConfirm: '/auth/me/email/bind/confirm',
  /** POST /auth/me/password/set：微信用户设置登录密码（不校验当前密码） */
  setPassword: '/auth/me/password/set',
} as const

/**
 * 是否运行在微信小程序环境。
 *
 * 编译期常量：Taro 构建时把 `process.env.TARO_ENV` 替换成字面量，
 * 所以 H5 产物里 `IS_WEAPP` 恒为 false，微信分支会被静态消除，
 * 不会把 Taro.login 相关代码打进 H5 包。
 */
export const IS_WEAPP = process.env.TARO_ENV === 'weapp'

/** 会话在本地存储中的 key */
export const AUTH_STORAGE_KEY = 'jbsttj_auth_session'

/**
 * 提前刷新窗口：距过期不足 5 分钟就主动换新 token。
 * Supabase 默认 access_token 有效期 1 小时，refresh_token 可长期滚动使用。
 */
export const TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000

/**
 * 兜底有效期：后端未返回 expires_in 时按 1 小时算。
 * 宁可早刷新也不要拿着过期 token 打请求。
 */
export const DEFAULT_EXPIRES_IN = 3600

/** 后端 RegisterRequest/LoginRequest 的 password 约束为 min_length=6, max_length=128 */
export const PASSWORD_MIN_LENGTH = 6
export const PASSWORD_MAX_LENGTH = 128

/** 登录页路径 */
export const LOGIN_PAGE = '/pages/login/index'
/**
 * 登录成功后的默认落地页。
 *
 * 原先指向 `/pages/index/index`（独立搜索首页），但该页已从 app.config.ts
 * 的 pages 中移除（搜索框已合并进「剧本」tab 顶部），reLaunch 到未注册页面
 * 会直接报错、让用户卡在登录页。改成 tabBar 的落地页「剧本」。
 */
export const HOME_PAGE = '/pages/scripts/index'

/** 需要重新登录的后端错误码（app/core/security.py 中抛出的 AuthError code） */
export const REAUTH_ERROR_CODES = new Set([
  'token_expired',
  'invalid_token',
  'missing_token',
  'invalid_audience',
  'unknown_kid',
])
