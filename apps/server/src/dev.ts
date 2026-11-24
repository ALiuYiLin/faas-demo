import { createCompiler } from "@faas/compiler";
import { Registry } from "@faas/core";
import { enableHotReload } from "@faas/dev";
import { APP_SRC, DIST_DIR, MODULES_DIR, ROOT } from "./config";
import { startServer } from "./server";

// 开发入口：构建 + 注入 builder + 监听热区，不打包（直接跑源码）。

process.on("unhandledRejection", (reason) => {
  console.error("[app] 未处理的 Promise 拒绝:", reason);
});

const compiler = createCompiler({
  root: ROOT,
  modulesDir: MODULES_DIR,
  distDir: DIST_DIR,
  aliases: { "@": APP_SRC },
});

// 启动时按源码全量重建，不能信任磁盘上的旧 manifest
const manifest = await compiler.buildAll();

const registry = new Registry({
  root: ROOT,
  modulesDir: MODULES_DIR,
  distDir: DIST_DIR,
  builder: compiler,
});
await registry.loadAll(manifest);

console.log(`[app] root=${ROOT}`);
console.log(`[app] modules=${MODULES_DIR}`);
console.log(`[app] dist=${DIST_DIR}`);

startServer(registry);
enableHotReload(registry, { root: ROOT, modulesDir: MODULES_DIR });
