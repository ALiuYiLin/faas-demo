import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** 一个编译产物的描述 */
export interface FileInfo {
  /** 产物相对路径（相对模块目录），如 controller/UserController.js */
  file: string;
  /** 源文件相对路径，如 controller/UserController.ts */
  source: string;
  /** 产物内容哈希（sha256 前 16 位），兼做完整性校验与换版判断 */
  version: string;
}

export interface ManifestEntries {
  /** controller 入口（相对模块目录的 .js 路径） */
  controllers: string[];
  /** service 入口 */
  services: string[];
}

export interface Manifest {
  manifestVersion: 2;
  builtAt: string;
  /** 兼容的 runtime 版本范围 */
  runtime: string;
  /** 产物路径 -> 描述 */
  files: Record<string, FileInfo>;
  /** 需要主动加载的入口 */
  entries: ManifestEntries;
}

export interface ManifestStore {
  readonly file: string;
  read(): Promise<Manifest | null>;
  write(manifest: Manifest): Promise<void>;
  /** 删除 keep 之外的所有产物（manifest*.json / .etag 永远保留） */
  prune(manifest: Manifest, keep?: Iterable<string>): Promise<string[]>;
}

export function createManifestStore(distDir: string): ManifestStore {
  const file = path.join(distDir, "manifest.json");

  return {
    file,

    async read(): Promise<Manifest | null> {
      try {
        return JSON.parse(await readFile(file, "utf8")) as Manifest;
      } catch {
        return null;
      }
    },

    async write(manifest: Manifest): Promise<void> {
      await mkdir(distDir, { recursive: true });
      await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    },

    async prune(manifest: Manifest, keep?: Iterable<string>): Promise<string[]> {
      const wanted = new Set(Object.keys(manifest.files));
      for (const extra of keep ?? []) wanted.add(extra);

      const removed: string[] = [];
      for (const relative of await walk(distDir)) {
        if (wanted.has(relative)) continue;
        if (relative === "manifest.json" || relative === "manifest.prev.json" || relative === ".etag") {
          continue;
        }
        await rm(path.join(distDir, relative), { force: true });
        removed.push(relative);
      }
      return removed;
    },
  };
}

export function emptyManifest(): Manifest {
  return {
    manifestVersion: 2,
    builtAt: new Date().toISOString(),
    runtime: "^1.0.0",
    files: {},
    entries: { controllers: [], services: [] },
  };
}

/**
 * 校验 manifest 能不能被当前平台加载。
 * 远端下发时尤其重要：模块可能按新 API 编译、平台还是旧版。
 */
export function assertCompatible(manifest: Manifest, expectedRuntime = "^1.0.0"): void {
  if (manifest?.manifestVersion !== 2) {
    throw new Error(
      `[manifest] 不支持的 manifestVersion：${String(manifest?.manifestVersion)}（只支持 2）`,
    );
  }
  const expected = majorOf(expectedRuntime);
  const actual = majorOf(manifest.runtime);
  if (expected !== actual) {
    throw new Error(
      `[manifest] 运行时版本不兼容：模块要求 ${manifest.runtime}，平台是 ${expectedRuntime}`,
    );
  }
}

function majorOf(range: string): number {
  const match = /\d+/.exec(range ?? "");
  return match ? Number(match[0]) : Number.NaN;
}

/** 递归列出目录下的所有文件（相对路径，POSIX 风格） */
async function walk(dir: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walk(path.join(dir, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}


