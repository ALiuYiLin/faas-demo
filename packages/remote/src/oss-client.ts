import OSS from "ali-oss";

export interface OssConfig {
  region: string;
  bucket: string;
  endpoint?: string;
  accessKeyId: string;
  accessKeySecret: string;
  secure?: boolean;
  /** 毫秒 */
  timeout?: number;
}

/** 统一的 ali-oss 客户端构造，上传脚本和产物源共用 */
export function createOssClient(config: OssConfig): OSS {
  return new OSS({
    region: config.region,
    bucket: config.bucket,
    endpoint: config.endpoint,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    secure: config.secure ?? true,
    timeout: config.timeout,
  });
}

/** 从 env 风格的配置里挑出 OSS 相关字段 */
export function ossConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OssConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`[oss] 缺少环境变量 ${name}`);
    return value;
  };
  return {
    region: required("OSS_REGION"),
    bucket: required("OSS_BUCKET"),
    endpoint: env.OSS_ENDPOINT || undefined,
    accessKeyId: required("OSS_ACCESS_KEY_ID"),
    accessKeySecret: required("OSS_ACCESS_KEY_SECRET"),
    secure: env.OSS_SECURE !== "false",
    timeout: Number(env.OSS_REQUEST_TIMEOUT_MS ?? 30_000),
  };
}
