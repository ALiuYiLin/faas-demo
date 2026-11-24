import { createManifestStore, Registry } from "@faas/core";
import { DIST_DIR, MODULES_DIR, ROOT } from "./config";
import { startServer } from "./server";

// 生产入口：只加载预构建产物，不依赖 compiler / watcher。
// 构建：pnpm build   →   dist/server/index.js + dist/modules
// 运行：node dist/server/index.js（或 pnpm start）

process.on("unhandledRejection", (reason) => {
  console.error("[app] 未处理的 Promise 拒绝:", reason);
});

let distDir = DIST_DIR;
let manifest = await createManifestStore(distDir).read();

// 部署时常见做法：把产物目录整个放到 MODULES_DIR（里面含 manifest.json），
// 此时不设置 MODULES_DIST_DIR 也能跑。
if (!manifest && process.env.MODULES_DIR) {
  const alt = createManifestStore(MODULES_DIR);
  const altManifest = await alt.read();
  if (altManifest) {
    manifest = altManifest;
    distDir = MODULES_DIR;
    console.log(`[app] 使用 MODULES_DIR 作为产物目录：${MODULES_DIR}`);
  }
}

if (!manifest) {
  console.error(
    `[app] 找不到模块产物：${distDir}/manifest.json\n` +
      `     先执行 pnpm build（或 pnpm build:modules），` +
      `或用 MODULES_DIST_DIR / MODULES_DIR 指定产物目录`,
  );
  process.exit(1);
}

console.log(`[app] root=${ROOT}`);
console.log(`[app] modules=${MODULES_DIR}`);
console.log(`[app] dist=${distDir}`);

const registry = new Registry({
  root: ROOT,
  modulesDir: MODULES_DIR,
  distDir,
});
await registry.loadAll(manifest);

startServer(registry);
