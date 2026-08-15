import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const baseConfigPath = resolve(
    process.argv[2] ?? "docs/benchmarks/itrdb-operation-capability-config-v1.json",
);
const baseManifestPath = resolve(
    process.argv[3] ?? "docs/benchmarks/itrdb-operation-capability-manifest-v1.json",
);
const outputPrefix = process.argv[4]
    ?? "docs/benchmarks/itrdb-operation-capability-paper-v1";
const splitPath = resolve(`${outputPrefix}-split.json`);
const developmentConfigPath = resolve(`${outputPrefix}-development-config.json`);
const holdoutConfigPath = resolve(`${outputPrefix}-holdout-config.json`);
const splitSeed = "itrdb-operation-capability-paper-file-split-2026-08-15-v1";
const scenarioSeed = "itrdb-operation-capability-paper-scenarios-2026-08-15-v1";
const targetSelectionSeed = "itrdb-operation-capability-paper-targets-2026-08-15-v1";
const finalFileCount = 25;
const targetsPerFile = 20;
const requiredFinalCasesPerFamily = 500;
const forcedDevelopmentFiles = new Set(["co612"]);

const digest = (value) => createHash("sha256").update(value).digest("hex");
const baseConfigBytes = readFileSync(baseConfigPath);
const baseManifestBytes = readFileSync(baseManifestPath);
const baseConfig = JSON.parse(baseConfigBytes.toString("utf8"));
const baseManifest = JSON.parse(baseManifestBytes.toString("utf8"));
const eligibleForHoldout = baseManifest.files.filter((file) => (
    file.eligibleTargets.length >= targetsPerFile
    && !forcedDevelopmentFiles.has(file.fileId.toLowerCase())
));
if (eligibleForHoldout.length < finalFileCount) {
    throw new Error(
        `only ${eligibleForHoldout.length} files have ${targetsPerFile} eligible targets`,
    );
}
const holdoutIds = new Set([...eligibleForHoldout]
    .sort((left, right) => digest(`${splitSeed}:${left.sourceSha256}`)
        .localeCompare(digest(`${splitSeed}:${right.sourceSha256}`)))
    .slice(0, finalFileCount)
    .map((file) => file.fileId));
const developmentIds = new Set(baseManifest.files
    .filter((file) => !holdoutIds.has(file.fileId))
    .map((file) => file.fileId));
if ([...holdoutIds].some((fileId) => developmentIds.has(fileId))) {
    throw new Error("development and holdout file sets overlap");
}

const makeConfig = (role, fileIds) => ({
    schemaVersion: 1,
    protocolVersion: "itrdb-operation-capability-v1",
    scenarioGeneratorVersion: 4,
    frozenDate: "2026-08-15",
    seed: scenarioSeed,
    itrdbRoot: baseConfig.itrdbRoot,
    fileIds,
    selection: {
        minimumSeriesYears: baseConfig.selection.minimumSeriesYears,
        minimumMasterCorrelation: baseConfig.selection.minimumMasterCorrelation,
        maximumProblemSegments: baseConfig.selection.maximumProblemSegments,
        minimumOlderContextYears: baseConfig.selection.minimumOlderContextYears,
        minimumNewerContextYears: baseConfig.selection.minimumNewerContextYears,
        maximumTargetsPerFile: targetsPerFile,
        targetSelectionSeed,
        excludeFilesWithoutEligibleTargets: true,
        usesSignalStrength: false,
        usesDiagnosisOutput: false,
    },
    injection: {
        falseRingMode: baseConfig.injection.falseRingMode,
        partialShiftYears: baseConfig.injection.partialShiftYears,
        wholeShiftYears: baseConfig.injection.wholeShiftYears,
        distantSpacingYears: baseConfig.injection.distantSpacingYears,
        distantEventCounts: baseConfig.injection.distantEventCounts,
        nearSpacingYears: baseConfig.injection.nearSpacingYears,
        nearUnitEventCounts: baseConfig.injection.nearUnitEventCounts,
        includeAdjacentOptionalSuccess: false,
        allowedWindowWidths: baseConfig.injection.allowedWindowWidths,
    },
    families: {
        Clean: "one untouched control for every frozen target series",
        A: "one balanced single missing, false, partial, or whole event per target",
        B: "one balanced distant same-type multi-event chain per target",
        C: "one balanced 2-13 year same-direction missing or false chain per target",
        D: "one balanced distant two-, three-, or four-operation composition per target",
    },
    design: {
        scenarioSampling: "balancedOnePerFamily",
        splitId: splitSeed,
        datasetRole: role,
        casesPerTargetPerFamily: 1,
    },
    statistics: {
        clusterUnit: "file",
        bootstrapReplicates: 10000,
        confidenceLevel: 0.95,
        targetCoverage: 0.9,
        seed: `itrdb-operation-capability-paper-bootstrap-${role}-v1`,
    },
    runtime: {
        workers: 16,
        cofechaTimeoutSeconds: baseConfig.runtime.cofechaTimeoutSeconds,
    },
});

const orderedIds = (ids) => baseManifest.files
    .filter((file) => ids.has(file.fileId))
    .map((file) => file.fileId);
const developmentFileIds = orderedIds(developmentIds);
const holdoutFileIds = orderedIds(holdoutIds);
const finalCasesPerFamily = holdoutFileIds.length * targetsPerFile;
if (finalCasesPerFamily !== requiredFinalCasesPerFamily) {
    throw new Error(
        `final holdout must contain exactly ${requiredFinalCasesPerFamily} cases per family; `
        + `selected ${finalCasesPerFamily}`,
    );
}
const developmentConfig = makeConfig("development", developmentFileIds);
const holdoutConfig = makeConfig("finalHoldout", holdoutFileIds);
const split = {
    schemaVersion: 1,
    protocolVersion: "itrdb-operation-capability-paper-split-v1",
    frozenDate: "2026-08-15",
    splitSeed,
    sourceConfigPath: baseConfigPath.replaceAll("\\", "/"),
    sourceManifestPath: baseManifestPath.replaceAll("\\", "/"),
    sourceConfigSha256: digest(baseConfigBytes),
    sourceManifestSha256: digest(baseManifestBytes),
    selection: {
        finalFileCount,
        targetsPerFile,
        minimumEligibleTargetsForFinalFile: targetsPerFile,
        forcedDevelopmentFiles: [...forcedDevelopmentFiles].sort(),
        usesSignalStrength: false,
        usesDiagnosisOutput: false,
    },
    counts: {
        developmentFiles: developmentFileIds.length,
        finalHoldoutFiles: holdoutFileIds.length,
        finalCasesPerFamily,
    },
    files: baseManifest.files.map((file) => ({
        fileId: file.fileId,
        relativePath: file.relativePath,
        sourceSha256: file.sourceSha256,
        eligibleTargetsBeforeLimit: file.eligibleTargets.length,
        role: holdoutIds.has(file.fileId) ? "finalHoldout" : "development",
    })),
};

writeFileSync(splitPath, `${JSON.stringify(split, null, 2)}\n`, "utf8");
writeFileSync(
    developmentConfigPath,
    `${JSON.stringify(developmentConfig, null, 2)}\n`,
    "utf8",
);
writeFileSync(holdoutConfigPath, `${JSON.stringify(holdoutConfig, null, 2)}\n`, "utf8");
console.log(`ITRDB_PAPER_CAPABILITY_SPLIT ${JSON.stringify({
    splitPath,
    developmentConfigPath,
    holdoutConfigPath,
    developmentFiles: developmentFileIds.length,
    finalHoldoutFiles: holdoutFileIds.length,
    finalCasesPerFamily,
    developmentFileIds,
    holdoutFileIds,
})}`);
