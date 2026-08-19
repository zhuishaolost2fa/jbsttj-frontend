/**
 * 用户提问面板（底部抽屉）。
 *
 * 对接后端「用户提问沉淀」三件套：
 *   - GET  /dm-guide/questions               列表（分页 + 状态筛选）
 *   - POST /dm-guide/questions/{id}/answer    真人解答
 *   - GET  /dm-guide/guide-questions          引导问题 Top3（本面板不直接用，
 *                                            由详情页在就绪时拉取替换硬编码建议）
 *
 * 交互设计：
 *  - 顶部 tabs 切换状态（全部 / 待解答 / 已解答 / 已忽略），切 tab 重新拉首页。
 *  - 每条问题卡片：问的人头像昵称 + 问的内容 + 被问次数 + 状态标签。
 *  - 已解答：默认折叠答案，点「展开答案」查看，含答的人信息与解答时间。
 *  - 待解答 + 已登录：卡片底部出现「我来回答」按钮，点开后内联输入框 + 提交。
 *    提交成功后该条原地变成已解答态，无需重新拉列表。
 *  - 未登录：不显示回答入口，引导先去登录。
 *  - 分页：底部「加载更多」按钮，追加到列表尾。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, Textarea } from "@tarojs/components";
import Taro from "@tarojs/taro";
import Avatar from "../Avatar";
import {
  fetchDmQuestions,
  answerDmQuestion,
  QUESTION_STATUS_TEXT,
  type QuestionRecord,
  type QuestionStatusFilter,
} from "../../services/dmGuide";
import { ApiError } from "../../services/request";
import { goLogin } from "../../store/auth";
import "./index.less";

interface QuestionPanelProps {
  /** 剧本业务编码 */
  scriptCode: string
  /** 剧本名（展示用） */
  scriptTitle?: string
  /** 是否打开 */
  open: boolean
  /** 关闭回调 */
  onClose: () => void
  /** 是否已登录（决定是否显示「我来回答」入口） */
  isAuthenticated: boolean
  /** 点击问题将其作为提问发到聊天框（可选） */
  onAskQuestion?: (question: string) => void
}

/** 状态筛选 tab 配置 */
const STATUS_TABS: Array<{ label: string; value: QuestionStatusFilter }> = [
  { label: "全部", value: undefined },
  { label: "待解答", value: "pending" },
  { label: "已解答", value: "answered" },
  { label: "已忽略", value: "dismissed" },
];

const PAGE_SIZE = 20;

/** 状态标签的 CSS 类名 */
function statusClass(s: string): string {
  if (s === "answered") return "is-answered";
  if (s === "dismissed") return "is-dismissed";
  return "is-pending";
}

/** 格式化时间为简短展示 */
function formatTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export default function QuestionPanel({
  scriptCode,
  scriptTitle,
  open,
  onClose,
  isAuthenticated,
  onAskQuestion,
}: QuestionPanelProps) {
  const [statusFilter, setStatusFilter] = useState<QuestionStatusFilter>(undefined);
  const [items, setItems] = useState<QuestionRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fetched, setFetched] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  /** 展开答案的卡片 ID 集合 */
  const [expandedAnswers, setExpandedAnswers] = useState<Record<string, boolean>>({});
  /** 正在输入回答的卡片 ID */
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  /** 回答输入文本 */
  const [answerText, setAnswerText] = useState("");
  /** 提交中 */
  const [submitting, setSubmitting] = useState(false);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 拉首页数据（切 tab / 首次打开时调用） */
  const loadFirst = useCallback(
    async (filter: QuestionStatusFilter) => {
      if (!scriptCode) return;
      setLoading(true);
      setError("");
      try {
        const res = await fetchDmQuestions(scriptCode, {
          status: filter,
          limit: PAGE_SIZE,
          offset: 0,
        });
        if (!mountedRef.current) return;
        setItems(res.items || []);
        setTotal(res.total || 0);
        setOffset(PAGE_SIZE);
        setHasMore((res.items?.length || 0) < (res.total || 0));
        setFetched(true);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(err instanceof ApiError ? err.message : "加载失败");
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [scriptCode]
  );

  /** 首次打开时拉数据 */
  useEffect(() => {
    if (open && !fetched && !loading) {
      void loadFirst(statusFilter);
    }
  }, [open, fetched, loading, loadFirst, statusFilter]);

  /** 切 tab */
  const handleTabChange = useCallback(
    (filter: QuestionStatusFilter) => {
      if (filter === statusFilter) return;
      setStatusFilter(filter);
      setExpandedAnswers({});
      setAnsweringId(null);
      setAnswerText("");
      void loadFirst(filter);
    },
    [statusFilter, loadFirst]
  );

  /** 加载更多 */
  const handleLoadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetchDmQuestions(scriptCode, {
        status: statusFilter,
        limit: PAGE_SIZE,
        offset,
      });
      if (!mountedRef.current) return;
      setItems((prev) => [...prev, ...(res.items || [])]);
      setOffset((prev) => prev + PAGE_SIZE);
      setHasMore(offset + (res.items?.length || 0) < (res.total || 0));
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof ApiError ? err.message : "加载失败");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [scriptCode, statusFilter, offset, loading, hasMore]);

  /** 展开答案 */
  const toggleAnswer = useCallback((id: string) => {
    setExpandedAnswers((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  /** 打开回答输入框 */
  const startAnswering = useCallback(
    (id: string) => {
      if (!isAuthenticated) {
        Taro.showModal({
          title: "需要登录",
          content: "登录后可以解答其他用户的问题",
          confirmText: "去登录",
          success: (res) => {
            if (res.confirm) {
              goLogin();
            }
          },
        });
        return;
      }
      setAnsweringId(id);
      setAnswerText("");
    },
    [isAuthenticated]
  );

  /** 取消回答 */
  const cancelAnswering = useCallback(() => {
    setAnsweringId(null);
    setAnswerText("");
  }, []);

  /** 提交答案 */
  const submitAnswer = useCallback(
    async (questionId: string) => {
      const text = answerText.trim();
      if (!text) {
        Taro.showToast({ title: "请输入答案", icon: "none" });
        return;
      }
      if (submitting) return;
      setSubmitting(true);
      try {
        const updated = await answerDmQuestion(questionId, text);
        if (!mountedRef.current) return;
        // 原地更新该条记录
        setItems((prev) =>
          prev.map((it) => (it.id === questionId ? updated : it))
        );
        setAnsweringId(null);
        setAnswerText("");
        setExpandedAnswers((prev) => ({ ...prev, [questionId]: true }));
        Taro.showToast({ title: "解答成功", icon: "success" });
      } catch (err) {
        Taro.showToast({
          title: err instanceof ApiError ? err.message : "提交失败",
          icon: "none",
        });
      } finally {
        if (mountedRef.current) setSubmitting(false);
      }
    },
    [answerText, submitting]
  );

  /** 点击问题 → 发到聊天框 */
  const handleAsk = useCallback(
    (question: string) => {
      onAskQuestion?.(question);
      onClose();
    },
    [onAskQuestion, onClose]
  );

  /** 渲染单条问题卡片 */
  const renderQuestion = (q: QuestionRecord) => {
    const isAnswered = q.status === "answered";
    const isPending = q.status === "pending";
    const isDismissed = q.status === "dismissed";
    const answerOpen = !!expandedAnswers[q.id];
    const isAnswering = answeringId === q.id;

    return (
      <View className="q-card" key={q.id}>
        {/* 头部：提问者信息 + 状态 */}
        <View className="q-card-head">
          <Avatar
            name={q.createdByNickname}
            url={q.createdByAvatarUrl}
            color={q.createdByAvatarColor}
            size={28}
          />
          <Text className="q-asker-name">
            {q.createdByNickname || "匿名用户"}
          </Text>
          <Text className="q-time">{formatTime(q.createdAt)}</Text>
          <Text className={`q-status ${statusClass(q.status)}`}>
            {QUESTION_STATUS_TEXT[q.status] || q.status}
          </Text>
        </View>

        {/* 问题内容 */}
        <View
          className="q-body"
          onClick={() => isReadyToAsk(q) && handleAsk(q.question)}
        >
          <Text className="q-text">{q.question}</Text>
          {isReadyToAsk(q) && (
            <Text className="q-ask-hint">点击提问</Text>
          )}
        </View>

        {/* 统计 */}
        <View className="q-meta">
          <Text className="q-meta-item">
            被问 {q.askCount} 次
          </Text>
          {q.bestSimilarity > 0 ? (
            <Text className="q-meta-item">
              最高匹配 {Math.round(q.bestSimilarity * 100)}%
            </Text>
          ) : null}
        </View>

        {/* 已解答：展开答案 */}
        {isAnswered && q.answer ? (
          <View className="q-answer-section">
            <Text
              className="q-answer-toggle"
              onClick={() => toggleAnswer(q.id)}
            >
              {answerOpen ? "收起答案" : "展开答案"}
            </Text>
            {answerOpen ? (
              <View className="q-answer-box">
                <View className="q-answerer-row">
                  <Avatar
                    name={q.answeredByNickname}
                    url={q.answeredByAvatarUrl}
                    color={q.answeredByAvatarColor}
                    size={20}
                  />
                  <Text className="q-answerer-name">
                    {q.answeredByNickname || "匿名用户"}
                  </Text>
                  <Text className="q-answer-time">
                    {formatTime(q.answeredAt)}
                  </Text>
                </View>
                <Text className="q-answer-text">{q.answer}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* 待解答：回答入口 */}
        {isPending && !isDismissed ? (
          isAnswering ? (
            <View className="q-answer-input">
              <Textarea
                className="q-answer-textarea"
                value={answerText}
                placeholder="输入你的解答…"
                maxlength={2000}
                autoHeight
                adjustPosition
                onInput={(e) => setAnswerText(e.detail.value)}
              />
              <View className="q-answer-actions">
                <View className="q-cancel-btn" onClick={cancelAnswering}>
                  <Text className="q-cancel-text">取消</Text>
                </View>
                <View
                  className={`q-submit-btn ${
                    !answerText.trim() || submitting ? "is-disabled" : ""
                  }`}
                  onClick={() => submitAnswer(q.id)}
                >
                  <Text className="q-submit-text">
                    {submitting ? "提交中…" : "提交"}
                  </Text>
                </View>
              </View>
            </View>
          ) : (
            <View className="q-answer-trigger" onClick={() => startAnswering(q.id)}>
              <Text className="q-answer-trigger-text">我来回答</Text>
            </View>
          )
        ) : null}
      </View>
    );
  };

  /** 判断该问题是否可点击发到聊天框（已忽略的不允许） */
  function isReadyToAsk(q: QuestionRecord): boolean {
    return q.status !== "dismissed" && !!onAskQuestion;
  }

  return (
    <View
      className={`q-panel-mask ${open ? "is-open" : ""}`}
      onClick={onClose}
    >
      <View
        className={`q-panel-sheet ${open ? "is-open" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <View className="q-panel-handle" />

        {/* 头部 */}
        <View className="q-panel-head">
          <Text className="q-panel-title">用户提问</Text>
          <Text className="q-panel-sub">
            {fetched ? `共 ${total} 条` : scriptTitle || ""}
          </Text>
          <View className="q-panel-close" onClick={onClose}>
            <Text className="q-panel-close-text">✕</Text>
          </View>
        </View>

        {/* 状态筛选 tabs */}
        <View className="q-tabs">
          {STATUS_TABS.map((tab) => (
            <View
              key={tab.label}
              className={`q-tab ${statusFilter === tab.value ? "is-active" : ""}`}
              onClick={() => handleTabChange(tab.value)}
            >
              <Text className="q-tab-text">{tab.label}</Text>
            </View>
          ))}
        </View>

        {/* 列表 */}
        <ScrollView className="q-panel-body" scrollY>
          {loading && !items.length ? (
            <View className="q-panel-tip">正在加载…</View>
          ) : error && !items.length ? (
            <View className="q-panel-tip is-error">
              <Text className="q-panel-tip-text">{error}</Text>
              <View
                className="q-panel-retry"
                onClick={() => void loadFirst(statusFilter)}
              >
                <Text className="q-panel-retry-text">重试</Text>
              </View>
            </View>
          ) : items.length ? (
            <View className="q-list">
              {items.map(renderQuestion)}
              {hasMore ? (
                <View
                  className={`q-load-more ${loading ? "is-loading" : ""}`}
                  onClick={() => void handleLoadMore()}
                >
                  <Text className="q-load-more-text">
                    {loading ? "加载中…" : "加载更多"}
                  </Text>
                </View>
              ) : (
                <View className="q-list-end">
                  <Text className="q-list-end-text">没有更多了</Text>
                </View>
              )}
            </View>
          ) : (
            <View className="q-panel-tip">
              <Text className="q-panel-tip-emoji">📝</Text>
              <Text className="q-panel-tip-text">
                {statusFilter === "pending"
                  ? "暂无待解答问题"
                  : statusFilter === "answered"
                  ? "暂无已解答问题"
                  : statusFilter === "dismissed"
                  ? "暂无已忽略问题"
                  : "还没有用户提问"}
              </Text>
              <Text className="q-panel-tip-desc">
                玩家提问手册检索不到时，问题会自动沉淀到这里
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  );
}
