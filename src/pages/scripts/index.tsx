/**
 * 剧本库 —— 浏览所有已上架剧本，支持多维度筛选。
 *
 * 替代原先的「我的剧本」tab：原先占了一个 tab 位但只服务已登录用户看自己导入的剧本，
 * 现在中间 tab 改成全量剧本库（公开可浏览），「我的剧本」收纳到「我的」页面入口下。
 *
 * 筛选 UX 设计原则：**直接点击，不藏抽屉**。
 *   - 排序：横向滚动 chip 行，一点即切
 *   - 玩法 / 题材 / 难度：多选 chip，横向滚动，点击即筛选
 *   - 人数：单选 chip（后端 players 参数只接受一个值）
 *   - 搜索框：防抖 350ms 自动触发
 *   - 已选筛选项汇总条，支持逐个移除和一键清空
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ScrollView } from "@tarojs/components";
import Taro, { usePullDownRefresh } from "@tarojs/taro";
import { SearchBar } from "@nutui/nutui-react-taro";
import {
  fetchScriptList,
  fetchScriptOptions,
  type ScriptItemCamel,
  type ScriptOptionGroup,
  type ScriptSort,
  type ScriptListQuery,
} from "../../services/script";
import { ApiError } from "../../services/request";
import "./index.less";

/** 排序选项（与后端 SORTS 白名单一致） */
const SORT_OPTIONS: { code: ScriptSort; label: string }[] = [
  { code: "hot", label: "热门" },
  { code: "rating", label: "评分" },
  { code: "newest", label: "最新" },
  { code: "year", label: "年份" },
  { code: "title", label: "名称" },
];

/** 防抖延迟：搜索框输入停下后多久触发查询 */
const DEBOUNCE_MS = 350;

function ScriptLibraryPage() {
  /* ----------------------------- 筛选状态 ----------------------------- */
  const [keyword, setKeyword] = useState("");
  const [sort, setSort] = useState<ScriptSort>("hot");
  const [playstyles, setPlaystyles] = useState<string[]>([]);
  const [themes, setThemes] = useState<string[]>([]);
  const [difficulties, setDifficulties] = useState<string[]>([]);
  const [players, setPlayers] = useState<number | undefined>(undefined);

  /* ----------------------------- 字典维度 ----------------------------- */
  const [optionGroups, setOptionGroups] = useState<ScriptOptionGroup[]>([]);

  /* ----------------------------- 列表状态 ----------------------------- */
  const [scripts, setScripts] = useState<ScriptItemCamel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");

  /* ----------------------------- 控制标志 ----------------------------- */
  const mountedRef = useRef(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 请求序号：仅应用最新一次的结果，丢弃乱序的旧响应 */
  const reqSeq = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ---------- 字典维度：首屏拉一次，筛选项直接从里面取 ---------- */
  useEffect(() => {
    fetchScriptOptions()
      .then((tree) => {
        if (mountedRef.current) setOptionGroups(tree.categories);
      })
      .catch(() => {
        // 字典拉不到也不阻断列表加载，筛选项只是不渲染
      });
  }, []);

  const playstyleGroup = optionGroups.find((g) => g.code === "playstyle");
  const themeGroup = optionGroups.find((g) => g.code === "theme");
  const difficultyGroup = optionGroups.find((g) => g.code === "difficulty");
  const playerCountGroup = optionGroups.find(
    (g) => g.code === "player_count"
  );

  /* ---------- 构建查询参数 ---------- */
  const buildQuery = useCallback((): ScriptListQuery => {
    const q: ScriptListQuery = { sort };
    if (keyword.trim()) q.keyword = keyword.trim();
    if (playstyles.length) q.playstyles = playstyles;
    if (themes.length) q.themes = themes;
    if (difficulties.length) q.difficulties = difficulties;
    if (players != null) q.players = players;
    return q;
  }, [keyword, sort, playstyles, themes, difficulties, players]);

  /* ---------- 加载剧本列表 ---------- */
  const loadScripts = useCallback(
    async (reset: boolean) => {
      const seq = ++reqSeq.current;
      if (reset) {
        setLoading(true);
        setErrorMsg("");
      } else {
        setLoadingMore(true);
      }

      try {
        const baseQuery = buildQuery();
        const res = await fetchScriptList({
          ...baseQuery,
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
        if (reset) setLoading(false);
        else setLoadingMore(false);
      }
    },
    [buildQuery, scripts.length]
  );

  /* ---------- 筛选条件变化时防抖触发查询 ---------- */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void loadScripts(true);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, sort, playstyles, themes, difficulties, players]);

  /* ---------- 下拉刷新 ---------- */
  usePullDownRefresh(() => {
    void loadScripts(true).finally(() => Taro.stopPullDownRefresh());
  });

  /* ---------- 加载更多 ---------- */
  const handleLoadMore = useCallback(() => {
    if (loadingMore || !hasMore || loading) return;
    void loadScripts(false);
  }, [loadingMore, hasMore, loading, loadScripts]);

  /* ---------- 多选切换 ---------- */
  const toggleArray = useCallback(
    (setter: (fn: (prev: string[]) => string[]) => void) =>
      (code: string) => {
        setter((prev) =>
          prev.includes(code)
            ? prev.filter((c) => c !== code)
            : [...prev, code]
        );
      },
    []
  );
  const togglePlaystyle = toggleArray(setPlaystyles);
  const toggleTheme = toggleArray(setThemes);
  const toggleDifficulty = toggleArray(setDifficulties);

  /* ---------- 单选切换（人数：后端只接受一个 players 值） ---------- */
  const togglePlayers = useCallback((val: number) => {
    setPlayers((prev) => (prev === val ? undefined : val));
  }, []);

  /* ---------- 清空全部筛选 ---------- */
  const clearAll = useCallback(() => {
    setKeyword("");
    setPlaystyles([]);
    setThemes([]);
    setDifficulties([]);
    setPlayers(undefined);
    setSort("hot");
  }, []);

  const hasActiveFilters =
    !!keyword.trim() ||
    playstyles.length > 0 ||
    themes.length > 0 ||
    difficulties.length > 0 ||
    players != null;

  /* ---------- 打开剧本详情 ---------- */
  const openDetail = useCallback((s: ScriptItemCamel) => {
    Taro.navigateTo({
      url: `/pages/scriptDetail/index?code=${encodeURIComponent(
        s.code
      )}&title=${encodeURIComponent(s.title || "")}`,
    });
  }, []);

  /* ---------- 已选项汇总：逐个可移除 ---------- */
  const activeChips: { label: string; onRemove: () => void }[] = [];
  if (keyword.trim())
    activeChips.push({
      label: `"${keyword.trim()}"`,
      onRemove: () => setKeyword(""),
    });
  playstyles.forEach((code) => {
    const opt = playstyleGroup?.options.find((o) => o.code === code);
    if (opt)
      activeChips.push({
        label: opt.label,
        onRemove: () => togglePlaystyle(code),
      });
  });
  themes.forEach((code) => {
    const opt = themeGroup?.options.find((o) => o.code === code);
    if (opt)
      activeChips.push({
        label: opt.label,
        onRemove: () => toggleTheme(code),
      });
  });
  difficulties.forEach((code) => {
    const opt = difficultyGroup?.options.find((o) => o.code === code);
    if (opt)
      activeChips.push({
        label: opt.label,
        onRemove: () => toggleDifficulty(code),
      });
  });
  if (players != null) {
    const opt = playerCountGroup?.options.find(
      (o) => o.minValue === players
    );
    if (opt)
      activeChips.push({
        label: opt.label,
        onRemove: () => setPlayers(undefined),
      });
  }

  /* ------------------------------ 渲染 ------------------------------ */
  return (
    <View className="library-page">
      {/* ===== 搜索框（sticky） ===== */}
      <View className="lib-search">
        <SearchBar
          value={keyword}
          placeholder="搜索剧本名、作者…"
          shape="round"
          onChange={(v: string) => setKeyword(v)}
          onClear={() => setKeyword("")}
        />
      </View>

      {/* ===== 排序 ===== */}
      <ScrollView scrollX className="sort-row" >
        {SORT_OPTIONS.map((opt) => (
          <View
            key={opt.code}
            className={`sort-chip ${sort === opt.code ? "is-active" : ""}`}
            onClick={() => setSort(opt.code)}
          >
            {opt.label}
          </View>
        ))}
      </ScrollView>

      {/* ===== 筛选维度 ===== */}
      <View className="filter-section">
        {playstyleGroup ? (
          <View className="filter-row">
            <Text className="filter-label">玩法</Text>
            <ScrollView scrollX className="filter-chips" >
              {playstyleGroup.options.map((opt) => (
                <View
                  key={opt.code}
                  className={`f-chip ${
                    playstyles.includes(opt.code) ? "is-active" : ""
                  }`}
                  onClick={() => togglePlaystyle(opt.code)}
                >
                  {opt.label}
                </View>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {themeGroup ? (
          <View className="filter-row">
            <Text className="filter-label">题材</Text>
            <ScrollView scrollX className="filter-chips" >
              {themeGroup.options.map((opt) => (
                <View
                  key={opt.code}
                  className={`f-chip ${
                    themes.includes(opt.code) ? "is-active" : ""
                  }`}
                  onClick={() => toggleTheme(opt.code)}
                >
                  {opt.label}
                </View>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {difficultyGroup ? (
          <View className="filter-row">
            <Text className="filter-label">难度</Text>
            <ScrollView scrollX className="filter-chips" >
              {difficultyGroup.options.map((opt) => (
                <View
                  key={opt.code}
                  className={`f-chip ${
                    difficulties.includes(opt.code) ? "is-active" : ""
                  }`}
                  onClick={() => toggleDifficulty(opt.code)}
                >
                  {opt.label}
                </View>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {playerCountGroup ? (
          <View className="filter-row">
            <Text className="filter-label">人数</Text>
            <ScrollView scrollX className="filter-chips" >
              {playerCountGroup.options.map((opt) => (
                <View
                  key={opt.code}
                  className={`f-chip ${
                    players === opt.minValue ? "is-active" : ""
                  }`}
                  onClick={() =>
                    opt.minValue != null && togglePlayers(opt.minValue)
                  }
                >
                  {opt.label}
                </View>
              ))}
            </ScrollView>
          </View>
        ) : null}
      </View>

      {/* ===== 已选筛选汇总条 ===== */}
      {hasActiveFilters ? (
        <View className="active-bar">
          <ScrollView scrollX className="active-chips" >
            {activeChips.map((chip, i) => (
              <View key={i} className="active-chip" onClick={chip.onRemove}>
                <Text className="active-chip-text">{chip.label}</Text>
                <Text className="active-chip-x">✕</Text>
              </View>
            ))}
          </ScrollView>
          <View className="clear-all-btn" onClick={clearAll}>
            <Text className="clear-all-text">清除</Text>
          </View>
        </View>
      ) : null}

      {/* ===== 结果计数 ===== */}
      <View className="result-info">
        {loading ? (
          <Text className="result-count">加载中…</Text>
        ) : (
          <Text className="result-count">
            共 {total} 个剧本
          </Text>
        )}
      </View>

      {/* ===== 错误提示 ===== */}
      {errorMsg && !loading ? (
        <View className="page-error">{errorMsg}</View>
      ) : null}

      {/* ===== 剧本列表 ===== */}
      {loading && scripts.length === 0 ? (
        <View className="lib-tip">加载中…</View>
      ) : scripts.length === 0 && !errorMsg ? (
        <View className="lib-empty">
          <Text className="lib-empty-emoji">🔍</Text>
          <Text className="lib-empty-title">
            {hasActiveFilters ? "没有匹配的剧本" : "暂无剧本"}
          </Text>
          <Text className="lib-empty-desc">
            {hasActiveFilters ? "试试调整或清除筛选条件" : "后续会持续更新剧本库"}
          </Text>
          {hasActiveFilters ? (
            <View className="lib-empty-btn" onClick={clearAll}>
              <Text className="lib-empty-btn-text">清除筛选</Text>
            </View>
          ) : null}
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
                  {s.hasGuide ? (
                    <Text className="lib-badge-imported">已导入</Text>
                  ) : null}
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
      )}
    </View>
  );
}

export default ScriptLibraryPage;
