import { createApp, type Registry } from "@faas/core";
import { BASE_PATH, PORT } from "./config";

/** 生产 / 开发共用的启动逻辑 */
export function startServer(registry: Registry): void {
  const app = createApp(registry, { basePath: BASE_PATH });
  app.listen(PORT, () => {
    console.log(`listening on http://localhost:${PORT}${BASE_PATH}`);
  });
}
