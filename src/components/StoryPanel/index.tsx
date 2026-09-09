/**
 * 故事还原面板（剧本详情页「故事还原」tab 的完整实现）。
 *
 * 对接后端故事还原 + 划线评论 + 合成文章三组接口（全部扁平、挂在 /dm-guide 下）：
 *   - GET  /dm-guide/synthesis           「合成文章」：5 节连贯复盘（默认展示）
 *   - GET  /dm-guide/stories             故事还原列表（细节抽屉，类型筛选 + 分页）
 *   - GET  /dm-guide/stories/{id}        条目详情（正文 + 公开划线）
 *   - GET  /dm-guide/highlights?mine=1   我的划线（含 private，需登录）
 *   - POST /dm-guide/highlights          提交划线（需登录）
 *   - PATCH/DELETE /dm-guide/highlights/{id}  修改/删除自己的划线（需登录）
 *
 * 交互设计（2026-09-08 改造）：
 *  - 顶部默认展示「合成文章」：5 节连贯复盘（梗概 → 诡计 → 时间线 → 角色 → 结局），
 *    每节末尾如果 LLM 给出了锚点（anchorStories），点"查看细节"会展开抽屉并定位到对应卡片。
 *  - 底部一个折叠按钮"展开故事碎片"→ 展开原有 chips + 卡片流，保留类型筛选/分页/阅读/划线全套能力。
 *  - 合成未生成（overview=null 或 status!=ready）：静默降级，直接展示原故事列表（保持旧行为）。
 *
 * 划线机制同旧版：
 *  - 列表页：顶部类型筛选 chips，卡片流展示条目标题 + 摘要 + 章节页码 + 公开划线数。
 *  - 阅读页（全屏 overlay）：正文 + meta 结构化补充 + 共读时间线（公开划线 + 我自己的私有划线合并）。
 *  - 划线（仅 H5）：监听 document.selectionchange，捕获 quote/偏移/前后文指纹，点按钮提交。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { View, Text, ScrollView, Textarea } from "@tarojs/components";
import Taro from "@tarojs/taro";
import Avatar from "../Avatar";
import {
  createHighlight,
  deleteHighlight,
  fetchHighlights,
  fetchStories,
  fetchStoryDetail,
  fetchSynthesis,
  STORY_TYPE_TEXT,
  STORY_TYPE_TONE,
  SYNTHESIS_SECTIONS,
  updateHighlight,
  type HighlightRecord,
  type StoryItem,
  type StoryTypeFilter,
  type SynthesisAnchor,
  type SynthesisResult,
} from "../../services/dmGuide";
import { ApiError } from "../../services/request";
import { goLogin, useAuth } from "../../store/auth";
import AppIcon from "../AppIcon";
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

/**
 * overview 是否真有内容：5 节里任意一节有非空文本即算数。
 *
 * 后端「任务没跑通却标 ready」时会返回 5 节全空字符串的空壳 overview
 * （`documentId:null`），此时必须按「没有合成」处理，否则前端会渲染一篇空文章。
 */
function hasOverviewContent(overview?: SynthesisResult["overview"] | null): boolean {
  if (!overview) return false;
  return SYNTHESIS_SECTIONS.some((sec) => (overview[sec.key] || "").trim().length > 0);
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

  /* ------------------------------ 合成文章状态 ------------------------------ */
  const [synthesis, setSynthesis] = useState<SynthesisResult | null>(null);
  const [synthesisLoading, setSynthesisLoading] = useState(false);
  const [synthesisFetched, setSynthesisFetched] = useState(false);
  /**
   * 合成拉取失败的提示文案；synthesisFetched=true 且 synthesis==null 且合成状态≠ready
   * 时显示。主视图已有降级路径（直接走 chips+list），所以这里仅在 hasSynthesis 为
   * false 但已 fetched 时用作占位提示（避免空屏观感迷惑）。
   */
  const [synthesisError, setSynthesisError] = useState("");
  /**
   * 「展开故事细节抽屉」开关。默认折叠：只展示顶部合成文章，点按钮才展开 chips + 卡片列表。
   * 合成文章某节的"查看细节"被点击时也会自动展开，并按 anchor title 定位到对应卡片。
   */
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** 锚点定位：把目标 StoryItem.id 写入，列表渲染时高亮并滚到视野内 */
  const [anchorStoryId, setAnchorStoryId] = useState<string | null>(null);
  /**
   * 「本节关联」模式：点合成文章某节的「查看 N 张细节碎片」后，抽屉只展示这 N 张。
   * anchorSection 为 null = 展示完整碎片列表。
   */
  const [anchorSection, setAnchorSection] = useState<{
    key: string;
    title: string;
  } | null>(null);
  const [anchorItems, setAnchorItems] = useState<StoryItem[]>([]);
  const [anchorLoading, setAnchorLoading] = useState(false);

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

  /* ------------------------------ 合成文章加载 ------------------------------ */

  /**
   * 拉一次合成文章。失败仅记日志、不抛错：合成未生成（status != ready）或接口
   * 5xx 时，前端降级展示原故事列表，保持旧行为。
   */
  const loadSynthesis = useCallback(async () => {
    if (!scriptCode) return;
    setSynthesisLoading(true);
    setSynthesisError("");
    try {
      const res = await fetchSynthesis(scriptCode, { title: scriptTitle });
      if (!mountedRef.current) return;
      setSynthesis(res);
      setSynthesisFetched(true);
    } catch (err) {
      if (!mountedRef.current) return;
      // 404 / 5xx 都按"未生成"处理：overview 留 null，前端走降级路径
      setSynthesisError(err instanceof ApiError ? err.message : "加载失败");
      setSynthesisFetched(true);
    } finally {
      if (mountedRef.current) setSynthesisLoading(false);
    }
  }, [scriptCode, scriptTitle]);

  /* 首次激活 tab 时并行拉合成文章 + 故事列表（懒加载），合成未生成时静默降级 */
  useEffect(() => {
    if (active && scriptCode && !synthesisFetched && !synthesisLoading) {
      void loadSynthesis();
    }
    if (active && scriptCode && !fetched && !loading) {
      void loadFirst(typeFilter);
    }
  }, [active, scriptCode, synthesisFetched, synthesisLoading, loadSynthesis, fetched, loading, loadFirst, typeFilter]);

  const handleChipChange = useCallback(
    (filter: StoryTypeFilter) => {
      if (filter === typeFilter) return;
      setTypeFilter(filter);
      setAnchorStoryId(null);
      void loadFirst(filter);
    },
    [typeFilter, loadFirst]
  );

  /**
   * 合成文章某节点「查看 N 张细节碎片」。
   *
   * 关键：**抽屉进入「本节关联」模式，只展示这 N 张卡片**，而不是把第一张滚到
   * 视野里了事 —— 后者用户点进来看到的仍是上百张无关碎片，等于没有关联。
   *
   * 取数策略：
   *  1) anchor 带 id → 直接 `fetchStories({ ids })` 精准取回（后端 PostgREST `id=in.(...)`）；
   *  2) id 缺失/取回为空（老数据、purge 重跑后旧 id 失效）→ 按 title 在已加载 items 里匹配；
   *  3) 仍匹配不上 → 重拉第一页再匹配一次；都不行就退回全量列表并清掉关联态。
   */
  const handleAnchorClick = useCallback(
    (section: { key: string; title: string }, anchors: SynthesisAnchor[]) => {
      if (!anchors || !anchors.length) return;

      const ids = anchors.map((a) => a.id).filter(Boolean) as string[];
      const titles = anchors.map((a) => a.title).filter(Boolean);

      setDetailsOpen(true);
      setAnchorLoading(true);
      setAnchorSection({ key: section.key, title: section.title });

      void (async () => {
        try {
          // 1) 优先按 id 精准取回
          if (ids.length && scriptCode) {
            const res = await fetchStories(scriptCode, { ids });
            if (!mountedRef.current) return;
            if (res.items?.length) {
              setAnchorItems(res.items);
              setAnchorStoryId(res.items[0].id);
              return;
            }
          }
          // 2) 兜底：按 title 在已加载列表里匹配
          const hit = items.filter((it) => titles.includes(it.title));
          if (hit.length) {
            setAnchorItems(hit);
            setAnchorStoryId(hit[0].id);
            return;
          }
          // 3) 再兜底：重拉第一页后匹配
          if (scriptCode) {
            setTypeFilter(undefined);
            const res = await fetchStories(scriptCode, { limit: PAGE_SIZE, offset: 0 });
            if (!mountedRef.current) return;
            setItems(res.items || []);
            setTotal(res.total || 0);
            setOffset(PAGE_SIZE);
            setHasMore((res.items?.length || 0) < (res.total || 0));
            setFetched(true);
            const found = (res.items || []).filter((it) => titles.includes(it.title));
            if (found.length) {
              setAnchorItems(found);
              setAnchorStoryId(found[0].id);
              return;
            }
          }
          // 4) 全都不行：退回全量列表，不让用户面对空抽屉
          setAnchorSection(null);
          setAnchorItems([]);
        } catch {
          // 取数失败同样退回全量，静默处理
          setAnchorSection(null);
          setAnchorItems([]);
        } finally {
          if (mountedRef.current) setAnchorLoading(false);
        }
      })();
    },
    [items, scriptCode]
  );

  /** 退出「本节关联」模式，回到完整碎片列表 */
  const clearAnchorFilter = useCallback(() => {
    setAnchorSection(null);
    setAnchorItems([]);
    setAnchorStoryId(null);
  }, []);

  /**
   * 合成文章底部「展开/收起故事细节抽屉」的总开关。展开时清除关联态与高亮，
   * 因为滚动目标消失后高亮没意义；折叠时同步清 anchor。
   */
  const toggleDetails = useCallback(() => {
    setDetailsOpen((prev) => {
      if (prev) {
        setAnchorStoryId(null);
        setAnchorSection(null);
        setAnchorItems([]);
      }
      return !prev;
    });
  }, []);

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

  /* ------------------------------ 锚点滚动（H5 only） ------------------------------ */

  /**
   * anchorStoryId 变更后，等列表渲染完再把对应卡片滚到视野内（带高亮样式）。
   * Taro 的 ScrollView 提供 scrollIntoView；H5 用 document.querySelector + scrollIntoView。
   * 小程序端 anchor 仅做高亮（不强求滚动，因没有 native 滚动 API 可控）。
   */
  useEffect(() => {
    if (!anchorStoryId) return;
    const el = document.querySelector<HTMLElement>(
      `.story-card-wrap[data-story-id="${anchorStoryId}"]`
    );
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [anchorStoryId, items]);

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
      confirmColor: "#C0392B",
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

  /**
   * 「合成文章」是否可用：status=ready 且 overview 至少有一节非空。
   * 决定主视图模式：有合成 → 默认展示文章 + 折叠抽屉；无合成 → 降级到碎片列表。
   *
   * ⚠️ 不能只判 `!!overview`：后端存在「任务没跑通却标 ready」的脏数据
   * （实测多个剧本返回 `synthesisStatus:"ready"` + `documentId:null` +
   * 5 节全空字符串 + 空 anchorStories）。只判对象存在会把空壳当成有效合成，
   * 渲染出一篇「什么都没有的文章」+ 一个孤零零的「展开 0 张碎片」按钮。
   */
  const hasSynthesis =
    synthesis?.synthesisStatus === "ready" &&
    hasOverviewContent(synthesis.overview);

  /** 合成文章的 5 节渲染（按 SYNTHESIS_SECTIONS 顺序，跳过空节） */
  const renderSynthesisSection = (
    sec: (typeof SYNTHESIS_SECTIONS)[number]
  ): ReactNode | null => {
    const overview = synthesis?.overview;
    if (!overview) return null;
    const body = (overview[sec.key] || "").trim();
    if (!body) return null;
    const anchors = overview.anchorStories?.[sec.key] || [];
    return (
      <View key={sec.key} className={`synthesis-section ${sec.tone}`}>
        <View className="synthesis-section-head">
          <AppIcon name={sec.icon} tone="ink" size={16} className="synthesis-section-icon" />
          <Text className="synthesis-section-title">{sec.title}</Text>
        </View>
        <View className="synthesis-section-body">
          <Text className="synthesis-section-body-text">{body}</Text>
        </View>
        {anchors.length ? (
          <View
            className="synthesis-anchor"
            onClick={() => void handleAnchorClick(sec, anchors)}
          >
            <Text className="synthesis-anchor-text">
              查看本节关联的 {anchors.length} 张碎片 →
            </Text>
          </View>
        ) : null}
      </View>
    );
  };

  /** 抽屉里的故事卡片列表（chips + cards），与原列表渲染共用一份代码 */
  const renderDetailsList = () => (
    <>
      {/* chips：一本碎片都没有时不渲染 —— 一排点不出东西的筛选器
          看起来就像渲染错乱，直接留空状态提示更清楚 */}
      {items.length ? (
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
      ) : null}

      {/* 列表 */}
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
            {items.map((it) => (
              <View
                key={it.id}
                data-story-id={it.id}
                className={`story-card-wrap${
                  anchorStoryId === it.id ? " is-anchor" : ""
                }`}
                onClick={() => openStory(it)}
              >
                {renderStoryCard(it)}
              </View>
            ))}
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
            <View className="story-tip-icon">
              <AppIcon name="book" tone="mute" size={26} />
            </View>
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
    </>
  );

  return (
    <View className="story-panel">
      {/* ===== 主视图：合成文章 OR 降级列表 ===== */}
      {hasSynthesis ? (
        <View className="story-panel-main">
          <ScrollView className="synthesis-scroll" scrollY>
            {synthesisLoading && !synthesisFetched ? (
              <View className="synthesis-loading">
                <Text className="synthesis-loading-text">
                  正在整理合成文章…
                </Text>
              </View>
            ) : (
              <View className="synthesis-article">
                {SYNTHESIS_SECTIONS.map((sec) => renderSynthesisSection(sec))}
                {synthesis?.createdAt ? (
                  <View className="synthesis-meta">
                    <Text className="synthesis-meta-text">
                      合成于 {formatTime(synthesis.createdAt)} · 由 Qwen 整理
                    </Text>
                  </View>
                ) : null}
              </View>
            )}
            <View className="synthesis-toggle">
              <View
                className={`synthesis-toggle-btn${
                  detailsOpen ? " is-open" : ""
                }`}
                onClick={toggleDetails}
              >
                <Text className="synthesis-toggle-text">
                  {detailsOpen
                    ? "收起故事细节"
                    : `展开全部 ${total || items.length} 张故事碎片`}
                </Text>
                <Text className="synthesis-toggle-arrow">
                  {detailsOpen ? "▴" : "▾"}
                </Text>
              </View>
            </View>
          </ScrollView>
        </View>
      ) : !synthesisFetched ? (
        /* 合成结果还没回来：先占位。旧实现这里会直接把 chips + 列表顶上去，
         * 用户切进 tab 先看到一排「tab 标签」再被文章替换，观感像渲染错乱。 */
        <View className="story-panel-main">
          <View className="synthesis-loading">
            <Text className="synthesis-loading-text">
              正在整理故事还原…
            </Text>
          </View>
        </View>
      ) : (
        /* 确认没有合成（未生成 / 生成失败 / 空壳 overview）→ 降级到碎片列表 */
        <View className="story-panel-main story-panel-main--legacy">
          {items.length ? (
            <View className="story-legacy-tip">
              <Text className="story-legacy-tip-text">
                {synthesisError
                  ? "合成文章暂不可用，下面是原始故事碎片"
                  : "这本手册还没生成合成文章，下面是原始故事碎片"}
              </Text>
            </View>
          ) : null}
          {renderDetailsList()}
        </View>
      )}

      {/* ===== 抽屉：合成文章下的故事碎片（仅在 hasSynthesis 时用） ===== */}
      {hasSynthesis && detailsOpen ? (
        <View className="story-details-drawer">
          <View
            className="story-details-mask"
            onClick={toggleDetails}
          />
          <View className="story-details-sheet">
            <View className="story-details-head">
              <Text className="story-details-title">
                {anchorSection ? `「${anchorSection.title}」关联碎片` : "故事碎片"}
              </Text>
              <View
                className="story-details-close"
                onClick={toggleDetails}
                ariaRole="button"
                ariaLabel="关闭"
              >
                <AppIcon name="x" tone="ink" size={13} />
              </View>
            </View>
            {anchorSection ? (
              <View className="story-details-anchorbar">
                <Text className="story-details-anchorbar-text">
                  本节关联 {anchorItems.length} 张 · 已从全部{" "}
                  {total || items.length} 张中筛选
                </Text>
                <View
                  className="story-details-anchorbar-btn"
                  onClick={clearAnchorFilter}
                >
                  <Text className="story-details-anchorbar-btn-text">
                    查看全部
                  </Text>
                </View>
              </View>
            ) : null}
            <View className="story-details-body">
              {anchorSection ? (
                anchorLoading ? (
                  <View className="story-tip">
                    <Text className="story-tip-text">正在定位关联碎片…</Text>
                  </View>
                ) : anchorItems.length ? (
                  <ScrollView className="story-list" scrollY>
                    <View className="story-cards">
                      {anchorItems.map((it) => (
                        <View
                          key={it.id}
                          data-story-id={it.id}
                          className={`story-card-wrap${
                            anchorStoryId === it.id ? " is-anchor" : ""
                          }`}
                          onClick={() => openStory(it)}
                        >
                          {renderStoryCard(it)}
                        </View>
                      ))}
                    </View>
                  </ScrollView>
                ) : (
                  <View className="story-tip">
                    <Text className="story-tip-text">
                      没找到本节关联的碎片
                    </Text>
                    <View
                      className="story-retry"
                      onClick={clearAnchorFilter}
                    >
                      <Text className="story-retry-text">查看全部碎片</Text>
                    </View>
                  </View>
                )
              ) : (
                renderDetailsList()
              )}
            </View>
          </View>
        </View>
      ) : null}

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
                    划线评论 · 已选 {Array.from(pendingSel.quote).length} 字
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
