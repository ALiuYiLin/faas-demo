import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertCompatible, type ArtifactInfo, type Manifest } from "@faas/core";
import { pruneDistDir } from "./prune";
import type { ArtifactSource } from "./source";

export interface RemoteSyncConfig {
  source: ArtifactSource;
  /** 远端前缀，如 `faas-demo/modules` */
  prefix: string;
  /** 本地缓存目录（同时是产物目录） */
  distDir: string;
  /** 并发下载数，默认 4 */
  concurrency?: number;
  /** 同步成功后是否清理过期产物，默认 true */
  prune?: boolean;
  /** 保留几代（current + N-1），默认 2；1 表示不留上一版（无法回滚） */
  keepGenerations?: number;
  log?: (message: string) => void;
}

export interface SyncResult {
  manifest: Manifest;
  /** 产物是否有变化（决定要不要 applyManifest） */
  changed: boolean;
  /** 本次看到的 manifest ETag */
  etag: string;
  /** 下载了几个产物 */
  downloaded: number;
}

export interface RollbackResult {
  /** 回滚后生效的 manifest */
  manifest: Manifest;
  /** 被替换掉的那一版（现在是 previous） */
  previous: Manifest;
}

/**
 * 远端同步：一次 HEAD 判断要不要干活，然后只下载 version 变了的产物。
 *
 * 落盘顺序：先 bundle、再 manifest.prev、最后 manifest —— 任何时刻 manifest 都只指向已存在的文件。
 * 同步成功后按 `keepGenerations` 清理过期产物（默认保留 current + previous）。
 */
export class RemoteSync {
  private readonly manifestFile: string;
  private readonly previousManifestFile: string;
  private readonly etagFile: string;
  private readonly log: (message: string) => void;
  private lastEtag: string | null = null;
  private cachedManifest: Manifest | null = null;

  constructor(private readonly config: RemoteSyncConfig) {
    this.manifestFile = path.join(config.distDir, "manifest.json");
    this.previousManifestFile = path.join(config.distDir, "manifest.prev.json");
    this.etagFile = path.join(config.distDir, ".etag");
    this.log = config.log ?? ((message) => console.log(message));
  }

  /** 上一次同步拿到的 manifest（RemoteBuilder 用） */
  get current(): Manifest | null {
    return this.cachedManifest;
  }

  /** 上一代 manifest（回滚用），没有则 null */
  async previous(): Promise<Manifest | null> {
    return this.readPreviousManifest();
  }

  async sync(options: { force?: boolean } = {}): Promise<SyncResult> {
    if (this.cachedManifest === null) {
      this.cachedManifest = await this.readCachedManifest();
      this.lastEtag = await this.readCachedEtag();
    }

    const manifestKey = this.key("manifest.json");
    const etag = await this.config.source.head(manifestKey);
    if (!etag) {
      throw new Error(
        `[remote] ${manifestKey} 不存在。先把本地构建产物（dist/modules）上传到 ${this.config.prefix}/`,
      );
    }

    if (!options.force && etag === this.lastEtag && this.cachedManifest) {
      return { manifest: this.cachedManifest, changed: false, etag, downloaded: 0 };
    }

    const raw = await this.config.source.get(manifestKey);
    const manifest = JSON.parse(raw.toString("utf8")) as Manifest;
    assertCompatible(manifest);

    const previous = this.cachedManifest;
    const upserts = diffArtifacts(previous, manifest);
    const downloaded = await this.downloadAll(upserts);

    // 轮转上一代：回滚依赖它
    if (previous && this.keepGenerations > 1) {
      await this.writeAtomic(this.previousManifestFile, serialize(previous));
    }

    await this.writeAtomic(this.manifestFile, serialize(manifest));
    await this.writeAtomic(this.etagFile, etag);

    this.cachedManifest = manifest;
    this.lastEtag = etag;

    this.log(
      `[remote] manifest ${etag.slice(0, 8)}：${upserts.length} 个产物更新，下载 ${downloaded} 个`,
    );

    await this.prune(previous ? [manifest, previous] : [manifest]);

    return { manifest, changed: upserts.length > 0, etag, downloaded };
  }

  /**
   * 回滚到上一代。
   *
   * 不动 `.etag`：远端没有发布新版本时，之后的 sync 会把当前（回滚后的）manifest 当成最新，
   * 不会被立刻拉回新版本；等远端再次发布才会前进。
   */
  async rollback(): Promise<RollbackResult | null> {
    const current = this.cachedManifest ?? (await this.readCachedManifest());
    if (!current) return null;

    const previous = await this.readPreviousManifest();
    if (!previous) return null;

    await this.writeAtomic(this.previousManifestFile, serialize(current));
    await this.writeAtomic(this.manifestFile, serialize(previous));
    this.cachedManifest = previous;

    this.log(`[remote] 回滚到上一版（builtAt=${previous.builtAt}）`);
    await this.prune([previous, current]);

    return { manifest: previous, previous: current };
  }

  private get keepGenerations(): number {
    return Math.max(1, this.config.keepGenerations ?? 2);
  }

  private async prune(manifests: Manifest[]): Promise<void> {
    if (this.config.prune === false) return;
    try {
      const result = await pruneDistDir({ distDir: this.config.distDir, keepManifests: manifests });
      if (result.removed.length > 0) {
        this.log(
          `[remote] 清理 ${result.removed.length} 个过期产物（${(result.bytes / 1024).toFixed(1)} KB）`,
        );
      }
    } catch (error) {
      // 清理是后台动作，失败不影响本次同步
      this.log(`[remote] 清理失败（忽略）：${error instanceof Error ? error.message : error}`);
    }
  }

  private key(relative: string): string {
    return `${this.config.prefix.replace(/\/+$/, "")}/${relative.replace(/^\/+/, "")}`;
  }

  private async downloadAll(infos: ArtifactInfo[]): Promise<number> {
    if (infos.length === 0) return 0;
    const queue = [...infos];
    const concurrency = Math.max(1, this.config.concurrency ?? 4);
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        await this.download(next);
      }
    });
    await Promise.all(workers);
    return infos.length;
  }

  private async download(info: ArtifactInfo): Promise<void> {
    const content = await this.config.source.get(this.key(info.file));
    const version = createHash("sha256").update(content).digest("hex").slice(0, 16);
    if (version !== info.version) {
      throw new Error(
        `[remote] ${info.file} 校验失败：sha256 ${version} != manifest ${info.version}（文件损坏或 manifest 与产物不匹配）`,
      );
    }

    const target = path.join(this.config.distDir, info.file);
    await mkdir(path.dirname(target), { recursive: true });
    await this.writeAtomic(target, content);
    this.log(`[remote] 下载 ${info.file} (${info.version})`);
  }

  /** 原子写：先写临时文件再 rename，避免读到半个文件 */
  private async writeAtomic(file: string, data: string | Buffer): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file).catch(async (error) => {
      await rm(tmp, { force: true });
      throw error;
    });
  }

  private async readCachedManifest(): Promise<Manifest | null> {
    return readManifestFile(this.manifestFile);
  }

  private async readPreviousManifest(): Promise<Manifest | null> {
    return readManifestFile(this.previousManifestFile);
  }

  private async readCachedEtag(): Promise<string | null> {
    try {
      return (await readFile(this.etagFile, "utf8")).trim();
    } catch {
      return null;
    }
  }
}

function serialize(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function readManifestFile(file: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/** 找出新增 / 版本变化的产物；删除的产物会随着 manifest 更新在 applyManifest 里处理 */
function diffArtifacts(current: Manifest | null, next: Manifest): ArtifactInfo[] {
  const upserts: ArtifactInfo[] = [];
  for (const [kind, nextMap] of [
    ["controllers", next.controllers],
    ["services", next.services],
  ] as const) {
    const currentMap = (current?.[kind] ?? {}) as Record<string, ArtifactInfo>;
    for (const [name, info] of Object.entries(nextMap)) {
      if (currentMap[name]?.version !== info.version) upserts.push(info);
    }
  }
  return upserts;
}
