import path from "node:path";

/**
 * 配置全部来自环境变量 + cwd，源码运行和打包运行行为一致：
 *
 * | 变量              | 默认值                          | 说明 |
 * | ----------------- | ------------------------------- | ---- |
 * | APP_ROOT          | process.cwd()                   | 部署根目录 |
 * | MODULES_SOURCE    | oss                             | 产物来源：`oss` 拉远端 / `dir` 用本地已有产物 |
 * | MODULES_DIR       | `<ROOT>/apps/server/src/modules`| 热区目录（远端模式下同时是下载缓存目录） |
 * | MODULES_DIST_DIR  | `<ROOT>/dist/modules`           | 产物目录（bundle + manifest.json） |
 * | PROJECT_NAME      | faas-demo                       | OSS key 前缀的第一段 |
 * | OSS_PREFIX        | `<PROJECT_NAME>/modules`        | 覆盖 OSS key 前缀 |
 * | REMOTE_POLL_MS    | 30000                           | 轮询间隔；0 表示只靠 webhook |
 * | ADMIN_TOKEN       | （空）                          | 设置后 `/__admin/*` 需要 Bearer token |
 * | PORT              | 3000                            | |
 * | BASE_PATH         | /api                            | 全局路由前缀 |
 */

/** 项目 / 部署根目录 */
export const ROOT = path.resolve(process.env.APP_ROOT ?? process.cwd());

/** 应用源码目录，也是 compiler 的 `@/` 别名根 */
export const APP_SRC = path.join(ROOT, "apps", "server", "src");

/** 热区目录 */
export const MODULES_DIR = process.env.MODULES_DIR
  ? path.resolve(process.env.MODULES_DIR)
  : path.join(APP_SRC, "modules");

/** 构建产物目录（controller/service bundle + manifest.json） */
export const DIST_DIR = process.env.MODULES_DIST_DIR
  ? path.resolve(process.env.MODULES_DIST_DIR)
  : path.join(ROOT, "dist", "modules");

/** 产物来源 */
export const MODULES_SOURCE: "oss" | "dir" =
  (process.env.MODULES_SOURCE ?? "oss").toLowerCase() === "dir" ? "dir" : "oss";

export const PROJECT_NAME = process.env.PROJECT_NAME ?? "faas-demo";

export const OSS_PREFIX = process.env.OSS_PREFIX ?? `${PROJECT_NAME}/modules`;

export const REMOTE_POLL_MS = Number(process.env.REMOTE_POLL_MS ?? 30_000);

/** 轮询失败后的退避上限（毫秒） */
export const REMOTE_POLL_MAX_MS = Number(process.env.REMOTE_POLL_MAX_MS ?? 300_000);

export const REMOTE_CONCURRENCY = Number(process.env.REMOTE_CONCURRENCY ?? 4);

/** 同步成功后是否清理过期产物 */
export const PRUNE_ON_SYNC = process.env.PRUNE_ON_SYNC !== "false";

/** 本地缓存保留几代（current + N-1） */
export const KEEP_GENERATIONS = Number(process.env.KEEP_GENERATIONS ?? 2);

export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || undefined;

export const PORT = Number(process.env.PORT ?? 3000);

export const BASE_PATH = process.env.BASE_PATH ?? "/api";
