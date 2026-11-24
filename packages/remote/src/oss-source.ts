import type { ArtifactSource } from "./source";
import { createOssClient, type OssConfig } from "./oss-client";

export type OssSourceConfig = OssConfig;

/** 阿里云 OSS 产物源（只读：head + get） */
export function createOssSource(config: OssSourceConfig): ArtifactSource {
  const client = createOssClient(config);

  return {
    async head(key: string): Promise<string | null> {
      try {
        const result = await client.head(key);
        const headers = result.res.headers as Record<string, string | undefined>;
        // OSS 的 ETag 带双引号；分片上传是 `xxx-N`，这里只做"是否变化"的比对
        const etag = headers["etag"] ?? headers["ETag"] ?? "";
        return String(etag).replace(/"/g, "");
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async get(key: string): Promise<Buffer> {
      const result = await client.get(key);
      return result.content as Buffer;
    },
  };
}

function isNotFound(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  const code = (error as { code?: string })?.code;
  return status === 404 || code === "NoSuchKey";
}
