import { buildAll, readManifest } from "@/build/artifact";
import { createApp } from "@/server/app";
import { Registry } from "@/server/registry";

// 平台的底线：任何模块层面的异常都不能把进程带走（否则热更就变成"热崩"）
process.on("unhandledRejection", (reason) => {
  console.error("[app] 未处理的 Promise 拒绝:", reason);
});

const port = Number(process.env.PORT ?? 3000);
const watching = process.env.WATCH !== "0";

// 开发模式（默认）：启动时按源码全量重建。
// 不能直接信任磁盘上的 manifest——服务停止期间源码可能已经改过（甚至新增了文件），
// 那样会加载到过期产物（例如空文件编译出的空 bundle）。
// 线上（WATCH=0）：只读预构建产物，缺失才构建。
const manifest = watching ? await buildAll() : ((await readManifest()) ?? (await buildAll()));

const registry = new Registry(manifest);
await registry.loadAll();

const app = createApp(registry, { basePath: process.env.BASE_PATH ?? "/api" });
app.listen(port, () => {
  console.log(`listening on http://localhost:${port}${process.env.BASE_PATH ?? "/api"}`);
});

if (watching) {
  registry.startWatching();
  console.log("[registry] watching src/modules（WATCH=0 可关闭）");
}
