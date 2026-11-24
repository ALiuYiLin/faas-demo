import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertCompatible, createManifestStore, type FileInfo, type Manifest, type ManifestStore } from "@faas/core";
import type { ArtifactSource } from "./source";

export interface RemoteSyncConfig {
  source: ArtifactSource;
  /** 远端前缀，如 `faas-demo/modules` */
  prefix: string;
  /** 本地目录（同时是产物目录） */
  distDir: string;
  /** 并发下载数，默认 4 */
  concurrency?: number;
  /** 同步成功后是否清理过期产物，默认 true */
  prune?: boolean;
  /** 保留几代（current + N-1），默认 2 */
  keepGenerations?: number;
  log?: (message: string) => void;
}

export interface SyncResult {
  manifest: Manifest;
  changed: boolean;
  etag: string;
  /** 下载了几个文件 */
  downloaded: number;
}

export interface RollbackResult {
  manifest: Manifest;
  previous: Manifest;
}

/**
 * 远端同步：一次 HEAD 判断要不要干活，然后只下载 version 变了的文件。
 *
 * 落盘顺序：先文件、再 manifest.prev、最后 manifest。
 * 文件级意味着 util/common 变化只下载那一个文件，入口不需要重新加载。
 */
export class RemoteSync {
  private readonly manifestFile: string;
  private readonly previousManifestFile: string;
  private readonly etagFile: string;
  private readonly store: ManifestStore;
  private readonly log: (message: string) => void;
  private lastEtag: string | null = null;
  private cachedManifest: Manifest | null = null;

  constructor(private readonly config: RemoteSyncConfig) {
    this.manifestFile = path.join(config.distDir, "manifest.json");
    this.previousManifestFile = path.join(config.distDir, "manifest.prev.json");
    this.etagFile = path.join(config.distDir, ".etag");
    this.store = createManifestStore(config.distDir);
    this.log = config.log ?? ((message) => console.log(message));
  }

  get current(): Manifest | null {
    return this.cachedManifest;
  }

  async previous(): Promise<Manifest | null> {
    return readManifestFile(this.previousManifestFile);
  }

  async sync(options: { force?: boolean } = {}): Promise<SyncResult> {
    if (this.cachedManifest === null) {
      this.cachedManifest = await this.store.read();
      this.lastEtag = await readText(this.etagFile);
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

    const manifest = JSON.parse((await this.config.source.get(manifestKey)).toString("utf8")) as Manifest;
    assertCompatible(manifest);

    const previous = this.cachedManifest;
    const changedFiles = diffFiles(previous, manifest);
    const downloaded = await this.downloadAll(changedFiles);

    if (previous && this.keepGenerations > 1) {
      await this.writeAtomic(this.previousManifestFile, serialize(previous));
    }
    await this.store.write(manifest);
    await this.writeAtomic(this.etagFile, etag);

    this.cachedManifest = manifest;
    this.lastEtag = etag;

    this.log(
      `[remote] manifest ${etag.slice(0, 8)}：${changedFiles.length} 个文件更新，下载 ${downloaded} 个`,
    );

    await this.prune(previous ? [manifest, previous] : [manifest]);

    return { manifest, changed: changedFiles.length > 0, etag, downloaded };
  }

  /** 回滚到上一代；不动 .etag，远端没发布新版本时不会被拉回去 */
  async rollback(): Promise<RollbackResult | null> {
    const current = this.cachedManifest ?? (await this.store.read());
    if (!current) return null;

    const previous = await this.previous();
    if (!previous) return null;

    await this.writeAtomic(this.previousManifestFile, serialize(current));
    await this.store.write(previous);
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
      const keep = manifests.flatMap((manifest) => Object.keys(manifest.files));
      const removed = await this.store.prune(manifests[0], keep);
      if (removed.length > 0) this.log(`[remote] 清理 ${removed.length} 个过期文件`);
    } catch (error) {
      this.log(`[remote] 清理失败（忽略）：${error instanceof Error ? error.message : error}`);
    }
  }

  private key(relative: string): string {
    return `${this.config.prefix.replace(/\/+$/, "")}/${relative.replace(/^\/+/, "")}`;
  }

  private async downloadAll(files: FileInfo[]): Promise<number> {
    if (files.length === 0) return 0;
    const queue = [...files];
    const concurrency = Math.max(1, this.config.concurrency ?? 4);
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          await this.download(next);
        }
      }),
    );
    return files.length;
  }

  private async download(info: FileInfo): Promise<void> {
    const content = await this.config.source.get(this.key(info.file));
    const version = createHash("sha256").update(content).digest("hex").slice(0, 16);
    if (version !== info.version) {
      throw new Error(
        `[remote] ${info.file} 校验失败：sha256 ${version} != manifest ${info.version}`,
      );
    }

    const target = path.join(this.config.distDir, info.file);
    await mkdir(path.dirname(target), { recursive: true });
    await this.writeAtomic(target, content);
  }

  private async writeAtomic(file: string, data: string | Buffer): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file).catch(async (error) => {
      await rm(tmp, { force: true });
      throw error;
    });
  }
}

function serialize(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function readText(file: string): Promise<string | null> {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

async function readManifestFile(file: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/** 找出新增或 version 变化的文件 */
function diffFiles(current: Manifest | null, next: Manifest): FileInfo[] {
  const changed: FileInfo[] = [];
  for (const [file, info] of Object.entries(next.files)) {
    if (current?.files[file]?.version !== info.version) changed.push(info);
  }
  return changed;
}
