import { watch } from "node:fs";
import path from "node:path";

export interface WatchOptions {
  /** 项目根，用于把绝对路径换算成相对路径 */
  root: string;
  /** 被监听的目录 */
  dir: string;
  debounceMs?: number;
  onChange(relative: string): void;
}

/**
 * 监听目录内的 `.ts` 变化，防抖后把「相对项目根的 POSIX 路径」回调出去。
 * 返回停止函数。
 */
export function watchModules(options: WatchOptions): () => void {
  const { root, dir, debounceMs = 200, onChange } = options;
  let timer: NodeJS.Timeout | undefined;
  const pending = new Set<string>();

  const watcher = watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    // 忽略编辑器临时文件（.xxx.tmpdir、xxx.ts~RF123.TMP）和目录事件
    const name = filename.toString();
    const base = path.basename(name);
    if (!base.endsWith(".ts") || base.startsWith(".") || base.includes("~")) return;

    const absolute = path.join(dir, name);
    pending.add(path.relative(root, absolute).replace(/\\/g, "/"));

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const changes = [...pending];
      pending.clear();
      for (const relative of changes) onChange(relative);
    }, debounceMs);
  });

  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
