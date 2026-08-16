import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const priorPrefix = resolve(
    repoRoot,
    "docs/benchmarks/itrdb-operation-capability-paper-v3-holdout",
);
const baseManifestPath = resolve(
    repoRoot,
    "docs/benchmarks/itrdb-operation-capability-manifest-v1.json",
);
const outputPrefix = resolve(
    repoRoot,
    "docs/benchmarks/itrdb-operation-capability-paper-v4-1000-holdout",
);
const configPath = `${outputPrefix}-config.json`;
const manifestPath = `${outputPrefix}-manifest.json`;
const protocolVersion = "itrdb-operation-capability-v4-1000";
const frozenDate = "2026-08-17";
const targetCount = 1000;
const expansionSeed = "itrdb-operation-capability-paper-target-expansion-2026-08-17-v4";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const repoPath = (path) => relative(repoRoot, path).replaceAll("\\", "/");
const currentGitCommit = () => execFileSync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true },
).trim();
const targetKey = (fileId, targetId) => `${fileId}\u0000${targetId}`;
const selectionKey = (fileId, targetId) => sha256(
    `${expansionSeed}:${fileId}:${targetId}`,
);

const priorConfig = JSON.parse(readFileSync(`${priorPrefix}-config.json`, "utf8"));
const priorManifest = JSON.parse(readFileSync(`${priorPrefix}-manifest.json`, "utf8"));
const baseManifest = JSON.parse(readFileSync(baseManifestPath, "utf8"));
const priorFileIds = priorManifest.files.map((file) => file.fileId);
const priorFileIdSet = new Set(priorFileIds);
const baseFiles = new Map(baseManifest.files
    .filter((file) => priorFileIdSet.has(file.fileId))
    .map((file) => [file.fileId, file]));
if (baseFiles.size !== priorFileIds.length) {
    throw new Error("base manifest does not contain every frozen v3 holdout file");
}

const priorTargets = new Set(priorManifest.files.flatMap((file) => (
    file.eligibleTargets.map((target) => targetKey(file.fileId, target.targetId))
)));
if (priorTargets.size !== priorManifest.counts.eligibleTargets) {
    throw new Error("v3 holdout target ids are not unique");
}
const availableAdditions = priorFileIds.flatMap((fileId) => {
    const file = baseFiles.get(fileId);
    return file.eligibleTargets
        .filter((target) => !priorTargets.has(targetKey(fileId, target.targetId)))
        .map((target) => ({ fileId, target }));
}).sort((left, right) => (
    selectionKey(left.fileId, left.target.targetId)
        .localeCompare(selectionKey(right.fileId, right.target.targetId))
    || left.fileId.localeCompare(right.fileId)
    || left.target.targetId.localeCompare(right.target.targetId)
));
const requiredAdditions = targetCount - priorTargets.size;
if (requiredAdditions <= 0 || availableAdditions.length < requiredAdditions) {
    throw new Error(
        `cannot expand ${priorTargets.size} targets to ${targetCount}; `
        + `only ${availableAdditions.length} additions are available`,
    );
}
const selectedAdditionKeys = new Set(availableAdditions
    .slice(0, requiredAdditions)
    .map(({ fileId, target }) => targetKey(fileId, target.targetId)));
const {
    maximumTargetsPerFile: _priorMaximumTargetsPerFile,
    ...priorSelection
} = priorConfig.selection;

const config = {
    ...priorConfig,
    protocolVersion,
    frozenDate,
    seed: "itrdb-operation-capability-paper-scenarios-2026-08-17-v4-1000",
    selection: {
        ...priorSelection,
        targetSelectionSeed: expansionSeed,
        globalTargetCount: targetCount,
        priorTargetsRetained: priorTargets.size,
    },
    design: {
        ...priorConfig.design,
        datasetRole: "expandedFrozenHoldoutReuse",
        priorProtocolVersion: priorConfig.protocolVersion,
        targetExpansion: "retainPrior500PlusDeterministic500",
    },
    statistics: {
        ...priorConfig.statistics,
        seed: "itrdb-operation-capability-paper-bootstrap-expanded-v4-1000",
    },
};
const configBytes = `${JSON.stringify(config, null, 2)}\n`;
const files = priorFileIds.map((fileId) => {
    const priorFile = priorManifest.files.find((file) => file.fileId === fileId);
    const baseFile = baseFiles.get(fileId);
    const priorIds = new Set(priorFile.eligibleTargets.map((target) => target.targetId));
    const additions = baseFile.eligibleTargets.filter((target) => (
        selectedAdditionKeys.has(targetKey(fileId, target.targetId))
    )).sort((left, right) => (
        selectionKey(fileId, left.targetId).localeCompare(selectionKey(fileId, right.targetId))
        || left.targetId.localeCompare(right.targetId)
    ));
    const eligibleTargets = [
        ...priorFile.eligibleTargets,
        ...additions.filter((target) => !priorIds.has(target.targetId)),
    ];
    return {
        ...baseFile,
        eligibleTargets,
    };
});
const selectedTargetCount = files.reduce(
    (sum, file) => sum + file.eligibleTargets.length,
    0,
);
if (selectedTargetCount !== targetCount) {
    throw new Error(`expected ${targetCount} selected targets, got ${selectedTargetCount}`);
}
const manifest = {
    ...priorManifest,
    protocolVersion,
    createdAt: new Date().toISOString(),
    gitCommit: currentGitCommit(),
    configPath: repoPath(configPath),
    configSha256: sha256(configBytes),
    files,
    counts: {
        ...priorManifest.counts,
        totalSeries: files.reduce((sum, file) => sum + file.totalSeries, 0),
        eligibleTargetsBeforeLimit: files.reduce(
            (sum, file) => sum + file.eligibleTargetsBeforeLimit,
            0,
        ),
        eligibleTargets: selectedTargetCount,
    },
    expansion: {
        priorProtocolVersion: priorConfig.protocolVersion,
        priorTargetCount: priorTargets.size,
        addedTargetCount: requiredAdditions,
        availableTargetCount: priorTargets.size + availableAdditions.length,
        selectionSeed: expansionSeed,
    },
};

writeFileSync(configPath, configBytes, "utf8");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`ITRDB_CAPABILITY_V4_1000_FROZEN ${JSON.stringify({
    configPath,
    manifestPath,
    files: files.length,
    targets: selectedTargetCount,
    retainedTargets: priorTargets.size,
    addedTargets: requiredAdditions,
    availableTargets: priorTargets.size + availableAdditions.length,
})}`);
