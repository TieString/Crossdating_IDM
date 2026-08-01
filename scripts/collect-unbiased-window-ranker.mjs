import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const offsets = (process.env.WINDOW_RANK_OFFSETS ?? "8,9,10,11,12")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite);
const cases = Number(process.env.WINDOW_RANK_CASES ?? 25);
const collectFeatures = process.env.WINDOW_RANK_COLLECT_FEATURES !== "0";
const outputDirectory = resolve(
    process.env.WINDOW_RANK_OUTPUT_DIR
        ?? resolve(tmpdir(), "crossdating-unbiased-window-ranker"),
);
const auditOutputDirectory = process.env.WINDOW_RANK_AUDIT_OUTPUT_DIR
    ? resolve(process.env.WINDOW_RANK_AUDIT_OUTPUT_DIR)
    : null;

if (offsets.some((offset) => [13, 14, 15, 16, 17, 18, 19, 20].includes(offset))) {
    throw new Error("Offsets 13-20 are consumed blind evaluations and cannot be rerun.");
}
if (offsets.length === 0 || !Number.isFinite(cases) || cases < 1) {
    throw new Error("WINDOW_RANK_OFFSETS and WINDOW_RANK_CASES must be valid.");
}

mkdirSync(outputDirectory, { recursive: true });
if (auditOutputDirectory) mkdirSync(auditOutputDirectory, { recursive: true });
const executable = process.execPath;
const vitestCli = resolve("node_modules", "vitest", "vitest.mjs");
const testPath = "src/features/crossdating/diagnosis/__tests__/itrdbBenchmark.test.ts";

for (const offset of offsets) {
    const outputPath = resolve(outputDirectory, `offset-${offset}-cases-${cases}.json`);
    const auditPath = auditOutputDirectory
        ? resolve(auditOutputDirectory, `offset-${offset}-cases-${cases}.json`)
        : null;
    console.log(
        `Collecting offset=${offset}, cases=${cases}`
        + (collectFeatures ? ` features=${outputPath}` : "")
        + (auditPath ? ` audit=${auditPath}` : ""),
    );
    const result = spawnSync(
        executable,
        [
            vitestCli,
            "run",
            testPath,
            "-t",
            "frozen-event holdout",
            "--reporter=dot",
        ],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                RUN_ITRDB_BENCH: "1",
                ITRDB_FROZEN_OFFSET: String(offset),
                ITRDB_FROZEN_CASES: String(cases),
                ITRDB_FROZEN_FILES: "200",
                ITRDB_GAIN_GATED_OPERATION_RECOVERY: "1",
                ITRDB_MIXED_REFERENCE_SUPPLEMENT: "1",
                ...(collectFeatures ? { ITRDB_WINDOW_RANK_DATA_PATH: outputPath } : {}),
                ...(auditPath ? { ITRDB_AUDIT_DATA_PATH: auditPath } : {}),
            },
            stdio: "inherit",
        },
    );
    if (result.status !== 0) {
        if (result.error) console.error(result.error);
        process.exit(result.status ?? 1);
    }
}

console.log(`Completed ${offsets.length} unbiased development offsets.`);
