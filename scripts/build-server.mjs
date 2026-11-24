import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

/**
 * 把 server 入口打成单文件 ESM bundle，输出到 dist/server。
 *
 * - workspace 里的 `@faas/*` 是 TS 源码，直接打进 bundle；
 * - express 也打进去，部署时只需要 `dist/`（不用带 node_modules）；
 *   express 是 CJS 且带动态 require，所以 banner 里注入一个基于 createRequire 的 require；
 * - 生产入口不 import compiler / dev，所以 bundle 里没有 rollup。
 */
const outdir = path.resolve("dist", "server");
await mkdir(outdir, { recursive: true });

const result = await build({
  entryPoints: ["apps/server/src/index.ts"],
  outfile: path.join(outdir, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  // urllib 在配置代理时才会 require('proxy-agent')，它是可选依赖；不走代理就永远用不到
  external: ["proxy-agent"],
  logLevel: "warning",
  banner: {
    // esbuild 打包 CJS 依赖到 ESM 时，动态 require 需要真实 require 兜底
    js: 'import { createRequire as __faasCreateRequire } from "node:module"; const require = __faasCreateRequire(import.meta.url);',
  },
  metafile: true,
});

// 让 dist/server 自带 ESM 标记，脱离仓库根目录单独部署也能跑
await writeFile(path.join(outdir, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`, "utf8");

const outputs = Object.entries(result.metafile.outputs).map(
  ([file, info]) => `${file}  ${(info.bytes / 1024).toFixed(1)} KB`,
);
console.log(`[build] dist/server\n${outputs.map((line) => `  ${line}`).join("\n")}`);
