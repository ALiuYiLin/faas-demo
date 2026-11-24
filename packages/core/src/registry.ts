import type { RequestHandler, Router } from "express";
import { appContext, beginCapture, classMeta, endCapture, type Registrations } from "@faas/runtime/internal";
import { createModuleLoader } from "./loader";
import { createManifestStore, emptyManifest, type Manifest, type ManifestStore } from "./manifest";
import { RouterTable } from "./router-table";

export interface RegistryOptions {
  /** 项目根，manifest 里的相对路径相对它 */
  root: string;
  /** 热区源码目录（用户配置/观测用） */
  modulesDir: string;
  /** 产物目录（部署时拉取到的目录） */
  distDir: string;
}

export interface ControllerRecord {
  /** 入口产物相对路径，如 controller/UserController.js */
  entry: string;
  prefix: string;
  router: Router;
  type: Function;
  version: string;
}

export interface ServiceRecord {
  entry: string;
  beanName: string;
  type: Function;
  version: string;
}

/**
 * 模块注册表：按「文件」加载模块（不打包），支持原地换版。
 *
 * - `applyManifest` 只重新求值 version 变了的文件；
 * - 入口（controller/service）变化才重建 router / 重新注册 bean；
 * - 普通文件（utils/common…）变化只替换模块导出，已有 router 继续用新实现。
 */
export class Registry {
  readonly controllers = new Map<string, ControllerRecord>();
  readonly services = new Map<string, ServiceRecord>();

  private readonly loader;
  private readonly store: ManifestStore;
  private readonly routerTable = new RouterTable();
  private manifest: Manifest = emptyManifest();

  constructor(private readonly options: RegistryOptions) {
    this.loader = createModuleLoader({ root: options.distDir });
    this.store = createManifestStore(options.distDir);
  }

  /** 入口中间件：换版只替换内部 composed，Express 路由表永不改动 */
  readonly handle: RequestHandler = (req, res, next) => this.routerTable.handle(req, res, next);

  get manifestStore(): ManifestStore {
    return this.store;
  }

  get currentManifest(): Manifest {
    return this.manifest;
  }

  async loadAll(manifest: Manifest): Promise<void> {
    await this.applyManifest(manifest);
  }

  /**
   * 把运行态同步到给定 manifest：只重载 version 变了的文件，
   * 移除消失的入口，最后重建路由表。
   */
  async applyManifest(next: Manifest): Promise<void> {
    const previous = this.manifest;

    const changed: string[] = [];
    for (const [file, info] of Object.entries(next.files)) {
      if (previous.files[file]?.version !== info.version) changed.push(file);
    }
    const removed = new Set(
      Object.keys(previous.files).filter((file) => !(file in next.files)),
    );

    // 1) 移除消失的入口
    for (const [name, record] of [...this.controllers]) {
      if (removed.has(record.entry)) {
        this.controllers.delete(name);
        appContext.forget(record.type);
      }
    }
    for (const [name, record] of [...this.services]) {
      if (removed.has(record.entry)) {
        this.services.delete(name);
        appContext.removeBean(record.beanName);
      }
    }

    // 2) 重新求值变化的模块；service 入口会在这里重新注册 bean
    const captures = new Map<string, Registrations>();
    for (const file of changed) {
      const old = this.recordByEntry(file);
      if (old) appContext.forget(old.type);

      const capture = beginCapture();
      try {
        // 允许 @Service 覆盖同名 bean
        appContext.withReplace(() => this.loader.reload(file));
      } finally {
        endCapture();
      }
      captures.set(file, capture);
    }

    // 3) 入口记录
    for (const entry of next.entries.services) {
      const version = next.files[entry]?.version;
      if (!version) continue;
      const name = nameOf(entry);
      const record = this.services.get(name);
      if (record && record.version === version) continue;

      const bean = captures.get(entry)?.beans[0];
      if (!bean) throw new Error(`[registry] service 入口 ${entry} 没有注册任何 bean`);
      this.services.set(name, { entry, beanName: bean.name, type: bean.type, version });
    }

    for (const entry of next.entries.controllers) {
      const version = next.files[entry]?.version;
      if (!version) continue;
      const name = nameOf(entry);
      const record = this.controllers.get(name);
      if (record && record.version === version) continue;

      const type = captures.get(entry)?.controllers[0];
      if (!type) {
        throw new Error(
          `[registry] controller 入口 ${entry} 没有注册 @Controller（产物可能过期或源码为空）`,
        );
      }

      const exported = this.loader.exportsOf(entry) as { default?: unknown } | undefined;
      const router = exported?.default;
      if (typeof router !== "function") {
        throw new Error(`[registry] controller 入口 ${entry} 的默认导出不是 router`);
      }

      const meta = classMeta(type);
      this.controllers.set(name, {
        entry,
        prefix: meta.path ?? "/",
        router: router as unknown as Router,
        type,
        version,
      });
    }

    // 4) 重建路由表（一次赋值）
    this.manifest = next;
    this.routerTable.rebuild(this.controllers.values());
  }

  /** 观测：当前加载的入口、版本、路由 */
  describe(): unknown {
    return {
      builtAt: this.manifest.builtAt,
      files: Object.keys(this.manifest.files).length,
      services: [...this.services.values()].map((record) => ({
        entry: record.entry,
        bean: record.beanName,
        version: record.version,
      })),
      controllers: [...this.controllers.values()].map((record) => ({
        entry: record.entry,
        prefix: record.prefix,
        version: record.version,
        routes: classMeta(record.type).routes.map(
          (route) => `${route.method.toUpperCase()} ${record.prefix}${route.path}`,
        ),
      })),
    };
  }

  private recordByEntry(entry: string): ControllerRecord | ServiceRecord | undefined {
    for (const record of this.controllers.values()) if (record.entry === entry) return record;
    for (const record of this.services.values()) if (record.entry === entry) return record;
    return undefined;
  }
}

/** controller/UserController.js -> UserController */
function nameOf(entry: string): string {
  return entry.slice(entry.lastIndexOf("/") + 1).replace(/\.js$/, "");
}
