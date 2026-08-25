import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = join(tmpdir(), "crossdating-pairwise-only-replay");
const bundlePath = join(bundleDir, `replay-${process.pid}.mjs`);
mkdirSync(bundleDir, { recursive: true });
buildSync({
    entryPoints: [join(repoRoot, "scripts", "replay-pairwise-only-diagnosis.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    tsconfig: join(repoRoot, "tsconfig.itrdb-operation-capability.json"),
    outfile: bundlePath,
    logLevel: "warning",
});
const result = spawnSync(process.execPath, [
    bundlePath,
    ...process.argv.slice(2).filter((argument) => argument !== "--"),
], {
    cwd: repoRoot,
    env: { ...process.env, CROSSDATING_REPO_ROOT: repoRoot },
    stdio: "inherit",
    windowsHide: true,
});
rmSync(bundlePath, { force: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
