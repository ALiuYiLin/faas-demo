import { createApp, createManifestStore, Registry } from "@faas/core";
import {
  RemoteBuilder,
  RemoteSync,
  createOssSource,
  ossConfigFromEnv,
  type SyncResult,
} from "@faas/remote";
import {
  ADMIN_TOKEN,
  BASE_PATH,
  DIST_DIR,
  MODULES_DIR,
  MODULES_SOURCE,
  OSS_PREFIX,
  PORT,
  REMOTE_CONCURRENCY,
  REMOTE_POLL_MS,
  ROOT,
} from "./config";

// 本地直接用 .env；部署时用真实环境变量即可
try {
  process.loadEnvFile(".env");
} catch {
  // 没有 .env 就忽略
}

// 平台的底线：任何模块层面的异常都不能把进程带走
process.on("unhandledRejection", (reason) => {
  console.error("[app] 未处理的 Promise 拒绝:", reason);
});

const store = createManifestStore(DIST_DIR);

/** oss 模式下的远端同步；dir 模式没有 */
let sync: RemoteSync | null = null;
/** single-flight：轮询和 webhook 同时触发时只跑一次 */
let inFlight: Promise<SyncResult> | null = null;

async function runSync(): Promise<SyncResult> {
  if (!sync) throw new Error("当前是 MODULES_SOURCE=dir，没有可同步的远端");
  if (!inFlight) {
    inFlight = sync.sync().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function createRegistry(): Promise<Registry> {
  if (MODULES_SOURCE === "dir") {
    // 产物已经在本地：直接加载
    const manifest = (await store.read()) ?? (await createManifestStore(MODULES_DIR).read());
    if (!manifest) {
      console.error(
        `[app] MODULES_SOURCE=dir 但找不到 manifest（${DIST_DIR} 和 ${MODULES_DIR}）。` +
          `先执行 pnpm build（或 pnpm build:modules）`,
      );
      process.exit(1);
    }
    const registry = new Registry({ root: ROOT, modulesDir: MODULES_DIR, distDir: DIST_DIR });
    await registry.loadAll(manifest);
    console.log(`[app] source=dir dist=${DIST_DIR}`);
    return registry;
  }

  // 远端模式：启动时同步一次；失败则退回本地缓存（缓存也没有就退出）
  sync = new RemoteSync({
    source: createOssSource(ossConfigFromEnv()),
    prefix: OSS_PREFIX,
    distDir: DIST_DIR,
    concurrency: REMOTE_CONCURRENCY,
  });

  let first: SyncResult;
  try {
    first = await sync.sync();
  } catch (error) {
    const cached = await store.read();
    if (!cached) {
      console.error(
        `[app] 从 OSS 同步失败且没有本地缓存（${DIST_DIR}）：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
    console.warn(
      `[app] 远端同步失败，先用本地缓存启动：${error instanceof Error ? error.message : String(error)}`,
    );
    first = { manifest: cached, changed: false, etag: "", downloaded: 0 };
  }

  const registry = new Registry({
    root: ROOT,
    modulesDir: MODULES_DIR,
    distDir: DIST_DIR,
    builder: new RemoteBuilder(sync, DIST_DIR),
  });
  await registry.loadAll(first.manifest);
  console.log(`[app] source=oss prefix=${OSS_PREFIX} dist=${DIST_DIR}`);
  return registry;
}

const registry = await createRegistry();

const app = createApp(registry, { basePath: BASE_PATH });

/** webhook / 运维入口：手动触发一次同步并换版 */
app.post("/__admin/sync", async (req, res) => {
  if (ADMIN_TOKEN && req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const result = await runSync();
  if (result.changed) await registry.applyManifest(result.manifest);
  res.json({ changed: result.changed, etag: result.etag, downloaded: result.downloaded });
});

app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}${BASE_PATH}`);
});

console.log(`[app] root=${ROOT}`);
console.log(`[app] modules=${MODULES_DIR}`);

// 轮询：REMOTE_POLL_MS=0 时只靠 webhook
if (sync && REMOTE_POLL_MS > 0) {
  setInterval(() => {
    void runSync()
      .then(async (result) => {
        if (!result.changed) return;
        await registry.applyManifest(result.manifest);
        console.log(`[app] 轮询换版：manifest ${result.etag.slice(0, 8)}`);
      })
      .catch((error) => {
        console.error("[app] 轮询同步失败:", error instanceof Error ? error.message : error);
      });
  }, REMOTE_POLL_MS);
  console.log(`[app] 轮询间隔 ${REMOTE_POLL_MS}ms`);
}
