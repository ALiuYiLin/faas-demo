import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** 一个构建产物的描述，写进 manifest */
export interface ArtifactInfo {
  /** 入口源码，相对项目根 */
  entry: string;
  /** 产物文件，相对 dist 目录 */
  file: string;
  /** bundle 内容哈希（sha256 前 16 位），换版判断依据 */
  version: string;
  /** 打进来的源文件 -> md5（传递闭包），用于增量重建 */
  deps: Record<string, string>;
}

export type ArtifactKind = "controller" | "service";

export interface Manifest {
  manifestVersion: 1;
  builtAt: string;
  /** 兼容的 runtime 版本范围 */
  runtime: string;
  services: Record<string, ArtifactInfo>;
  controllers: Record<string, ArtifactInfo>;
}

/** manifest 是「构建器」和「运行时」之间的契约，读写都从这里走 */
export interface ManifestStore {
  readonly file: string;
  read(): Promise<Manifest | null>;
  write(manifest: Manifest): Promise<void>;
  /** 删除 manifest 未引用的旧 bundle */
  prune(manifest: Manifest): Promise<void>;
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

    async prune(manifest: Manifest): Promise<void> {
      const keep = new Set(
        [...Object.values(manifest.controllers), ...Object.values(manifest.services)].map((info) =>
          path.join(distDir, info.file),
        ),
      );
      for (const kind of ["controller", "service"] as const) {
        const dir = path.join(distDir, kind);
        let files: string[];
        try {
          files = await readdir(dir);
        } catch {
          continue;
        }
        for (const name of files) {
          const full = path.join(dir, name);
          if (!keep.has(full)) await rm(full, { force: true });
        }
      }
    },
  };
}

export function emptyManifest(): Manifest {
  return {
    manifestVersion: 1,
    builtAt: new Date().toISOString(),
    runtime: "^1.0.0",
    services: {},
    controllers: {},
  };
}
