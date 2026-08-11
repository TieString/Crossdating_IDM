import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteNode = join(repoRoot, "node_modules", "vite-node", "vite-node.mjs");
const script = join(repoRoot, "scripts", "analyze-itrdb-reference-structure.ts");
const result = spawnSync(process.execPath, [viteNode, script, ...process.argv.slice(2)], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
});
process.exit(result.status ?? 1);
