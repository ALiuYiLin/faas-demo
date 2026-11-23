import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { RequestHandler, Router } from "express";
import { appContext, beginCapture, classMeta, endCapture } from "@faas/runtime/internal";
import type { Builder } from "./builder";
import {
  createManifestStore,
  emptyManifest,
  type ArtifactInfo,
  type Manifest,
  type ManifestStore,
} from "./manifest";
import { RouterTable } from "./router-table";
import { executeBundle } from "./sandbox";

export interface RegistryOptions {
  /** 项目根，manifest 里的相对路径都相对它 */
  root: string;
  /** 热区源码目录（用于判断变更是否属于热区、定位入口文件） */
  modulesDir: string;
  /** 产物目录（bundle + manifest.json） */
  distDir: string;
  /** 开发期注入；线上不注入，只加载预构建产物 */
  builder?: Builder;
}

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

/**
 * 模块注册表：加载产物、换版、组合路由表。
 *
 * 它只依赖 `Builder` 端口，不 import rollup —— 生产依赖树里不会出现构建器。
 */
export class Registry {
  readonly services = new Map<string, ServiceRecord>();
  readonly controllers = new Map<string, ControllerRecord>();

  private readonly options: RegistryOptions;
  private readonly store: ManifestStore;
  private readonly routerTable = new RouterTable();
  private manifest: Manifest = emptyManifest();

  constructor(options: RegistryOptions) {
    this.options = options;
    this.store = createManifestStore(options.distDir);
  }

  /** 入口中间件：换版只替换内部 composed，Express 路由表永不改动 */
  readonly handle: RequestHandler = (req, res, next) => this.routerTable.handle(req, res, next);

  get manifestStore(): ManifestStore {
    return this.store;
  }

  async loadAll(manifest: Manifest): Promise<void> {
    this.manifest = manifest;
    // 先 service 后 controller：controller 的 @Resource 虽是懒解析，但先装好更直观
    for (const [name, info] of Object.entries(manifest.services)) {
      await this.loadService(name, info);
    }
    for (const [name, info] of Object.entries(manifest.controllers)) {
      await this.loadController(name, info);
    }
    this.rebuildRouter();
  }

  /* ------------------------------ 加载 ------------------------------ */

  private async loadService(name: string, info: ArtifactInfo): Promise<void> {
    const file = path.join(this.options.distDir, info.file);
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
    const file = path.join(this.options.distDir, info.file);
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
          `最常见的原因是产物过期或源码为空（bundle 里没有任何装饰器调用），重跑构建即可`,
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
      router: exported as unknown as Router,
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

    const built = await this.builder().build(current.entry);
    if (built.info.version === current.version) {
      current.deps = built.info.deps;
      await this.syncManifest("controllers", name, built.info);
      console.log(`[registry] controller ${name} 依赖变动但产物一致，跳过 swap`);
      return false;
    }

    await this.builder().write(built);
    await this.loadController(name, built.info);
    await this.syncManifest("controllers", name, built.info);
    this.rebuildRouter();
    console.log(
      `[registry] controller ${name} -> ${built.info.version} (${countRoutes(this.controllers.get(name))} routes)`,
    );
    return true;
  }

  async reloadService(name: string): Promise<boolean> {
    const current = this.services.get(name);
    if (!current) return false;

    const built = await this.builder().build(current.entry);
    if (built.info.version === current.version) {
      current.deps = built.info.deps;
      await this.syncManifest("services", name, built.info);
      return false;
    }

    await this.builder().write(built);
    await this.loadService(name, built.info);
    await this.syncManifest("services", name, built.info);
    console.log(`[registry] service ${name} -> ${built.info.version}`);
    return true;
  }

  /* ------------------------------ 文件变更 ------------------------------ */

  /** 处理一个源文件变更（由 @faas/dev 的 watcher 调用）；任何异常都不外抛 */
  async applyChange(relative: string): Promise<void> {
    try {
      await this.applyChangeInner(relative);
    } catch (error) {
      console.error(
        `[registry] 处理变更失败，保留现有版本（${relative}）：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async applyChangeInner(relative: string): Promise<void> {
    // 删除：入口文件消失 → 全量重扫，产物随之从 registry 移除
    if (!(await this.fileExists(path.join(this.options.root, relative)))) {
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

    // 宽判据：service 变了，注入它的 controller 也重建一次（产物一致则跳过 swap）
    for (const record of serviceHits) {
      for (const controller of [...this.controllers.values()]) {
        if (controller.beanDeps.includes(record.beanName)) await this.reloadController(controller.name);
      }
    }

    for (const record of controllerHits) await this.reloadController(record.name);
  }

  private async rescan(): Promise<void> {
    const manifest = await this.builder().buildAll();
    await this.applyManifest(manifest);
  }

  private async applyManifest(manifest: Manifest): Promise<void> {
    this.manifest = manifest;

    for (const [name, record] of [...this.controllers]) {
      if (!manifest.controllers[name]) {
        this.controllers.delete(name);
        appContext.forget(record.type);
        console.log(`[registry] 已移除 controller ${name}`);
      }
    }
    for (const [name, record] of [...this.services]) {
      if (!manifest.services[name]) {
        this.services.delete(name);
        appContext.removeBean(record.beanName);
        console.log(`[registry] 已移除 service ${name}`);
      }
    }

    for (const [name, info] of Object.entries(manifest.services)) {
      const current = this.services.get(name);
      if (!current || current.version !== info.version) await this.loadService(name, info);
    }
    for (const [name, info] of Object.entries(manifest.controllers)) {
      const current = this.controllers.get(name);
      if (!current || current.version !== info.version) await this.loadController(name, info);
    }
    this.rebuildRouter();
  }

  /* ------------------------------ 内部 ------------------------------ */

  private builder(): Builder {
    if (!this.options.builder) {
      throw new Error(
        "[registry] 没有注入 Builder，无法重建产物（线上模式只加载预构建产物，不支持热更）",
      );
    }
    return this.options.builder;
  }

  private async syncManifest(
    kind: "services" | "controllers",
    name: string,
    info: ArtifactInfo,
  ): Promise<void> {
    this.manifest[kind][name] = info;
    this.manifest.builtAt = new Date().toISOString();
    // 必须落盘：否则进程重启后读到的是旧版本
    await this.store.write(this.manifest);
    await this.store.prune(this.manifest);
  }

  private rebuildRouter(): void {
    this.routerTable.rebuild(this.controllers.values());
  }

  private async fileExists(file: string): Promise<boolean> {
    try {
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  }

  private isHotZone(relative: string): boolean {
    const modules = path.relative(this.options.root, this.options.modulesDir).replace(/\\/g, "/");
    return relative.startsWith(`${modules}/`);
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
        routes: classMeta(record.type).routes.map(
          (route) => `${route.method.toUpperCase()} ${record.prefix}${route.path}`,
        ),
      })),
    };
  }
}

function countRoutes(record: ControllerRecord | undefined): number {
  return record ? classMeta(record.type).routes.length : 0;
}
