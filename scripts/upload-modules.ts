import path from "node:path";
import {
  createOssClient,
  listManifestVersions,
  ossConfigFromEnv,
  rollbackModules,
  uploadModules,
  type OssIo,
} from "@faas/remote";

// 本地直接用 .env（CI 里通常直接给环境变量）
try {
  process.loadEnvFile(".env");
} catch {
  // 没有 .env 就忽略
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const dryRun = has("dry-run");
const distDir = path.resolve(arg("dist") ?? process.env.MODULES_DIST_DIR ?? path.join("dist", "modules"));
const project = process.env.PROJECT_NAME ?? "faas-demo";
const prefix = (arg("prefix") ?? process.env.OSS_PREFIX ?? `${project}/modules`).replace(/\/+$/, "");
const oss = ossConfigFromEnv();
const log = (message: string) => console.log(message);

console.log(`[upload] 目标 oss://${oss.bucket}/${prefix}/`);

// pnpm upload:modules --versions
if (has("versions")) {
  const versions = await listManifestVersions(createOssClient(oss) as unknown as OssIo, prefix);
  if (versions.length === 0) {
    console.log("[upload] 还没有历史 manifest");
  } else {
    for (const version of versions) {
      const size = ((version.size ?? 0) / 1024).toFixed(1);
      console.log(`  ${version.version}  ${version.lastModified ?? ""}  ${size} KB`);
    }
  }
  process.exit(0);
}

// pnpm upload:modules --rollback=<version>   把历史版本重新发布为当前 manifest
const rollback = arg("rollback");
if (rollback) {
  const manifest = await rollbackModules({ ...oss, prefix, dryRun, log }, rollback);
  console.log(`[upload] 目标版本 builtAt=${manifest.builtAt}`);
  process.exit(0);
}

console.log(`[upload] 本地目录 ${distDir}`);

const result = await uploadModules({
  ...oss,
  distDir,
  prefix,
  dryRun,
  concurrency: Number(process.env.OSS_UPLOAD_CONCURRENCY ?? 4),
  prune: has("prune") || has("prune-dry-run"),
  pruneDryRun: has("prune-dry-run"),
  pruneGraceMs: arg("grace-ms") ? Number(arg("grace-ms")) : undefined,
  keepGenerations: arg("keep") ? Number(arg("keep")) : undefined,
  log,
});

console.log(`[upload] manifest 版本 ${result.version}`);
console.log(
  `[upload] ${dryRun ? "(dry-run) " : ""}共 ${result.total} 个文件：` +
    `上传 ${result.uploaded.length}，跳过 ${result.skipped.length}`,
);
if (result.pruned.length > 0) {
  console.log(`[upload] ${dryRun ? "(dry-run) 将清理" : "已清理"} ${result.pruned.length} 个对象`);
}
