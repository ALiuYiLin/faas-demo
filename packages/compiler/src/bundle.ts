import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { rollup } from "rollup";
import esbuild from "rollup-plugin-esbuild";
import {
  createManifestStore,
  emptyManifest,
  type ArtifactKind,
  type Builder,
  type BuiltArtifact,
  type Manifest,
} from "@faas/core";
import type { CompilerConfig } from "./config";
import { createResolvePlugin } from "./resolve";

export function toPosix(file: string): string {
  return file.replace(/\\/g, "/");
}

/** 按目录约定判断产物类型：`**\/controller/*.ts` / `**\/service/impl/*.ts` */
export function entryKind(file: string): ArtifactKind | null {
  const parent = path.basename(path.dirname(file));
  const grand = path.basename(path.dirname(path.dirname(file)));
  if (parent === "controller") return "controller";
  if (parent === "impl" && grand === "service") return "service";
  return null;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 构建单个产物：TS/ESM -> CJS，收集依赖闭包与 md5 */
export async function buildArtifact(
  config: CompilerConfig,
  entry: string,
): Promise<BuiltArtifact> {
  const absoluteEntry = path.resolve(config.root, entry);
  const kind = entryKind(absoluteEntry);
  if (!kind) {
    throw new Error(`[compiler] ${entry} 不在 controller/ 或 service/impl/ 目录下，无法判断产物类型`);
  }

  const modules = new Set<string>();
  const bundle = await rollup({
    input: absoluteEntry,
    plugins: [
      createResolvePlugin(absoluteEntry, config.aliases ?? {}, modules),
      esbuild({
        target: "es2022",
        tsconfig: false,
        // 与应用 tsconfig 的 experimentalDecorators 保持一致：legacy 装饰器语义
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
        sourceMap: false,
      }),
    ],
    onwarn(warning) {
      if (warning.code === "EMPTY_BUNDLE" || warning.code === "MIXED_EXPORTS") return;
      console.warn(`[compiler] ${warning.code}: ${warning.message}`);
    },
  });

  try {
    const { output } = await bundle.generate({ format: "cjs", exports: "auto", sourcemap: false });
    const chunk = output.find((item) => item.type === "chunk");
    if (!chunk || chunk.type !== "chunk") {
      throw new Error(`[compiler] ${entry} 没有产出 chunk`);
    }

    const code = chunk.code;
    const version = createHash("sha256").update(code).digest("hex").slice(0, 16);

    const deps: Record<string, string> = {};
    for (const file of modules) {
      const relative = toPosix(path.relative(config.root, file));
      deps[relative] = createHash("md5").update(await readFile(file)).digest("hex");
    }

    const name = path.basename(absoluteEntry, path.extname(absoluteEntry));
    return {
      kind,
      name,
      code,
      info: {
        entry: toPosix(path.relative(config.root, absoluteEntry)),
        file: `${kind}/${name}.${version.slice(0, 8)}.js`,
        version,
        deps,
      },
    };
  } finally {
    await bundle.close();
  }
}

/** 全量构建：扫描热区，产出 controller/service bundle 与 manifest */
export async function buildAll(config: CompilerConfig): Promise<Manifest> {
  const store = createManifestStore(config.distDir);
  await mkdir(config.distDir, { recursive: true });

  const entries = (await walk(config.modulesDir)).filter((file) => entryKind(file) !== null);
  const previous = await store.read();
  const manifest: Manifest = emptyManifest();

  for (const file of entries) {
    const kind = entryKind(file);
    const name = path.basename(file, path.extname(file));
    try {
      const built = await buildArtifact(config, file);
      const target = path.join(config.distDir, built.info.file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, built.code, "utf8");
      if (built.kind === "controller") manifest.controllers[built.name] = built.info;
      else manifest.services[built.name] = built.info;
    } catch (error) {
      // 单个产物构建失败（例如依赖文件被删）不应该拖垮整次构建：
      // 保留上一版产物继续服务，其余产物照常更新
      const old = kind === "controller" ? previous?.controllers[name] : previous?.services[name];
      console.error(
        `[compiler] ${name} 构建失败：` +
          `${error instanceof Error ? error.message.split("\n")[0] : String(error)}` +
          (old ? "（保留上一版）" : "（跳过）"),
      );
      if (!old) continue;
      if (kind === "controller") manifest.controllers[name] = old;
      else manifest.services[name] = old;
    }
  }

  await store.write(manifest);
  await store.prune(manifest);
  return manifest;
}

/** 供运行时注入的构建器实现（端口定义在 @faas/core） */
export function createCompiler(config: CompilerConfig): Builder {
  return {
    build: (entry) => buildArtifact(config, entry),
    buildAll: () => buildAll(config),
    async write(built) {
      const target = path.join(config.distDir, built.info.file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, built.code, "utf8");
    },
  };
}
