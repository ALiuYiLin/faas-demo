import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { rollup, type Plugin } from "rollup";
import esbuild from "rollup-plugin-esbuild";
import { DIST, MANIFEST, MODULES, ROOT, RUNTIME_MODULE, SRC, toPosix } from "@/paths";

/** 一个构建产物的描述，写进 manifest */
export interface ArtifactInfo {
  /** 入口源码，相对项目根 */
  entry: string;
  /** 产物文件，相对 dist/modules */
  file: string;
  /** bundle 内容哈希（sha256 前 16 位），换版判断依据 */
  version: string;
  /** 打进来的源文件 -> md5（传递闭包），用于增量重建 */
  deps: Record<string, string>;
}

export interface Manifest {
  manifestVersion: 1;
  builtAt: string;
  runtime: string;
  services: Record<string, ArtifactInfo>;
  controllers: Record<string, ArtifactInfo>;
}

export type ArtifactKind = "controller" | "service";

export interface BuiltArtifact {
  info: ArtifactInfo;
  code: string;
  kind: ArtifactKind;
  name: string;
}

const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js"];

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function resolveFile(target: string): Promise<string | null> {
  const candidates = [
    ...RESOLVE_SUFFIXES.map((suffix) => target + suffix),
    ...RESOLVE_SUFFIXES.slice(1).map((suffix) => path.join(target, `index${suffix}`)),
  ];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

/** 构建期插件：解析 `@/` 与相对导入，`@faas/runtime` 和裸模块保持 external */
function resolvePlugin(entry: string, modules: Set<string>): Plugin {
  return {
    name: "faas:resolve",
    async resolveId(id, importer) {
      if (id === entry) return entry;
      if (id === RUNTIME_MODULE) return { id, external: true };
      if (id.startsWith("@/")) return resolveFile(path.join(SRC, id.slice(2)));
      if (id.startsWith(".")) {
        if (!importer) return null;
        return resolveFile(path.resolve(path.dirname(importer), id));
      }
      return { id, external: true };
    },
    async load(id) {
      if (!path.isAbsolute(id)) return null;
      try {
        return await readFile(id, "utf8");
      } catch {
        return null;
      }
    },
    /** 收集真正进了 bundle 的模块（含传递依赖），用于依赖指纹 */
    buildEnd() {
      for (const id of this.getModuleIds()) {
        if (path.isAbsolute(id)) modules.add(id);
      }
    },
  };
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
export async function buildArtifact(entryPath: string): Promise<BuiltArtifact> {
  const absoluteEntry = path.resolve(ROOT, entryPath);
  const kind = entryKind(absoluteEntry);
  if (!kind) {
    throw new Error(`[build] ${entryPath} 不在 controller/ 或 service/impl/ 目录下，无法判断产物类型`);
  }

  const modules = new Set<string>();
  const bundle = await rollup({
    input: absoluteEntry,
    plugins: [
      resolvePlugin(absoluteEntry, modules),
      esbuild({
        target: "es2022",
        tsconfig: false,
        // 与项目 tsconfig 的 experimentalDecorators 保持一致：legacy 装饰器语义
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
        sourceMap: false,
      }),
    ],
    onwarn(warning) {
      if (warning.code === "EMPTY_BUNDLE" || warning.code === "MIXED_EXPORTS") return;
      console.warn(`[build] ${warning.code}: ${warning.message}`);
    },
  });

  try {
    const { output } = await bundle.generate({ format: "cjs", exports: "auto", sourcemap: false });
    const chunk = output.find((item) => item.type === "chunk");
    if (!chunk || chunk.type !== "chunk") {
      throw new Error(`[build] ${entryPath} 没有产出 chunk`);
    }

    const code = chunk.code;
    const version = createHash("sha256").update(code).digest("hex").slice(0, 16);

    const deps: Record<string, string> = {};
    for (const file of modules) {
      const relative = toPosix(path.relative(ROOT, file));
      deps[relative] = createHash("md5").update(await readFile(file)).digest("hex");
    }

    const name = path.basename(absoluteEntry, path.extname(absoluteEntry));
    const info: ArtifactInfo = {
      entry: toPosix(path.relative(ROOT, absoluteEntry)),
      file: `${kind}/${name}.${version.slice(0, 8)}.js`,
      version,
      deps,
    };

    return { info, code, kind, name };
  } finally {
    await bundle.close();
  }
}

/** 全量构建：扫描热区，产出 controller/service bundle 与 manifest */
export async function buildAll(): Promise<Manifest> {
  await mkdir(DIST, { recursive: true });

  const entries = (await walk(MODULES)).filter((file) => entryKind(file) !== null);
  const manifest: Manifest = {
    manifestVersion: 1,
    builtAt: new Date().toISOString(),
    runtime: "^1.0.0",
    services: {},
    controllers: {},
  };

  for (const file of entries) {
    const built = await buildArtifact(file);
    const target = path.join(DIST, built.info.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, built.code, "utf8");
    if (built.kind === "controller") manifest.controllers[built.name] = built.info;
    else manifest.services[built.name] = built.info;
  }

  await writeManifest(manifest);
  await pruneStale(manifest);
  return manifest;
}

async function writeManifest(manifest: Manifest): Promise<void> {
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function pruneStale(manifest: Manifest): Promise<void> {
  const keep = new Set(
    [...Object.values(manifest.controllers), ...Object.values(manifest.services)].map((info) =>
      path.join(DIST, info.file),
    ),
  );
  for (const kind of ["controller", "service"] as const) {
    const dir = path.join(DIST, kind);
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const full = path.join(dir, file);
      if (!keep.has(full)) await rm(full, { force: true });
    }
  }
}

/** 落盘 manifest（热重载换版后必须调用，否则重启会加载到旧版本）并清理旧 bundle */
export async function saveManifest(manifest: Manifest): Promise<void> {
  await writeManifest(manifest);
  await pruneStale(manifest);
}

export async function readManifest(): Promise<Manifest | null> {
  try {
    const raw = await readFile(MANIFEST, "utf8");
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}
