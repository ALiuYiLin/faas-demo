import { createCompiler } from "@faas/compiler";
import { createApp, createManifestStore, Registry } from "@faas/core";
import { enableHotReload } from "@faas/dev";
import { APP_SRC, DIST_DIR, MODULES_DIR, ROOT } from "./config";

// 平台的底线：任何模块层面的异常都不能把进程带走
process.on("unhandledRejection", (reason) => {
  console.error("[app] 未处理的 Promise 拒绝:", reason);
});

const port = Number(process.env.PORT ?? 3000);
const basePath = process.env.BASE_PATH ?? "/api";
const watching = process.env.WATCH !== "0";

const compiler = createCompiler({
  root: ROOT,
  modulesDir: MODULES_DIR,
  distDir: DIST_DIR,
  aliases: { "@": APP_SRC },
});

// 开发模式（默认）：启动时按源码全量重建，不能信任磁盘上的旧 manifest。
// 线上（WATCH=0）：只读预构建产物，缺失才构建。
const manifest = watching
  ? await compiler.buildAll()
  : ((await createManifestStore(DIST_DIR).read()) ?? (await compiler.buildAll()));

const registry = new Registry({
  root: ROOT,
  modulesDir: MODULES_DIR,
  distDir: DIST_DIR,
  builder: watching ? compiler : undefined,
});
await registry.loadAll(manifest);

const app = createApp(registry, { basePath });
app.listen(port, () => {
  console.log(`listening on http://localhost:${port}${basePath}`);
});

if (watching) {
  enableHotReload(registry, { root: ROOT, modulesDir: MODULES_DIR });
  console.log("[app] 热更新已启用（WATCH=0 可关闭）");
}
