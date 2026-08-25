/** Runs clean COFECHA and freezes unseen development/calibration/final file splits. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCofechaResult } from "@/features/cofecha/formatter";
import { normalizeCofechaSeriesId } from "@/features/cofecha/seriesId";
import {
    loadRwl,
    runCofecha,
    sha256Bytes,
} from "./legacy-generalization/evaluator";
import type {
    CapabilityConfig,
    CapabilityFile,
    CapabilityManifest,
    CapabilityTarget,
} from "./itrdb-operation-capability/types";

type Pool = {
    schemaVersion: 1;
    itrdbRoot: string;
    excludedHistoricalFileIds: string[];
    candidates: {
        fileId: string;
        relativePath: string;
        sourceSha256: string;
        deterministicOrder: string;
    }[];
};

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
    "D:/软件测试/itrdb-unified-model-v2/unseen-structural-pool.json",
));
const outputDir = resolve(valueFor(
    "--output-dir",
    "D:/软件测试/itrdb-unified-model-v2/protocol-v1",
));
const workDir = resolve(valueFor(
    "--work-dir",
    "D:/软件测试/itrdb-unified-model-v2/clean-cofecha-work",
));
const cofechaExeInput = valueFor(
    "--cofecha-exe",
    process.env.COFECHA_EXE ?? "D:/软件测试/cofecha-x86_64-pc-windows-msvc.exe",
);
const cofechaExe = resolve(cofechaExeInput);
const minimumFileIntercorrelation = Number(valueFor(
    "--minimum-file-intercorrelation",
    "0.80",
));
const maximumFileProblemSegments = Number(valueFor(
    "--maximum-file-problem-segments",
    "0",
));
const minimumSeriesYears = Number(valueFor("--minimum-series-years", "200"));
const minimumMasterCorrelation = Number(valueFor(
    "--minimum-master-correlation",
    "0.80",
));
const maximumSeriesProblemSegments = Number(valueFor(
    "--maximum-series-problem-segments",
    "0",
));
const targetsPerFile = Number(valueFor("--targets-per-file", "6"));
const developmentFiles = Number(valueFor("--development-files", "18"));
const calibrationFiles = Number(valueFor("--calibration-files", "10"));
const finalFiles = Number(valueFor("--final-files", "17"));
const desiredQualifiedFiles = Number(valueFor("--qualified-files", "60"));
const timeoutSeconds = Number(valueFor("--cofecha-timeout-seconds", "60"));
const splitSeed = valueFor(
    "--split-seed",
    "unified-adjudicator-unseen-file-split-2026-08-23-v1",
);
const targetSeed = valueFor(
    "--target-seed",
    "unified-adjudicator-unseen-targets-2026-08-23-v1",
);
const scenarioSeed = valueFor(
    "--scenario-seed",
    "unified-adjudicator-unseen-scenarios-2026-08-23-v1",
);
const exclusionManifestPaths = valueFor("--exclude-manifests", "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value));

const excludedFileIds = new Set<string>();
const collectExcludedIds = (value: unknown): void => {
    if (Array.isArray(value)) {
        value.forEach(collectExcludedIds);
        return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.fileId === "string") {
        excludedFileIds.add(record.fileId.toLowerCase());
    }
    if (Array.isArray(record.fileIds)) {
        record.fileIds.forEach((fileId) => {
            if (typeof fileId === "string") excludedFileIds.add(fileId.toLowerCase());
        });
    }
    Object.values(record).forEach(collectExcludedIds);
};
exclusionManifestPaths.forEach((path) => {
    collectExcludedIds(JSON.parse(readFileSync(path, "utf8")));
});

const digest = (value: Buffer | string): string => createHash("sha256")
    .update(value).digest("hex");
const slash = (value: string): string => value.replaceAll("\\", "/");
const pool = JSON.parse(readFileSync(poolPath, "utf8")) as Pool;
const itrdbRoot = resolve(pool.itrdbRoot);
const requiredFiles = developmentFiles + calibrationFiles + finalFiles;
if (desiredQualifiedFiles < requiredFiles) {
    throw new Error("qualified file target is smaller than the requested split");
}
mkdirSync(outputDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const qualified: CapabilityFile[] = [];
const excluded: CapabilityManifest["excludedFiles"] = [];
for (const [index, candidate] of pool.candidates.entries()) {
    if (qualified.length >= desiredQualifiedFiles) break;
    if (excludedFileIds.has(candidate.fileId.toLowerCase())) continue;
    const inputPath = resolve(itrdbRoot, candidate.relativePath);
    try {
        const loaded = await loadRwl(inputPath, "tucson-auto");
        if (loaded.sourceSha256 !== candidate.sourceSha256) {
            throw new Error("source_sha256_changed_since_structural_scan");
        }
        const context = runCofecha({
            siteData: loaded.siteData,
            readResult: loaded.readResult,
            workDir,
            label: `${String(index + 1).padStart(4, "0")}-${candidate.fileId}`,
            cofechaExe,
            timeoutSeconds,
        });
        const result = parseCofechaResult(context.outText);
        if (result.seriesIntercorrelation < minimumFileIntercorrelation) {
            throw new Error(
                `file_intercorrelation_below_minimum:${result.seriesIntercorrelation}`,
            );
        }
        if (result.possibleProblemsCount > maximumFileProblemSegments) {
            throw new Error(
                `file_problem_segments_above_maximum:${result.possibleProblemsCount}`,
            );
        }
        const eligibleBeforeLimit: CapabilityTarget[] = Array.from(loaded.series.values())
            .flatMap((series) => {
                const id = normalizeCofechaSeriesId(series.id);
                const masterCorrelation = result.masterCorrelations.get(id);
                const problemSegments = result.seriesProblemCounts.get(id);
                if (series.length < minimumSeriesYears
                    || masterCorrelation === undefined
                    || masterCorrelation < minimumMasterCorrelation
                    || problemSegments === undefined
                    || problemSegments > maximumSeriesProblemSegments) return [];
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
        if (eligibleBeforeLimit.length < targetsPerFile) {
            throw new Error(`eligible_targets_below_minimum:${eligibleBeforeLimit.length}`);
        }
        const eligibleTargets = [...eligibleBeforeLimit]
            .sort((left, right) => (
                digest(`${targetSeed}:${candidate.fileId}:${left.targetId}`)
                    .localeCompare(digest(`${targetSeed}:${candidate.fileId}:${right.targetId}`))
                || left.targetId.localeCompare(right.targetId)
            ))
            .slice(0, targetsPerFile)
            .sort((left, right) => left.targetId.localeCompare(right.targetId));
        qualified.push({
            fileId: candidate.fileId,
            relativePath: candidate.relativePath,
            sourceSha256: loaded.sourceSha256,
            cleanCofechaSha256: digest(context.outText),
            seriesIntercorrelation: result.seriesIntercorrelation,
            possibleProblemSegments: result.possibleProblemsCount,
            totalSeries: loaded.series.size,
            eligibleTargetsBeforeLimit: eligibleBeforeLimit.length,
            eligibleTargets,
        });
        console.log(
            `UNSEEN_COFECHA accepted=${qualified.length}/${desiredQualifiedFiles}`
            + ` checked=${index + 1}/${pool.candidates.length}`
            + ` file=${candidate.fileId}`
            + ` r=${result.seriesIntercorrelation.toFixed(3)}`
            + ` eligible=${eligibleBeforeLimit.length}`,
        );
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        excluded.push({
            fileId: candidate.fileId,
            relativePath: candidate.relativePath,
            reason,
        });
        console.log(
            `UNSEEN_COFECHA_EXCLUDED checked=${index + 1}/${pool.candidates.length}`
            + ` file=${candidate.fileId} reason=${reason}`,
        );
    }
}
if (qualified.length < requiredFiles) {
    throw new Error(
        `only ${qualified.length} clean high-quality files; ${requiredFiles} required`,
    );
}

const ordered = [...qualified].sort((left, right) => (
    digest(`${splitSeed}:${left.sourceSha256}`)
        .localeCompare(digest(`${splitSeed}:${right.sourceSha256}`))
));
const roleByFile = new Map<string, "development" | "calibration" | "finalHoldout">();
ordered.slice(0, developmentFiles).forEach((file) => roleByFile.set(file.fileId, "development"));
ordered.slice(developmentFiles, developmentFiles + calibrationFiles)
    .forEach((file) => roleByFile.set(file.fileId, "calibration"));
ordered.slice(developmentFiles + calibrationFiles, requiredFiles)
    .forEach((file) => roleByFile.set(file.fileId, "finalHoldout"));

const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
}).trim();
const cofechaSha256 = sha256Bytes(readFileSync(cofechaExe));
const makeConfig = (
    role: "development" | "calibration" | "finalHoldout",
    files: CapabilityFile[],
): CapabilityConfig => ({
    schemaVersion: 1,
    protocolVersion: "itrdb-unified-adjudicator-v2",
    scenarioGeneratorVersion: 5,
    frozenDate: "2026-08-23",
    seed: scenarioSeed,
    itrdbRoot: slash(itrdbRoot),
    fileIds: files.map((file) => file.fileId),
    selection: {
        minimumSeriesYears,
        minimumMasterCorrelation,
        maximumProblemSegments: maximumSeriesProblemSegments,
        minimumFileIntercorrelation,
        maximumFileProblemSegments,
        minimumOlderContextYears: 45,
        minimumNewerContextYears: 35,
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
        distantEventCounts: [2, 3, 4],
        nearSpacingYears: [2, 5, 9, 13],
        nearUnitEventCounts: [2, 3, 4],
        includeAdjacentOptionalSuccess: false,
        allowedWindowWidths: [5, 7, 9, 13],
    },
    families: {
        Clean: "one untouched control per frozen target",
        A: "one balanced single event per frozen target",
        B: "one distant same-type multi-event chain per frozen target",
        C: "one 2-13 year same-direction unit chain per frozen target",
        D: "one distant mixed-operation composition per frozen target",
    },
    design: {
        scenarioSampling: "balancedOnePerFamily",
        splitId: splitSeed,
        datasetRole: role,
        casesPerTargetPerFamily: 1,
    },
    statistics: {
        clusterUnit: "file",
        bootstrapReplicates: 20_000,
        confidenceLevel: 0.95,
        targetCoverage: 0.9,
        seed: `${splitSeed}:${role}:bootstrap`,
    },
    runtime: {
        workers: 12,
        cofechaTimeoutSeconds: timeoutSeconds,
    },
    evaluationProtocol: {
        version: "frontier-workflow-suggestion-v1",
        mainMetric: "workflowSuggestionAccuracy",
        denominator: "actualFrontierDiagnosisAttempts",
        unreachedEvents: "serialRecoveryOnly",
        wholeSeriesMoveSuccess: "negativeExactShiftNoWindow",
    },
});

const writeRole = (
    role: "development" | "calibration" | "finalHoldout",
): { configPath: string; manifestPath: string; files: CapabilityFile[] } => {
    const files = ordered.filter((file) => roleByFile.get(file.fileId) === role);
    const config = makeConfig(role, files);
    const configPath = resolve(outputDir, `${role}-config.json`);
    const manifestPath = resolve(outputDir, `${role}-manifest.json`);
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
        cofechaSha256,
        files,
        excludedFiles: [],
        counts: {
            requestedFiles: files.length,
            includedFiles: files.length,
            excludedFiles: 0,
            totalSeries: files.reduce((sum, file) => sum + file.totalSeries, 0),
            eligibleTargetsBeforeLimit: files.reduce(
                (sum, file) => sum + (file.eligibleTargetsBeforeLimit ?? 0),
                0,
            ),
            eligibleTargets: files.reduce(
                (sum, file) => sum + file.eligibleTargets.length,
                0,
            ),
        },
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { configPath, manifestPath, files };
};

const roles = {
    development: writeRole("development"),
    calibration: writeRole("calibration"),
    finalHoldout: writeRole("finalHoldout"),
};
const split = {
    schemaVersion: 1,
    protocolVersion: "itrdb-unified-adjudicator-v2",
    createdAt: new Date().toISOString(),
    gitCommit,
    poolPath: slash(poolPath),
    poolSha256: sha256Bytes(readFileSync(poolPath)),
    cofechaExe: slash(cofechaExe),
    cofechaSha256,
    splitSeed,
    targetSeed,
    scenarioSeed,
    exclusionManifestPaths: exclusionManifestPaths.map(slash),
    excludedFileIds: [...excludedFileIds].sort(),
    historicalFileIdsExcluded: pool.excludedHistoricalFileIds.length,
    quality: {
        minimumFileIntercorrelation,
        maximumFileProblemSegments,
        minimumSeriesYears,
        minimumMasterCorrelation,
        maximumSeriesProblemSegments,
        targetsPerFile,
    },
    counts: {
        qualifiedFiles: qualified.length,
        developmentFiles,
        calibrationFiles,
        finalFiles,
        casesPerFamily: {
            development: developmentFiles * targetsPerFile,
            calibration: calibrationFiles * targetsPerFile,
            finalHoldout: finalFiles * targetsPerFile,
        },
    },
    files: ordered.map((file) => ({
        fileId: file.fileId,
        relativePath: file.relativePath,
        sourceSha256: file.sourceSha256,
        role: roleByFile.get(file.fileId) ?? "reserve",
        seriesIntercorrelation: file.seriesIntercorrelation,
        possibleProblemSegments: file.possibleProblemSegments,
        eligibleTargets: file.eligibleTargets.length,
    })),
    excluded,
    roleArtifacts: Object.fromEntries(Object.entries(roles).map(([role, value]) => [
        role,
        {
            configPath: slash(value.configPath),
            manifestPath: slash(value.manifestPath),
            fileIds: value.files.map((file) => file.fileId),
        },
    ])),
};
writeFileSync(
    resolve(outputDir, "frozen-split.json"),
    `${JSON.stringify(split, null, 2)}\n`,
    "utf8",
);
writeFileSync(
    resolve(outputDir, "qualified-pool.json"),
    `${JSON.stringify({ qualified, excluded }, null, 2)}\n`,
    "utf8",
);
console.log(`UNSEEN_SPLIT_COMPLETE ${JSON.stringify({
    outputDir,
    qualifiedFiles: qualified.length,
    development: roles.development.files.map((file) => file.fileId),
    calibration: roles.calibration.files.map((file) => file.fileId),
    finalHoldout: roles.finalHoldout.files.map((file) => file.fileId),
})}`);
