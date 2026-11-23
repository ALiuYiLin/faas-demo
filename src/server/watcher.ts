import { watch } from "node:fs";
import path from "node:path";
import { MODULES, ROOT, toPosix } from "@/paths";

/**
 * 监听热区文件变化，200ms 防抖后把「相对项目根」的路径回传。
 * 返回一个停止函数。
 */
export function watchModules(onChange: (relative: string) => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Set<string>();

  const watcher = watch(MODULES, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    // 忽略编辑器临时文件（.xxx.tmpdir、xxx.ts~RF123.TMP）和目录事件
    const name = filename.toString();
    const base = path.basename(name);
    if (!base.endsWith(".ts") || base.startsWith(".") || base.includes("~")) return;

    const absolute = path.join(MODULES, name);
    pending.add(toPosix(path.relative(ROOT, absolute)));

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const changes = [...pending];
      pending.clear();
      for (const relative of changes) onChange(relative);
    }, 200);
  });

  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
