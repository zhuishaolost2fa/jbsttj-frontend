/**
 * 故事还原面板（剧本详情页「故事还原」tab 的完整实现）。
 *
 * 对接后端故事还原 + 划线评论三组接口（全部扁平、挂在 /dm-guide 下）：
 *   - GET  /dm-guide/stories            故事还原列表（公开，类型筛选 + 分页）
 *   - GET  /dm-guide/stories/{id}       条目详情（正文 + 公开划线，公开）
 *   - GET  /dm-guide/highlights?mine=1  我的划线（含 private，需登录）
 *   - POST /dm-guide/highlights         提交划线（需登录）
 *   - PATCH/DELETE /dm-guide/highlights/{id}  修改/删除自己的划线（需登录）
 *
 * 交互设计：
 *  - 列表页：顶部类型筛选 chips（时间线/真相/角色/线索/结局），卡片流展示
 *    条目标题 + 摘要 + 章节页码 + 公开划线数，点卡片进全屏阅读页。
 *  - 阅读页（全屏 overlay）：正文 + meta 结构化补充（时间线事件）+
 *    共读时间线（公开划线 + 我自己的私有划线合并，按时间倒序）。
 *  - 划线（仅 H5）：监听 document.selectionchange，用户选中正文中的一段
 *    文字后底部出现「划线评论」按钮 —— 划线数据（quote/偏移/前后文指纹）
 *    在 selectionchange 时就已捕获，点按钮时即使选区被浏览器收起也不丢；
 *    偏移按 Array.from 统计码点，避免 emoji 等 surrogate pair 错位。
 *    小程序端没有页面级文本选择事件，只读展示。
 *  - 自己的划线卡片上有「编辑 / 删除」：编辑弹窗可改评论与可见性
 *    （private ↔ public），删除为软删、二次确认。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, Textarea } from "@tarojs/components";
import Taro from "@tarojs/taro";
import Avatar from "../Avatar";
import {
  createHighlight,
  deleteHighlight,
  fetchHighlights,
  fetchStories,
  fetchStoryDetail,
  STORY_TYPE_TEXT,
  STORY_TYPE_TONE,
  updateHighlight,
  type HighlightRecord,
  type StoryItem,
  type StoryTypeFilter,
} from "../../services/dmGuide";
import { ApiError } from "../../services/request";
import { goLogin, useAuth } from "../../store/auth";
import "./index.less";

/** H5 才有页面级文本选择，小程序端不挂划线入口 */
const IS_H5 = process.env.TARO_ENV === "h5";

/** 阅读页正文容器的 DOM id（H5 划线时用于界定选区范围与计算偏移） */
const STORY_CONTENT_DOM_ID = "story-content-dom";

/** 类型筛选 chips；「其他」不单列，归入「全部」 */
const TYPE_CHIPS: Array<{ label: string; value: StoryTypeFilter }> = [
  { label: "全部", value: undefined },
  { label: "时间线", value: "timeline" },
  { label: "真相还原", value: "truth" },
  { label: "角色背景", value: "role" },
  { label: "线索关联", value: "clue" },
  { label: "结局收束", value: "ending" },
];

const PAGE_SIZE = 20;

/** 待提交的划线选区（selectionchange 时捕获，点按钮提交） */
interface PendingSelection {
  quote: string;
  startOffset: number;
  endOffset: number;
  prefix: string;
  suffix: string;
}

/** 格式化时间为简短展示（与 QuestionPanel 同一套口径） */
function formatTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

interface StoryPanelProps {
  /** 剧本业务编码 */
  scriptCode: string
  /** 剧本名（展示用） */
  scriptTitle?: string
  /** tab 是否处于激活态（首次激活才拉数据，懒加载） */
  active: boolean
  /** 是否已登录（决定「我的划线」合并与划线入口） */
  isAuthenticated: boolean
}

export default function StoryPanel({
  scriptCode,
  scriptTitle,
  active,
  isAuthenticated,
}: StoryPanelProps) {
  const { user } = useAuth();
  const currentUserId = user?.id || "";

  /* ------------------------------ 列表状态 ------------------------------ */
  const [typeFilter, setTypeFilter] = useState<StoryTypeFilter>(undefined);
  const [items, setItems] = useState<StoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fetched, setFetched] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  /* ------------------------------ 阅读页状态 ------------------------------ */
  const [detailOpen, setDetailOpen] = useState(false);
  const [activeStory, setActiveStory] = useState<StoryItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  /** 共读时间线 = 公开划线 + 我自己的私有划线（按 id 去重合并，时间倒序） */
  const [highlights, setHighlights] = useState<HighlightRecord[]>([]);

  /* ------------------------------ 划线弹窗状态 ------------------------------ */
  /** selectionchange 捕获的待提交选区（H5） */
  const [pendingSel, setPendingSel] = useState<PendingSelection | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** 编辑已有划线时的 ID；null = 新建划线 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dialogQuote, setDialogQuote] = useState("");
  const [dialogComment, setDialogComment] = useState("");
  const [dialogVisibility, setDialogVisibility] = useState<"private" | "public">(
    "private"
  );
  const [submitting, setSubmitting] = useState(false);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ------------------------------ 列表加载 ------------------------------ */

  const loadFirst = useCallback(
    async (filter: StoryTypeFilter) => {
      if (!scriptCode) return;
      setLoading(true);
      setError("");
      try {
        const res = await fetchStories(scriptCode, {
          storyType: filter,
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

  /** 首次激活 tab 时才拉列表（懒加载），之后切回来不重复请求 */
  useEffect(() => {
    if (active && scriptCode && !fetched && !loading) {
      void loadFirst(typeFilter);
    }
  }, [active, scriptCode, fetched, loading, loadFirst, typeFilter]);

  const handleChipChange = useCallback(
    (filter: StoryTypeFilter) => {
      if (filter === typeFilter) return;
      setTypeFilter(filter);
      void loadFirst(filter);
    },
    [typeFilter, loadFirst]
  );

  const handleLoadMore = useCallback(async () => {
    if (loading || !hasMore || !scriptCode) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetchStories(scriptCode, {
        storyType: typeFilter,
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
  }, [scriptCode, typeFilter, offset, loading, hasMore]);

  /* ------------------------------ 阅读页加载 ------------------------------ */

  /**
   * 打开并加载一条故事：详情（正文 + 公开划线）与我的划线并行拉取，
   * 合并成「共读时间线」。私有划线拉取失败不影响公开时间线展示。
   */
  const loadDetail = useCallback(
    async (story: StoryItem) => {
      setDetailLoading(true);
      setDetailError("");
      try {
        const d = await fetchStoryDetail(story.id, 50);
        let merged: HighlightRecord[] = d.highlights ?? [];
        if (isAuthenticated) {
          try {
            const mineRes = await fetchHighlights({
              storyId: story.id,
              mine: true,
              limit: 50,
            });
            const map = new Map(merged.map((h) => [h.id, h]));
            for (const h of mineRes.items || []) map.set(h.id, h);
            merged = Array.from(map.values());
          } catch {
            /* 私有划线拉取失败静默降级：只展示公开时间线 */
          }
        }
        merged.sort((a, b) =>
          (b.createdAt || "").localeCompare(a.createdAt || "")
        );
        if (!mountedRef.current) return;
        setDetailOpen(true);
        setDetailLoading(false);
        setActiveStory(d);
        setHighlights(merged);
      } catch (err) {
        if (!mountedRef.current) return;
        setDetailLoading(false);
        setDetailError(err instanceof ApiError ? err.message : "加载失败");
      }
    },
    [isAuthenticated]
  );

  const openStory = useCallback(
    (story: StoryItem) => {
      setPendingSel(null);
      setDialogOpen(false);
      void loadDetail(story);
    },
    [loadDetail]
  );

  const closeDetail = useCallback(() => {
    setDetailOpen(false);
    setPendingSel(null);
    setDialogOpen(false);
    if (IS_H5) {
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        /* ignore */
      }
    }
  }, []);

  /* ------------------------------ H5 划线选区捕获 ------------------------------ */

  /**
   * 监听正文选区：选中故事正文里的一段文字后，立刻把划线所需的
   * quote / 偏移 / 前后文指纹捕获进 state —— 用户随后点「划线评论」
   * 按钮时，即使浏览器把选区收起了，数据也不会丢。
   *
   * 偏移量按 Array.from 统计码点（后端与 Web Annotation 口径一致），
   * 避免 emoji 等 surrogate pair 把 startOffset/endOffset 算错。
   */
  useEffect(() => {
    if (!IS_H5 || !detailOpen) return;
    const handler = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setPendingSel(null);
        return;
      }
      const contentEl = document.getElementById(STORY_CONTENT_DOM_ID);
      if (!contentEl) return;
      const range = sel.getRangeAt(0);
      // 选区必须完整落在正文容器内，跨出容器（比如选中了标题）不算
      if (
        !contentEl.contains(range.startContainer) ||
        !contentEl.contains(range.endContainer)
      ) {
        return;
      }
      const quote = range.toString();
      if (!quote || !quote.trim()) return;

      const pre = document.createRange();
      pre.selectNodeContents(contentEl);
      pre.setEnd(range.startContainer, range.startOffset);
      const startOffset = Array.from(pre.toString()).length;
      const chars = Array.from(activeStory?.content ?? "");
      const endOffset = Math.min(
        startOffset + Array.from(quote).length,
        chars.length
      );
      setPendingSel({
        quote,
        startOffset,
        endOffset,
        prefix: chars.slice(Math.max(0, startOffset - 32), startOffset).join(""),
        suffix: chars.slice(endOffset, endOffset + 32).join(""),
      });
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [detailOpen, activeStory?.content]);

  /* ------------------------------ 划线弹窗 ------------------------------ */

  const requireLogin = useCallback((content: string) => {
    Taro.showModal({
      title: "需要登录",
      content,
      confirmText: "去登录",
      success: (res) => {
        if (res.confirm) goLogin();
      },
    });
  }, []);

  /** 底部按钮 → 新建划线弹窗（依赖 selectionchange 已捕获的选区） */
  const openCreateDialog = useCallback(() => {
    if (!isAuthenticated) {
      requireLogin("登录后可以划线并留下你的评论");
      return;
    }
    if (!pendingSel) {
      Taro.showToast({ title: "请先选中正文中的文字", icon: "none" });
      return;
    }
    setEditingId(null);
    setDialogQuote(pendingSel.quote);
    setDialogComment("");
    setDialogVisibility("private");
    setDialogOpen(true);
  }, [isAuthenticated, pendingSel, requireLogin]);

  /** 划线卡片「编辑」→ 弹窗（改评论 / 可见性） */
  const openEditDialog = useCallback((h: HighlightRecord) => {
    setEditingId(h.id);
    setDialogQuote(h.quote);
    setDialogComment(h.comment || "");
    setDialogVisibility(h.visibility === "public" ? "public" : "private");
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setEditingId(null);
  }, []);

  const submitDialog = useCallback(async () => {
    if (submitting) return;
    if (editingId) {
      setSubmitting(true);
      try {
        const updated = await updateHighlight(editingId, {
          comment: dialogComment.trim() || null,
          visibility: dialogVisibility,
        });
        if (!mountedRef.current) return;
        setHighlights((prev) =>
          prev.map((h) => (h.id === editingId ? updated : h))
        );
        closeDialog();
        Taro.showToast({ title: "已更新", icon: "success" });
      } catch (err) {
        Taro.showToast({
          title: err instanceof ApiError ? err.message : "提交失败",
          icon: "none",
        });
      } finally {
        if (mountedRef.current) setSubmitting(false);
      }
      return;
    }
    if (!pendingSel) return;
    setSubmitting(true);
    try {
      await createHighlight({
        storyId: activeStory?.id || "",
        quote: pendingSel.quote,
        startOffset: pendingSel.startOffset,
        endOffset: pendingSel.endOffset,
        prefix: pendingSel.prefix,
        suffix: pendingSel.suffix,
        comment: dialogComment.trim() || undefined,
        visibility: dialogVisibility,
      });
      if (!mountedRef.current) return;
      closeDialog();
      setPendingSel(null);
      Taro.showToast({
        title:
          dialogVisibility === "public"
            ? "已发布到共读时间线"
            : "已保存（仅自己可见）",
        icon: "none",
      });
      // 重拉详情：公开划线进时间线、条目计数同步刷新
      if (activeStory) void loadDetail(activeStory);
    } catch (err) {
      Taro.showToast({
        title: err instanceof ApiError ? err.message : "提交失败",
        icon: "none",
      });
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [
    submitting,
    editingId,
    dialogComment,
    dialogVisibility,
    pendingSel,
    activeStory,
    closeDialog,
    loadDetail,
  ]);

  /** 删除自己的划线（软删，二次确认） */
  const handleDelete = useCallback((h: HighlightRecord) => {
    Taro.showModal({
      title: "删除划线",
      content: "删除后这条划线不再展示（可在后台恢复）",
      confirmText: "删除",
      confirmColor: "#e54d42",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await deleteHighlight(h.id);
          if (!mountedRef.current) return;
          setHighlights((prev) => prev.filter((it) => it.id !== h.id));
          Taro.showToast({ title: "已删除", icon: "none" });
        } catch (err) {
          Taro.showToast({
            title: err instanceof ApiError ? err.message : "删除失败",
            icon: "none",
          });
        }
      },
    });
  }, []);

  /* ------------------------------ 渲染 ------------------------------ */

  /** 单条划线卡片 */
  const renderHighlight = (h: HighlightRecord) => {
    const isMine = !!currentUserId && h.userId === currentUserId;
    return (
      <View className="hl-item" key={h.id}>
        <View className="hl-head">
          <Avatar
            name={h.userNickname}
            url={h.userAvatarUrl}
            color={h.userAvatarColor}
            size={24}
          />
          <Text className="hl-name">{h.userNickname || "匿名用户"}</Text>
          {h.visibility === "private" ? (
            <Text className="hl-private-tag">仅自己可见</Text>
          ) : null}
          <Text className="hl-time">{formatTime(h.createdAt)}</Text>
        </View>
        <Text className="hl-quote">{h.quote}</Text>
        {h.comment ? <Text className="hl-comment">{h.comment}</Text> : null}
        {isMine ? (
          <View className="hl-actions">
            <Text className="hl-action" onClick={() => openEditDialog(h)}>
              编辑
            </Text>
            <Text className="hl-action is-danger" onClick={() => handleDelete(h)}>
              删除
            </Text>
          </View>
        ) : null}
      </View>
    );
  };

  /** 故事卡片 */
  const renderStoryCard = (s: StoryItem) => (
    <View className="story-card" key={s.id} onClick={() => openStory(s)}>
      <View className="story-card-head">
        <Text
          className={`story-type-tag ${STORY_TYPE_TONE[s.storyType] || "is-other"}`}
        >
          {STORY_TYPE_TEXT[s.storyType] || s.storyType}
        </Text>
        <Text className="story-card-title">{s.title || "未命名条目"}</Text>
      </View>
      {s.summary ? (
        <Text className="story-card-summary">{s.summary}</Text>
      ) : (
        <Text className="story-card-summary">{s.content.slice(0, 60)}…</Text>
      )}
      <View className="story-card-meta">
        {s.sectionPath?.length ? (
          <Text className="story-card-meta-item">
            {s.sectionPath.join(" / ")}
          </Text>
        ) : null}
        {s.pageStart ? (
          <Text className="story-card-meta-item">
            P{s.pageStart}
            {s.pageEnd && s.pageEnd !== s.pageStart ? `-${s.pageEnd}` : ""}
          </Text>
        ) : null}
        <Text className="story-card-meta-item">
          {s.publicHighlights > 0 ? `${s.publicHighlights} 条划线` : "还没有划线"}
        </Text>
      </View>
    </View>
  );

  /* meta 结构化补充：时间线事件（{events:[{when,what}]}） */
  const detailEvents: Array<{ when?: string; what?: string }> =
    Array.isArray(activeStory?.meta?.events) ? activeStory.meta.events : [];

  return (
    <View className="story-panel">
      {/* ===== 类型筛选 ===== */}
      <ScrollView className="story-chips" scrollX>
        {TYPE_CHIPS.map((chip) => (
          <View
            key={chip.label}
            className={`story-chip ${
              typeFilter === chip.value ? "is-active" : ""
            }`}
            onClick={() => handleChipChange(chip.value)}
          >
            <Text className="story-chip-text">{chip.label}</Text>
          </View>
        ))}
      </ScrollView>

      {/* ===== 故事列表 ===== */}
      <ScrollView className="story-list" scrollY>
        {loading && !items.length ? (
          <View className="story-tip">正在加载…</View>
        ) : error && !items.length ? (
          <View className="story-tip is-error">
            <Text className="story-tip-text">{error}</Text>
            <View
              className="story-retry"
              onClick={() => void loadFirst(typeFilter)}
            >
              <Text className="story-retry-text">重试</Text>
            </View>
          </View>
        ) : items.length ? (
          <View className="story-cards">
            {items.map(renderStoryCard)}
            {hasMore ? (
              <View
                className={`story-load-more ${loading ? "is-loading" : ""}`}
                onClick={() => void handleLoadMore()}
              >
                <Text className="story-load-more-text">
                  {loading ? "加载中…" : "加载更多"}
                </Text>
              </View>
            ) : (
              <View className="story-list-end">
                <Text className="story-list-end-text">
                  共 {total} 条 · 已全部加载
                </Text>
              </View>
            )}
          </View>
        ) : (
          <View className="story-tip">
            <Text className="story-tip-emoji">📖</Text>
            <Text className="story-tip-text">
              {typeFilter
                ? `暂无${STORY_TYPE_TEXT[typeFilter] || "该类型"}条目`
                : "这本手册还没有故事还原"}
            </Text>
            <Text className="story-tip-desc">
              手册完成解析后，时间线、真相与角色脉络会整理到这里
            </Text>
          </View>
        )}
      </ScrollView>

      {/* ===== 阅读页（全屏 overlay） ===== */}
      {detailOpen ? (
        <View className="story-detail-overlay">
          <View className="story-detail-head">
            <View className="story-back" onClick={closeDetail}>
              <Text className="story-back-text">‹ 返回</Text>
            </View>
            <Text className="story-detail-title">
              {activeStory?.title || scriptTitle || "故事还原"}
            </Text>
            <Text
              className={`story-type-tag ${
                STORY_TYPE_TONE[activeStory?.storyType || ""] || "is-other"
              }`}
            >
              {STORY_TYPE_TEXT[activeStory?.storyType || ""] || "其他"}
            </Text>
          </View>

          <ScrollView className="story-detail-body" scrollY>
            {detailLoading ? (
              <View className="story-tip">正在加载…</View>
            ) : detailError ? (
              <View className="story-tip is-error">
                <Text className="story-tip-text">{detailError}</Text>
                <View
                  className="story-retry"
                  onClick={() =>
                    activeStory && void loadDetail(activeStory)
                  }
                >
                  <Text className="story-retry-text">重试</Text>
                </View>
              </View>
            ) : activeStory ? (
              <>
                {/* 出处信息 */}
                <View className="story-source">
                  {activeStory.sectionPath?.length ? (
                    <Text className="story-source-text">
                      {activeStory.sectionPath.join(" / ")}
                    </Text>
                  ) : null}
                  {activeStory.pageStart ? (
                    <Text className="story-source-text">
                      手册 P
                      {activeStory.pageStart}
                      {activeStory.pageEnd &&
                      activeStory.pageEnd !== activeStory.pageStart
                        ? `-${activeStory.pageEnd}`
                        : ""}
                    </Text>
                  ) : null}
                  <Text className="story-source-text">
                    约 {activeStory.charCount || activeStory.content.length} 字
                  </Text>
                </View>

                {/* 结构化时间线事件 */}
                {detailEvents.length ? (
                  <View className="story-events">
                    <Text className="story-sec-title">时间线事件</Text>
                    {detailEvents.map((ev, i) => (
                      <View className="story-event" key={i}>
                        <Text className="story-event-when">
                          {ev?.when || ""}
                        </Text>
                        <Text className="story-event-what">
                          {ev?.what || ""}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}

                {/* 正文（H5 可选中划线） */}
                <Text id={STORY_CONTENT_DOM_ID} className="story-content">
                  {activeStory.content}
                </Text>

                {/* 共读时间线 */}
                <View className="hl-section">
                  <Text className="story-sec-title">
                    共读时间线{highlights.length ? ` · ${highlights.length}` : ""}
                  </Text>
                  {highlights.length ? (
                    highlights.map(renderHighlight)
                  ) : (
                    <Text className="hl-empty">
                      还没有公开划线
                      {IS_H5 ? "，选中正文文字写下第一条吧" : ""}
                    </Text>
                  )}
                </View>

                <View className="story-detail-bottom-space" />
              </>
            ) : null}
          </ScrollView>

          {/* H5 划线入口：选中正文后变为可提交状态 */}
          {IS_H5 ? (
            <View className="story-action-bar">
              {pendingSel ? (
                <View className="story-mark-btn" onClick={openCreateDialog}>
                  <Text className="story-mark-btn-text">
                    ✏️ 划线评论 · 已选 {Array.from(pendingSel.quote).length} 字
                  </Text>
                </View>
              ) : (
                <Text className="story-action-hint">
                  选中正文中的文字，即可划线、写评论
                </Text>
              )}
            </View>
          ) : null}

          {/* 划线新建/编辑弹窗 */}
          {dialogOpen ? (
            <View className="hl-dialog-mask" onClick={closeDialog}>
              <View
                className="hl-dialog"
                onClick={(e) => e.stopPropagation()}
              >
                <Text className="hl-dialog-title">
                  {editingId ? "编辑划线" : "划线评论"}
                </Text>
                <Text className="hl-dialog-quote">
                  {Array.from(dialogQuote).length > 60
                    ? `${Array.from(dialogQuote).slice(0, 60).join("")}…`
                    : dialogQuote}
                </Text>
                <Textarea
                  className="hl-dialog-textarea"
                  value={dialogComment}
                  placeholder="写点什么…（可留空，纯划线）"
                  maxlength={2000}
                  autoHeight
                  adjustPosition
                  onInput={(e) => setDialogComment(e.detail.value)}
                />
                <View className="hl-vis-row">
                  <View
                    className={`hl-vis-opt ${
                      dialogVisibility === "private" ? "is-active" : ""
                    }`}
                    onClick={() => setDialogVisibility("private")}
                  >
                    <Text className="hl-vis-text">仅自己可见</Text>
                  </View>
                  <View
                    className={`hl-vis-opt ${
                      dialogVisibility === "public" ? "is-active" : ""
                    }`}
                    onClick={() => setDialogVisibility("public")}
                  >
                    <Text className="hl-vis-text">公开 · 共读时间线</Text>
                  </View>
                </View>
                <View className="hl-dialog-actions">
                  <View className="hl-dialog-cancel" onClick={closeDialog}>
                    <Text className="hl-dialog-cancel-text">取消</Text>
                  </View>
                  <View
                    className={`hl-dialog-submit ${
                      submitting ? "is-disabled" : ""
                    }`}
                    onClick={() => void submitDialog()}
                  >
                    <Text className="hl-dialog-submit-text">
                      {submitting ? "提交中…" : "提交"}
                    </Text>
                  </View>
                </View>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
