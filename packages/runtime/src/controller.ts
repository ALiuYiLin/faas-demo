import express, { type RequestHandler, type Router } from "express";
import { appContext } from "./app-context";
import { classMeta, type ParamMeta, type RouteMeta } from "./context";

/**
 * 把一个 controller 类变成一个 express.Router。
 *
 * 在 controller 模块里这样用：
 * ```ts
 * export default controllerRouter(UserController);
 * ```
 * 前缀来自 `@Controller("/users")`，由运行时 mount 时使用。
 */
export function controllerRouter(type: new (...args: any[]) => unknown): Router {
  const meta = classMeta(type);
  if (meta.path === undefined) {
    throw new Error(`[runtime] ${type.name} 没有 @Controller 装饰器，无法生成 router`);
  }

  const instance = appContext.resolve(type);
  const router = express.Router();

  for (const route of meta.routes) {
    const handler = createHandler(instance, route, meta.params.get(route.handler) ?? []);
    const path = normalizePath(route.path);
    if (route.method === "get") router.get(path, handler);
    else router.post(path, handler);
  }

  return router;
}

/**
 * 包一层：按 @Param/@Body 组装实参、把 this 绑回实例、统一 await、
 * 把返回值序列化成响应（返回 undefined 表示 handler 自己写了响应）。
 */
function createHandler(instance: unknown, route: RouteMeta, params: ParamMeta[]): RequestHandler {
  return async (req, res, next) => {
    try {
      const key = route.handler;
      const method = (instance as Record<string | symbol, (...args: any[]) => unknown>)[key];
      if (typeof method !== "function") {
        throw new Error(`[runtime] ${key.toString()} 不是方法`);
      }

      const args: unknown[] = [];
      for (const param of params) {
        args[param.index] = param.kind === "body" ? req.body : req.params[param.name ?? ""];
      }

      const result = await method.call(instance, ...args, req, res, next);
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
