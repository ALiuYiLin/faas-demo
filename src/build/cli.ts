import { buildAll } from "./artifact";

const manifest = await buildAll();

const lines: string[] = [];
for (const [name, info] of Object.entries(manifest.services)) {
  lines.push(`  service     ${name.padEnd(20)} ${info.version}  (${Object.keys(info.deps).length} deps)`);
}
for (const [name, info] of Object.entries(manifest.controllers)) {
  lines.push(`  controller  ${name.padEnd(20)} ${info.version}  (${Object.keys(info.deps).length} deps)`);
}

console.log(`[build] ${new Date().toISOString()}`);
console.log(lines.join("\n") || "  (没有找到任何 controller / service)");
