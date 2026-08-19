/**
 * 剧本详情 + DM 手册 AI 问答。
 *
 * 问答走 {@link askScriptQuestion} 的两级分流：先向量检索，命中预置问答对就
 * 直接把手册原文答案摆出来（标「手册原文」，不烧大模型额度）；只有检索不到
 * 满意结果时才真正请大模型出手（标「AI 生成」）。用户能一眼看出这句话
 * 是手册白纸黑字写的，还是 AI 推的 —— 带本时这两者的可信度完全不同。
 *
 * 手册未建好索引时不放开输入框：那时候提问必然是空答，不如把解析进度显示清楚。
 *
 * 会话按剧本持久化到 localStorage（`dm_chat_{code}`，最多保留最近 50 条），
 * 退出重进不丢记录；ready-bar 提供「清除会话」（二次确认后连存档一起删）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, Input } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { fetchScriptDetail, type ScriptItemCamel } from "../../services/script";
import {
  askScriptQuestion,
  fetchImportStatus,
  fetchQaTitleChain,
  ingestDmGuide,
  isTerminalStatus,
  resolveJobProgress,
  OVERALL_STATUS_TEXT,
  type AnswerSource,
  type AskSource,
  type ImportStatus,
  type QATitleChain,
  type QATitleItem,
  type QATitleNode,
} from "../../services/dmGuide";
import { ApiError } from "../../services/request";
import { useAuth } from "../../store/auth";
import { usePolling } from "../../hooks/usePolling";
import QuestionPanel from "../../components/QuestionPanel";
import "./index.less";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 答案来路：手册原文 / AI 生成 / 无结果 */
  source?: AnswerSource;
  similarity?: number;
  matchedQuestion?: string;
  sources?: AskSource[];
  tookMs?: number;
  isError?: boolean;
}

const SOURCE_LABEL: Record<AnswerSource, string> = {
  manual: "手册原文",
  ai: "AI 生成",
  none: "未命中",
};

const SOURCE_TONE: Record<AnswerSource, string> = {
  manual: "is-manual",
  ai: "is-ai",
  none: "is-none",
};

/** 手册就绪后给的引导问法，降低「不知道能问什么」的冷启动成本 */
const SUGGESTED = [
  "本案凶手是谁？",
  "第二幕的流程是什么？",
  "玩家问不出线索怎么办？",
];

const POLL_INTERVAL = 5000;

let seq = 0;
const nextId = () => `m${Date.now()}_${seq++}`;

/* ------------------------- 会话持久化（localStorage） ------------------------- */
/* Taro H5 下 get/setStorageSync 底层即 localStorage。按剧本 code 分键，
 * 一部剧本一份会话；只保留最近 MAX_PERSISTED 条，防止答案长文本把 5MB 额度撑爆。 */

const CHAT_KEY_PREFIX = "dm_chat_";
const MAX_PERSISTED = 50;

interface PersistedChat {
  v: number;
  savedAt: number;
  lastAskedQaId?: string;
  messages: ChatMessage[];
}

function chatStorageKey(scriptCode: string): string {
  return `${CHAT_KEY_PREFIX}${scriptCode}`;
}

/** 读取已存会话；数据缺失/损坏时返回 null（静默降级为全新会话） */
function loadPersistedChat(scriptCode: string): PersistedChat | null {
  if (!scriptCode) return null;
  try {
    const raw = Taro.getStorageSync(chatStorageKey(scriptCode));
    if (!raw) return null;
    const data = (typeof raw === "string" ? JSON.parse(raw) : raw) as PersistedChat;
    if (!data || !Array.isArray(data.messages)) return null;
    return data;
  } catch {
    return null;
  }
}

/** 写入会话；存储超限等异常静默吞掉，绝不影响聊天主流程 */
function persistChat(
  scriptCode: string,
  messages: ChatMessage[],
  lastAskedQaId: string
) {
  if (!scriptCode) return;
  try {
    const payload: PersistedChat = {
      v: 1,
      savedAt: Date.now(),
      lastAskedQaId: lastAskedQaId || undefined,
      messages: messages.slice(-MAX_PERSISTED),
    };
    Taro.setStorageSync(chatStorageKey(scriptCode), JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function ScriptDetailPage() {
  const router = useRouter();
  const scriptCode = decodeURIComponent(String(router.params?.code || ""));
  const presetTitle = decodeURIComponent(String(router.params?.title || ""));

  const { isAuthenticated } = useAuth();
  const [script, setScript] = useState<ScriptItemCamel | null>(null);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  /* 首渲染即从 localStorage 恢复上次会话（scriptCode 在首渲染已可从路由参数拿到），
   * 用惰性初始化而不是 effect 恢复，避免「先写空数组覆盖存档、再读档」的时序坑。 */
  const initialChatRef = useRef<PersistedChat | null | undefined>(undefined);
  const getInitialChat = (): PersistedChat | null => {
    if (initialChatRef.current === undefined) {
      initialChatRef.current = loadPersistedChat(scriptCode);
    }
    return initialChatRef.current ?? null;
  };

  const [messages, setMessages] = useState<ChatMessage[]>(
    () => getInitialChat()?.messages ?? []
  );
  const [inputValue, setInputValue] = useState("");
  const [asking, setAsking] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [scrollTarget, setScrollTarget] = useState("");

  /* 问答目录概览（/qa-titles）：独立抽屉展示，不占用聊天消息流 */
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalog, setCatalog] = useState<QATitleChain | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [catalogFetched, setCatalogFetched] = useState(false);
  const [catExpanded, setCatExpanded] = useState<Record<string, boolean>>({});
  /** 抽屉打开过一次后保持挂载（只隐藏不销毁），滚动位置与展开状态不丢 */
  const [catalogMounted, setCatalogMounted] = useState(false);
  /** 上次从目录点出去提问的问答 ID，重开抽屉时高亮标记「上次提问」（随会话一并持久化） */
  const [lastAskedQaId, setLastAskedQaId] = useState(
    () => getInitialChat()?.lastAskedQaId ?? ""
  );

  /* 用户提问面板：与问答目录平行的底部抽屉，展示待解答问题池并支持真人解答 */
  const [questionPanelOpen, setQuestionPanelOpen] = useState(false);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* 会话变化即落盘（含目录直答与正常问答），最多保留最近 50 条 */
  useEffect(() => {
    persistChat(scriptCode, messages, lastAskedQaId);
  }, [messages, lastAskedQaId, scriptCode]);

  /* 恢复到历史会话时，把视图定位到最后一条消息 */
  useEffect(() => {
    const restored = getInitialChat()?.messages;
    if (restored?.length) {
      setScrollTarget(restored[restored.length - 1].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 清除本会话的聊天记录（含持久化存档），需二次确认 */
  const handleClearChat = useCallback(() => {
    if (!messages.length) return;
    Taro.showModal({
      title: "清除会话",
      content: "清除后本剧本的问答记录将不可恢复",
      confirmText: "清除",
      confirmColor: "#e54d42",
      success: (res) => {
        if (!res.confirm) return;
        setMessages([]);
        setLastAskedQaId("");
        setExpanded({});
        setScrollTarget("");
        try {
          Taro.removeStorageSync(chatStorageKey(scriptCode));
        } catch {
          /* ignore */
        }
        Taro.showToast({ title: "会话已清除", icon: "none" });
      },
    });
  }, [messages.length, scriptCode]);

  const loadStatus = useCallback(async (): Promise<boolean> => {
    if (!scriptCode) return false;
    try {
      const st = await fetchImportStatus(scriptCode);
      // 状态拉不到不阻断详情展示，问答区会退化成「状态未知」
      if (mountedRef.current) setImportStatus(st);
      return true;
    } catch {
      // 返回 false 让 usePolling 计入连续失败、触发「三次失败停表」
      return false;
    }
  }, [scriptCode]);

  useEffect(() => {
    if (!scriptCode) {
      setLoadError("缺少剧本参数");
      setLoading(false);
      return;
    }
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const detail = await fetchScriptDetail(scriptCode);
        if (!alive) return;
        setScript(detail);
        Taro.setNavigationBarTitle({ title: detail.title || "剧本详情" });
        await loadStatus();
      } catch (err) {
        if (!alive) return;
        setLoadError(err instanceof ApiError ? err.message : "剧本加载失败");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [scriptCode, loadStatus]);

  /* 解析未完成时轮询，就绪即停；连续失败 3 次自动停表（后端挂了不再空转烧流量） */
  const overall = importStatus?.overallStatus ?? "pending";
  const busy = !isTerminalStatus(overall);
  usePolling({
    active: busy && !!scriptCode && !!script,
    interval: POLL_INTERVAL,
    task: loadStatus,
    onGiveUp: () =>
      Taro.showToast({
        title: "状态刷新已停止，请下拉重试",
        icon: "none",
      }),
  });

  const isReady = overall === "ready";
  const dmGuide = (importStatus?.dmGuide ?? {}) as Record<string, any>;
  const job = dmGuide.job as any;
  const jobProg = resolveJobProgress(job);

  /* ------------------------------ 提问 ------------------------------ */

  const submitQuestion = useCallback(
    async (raw: string) => {
      const q = (raw || "").trim();
      if (!q || asking) return;
      if (!isReady) {
        Taro.showToast({ title: "手册尚未建好索引", icon: "none" });
        return;
      }

      const userMsg: ChatMessage = { id: nextId(), role: "user", content: q };
      setMessages((prev) => [...prev, userMsg]);
      setInputValue("");
      setAsking(true);
      setScrollTarget(userMsg.id);

      try {
        // 检索接口是公开的，但 ask（要花 LLM 额度）后端要求登录。
        // 未登录时索性别去撞那个 401，直接退化成纯手册检索。
        const res = await askScriptQuestion(scriptCode, q, {
          topK: 6,
          allowLlm: isAuthenticated,
        });
        if (!mountedRef.current) return;
        const reply: ChatMessage = {
          id: nextId(),
          role: "assistant",
          content: res.answer || "未能得到答案，请换个问法试试。",
          source: res.source,
          similarity: res.similarity,
          matchedQuestion: res.matchedQuestion,
          sources: res.sources,
          tookMs: res.tookMs,
        };
        setMessages((prev) => [...prev, reply]);
        setScrollTarget(reply.id);
      } catch (err) {
        if (!mountedRef.current) return;
        const msg =
          err instanceof ApiError ? err.message : "提问失败，请稍后重试";
        const reply: ChatMessage = {
          id: nextId(),
          role: "assistant",
          content: msg,
          isError: true,
        };
        setMessages((prev) => [...prev, reply]);
        setScrollTarget(reply.id);
      } finally {
        if (mountedRef.current) setAsking(false);
      }
    },
    [asking, isReady, scriptCode, isAuthenticated]
  );

  const handleRetryIngest = useCallback(async () => {
    if (!isAuthenticated) {
      Taro.showToast({ title: "请先登录", icon: "none" });
      return;
    }
    try {
      await ingestDmGuide(scriptCode, true);
      Taro.showToast({ title: "已重新提交解析", icon: "none" });
      void loadStatus();
    } catch (err) {
      Taro.showToast({
        title: err instanceof ApiError ? err.message : "重试失败",
        icon: "none",
      });
    }
  }, [isAuthenticated, scriptCode, loadStatus]);

  /* ---------------------------- 目录概览（/qa-titles） ---------------------------- */

  /**
   * 拉取问答目录。手册就绪后立即在后台预加载，用户点开抽屉时数据
   * 通常已就位、体感「秒开」；失败重试同样走这里（重复调用有防抖守卫）。
   */
  const loadCatalog = useCallback(async () => {
    if (!scriptCode || catalogFetched || catalogLoading) return;
    setCatalogLoading(true);
    setCatalogError("");
    try {
      const chain = await fetchQaTitleChain(scriptCode);
      if (!mountedRef.current) return;
      setCatalog(chain);
      setCatalogFetched(true);
      const expanded: Record<string, boolean> = {};
      const walk = (nodes: QATitleNode[], depth: number) => {
        for (const n of nodes) {
          const key = n.path.join("/") || n.title;
          expanded[key] = true;
          if (depth < 2 && n.children?.length) walk(n.children, depth + 1);
        }
      };
      walk(chain.titles ?? [], 1);
      setCatExpanded(expanded);
    } catch (err) {
      if (!mountedRef.current) return;
      setCatalogError(err instanceof ApiError ? err.message : "目录加载失败");
    } finally {
      if (mountedRef.current) setCatalogLoading(false);
    }
  }, [scriptCode, catalogFetched, catalogLoading]);

  /* 预加载：手册一就绪就在后台拉目录，不等用户点开抽屉 */
  useEffect(() => {
    if (isReady) void loadCatalog();
  }, [isReady, loadCatalog]);

  /** 打开抽屉；数据若尚未预载完成则兜底再触发一次（loadCatalog 内部去重） */
  const openCatalog = useCallback(() => {
    setCatalogMounted(true);
    setCatalogOpen(true);
    void loadCatalog();
  }, [loadCatalog]);

  /**
   * 点目录里的一条问答：答案就在条目上（解析阶段预生成的问答对），
   * 直接把问与答落成消息 —— 不再走一遍检索接口，零延迟、零 embedding 开销。
   * 答案标「手册原文 · 匹配度 100%」，出处带上所在章节路径与页码。
   * 防御：个别条目 answer 为空时回退到正常提问链路。
   */
  const handleCatalogAsk = useCallback(
    (item: QATitleItem, sectionPath: string[]) => {
      setLastAskedQaId(item.id);
      setCatalogOpen(false);
      if (!item.answer?.trim()) {
        void submitQuestion(item.question);
        return;
      }
      const userMsg: ChatMessage = {
        id: nextId(),
        role: "user",
        content: item.question,
      };
      const reply: ChatMessage = {
        id: nextId(),
        role: "assistant",
        content: item.answer,
        source: "manual",
        similarity: 1,
        matchedQuestion: item.question,
        sources: [
          {
            type: "qa",
            similarity: 1,
            question: item.question,
            answer: item.answer,
            sectionPath,
            pageStart: item.pageStart ?? 0,
            pageEnd: item.pageEnd ?? 0,
          },
        ],
      };
      setMessages((prev) => [...prev, userMsg, reply]);
      setScrollTarget(reply.id);
    },
    [submitQuestion]
  );

  /** 递归渲染标题树：节点可展开/收起，叶子问答可直接发起提问 */
  const renderCatalogNodes = (nodes: QATitleNode[], depth: number) =>
    nodes.map((n) => {
      const key = n.path.join("/") || n.title;
      const open = !!catExpanded[key];
      const hasChildren = !!n.children?.length;
      return (
        <View className="cat-node" key={key}>
          <View
            className="cat-node-head"
            onClick={() =>
              setCatExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
            }
          >
            <Text className="cat-caret">{open ? "▾" : "▸"}</Text>
            <Text className="cat-node-title">{n.title}</Text>
            <Text className="cat-node-count">{n.qaCount}</Text>
          </View>
          {open ? (
            <View className="cat-node-body">
              {n.qa.map((item) => {
                const isLast = item.id === lastAskedQaId;
                return (
                  <View
                    className={`cat-qa-item${isLast ? " is-last" : ""}`}
                    key={item.id}
                    onClick={() => handleCatalogAsk(item, n.path)}
                  >
                    <Text className="cat-qa-text">{item.question}</Text>
                    {isLast ? (
                      <Text className="cat-qa-last">上次提问</Text>
                    ) : (
                      <Text className="cat-qa-go">提问</Text>
                    )}
                  </View>
                );
              })}
              {hasChildren ? renderCatalogNodes(n.children, depth + 1) : null}
            </View>
          ) : null}
        </View>
      );
    });

  /* ------------------------------ 渲染 ------------------------------ */

  if (loading) {
    return (
      <View className="detail-page">
        <View className="page-tip">加载中…</View>
      </View>
    );
  }

  if (loadError) {
    return (
      <View className="detail-page">
        <View className="page-tip is-error">{loadError}</View>
      </View>
    );
  }

  const title = script?.title || presetTitle || "剧本详情";

  return (
    <View className="detail-page">
      {/* ===== 剧本信息 ===== */}
      <View className="script-head">
        <View className="head-cover">
          <Text className="cover-text">{title[0]}</Text>
        </View>
        <View className="head-body">
          <Text className="head-title">{title}</Text>
          <View className="head-meta">
            {script?.playerText ? (
              <Text className="meta-item">{script.playerText}</Text>
            ) : null}
            {script?.durationText ? (
              <Text className="meta-item">{script.durationText}</Text>
            ) : null}
            {script?.difficultyLabel ? (
              <Text className="meta-item">{script.difficultyLabel}</Text>
            ) : null}
          </View>
          <Text className={`head-badge ${isReady ? "is-ready" : "is-idle"}`}>
            {OVERALL_STATUS_TEXT[overall] ?? overall}
          </Text>
        </View>
      </View>

      {/* ===== 未就绪：显示进度 / 失败重试 ===== */}
      {!isReady ? (
        <View className="status-panel">
          {overall === "failed" ? (
            <>
              <Text className="status-title">手册解析失败</Text>
              <Text className="status-desc">
                {job?.errorMessage || "未知原因"}
              </Text>
              <View className="status-btn" onClick={handleRetryIngest}>
                <Text className="status-btn-text">重新解析</Text>
              </View>
            </>
          ) : overall === "no_guide" ? (
            <>
              <Text className="status-title">未关联 DM 手册</Text>
              <Text className="status-desc">
                这个剧本还没上传主持人手册，无法进行问答
              </Text>
            </>
          ) : (
            <>
              <Text className="status-title">
                {jobProg.text || "正在解析手册"}
              </Text>
              <View className="progress-track">
                <View
                  className={`progress-fill${
                    jobProg.indeterminate ? " is-indeterminate" : ""
                  }`}
                  style={{
                    width: jobProg.indeterminate
                      ? "0%"
                      : `${Math.max(jobProg.percent, 5)}%`,
                  }}
                />
              </View>
              <Text className="status-desc">
                解析完成后即可提问
                {job?.totalPages ? ` · 共 ${job.totalPages} 页` : ""}
              </Text>
            </>
          )}
        </View>
      ) : (
        <View className="ready-bar">
          <Text className="ready-text">
            索引就绪 · {dmGuide?.job?.embeddedQa ?? 0} 条问答
          </Text>
          <View className="ready-actions">
            {messages.length ? (
              <View className="clear-btn" onClick={handleClearChat}>
                <Text className="clear-btn-text">清除会话</Text>
              </View>
            ) : null}
            <View className="qpanel-btn" onClick={() => setQuestionPanelOpen(true)}>
              <Text className="qpanel-btn-text">❓ 用户提问</Text>
            </View>
            <View className="catalog-btn" onClick={openCatalog}>
              <Text className="catalog-btn-text">📖 问答目录</Text>
            </View>
          </View>
        </View>
      )}

      {/* ===== 问答区 ===== */}
      <ScrollView
        className="chat-area"
        scrollY
        scrollIntoView={scrollTarget}
        scrollWithAnimation
      >
        {!messages.length ? (
          <View className="chat-intro">
            <Text className="intro-emoji">💬</Text>
            <Text className="intro-title">问问这本的手册</Text>
            <Text className="intro-desc">
              先在手册里做语义检索，命中现成答案就直接给你；
              检索不到才请大模型作答。
            </Text>
            {isReady ? (
              <>
                <View className="suggest-list">
                  {SUGGESTED.map((s) => (
                    <View
                      className="suggest-item"
                      key={s}
                      onClick={() => submitQuestion(s)}
                    >
                      <Text className="suggest-text">{s}</Text>
                    </View>
                  ))}
                </View>
                <View className="catalog-link" onClick={openCatalog}>
                  <Text className="catalog-link-text">
                    先看看手册里都有什么 · 浏览问答目录
                  </Text>
                </View>
              </>
            ) : null}
          </View>
        ) : null}

        {messages.map((m) => {
          if (m.role === "user") {
            return (
              <View className="msg-row is-user" id={m.id} key={m.id}>
                <View className="bubble is-user">
                  <Text className="bubble-text">{m.content}</Text>
                </View>
              </View>
            );
          }

          const tone = m.isError ? "is-error" : SOURCE_TONE[m.source ?? "none"];
          const open = !!expanded[m.id];
          return (
            <View className="msg-row" id={m.id} key={m.id}>
              <View className={`bubble is-bot ${m.isError ? "is-error" : ""}`}>
                {!m.isError && m.source ? (
                  <View className="bubble-head">
                    <Text className={`src-tag ${tone}`}>
                      {SOURCE_LABEL[m.source]}
                    </Text>
                    {m.source === "manual" && m.similarity ? (
                      <Text className="src-hint">
                        匹配度 {Math.round(m.similarity * 100)}%
                      </Text>
                    ) : null}
                    {m.source === "ai" ? (
                      <Text className="src-hint">
                        检索未命中，已由大模型作答
                      </Text>
                    ) : null}
                  </View>
                ) : null}

                <Text className="bubble-text">{m.content}</Text>

                {m.source === "manual" && m.matchedQuestion ? (
                  <Text className="matched-q">
                    对应手册问题：{m.matchedQuestion}
                  </Text>
                ) : null}

                {m.sources?.length ? (
                  <View className="ref-block">
                    <Text
                      className="ref-toggle"
                      onClick={() =>
                        setExpanded((prev) => ({
                          ...prev,
                          [m.id]: !prev[m.id],
                        }))
                      }
                    >
                      {open ? "收起出处" : `查看出处（${m.sources.length}）`}
                    </Text>
                    {open
                      ? m.sources.map((s, i) => (
                          <View className="ref-item" key={`${m.id}_r${i}`}>
                            <Text className="ref-meta">
                              {s.type === "qa" ? "问答对" : "原文"}
                              {s.sectionPath?.length
                                ? ` · ${s.sectionPath.join(" / ")}`
                                : ""}
                              {s.pageStart ? ` · P${s.pageStart}` : ""}
                              {` · ${Math.round((s.similarity ?? 0) * 100)}%`}
                            </Text>
                            <Text className="ref-text">
                              {s.type === "qa"
                                ? `${s.question}\n${s.answer}`
                                : s.content}
                            </Text>
                          </View>
                        ))
                      : null}
                  </View>
                ) : null}
              </View>
            </View>
          );
        })}

        {asking ? (
          <View className="msg-row">
            <View className="bubble is-bot">
              <Text className="bubble-text">正在检索手册…</Text>
            </View>
          </View>
        ) : null}

        <View className="chat-bottom-space" />
      </ScrollView>

      {/* ===== 问答目录抽屉（/qa-titles 概览，独立于聊天框） ===== */}
      {/* 打开过一次后保持挂载：滚动位置、展开状态、上次提问标记都原样保留 */}
      {catalogMounted ? (
        <View
          className={`sheet-mask${catalogOpen ? " is-open" : ""}`}
          onClick={() => setCatalogOpen(false)}
        >
          <View
            className={`catalog-sheet${catalogOpen ? " is-open" : ""}`}
            onClick={(e) => e.stopPropagation()}
          >
            <View className="sheet-handle" />
            <View className="sheet-head">
              <Text className="sheet-title">问答目录</Text>
              <Text className="sheet-sub">
                {catalog
                  ? `共 ${catalog.totalQa} 条问答 · ${catalog.totalTitles} 个章节`
                  : ""}
              </Text>
              <View
                className="sheet-close"
                onClick={() => setCatalogOpen(false)}
              >
                <Text className="sheet-close-text">✕</Text>
              </View>
            </View>
            <ScrollView className="sheet-body" scrollY>
              {catalogLoading ? (
                <View className="cat-tip">正在加载目录…</View>
              ) : catalogError ? (
                <View className="cat-tip is-error">
                  <Text className="cat-tip-text">{catalogError}</Text>
                  <View
                    className="cat-retry"
                    onClick={() => void loadCatalog()}
                  >
                    <Text className="cat-retry-text">重试</Text>
                  </View>
                </View>
              ) : catalog && catalog.titles?.length ? (
                renderCatalogNodes(catalog.titles, 1)
              ) : (
                <View className="cat-tip">这本手册还没有可浏览的问答目录</View>
              )}
            </ScrollView>
          </View>
        </View>
      ) : null}

      {/* ===== 用户提问面板（底部抽屉，与问答目录并行） ===== */}
      <QuestionPanel
        scriptCode={scriptCode}
        scriptTitle={script?.title || presetTitle}
        open={questionPanelOpen}
        onClose={() => setQuestionPanelOpen(false)}
        isAuthenticated={isAuthenticated}
        onAskQuestion={submitQuestion}
      />

      {/* ===== 输入栏 ===== */}
      <View className="input-bar">
        <Input
          className="chat-input"
          value={inputValue}
          disabled={!isReady || asking}
          placeholder={isReady ? "问点什么…" : "手册就绪后可提问"}
          confirmType="send"
          adjustPosition
          onInput={(e) => setInputValue(e.detail.value)}
          onConfirm={(e) => submitQuestion(e.detail.value)}
        />
        <View
          className={`send-btn ${
            !isReady || asking || !inputValue.trim() ? "is-disabled" : ""
          }`}
          onClick={() => submitQuestion(inputValue)}
        >
          <Text className="send-text">{asking ? "…" : "发送"}</Text>
        </View>
      </View>
    </View>
  );
}

export default ScriptDetailPage;
