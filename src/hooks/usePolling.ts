import { useEffect, useRef } from "react";

export interface PollingOptions {
  /** 是否处于轮询条件（如还有未到终态的任务）。为 false 时彻底停表并清零失败计数 */
  active: boolean;
  /** 轮询间隔（毫秒） */
  interval: number;
  /**
   * 单次轮询要执行的异步任务。
   * - resolve（含返回 true / void）→ 视为成功，连续失败计数清零
   * - 显式返回 false → 视为本次失败，连续失败计数 +1
   * - reject → 视为本次失败，连续失败计数 +1
   * 达到 maxConsecutiveFailures 后停止轮询，不再调用 task。
   */
  task: () => Promise<void | boolean>;
  /** 连续失败达到该次数后停止轮询（默认 3） */
  maxConsecutiveFailures?: number;
  /** 可见性开关，默认 true；为 false 时暂停轮询（不计入失败） */
  visible?: boolean;
  /** 连续失败达到上限、决定放弃轮询时回调一次，可用于提示用户 */
  onGiveUp?: () => void;
}

/**
 * 受限轮询：仅在 `active && visible` 时周期性执行 `task`。
 * `task` 连续失败 `maxConsecutiveFailures` 次后自动停表，避免对挂掉的后端空转烧流量。
 * 成功一次即清零失败计数；`active` / `visible` 任意一方变化都会重置计数并尝试恢复。
 */
export function usePolling({
  active,
  interval,
  task,
  maxConsecutiveFailures = 3,
  visible = true,
  onGiveUp,
}: PollingOptions) {
  const taskRef = useRef(task);
  taskRef.current = task;
  const onGiveUpRef = useRef(onGiveUp);
  onGiveUpRef.current = onGiveUp;

  const failCountRef = useRef(0);
  const stoppedRef = useRef(false);

  // `active` / `visible` 任一变化意味着「轮询条件」变了：清零失败计数、解除停表，给后端一次机会
  useEffect(() => {
    failCountRef.current = 0;
    stoppedRef.current = false;
  }, [active, visible]);

  useEffect(() => {
    if (!active || !visible || stoppedRef.current) return;

    const id = setInterval(async () => {
      if (stoppedRef.current) return;
      let ok = true;
      try {
        const result = await taskRef.current();
        // 显式返回 false 视为本次失败；void / true 视为成功
        if (result === false) ok = false;
      } catch {
        ok = false;
      }
      if (ok) {
        failCountRef.current = 0;
        return;
      }
      failCountRef.current += 1;
      if (failCountRef.current >= maxConsecutiveFailures) {
        stoppedRef.current = true;
        clearInterval(id);
        onGiveUpRef.current?.();
      }
    }, interval);

    return () => clearInterval(id);
  }, [active, visible, interval, maxConsecutiveFailures]);
}
