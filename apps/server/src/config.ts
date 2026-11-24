import path from "node:path";

/**
 * 配置全部来自环境变量 + cwd，源码运行和打包运行行为一致：
 *
 * | 变量              | 默认值                          | 说明 |
 * | ----------------- | ------------------------------- | ---- |
 * | APP_ROOT          | process.cwd()                   | 部署根目录 |
 * | MODULES_DIR       | `<ROOT>/apps/server/src/modules`| 热区源码目录（部署时指到实际位置） |
 * | MODULES_DIST_DIR  | `<ROOT>/dist/modules`           | 产物目录（bundle + manifest.json） |
 * | PORT              | 3000                            | |
 * | BASE_PATH         | /api                            | 全局路由前缀 |
 */

/** 项目 / 部署根目录 */
export const ROOT = path.resolve(process.env.APP_ROOT ?? process.cwd());

/** 应用源码目录，也是 compiler 的 `@/` 别名根 */
export const APP_SRC = path.join(ROOT, "apps", "server", "src");

/** 热区源码目录 */
export const MODULES_DIR = process.env.MODULES_DIR
  ? path.resolve(process.env.MODULES_DIR)
  : path.join(APP_SRC, "modules");

/** 构建产物目录（controller/service bundle + manifest.json） */
export const DIST_DIR = process.env.MODULES_DIST_DIR
  ? path.resolve(process.env.MODULES_DIST_DIR)
  : path.join(ROOT, "dist", "modules");

export const PORT = Number(process.env.PORT ?? 3000);

export const BASE_PATH = process.env.BASE_PATH ?? "/api";
