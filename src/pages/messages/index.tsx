/** 消息列表页（站内信收件箱）。 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView } from '@tarojs/components'
import Taro, { useDidShow, usePullDownRefresh, useReachBottom } from '@tarojs/taro'
import AppIcon from '../../components/AppIcon'
import { useAuth } from '../../store/auth'
import {
  fetchMessages,
  markAllMessagesRead,
  markMessageRead,
  MESSAGE_ICON,
  MESSAGE_LABELS,
  type MessageItem,
  type MessageType,
} from '../../services/messages'
import { usePageMeta } from '../../hooks/usePageMeta'
import './index.less'

/** 列表 tab：全部 / 未读（受 msg_type 过滤时会再嵌一层） */
type TabKey = 'all' | 'unread'

/** 简易相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期 */
function formatRelative(iso?: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  if (diff < 0) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day} 天前`
  const d = new Date(t)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/**
 * 点消息后的跳转：让用户直接看到这条事件的结果页。
 *   - question_answered → 剧本问答页（带剧本 code/id 跳详情）
 *   - script_parsed     → 剧本详情页（手稿已就绪）
 *   - system            → 不跳（系统公告没有具体落地页）
 */
function navigateForMessage(item: MessageItem) {
  const data = item.data || {}
  const scriptId = data.scriptId
  const scriptCode = data.scriptCode
  if (item.type === 'question_answered' || item.type === 'script_parsed') {
    if (scriptId || scriptCode) {
      const query = scriptId
        ? `id=${encodeURIComponent(scriptId)}`
        : `code=${encodeURIComponent(scriptCode!)}`
      void Taro.navigateTo({ url: `/pages/scriptDetail/index?${query}` })
      return
    }
  }
  void Taro.showToast({ title: '该消息无跳转目标', icon: 'none' })
}

const PAGE_SIZE = 20

function MessagesPage() {
  usePageMeta(
    '消息 · 剧本杀复盘助手',
    '你提的问题被人回答、你求的剧本被解析完成，都会收到一条站内消息。'
  )
  const { isAuthenticated } = useAuth()

  const [tab, setTab] = useState<TabKey>('all')
  const [items, setItems] = useState<MessageItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [markingAll, setMarkingAll] = useState(false)
  // 防重入：触底 / 下拉可能并发
  const loadingRef = useRef(false)

  // 首屏拉一次
  const reset = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const res = await fetchMessages({
        unreadOnly: tab === 'unread',
        limit: PAGE_SIZE,
        offset: 0,
      })
      setItems(res.items)
      setTotal(res.pagination.total)
      setUnreadCount(res.unreadCount)
      setOffset(res.items.length)
      setHasMore(res.pagination.hasMore)
    } catch (err) {
      console.error('[messages] 拉取失败:', err)
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [tab])

  useEffect(() => {
    if (!isAuthenticated) {
      setItems([])
      setTotal(0)
      setUnreadCount(0)
      return
    }
    void reset()
  }, [isAuthenticated, reset])

  // 切回页面时刷新（profile 那边可能刚标记过）
  useDidShow(() => {
    if (isAuthenticated) void reset()
  })

  usePullDownRefresh(async () => {
    await reset()
    Taro.stopPullDownRefresh()
  })

  const loadMore = useCallback(async () => {
    if (loadingRef.current || !hasMore) return
    loadingRef.current = true
    setLoading(true)
    try {
      const res = await fetchMessages({
        unreadOnly: tab === 'unread',
        limit: PAGE_SIZE,
        offset,
      })
      setItems((prev) => [...prev, ...res.items])
      setOffset((prev) => prev + res.items.length)
      setHasMore(res.pagination.hasMore)
      setUnreadCount(res.unreadCount)
    } catch (err) {
      console.error('[messages] 加载更多失败:', err)
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [offset, hasMore, tab])

  useReachBottom(() => {
    void loadMore()
  })

  const onItemTap = useCallback(async (item: MessageItem) => {
    if (!item.read) {
      // 乐观更新：先置已读再请求，避免跳转后看到红点抖一下
      setItems((prev) =>
        prev.map((m) => (m.id === item.id ? { ...m, read: true, readAt: new Date().toISOString() } : m))
      )
      setUnreadCount((prev) => Math.max(0, prev - 1))
      try {
        await markMessageRead(item.id)
      } catch (err) {
        console.warn('[messages] 标记已读失败（已乐观更新）:', err)
      }
    }
    navigateForMessage(item)
  }, [])

  const onMarkAll = useCallback(async () => {
    if (markingAll || unreadCount <= 0) return
    setMarkingAll(true)
    try {
      await markAllMessagesRead()
      setItems((prev) => prev.map((m) => ({ ...m, read: true, readAt: m.readAt ?? new Date().toISOString() })))
      setUnreadCount(0)
      Taro.showToast({ title: '已全部已读', icon: 'success', duration: 1200 })
    } catch (err) {
      console.error('[messages] 全部已读失败:', err)
      Taro.showToast({ title: '操作失败', icon: 'none' })
    } finally {
      setMarkingAll(false)
    }
  }, [markingAll, unreadCount])

  const tabs: { key: TabKey; label: string; badge?: number }[] = useMemo(
    () => [
      { key: 'all', label: `全部 ${total > 0 ? total : ''}`.trim() },
      {
        key: 'unread',
        label: `未读 ${unreadCount > 0 ? unreadCount : ''}`.trim(),
        badge: unreadCount,
      },
    ],
    [total, unreadCount]
  )

  if (!isAuthenticated) {
    return (
      <View className='messages-page messages-empty'>
        <AppIcon name='inbox' tone='mute' size={56} />
        <Text className='empty-title'>登录后查看消息</Text>
        <Text className='empty-sub'>
          你提的问题被回答、求的剧本被解析完成，都会在收件箱留一条。
        </Text>
      </View>
    )
  }

  if (items.length === 0 && !loading) {
    return (
      <View className='messages-page'>
        <View className='messages-tabs'>
          {tabs.map((t) => (
            <View
              key={t.key}
              className={`tab ${tab === t.key ? 'tab-active' : ''}`}
              onClick={() => tab !== t.key && setTab(t.key)}
            >
              <Text className='tab-text'>{t.label}</Text>
              {t.badge ? (
                <Text className='tab-badge'>{t.badge > 99 ? '99+' : t.badge}</Text>
              ) : null}
            </View>
          ))}
        </View>
        <View className='messages-empty'>
          <AppIcon name='inbox' tone='mute' size={56} />
          <Text className='empty-title'>{tab === 'unread' ? '没有未读消息' : '收件箱是空的'}</Text>
          <Text className='empty-sub'>
            有人回答你的问题、或者你求的剧本被解析完成，{'\n'}
            会自动收到站内通知。
          </Text>
        </View>
      </View>
    )
  }

  return (
    <View className='messages-page'>
      <View className='messages-tabs'>
        {tabs.map((t) => (
          <View
            key={t.key}
            className={`tab ${tab === t.key ? 'tab-active' : ''}`}
            onClick={() => tab !== t.key && setTab(t.key)}
          >
            <Text className='tab-text'>{t.label}</Text>
            {t.badge ? (
              <Text className='tab-badge'>{t.badge > 99 ? '99+' : t.badge}</Text>
            ) : null}
          </View>
        ))}
      </View>

      <ScrollView scrollY className='messages-scroll' lowerThreshold={80}>
        <View className='messages-list'>
          {items.map((item) => {
            const icon = MESSAGE_ICON[item.type as MessageType] || 'inbox'
            const label = MESSAGE_LABELS[item.type as MessageType] || item.type
            return (
              <View
                key={item.id}
                className={`message-card ${item.read ? 'is-read' : 'is-unread'}`}
                onClick={() => onItemTap(item)}
                hoverClass='card-hover'
                hoverStayTime={50}
              >
                {!item.read ? <View className='unread-bar' /> : null}
                <View className='message-icon'>
                  <AppIcon name={icon} tone={item.read ? 'mute' : 'yellow'} size={22} />
                </View>
                <View className='message-body'>
                  <View className='message-line1'>
                    <Text className='message-label'>{label}</Text>
                    <Text className='message-time'>{formatRelative(item.createdAt)}</Text>
                  </View>
                  <Text className='message-title' numberOfLines={1}>
                    {item.title}
                  </Text>
                  {item.content ? (
                    <Text className='message-content' numberOfLines={2}>
                      {item.content}
                    </Text>
                  ) : null}
                </View>
              </View>
            )
          })}
        </View>
        {hasMore ? (
          <View className='messages-foot'>
            <Text className='messages-foot-text'>{loading ? '加载中…' : '上拉加载更多'}</Text>
          </View>
        ) : items.length > 0 ? (
          <View className='messages-foot'>
            <Text className='messages-foot-text'>— 没有更多了 —</Text>
          </View>
        ) : null}
      </ScrollView>

      {unreadCount > 0 ? (
        <View className='messages-fab' onClick={onMarkAll} hoverClass='fab-hover' hoverStayTime={50}>
          <AppIcon name='check' tone='white' size={16} />
          <Text className='fab-text'>全部已读</Text>
        </View>
      ) : null}
    </View>
  )
}

export default MessagesPage
