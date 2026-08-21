/**
 * 我的剧本 —— 导入结果与解析状态的落地页（从 tab 收纳到「我的」入口下）。
 *
 * 剧本从「导入手册」到「能问答」中间隔着一条十几分钟的异步流水线，
 * 用户点完提交就没下文了显然不行。这个页面回答两个问题：
 * 我导过哪些本、每个本现在到哪一步了。
 *
 * 状态数据来自 `GET /scripts/import-status` 批量接口（三阶段归一）。
 * **受限轮询**：进入页面先拉一次，只有当还有本处于「解析中 / 上传中 / 待解析」
 * 时才起 5 秒轮询，全部落定后立即停表；页面隐藏也立刻暂停，
 * 避免后台空转烧流量。需要手动刷新就下拉。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, ScrollView } from "@tarojs/components";
import Taro, { useDidShow, useDidHide, usePullDownRefresh } from "@tarojs/taro";
import {
  fetchMyScripts,
  deleteScript,
  type ScriptItemCamel,
} from "../../services/script";
import {
  fetchImportStatusBatch,
  isTerminalStatus,
  resolveJobProgress,
  OVERALL_STATUS_TEXT,
  type ImportStatus,
} from "../../services/dmGuide";
import { ApiError } from "../../services/request";
import { goLogin, useAuth } from "../../store/auth";
import { usePolling } from "../../hooks/usePolling";
import "./index.less";

/** 状态徽章的视觉分组 */
const STATUS_TONE: Record<string, string> = {
  ready: "is-ready",
  parsing: "is-parsing",
  uploading: "is-parsing",
  pending: "is-idle",
  no_guide: "is-idle",
  failed: "is-failed",
};

/** 轮询间隔：解析动辄十几分钟，5 秒一次足够跟上，也不至于把后端问烦 */
const POLL_INTERVAL = 5000;

function MyScriptsPage() {
  const { isAuthenticated, status: authStatus } = useAuth();
  const [scripts, setScripts] = useState<ScriptItemCamel[]>([]);
  const [statusMap, setStatusMap] = useState<Record<string, ImportStatus>>({});
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  /** 页面是否可见：navigateBack 回来时刷新，离开时暂停轮询 */
  const [visible, setVisible] = useState(true);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * 批量拉取剧本导入状态 —— 一次请求拿回所有本，替代逐本调 import-status。
   * 只查「已关联手册」的本（hasGuide=false 永远是 no_guide，无需轮询）；
   * 批量接口内部对失败条目静默跳过，这里整批失败也不让列表变红（卡片退化为「状态未知」）。
   */
  const loadStatuses = useCallback(
    async (list: ScriptItemCamel[]): Promise<boolean> => {
      const targets = list.filter((s) => s.id && s.hasGuide);
      if (!targets.length) return true;

      try {
        const map = await fetchImportStatusBatch(targets.map((s) => s.id));
        if (!mountedRef.current) return false;
        setStatusMap((prev) => ({ ...prev, ...map }));
        return true;
      } catch {
        // 批量状态接口异常不该让整个列表变红 —— 卡片会保持上一次的状态或退化成「状态未知」
        // 但需返回 false，让 usePolling 计入连续失败、触发「三次失败停表」
        return false;
      }
    },
    []
  );

  const loadScripts = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setLoading(true);
      setErrorMsg("");
      try {
        const res = await fetchMyScripts({ sort: "newest", limit: 30 });
        if (!mountedRef.current) return;
        setScripts(res.items);
        await loadStatuses(res.items);
      } catch (err) {
        if (!mountedRef.current) return;
        const msg =
          err instanceof ApiError ? err.message : "加载失败，请下拉重试";
        setErrorMsg(msg);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [loadStatuses]
  );

  // 每次进入页面都刷新：从导入流程回来时能立刻看到新剧本。
  useDidShow(() => {
    setVisible(true);
    if (isAuthenticated) void loadScripts({ silent: scripts.length > 0 });
  });

  // 离开页面（navigateBack / 切到别的页面）时暂停轮询。
  useDidHide(() => {
    setVisible(false);
  });

  useEffect(() => {
    if (isAuthenticated) void loadScripts();
    else setLoading(false);
  }, [isAuthenticated, loadScripts]);

  // 下拉刷新：手动拉取最新导入状态
  usePullDownRefresh(() => {
    void loadScripts({ silent: true }).finally(() =>
      Taro.stopPullDownRefresh()
    );
  });

  /* 受限轮询：只有还存在「解析中 / 上传中 / 待解析」的本时才起表，
     全部落定后立即停掉；页面隐藏时也立刻暂停。
     轮询接口连续失败 3 次即停表（后端挂了就不再空转烧流量），用户可下拉重试。 */
  const pending = scripts.filter((s) => {
    const st = statusMap[s.id]?.overallStatus;
    return st != null && !isTerminalStatus(st);
  });

  usePolling({
    active: pending.length > 0,
    visible,
    interval: POLL_INTERVAL,
    task: () => loadStatuses(pending),
    onGiveUp: () =>
      setErrorMsg("状态刷新已停止（连续多次失败），请下拉重试"),
  });

  const openDetail = (s: ScriptItemCamel) => {
    Taro.navigateTo({
      url: `/pages/scriptDetail/index?code=${encodeURIComponent(
        s.code
      )}&title=${encodeURIComponent(s.title || "")}`,
    });
  };

  /** 删除剧本：先二次确认，避免手滑误删（删除不可逆，索引一并清掉） */
  const handleDelete = useCallback((s: ScriptItemCamel) => {
    Taro.showModal({
      title: "删除剧本",
      content: `确定删除「${
        s.title || "未命名剧本"
      }」吗？删除后无法恢复，关联的 DM 手册索引也会一起清除。`,
      confirmText: "删除",
      confirmColor: "#e54d42",
      cancelText: "取消",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await deleteScript(s.id);
          // 本地即刻移除，不必等下一次刷新
          setScripts((prev) => prev.filter((x) => x.id !== s.id));
          setStatusMap((prev) => {
            const next = { ...prev };
            delete next[s.id];
            return next;
          });
          Taro.showToast({ title: "已删除", icon: "success" });
        } catch (err) {
          Taro.showToast({
            title: err instanceof ApiError ? err.message : "删除失败，请重试",
            icon: "none",
          });
        }
      },
    });
  }, []);

  /* ------------------------------ 分支渲染 ------------------------------ */

  if (authStatus === "loading") {
    return (
      <View className="scripts-page">
        <View className="page-tip">正在恢复登录状态…</View>
      </View>
    );
  }

  if (!isAuthenticated) {
    return (
      <View className="scripts-page">
        <View className="empty-block">
          <Text className="empty-emoji">🔒</Text>
          <Text className="empty-title">登录后查看我导入的剧本</Text>
          <Text className="empty-desc">剧本与解析进度都挂在你的账号下</Text>
          <View className="empty-btn" onClick={() => goLogin()}>
            <Text className="empty-btn-text">去登录</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View className="scripts-page">
      <View className="page-head">
        <Text className="page-title">我的剧本</Text>
        <Text className="page-count">
          {scripts.length ? `共 ${scripts.length} 本` : ""}
        </Text>
      </View>

      {errorMsg ? <View className="page-error">{errorMsg}</View> : null}

      {loading && !scripts.length ? (
        <View className="page-tip">加载中…</View>
      ) : null}

      {!loading && !scripts.length && !errorMsg ? (
        <View className="empty-block">
          <Text className="empty-emoji">📥</Text>
          <Text className="empty-title">还没有导入过剧本</Text>
          <Text className="empty-desc">导入 DM 手册后，这里会显示解析进度</Text>
          <View
            className="empty-btn"
            onClick={() => Taro.switchTab({ url: "/pages/index/index" })}
          >
            <Text className="empty-btn-text">去导入</Text>
          </View>
        </View>
      ) : null}

      <ScrollView className="script-list" scrollY>
        {scripts.map((s) => {
          const st = statusMap[s.id];
          const overall =
            st?.overallStatus ?? (s.hasGuide ? "pending" : "no_guide");
          const tone = STATUS_TONE[overall] ?? "is-idle";
          const job = (st?.dmGuide as any)?.job;
          const isParsing = overall === "parsing" || overall === "uploading";
          const jobProg = resolveJobProgress(job);

          return (
            <View
              className="script-card"
              key={s.id}
              onClick={() => openDetail(s)}
            >
              <View className="card-cover">
                <Text className="cover-text">{(s.title || "本")[0]}</Text>
              </View>

              <View className="card-body">
                <View className="card-line">
                  <Text className="card-title">{s.title || "未命名剧本"}</Text>
                  <Text className={`card-badge ${tone}`}>
                    {OVERALL_STATUS_TEXT[overall] ?? overall}
                  </Text>
                </View>

                <View className="card-meta">
                  {s.playerText ? (
                    <Text className="meta-item">{s.playerText}</Text>
                  ) : null}
                  {s.durationText ? (
                    <Text className="meta-item">{s.durationText}</Text>
                  ) : null}
                  {s.status === "draft" ? (
                    <Text className="meta-item is-draft">草稿</Text>
                  ) : null}
                  {!s.playerText && !s.durationText && s.author ? (
                    <Text className="meta-item">{s.author}</Text>
                  ) : null}
                </View>

                {/* 解析中：展示当前阶段 + 阶段内子进度。
                    刻意不做全局百分比 —— 各阶段耗时差两个数量级，插值出来的数字会卡死不动 */}
                {isParsing ? (
                  <View className="card-progress">
                    <View className="progress-track">
                      <View
                        className={`progress-fill${
                          jobProg.indeterminate ? " is-indeterminate" : ""
                        }`}
                        style={{
                          width: jobProg.indeterminate
                            ? "0%"
                            : `${Math.max(jobProg.percent, 4)}%`,
                        }}
                      />
                    </View>
                    <Text className="progress-text">
                      {jobProg.text || "解析中"}
                    </Text>
                  </View>
                ) : null}

                {overall === "failed" ? (
                  <Text className="card-error">
                    {job?.errorMessage || "解析失败，进入详情可重试"}
                  </Text>
                ) : null}

                {overall === "ready" ? (
                  <Text className="card-ready">已建索引 · 点击开始提问</Text>
                ) : null}

                {overall === "no_guide" ? (
                  <Text className="card-hint">未关联 DM 手册，无法问答</Text>
                ) : null}
              </View>

              <View
                className="card-del"
                onClick={(e) => {
                  // 阻止冒泡，避免误触打开详情
                  if (e && typeof e.stopPropagation === "function")
                    e.stopPropagation();
                  handleDelete(s);
                }}
              >
                <Text className="card-del-icon">🗑</Text>
              </View>
              <Text className="card-arrow">&#x203A;</Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

export default MyScriptsPage;
