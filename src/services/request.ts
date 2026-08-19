/**
 * 统一请求封装（仅用于和自家 FastAPI 后端通信）。
 *
 * 后端响应约定（见 app/core/exceptions.py）：
 *   - 成功：直接返回业务模型本身，**没有** { code, message, data } 外层包装
 *   - 失败：{ "error": { "code": "unauthorized", "message": "...", "details": ... } }
 *
 * 本层额外负责：
 *   - 自动注入 Authorization: Bearer <access_token>（临期会先续签）
 *   - 收到 401 时刷新一次 token 并重放请求，刷新失败则清空会话
 *
 * 注意：上传分片到 OSS 不要走这里，那条链路需要读响应头拿 ETag，用原生 XHR。
 */

import Taro from '@tarojs/taro'
import { buildApiUrl } from '../constants/api'
import { REAUTH_ERROR_CODES } from '../constants/auth'
import { tokenManager } from './tokenManager'

export class ApiError extends Error {
  /** HTTP 状态码，网络层失败为 0 */
  status: number
  /** 后端业务错误码，如 unauthorized / validation_error */
  code: string
  details?: unknown

  constructor(message: string, status: number, code = 'unknown', details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }

  /** 是否属于「需要重新登录」的错误 */
  get isAuthError(): boolean {
    return this.status === 401 || REAUTH_ERROR_CODES.has(this.code)
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

export interface RequestOptions {
  url: string
  method?: HttpMethod
  data?: Record<string, any>
  /** 超时，合并分片等重接口给足时间 */
  timeout?: number
  /** 是否携带 token，默认 true；登录/注册接口传 false */
  auth?: boolean
  /** 额外的自定义请求头（如乐观并发用的 If-Match） */
  headers?: Record<string, string>
  /** 内部使用：标记这是 401 之后的重放，避免无限重试 */
  _retried?: boolean
}

interface BackendError {
  error?: { code?: string; message?: string; details?: unknown }
}

/** 从后端响应体中解析出可读的错误信息 */
function parseError(body: any, statusCode: number): ApiError {
  const err = (body as BackendError)?.error
  if (err && typeof err === 'object') {
    return new ApiError(
      err.message || `请求失败（HTTP ${statusCode}）`,
      statusCode,
      err.code || 'unknown',
      err.details
    )
  }
  // FastAPI 未被兜底处理器捕获时可能是 { detail: "..." }
  if (body && typeof body.detail === 'string') {
    return new ApiError(body.detail, statusCode, `http_${statusCode}`)
  }
  return new ApiError(`服务异常（HTTP ${statusCode}）`, statusCode, `http_${statusCode}`)
}

export async function request<T>(options: RequestOptions): Promise<T> {
  const { url, method = 'POST', data, timeout = 30000, auth = true } = options

  const header: Record<string, string> = { 'Content-Type': 'application/json' }

  if (auth) {
    const token = await tokenManager.getAccessToken()
    if (token) header.Authorization = `Bearer ${token}`
  }

  if (options.headers) {
    Object.assign(header, options.headers)
  }

  let res: Taro.request.SuccessCallbackResult<any>
  try {
    res = await Taro.request<any>({
      url: buildApiUrl(url),
      method,
      data,
      timeout,
      header,
    })
  } catch (err: any) {
    throw new ApiError(
      err?.errMsg || '网络请求失败，请检查网络后重试',
      0,
      'network_error'
    )
  }

  // 401：刷新 token 后重放一次
  if (res.statusCode === 401 && auth && !options._retried) {
    const refreshed = await tokenManager.refresh()
    if (refreshed) {
      return request<T>({ ...options, _retried: true })
    }
    // 刷新拿不到新 token：如果本地还留着会话，说明是 token 真的失效了，清掉
    if (tokenManager.getSession()) {
      tokenManager.clear('expired')
    }
    throw parseError(res.data, 401)
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw parseError(res.data, res.statusCode)
  }

  // 204 No Content（如取消上传任务）
  if (res.statusCode === 204 || res.data === '' || res.data === undefined) {
    return undefined as T
  }

  return res.data as T
}

/** GET 语义糖，参数会被拼成 query string */
export function get<T>(url: string, params?: Record<string, any>, timeout?: number): Promise<T> {
  return request<T>({ url, method: 'GET', data: params, timeout })
}
