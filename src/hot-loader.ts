import vm, { type Context } from "vm";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { rollup } from "rollup";
import esbuild from "rollup-plugin-esbuild";
import { Router } from "express";
import crypto from 'crypto'
/**
 * 宿主的 require。本项目是 ESM（package.json 里 "type": "module"），
 * 没有全局 require，用 createRequire 造一个，业务才能 require('express') 这类稳定依赖。
 */
const hostRequire = createRequire(import.meta.url);

/**
 * 虚拟入口 id。故意不带 `\0` 前缀：rollup-plugin-esbuild 内部用 unplugin-utils 的
 * createFilter，它会跳过含 `\0` 的 id（认为不是真实文件），导致 TS 不被转译。
 */
const VIRTUAL_ID = "virtual:hot-loader-entry.ts";

export interface CompileOptions {
  /** 同步执行的超时时间（毫秒），默认 5000 */
  timeout?: number;
  /** 出现在错误堆栈里的文件名 */
  filename?: string;
}

/**
 * TS + ESM 源码 -> CJS 字符串。
 *
 * - rollup 负责 ESM -> CJS（import/export 语义、default 互操作）；
 * - rollup-plugin-esbuild 负责 TS -> JS（去类型、enum、装饰器等）。
 * - 裸模块（express、node:path…）一律 external，产物里保留 require()，运行时由沙箱解析。
 */
export async function codeTransform(code: string): Promise<string> {
  const bundle = await rollup({
    input: VIRTUAL_ID,
    external: (id) =>
      id !== VIRTUAL_ID && !id.startsWith(".") && !path.isAbsolute(id),
    plugins: [
      {
        name: "hot-loader:virtual-entry",
        resolveId(id) {
          if (id === VIRTUAL_ID) return VIRTUAL_ID;
        },
        load(id) {
          if (id === VIRTUAL_ID) return code;
        },
      },
      esbuild({
        target: "es2022",
        tsconfig: false, // 单文件转译，不读项目 tsconfig
        sourceMap: false,
      }),
    ],
    // 用户代码是单文件，没有 bundle 任何依赖，空 chunk / 未解析导入都不算问题；
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


/**
 * 编译并执行一段 TS/ESM 源码，返回它的导出：有 `export default` 就取 default，
 * 否则返回整个 `module.exports`（对象或函数均可）。
 */
export async function compile<T = unknown>(
  code: string,
  options: CompileOptions = {},
): Promise<T> {
  const { timeout = 5000, filename = "hot-loader.ts" } = options;
  const cjsCode = await codeTransform(code);

  const module: { exports: Record<string, unknown> } = { exports: {} };
  const sandbox: Context = {
    module,
    exports: module.exports,
    require: hostRequire, // 共享宿主的 require，业务可直接 require('express') 等稳定依赖
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
  currentRouter: Router | null = null
  currentFileMd5: string | null = null
  async checkAndSwap(){
    const filePath = './src/router/index.ts'
    const code = await readFile(filePath, "utf8");
    const md5 = crypto.createHash('md5').update(code,'utf-8').digest('hex')
    if(md5 !== this.currentFileMd5){
      console.log("===正在重新启动===");
      const router = await compile<Router>(code)
      this.currentRouter = router
      this.currentFileMd5 = md5
    }
  }
  async init(){
    await this.checkAndSwap()
    setInterval(()=> this.checkAndSwap(), 20000)
  }
  getRouter(){
    return this.currentRouter
  }
}
