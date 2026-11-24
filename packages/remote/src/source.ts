/**
 * 远端产物来源：只做最少的两个操作。
 * OSS 是一个实现，本地目录镜像（测试用）是另一个实现。
 */
export interface ArtifactSource {
  /** 返回对象内容的 ETag（已去掉引号）；对象不存在返回 null */
  head(key: string): Promise<string | null>;
  /** 读取对象内容 */
  get(key: string): Promise<Buffer>;
}
