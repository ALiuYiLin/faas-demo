import type { ArtifactInfo, ArtifactKind, Manifest } from "./manifest";

export interface BuiltArtifact {
  info: ArtifactInfo;
  code: string;
  kind: ArtifactKind;
  name: string;
}

/**
 * 构建器端口：core 只认这个接口，不 import rollup。
 * 开发期由 `@faas/compiler` 实现并注入；线上不注入，运行时只加载预构建产物。
 */
export interface Builder {
  /** 重建单个产物（不落盘） */
  build(entry: string): Promise<BuiltArtifact>;
  /** 全量构建 + 落盘 + 写 manifest */
  buildAll(): Promise<Manifest>;
  /** 把单个产物落盘 */
  write(built: BuiltArtifact): Promise<void>;
}
