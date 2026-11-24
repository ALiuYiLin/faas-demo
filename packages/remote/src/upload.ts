import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Manifest } from "@faas/core";
import { createOssClient, type OssConfig } from "./oss-client";
import {
  archiveManifest,
  fetchManifestVersion,
  fetchRemoteManifest,
  isArchiveKey,
  listManifestVersions,
  listObjects,
  MANIFEST_FILE,
  manifestVersion,
  versionFromArchiveKey,
  type OssIo,
} from "./manifests";

export interface UploadModulesConfig extends OssConfig {
  /** 本地产物目录，通常就是 dist/modules */
  distDir: string;
  /** 远端前缀，如 `faas-demo/modules` */
  prefix: string;
  /** 只打印计划，不真正上传/删除 */
  dryRun?: boolean;
  /** 并发上传数，默认 4 */
  concurrency?: number;
  /** 上传完成后清理远端过期产物，默认 false */
  prune?: boolean;
  /** 清理时对象至少闲置多久（毫秒），默认 10 分钟 */
  pruneGraceMs?: number;
  /** 保留多少代 manifest（含当前），默认 2 */
  keepGenerations?: number;
  /** 只打印将被删除的对象 */
  pruneDryRun?: boolean;
  log?: (message: string) => void;
}

export interface UploadModulesResult {
  uploaded: string[];
  skipped: string[];
  total: number;
  /** 本次归档的 manifest 历史版本 id */
  version: string;
  /** 被删除（或 dry-run 下将被删除）的对象 */
  pruned: string[];
}

interface UploadClient extends OssIo {
  put(key: string, content: Buffer | string): Promise<unknown>;
}

/**
 * 把 `dist/modules` 上传到 OSS。
 *
 * - manifest 是唯一事实来源：本地缺文件直接报错；
 * - 内容 MD5 与远端 ETag 一致就跳过；
 * - 先传文件，再归档 manifest 历史，最后传 manifest.json；
 * - 可选 `prune`：只保留最近 N 代 manifest 引用的文件，且只删闲置超过宽限期的对象。
 */
export async function uploadModules(config: UploadModulesConfig): Promise<UploadModulesResult> {
  const log = config.log ?? ((message: string) => console.log(message));
  const prefix = config.prefix.replace(/\/+$/, "");
  const dryRun = config.dryRun === true;

  const manifestPath = path.join(config.distDir, "manifest.json");
  const json = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(json) as Manifest;
  const version = manifestVersion(json);

  const files = Object.keys(manifest.files);
  for (const file of files) {
    try {
      await readFile(path.join(config.distDir, file));
    } catch {
      throw new Error(`[upload] 本地缺少 ${file}，先执行 pnpm build:modules`);
    }
  }

  const client = createOssClient(config) as unknown as UploadClient;
  const result: UploadModulesResult = {
    uploaded: [],
    skipped: [],
    total: files.length + 1,
    version,
    pruned: [],
  };

  const previous = await fetchRemoteManifest(client, prefix).catch(() => null);

  const queue = [...files];
  const concurrency = Math.max(1, config.concurrency ?? 4);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        await uploadOne(client, config, prefix, next, log, result);
      }
    }),
  );

  if (dryRun) {
    log(`[upload] (dry-run) 将归档 manifests/${version}.json`);
  } else {
    await archiveManifest(client, prefix, json);
  }
  await uploadOne(client, config, prefix, MANIFEST_FILE, log, result);

  if (config.prune) {
    result.pruned = await pruneRemote(client, config, prefix, {
      version,
      files,
      previousManifest: previous?.manifest,
      log,
    });
  }

  return result;
}

/** 把某个历史版本重新发布成当前 manifest；各实例轮询到 ETag 变化后会自行回滚 */
export async function rollbackModules(
  config: Pick<
    UploadModulesConfig,
    | "region"
    | "bucket"
    | "endpoint"
    | "accessKeyId"
    | "accessKeySecret"
    | "secure"
    | "timeout"
    | "prefix"
    | "dryRun"
    | "log"
  >,
  version: string,
): Promise<Manifest> {
  const log = config.log ?? ((message: string) => console.log(message));
  const prefix = config.prefix.replace(/\/+$/, "");
  const client = createOssClient(config) as unknown as UploadClient;

  const target = await fetchManifestVersion(client, prefix, version);
  if (!target) {
    throw new Error(`[rollback] 历史版本 ${version} 不存在（${prefix}/manifests/${version}.json）`);
  }
  if (config.dryRun) {
    log(`[rollback] (dry-run) 将把 ${version} 重新发布为当前 manifest`);
    return target;
  }

  await client.put(
    `${prefix}/${MANIFEST_FILE}`,
    Buffer.from(`${JSON.stringify(target, null, 2)}\n`, "utf8"),
  );
  log(`[rollback] 已把 ${version} 发布为当前 manifest（各实例将在下一次轮询后回滚）`);
  return target;
}

async function pruneRemote(
  client: UploadClient,
  config: UploadModulesConfig,
  prefix: string,
  options: {
    version: string;
    files: string[];
    previousManifest?: Manifest;
    log: (message: string) => void;
  },
): Promise<string[]> {
  const log = options.log;
  const keepGenerations = Math.max(1, config.keepGenerations ?? 2);
  const graceMs = config.pruneGraceMs ?? 10 * 60_000;
  const dryRun = config.pruneDryRun === true || config.dryRun === true;

  const versions = await listManifestVersions(client, prefix);
  const keepVersions = new Set(versions.slice(0, keepGenerations).map((entry) => entry.version));
  keepVersions.add(options.version);

  const keepFiles = new Set(options.files);
  if (options.previousManifest) {
    for (const file of Object.keys(options.previousManifest.files)) keepFiles.add(file);
  }
  for (const version of keepVersions) {
    const manifest = await fetchManifestVersion(client, prefix, version);
    if (manifest) for (const file of Object.keys(manifest.files)) keepFiles.add(file);
  }

  const objects = await listObjects(client, prefix);
  const cutoff = Date.now() - graceMs;

  const doomed = objects.filter((object) => {
    if (object.relative === MANIFEST_FILE) return false;

    const archive = isArchiveKey(object.relative);
    const artifact = object.relative.endsWith(".js");
    if (!archive && !artifact) return false;

    if (archive) {
      if (keepVersions.has(versionFromArchiveKey(object.relative))) return false;
    } else if (keepFiles.has(object.relative)) {
      return false;
    }

    const timestamp = object.lastModified ? Date.parse(object.lastModified) : Number.NaN;
    // 没有时间戳就不删，宽限期内也不删
    return Number.isFinite(timestamp) && timestamp < cutoff;
  });

  const names = doomed.map((object) => object.relative);
  if (names.length === 0) {
    log(`[prune] 没有需要清理的对象（保留 ${keepVersions.size} 代）`);
    return [];
  }

  if (dryRun) {
    for (const name of names) log(`[prune] (dry-run) 将删除 ${name}`);
    return names;
  }

  for (const name of names) {
    await client.delete(`${prefix}/${name}`);
    log(`[prune] 已删除 ${name}`);
  }
  return names;
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
    const headers = result.res?.headers;
    const etag = headers?.["etag"] ?? headers?.["ETag"] ?? "";
    return String(etag).replace(/"/g, "");
  } catch (error) {
    if ((error as { status?: number })?.status === 404 || (error as { code?: string })?.code === "NoSuchKey") {
      return null;
    }
    throw error;
  }
}
