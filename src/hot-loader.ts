import vm, { type Context } from "vm";
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";
import esbuild from "rollup-plugin-esbuild";
import { Router } from "express";
import crypto from "crypto";
import * as sharedDecorators from "@/decorators";
import * as sharedContainer from "@/container";
import * as sharedMetadata from "@/container/metadata";

/**
 * 宿主的 require。本项目是 ESM（package.json 里 "type": "module"），
 * 没有全局 require，用 createRequire 造一个，业务才能 require('express') 这类稳定依赖。
 */
const hostRequire = createRequire(import.meta.url);

/** src 目录的绝对路径，用于解析 `@/xxx` 别名。 */
const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * 与宿主共享的模块。动态代码里 import 这些 id 时，必须拿到宿主同一份实例，
 * 否则装饰器写进去的元数据在另一个注册表里，宿主看不见。
 */
const SHARED_MODULES = new Map<string, unknown>([
  ["@/decorators", sharedDecorators],
  ["@/container", sharedContainer],
  ["@/container/metadata", sharedMetadata],
]);

/**
 * 虚拟入口 id。故意不带 `\0` 前缀：rollup-plugin-esbuild 内部用 unplugin-utils 的
 * createFilter，它会跳过含 `\0` 的 id（认为不是真实文件），导致 TS 不被转译。
 */
const VIRTUAL_ID = "virtual:hot-loader-entry.ts";

export interface CompileOptions {
  /** 同步执行的超时时间（毫秒），默认 5000 */
  timeout?: number;
  /** 入口文件的绝对路径；给了它，入口里的相对导入才能解析到真实文件 */
  filename?: string;
}

/** 解析 `.ts` / `.tsx` / `.js` / 目录 index 之类的真实文件 */
async function resolveFile(target: string): Promise<string | null> {
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.js`,
    path.join(target, "index.ts"),
    path.join(target, "index.tsx"),
    path.join(target, "index.js"),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // 不存在，继续试下一个
    }
  }
  return null;
}

/**
 * TS + ESM 源码 -> CJS 字符串。
 *
 * - rollup 负责 ESM -> CJS（import/export 语义、default 互操作）；
 * - rollup-plugin-esbuild 负责 TS -> JS（去类型、enum、装饰器等）；
 * - `@/xxx` 解析到 src 下的真实文件，相对导入解析到真实文件；
 * - 裸模块（express、node:path…）和 `@/decorators`、`@/container` 保持 external，
 *   产物里保留 require()，运行时由沙箱的 require 解析。
 */
export async function codeTransform(code: string, filename?: string): Promise<string> {
  const entryId = filename && path.isAbsolute(filename) ? filename : VIRTUAL_ID;

  const bundle = await rollup({
    input: entryId,
    plugins: [
      {
        name: "hot-loader:resolve",
        async resolveId(id, importer) {
          if (id === entryId) return entryId;

          // 宿主共享模块：不打包，保留 require("@/container") 由沙箱映射回宿主实例
          if (SHARED_MODULES.has(id)) return { id, external: true };

          // 路径别名 @/xxx -> src/xxx
          if (id.startsWith("@/")) {
            return resolveFile(path.join(SRC_DIR, id.slice(2)));
          }

          // 相对导入：相对 importer 的真实路径解析
          if (id.startsWith(".")) {
            if (!importer) return null;
            return resolveFile(path.resolve(path.dirname(importer), id));
          }

          // 其它裸模块（express、node:path…）交给宿主 require
          return { id, external: true };
        },
        async load(id) {
          if (id === entryId) return code;
          // 真实文件（@/ 与相对导入解析出来的）从磁盘读
          if (path.isAbsolute(id)) {
            try {
              return await readFile(id, "utf8");
            } catch {
              return null;
            }
          }
          return null;
        },
      },
      esbuild({
        target: "es2022",
        tsconfig: false, // 单文件转译，不读项目 tsconfig
        // 与项目 tsconfig 的 experimentalDecorators 保持一致：legacy 装饰器语义
        // （标准装饰器语义是 (value, context)，legacy 是 (target, key, descriptor)，两者不通用）
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
        sourceMap: false,
      }),
    ],
    // 动态代码会 import 表达式的相关模块，空 chunk / 未解析导入都不算问题；
    // default + 命名导出混用时 rollup 会告警，而 compile() 已统一取 default，可忽略。
    onwarn(warning) {
      if (
        warning.code === "EMPTY_BUNDLE" ||
        warning.code === "UNRESOLVED_IMPORT" ||
        warning.code === "MIXED_EXPORTS"
      ) {
        return;
      }
      console.warn(`[hot-loader] ${warning.code}: ${warning.message}`);
    },
  });

  try {
    const { output } = await bundle.generate({
      format: "cjs",
      exports: "auto", // 只有 default 时直接 module.exports = 值
      sourcemap: false,
    });
    const chunk = output.find((item) => item.type === "chunk");
    if (!chunk || chunk.type !== "chunk") {
      throw new Error("hot-loader: rollup 没有产出 chunk");
    }
    return chunk.code;
  } finally {
    await bundle.close();
  }
}

/** 沙箱里的 require：优先命中共享模块，其余走宿主 require。 */
function sandboxRequire(id: string): unknown {
  const shared = SHARED_MODULES.get(id);
  if (shared) return shared;
  return hostRequire(id);
}

/**
 * 编译并执行一段 TS/ESM 源码，返回它的导出：有 `export default` 就取 default，
 * 否则返回整个 `module.exports`（对象或函数均可）。
 */
export async function compile<T = unknown>(
  code: string,
  options: CompileOptions = {},
): Promise<T> {
  const { timeout = 5000, filename = "hot-loader.ts" } = options;
  const cjsCode = await codeTransform(code, filename);

  const module: { exports: Record<string, unknown> } = { exports: {} };
  const sandbox: Context = {
    module,
    exports: module.exports,
    require: sandboxRequire, // 共享模块直通宿主实例，其余走宿主 require
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };

  vm.createContext(sandbox);
  new vm.Script(cjsCode, { filename }).runInContext(sandbox, { timeout });

  const exported = module.exports;
  return (exported.default ?? exported) as T;
}

export class HotLoader {
  currentRouter: Router | null = null;
  currentFileMd5: string | null = null;

  async checkAndSwap() {
    const filePath = path.join(import.meta.dirname, "router/index.ts");
    const code = await readFile(filePath, "utf8");
    const md5 = crypto.createHash("md5").update(code, "utf-8").digest("hex");
    if (md5 !== this.currentFileMd5) {
      console.log("===正在重新启动===");
      const router = await compile<Router>(code, { filename: filePath });
      this.currentRouter = router;
      this.currentFileMd5 = md5;
    }
  }

  async init() {
    await this.checkAndSwap();
    setInterval(() => this.checkAndSwap(), 20000);
  }

  getRouter() {
    return this.currentRouter;
  }
}
