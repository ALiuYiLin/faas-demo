import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import * as runtimeApi from "@faas/runtime";

const hostRequire = createRequire(import.meta.url);

export interface ModuleLoader {
  /** 加载模块，返回稳定代理（已加载则复用） */
  load(relative: string): unknown;
  /** 重新求值并原地替换导出：已有引用（代理）立即看到新实现 */
  reload(relative: string): unknown;
  /** 原始导出（非代理），用于读 default 之类 */
  exportsOf(relative: string): unknown;
  has(relative: string): boolean;
}

export interface ModuleLoaderOptions {
  /** 产物根目录（部署时拉取到的目录） */
  root: string;
  /** 注入模块的共享实例，默认只有 @faas/runtime */
  shared?: Record<string, unknown>;
}

interface Entry {
  holder: { current: unknown };
  proxy: unknown;
}

/**
 * 文件级模块加载器。
 *
 * - 以「require 方所在的文件」为基准解析相对路径（和 Node 一致）；
 * - 所有模块在同一个 vm context 里求值，保证跨模块的类身份一致；
 * - 返回稳定代理，`reload` 时原地替换导出，旧的 router/实例无需重建即可调用新实现；
 * - 只允许解析 root 内的文件（防止逃逸到工程目录）。
 */
export function createModuleLoader(options: ModuleLoaderOptions): ModuleLoader {
  const root = path.resolve(options.root);
  const shared = options.shared ?? { "@faas/runtime": runtimeApi };
  const modules = new Map<string, Entry>();
  const context = vm.createContext({ console, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval });

  function resolve(fromFile: string, spec: string): string {
    if (spec.startsWith("@/")) {
      // `@/x` 约定指向模块根；兼容 `@/modules/...` 这种多一层 modules 的写法
      const withoutAlias = spec.slice(2);
      const candidates = [
        path.join(root, withoutAlias),
        path.join(root, withoutAlias.replace(/^modules\//, "")),
      ];
      for (const candidate of candidates) {
        const found = resolveCandidate(candidate);
        if (found) return found;
      }
      throw new Error(`[loader] 无法解析别名 ${spec}（from ${fromFile}）`);
    }

    const base = path.resolve(path.dirname(fromFile), spec);
    const found = resolveCandidate(base);
    if (found) return found;
    throw new Error(`[loader] 无法解析 ${spec}（from ${fromFile}）`);
  }

  function resolveCandidate(base: string): string | null {
    for (const candidate of [base, `${base}.js`, `${base}.json`, path.join(base, "index.js")]) {
      if (!candidate.startsWith(root)) continue;
      try {
        const stat = readFileSync(candidate);
        if (stat) return candidate;
      } catch {
        // 继续尝试
      }
    }
    return null;
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
    for (const [name, value] of Object.entries(shared)) {
      if (spec === name) return value;
    }
    if (!spec.startsWith(".") && !spec.startsWith("@/")) return hostRequire(spec);
    return load(relativeOf(resolve(fromFile, spec)));
  }

  function relativeOf(absolute: string): string {
    return path.relative(root, absolute).replace(/\\/g, "/");
  }

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

  function load(relative: string): unknown {
    const existing = modules.get(relative);
    if (existing) return existing.proxy;

    const holder = { current: undefined as unknown };
    const entry: Entry = { holder, proxy: undefined };
    entry.proxy = createProxy(holder);
    modules.set(relative, entry);

    holder.current = evaluate(path.join(root, relative));
    return entry.proxy;
  }

  function reload(relative: string): unknown {
    const existing = modules.get(relative);
    if (!existing) return load(relative);
    existing.holder.current = evaluate(path.join(root, relative));
    return existing.proxy;
  }

  return {
    load,
    reload,
    exportsOf(relative: string): unknown {
      return modules.get(relative)?.holder.current;
    },
    has(relative: string): boolean {
      return modules.has(relative);
    },
  };
}
