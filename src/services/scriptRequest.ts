/**
 * 剧本「求解析」接口层（对接 jbsttj-backend 的 /scripts/requests/*）。
 *
 * 语义见 app/api/v1/script_requests.py：
 *   - POST   /scripts/requests            发起求解析（同一用户对同一剧本幂等）
 *   - GET    /scripts/requests/me         我的求解析列表（分页，可按 status 过滤）
 *   - GET    /scripts/requests/leaderboard 全站求解析排行榜（无需登录）
 *   - DELETE /scripts/requests/{id}      取消求解析（软取消，可复活）
 *
 * 后端出参已统一小驼峰（schemas/script_request.py 开了 alias_generator=to_camel），
 * 前端直接按驼峰声明类型；仅 pagination.has_more 在嵌套 Pagination 模型上可能仍为
 * 蛇形，读取时做兜底（与 services/script.ts 同款处理）。
 */

import { get, request, type ApiError } from './request'

/** 求解析状态机（与 sql/script_requests.sql 的 CHECK 约束一致） */
export type ScriptRequestStatus = 'pending' | 'completed' | 'cancelled'

/** 一条求解析记录（出参为小驼峰，对应 ScriptRequestItem） */
export interface ScriptRequestItem {
  id: string
  scriptId?: string | null
  scriptCode?: string | null
  scriptTitle: string
  reason?: string | null
  coverUrl?: string | null
  /** 该剧本当前是否已解析完成（读取时与 script_dm_documents 实时判定） */
  hasGuide: boolean
  status: ScriptRequestStatus
  cancelledAt?: string | null
  completedAt?: string | null
  createdAt?: string | null
  /** 仅创建接口返回：true=复用已有记录（重复发起或取消后复活） */
  alreadyExists?: boolean
}

export interface ScriptRequestPagination {
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface ScriptRequestListResult {
  items: ScriptRequestItem[]
  pagination: ScriptRequestPagination
}

export interface ScriptRequestLeaderboardItem {
  scriptId?: string | null
  scriptCode?: string | null
  scriptTitle: string
  coverUrl?: string | null
  requestCount: number
}

export interface ScriptRequestLeaderboardResult {
  items: ScriptRequestLeaderboardItem[]
  pagination: ScriptRequestPagination
}

export interface ScriptRequestCreatePayload {
  /** 剧本名称（必填）。库中剧本会自动回填真实标题 */
  scriptTitle: string
  /** 剧本 UUID，与 scriptCode 二选一 */
  scriptId?: string
  /** 剧本业务编码，与 scriptId 二选一 */
  scriptCode?: string
  /** 期望解析的原因 / 补充说明 */
  reason?: string
}

/**
 * 发起求解析。
 *
 * 后端按 scriptId / scriptCode / scriptTitle 三选一定位剧本；同一用户对同一剧本
 * 幂等——重复发起（仍 pending）返回既有记录（`alreadyExists=true`），已取消的会
 * 复活回待解析。
 *
 * 特殊错误：剧本已解析完成时抛 `ApiError(409, code='script_already_parsed')`，
 * 调用方可据此提示「该剧本已解析完成」。
 */
export async function createScriptRequest(
  payload: ScriptRequestCreatePayload
): Promise<ScriptRequestItem> {
  const body: Record<string, unknown> = { scriptTitle: payload.scriptTitle }
  if (payload.scriptId) body.scriptId = payload.scriptId
  if (payload.scriptCode) body.scriptCode = payload.scriptCode
  if (payload.reason) body.reason = payload.reason
  return request<ScriptRequestItem>({
    url: '/scripts/requests',
    method: 'POST',
    data: body,
  })
}

export interface MyScriptRequestsQuery {
  status?: ScriptRequestStatus
  limit?: number
  offset?: number
}

/** 归一分页：后端嵌套 Pagination 可能序列化为 has_more（蛇形） */
function normalizePagination(
  pg: Record<string, any>,
  fallback: { limit: number; offset: number }
): ScriptRequestPagination {
  return {
    total: Number(pg.total ?? 0),
    limit: Number(pg.limit ?? fallback.limit),
    offset: Number(pg.offset ?? fallback.offset),
    hasMore: Boolean(pg.hasMore ?? pg.has_more ?? false),
  }
}

/**
 * 我的求解析列表（需登录）。
 *
 * 走 `GET /scripts/requests/me`，返回前会先把「剧本已被解析」的诉求自动流转为
 * completed，因此 `completed` 项即表示该剧本已解析完成。
 */
export async function fetchMyScriptRequests(
  query: MyScriptRequestsQuery = {}
): Promise<ScriptRequestListResult> {
  const params: Record<string, any> = {
    limit: query.limit ?? 20,
    offset: query.offset ?? 0,
  }
  if (query.status) params.status = query.status

  const res = await get<{
    items: ScriptRequestItem[]
    pagination: Record<string, any>
  }>('/scripts/requests/me', params)
  return {
    items: res?.items ?? [],
    pagination: normalizePagination(
      (res?.pagination ?? {}) as Record<string, any>,
      { limit: params.limit, offset: params.offset }
    ),
  }
}

/** 求解析排行榜（公开，无需登录）。 */
export async function fetchScriptRequestLeaderboard(
  query: { limit?: number; offset?: number } = {}
): Promise<ScriptRequestLeaderboardResult> {
  const params: Record<string, any> = {
    limit: query.limit ?? 20,
    offset: query.offset ?? 0,
  }
  const res = await get<{
    items: ScriptRequestLeaderboardItem[]
    pagination: Record<string, any>
  }>('/scripts/requests/leaderboard', params)
  return {
    items: res?.items ?? [],
    pagination: normalizePagination(
      (res?.pagination ?? {}) as Record<string, any>,
      { limit: params.limit, offset: params.offset }
    ),
  }
}

/**
 * 取消求解析（软取消，不删行，可再次发起复活）。
 * 已取消的重复取消幂等返回现状；已完成的诉求不能取消（抛 409）。
 */
export async function cancelScriptRequest(
  requestId: string
): Promise<ScriptRequestItem> {
  return request<ScriptRequestItem>({
    url: `/scripts/requests/${encodeURIComponent(requestId)}`,
    method: 'DELETE',
  })
}

export type { ApiError }
