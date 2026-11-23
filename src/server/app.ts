import express, { type ErrorRequestHandler } from "express";
import type { Registry } from "./registry";

export interface AppOptions {
  /**
   * 所有 controller 的全局挂载前缀（默认 `/api`）。
   * 传 `""` 或 `"/"` 表示挂在根路径。
   */
  basePath?: string;
}

export function createApp(registry: Registry, options: AppOptions = {}): express.Express {
  const app = express();
  const basePath = normalizeBasePath(options.basePath ?? "/api");

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // 观测面：当前加载的产物版本 / 路由（不受 basePath 影响）
  app.get("/__admin/modules", (_req, res) => {
    res.json({ basePath, ...(registry.describe() as Record<string, unknown>) });
  });

  // 路由表只挂这一个中间件，换版靠 registry 内部替换 composed。
  // 用 express 的挂载路径来剥前缀：composed 里的路由仍是 controller 自带的绝对路径。
  const dispatch = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    registry.handle(req, res, next);
  };
  if (basePath) app.use(basePath, dispatch);
  else app.use(dispatch);

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const message = err instanceof Error ? err.message : String(err);
    // body-parser / http-errors 会带 status，尊重它（400 而不是一律 500）
    const status =
      typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : 500;
    if (status >= 500) console.error("[app] 未处理异常:", err);
    res.status(status).json({ error: message });
  };
  app.use(errorHandler);

  return app;
}

/** `/api/` -> `/api`；`/`、`` -> `""`；`api` -> `/api` */
function normalizeBasePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
