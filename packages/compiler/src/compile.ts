import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";
import { createManifestStore, emptyManifest, type FileInfo, type Manifest } from "@faas/core";

export interface CompilerConfig {
  /** 项目根；manifest 里的路径相对它 */
  root: string;
  /** 热区源码目录 */
  modulesDir: string;
  /** 产物目录 */
  distDir: string;
}

export interface CompiledFile {
  info: FileInfo;
  code: string;
}

/**
 * 单文件编译：TS -> CJS，相对依赖保持 `require` 原样。
 * 这样每个文件都是一个独立模块，运行时由 loader 解析，不需要打包。
 */
export async function compileFile(sourceFile: string): Promise<CompiledFile> {
  const source = await readFile(sourceFile, "utf8");
  const { code } = await transform(source, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
    sourcemap: false,
    // 与项目 tsconfig 的 experimentalDecorators 保持一致：legacy 装饰器语义
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  });

  return {
    code,
    info: {
      file: "",
      source: "",
      version: createHash("sha256").update(code).digest("hex").slice(0, 16),
    },
  };
}

/** 按目录约定判断入口类型：`**\/controller/*.ts` / `**\/service/impl/*.ts` */
export function entryKind(relative: string): "controller" | "service" | null {
  const parts = relative.split("/");
  const parent = parts[parts.length - 2] ?? "";
  const grand = parts[parts.length - 3] ?? "";
  if (parent === "controller") return "controller";
  if (parent === "impl" && grand === "service") return "service";
  return null;
}

async function walk(dir: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walk(path.join(dir, entry.name), relative)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(relative);
    }
  }
  return files;
}

/**
 * 全量构建：把热区里的每个 `.ts` 编译成同名 `.js`，并生成 manifest。
 *
 * 单个文件编译失败时保留上一版产物与 manifest 条目（其它文件照常更新）。
 */
export async function buildAll(config: CompilerConfig): Promise<Manifest> {
  const store = createManifestStore(config.distDir);
  const previous = await store.read();
  const manifest = emptyManifest();
  const sources = await walk(config.modulesDir);

  for (const sourceRelative of sources) {
    const sourceFile = path.join(config.modulesDir, sourceRelative);
    const outputRelative = sourceRelative.replace(/\.ts$/, ".js");

    let code: string;
    let version: string;
    try {
      const compiled = await compileFile(sourceFile);
      code = compiled.code;
      version = compiled.info.version;
    } catch (error) {
      const old = previous?.files[outputRelative];
      console.error(
        `[compiler] ${sourceRelative} 编译失败：` +
          `${error instanceof Error ? error.message.split("\n")[0] : String(error)}` +
          (old ? "（保留上一版）" : "（跳过）"),
      );
      if (!old) continue;
      manifest.files[outputRelative] = old;
      continue;
    }

    const target = path.join(config.distDir, outputRelative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, code, "utf8");

    manifest.files[outputRelative] = { file: outputRelative, source: sourceRelative, version };

    const kind = entryKind(sourceRelative);
    if (kind === "controller") manifest.entries.controllers.push(outputRelative);
    else if (kind === "service") manifest.entries.services.push(outputRelative);
  }

  manifest.entries.controllers.sort();
  manifest.entries.services.sort();

  await store.write(manifest);
  await store.prune(manifest);
  return manifest;
}

export function createCompiler(config: CompilerConfig): { buildAll(): Promise<Manifest> } {
  return { buildAll: () => buildAll(config) };
}
