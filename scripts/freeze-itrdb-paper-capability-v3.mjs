import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const protocolVersion = "itrdb-operation-capability-v3";
const scenarioGeneratorVersion = 5;
const frozenDate = "2026-08-16";
const wholeShiftYears = [-4, -11, -20, -50];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const repoPath = (path) => relative(repoRoot, path).replaceAll("\\", "/");
const currentGitCommit = () => execFileSync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true },
).trim();

for (const role of ["development", "holdout"]) {
    const v2Prefix = resolve(
        repoRoot,
        `docs/benchmarks/itrdb-operation-capability-paper-v2-${role}`,
    );
    const v3Prefix = resolve(
        repoRoot,
        `docs/benchmarks/itrdb-operation-capability-paper-v3-${role}`,
    );
    const v2Config = JSON.parse(readFileSync(`${v2Prefix}-config.json`, "utf8"));
    const v2Manifest = JSON.parse(readFileSync(`${v2Prefix}-manifest.json`, "utf8"));
    const configPath = `${v3Prefix}-config.json`;
    const manifestPath = `${v3Prefix}-manifest.json`;
    const config = {
        ...v2Config,
        protocolVersion,
        scenarioGeneratorVersion,
        frozenDate,
        seed: "itrdb-operation-capability-paper-scenarios-2026-08-16-v3",
        injection: {
            ...v2Config.injection,
            wholeShiftYears,
        },
        statistics: {
            ...v2Config.statistics,
            seed: `itrdb-operation-capability-paper-bootstrap-${v2Config.design.datasetRole}-v3`,
        },
        evaluationProtocol: {
            version: "frontier-workflow-suggestion-v1",
            mainMetric: "workflowSuggestionAccuracy",
            denominator: "actualFrontierDiagnosisAttempts",
            unreachedEvents: "serialRecoveryOnly",
            wholeSeriesMoveSuccess: "negativeExactShiftNoWindow",
        },
    };
    const configBytes = `${JSON.stringify(config, null, 2)}\n`;
    const manifest = {
        ...v2Manifest,
        protocolVersion,
        scenarioGeneratorVersion,
        createdAt: new Date().toISOString(),
        gitCommit: currentGitCommit(),
        configPath: repoPath(configPath),
        configSha256: sha256(configBytes),
    };
    writeFileSync(configPath, configBytes, "utf8");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`ITRDB_CAPABILITY_V3_FROZEN ${JSON.stringify({
        role,
        configPath,
        manifestPath,
        files: manifest.files.length,
        targets: manifest.counts.eligibleTargets,
        wholeShiftYears,
    })}`);
}
