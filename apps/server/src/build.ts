import { createCompiler } from "@faas/compiler";
import { DIST_DIR, MODULES_DIR, ROOT } from "./config";

const compiler = createCompiler({ root: ROOT, modulesDir: MODULES_DIR, distDir: DIST_DIR });
const manifest = await compiler.buildAll();

const lines = [
  ...manifest.entries.services.map((entry) => `  service     ${entry}`),
  ...manifest.entries.controllers.map((entry) => `  controller  ${entry}`),
  `  files       ${Object.keys(manifest.files).length}`,
];

console.log(`[build] ${manifest.builtAt}  (manifest v${manifest.manifestVersion})`);
console.log(lines.join("\n") || "  (没有找到任何 controller / service)");
