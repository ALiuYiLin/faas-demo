import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "rollup";
import { RUNTIME_MODULE } from "@faas/core";

const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js"];

/** 探测 `.ts` / `.tsx` / `.js` / 目录 index */
export async function resolveFile(target: string): Promise<string | null> {
  const candidates = [
    ...RESOLVE_SUFFIXES.map((suffix) => target + suffix),
    ...RESOLVE_SUFFIXES.slice(1).map((suffix) => path.join(target, `index${suffix}`)),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // 不存在，继续
    }
  }
  return null;
}

/**
 * 构建期解析规则：
 * - `@faas/runtime` → external（运行期由沙箱映射回宿主实例）
 * - 别名（如 `@/x`）→ 配置里的目录
 * - 相对路径 → importer 所在目录
 * - 其它裸模块 → external（交给宿主 require）
 */
export function createResolvePlugin(
  entry: string,
  aliases: Record<string, string>,
  modules: Set<string>,
): Plugin {
  return {
    name: "faas:resolve",
    async resolveId(id, importer) {
      if (id === entry) return entry;
      if (id === RUNTIME_MODULE) return { id, external: true };

      for (const [alias, target] of Object.entries(aliases)) {
        if (id === alias) return resolveFile(target);
        const prefix = alias.endsWith("/") ? alias : `${alias}/`;
        if (id.startsWith(prefix)) {
          return resolveFile(path.join(target, id.slice(prefix.length)));
        }
      }

      if (id.startsWith(".")) {
        if (!importer) return null;
        return resolveFile(path.resolve(path.dirname(importer), id));
      }

      return { id, external: true };
    },
    async load(id) {
      if (!path.isAbsolute(id)) return null;
      try {
        return await readFile(id, "utf8");
      } catch {
        return null;
      }
    },
    /** 收集真正进了 bundle 的模块（含传递依赖），用于依赖指纹 */
    buildEnd() {
      for (const id of this.getModuleIds()) {
        if (path.isAbsolute(id)) modules.add(id);
      }
    },
  };
}
