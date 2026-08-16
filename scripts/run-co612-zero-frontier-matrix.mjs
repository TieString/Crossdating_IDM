import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(process.execPath, [
    join(repoRoot, "node_modules", "vite-node", "vite-node.mjs"),
    join(repoRoot, "scripts", "benchmark-co612-zero-frontier-matrix.ts"),
    "--",
    ...process.argv.slice(2).filter((argument) => argument !== "--"),
], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
