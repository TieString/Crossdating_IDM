import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name, fallback = "") => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};

const runDir = resolve(valueFor("--run-dir"));
const baselineRows = resolve(valueFor("--baseline-rows"));
const outputRoot = resolve(valueFor("--output-root"));
const workers = Math.max(1, Number(valueFor("--workers", "8")));
const fileIds = valueFor("--file-ids");
const attemptIdsFrom = valueFor("--attempt-ids-from");
const includeCompactEventEvidence = valueFor(
    "--include-compact-event-evidence",
    "false",
);
mkdirSync(outputRoot, { recursive: true });

const views = [
    { id: "rawpre", ar: "current-aic", log: "pre-spline-residual", target: "include", normalize: true },
    { id: "noar", ar: "none", log: "post-ar", target: "include", normalize: true },
    { id: "ar1", ar: "fixed-1", log: "post-ar", target: "include", normalize: true },
    { id: "exclude", ar: "current-aic", log: "post-ar", target: "exclude", normalize: true },
    { id: "unnorm", ar: "current-aic", log: "post-ar", target: "include", normalize: false },
    { id: "rawpre-noar", ar: "none", log: "pre-spline-residual", target: "include", normalize: true },
    { id: "rawpre-exclude", ar: "current-aic", log: "pre-spline-residual", target: "exclude", normalize: true },
    { id: "noar-exclude", ar: "none", log: "post-ar", target: "exclude", normalize: true },
];

for (const view of views) {
    const outputDir = resolve(outputRoot, view.id);
    const childArgs = [
        "scripts/run-replay-pairwise-only-diagnosis.mjs",
        "--run-dir", runDir,
        "--output-dir", outputDir,
        "--workers", String(workers),
        "--reference-strategy", "internal-model-flagged",
        "--internal-master-method", "mean",
        "--internal-target-contribution", view.target,
        "--normalize-internal-source-residuals", String(view.normalize),
        "--internal-spline-implementation", "discrete-penalty",
        "--internal-ar-implementation", view.ar,
        "--internal-log-implementation", view.log,
        "--include-evaluation-labels", "true",
        "--include-compact-event-evidence", includeCompactEventEvidence,
    ];
    if (attemptIdsFrom) childArgs.push("--attempt-ids-from", resolve(attemptIdsFrom));
    else childArgs.push("--failed-attempts-from", baselineRows);
    if (fileIds) childArgs.push("--file-ids", fileIds);
    console.log(`INTERNAL_REFERENCE_VIEW_START ${view.id}`);
    const result = spawnSync(process.execPath, childArgs, {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
        windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`reference view ${view.id} failed with ${result.status}`);
    }
}

console.log(`INTERNAL_REFERENCE_VIEW_GRID_COMPLETE ${JSON.stringify({
    runDir,
    baselineRows,
    outputRoot,
    views: views.map((view) => view.id),
})}`);
