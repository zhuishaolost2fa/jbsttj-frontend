/**
 * 我的求解析列表 —— 从「剧本库搜索无结果」发起的解析诉求落地页。
 *
 * 数据来自 `GET /scripts/requests/me`（需登录）。后端返回前会先把「剧本已被解析」
 * 的诉求自动流转为 completed，因此 completed 项即表示该剧本已经解析完成，
 * 可点进详情复盘；pending 项可取消（软取消，可再次发起复活）。
 *
 * 交互：顶部分段筛选（全部 / 待解析 / 已完成），下拉刷新，加载更多。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ScrollView } from "@tarojs/components";
import Taro, { useDidShow, usePullDownRefresh } from "@tarojs/taro";
import {
  fetchMyScriptRequests,
  cancelScriptRequest,
  type ScriptRequestItem,
  type ScriptRequestStatus,
} from "../../services/scriptRequest";
import { ApiError } from "../../services/request";
import { goLogin, useAuth } from "../../store/auth";
import "./index.less";

/** 状态徽章的视觉与文案 */
const STATUS_META: Record<
  ScriptRequestStatus,
  { label: string; tone: string }
> = {
  pending: { label: "待解析", tone: "is-pending" },
  completed: { label: "已完成", tone: "is-done" },
  cancelled: { label: "已取消", tone: "is-cancelled" },
};

/** 筛选项：undefined 表示全部 */
type Filter = ScriptRequestStatus | "all";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待解析" },
  { key: "completed", label: "已完成" },
];

function ScriptRequestsPage() {
  const { isAuthenticated, status: authStatus } = useAuth();
  const [items, setItems] = useState<ScriptRequestItem[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");

  const mountedRef = useRef(true);
  /** 请求序号：仅应用最新一次结果，丢弃乱序旧响应 */
  const reqSeq = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadRequests = useCallback(
    async (opts: { reset: boolean; silent?: boolean }) => {
      const seq = ++reqSeq.current;
      const statusParam =
        filter === "all" ? undefined : (filter as ScriptRequestStatus);
      if (opts.reset) {
        if (!opts.silent) setLoading(true);
        setErrorMsg("");
      } else {
        setLoadingMore(true);
      }

      try {
        const res = await fetchMyScriptRequests({
          status: statusParam,
          limit: 20,
          offset: opts.reset ? 0 : items.length,
        });
        if (seq !== reqSeq.current) return;
        if (opts.reset) {
          setItems(res.items);
        } else {
          setItems((prev) => [...prev, ...res.items]);
        }
        setHasMore(res.pagination.hasMore);
        setTotal(res.pagination.total);
      } catch (err) {
        if (seq !== reqSeq.current) return;
        const msg =
          err instanceof ApiError ? err.message : "加载失败，请重试";
        if (opts.reset) setErrorMsg(msg);
        else setErrorMsg("加载更多失败，请重试");
      } finally {
        if (seq !== reqSeq.current) return;
        if (opts.reset) setLoading(false);
        else setLoadingMore(false);
      }
    },
    [filter, items.length]
  );

  // 鉴权就绪后首屏加载
  useEffect(() => {
    if (authStatus === "loading") return;
    if (isAuthenticated) {
      void loadRequests({ reset: true });
    } else {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, authStatus]);

  // 切换筛选：重置列表
  useEffect(() => {
    if (!isAuthenticated) return;
    void loadRequests({ reset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // 每次进入页面刷新：从剧本库发起求解析后跳过来能看到新条目。
  // 首次挂载由上面的鉴权 effect 负责加载，这里只在已有数据时静默刷新，避免重复请求。
  useDidShow(() => {
    if (isAuthenticated && items.length > 0) {
      void loadRequests({ reset: true, silent: true });
    }
  });

  usePullDownRefresh(() => {
    void loadRequests({ reset: true, silent: true }).finally(() =>
      Taro.stopPullDownRefresh()
    );
  });

  const handleLoadMore = useCallback(() => {
    if (loadingMore || !hasMore || loading) return;
    void loadRequests({ reset: false });
  }, [loadingMore, hasMore, loading, loadRequests]);

  /** 取消求解析：二次确认后软取消，本地即刻移除 */
  const handleCancel = useCallback((item: ScriptRequestItem) => {
    Taro.showModal({
      title: "取消求解析",
      content: `确定取消对「${item.scriptTitle}」的求解析吗？之后可再次发起。`,
      confirmText: "取消求解析",
      confirmColor: "#e54d42",
      cancelText: "再想想",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const updated = await cancelScriptRequest(item.id);
          // 软取消：后端返回新状态，按筛选决定是移除还是就地更新
          if (filter === "pending") {
            setItems((prev) => prev.filter((x) => x.id !== item.id));
            setTotal((t) => Math.max(0, t - 1));
          } else {
            setItems((prev) =>
              prev.map((x) => (x.id === item.id ? updated : x))
            );
          }
          Taro.showToast({ title: "已取消", icon: "none" });
        } catch (err) {
          Taro.showToast({
            title: err instanceof ApiError ? err.message : "取消失败，请重试",
            icon: "none",
          });
        }
      },
    });
  }, [filter]);

  /** 打开剧本详情（仅已完成且有关联 code 的剧本可复盘） */
  const openDetail = useCallback((item: ScriptRequestItem) => {
    if (item.status !== "completed" || !item.scriptCode) return;
    Taro.navigateTo({
      url: `/pages/scriptDetail/index?code=${encodeURIComponent(
        item.scriptCode
      )}&title=${encodeURIComponent(item.scriptTitle || "")}`,
    });
  }, []);

  /* ------------------------------ 分支渲染 ------------------------------ */

  if (authStatus === "loading") {
    return (
      <View className="rq-page">
        <View className="page-tip">正在恢复登录状态…</View>
      </View>
    );
  }

  if (!isAuthenticated) {
    return (
      <View className="rq-page">
        <View className="empty-block">
          <Text className="empty-emoji">🔒</Text>
          <Text className="empty-title">登录后查看你的求解析</Text>
          <Text className="empty-desc">发起的解析诉求都挂在你的账号下</Text>
          <View className="empty-btn" onClick={() => goLogin()}>
            <Text className="empty-btn-text">去登录</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View className="rq-page">
      <View className="page-head">
        <Text className="page-title">求解析</Text>
        <Text className="page-count">
          {loading ? "" : total ? `共 ${total} 条` : ""}
        </Text>
      </View>

      {/* 筛选 */}
      <View className="filter-bar">
        {FILTERS.map((f) => (
          <View
            key={f.key}
            className={`filter-chip${filter === f.key ? " is-active" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            <Text className="filter-chip-text">{f.label}</Text>
          </View>
        ))}
      </View>

      {errorMsg ? <View className="page-error">{errorMsg}</View> : null}

      {loading && items.length === 0 ? (
        <View className="page-tip">加载中…</View>
      ) : items.length === 0 && !errorMsg ? (
        <View className="empty-block">
          <Text className="empty-emoji">📝</Text>
          <Text className="empty-title">
            {filter === "pending"
              ? "没有待解析的诉求"
              : filter === "completed"
              ? "还没有已完成的解析"
              : "还没有发起过求解析"}
          </Text>
          <Text className="empty-desc">
            在剧本库搜索不到时，可对心仪的剧本发起求解析
          </Text>
          <View
            className="empty-btn"
            onClick={() => Taro.switchTab({ url: "/pages/scripts/index" })}
          >
            <Text className="empty-btn-text">去剧本库</Text>
          </View>
        </View>
      ) : (
        <ScrollView className="rq-list" scrollY>
          {items.map((it) => {
            const meta = STATUS_META[it.status] ?? STATUS_META.pending;
            const canReview = it.status === "completed" && !!it.scriptCode;
            return (
              <View
                key={it.id}
                className={`rq-card${canReview ? " is-clickable" : ""}`}
                onClick={() => openDetail(it)}
              >
                <View className="card-cover">
                  <Text className="cover-text">
                    {(it.scriptTitle || "本")[0]}
                  </Text>
                </View>

                <View className="card-body">
                  <View className="card-line">
                    <Text className="card-title">
                      {it.scriptTitle || "未命名剧本"}
                    </Text>
                    <Text className={`card-badge ${meta.tone}`}>
                      {meta.label}
                    </Text>
                  </View>

                  {it.reason ? (
                    <Text className="card-reason">{it.reason}</Text>
                  ) : null}

                  <View className="card-meta">
                    {it.createdAt ? (
                      <Text className="meta-item">
                        发起于 {it.createdAt.slice(0, 10)}
                      </Text>
                    ) : null}
                    {canReview ? (
                      <Text className="meta-item is-link">点击复盘 ›</Text>
                    ) : null}
                  </View>
                </View>

                {it.status === "pending" ? (
                  <View
                    className="card-cancel"
                    onClick={(e) => {
                      if (e && typeof e.stopPropagation === "function")
                        e.stopPropagation();
                      handleCancel(it);
                    }}
                  >
                    <Text className="card-cancel-text">取消</Text>
                  </View>
                ) : null}
              </View>
            );
          })}

          {loadingMore ? (
            <View className="page-tip">加载中…</View>
          ) : hasMore ? (
            <View className="load-more-btn" onClick={handleLoadMore}>
              <Text className="load-more-text">加载更多</Text>
            </View>
          ) : (
            <View className="page-tip page-tip-end">没有更多了</View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

export default ScriptRequestsPage;
