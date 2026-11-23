import express, { type Express, type RequestHandler, type Router } from "express";
import { Container } from "./container";
import { classMeta, getControllers, isRegisteredBean, registerBean } from "./metadata";

export interface MountOptions {
  /** 挂载前缀，如 "/api"；缺省挂在根路径 */
  prefix?: string;
  /** 要注册的控制器；缺省用所有 @Controller 类 */
  controllers?: ReadonlyArray<new (...args: any[]) => unknown>;
  /** 让容器知道的实现类。@Service 在类定义时已注册，这里只是兜底 + 显式列出依赖 */
  beans?: ReadonlyArray<new (...args: any[]) => unknown>;
  /** 复用已有容器（热重载时换"代"会用到） */
  container?: Container;
}

/** 把控制器实例化成 express.Router，但还没挂到 app 上。 */
export function buildRouter(options: MountOptions = {}): Router {
  const container = options.container ?? new Container();
  const router = express.Router();
  const controllers: ReadonlyArray<new (...args: any[]) => unknown> =
    options.controllers ??
    [...getControllers().keys()].map((type) => type as new (...args: any[]) => unknown);

  for (const type of controllers) {
    const meta = classMeta(type);
    const instance = container.resolve(type);
    const sub = express.Router();

    for (const route of meta.routes) {
      const handler = handlerFor(instance, route.handler);
      const path = normalizePath(route.path);
      if (route.method === "get") sub.get(path, handler);
      else sub.post(path, handler);
    }

    router.use(normalizePath(meta.path ?? "/"), sub);
  }

  return router;
}

/** 静态注册：装饰器已经写好元数据，这里负责实例化、注入并挂到 app。 */
export function mount(app: Express, options: MountOptions = {}): Container {
  for (const bean of options.beans ?? []) {
    if (!isRegisteredBean(bean)) registerBean(bean);
  }

  const container = options.container ?? new Container();
  const router = buildRouter({ ...options, container });

  const prefix = options.prefix?.trim();
  if (prefix) app.use(prefix, router);
  else app.use(router);

  return container;
}

/**
 * 包一层：把 this 绑回实例、统一 await、把返回值序列化成响应。
 * 处理函数自己写了响应（res.send/json/end）时不再重复写。
 */
function handlerFor(instance: unknown, key: string | symbol): RequestHandler {
  return async (req, res, next) => {
    try {
      const method = (instance as Record<string | symbol, (...args: any[]) => unknown>)[key];
      if (typeof method !== "function") {
        throw new Error(`[router] ${key.toString()} 不是方法`);
      }
      const result = await method.call(instance, req, res, next);
      if (res.headersSent || res.writableEnded) return;
      if (result === undefined) return;
      if (typeof result === "string" || Buffer.isBuffer(result)) res.send(result);
      else res.json(result);
    } catch (error) {
      next(error);
    }
  };
}

function normalizePath(path: string): string {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}
