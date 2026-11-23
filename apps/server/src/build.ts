import { createCompiler } from "@faas/compiler";
import { APP_SRC, DIST_DIR, MODULES_DIR, ROOT } from "./config";

const compiler = createCompiler({
  root: ROOT,
  modulesDir: MODULES_DIR,
  distDir: DIST_DIR,
  aliases: { "@": APP_SRC },
});

const manifest = await compiler.buildAll();

const lines = [
  ...Object.entries(manifest.services).map(
    ([name, info]) => `  service     ${name.padEnd(20)} ${info.version}  (${Object.keys(info.deps).length} deps)`,
  ),
  ...Object.entries(manifest.controllers).map(
    ([name, info]) => `  controller  ${name.padEnd(20)} ${info.version}  (${Object.keys(info.deps).length} deps)`,
  ),
];

console.log(`[build] ${manifest.builtAt}`);
console.log(lines.join("\n") || "  (没有找到任何 controller / service)");
