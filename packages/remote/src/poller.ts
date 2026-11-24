export interface PollerOptions {
  /** 正常间隔（毫秒） */
  intervalMs: number;
  /** 失败后的首次退避（毫秒），默认 1000 */
  minDelayMs?: number;
  /** 退避上限（毫秒），默认 5 分钟 */
  maxDelayMs?: number;
  /** 抖动比例，0.1 表示 ±10%，默认 0.1 */
  jitter?: number;
  /** 每轮执行的任务；抛错即视为失败 */
  run: () => Promise<unknown>;
  log?: (message: string) => void;
  /** 便于测试：注入随机源（默认 Math.random） */
  random?: () => number;
}

export interface PollerHandle {
  stop(): void;
}

/**
 * 带指数退避 + 抖动的轮询器。
 *
 * - 成功：按 `intervalMs` 调度下一轮（±jitter）；
 * - 失败：`minDelayMs * 2^(n-1)` 递增，封顶 `maxDelayMs`（±jitter），成功一次即复位；
 * - 串行执行：上一轮跑完才调度下一轮，天然不会重叠。
 */
export function startPoller(options: PollerOptions): PollerHandle {
  const {
    intervalMs,
    minDelayMs = 1_000,
    maxDelayMs = 5 * 60_000,
    jitter = 0.1,
    run,
  } = options;
  const log = options.log ?? ((message) => console.log(message));
  const random = options.random ?? Math.random;

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let failures = 0;

  const withJitter = (delay: number): number => {
    const spread = delay * jitter;
    return Math.max(1, Math.round(delay - spread + random() * spread * 2));
  };

  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, delay);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;

    let delay = intervalMs;
    try {
      await run();
      if (failures > 0) log(`[poll] 已恢复，回到 ${intervalMs}ms 间隔`);
      failures = 0;
    } catch (error) {
      failures += 1;
      delay = Math.min(maxDelayMs, minDelayMs * 2 ** (failures - 1));
      log(
        `[poll] 第 ${failures} 次失败，约 ${delay}ms 后重试：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    schedule(withJitter(delay));
  };

  schedule(withJitter(intervalMs));

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
