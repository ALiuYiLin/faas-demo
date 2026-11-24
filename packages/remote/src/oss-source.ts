import OSS from "ali-oss";
import type { ArtifactSource } from "./source";

export interface OssSourceConfig {
  region: string;
  bucket: string;
  endpoint?: string;
  accessKeyId: string;
  accessKeySecret: string;
  secure?: boolean;
  /** 毫秒 */
  timeout?: number;
}

interface OssResponse {
  res?: { status?: number; headers?: Record<string, string> };
  etag?: string;
}

/** 阿里云 OSS 产物源（只读：head + get） */
export function createOssSource(config: OssSourceConfig): ArtifactSource {
  const client = new OSS({
    region: config.region,
    bucket: config.bucket,
    endpoint: config.endpoint,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    secure: config.secure ?? true,
    timeout: config.timeout,
  });

  return {
    async head(key: string): Promise<string | null> {
      try {
        const result = (await client.head(key)) as OssResponse;
        // OSS 的 ETag 带双引号；分片上传是 `xxx-N`，这里只做"是否变化"的比对
        const etag = result.res?.headers?.etag ?? result.etag ?? "";
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
