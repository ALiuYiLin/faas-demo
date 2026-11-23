import express, { type ErrorRequestHandler, type Express } from "express";
import type { Registry } from "./registry";

export interface AppOptions {
  /**
   * 所有 controller 的全局挂载前缀（默认 `/api`）。
   * 传 `""` 或 `"/"` 表示挂在根路径。
   */
  basePath?: string;
  /** 观测接口路径，默认 `/__admin/modules`；传 `false` 关闭 */
  adminPath?: string | false;
}

export function createApp(registry: Registry, options: AppOptions = {}): Express {
  const app = express();
  const basePath = normalizeBasePath(options.basePath ?? "/api");
  const adminPath = options.adminPath === false ? null : (options.adminPath ?? "/__admin/modules");

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (adminPath) {
    app.get(adminPath, (_req, res) => {
      res.json({ basePath, ...(registry.describe() as Record<string, unknown>) });
    });
  }

  // 路由表只挂这一个中间件，换版靠 registry 内部替换 composed
  if (basePath) app.use(basePath, registry.handle);
  else app.use(registry.handle);

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
