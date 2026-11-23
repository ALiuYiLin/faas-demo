export interface CompilerConfig {
  /** 项目根；manifest 里的路径相对它 */
  root: string;
  /** 热区源码目录 */
  modulesDir: string;
  /** 产物目录（bundle + manifest.json） */
  distDir: string;
  /**
   * 路径别名 -> 绝对目录，例如 `{ "@": "/abs/apps/server/src" }`。
   * 热区源码里写 `@/modules/entity/User` 时按它解析。
   */
  aliases?: Record<string, string>;
}
