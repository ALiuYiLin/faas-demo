import type { Registry } from "@faas/core";
import { watchModules } from "./watcher";

export interface HotReloadOptions {
  /** 项目根 */
  root: string;
  /** 热区源码目录 */
  modulesDir: string;
  debounceMs?: number;
}

/**
 * 把文件监听接到 registry 上：变更交给 `registry.applyChange`，
 * 重建/换版/异常兜底都在 core 里（这里只负责"发现变化"）。
 *
 * 返回停止函数。
 */
export function enableHotReload(registry: Registry, options: HotReloadOptions): () => void {
  console.log("[dev] watching modules for changes");
  return watchModules({
    root: options.root,
    dir: options.modulesDir,
    debounceMs: options.debounceMs,
    onChange(relative) {
      void registry.applyChange(relative);
    },
  });
}

export { watchModules } from "./watcher";
