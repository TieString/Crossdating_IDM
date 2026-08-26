import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    extractPart6FlaggedASeriesIds,
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import {
    buildInternalReferenceModel,
    scoreInternalTargetIncompatibility,
    type InternalMasterMethod,
    type InternalTargetContribution,
} from "@/features/crossdating/internalReferenceModel";
import { loadRwl } from "./legacy-generalization/evaluator";
import type {
    CofechaArImplementation,
    CofechaLogImplementation,
    CofechaSplineImplementation,
} from "@/features/crossdating/reference";

type Step = {
    caseIndex: number;
    step: number;
    fileId: string;
    family: string;
    targetId: string;
};

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string, fallback = ""): string => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const runDir = resolve(valueFor("--run-dir"));
const outputPath = resolve(valueFor("--output"));
const method = valueFor("--method", "mean") as InternalMasterMethod;
const targetContribution = valueFor(
    "--target-contribution",
    "include",
) as InternalTargetContribution;
const normalizeSourceResiduals = valueFor("--normalize-source-residuals", "false") === "true";
const splineImplementation = valueFor(
    "--spline-implementation",
    "discrete-penalty",
) as CofechaSplineImplementation;
const arImplementation = valueFor(
    "--ar-implementation",
    "current-aic",
) as CofechaArImplementation;
const logImplementation = valueFor(
    "--log-implementation",
    "post-ar",
) as CofechaLogImplementation;
const preSplineResidualBlendWeightValue = valueFor(
    "--pre-spline-residual-blend-weight",
);
const preSplineResidualBlendWeight = preSplineResidualBlendWeightValue === ""
    ? null
    : Number(preSplineResidualBlendWeightValue);
const selectedFileIds = new Set(valueFor("--file-ids")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));

const findAttemptDirectories = (root: string): Map<string, string> => {
    const output = new Map<string, string>();
    const scan = (directory: string): void => {
        readdirSync(directory).forEach((entry) => {
            const path = join(directory, entry);
            if (!statSync(path).isDirectory()) return;
            const match = entry.match(/^case-(\d+)-step-(\d+)$/);
            if (match) output.set(`${Number(match[1])}:${Number(match[2])}`, path);
            else scan(path);
        });
    };
    scan(root);
    return output;
};

const correlationAtLag = (
    left: ReadonlyMap<number, number>,
    right: ReadonlyMap<number, number>,
    lag: number,
) => {
    const pairs = Array.from(left).flatMap(([year, value]) => {
        const other = right.get(year + lag);
        return other === undefined ? [] : [[value, other] as const];
    });
    if (pairs.length < 30) return { correlation: null, overlap: pairs.length };
    const leftMean = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
    const rightMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
    let numerator = 0;
    let leftVariance = 0;
    let rightVariance = 0;
    pairs.forEach(([leftValue, rightValue]) => {
        const leftDelta = leftValue - leftMean;
        const rightDelta = rightValue - rightMean;
        numerator += leftDelta * rightDelta;
        leftVariance += leftDelta ** 2;
        rightVariance += rightDelta ** 2;
    });
    const denominator = Math.sqrt(leftVariance * rightVariance);
    return {
        correlation: denominator > 0 ? numerator / denominator : null,
        overlap: pairs.length,
    };
};

const quantile = (values: number[], probability: number) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) * probability)] ?? null;
};

const steps = JSON.parse(readFileSync(join(runDir, "steps.json"), "utf8")) as Step[];
const directories = findAttemptDirectories(join(runDir, "workers"));
const selected = steps.filter((step) => (
    selectedFileIds.size === 0 || selectedFileIds.has(step.fileId)
));
const rows = [];
for (const [index, step] of selected.entries()) {
    const key = `${step.caseIndex}:${step.step}`;
    const directory = directories.get(key);
    if (!directory) continue;
    const statePath = join(directory, "state.rwl");
    const outText = readFileSync(join(directory, "VERYCOF.OUT"), "utf8");
    const loaded = await loadRwl(statePath, "tucson-auto");
    const model = buildInternalReferenceModel({
        siteData: loaded.siteData,
        targetId: step.targetId,
        runId: `master-audit-${key}`,
        rwlHash: key,
        method,
        targetContribution,
        normalizeSourceResiduals,
        splineImplementation,
        arImplementation,
        logImplementation,
        preSplineResidualBlendWeight,
        computeSourceCompatibility: false,
    });
    if (!model?.referenceConfig.cofechaPassReference) continue;
    const cofechaMaster = parseCofechaResult(outText).masterDatingSeries;
    const internalMaster = new Map(model.referenceConfig.cofechaPassReference.points.map(
        (point) => [point.year, point.value],
    ));
    const zero = correlationAtLag(cofechaMaster, internalMaster, 0);
    let bestCorrelation = zero.correlation;
    let bestLag = 0;
    for (let lag = -10; lag <= 10; lag += 1) {
        const current = correlationAtLag(cofechaMaster, internalMaster, lag);
        if (current.correlation !== null
            && (bestCorrelation === null || current.correlation > bestCorrelation)) {
            bestCorrelation = current.correlation;
            bestLag = lag;
        }
    }
    const flaggedIds = extractPart6FlaggedASeriesIds(
        splitReportByParts(outText).get("PART 6") ?? "",
    );
    rows.push({
        attemptId: key,
        fileId: step.fileId,
        family: step.family,
        targetId: step.targetId,
        overlap: zero.overlap,
        zeroCorrelation: zero.correlation,
        bestCorrelation,
        bestLag,
        zeroLagDeficit: zero.correlation !== null && bestCorrelation !== null
            ? bestCorrelation - zero.correlation
            : null,
        cofechaFlagged: flaggedIds.includes(step.targetId),
        incompatibilityScore: scoreInternalTargetIncompatibility(model.targetCompatibility),
        targetCompatibility: model.targetCompatibility,
        sourceZeroCorrelationMean: model.sourceCompatibility.length > 0
            ? model.sourceCompatibility.reduce((sum, row) => (
                sum + (row.zeroCorrelation ?? -0.2)
            ), 0) / model.sourceCompatibility.length
            : null,
        sourceSegmentIncompatibleMean: model.sourceCompatibility.length > 0
            ? model.sourceCompatibility.reduce((sum, row) => (
                sum + (row.segmentIncompatibleFraction ?? 1)
            ), 0) / model.sourceCompatibility.length
            : null,
    });
    if ((index + 1) % 25 === 0) {
        console.log(`INTERNAL_MASTER_AUDIT ${index + 1}/${selected.length}`);
    }
}

const correlations = rows.flatMap((row) => (
    row.zeroCorrelation === null ? [] : [row.zeroCorrelation]
));
const summary = {
    schemaVersion: 1,
    runDir,
    method,
    targetContribution,
    normalizeSourceResiduals,
    splineImplementation,
    arImplementation,
    logImplementation,
    preSplineResidualBlendWeight,
    attempts: rows.length,
    files: [...new Set(rows.map((row) => row.fileId))],
    masterCorrelation: {
        mean: correlations.length > 0
            ? correlations.reduce((sum, value) => sum + value, 0) / correlations.length
            : null,
        q10: quantile(correlations, 0.1),
        median: quantile(correlations, 0.5),
        q90: quantile(correlations, 0.9),
        bestLagZeroRate: rows.filter((row) => row.bestLag === 0).length
            / Math.max(1, rows.length),
    },
};
writeFileSync(outputPath, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
console.log(`INTERNAL_MASTER_AUDIT_COMPLETE ${JSON.stringify(summary)}`);
