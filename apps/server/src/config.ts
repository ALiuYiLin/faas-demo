import path from "node:path";
import { fileURLToPath } from "node:url";

/** 应用源码目录（apps/server/src），也是 `@/` 别名的根 */
export const APP_SRC = fileURLToPath(new URL(".", import.meta.url));

/** 仓库根目录 */
export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** 热区源码目录 */
export const MODULES_DIR = path.join(APP_SRC, "modules");

/** 构建产物目录（bundle + manifest.json） */
export const DIST_DIR = path.join(ROOT, "dist", "modules");
