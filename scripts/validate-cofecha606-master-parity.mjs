import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name, fallback = "") => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const measurementsRoot = resolve(valueFor("--measurements-root"));
const cofechaExe = resolve(valueFor("--cofecha-exe"));
const outputRoot = resolve(valueFor("--output-dir"));
const requestedIds = valueFor("--ids")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
mkdirSync(outputRoot, { recursive: true });

const files = [];
const visit = (directory) => {
    readdirSync(directory).forEach((name) => {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) visit(path);
        else if (/\.rwl$/i.test(name)) files.push(path);
    });
};
visit(measurementsRoot);
const byId = new Map(files.map((path) => [basename(path, ".rwl").toLowerCase(), path]));
const results = [];
for (const id of requestedIds) {
    const sourcePath = byId.get(id);
    if (!sourcePath) {
        results.push({ id, status: "missing" });
        continue;
    }
    const outputDir = join(outputRoot, id);
    mkdirSync(outputDir, { recursive: true });
    const run = spawnSync(process.execPath, [
        join("scripts", "run-probe-cofecha-reference-parity.mjs"),
        "--",
        "--rwl", sourcePath,
        "--cofecha-exe", cofechaExe,
        "--output-dir", outputDir,
        "--profiles", "full",
        "--exact-only", "true",
        "--numeric-modes", "legacy-float32",
    ], {
        cwd: resolve("."),
        encoding: "utf8",
        timeout: 180_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
    });
    writeFileSync(
        join(outputDir, "runner.log"),
        `${run.stdout ?? ""}${run.stderr ?? ""}`,
        "utf8",
    );
    if (run.status !== 0) {
        results.push({ id, sourcePath, status: "failed", exitCode: run.status });
        continue;
    }
    const report = JSON.parse(readFileSync(join(outputDir, "parity-report.json"), "utf8"));
    const exact = report.profiles[0].exactBuilder;
    const passed = exact.expectedYears === exact.actualYears
        && exact.overlapYears === exact.expectedYears
        && exact.exactFourDecimals === exact.expectedYears
        && exact.formattedTextExact
        && exact.expectedDepthYears === exact.actualDepthYears
        && exact.depthMismatches.length === 0;
    results.push({
        id,
        sourcePath,
        status: passed ? "passed" : "mismatch",
        exact,
    });
    console.log(`COFECHA_MASTER_PARITY_FILE ${JSON.stringify({
        id,
        status: passed ? "passed" : "mismatch",
        years: exact.expectedYears,
        exactFourDecimals: exact.exactFourDecimals,
        depthMismatches: exact.depthMismatches.length,
        formattedTextExact: exact.formattedTextExact,
    })}`);
}

const summary = {
    schemaVersion: 1,
    measurementsRoot,
    cofechaExe,
    requestedCount: requestedIds.length,
    passedCount: results.filter((result) => result.status === "passed").length,
    mismatchCount: results.filter((result) => result.status === "mismatch").length,
    failedCount: results.filter((result) => result.status === "failed").length,
    missingCount: results.filter((result) => result.status === "missing").length,
    results,
};
writeFileSync(
    join(outputRoot, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
);
console.log(`COFECHA_MASTER_PARITY_COMPLETE ${JSON.stringify({
    requested: summary.requestedCount,
    passed: summary.passedCount,
    mismatch: summary.mismatchCount,
    failed: summary.failedCount,
    missing: summary.missingCount,
})}`);
