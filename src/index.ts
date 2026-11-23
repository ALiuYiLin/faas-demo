import express, { type ErrorRequestHandler } from "express";
import { HotLoader } from "@/hot-loader";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// 控制器通过热加载入口（src/router/index.ts）装配：
// loader 会把 `@/` 和相对导入的源码打包进 vm 沙箱执行，
// 装饰器写入的仍是宿主这份元数据注册表（@/decorators、@/container 被映射回宿主实例）。
const loader = new HotLoader();
await loader.checkAndSwap().catch((error) => {
  console.error("[hot-loader] 首次编译失败:", error);
});

app.use("/api", async (req, res, next) => {
  const router = loader.getRouter();
  if (!router) {
    res.status(503).json({ error: "business module not ready" });
    return;
  }
  router(req, res, next);
});

// 统一错误出口：控制器里抛出的异常都以 JSON 返回
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[app] 未处理异常:", err);
  res.status(500).json({ error: message });
};
app.use(errorHandler);

app.listen(port, () => {
  console.log(`listening on http://localhost:${port}`);
});
