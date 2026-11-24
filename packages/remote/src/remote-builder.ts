import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactInfo, Builder, BuiltArtifact, Manifest } from "@faas/core";
import type { RemoteSync } from "./sync";

/**
 * 把远端能力适配成 core 的 Builder 端口：
 * - `buildAll()` 触发一次完整的远端同步；
 * - `build(entry)` 不联网，直接从本地缓存读（registry 的 reload 路径会用到）；
 * - `write()` 写到缓存目录。
 */
export class RemoteBuilder implements Builder {
  constructor(
    private readonly sync: RemoteSync,
    private readonly distDir: string,
  ) {}

  async buildAll(): Promise<Manifest> {
    return (await this.sync.sync({ force: true })).manifest;
  }

  async build(entry: string): Promise<BuiltArtifact> {
    const manifest = this.sync.current ?? (await this.sync.sync()).manifest;
    const info = findArtifact(manifest, entry);
    if (!info) {
      throw new Error(`[remote] manifest 里没有入口 ${entry}`);
    }

    const code = await readFile(path.join(this.distDir, info.file), "utf8");
    return {
      info,
      code,
      kind: info.file.startsWith("controller/") ? "controller" : "service",
      name: path.basename(entry, path.extname(entry)),
    };
  }

  async write(built: BuiltArtifact): Promise<void> {
    const target = path.join(this.distDir, built.info.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, built.code, "utf8");
  }
}

function findArtifact(manifest: Manifest, entry: string): ArtifactInfo | undefined {
  for (const map of [manifest.controllers, manifest.services]) {
    for (const info of Object.values(map)) {
      if (info.entry === entry) return info;
    }
  }
  return undefined;
}
