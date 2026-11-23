import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // 只匹配 "@/..."，避免误伤 @types/node、@scope/pkg 这类裸模块
      { find: /^@\//, replacement: `${src}/` },
    ],
  },
});
