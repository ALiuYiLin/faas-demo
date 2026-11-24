import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactSource } from "./source";

/**
 * 本地目录镜像源：把"上传到 OSS"换成"拷进一个目录"，用于本地联调 / 测试。
 * ETag 用内容 MD5 模拟 OSS 单次 PUT 的语义。
 */
export function createFileSource(root: string): ArtifactSource {
  return {
    async head(key: string): Promise<string | null> {
      try {
        const content = await readFile(path.join(root, key));
        return createHash("md5").update(content).digest("hex");
      } catch {
        return null;
      }
    },
    async get(key: string): Promise<Buffer> {
      return readFile(path.join(root, key));
    },
  };
}
