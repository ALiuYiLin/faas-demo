import { createRequire } from "node:module";
import vm from "node:vm";
import * as runtimeApi from "@faas/runtime";

/** 热区模块唯一允许的包；沙箱里 require 它时映射回宿主同一份实例 */
export const RUNTIME_MODULE = "@faas/runtime";

const hostRequire = createRequire(import.meta.url);

/** 在 vm 沙箱里执行一个 CJS bundle，返回它的导出（有 default 取 default） */
export function executeBundle(code: string, filename: string): unknown {
  const module = { exports: {} as Record<string, unknown> };
  const sandbox = {
    module,
    exports: module.exports,
    require: (id: string) => (id === RUNTIME_MODULE ? runtimeApi : hostRequire(id)),
    console,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };

  vm.createContext(sandbox);
  new vm.Script(code, { filename }).runInContext(sandbox, { timeout: 5000 });
  return module.exports.default ?? module.exports;
}
