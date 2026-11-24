import path from "node:path";
import { createApp, Registry } from "@faas/core";
import {
  RemoteBuilder,
  RemoteSync,
  createFileSource,
  createOssSource,
  type ArtifactSource,
} from "@faas/remote";
import { BASE_PATH, DIST_DIR, MODULES_DIR, PORT, ROOT } from "./config";

// 方便本地直接用 .env 跑；部署时用真实环境变量即可
try {
  process.loadEnvFile(".env");
} catch {
  // 没有 .env 就忽略
}

process.on("unhandledRejection", (reason) => {
  console.error("[app] 未处理的 Promise 拒绝:", reason);
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`[remote] 缺少环境变量 ${name}`);
  return value;
}

function createSource(): ArtifactSource {
  if ((process.env.REMOTE_SOURCE ?? "oss") === "file") {
    return createFileSource(path.resolve(required("REMOTE_FILE_DIR")));
  }
  return createOssSource({
    region: required("OSS_REGION"),
    bucket: required("OSS_BUCKET"),
    endpoint: process.env.OSS_ENDPOINT || undefined,
    accessKeyId: required("OSS_ACCESS_KEY_ID"),
    accessKeySecret: required("OSS_ACCESS_KEY_SECRET"),
    secure: process.env.OSS_SECURE !== "false",
    timeout: Number(process.env.OSS_REQUEST_TIMEOUT_MS ?? 30_000),
  });
}

const prefix =
  process.env.OSS_PREFIX ??
  `${process.env.PROJECT_NAME ?? "faas-demo"}/modules`;

const sync = new RemoteSync({
  source: createSource(),
  prefix,
  distDir: DIST_DIR,
  concurrency: Number(process.env.REMOTE_CONCURRENCY ?? 4),
});

// 启动必须同步成功：远端模式下本地缓存只是缓存，manifest 以远端为准
const first = await sync.sync();

const registry = new Registry({
  root: ROOT,
  modulesDir: MODULES_DIR,
  distDir: DIST_DIR,
  builder: new RemoteBuilder(sync, DIST_DIR),
});
await registry.loadAll(first.manifest);

const app = createApp(registry, { basePath: BASE_PATH });

// 手动触发一次同步（验证 / 运维用；定时轮询是下一步）
app.post("/__admin/sync", async (_req, res) => {
  const result = await sync.sync();
  if (result.changed) await registry.applyManifest(result.manifest);
  res.json({ changed: result.changed, etag: result.etag, downloaded: result.downloaded });
});

app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}${BASE_PATH}`);
});

console.log(`[app] root=${ROOT}`);
console.log(`[app] dist=${DIST_DIR}`);
console.log(`[app] remote=${prefix}`);
