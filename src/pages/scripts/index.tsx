/**
 * 剧本库 —— 只展示已解析完成的剧本。
 *
 * 页面定位从「全量剧本库 + 多维度筛选」收窄为「已解析剧本列表」：
 *   - 去掉了排序、玩法/题材/难度/人数筛选及已选汇总条等全部筛选 UI；
 *   - 列表固定以 `hasGuide=true` 请求后端，只召回已关联 DM 主持人手册
 *     （已完成解析、可进入详情问答）的剧本；
 *   - 顶部新增搜索框：在「已解析剧本」范围内按关键词检索；
 *   - 当搜索关键词非空且结果为空时，展示「请求剧本解析」CTA，按钮名为
 *     `求《剧本名》解析`，点击后调用 `POST /scripts/requests` 发起求解析
 *     （未登录引导登录），成功后跳转到「我的 → 求解析」列表查看诉求进度；
 *   - 保留下拉刷新、加载更多与空/错状态，交互保持极简。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text } from "@tarojs/components";
import Taro, { usePullDownRefresh, useDidShow } from "@tarojs/taro";
import { SearchBar } from "@nutui/nutui-react-taro";
import {
  fetchScriptList,
  type ScriptItemCamel,
} from "../../services/script";
import {
  createScriptRequest,
  fetchScriptRequestLeaderboard,
  type ScriptRequestLeaderboardItem,
} from "../../services/scriptRequest";
import { ApiError } from "../../services/request";
import { goLogin, useAuth } from "../../store/auth";
import { replayActiveTabIcon } from "../../utils/replayActiveTabIcon";
import "./index.less";

function ScriptLibraryPage() {
  useDidShow(replayActiveTabIcon);
  const { isAuthenticated } = useAuth();
  /* ----------------------------- 列表状态 ----------------------------- */
  const [scripts, setScripts] = useState<ScriptItemCamel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  /** 发起求解析中：禁用按钮、防重复点击 */
  const [submitting, setSubmitting] = useState(false);

  /* --------------------------- 求解析榜单 --------------------------- */
  const [boardOpen, setBoardOpen] = useState(false);
  const [boardItems, setBoardItems] = useState<ScriptRequestLeaderboardItem[]>([]);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardError, setBoardError] = useState("");
  /** 请求序号：仅应用最新一次结果，丢弃乱序旧响应 */
  const boardSeq = useRef(0);

  /* ----------------------------- 搜索状态 ----------------------------- */
  const [keyword, setKeyword] = useState("");
  /** 用 ref 持有最新关键词，避免 loadScripts 依赖 keyword 反复重建 */
  const keywordRef = useRef("");

  /* ----------------------------- 控制标志 ----------------------------- */
  const mountedRef = useRef(true);
  /** 请求序号：仅应用最新一次的结果，丢弃乱序的旧响应 */
  const reqSeq = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* 组件卸载时清除搜索防抖定时器 */
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  /* ---------- 加载剧本列表：固定只看已解析完成的剧本 ---------- */
  const loadScripts = useCallback(
    async (reset: boolean) => {
      const seq = ++reqSeq.current;
      const kw = keywordRef.current.trim();
      if (reset) {
        setLoading(true);
        setErrorMsg("");
      } else {
        setLoadingMore(true);
      }

      try {
        const res = await fetchScriptList({
          hasGuide: true,
          keyword: kw,
          sort: "newest",
          limit: 20,
          offset: reset ? 0 : scripts.length,
        });
        if (seq !== reqSeq.current) return; // 已有更新的请求发出
        if (reset) {
          setScripts(res.items);
        } else {
          setScripts((prev) => [...prev, ...res.items]);
        }
        setHasMore(res.pagination.hasMore);
        setTotal(res.pagination.total);
      } catch (err) {
        if (seq !== reqSeq.current) return;
        const msg =
          err instanceof ApiError ? err.message : "加载失败，请重试";
        if (reset) setErrorMsg(msg);
        else setErrorMsg("加载更多失败，请重试");
      } finally {
        if (seq !== reqSeq.current) return;
        if (reset) {
          setLoading(false);
        } else {
          setLoadingMore(false);
        }
      }
    },
    [scripts.length]
  );

  /* ---------- 首屏加载 ---------- */
  useEffect(() => {
    void loadScripts(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 下拉刷新 ---------- */
  usePullDownRefresh(() => {
    void loadScripts(true).finally(() => Taro.stopPullDownRefresh());
  });

  /* ---------- 加载更多 ---------- */
  const handleLoadMore = useCallback(() => {
    if (loadingMore || !hasMore || loading) return;
    void loadScripts(false);
  }, [loadingMore, hasMore, loading, loadScripts]);

  /* ---------- 搜索：防抖触发列表重载 ---------- */
  const runSearch = useCallback(
    (raw: string) => {
      const kw = raw.trim();
      keywordRef.current = kw;
      void loadScripts(true);
    },
    [loadScripts]
  );

  const handleSearchChange = (value: string) => {
    setKeyword(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => runSearch(value), 300);
  };

  const handleSearchConfirm = (value: string) => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setKeyword(value);
    void runSearch(value);
  };

  const handleSearchClear = () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setKeyword("");
    keywordRef.current = "";
    void loadScripts(true);
  };

  /* ---------- 打开剧本详情 ---------- */
  const openDetail = useCallback((s: ScriptItemCamel) => {
    Taro.navigateTo({
      url: `/pages/scriptDetail/index?code=${encodeURIComponent(
        s.code
      )}&title=${encodeURIComponent(s.title || "")}`,
    });
  }, []);

  /* ---------- 请求剧本解析：调 POST /scripts/requests，成功后跳求解析列表 ---------- */
  const requestAnalysis = useCallback(async () => {
    const name = keywordRef.current.trim();
    if (!name || submitting) return;

    // 未登录：先去登录，登录后回到剧本库继续操作
    if (!isAuthenticated) {
      goLogin("/pages/scripts/index");
      return;
    }

    setSubmitting(true);
    try {
      const item = await createScriptRequest({ scriptTitle: name });
      const tip = item.alreadyExists
        ? "已发起过该剧本的求解析"
        : "已提交求解析";
      Taro.showToast({ title: tip, icon: "none", duration: 1400 });
      // 稍作停留让用户看到提示，再跳到求解析列表
      setTimeout(() => {
        void Taro.navigateTo({ url: "/pages/scriptRequests/index" });
      }, 700);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.isAuthError) {
          goLogin("/pages/scripts/index");
          return;
        }
        if (err.code === "script_already_parsed") {
          // 该剧本其实已解析完成（搜索结果可能过期）：刷新列表让它现身
          Taro.showToast({ title: "该剧本已解析完成", icon: "none" });
          void loadScripts(true);
          return;
        }
        Taro.showToast({
          title: err.message || "发起失败，请重试",
          icon: "none",
        });
      } else {
        Taro.showToast({ title: "发起失败，请重试", icon: "none" });
      }
    } finally {
      setSubmitting(false);
    }
  }, [submitting, isAuthenticated, loadScripts]);

  /* ---------- 求解析榜单：打开弹层并拉取数据（公开接口，无需登录） ---------- */
  const openLeaderboard = useCallback(async () => {
    setBoardOpen(true);
    const seq = ++boardSeq.current;
    setBoardError("");
    // 已有缓存时静默刷新，避免重复全屏 loading
    if (boardItems.length === 0) setBoardLoading(true);
    try {
      const res = await fetchScriptRequestLeaderboard({ limit: 50 });
      if (seq !== boardSeq.current) return;
      setBoardItems(res.items);
    } catch (err) {
      if (seq !== boardSeq.current) return;
      setBoardError(
        err instanceof ApiError ? err.message : "加载失败，请重试"
      );
    } finally {
      if (seq !== boardSeq.current) return;
      setBoardLoading(false);
    }
  }, [boardItems.length]);

  const closeLeaderboard = useCallback(() => {
    setBoardOpen(false);
  }, []);

  /** 榜单点击：有业务编码的剧本可跳详情复盘，库外剧本仅提示 */
  const openBoardItem = useCallback(
    (item: ScriptRequestLeaderboardItem) => {
      if (!item.scriptCode) {
        Taro.showToast({ title: "该剧本还未入库，暂无详情", icon: "none" });
        return;
      }
      closeLeaderboard();
      Taro.navigateTo({
        url: `/pages/scriptDetail/index?code=${encodeURIComponent(
          item.scriptCode
        )}&title=${encodeURIComponent(item.scriptTitle || "")}`,
      });
    },
    [closeLeaderboard]
  );

  /* ------------------------------ 渲染 ------------------------------ */
  const kw = keyword.trim();
  /** 搜索无结果：关键词非空、已加载完、列表为空、且无错误 */
  const isSearchEmpty = kw.length > 0 && !loading && !errorMsg && scripts.length === 0;

  return (
    <View className="library-page">
      {/* ===== 搜索框 ===== */}
      <View className="lib-search">
        <SearchBar
          value={keyword}
          placeholder="搜索已解析的剧本..."
          shape="round"
          onChange={handleSearchChange}
          onSearch={handleSearchConfirm}
          onClear={handleSearchClear}
        />
      </View>

      {/* ===== 结果计数 ===== */}
      <View className="result-info">
        {loading ? (
          <Text className="result-count">加载中…</Text>
        ) : kw.length > 0 ? (
          <Text className="result-count">
            搜索「{kw}」· 共 {total} 个
          </Text>
        ) : (
          <Text className="result-count">已解析剧本 · 共 {total} 个</Text>
        )}
      </View>

      {/* ===== 错误提示 ===== */}
      {errorMsg && !loading ? (
        <View className="page-error">{errorMsg}</View>
      ) : null}

      {/* ===== 搜索无结果：请求解析 CTA ===== */}
      {isSearchEmpty ? (
        <View className="request-cta">
          <Text className="request-cta-emoji">🔍</Text>
          <Text className="request-cta-title">没有找到《{kw}》的解析</Text>
          <Text className="request-cta-desc">
            还没人导入该剧本的 DM 主持人手册，发起解析请求后即可在此查看
          </Text>
          <View
            className={`request-btn${submitting ? " is-loading" : ""}`}
            onClick={requestAnalysis}
          >
            <Text className="request-btn-text">
              {submitting ? "提交中…" : `求《${kw}》解析`}
            </Text>
          </View>
        </View>
      ) : null}

      {/* ===== 剧本列表（仅在有结果或无搜索时展示） ===== */}
      {!isSearchEmpty && (loading && scripts.length === 0 ? (
        <View className="lib-tip">加载中…</View>
      ) : scripts.length === 0 && !errorMsg ? (
        <View className="lib-empty">
          <Text className="lib-empty-emoji">📖</Text>
          <Text className="lib-empty-title">暂无已解析剧本</Text>
          <Text className="lib-empty-desc">
            导入 DM 指南并完成解析后，会展示在这里
          </Text>
        </View>
      ) : (
        <View className="lib-list">
          {scripts.map((s) => (
            <View
              key={s.id}
              className="lib-card"
              onClick={() => openDetail(s)}
            >
              {/* 封面：有图用图，否则取标题首字渐变底 */}
              <View className="lib-card-cover">
                <Text className="lib-cover-text">
                  {(s.title || "本")[0]}
                </Text>
              </View>

              <View className="lib-card-body">
                <View className="lib-card-head">
                  <Text className="lib-card-title">
                    {s.title || "未命名剧本"}
                  </Text>
                </View>

                <View className="lib-card-meta">
                  {s.playerText ? (
                    <Text className="lib-meta-item">{s.playerText}</Text>
                  ) : null}
                  {s.durationText ? (
                    <Text className="lib-meta-item">{s.durationText}</Text>
                  ) : null}
                  {s.difficultyLabel ? (
                    <Text className="lib-meta-item">
                      {s.difficultyLabel}
                    </Text>
                  ) : null}
                  {s.author ? (
                    <Text className="lib-meta-item">{s.author}</Text>
                  ) : null}
                </View>

                {/* 标签：玩法 + 题材 */}
                {(s.playstyleLabels?.length || s.themeLabels?.length) ? (
                  <View className="lib-card-tags">
                    {s.playstyleLabels?.map((t) => (
                      <Text key={`ps-${t.code}`} className="lib-tag">
                        {t.label}
                      </Text>
                    ))}
                    {s.themeLabels?.map((t) => (
                      <Text key={`th-${t.code}`} className="lib-tag">
                        {t.label}
                      </Text>
                    ))}
                  </View>
                ) : null}

                {/* 评分 */}
                {s.rating != null && s.rating > 0 ? (
                  <View className="lib-card-rating">
                    <Text className="lib-rating-text">
                      ★ {s.rating.toFixed(1)}
                    </Text>
                    {s.ratingCount ? (
                      <Text className="lib-rating-count">
                        ({s.ratingCount})
                      </Text>
                    ) : null}
                  </View>
                ) : null}
              </View>

              <Text className="lib-card-arrow">&#x203A;</Text>
            </View>
          ))}

          {/* 加载更多 / 到底提示 */}
          {loadingMore ? (
            <View className="lib-tip">加载中…</View>
          ) : hasMore ? (
            <View className="load-more-btn" onClick={handleLoadMore}>
              <Text className="load-more-text">加载更多</Text>
            </View>
          ) : (
            <View className="lib-tip lib-tip-end">没有更多了</View>
          )}
        </View>
      ))}
      {/* ===== 悬浮按钮：求解析榜单 ===== */}
      <View className="board-fab" onClick={openLeaderboard}>
        <Text className="board-fab-icon">🏆</Text>
        <Text className="board-fab-text">求解析榜</Text>
      </View>

      {/* ===== 求解析榜单弹层（按诉求人数降序，越多人求越靠前） ===== */}
      {boardOpen ? (
        <View className="board-overlay">
          <View
            className="board-mask"
            catchMove
            onClick={closeLeaderboard}
          />
          <View className="board-sheet" catchMove>
            <View className="board-head">
              <View className="board-head-left">
                <Text className="board-title">求解析榜单</Text>
                <Text className="board-subtitle">
                  大家最想解析的剧本，越多越靠前
                </Text>
              </View>
              <View className="board-close" onClick={closeLeaderboard}>
                <Text className="board-close-text">✕</Text>
              </View>
            </View>

            <View className="board-body">
              {boardLoading && boardItems.length === 0 ? (
                <View className="board-tip">加载中…</View>
              ) : boardError && boardItems.length === 0 ? (
                <View className="board-empty">
                  <Text className="board-empty-text">{boardError}</Text>
                  <View className="board-retry" onClick={openLeaderboard}>
                    <Text className="board-retry-text">重试</Text>
                  </View>
                </View>
              ) : boardItems.length === 0 ? (
                <View className="board-empty">
                  <Text className="board-empty-emoji">🗳️</Text>
                  <Text className="board-empty-title">还没有求解析诉求</Text>
                  <Text className="board-empty-desc">
                    搜索不到心仪的剧本时，点「求解析」即可上榜
                  </Text>
                </View>
              ) : (
                <View className="board-list">
                  {boardItems.map((it, idx) => (
                    <View
                      key={`${it.scriptId ?? it.scriptTitle}-${idx}`}
                      className={`board-item${
                        it.scriptCode ? " is-clickable" : ""
                      }`}
                      onClick={() => openBoardItem(it)}
                    >
                      <Text
                        className={`board-rank${
                          idx < 3 ? ` is-top${idx + 1}` : ""
                        }`}
                      >
                        {idx + 1}
                      </Text>

                      <View className="board-cover">
                        <Text className="board-cover-text">
                          {(it.scriptTitle || "本")[0]}
                        </Text>
                      </View>

                      <View className="board-item-body">
                        <Text className="board-item-title">
                          {it.scriptTitle || "未命名剧本"}
                        </Text>
                        {!it.scriptCode ? (
                          <Text className="board-item-sub">暂未入库</Text>
                        ) : null}
                      </View>

                      <View className="board-count">
                        <Text className="board-count-num">
                          {it.requestCount}
                        </Text>
                        <Text className="board-count-unit">人求</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export default ScriptLibraryPage;
