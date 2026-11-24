import type { Manifest } from "@faas/core";
import { watchModules } from "./watcher";

export interface HotReloadOptions {
  /** 项目根 */
  root: string;
  /** 热区源码目录 */
  modulesDir: string;
  debounceMs?: number;
  /** 重新构建并返回新 manifest */
  build: () => Promise<Manifest>;
  /** 把新 manifest 应用到运行时（只重载变化的文件） */
  onManifest: (manifest: Manifest) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

/**
 * 把文件监听接到「构建 + 应用」上。
 * 同一时间只跑一次构建，期间的变更合并成下一轮。
 */
export function enableHotReload(options: HotReloadOptions): () => void {
  let running = false;
  let queued = false;

  const run = async (): Promise<void> => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      const manifest = await options.build();
      await options.onManifest(manifest);
    } catch (error) {
      console.error(
        `[dev] 重建失败，保留当前版本：${error instanceof Error ? error.message : String(error)}`,
      );
      options.onError?.(error);
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void run();
      }
    }
  };

  console.log("[dev] watching modules for changes");
  return watchModules({
    root: options.root,
    dir: options.modulesDir,
    debounceMs: options.debounceMs,
    onChange(relative) {
      console.log(`[dev] 变更 ${relative}`);
      void run();
    },
  });
}

export { watchModules } from "./watcher";
