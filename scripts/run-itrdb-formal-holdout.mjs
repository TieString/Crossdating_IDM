import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const split = valueFor("--split") ?? "development";
if (!["development", "calibration", "final"].includes(split)) {
    throw new Error(`invalid --split: ${split}`);
}
const splitMap = {
    development: "train",
    calibration: "calibration",
    final: "validation",
};
const datasetRoot = resolve(
    valueFor("--input-dir")
        ?? "D:/软件测试/数据/ITRDB/itrdb_download/measurements",
);
const outputRoot = resolve(
    valueFor("--output-dir") ?? "D:/软件测试/ITRDB-js-validation-results",
);
const runId = valueFor("--run-id") ?? `${split}-v1`;
const runDir = join(outputRoot, runId);
mkdirSync(runDir, { recursive: true });
const auditPath = join(runDir, "formal-audit.json");
const summaryPath = join(runDir, "formal-summary.json");

const env = { ...process.env };
Object.keys(env).filter((key) => key.startsWith("ITRDB_") || key === "RUN_ITRDB_BENCH")
    .forEach((key) => delete env[key]);
Object.assign(env, {
    RUN_ITRDB_BENCH: "1",
    CROSSDATING_ITRDB_DIR: datasetRoot,
    ITRDB_TIMEOUT: "3600000",
    ITRDB_FROZEN_FILE_SPLIT: splitMap[split],
    ITRDB_FROZEN_FILES: "320",
    ITRDB_FROZEN_CASES: "240",
    ITRDB_FROZEN_OFFSET: "8",
    ITRDB_FROZEN_MIN_CONTEXT_YEARS: "14",
    ITRDB_FROZEN_MIN_OLDER_CONTEXT_YEARS: "14",
    ITRDB_FROZEN_MIN_NEWER_CONTEXT_YEARS: "2",
    ITRDB_SKIP_PARTIAL_TRUTH: "1",
    ITRDB_AUDIT_DATA_PATH: auditPath,
});

const test = spawnSync(process.execPath, [
    join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "src/features/crossdating/diagnosis/__tests__/itrdbBenchmark.test.ts",
    "-t",
    "frozen-event holdout",
    "--reporter=dot",
], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
});
if (test.error) throw test.error;
if (test.status !== 0) process.exit(test.status ?? 1);

const summarize = spawnSync(process.execPath, [
    join(repoRoot, "node_modules", "vite-node", "vite-node.mjs"),
    join(repoRoot, "scripts", "summarize-itrdb-formal-holdout.ts"),
    "--",
    "--input",
    auditPath,
    "--output",
    summaryPath,
], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
});
if (summarize.error) throw summarize.error;
process.exitCode = summarize.status ?? 1;
