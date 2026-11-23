import express, { type ErrorRequestHandler } from "express";
import { mount } from "@/container";
import { UserController } from "@/modules/controller/UserController";
import { UserServiceImpl } from "@/modules/service/impl/UserServiceImpl";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// 静态注册：装饰器在模块求值时已写好元数据，这里负责实例化、注入并挂路由。
// beans 里显式列出实现类，既是兜底注册，也让人一眼看到依赖。
mount(app, {
  prefix: "/api",
  controllers: [UserController],
  beans: [UserServiceImpl],
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
