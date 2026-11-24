import { createCompiler } from "@faas/compiler";
import { Registry } from "@faas/core";
import { enableHotReload } from "@faas/dev";
import { DIST_DIR, MODULES_DIR, ROOT } from "./config";
import { startServer } from "./server";

// 开发入口：逐文件编译 + 文件级热更，不打包。

process.on("unhandledRejection", (reason) => {
  console.error("[app] 未处理的 Promise 拒绝:", reason);
});

const compiler = createCompiler({ root: ROOT, modulesDir: MODULES_DIR, distDir: DIST_DIR });

// 启动时全量编译一次（不能信任磁盘上的旧产物）
const manifest = await compiler.buildAll();

const registry = new Registry({ root: ROOT, modulesDir: MODULES_DIR, distDir: DIST_DIR });
await registry.loadAll(manifest);

console.log(`[app] root=${ROOT}`);
console.log(`[app] modules=${MODULES_DIR}`);
console.log(`[app] dist=${DIST_DIR}`);

startServer(registry);

enableHotReload({
  root: ROOT,
  modulesDir: MODULES_DIR,
  build: () => compiler.buildAll(),
  onManifest: (next) => registry.applyManifest(next),
});
