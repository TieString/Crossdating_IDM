import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const protocolVersion = "itrdb-operation-capability-v2";
const frozenDate = "2026-08-16";
const wholeShiftYears = [-4, 4, -11, 11, -20, 20, -50, 50];

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const repoPath = (path) => relative(repoRoot, path).replaceAll("\\", "/");
const currentGitCommit = () => execFileSync(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true },
).trim();

for (const role of ["development", "holdout"]) {
    const v1Prefix = resolve(
        repoRoot,
        `docs/benchmarks/itrdb-operation-capability-paper-v1-${role}`,
    );
    const v2Prefix = resolve(
        repoRoot,
        `docs/benchmarks/itrdb-operation-capability-paper-v2-${role}`,
    );
    const v1Config = JSON.parse(readFileSync(`${v1Prefix}-config.json`, "utf8"));
    const v1Manifest = JSON.parse(readFileSync(`${v1Prefix}-manifest.json`, "utf8"));
    const configPath = `${v2Prefix}-config.json`;
    const manifestPath = `${v2Prefix}-manifest.json`;
    const config = {
        ...v1Config,
        protocolVersion,
        frozenDate,
        seed: "itrdb-operation-capability-paper-scenarios-2026-08-16-v2",
        injection: {
            ...v1Config.injection,
            wholeShiftYears,
        },
        statistics: {
            ...v1Config.statistics,
            seed: `itrdb-operation-capability-paper-bootstrap-${v1Config.design.datasetRole}-v2`,
        },
    };
    const configBytes = `${JSON.stringify(config, null, 2)}\n`;
    const manifest = {
        ...v1Manifest,
        protocolVersion,
        createdAt: new Date().toISOString(),
        gitCommit: currentGitCommit(),
        configPath: repoPath(configPath),
        configSha256: sha256(configBytes),
    };
    writeFileSync(configPath, configBytes, "utf8");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`ITRDB_CAPABILITY_V2_FROZEN ${JSON.stringify({
        role,
        configPath,
        manifestPath,
        files: manifest.files.length,
        targets: manifest.counts.eligibleTargets,
        wholeShiftYears,
    })}`);
}
