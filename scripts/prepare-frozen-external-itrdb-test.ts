/** Selects and freezes a new 50-file external test without reading diagnosis output. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCofechaResult } from "@/features/cofecha/formatter";
import { normalizeCofechaSeriesId } from "@/features/cofecha/seriesId";
import { loadRwl, runCofecha, sha256Bytes } from "./legacy-generalization/evaluator";
import {
    selectFilesForLengthBalance,
    selectLengthBalancedTargets,
} from "./itrdb-operation-capability/externalTargetSelection";
import type {
    CapabilityConfig,
    CapabilityFile,
    CapabilityManifest,
    CapabilityTarget,
} from "./itrdb-operation-capability/types";

type PoolCandidate = {
    fileId: string;
    relativePath: string;
    sourceSha256: string;
    deterministicOrder: string;
    approximateMedianCorrelation?: number;
};

type Pool = {
    schemaVersion: 1;
    itrdbRoot: string;
    excludedHistoricalFileIds: string[];
    candidates: PoolCandidate[];
};

type FileCorrelationBand = "0.50-0.60" | "0.60-0.70" | "0.70-0.80" | "0.80+";

const repoRoot = resolve(
    process.env.CROSSDATING_REPO_ROOT
    ?? fileURLToPath(new URL("..", import.meta.url)),
);
const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string, fallback: string): string => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const poolPath = resolve(valueFor(
    "--pool",
    "D:/软件测试/itrdb-unified-model-v2/external-v1/structural-pool.json",
));
const outputDir = resolve(valueFor(
    "--output-dir",
    "D:/软件测试/itrdb-unified-model-v2/external-v1/protocol",
));
const workDir = resolve(valueFor(
    "--work-dir",
    "D:/软件测试/itrdb-unified-model-v2/external-v1/clean-cofecha-work",
));
const cofechaExe = resolve(valueFor(
    "--cofecha-exe",
    process.env.COFECHA_EXE ?? "D:/软件测试/cofecha-x86_64-pc-windows-msvc.exe",
));
const runtimeManifestPath = resolve(valueFor(
    "--runtime-manifest",
    "D:/软件测试/itrdb-unified-model-v2/artifact-archive-2026-08-28/frozen-runtime-v34-manifest.json",
));
const frozenModelEvidenceCommit = valueFor(
    "--model-evidence-commit",
    "cfa2156dbb7b7686dcc5304b56577bc66d8f6284",
);
const fileCount = Number(valueFor("--files", "50"));
const targetsPerFile = Number(valueFor("--targets-per-file", "10"));
const timeoutSeconds = Number(valueFor("--cofecha-timeout-seconds", "60"));
const reuseCleanWork = valueFor("--reuse-clean-work", "true") !== "false";
const scenarioSeed = valueFor(
    "--scenario-seed",
    "frozen-external-scenarios-2026-08-28-v1",
);
const targetSeed = valueFor(
    "--target-seed",
    "frozen-external-targets-2026-08-28-v1",
);
const bootstrapSeed = valueFor(
    "--bootstrap-seed",
    "frozen-external-file-bootstrap-2026-08-28-v1",
);

const digest = (value: Buffer | string): string => createHash("sha256")
    .update(value).digest("hex");
const slash = (value: string): string => value.replaceAll("\\", "/");
const fileBand = (value: number): FileCorrelationBand | null => (
    value < 0.5
        ? null
        : value < 0.6
            ? "0.50-0.60"
            : value < 0.7
                ? "0.60-0.70"
                : value < 0.8
                    ? "0.70-0.80"
                    : "0.80+"
);
const bands: FileCorrelationBand[] = [
    "0.50-0.60", "0.60-0.70", "0.70-0.80", "0.80+",
];
const quotaBase = Math.floor(fileCount / bands.length);
const quotas: Record<FileCorrelationBand, number> = {
    "0.50-0.60": quotaBase + (fileCount % 4 > 0 ? 1 : 0),
    "0.60-0.70": quotaBase + (fileCount % 4 > 1 ? 1 : 0),
    "0.70-0.80": quotaBase + (fileCount % 4 > 2 ? 1 : 0),
    "0.80+": quotaBase,
};

const pool = JSON.parse(readFileSync(poolPath, "utf8")) as Pool;
const itrdbRoot = resolve(pool.itrdbRoot);
mkdirSync(outputDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const approximateBins = new Map<FileCorrelationBand, PoolCandidate[]>(
    bands.map((band) => [band, []]),
);
pool.candidates.forEach((candidate) => {
    const band = fileBand(candidate.approximateMedianCorrelation ?? -1);
    if (band) approximateBins.get(band)!.push(candidate);
});
approximateBins.forEach((candidates) => candidates.sort((left, right) => (
    left.deterministicOrder.localeCompare(right.deterministicOrder)
)));
const orderedCandidates: PoolCandidate[] = [];
for (let index = 0; ; index += 1) {
    let added = false;
    bands.forEach((band) => {
        const candidate = approximateBins.get(band)![index];
        if (!candidate) return;
        orderedCandidates.push(candidate);
        added = true;
    });
    if (!added) break;
}

const qualifiedByBand = new Map<FileCorrelationBand, CapabilityFile[]>(
    bands.map((band) => [band, []]),
);
const excluded: CapabilityManifest["excludedFiles"] = [];
for (const [index, candidate] of orderedCandidates.entries()) {
    if (bands.every((band) => qualifiedByBand.get(band)!.length >= quotas[band])) break;
    const inputPath = resolve(itrdbRoot, candidate.relativePath);
    try {
        const loaded = await loadRwl(inputPath, "tucson-auto");
        if (loaded.sourceSha256 !== candidate.sourceSha256) {
            throw new Error("source_sha256_changed_since_structural_scan");
        }
        const label = `${String(index + 1).padStart(4, "0")}-${candidate.fileId}`;
        const cachedOutPath = resolve(workDir, label, "VERYCOF.OUT");
        const outText = reuseCleanWork && existsSync(cachedOutPath)
            ? readFileSync(cachedOutPath, "utf8")
            : runCofecha({
                    siteData: loaded.siteData,
                    readResult: loaded.readResult,
                    workDir,
                    label,
                    cofechaExe,
                    timeoutSeconds,
                }).outText;
        const result = parseCofechaResult(outText);
        const band = fileBand(result.seriesIntercorrelation);
        if (!band) throw new Error(`file_intercorrelation_below_minimum:${result.seriesIntercorrelation}`);
        if (result.possibleProblemsCount !== 0) {
            throw new Error(`file_problem_segments_not_zero:${result.possibleProblemsCount}`);
        }
        const eligibleTargets: CapabilityTarget[] = Array.from(loaded.series.values())
            .flatMap((series) => {
                const id = normalizeCofechaSeriesId(series.id);
                const masterCorrelation = result.masterCorrelations.get(id);
                const problemSegments = result.seriesProblemCounts.get(id);
                if (series.length < 100
                    || series.zeroCount !== 0
                    || masterCorrelation === undefined
                    || masterCorrelation < 0.6
                    || problemSegments !== 0) return [];
                return [{
                    targetId: series.id,
                    startYear: series.startYear,
                    endYear: series.endYear,
                    seriesYears: series.length,
                    zeroCount: series.zeroCount,
                    masterCorrelation,
                    problemSegments,
                }];
            });
        if (eligibleTargets.length < targetsPerFile) {
            throw new Error(`zero_free_eligible_targets_below_${targetsPerFile}:${eligibleTargets.length}`);
        }
        qualifiedByBand.get(band)!.push({
            fileId: candidate.fileId,
            relativePath: candidate.relativePath,
            sourceSha256: loaded.sourceSha256,
            cleanCofechaSha256: digest(outText),
            seriesIntercorrelation: result.seriesIntercorrelation,
            possibleProblemSegments: result.possibleProblemsCount,
            totalSeries: loaded.series.size,
            eligibleTargetsBeforeLimit: eligibleTargets.length,
            eligibleTargets,
        });
        console.log(
            `EXTERNAL_FILE accepted=${bands.reduce((sum, item) => sum + qualifiedByBand.get(item)!.length, 0)}/${fileCount}`
            + ` checked=${index + 1}/${orderedCandidates.length}`
            + ` file=${candidate.fileId} band=${band}`
            + ` r=${result.seriesIntercorrelation.toFixed(3)}`
            + ` eligible=${eligibleTargets.length}`,
        );
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        excluded.push({ fileId: candidate.fileId, relativePath: candidate.relativePath, reason });
        console.log(`EXTERNAL_FILE_EXCLUDED checked=${index + 1} file=${candidate.fileId} reason=${reason}`);
    }
}

const requiredByBand: Record<FileCorrelationBand, number> = Object.fromEntries(
    bands.map((band) => [band, Math.min(quotas[band], qualifiedByBand.get(band)!.length)]),
) as Record<FileCorrelationBand, number>;
let fileDeficit = fileCount - Object.values(requiredByBand)
    .reduce((sum, count) => sum + count, 0);
while (fileDeficit > 0) {
    const available = bands.filter((band) => (
        requiredByBand[band] < qualifiedByBand.get(band)!.length
    )).sort((left, right) => (
        (qualifiedByBand.get(right)!.length - requiredByBand[right])
        - (qualifiedByBand.get(left)!.length - requiredByBand[left])
        || left.localeCompare(right)
    ));
    if (available.length === 0) break;
    const band = available[0];
    requiredByBand[band] += 1;
    fileDeficit -= 1;
}
const files = selectFilesForLengthBalance(
    qualifiedByBand,
    requiredByBand,
    targetsPerFile,
    `${targetSeed}:files`,
);
if (files.length !== fileCount) {
    const counts = Object.fromEntries(bands.map((band) => [band, qualifiedByBand.get(band)!.length]));
    throw new Error(`only ${files.length}/${fileCount} files passed frozen quality gates: ${JSON.stringify(counts)}`);
}
const selection = selectLengthBalancedTargets(files, targetsPerFile, targetSeed);
files.forEach((file) => {
    file.eligibleTargets = selection.selectedByFile.get(file.fileId)!;
});

const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
}).trim();
const config: CapabilityConfig = {
    schemaVersion: 1,
    protocolVersion: "itrdb-frozen-external-v1",
    scenarioGeneratorVersion: 6,
    frozenDate: "2026-08-28",
    seed: scenarioSeed,
    itrdbRoot: slash(itrdbRoot),
    fileIds: files.map((file) => file.fileId),
    selection: {
        minimumSeriesYears: 100,
        minimumMasterCorrelation: 0.6,
        maximumProblemSegments: 0,
        minimumFileIntercorrelation: 0.5,
        maximumFileProblemSegments: 0,
        minimumOlderContextYears: 45,
        minimumNewerContextYears: 15,
        maximumTargetsPerFile: targetsPerFile,
        targetSelectionSeed: targetSeed,
        excludeFilesWithoutEligibleTargets: true,
        usesSignalStrength: false,
        usesDiagnosisOutput: false,
    },
    injection: {
        falseRingMode: "moderate",
        partialShiftYears: [-6, -20],
        wholeShiftYears: [-4, -11, -20, -50],
        distantSpacingYears: 30,
        nearSpacingYears: [2, 5, 9, 13],
        distantEventCounts: [2, 3, 4],
        nearUnitEventCounts: [2, 3, 4],
        includeAdjacentOptionalSuccess: false,
        allowedWindowWidths: [5, 7, 9, 13],
    },
    families: {
        Clean: "one untouched control for every frozen target",
        A: "one balanced single missing/false/partial/negative-whole event",
        B: "one length-feasible distant same-type multi-event chain",
        C: "one length-feasible 2-13 year same-direction unit chain",
        D: "one length-feasible distant mixed-operation composition",
    },
    design: {
        scenarioSampling: "balancedOnePerFamily",
        splitId: "frozen-external-50-files-2026-08-28-v1",
        datasetRole: "externalFrozenTest",
        casesPerTargetPerFamily: 1,
        eventPositionWeights: { middle: 0.4, newer: 0.35, barkNear: 0.25 },
        lengthAwareEventCounts: true,
    },
    statistics: {
        clusterUnit: "file",
        bootstrapReplicates: 20_000,
        confidenceLevel: 0.95,
        targetCoverage: 0.9,
        seed: bootstrapSeed,
    },
    runtime: { workers: 12, cofechaTimeoutSeconds: timeoutSeconds },
    evaluationProtocol: {
        version: "frontier-workflow-suggestion-v1",
        mainMetric: "workflowSuggestionAccuracy",
        denominator: "actualFrontierDiagnosisAttempts",
        unreachedEvents: "serialRecoveryOnly",
        wholeSeriesMoveSuccess: "negativeExactShiftNoWindow",
    },
};
const configPath = resolve(outputDir, "external-config.json");
const manifestPath = resolve(outputDir, "external-manifest.json");
const configText = `${JSON.stringify(config, null, 2)}\n`;
writeFileSync(configPath, configText, "utf8");
const manifest: CapabilityManifest = {
    schemaVersion: 1,
    protocolVersion: config.protocolVersion,
    scenarioGeneratorVersion: config.scenarioGeneratorVersion,
    createdAt: new Date().toISOString(),
    gitCommit,
    configPath: slash(relative(repoRoot, configPath)),
    configSha256: digest(configText),
    itrdbRoot: slash(itrdbRoot),
    cofechaSha256: sha256Bytes(readFileSync(cofechaExe)),
    files,
    excludedFiles: excluded,
    counts: {
        requestedFiles: fileCount,
        includedFiles: files.length,
        excludedFiles: excluded.length,
        totalSeries: files.reduce((sum, file) => sum + file.totalSeries, 0),
        eligibleTargetsBeforeLimit: files.reduce(
            (sum, file) => sum + (file.eligibleTargetsBeforeLimit ?? 0),
            0,
        ),
        eligibleTargets: files.reduce((sum, file) => sum + file.eligibleTargets.length, 0),
    },
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const lock = {
    schemaVersion: 1,
    frozenAt: new Date().toISOString(),
    executionGitCommit: gitCommit,
    frozenModelEvidenceCommit,
    frozenModelRuntimeManifest: slash(runtimeManifestPath),
    frozenModelRuntimeManifestSha256: sha256Bytes(readFileSync(runtimeManifestPath)),
    scenarioGeneratorPath: "scripts/itrdb-operation-capability/scenarios.ts",
    scenarioGeneratorSha256: sha256Bytes(readFileSync(resolve(repoRoot, "scripts/itrdb-operation-capability/scenarios.ts"))),
    configPath: slash(configPath),
    configSha256: digest(configText),
    manifestPath: slash(manifestPath),
    manifestSha256: sha256Bytes(readFileSync(manifestPath)),
    cofechaExeSha256: manifest.cofechaSha256,
    seeds: { scenarioSeed, targetSeed, bootstrapSeed },
    fileCorrelationQuotas: quotas,
    fileCorrelationCounts: requiredByBand,
    fileCorrelationQualifiedCounts: Object.fromEntries(bands.map((band) => [band, qualifiedByBand.get(band)!.length])),
    fileCorrelationQuotaShortfall: Object.fromEntries(bands.map((band) => [
        band,
        Math.max(0, quotas[band] - qualifiedByBand.get(band)!.length),
    ])),
    targetLengthIdealCounts: selection.idealCounts,
    targetLengthCounts: selection.counts,
    fileIds: files.map((file) => file.fileId),
    postTestPolicy: "analysis_only_no_training_calibration_threshold_or_case_replacement",
};
writeFileSync(
    resolve(outputDir, "external-protocol-lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
    "utf8",
);
writeFileSync(
    resolve(outputDir, "selection-audit.json"),
    `${JSON.stringify({
        quotas,
        files,
        qualifiedFiles: bands.flatMap((band) => qualifiedByBand.get(band)!),
        excluded,
    }, null, 2)}\n`,
    "utf8",
);
console.log(`EXTERNAL_PROTOCOL_FROZEN ${JSON.stringify({
    outputDir,
    files: files.length,
    targets: manifest.counts.eligibleTargets,
    fileCorrelationCounts: lock.fileCorrelationCounts,
    targetLengthCounts: lock.targetLengthCounts,
})}`);
