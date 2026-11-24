/**
 * 原型验证：按文件加载（不打包）+ 模块代理，验证「utils 更新后 router/controller 不重新求值也能调用到新实现」。
 *
 * 运行：node node_modules/vite-node/dist/cli.mjs scripts/prototype-file-modules.ts
 *
 * 这只是验证脚本，不改变现有 bundle 流程。
 */
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";
import * as runtimeApi from "../packages/runtime/src/index.ts";

const hostRequire = createRequire(import.meta.url);

/* ------------------------------------------------------------------ *
 * 1) 逐文件编译：TS -> CJS，依赖保持 require
 * ------------------------------------------------------------------ */

function compileFile(sourceFile: string, outFile: string): void {
  const source = readFileSync(sourceFile, "utf8");
  const { code } = transformSync(source, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  });
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, code, "utf8");
}

function compileTree(srcDir: string, outDir: string, files: string[]): void {
  for (const relative of files) {
    compileFile(path.join(srcDir, relative), path.join(outDir, relative.replace(/\.ts$/, ".js")));
  }
}

/* ------------------------------------------------------------------ *
 * 2) 模块加载器：相对解析 + 单实例缓存 + live proxy
 * ------------------------------------------------------------------ */

interface ModuleEntry {
  holder: { current: unknown };
  proxy: unknown;
  /** 这个文件被求值了几次（用来断言 controller 没有被重新求值） */
  evaluations: number;
}

function createLoader(root: string) {
  const modules = new Map<string, ModuleEntry>();
  // 所有模块跑在同一个 realm 里，保证类身份一致（跨 realm 会让 instanceof 失效）
  const context = vm.createContext({ console, process, Buffer, setTimeout, clearTimeout });

  function resolve(fromFile: string, spec: string): string {
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const candidate of [base, `${base}.js`, path.join(base, "index.js")]) {
      try {
        readFileSync(candidate);
        return candidate;
      } catch {
        // 继续尝试
      }
    }
    throw new Error(`[loader] 无法解析 ${spec}（from ${fromFile}）`);
  }

  function evaluate(file: string): unknown {
    const code = readFileSync(file, "utf8");
    const module = { exports: {} as Record<string, unknown> };
    const wrapper = `(function (exports, require, module, __filename, __dirname) {\n${code}\n})`;
    const factory = vm.runInContext(wrapper, context, { filename: file }) as (
      exports: unknown,
      require: (spec: string) => unknown,
      module: { exports: unknown },
      filename: string,
      dirname: string,
    ) => void;

    factory(
      module.exports,
      (spec: string) => requireFrom(file, spec),
      module,
      file,
      path.dirname(file),
    );
    return module.exports;
  }

  function requireFrom(fromFile: string, spec: string): unknown {
    if (spec === "@faas/runtime") return runtimeApi;
    if (!spec.startsWith(".")) return hostRequire(spec);
    return load(resolve(fromFile, spec));
  }

  /** 返回稳定代理：调用/取值都转发到 holder.current */
  function createProxy(holder: { current: unknown }): unknown {
    return new Proxy(function liveModule() {} as unknown as object, {
      get(_target, key) {
        const value = (holder.current as Record<PropertyKey, unknown>)?.[key];
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(holder.current)
          : value;
      },
      apply(_target, thisArg, args) {
        return Reflect.apply(holder.current as (...a: unknown[]) => unknown, thisArg, args);
      },
      construct(_target, args, newTarget) {
        return Reflect.construct(holder.current as new (...a: unknown[]) => unknown, args, newTarget);
      },
      has(_target, key) {
        return key in ((holder.current as object) ?? {});
      },
      ownKeys() {
        return Reflect.ownKeys((holder.current as object) ?? {});
      },
      getOwnPropertyDescriptor(_target, key) {
        return (
          Reflect.getOwnPropertyDescriptor((holder.current as object) ?? {}, key) ?? {
            configurable: true,
            enumerable: true,
          }
        );
      },
    });
  }

  function load(file: string): unknown {
    const existing = modules.get(file);
    if (existing) return existing.proxy;

    const holder = { current: undefined as unknown };
    const entry: ModuleEntry = { holder, proxy: undefined, evaluations: 0 };
    entry.proxy = createProxy(holder);
    modules.set(file, entry);

    holder.current = evaluate(file);
    entry.evaluations += 1;
    return entry.proxy;
  }

  /** 模拟"磁盘上的文件更新了"：重新求值并原地替换 exports，已有引用立即生效 */
  function reload(file: string): void {
    const entry = modules.get(file);
    if (!entry) {
      load(file);
      return;
    }
    entry.holder.current = evaluate(file);
    entry.evaluations += 1;
  }

  return { load, reload, stats: () => modules };
}

/* ------------------------------------------------------------------ *
 * 3) 场景
 * ------------------------------------------------------------------ */

const work = mkdtempSync(path.join(tmpdir(), "faas-filemode-"));
const srcDir = path.join(work, "src");
const outDir = path.join(work, "dist");

const controller = (name: string) => `
import { ns } from "../utils/index.js";
export function call(): string {
  return ns();
}
export const controllerName = "${name}";
`;

const util = (version: string) => `
export function ns(): string {
  return "util ${version}";
}
`;

// 对照组：手写解构会拷贝函数引用，更新后不会生效（这是必须知道的约束）
const destructuringController = `
const { ns } = require("../utils/index.js");
export function call(): string {
  return ns();
}
`;

const files = ["utils/index.ts", "controller/A.ts", "controller/B.ts", "controller/C.ts"];
for (const file of files) {
  const full = path.join(srcDir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  const content = file.startsWith("utils")
    ? util("v1")
    : path.basename(file) === "C.ts"
      ? destructuringController
      : controller(path.basename(file, ".ts"));
  writeFileSync(full, content);
}
compileTree(srcDir, outDir, files);

const loader = createLoader(outDir);
const fileA = path.join(outDir, "controller", "A.js");
const fileB = path.join(outDir, "controller", "B.js");
const utilFile = path.join(outDir, "utils", "index.js");

const a = loader.load(fileA) as { call(): string };
const b = loader.load(fileB) as { call(): string };
const c = loader.load(path.join(outDir, "controller", "C.js")) as { call(): string };

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail: string) => results.push([name, ok, detail]);

check("两个 controller 共享同一个 util 模块实例", loader.stats().get(utilFile)?.evaluations === 1, `evaluations=${loader.stats().get(utilFile)?.evaluations}`);
check("初始调用走 v1（A/B 一致）", a.call() === "util v1" && b.call() === "util v1", `${a.call()} / ${b.call()}`);

// 模拟：utils 被更新并拉到本地目录
writeFileSync(path.join(srcDir, "utils/index.ts"), util("v2"));
compileFile(path.join(srcDir, "utils/index.ts"), utilFile);
loader.reload(utilFile);

check("utils 更新后 A 立即调用到 v2", a.call() === "util v2", a.call());
check("utils 更新后 B 立即调用到 v2", b.call() === "util v2", b.call());
check(
  "controller 没有被重新求值（router 不需要重建）",
  loader.stats().get(fileA)?.evaluations === 1 && loader.stats().get(fileB)?.evaluations === 1,
  `A=${loader.stats().get(fileA)?.evaluations} B=${loader.stats().get(fileB)?.evaluations}`,
);

// 对照：controller 自身文件变化时，才需要重新加载（此时调用方拿到的是新代理）
const a2 = loader.load(fileA) as { call(): string };
loader.reload(fileA);
check("controller 文件自身变化后仍是同一实例的代理语义", a2.call() === "util v2", a2.call());
check("对照：手写解构会保留旧引用（已知约束，需用 ESM import）", c.call() === "util v1", c.call());

const failed = results.filter(([, ok]) => !ok);
console.log(`\n工作目录: ${work}\n`);
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
}
console.log(`\n${failed.length === 0 ? "✅ 全部通过" : `❌ ${failed.length} 项失败`}`);
process.exit(failed.length === 0 ? 0 : 1);
