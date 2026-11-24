import path from "node:path";
import { ossConfigFromEnv, uploadModules } from "@faas/remote";

// 本地直接用 .env（部署/CI 里通常直接给环境变量）
try {
  process.loadEnvFile(".env");
} catch {
  // 没有 .env 就忽略
}

/** 支持 --dry-run / --prefix=<key 前缀> / --dist=<产物目录> */
function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((item) => item.startsWith(prefix));
  return hit?.slice(prefix.length);
}

const dryRun = process.argv.includes("--dry-run");
const distDir = path.resolve(arg("dist") ?? process.env.MODULES_DIST_DIR ?? path.join("dist", "modules"));
const project = process.env.PROJECT_NAME ?? "faas-demo";
// bucket 本身是 10coding-project，所以 OSS 上的 key 前缀是 <project>/modules
const prefix = arg("prefix") ?? process.env.OSS_PREFIX ?? `${project}/modules`;

const oss = ossConfigFromEnv();

console.log(`[upload] 本地目录 ${distDir}`);
console.log(`[upload] 目标     oss://${oss.bucket}/${prefix.replace(/\/+$/, "")}/`);

const result = await uploadModules({
  ...oss,
  distDir,
  prefix,
  dryRun,
  concurrency: Number(process.env.OSS_UPLOAD_CONCURRENCY ?? 4),
});

console.log(
  `[upload] ${dryRun ? "(dry-run) " : ""}共 ${result.total} 个文件：` +
    `上传 ${result.uploaded.length}，跳过 ${result.skipped.length}`,
);