import { fileURLToPath } from "node:url";
import path from "node:path";

/** 项目根目录 */
export const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** src 目录 */
export const SRC = fileURLToPath(new URL(".", import.meta.url));
/** 热区（可热加载的业务模块） */
export const MODULES = path.join(SRC, "modules");
/** 构建产物目录 */
export const DIST = path.join(ROOT, "dist", "modules");
/** manifest 路径 */
export const MANIFEST = path.join(DIST, "manifest.json");

/** Windows 路径转正斜杠，manifest 里的 key 统一用 POSIX 形式 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** `@faas/runtime` 是模块唯一允许的运行时依赖，构建期 external */
export const RUNTIME_MODULE = "@faas/runtime";
