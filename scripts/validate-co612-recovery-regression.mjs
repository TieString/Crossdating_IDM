import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(
    repoRoot,
    "docs",
    "benchmarks",
    "legacy-cross-file-generalization-config-v1.json",
), "utf8"));
const configuredInput = config.paths.co612Input;
const inputPath = isAbsolute(configuredInput)
    ? configuredInput
    : resolve(repoRoot, configuredInput);
const outputRoot = mkdtempSync(join(tmpdir(), "co612-recovery-regression-"));
const result = spawnSync(process.execPath, [
    join(repoRoot, "scripts", "run-co612-review-window-bootstrap.mjs"),
    "--input", inputPath,
    "--output-dir", outputRoot,
    "--run-id", "old358-first-sweep",
    "--max-rounds", "1",
    "--workers", "16",
    "--minimum-first-sweep-correct-windows", "22",
], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
});

if (result.error) throw result.error;
if (result.status === 0) {
    rmSync(outputRoot, { recursive: true, force: true });
} else {
    console.error(`CO612 recovery regression artifacts retained at ${outputRoot}`);
}
process.exitCode = result.status ?? 1;
