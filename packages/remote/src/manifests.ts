import { createHash } from "node:crypto";
import type { Manifest } from "@faas/core";

export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_ARCHIVE_DIR = "manifests";

/** 只用到对象存储的这几个操作，避免依赖 ali-oss 的完整类型 */
export interface OssIo {
  head(key: string): Promise<{ res?: { headers?: Record<string, string | undefined> } }>;
  get(key: string): Promise<{ content: unknown }>;
  put(key: string, content: Buffer | string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(
    query: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{
    objects?: Array<{ name: string; size?: number; lastModified?: string | Date }>;
    isTruncated?: boolean;
    nextMarker?: string;
  }>;
}

export interface ManifestVersion {
  version: string;
  lastModified?: string;
  size?: number;
}

export interface OssObject {
  name: string;
  /** 相对 prefix 的路径，如 `controller/UserController.17e440ba.js` */
  relative: string;
  size?: number;
  lastModified?: string;
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** manifest 内容哈希前 16 位，作为历史版本 id */
export function manifestVersion(json: string): string {
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

export function archiveKey(version: string): string {
  return `${MANIFEST_ARCHIVE_DIR}/${version}.json`;
}

export function isArchiveKey(relative: string): boolean {
  return /^manifests\/[0-9a-f]{16}\.json$/.test(relative);
}

export function versionFromArchiveKey(relative: string): string {
  return relative.slice(MANIFEST_ARCHIVE_DIR.length + 1, -".json".length);
}

async function readKey(client: OssIo, key: string): Promise<string | null> {
  try {
    const result = await client.get(key);
    return Buffer.isBuffer(result.content) ? result.content.toString("utf8") : String(result.content);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function fetchRemoteManifest(
  client: OssIo,
  prefix: string,
): Promise<{ json: string; manifest: Manifest } | null> {
  const json = await readKey(client, `${prefix}/${MANIFEST_FILE}`);
  if (!json) return null;
  return { json, manifest: JSON.parse(json) as Manifest };
}

export async function fetchManifestVersion(
  client: OssIo,
  prefix: string,
  version: string,
): Promise<Manifest | null> {
  const json = await readKey(client, `${prefix}/${archiveKey(version)}`);
  return json ? (JSON.parse(json) as Manifest) : null;
}

/** 归档当前 manifest（历史版本），返回版本 id */
export async function archiveManifest(
  client: OssIo,
  prefix: string,
  json: string,
): Promise<string> {
  const version = manifestVersion(json);
  // ali-oss 的 put 把字符串当"本地文件路径"，内容必须是 Buffer
  await client.put(`${prefix}/${archiveKey(version)}`, Buffer.from(json, "utf8"));
  return version;
}

/** 列出历史 manifest，按时间倒序（最新的在前） */
export async function listManifestVersions(
  client: OssIo,
  prefix: string,
): Promise<ManifestVersion[]> {
  const objects = await listObjects(client, prefix);
  return objects
    .filter((object) => isArchiveKey(object.relative))
    .map((object) => ({
      version: versionFromArchiveKey(object.relative),
      lastModified: object.lastModified,
      size: object.size,
    }))
    .sort((a, b) => String(b.lastModified ?? "").localeCompare(String(a.lastModified ?? "")));
}

/** 把某个历史版本重新发布成当前 manifest（跨实例回滚） */
export async function rollbackManifest(
  client: OssIo,
  prefix: string,
  version: string,
): Promise<Manifest> {
  const manifest = await fetchManifestVersion(client, prefix, version);
  if (!manifest) {
    throw new Error(`[remote] 历史版本 ${version} 不存在（${prefix}/${archiveKey(version)}）`);
  }
  await client.put(`${prefix}/${MANIFEST_FILE}`, Buffer.from(serializeManifest(manifest), "utf8"));
  return manifest;
}

/** 分页列出 prefix 下的所有对象 */
export async function listObjects(client: OssIo, prefix: string): Promise<OssObject[]> {
  const root = `${prefix.replace(/\/+$/, "")}/`;
  const objects: OssObject[] = [];
  let marker: string | undefined;

  for (;;) {
    const result = await client.list(
      { prefix: root, "max-keys": 1000, ...(marker ? { marker } : {}) },
      {},
    );
    const page = result.objects ?? [];
    for (const object of page) {
      const lastModified = object.lastModified instanceof Date
        ? object.lastModified.toISOString()
        : object.lastModified;
      objects.push({
        name: object.name,
        relative: object.name.slice(root.length),
        size: object.size,
        lastModified,
      });
    }
    if (!result.isTruncated || page.length === 0) break;
    marker = result.nextMarker ?? page[page.length - 1]?.name;
    if (!marker) break;
  }

  return objects;
}

function isNotFound(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  const code = (error as { code?: string })?.code;
  return status === 404 || code === "NoSuchKey";
}
