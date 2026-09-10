/**
 * 站内消息（收件箱）接口层。
 *
 * 对接后端 `/api/v1/messages`：
 *   - GET    /messages                  我的消息列表（分页、类型/未读过滤）
 *   - GET    /messages/unread-count     未读数（tabbar 红点轮询）
 *   - POST   /messages/read-all         全部已读
 *   - PATCH  /messages/{id}/read        单条已读
 *   - POST   /messages/read-batch       批量已读
 *   - DELETE /messages/{id}             物理删除
 *
 * 后端 pydantic 出参已统一小驼峰（`response_model_by_alias=True`，
 * `alias_generator=to_camel`），前端直接按驼峰声明类型。
 *
 * ⚠️ 抽页签级别共享：profile 与 messages 两个页都会读 `unreadCount`，
 * 建议在 store 里集中维护（避免两个页分别拉），目前为简化先各拉各的。
 */

import { get, request, type ApiError } from './request'

/** 消息类型（与后端 `ck_user_messages_type` 一致） */
export type MessageType = 'system' | 'question_answered' | 'script_parsed'

/** 类型过滤项 —— 不传等于全部 */
export const MESSAGE_TYPES: MessageType[] = [
  'system',
  'question_answered',
  'script_parsed',
]

/** 卡片上给人看的标签（与服务端文案有微差时优先用本地的，便于运营调整） */
export const MESSAGE_LABELS: Record<MessageType, string> = {
  system: '系统通知',
  question_answered: '问题被回答',
  script_parsed: '求解析已达成',
}

/** 卡片左侧的小图标（与 IconName 严格对应） */
export const MESSAGE_ICON: Record<MessageType, 'inbox' | 'message-circle' | 'check-circle'> = {
  system: 'inbox',
  question_answered: 'message-circle',
  script_parsed: 'check-circle',
}

export interface MessageData {
  scriptId?: string | null
  scriptCode?: string | null
  scriptTitle?: string | null
  questionId?: string | null
  requestId?: string | null
}

export interface MessageItem {
  id: string
  type: MessageType
  title: string
  content: string
  actorId?: string | null
  data: MessageData
  read: boolean
  readAt?: string | null
  createdAt?: string | null
}

export interface MessagePagination {
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface MessageListResult {
  items: MessageItem[]
  pagination: MessagePagination
  unreadCount: number
}

export interface UnreadCountResult {
  unreadCount: number
}

export interface MarkReadResult {
  updated: number
  unreadCount: number
}

export interface ListMessagesQuery {
  type?: MessageType
  /** true=只看未读 */
  unreadOnly?: boolean
  limit?: number
  offset?: number
}

/** 后端嵌套 Pagination 可能序列化为 hasMore / has_more，两种都兜底 */
function normalizePagination(
  pg: Record<string, any> | undefined,
  fallback: { limit: number; offset: number }
): MessagePagination {
  const safe = pg ?? {}
  return {
    total: Number(safe.total ?? 0),
    limit: Number(safe.limit ?? fallback.limit),
    offset: Number(safe.offset ?? fallback.offset),
    hasMore: Boolean(safe.hasMore ?? safe.has_more ?? false),
  }
}

/** 我的消息列表（需登录）。 */
export async function fetchMessages(
  query: ListMessagesQuery = {}
): Promise<MessageListResult> {
  const params: Record<string, any> = {
    limit: query.limit ?? 20,
    offset: query.offset ?? 0,
  }
  if (query.type) params.type = query.type
  if (query.unreadOnly) params.unreadOnly = true

  const res = await get<{
    items: MessageItem[]
    pagination: Record<string, any>
    unreadCount?: number
  }>('/messages', params)
  return {
    items: res?.items ?? [],
    pagination: normalizePagination(
      res?.pagination as Record<string, any> | undefined,
      { limit: params.limit, offset: params.offset }
    ),
    unreadCount: Number(res?.unreadCount ?? 0),
  }
}

/** 未读条数。轻量接口，30s 一次轮询可控。 */
export async function fetchUnreadCount(): Promise<number> {
  const res = await get<UnreadCountResult>('/messages/unread-count')
  return Number(res?.unreadCount ?? 0)
}

/** 单条已读（重复点幂等：updated=0，返回里的 unreadCount 仍是当前真实未读数）。 */
export async function markMessageRead(
  messageId: string
): Promise<MarkReadResult> {
  return request<MarkReadResult>({
    url: `/messages/${encodeURIComponent(messageId)}/read`,
    method: 'PATCH',
  })
}

/** 全部已读。 */
export async function markAllMessagesRead(): Promise<MarkReadResult> {
  return request<MarkReadResult>({
    url: '/messages/read-all',
    method: 'POST',
  })
}

/** 批量已读（最多 100 条）。 */
export async function markMessagesReadBatch(
  messageIds: string[]
): Promise<MarkReadResult> {
  return request<MarkReadResult>({
    url: '/messages/read-batch',
    method: 'POST',
    data: { messageIds: messageIds.slice(0, 100) },
  })
}

/** 删除一条（物理删除，仅自己的）。 */
export async function deleteMessage(messageId: string): Promise<void> {
  await request<null>({
    url: `/messages/${encodeURIComponent(messageId)}`,
    method: 'DELETE',
  })
}

export type { ApiError }
