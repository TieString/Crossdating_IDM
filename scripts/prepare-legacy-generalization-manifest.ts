import { createHash } from "node:crypto";
import {
    existsSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRwl, type RwlSeries } from "@/features/crossdating/diagnosis/__tests__/rdmFixture";
import { stableItrdbPathHash } from "@/features/crossdating/diagnosis/__tests__/itrdbValidationProtocol";

type FrozenConfig = {
    schemaVersion: number;
    protocolVersion: string;
    gitCommit: string;
    seed: string;
    paths: Record<string, string>;
    expectedHashes: Record<string, string>;
    selection: {
        externalFileCount: number;
        pilotFileCount: number;
        targetsPerFile: number;
        negativeTargetsPerFile: number;
        excludePriorManifestFiles: boolean;
        maximumFilesPerDatasetPrefix: number;
        minimumSeriesPerFile: number;
        maximumSeriesPerFile: number;
        minimumTargetLength: number;
        maximumTargetLength: number;
        minimumReferenceOverlapYears: number;
        minimumReferenceCount: number;
        minimumOlderContextYears: number;
        minimumNewerContextYears: number;
        requireCompleteTargetCalendar: boolean;
        requireZeroFreeTarget: boolean;
    };
    injection: {
        falseRingMode: "average" | "moderate" | "splitLike";
        partialMoveShiftYears: number;
        contiguousBlockShiftYears: number;
        wholeSeriesShiftYears: number;
        multiDiscreteMissingCounts: number[];
        minimumDiscreteSpacingYears: number;
        endpointNewerDistanceYears: number;
        cropOlderYears: number;
        compositeWholeSeriesShiftYears: number;
        compositePartialShiftYears: number;
        scenarioOrder: string[];
        serialScenarioOrder: string[];
    };
};

type TruthSpec = {
    truthId: string;
    eventType: "missingRing" | "falseRing" | "partialMove" | "wholeSeriesMove";
    year: number | null;
    shiftYears: number;
    observationId: string;
};

type ScenarioPlan = {
    scenarioId: string;
    kind: string;
    truthQuality: "exact-injected" | "negative-clean";
    eventComplexity: string;
    targetId: string;
    saveReopenPair: boolean;
    truths: TruthSpec[];
    parameters: Record<string, unknown>;
};

type TargetPlan = {
    targetId: string;
    startYear: number;
    endYear: number;
    seriesLength: number;
    zeroCount: number;
    referenceCount: number;
    scenarios: ScenarioPlan[];
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const configPath = resolve(valueFor("--config")
    ?? "docs/benchmarks/legacy-cross-file-generalization-config-v1.json");
const outputPath = resolve(valueFor("--output")
    ?? "docs/benchmarks/legacy-cross-file-generalization-manifest-v1.json");
const configBytes = readFileSync(configPath);
const config = JSON.parse(configBytes.toString("utf8")) as FrozenConfig;
const configHash = createHash("sha256").update(configBytes).digest("hex");
const resolveRepoPath = (path: string): string => (
    /^[A-Za-z]:[\\/]/.test(path) ? resolve(path) : resolve(repoRoot, path)
);
const itrdbRoot = resolveRepoPath(config.paths.itrdbRoot);
const priorManifestPath = resolveRepoPath(config.paths.priorItrdbManifest);
if (!existsSync(itrdbRoot)) throw new Error(`ITRDB root not found: ${itrdbRoot}`);

const sha256 = (path: string): string => createHash("sha256")
    .update(readFileSync(path)).digest("hex");
for (const [name, expected] of Object.entries(config.expectedHashes)) {
    const source = config.paths[name];
    if (!source) continue;
    const path = resolveRepoPath(source);
    if (!existsSync(path)) throw new Error(`required input missing: ${name}=${path}`);
    const actual = sha256(path);
    if (actual !== expected) throw new Error(`${name} SHA-256 mismatch: ${actual}`);
}

const collectRwl = (directory: string, output: string[]): void => {
    for (const entry of readdirSync(directory)) {
        const path = resolve(directory, entry);
        if (statSync(path).isDirectory()) collectRwl(path, output);
        else if (entry.toLowerCase().endsWith(".rwl")) output.push(path);
    }
};
const normalize = (value: string): string => value.replace(/\\/g, "/").toLowerCase();
const stableOrder = (value: string): number => stableItrdbPathHash(
    `${config.seed}:${normalize(value)}`,
);
const priorManifest = JSON.parse(readFileSync(priorManifestPath, "utf8")) as {
    fileSha256: Record<string, string>;
};
const priorFiles = new Set(Object.keys(priorManifest.fileSha256).map(normalize));
const allFiles: string[] = [];
collectRwl(itrdbRoot, allFiles);
const candidates = allFiles.map((path) => ({
    path,
    relativePath: normalize(relative(itrdbRoot, path)),
})).filter(({ relativePath }) => (
    !config.selection.excludePriorManifestFiles || !priorFiles.has(relativePath)
)).sort((left, right) => (
    stableOrder(left.relativePath) - stableOrder(right.relativePath)
    || left.relativePath.localeCompare(right.relativePath)
));

const overlap = (left: RwlSeries, right: RwlSeries): number => {
    let count = 0;
    left.valuesByYear.forEach((_, year) => {
        if (right.valuesByYear.has(year)) count += 1;
    });
    return count;
};
const referenceCount = (target: RwlSeries, all: RwlSeries[]): number => all.filter((row) => (
    row.id !== target.id
    && overlap(target, row) >= config.selection.minimumReferenceOverlapYears
)).length;
const completeCalendar = (series: RwlSeries): boolean => (
    series.length === series.endYear - series.startYear + 1
);
const eligibleTarget = (series: RwlSeries, all: RwlSeries[]): boolean => (
    series.length >= config.selection.minimumTargetLength
    && series.length <= config.selection.maximumTargetLength
    && (!config.selection.requireCompleteTargetCalendar || completeCalendar(series))
    && (!config.selection.requireZeroFreeTarget || series.zeroCount === 0)
    && referenceCount(series, all) >= config.selection.minimumReferenceCount
);
const nearestPositiveYear = (series: RwlSeries, desired: number): number => {
    const candidates = Array.from(series.valuesByYear)
        .filter(([, value]) => value > 0)
        .map(([year]) => year)
        .sort((left, right) => Math.abs(left - desired) - Math.abs(right - desired));
    if (!candidates[0]) throw new Error(`no positive year for ${series.id}`);
    return candidates[0];
};
const quantileYear = (series: RwlSeries, fraction: number): number => {
    const lo = series.startYear + config.selection.minimumOlderContextYears;
    const hi = series.endYear - config.selection.minimumNewerContextYears;
    return nearestPositiveYear(series, Math.round(lo + (hi - lo) * fraction));
};
const spacedYears = (series: RwlSeries, count: number): number[] => {
    const lo = series.startYear + config.selection.minimumOlderContextYears;
    const hi = series.endYear - config.selection.minimumNewerContextYears;
    const years = Array.from({ length: count }, (_, index) => nearestPositiveYear(
        series,
        Math.round(lo + (hi - lo) * (index + 1) / (count + 1)),
    )).sort((left, right) => left - right);
    if (new Set(years).size !== count || years.some((year, index) => (
        index > 0 && year - years[index - 1] < config.injection.minimumDiscreteSpacingYears
    ))) throw new Error(`insufficient separated years for ${series.id}:${count}`);
    return years;
};
const observationId = (series: RwlSeries, year: number | null): string => {
    if (year === null) return `${series.id}:whole:${series.startYear}-${series.endYear}`;
    const value = series.valuesByYear.get(year);
    return `${series.id}:${year}:${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`;
};
const truth = (
    series: RwlSeries,
    scenario: string,
    index: number,
    eventType: TruthSpec["eventType"],
    year: number | null,
    shiftYears: number,
): TruthSpec => ({
    truthId: `${series.id}:${scenario}:${index}`,
    eventType,
    year,
    shiftYears,
    observationId: observationId(series, year),
});
const makeScenarios = (fileId: string, series: RwlSeries): ScenarioPlan[] => {
    const singleMissing = quantileYear(series, 0.18);
    const singleFalse = quantileYear(series, 0.36);
    const partial = quantileYear(series, 0.58);
    const contiguous = quantileYear(series, 0.52);
    const endpoint = nearestPositiveYear(
        series,
        series.endYear - config.injection.endpointNewerDistanceYears,
    );
    const multi = Object.fromEntries(config.injection.multiDiscreteMissingCounts.map((count) => [
        count,
        spacedYears(series, count),
    ])) as Record<number, number[]>;
    const compositeMissing = quantileYear(series, 0.28);
    const compositePartial = quantileYear(series, 0.62);
    const compositeFalse = quantileYear(series, 0.78);
    const base = (kind: string, eventComplexity: string, truths: TruthSpec[], parameters: Record<string, unknown> = {}): ScenarioPlan => ({
        scenarioId: `${fileId}:${series.id}:${kind}`,
        kind,
        truthQuality: kind === "clean" ? "negative-clean" : "exact-injected",
        eventComplexity,
        targetId: series.id,
        saveReopenPair: true,
        truths,
        parameters,
    });
    return [
        base("clean", "clean", []),
        base("singleMissingRing", "single", [
            truth(series, "singleMissingRing", 0, "missingRing", singleMissing, -1),
        ]),
        base("singleFalseRing", "single", [
            truth(series, "singleFalseRing", 0, "falseRing", singleFalse, 1),
        ], { falseRingMode: config.injection.falseRingMode }),
        base("singlePartialMove", "single", [
            truth(series, "singlePartialMove", 0, "partialMove", partial, config.injection.partialMoveShiftYears),
        ]),
        base("wholeSeriesMove", "single-global", [
            truth(series, "wholeSeriesMove", 0, "wholeSeriesMove", null, config.injection.wholeSeriesShiftYears),
        ]),
        base("contiguousBlock", "single-contiguous-block", [
            truth(series, "contiguousBlock", 0, "partialMove", contiguous, config.injection.contiguousBlockShiftYears),
        ]),
        ...config.injection.multiDiscreteMissingCounts.map((count) => base(
            `multiDiscreteMissing${count}`,
            `multi-discrete-${count}`,
            multi[count].map((year, index) => truth(
                series,
                `multiDiscreteMissing${count}`,
                index,
                "missingRing",
                year,
                -1,
            )),
            { count },
        )),
        base("composite", "composite-global-local", [
            truth(series, "composite", 0, "wholeSeriesMove", null, config.injection.compositeWholeSeriesShiftYears),
            truth(series, "composite", 1, "missingRing", compositeMissing, -1),
            truth(series, "composite", 2, "partialMove", compositePartial, config.injection.compositePartialShiftYears),
            truth(series, "composite", 3, "falseRing", compositeFalse, 1),
        ], {
            wholeSeriesShiftYears: config.injection.compositeWholeSeriesShiftYears,
            partialShiftYears: config.injection.compositePartialShiftYears,
            falseRingMode: config.injection.falseRingMode,
        }),
        base("endpointCropped", "endpoint-cropped", [
            truth(series, "endpointCropped", 0, "missingRing", endpoint, -1),
        ], {
            newerDistanceYears: config.injection.endpointNewerDistanceYears,
            cropOlderYears: config.injection.cropOlderYears,
        }),
    ];
};

const selectedPrefixes = new Map<string, number>();
const files: Array<Record<string, unknown>> = [];
const unavailableCounts: Record<string, number> = {};
const reject = (reason: string): void => {
    unavailableCounts[reason] = (unavailableCounts[reason] ?? 0) + 1;
};
for (const file of candidates) {
    if (files.length >= config.selection.externalFileCount) break;
    const prefix = file.relativePath.split("/").at(-1)?.slice(0, 3) ?? "unknown";
    if ((selectedPrefixes.get(prefix) ?? 0)
        >= config.selection.maximumFilesPerDatasetPrefix) {
        reject("dataset_prefix_quota");
        continue;
    }
    let parsed: Map<string, RwlSeries>;
    try {
        parsed = parseRwl(readFileSync(file.path, "utf8"));
    } catch {
        reject("parse_failed");
        continue;
    }
    const all = Array.from(parsed.values());
    if (all.length < config.selection.minimumSeriesPerFile) {
        reject("too_few_series");
        continue;
    }
    if (all.length > config.selection.maximumSeriesPerFile) {
        reject("too_many_series");
        continue;
    }
    const targets = all.filter((series) => eligibleTarget(series, all)).sort((left, right) => (
        stableOrder(`${file.relativePath}:${left.id}`)
        - stableOrder(`${file.relativePath}:${right.id}`)
        || left.id.localeCompare(right.id)
    ));
    if (targets.length < config.selection.targetsPerFile) {
        reject("insufficient_eligible_targets");
        continue;
    }
    let targetPlans: TargetPlan[];
    try {
        targetPlans = targets.slice(0, config.selection.targetsPerFile).map((series) => ({
            targetId: series.id,
            startYear: series.startYear,
            endYear: series.endYear,
            seriesLength: series.length,
            zeroCount: series.zeroCount,
            referenceCount: referenceCount(series, all),
            scenarios: makeScenarios(file.relativePath, series),
        }));
    } catch {
        reject("scenario_years_unavailable");
        continue;
    }
    const chronologyYears = all.flatMap((series) => [series.startYear, series.endYear]);
    const index = files.length;
    files.push({
        fileId: `itrdb-${String(index + 1).padStart(2, "0")}-${createHash("sha256").update(file.relativePath).digest("hex").slice(0, 10)}`,
        role: index < config.selection.pilotFileCount ? "external-pilot" : "external-full",
        source: "ITRDB",
        path: file.path.replace(/\\/g, "/"),
        relativePath: file.relativePath,
        sha256: sha256(file.path),
        rwlFormat: "tucson-auto",
        seriesCount: all.length,
        usableTargetCount: targets.length,
        chronologyRange: {
            startYear: Math.min(...chronologyYears),
            endYear: Math.max(...chronologyYears),
        },
        truthQuality: ["exact-injected", "negative-clean"],
        developmentExposure: "unknown",
        developmentExposureNote: "not selected by itrdb-validation-v1 manifest; other historical exploratory exposure cannot be excluded",
        cleanBaselineAvailable: true,
        referenceAvailable: true,
        cofechaAvailable: true,
        unavailableReason: null,
        negativeTargetIds: targets.slice(0, config.selection.negativeTargetsPerFile).map((series) => series.id),
        targets: targetPlans,
    });
    selectedPrefixes.set(prefix, (selectedPrefixes.get(prefix) ?? 0) + 1);
}
if (files.length !== config.selection.externalFileCount) {
    throw new Error(`selected ${files.length}/${config.selection.externalFileCount} external files`);
}

const directed = [
    {
        fileId: "zsl-directed-regression",
        source: "ZSL",
        path: resolveRepoPath(config.paths.zslInput).replace(/\\/g, "/"),
        sha256: sha256(resolveRepoPath(config.paths.zslInput)),
        truthQuality: "exact-injected",
        developmentExposure: "known",
        targetId: "ZSL141",
        testPath: "src/features/crossdating/diagnosis/__tests__/zsl141PartialMoveRegression.test.ts",
        purpose: "partial breakpoint and save/reopen directional regression",
    },
    {
        fileId: "mcp17a-directed-regression",
        source: "ITRDB-directed",
        path: resolveRepoPath(config.paths.mcp17aInput).replace(/\\/g, "/"),
        sha256: sha256(resolveRepoPath(config.paths.mcp17aInput)),
        truthQuality: "natural-confirmed",
        developmentExposure: "known",
        targetId: "MCP17A",
        testPath: "src/features/crossdating/diagnosis/__tests__/ausl038Mcp17aPartialMoveRegression.test.ts",
        truthYears: [1779, 1780, 1781, 1782, 1783, 1784, 1785, 1786, 1787],
        expectedFirstFixedYear: 1788,
        expectedShiftYears: -9,
        purpose: "confirmed contiguous natural gap and save/reopen stability",
    },
];
const inputHashes = Object.fromEntries([
    ...files.map((file) => [String(file.fileId), String(file.sha256)]),
    ...directed.map((file) => [file.fileId, file.sha256]),
    ["co612", config.expectedHashes.co612Input],
    ["cofecha", config.expectedHashes.cofechaSidecar],
]);
const manifest = {
    schemaVersion: 1,
    protocolVersion: config.protocolVersion,
    gitCommit: config.gitCommit,
    configPath: relative(repoRoot, configPath).replace(/\\/g, "/"),
    configHash,
    createdBeforeExternalEvaluation: true,
    selection: {
        seed: config.seed,
        candidateFileCount: candidates.length,
        selectedFileCount: files.length,
        pilotFileCount: config.selection.pilotFileCount,
        priorManifestFilesExcluded: priorFiles.size,
        selectedUsingDiagnosisOutput: false,
        selectedUsingSignalStrength: false,
        selectedUsingRingWidthMagnitude: false,
        unavailableCounts,
    },
    inputHashes,
    files,
    directedRegressions: directed,
    omittedSources: [{
        source: "repository-samples",
        reason: "no independent exact truth provenance frozen for this protocol",
    }],
};
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const manifestHash = sha256(outputPath);
console.log(`LEGACY_GENERALIZATION_MANIFEST ${JSON.stringify({
    outputPath,
    configHash,
    manifestHash,
    datasetFiles: allFiles.length,
    priorFilesExcluded: priorFiles.size,
    externalFiles: files.length,
    pilotFiles: config.selection.pilotFileCount,
    targets: files.reduce((sum, file) => sum + (file.targets as TargetPlan[]).length, 0),
    unavailableCounts,
})}`);
