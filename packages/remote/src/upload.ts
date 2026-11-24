import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Manifest } from "@faas/core";
import { createOssClient, type OssConfig } from "./oss-client";

export interface UploadModulesConfig extends OssConfig {
  /** 本地构建产物目录，通常就是 dist/modules */
  distDir: string;
  /** 远端前缀，如 `10coding-project/faas-demo/modules` */
  prefix: string;
  /** 只打印计划，不真正上传 */
  dryRun?: boolean;
  /** 并发上传数，默认 4 */
  concurrency?: number;
  log?: (message: string) => void;
}

export interface UploadModulesResult {
  uploaded: string[];
  skipped: string[];
  total: number;
}

/**
 * 把 `dist/modules` 上传到 OSS。
 *
 * - 以 manifest 里列出的产物为准，本地缺文件直接报错（避免传上去一个指向空文件的 manifest）；
 * - 内容 MD5 与远端 ETag 一致就跳过（单次 PUT 的 ETag 就是内容 MD5）；
 * - **manifest.json 最后传**：任何时刻远端 manifest 都只指向已经上传完成的 bundle。
 */
export async function uploadModules(config: UploadModulesConfig): Promise<UploadModulesResult> {
  const log = config.log ?? ((message: string) => console.log(message));
  const prefix = config.prefix.replace(/\/+$/, "");

  const manifestPath = path.join(config.distDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;

  const artifacts = [
    ...Object.values(manifest.controllers).map((info) => info.file),
    ...Object.values(manifest.services).map((info) => info.file),
  ];

  // 本地完整性检查：manifest 引用的文件必须都在
  for (const file of artifacts) {
    try {
      await readFile(path.join(config.distDir, file));
    } catch {
      throw new Error(`[upload] 本地缺少 ${file}，先执行 pnpm build:modules`);
    }
  }

  const client = createOssClient(config) as UploadClient;
  const result: UploadModulesResult = { uploaded: [], skipped: [], total: artifacts.length + 1 };

  // 先传 bundle（并发），最后传 manifest
  const queue = [...artifacts];
  const concurrency = Math.max(1, config.concurrency ?? 4);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        await uploadOne(client, config, prefix, next, log, result);
      }
    }),
  );
  await uploadOne(client, config, prefix, "manifest.json", log, result);

  return result;
}

async function uploadOne(
  client: UploadClient,
  config: UploadModulesConfig,
  prefix: string,
  relative: string,
  log: (message: string) => void,
  result: UploadModulesResult,
): Promise<void> {
  const content = await readFile(path.join(config.distDir, relative));
  const key = `${prefix}/${relative}`;

  if (!config.dryRun) {
    const remoteEtag = await headEtag(client, key);
    // 单次 PUT 的 ETag = 内容 MD5；一致说明远端已是这份内容
    if (remoteEtag === createHash("md5").update(content).digest("hex")) {
      result.skipped.push(relative);
      log(`[upload] 跳过（远端一致） ${relative}`);
      return;
    }
    await client.put(key, content);
  }

  result.uploaded.push(relative);
  log(`[upload] ${config.dryRun ? "将上传" : "已上传"} ${relative} (${(content.length / 1024).toFixed(1)} KB)`);
}

async function headEtag(client: UploadClient, key: string): Promise<string | null> {
  try {
    const result = await client.head(key);
    const headers = result.res?.headers as Record<string, string | undefined> | undefined;
    const etag = headers?.["etag"] ?? headers?.["ETag"] ?? "";
    return String(etag).replace(/"/g, "");
  } catch (error) {
    if ((error as { status?: number })?.status === 404 || (error as { code?: string })?.code === "NoSuchKey") {
      return null;
    }
    throw error;
  }
}

/** 只用到 head / put，避免依赖 ali-oss 的完整类型 */
interface UploadClient {
  head(key: string): Promise<{ res?: { headers?: object } }>;
  put(key: string, content: Buffer): Promise<unknown>;
}
