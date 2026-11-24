import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Manifest } from "@faas/core";

export interface PruneOptions {
  distDir: string;
  /** 这些 manifest 引用的产物都要保留（通常是 current + previous） */
  keepManifests: Manifest[];
}

export interface PruneResult {
  removed: string[];
  bytes: number;
}

/**
 * 清理本地缓存里的过期产物。
 *
 * 只动 `controller/`、`service/` 下的文件，且只删 `.js` 产物和残留的 `.tmp`：
 * `manifest.json`、`manifest.prev.json`、`.etag` 永远不会被碰到。
 */
export async function pruneDistDir(options: PruneOptions): Promise<PruneResult> {
  const keep = new Set<string>();
  for (const manifest of options.keepManifests) {
    for (const info of [
      ...Object.values(manifest.controllers),
      ...Object.values(manifest.services),
    ]) {
      keep.add(info.file);
    }
  }

  const result: PruneResult = { removed: [], bytes: 0 };

  for (const kind of ["controller", "service"] as const) {
    const dir = path.join(options.distDir, kind);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (!name.endsWith(".js") && !name.endsWith(".tmp")) continue;

      const relative = `${kind}/${name}`;
      if (keep.has(relative)) continue;

      const full = path.join(dir, name);
      try {
        const info = await stat(full);
        if (!info.isFile()) continue;
        await rm(full, { force: true });
        result.removed.push(relative);
        result.bytes += info.size;
      } catch {
        // 单个文件删不掉不影响其它
      }
    }
  }

  return result;
}
