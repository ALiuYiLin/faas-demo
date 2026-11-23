import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import express, { type Router } from "express";
import * as runtimeApi from "@/runtime";
import { appContext } from "@/runtime/app-context";
import { beginCapture, classMeta, endCapture } from "@/runtime/context";
import {
  buildAll,
  buildArtifact,
  saveManifest,
  type ArtifactInfo,
  type BuiltArtifact,
  type Manifest,
} from "@/build/artifact";
import { DIST, MODULES, ROOT, RUNTIME_MODULE, toPosix } from "@/paths";
import { watchModules } from "./watcher";

const hostRequire = createRequire(import.meta.url);

export interface ServiceRecord {
  /** 产物名（文件名去扩展名），如 UserServiceImpl */
  name: string;
  /** 注册到容器的 bean 名，如 userService */
  beanName: string;
  type: Function;
  version: string;
  file: string;
  entry: string;
  deps: Record<string, string>;
}

export interface ControllerRecord {
  name: string;
  prefix: string;
  router: Router;
  type: Function;
  version: string;
  file: string;
  entry: string;
  deps: Record<string, string>;
  /** 注入的 bean 名：service 变化时据此做"宽判据"重建 */
  beanDeps: string[];
}

/** 在 vm 沙箱里执行一个 CJS bundle；`@faas/runtime` 映射回宿主实例 */
function executeBundle(code: string, filename: string): unknown {
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

export class Registry {
  readonly services = new Map<string, ServiceRecord>();
  readonly controllers = new Map<string, ControllerRecord>();

  private composed: Router = express.Router();
  private manifest: Manifest;
  private stopWatching?: () => void;

  constructor(manifest: Manifest) {
    this.manifest = manifest;
  }

  async loadAll(): Promise<void> {
    // 先 service 后 controller：controller 的 @Resource 虽然是懒解析，但先装好更直观
    for (const [name, info] of Object.entries(this.manifest.services)) {
      await this.loadService(name, info);
    }
    for (const [name, info] of Object.entries(this.manifest.controllers)) {
      await this.loadController(name, info);
    }
    this.rebuildRouter();
  }

  /** 入口中间件：每次请求抓一次 composed 快照，换版不影响进行中的请求 */
  handle(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const router = this.composed;
    router(req, res, next);
  }

  private rebuildRouter(): void {
    const next = express.Router();
    for (const record of this.controllers.values()) {
      next.use(record.prefix, record.router);
    }
    this.composed = next;
  }

  /* ------------------------------ 加载 ------------------------------ */

  private async loadService(name: string, info: ArtifactInfo): Promise<void> {
    const file = path.join(DIST, info.file);
    const code = await readFile(file, "utf8");

    const capture = beginCapture();
    try {
      appContext.withReplace(() => executeBundle(code, file));
    } finally {
      endCapture();
    }

    const registered = capture.beans[0];
    if (!registered) {
      throw new Error(`[registry] service 产物 ${name} 没有注册任何 bean`);
    }

    const previous = this.services.get(name);
    if (previous) {
      if (previous.beanName !== registered.name) appContext.removeBean(previous.beanName);
      // 驱逐旧实例：注入方是 getter，下次访问自然拿到新单例
      appContext.forget(previous.type);
    }

    this.services.set(name, {
      name,
      beanName: registered.name,
      type: registered.type,
      version: info.version,
      file,
      entry: info.entry,
      deps: info.deps,
    });
  }

  private async loadController(name: string, info: ArtifactInfo): Promise<void> {
    const file = path.join(DIST, info.file);
    const code = await readFile(file, "utf8");

    const capture = beginCapture();
    let exported: unknown;
    try {
      exported = executeBundle(code, file);
    } finally {
      endCapture();
    }

    const type = capture.controllers[0];
    if (!type) {
      throw new Error(
        `[registry] controller 产物 ${name} 没有注册 @Controller。` +
          `最常见的原因是产物过期或源码为空（bundle 里没有任何装饰器调用），` +
          `重跑 pnpm build:modules 即可`,
      );
    }
    if (typeof exported !== "function") {
      throw new Error(`[registry] controller 产物 ${name} 的默认导出不是 router`);
    }

    const meta = classMeta(type);
    const previous = this.controllers.get(name);
    if (previous) appContext.forget(previous.type);

    this.controllers.set(name, {
      name,
      prefix: meta.path ?? "/",
      router: exported as Router,
      type,
      version: info.version,
      file,
      entry: info.entry,
      deps: info.deps,
      beanDeps: meta.injects.map((inject) => inject.ref ?? String(inject.property)),
    });
  }

  /* ------------------------------ 重载 ------------------------------ */

  async reloadController(name: string): Promise<boolean> {
    const current = this.controllers.get(name);
    if (!current) return false;
    return this.applyController(current.entry, (built) => built.info.version !== current.version);
  }

  async reloadService(name: string): Promise<boolean> {
    const current = this.services.get(name);
    if (!current) return false;
    return this.applyService(current.entry, (built) => built.info.version !== current.version);
  }

  /** 构建 + hash 去抖：产物没变就只更新依赖指纹，不 swap */
  private async applyController(entry: string, shouldSwap: (built: BuiltArtifact) => boolean): Promise<boolean> {
    const built = await buildArtifact(entry);
    const name = built.name;
    const current = this.controllers.get(name);

    if (current && !shouldSwap(built)) {
      current.deps = built.info.deps;
      await this.syncManifest("controllers", name, built.info);
      console.log(`[registry] controller ${name} 依赖变动但产物一致，跳过 swap`);
      return false;
    }

    await this.writeBundle(built);
    await this.loadController(name, built.info);
    await this.syncManifest("controllers", name, built.info);
    this.rebuildRouter();
    console.log(`[registry] controller ${name} -> ${built.info.version} (${countRoutes(this.controllers.get(name))} routes)`);
    return true;
  }

  private async applyService(entry: string, shouldSwap: (built: BuiltArtifact) => boolean): Promise<boolean> {
    const built = await buildArtifact(entry);
    const name = built.name;
    const current = this.services.get(name);

    if (current && !shouldSwap(built)) {
      current.deps = built.info.deps;
      await this.syncManifest("services", name, built.info);
      return false;
    }

    await this.writeBundle(built);
    await this.loadService(name, built.info);
    await this.syncManifest("services", name, built.info);
    console.log(`[registry] service ${name} -> ${built.info.version}`);
    return true;
  }

  private async writeBundle(built: BuiltArtifact): Promise<void> {
    const target = path.join(DIST, built.info.file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, built.code, "utf8");
  }

  private async syncManifest(
    kind: "services" | "controllers",
    name: string,
    info: ArtifactInfo,
  ): Promise<void> {
    this.manifest[kind][name] = info;
    this.manifest.builtAt = new Date().toISOString();
    // 必须落盘：否则进程重启后 readManifest() 会拿到旧版本
    await saveManifest(this.manifest);
  }

  /* ------------------------------ 文件变更 ------------------------------ */

  startWatching(): void {
    this.stopWatching = watchModules((relative) => {
      void this.handleFileChange(relative);
    });
  }

  stopWatch(): void {
    this.stopWatching?.();
    this.stopWatching = undefined;
  }

  private async handleFileChange(relative: string): Promise<void> {
    // 文件被删除、构建失败……都不能让平台挂掉：兜住一切异常，保留当前可用的版本
    try {
      await this.applyChange(relative);
    } catch (error) {
      console.error(
        `[registry] 处理变更失败，保留现有版本（${relative}）：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async applyChange(relative: string): Promise<void> {
    // 删除：入口文件消失 → 全量重扫，产物随之从 registry 移除
    if (!(await this.fileExists(path.join(ROOT, relative)))) {
      console.log(`[registry] ${relative} 已删除，重新扫描`);
      await this.rescan();
      return;
    }

    const serviceHits = [...this.services.values()].filter((record) => relative in record.deps);
    const controllerHits = [...this.controllers.values()].filter((record) => relative in record.deps);

    if (serviceHits.length === 0 && controllerHits.length === 0) {
      if (this.isHotZone(relative)) {
        console.log(`[registry] ${relative} 是新增的入口，全量重建`);
        await this.rescan();
      }
      return;
    }

    console.log(`[registry] 变更 ${relative}`);
    for (const record of serviceHits) await this.reloadService(record.name);

    // 宽判据：service 变了，依赖它的 controller 也重建一次（产物一致则跳过 swap）
    for (const record of serviceHits) {
      for (const controller of [...this.controllers.values()]) {
        if (controller.beanDeps.includes(record.beanName)) await this.reloadController(controller.name);
      }
    }

    for (const record of controllerHits) await this.reloadController(record.name);
  }

  private async fileExists(file: string): Promise<boolean> {
    try {
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  }

  private isHotZone(relative: string): boolean {
    return relative.startsWith(`${toPosix(path.relative(ROOT, MODULES))}/`);
  }

  private async rescan(): Promise<void> {
    this.manifest = await buildAll();

    // 产物消失（源码被删）→ 从 registry 移除并重建路由表
    for (const [name, record] of [...this.controllers]) {
      if (!this.manifest.controllers[name]) {
        this.controllers.delete(name);
        appContext.forget(record.type);
        console.log(`[registry] 已移除 controller ${name}`);
      }
    }
    for (const [name, record] of [...this.services]) {
      if (!this.manifest.services[name]) {
        this.services.delete(name);
        appContext.removeBean(record.beanName);
        console.log(`[registry] 已移除 service ${name}`);
      }
    }

    for (const [name, info] of Object.entries(this.manifest.services)) {
      const current = this.services.get(name);
      if (!current || current.version !== info.version) await this.loadService(name, info);
    }
    for (const [name, info] of Object.entries(this.manifest.controllers)) {
      const current = this.controllers.get(name);
      if (!current || current.version !== info.version) await this.loadController(name, info);
    }
    this.rebuildRouter();
  }

  /* ------------------------------ 观测 ------------------------------ */

  describe(): unknown {
    return {
      builtAt: this.manifest.builtAt,
      services: [...this.services.values()].map((record) => ({
        artifact: record.name,
        bean: record.beanName,
        version: record.version,
      })),
      controllers: [...this.controllers.values()].map((record) => ({
        artifact: record.name,
        prefix: record.prefix,
        version: record.version,
        beanDeps: record.beanDeps,
        routes: classMeta(record.type).routes.map((route) => `${route.method.toUpperCase()} ${record.prefix}${route.path}`),
      })),
    };
  }
}

function countRoutes(record: ControllerRecord | undefined): number {
  return record ? classMeta(record.type).routes.length : 0;
}

