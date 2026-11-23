import { buildAll, readManifest } from "@/build/artifact";
import { createApp } from "@/server/app";
import { Registry } from "@/server/registry";

const port = Number(process.env.PORT ?? 3000);

// 没有 manifest 就全量构建一次（开发期最省事；线上应该只读预构建产物）
const manifest = (await readManifest()) ?? (await buildAll());

const registry = new Registry(manifest);
await registry.loadAll();

const app = createApp(registry, { basePath: process.env.BASE_PATH ?? "/api" });
app.listen(port, () => {
  console.log(`listening on http://localhost:${port}${process.env.BASE_PATH ?? "/api"}`);
});

if (process.env.WATCH !== "0") {
  registry.startWatching();
  console.log("[registry] watching src/modules（WATCH=0 可关闭）");
}
