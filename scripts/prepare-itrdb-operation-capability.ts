/** Builds a frozen, truth-blind ITRDB target manifest from clean COFECHA PART 7 metrics. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
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
import { selectManifestTargets } from "./itrdb-operation-capability/manifestSelection";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    if (index >= 0) return args[index + 1] ?? null;
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    return inline?.slice(name.length + 1) ?? null;
};
const configPath = resolve(valueFor("--config")
    ?? "docs/benchmarks/itrdb-operation-capability-config-v1.json");
const outputPath = resolve(valueFor("--output")
    ?? "docs/benchmarks/itrdb-operation-capability-manifest-v1.json");
const workRoot = resolve(valueFor("--work-dir")
    ?? "D:/软件测试/itrdb-operation-capability/manifest-clean-cofecha-v1");
const cofechaExe = resolve(valueFor("--cofecha-exe")
    ?? "src-tauri/bin/cofecha-x86_64-pc-windows-msvc.exe");

if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`);
if (!existsSync(cofechaExe)) throw new Error(`COFECHA not found: ${cofechaExe}`);
const configBytes = readFileSync(configPath);
const config = JSON.parse(configBytes.toString("utf8")) as CapabilityConfig;
if (config.protocolVersion !== "itrdb-operation-capability-v1") {
    throw new Error(`unsupported protocol: ${config.protocolVersion}`);
}
const itrdbRoot = resolve(config.itrdbRoot);
if (!existsSync(itrdbRoot)) throw new Error(`ITRDB root not found: ${itrdbRoot}`);
mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(workRoot, { recursive: true });

const sha256 = (value: Buffer | string): string => createHash("sha256")
    .update(value).digest("hex");
const allRwlByName = new Map<string, string[]>();
const scan = (directory: string): void => {
    readdirSync(directory).forEach((entry) => {
        const path = resolve(directory, entry);
        if (statSync(path).isDirectory()) {
            scan(path);
            return;
        }
        if (!entry.toLowerCase().endsWith(".rwl")) return;
        const key = entry.toLowerCase();
        allRwlByName.set(key, [...allRwlByName.get(key) ?? [], path]);
    });
};
scan(itrdbRoot);

const files: CapabilityFile[] = [];
const excludedFiles: CapabilityManifest["excludedFiles"] = [];
for (const [fileIndex, fileId] of config.fileIds.entries()) {
    const paths = allRwlByName.get(`${fileId.toLowerCase()}.rwl`) ?? [];
    if (paths.length !== 1) {
        excludedFiles.push({
            fileId,
            relativePath: paths[0] ? relative(itrdbRoot, paths[0]).replaceAll("\\", "/") : null,
            reason: paths.length === 0 ? "source_not_found" : `ambiguous_source:${paths.length}`,
        });
        continue;
    }
    const inputPath = paths[0];
    const relativePath = relative(itrdbRoot, inputPath).replaceAll("\\", "/");
    try {
        const loaded = await loadRwl(inputPath, "tucson-auto");
        const sourceHashBefore = loaded.sourceSha256;
        const context = runCofecha({
            siteData: loaded.siteData,
            readResult: loaded.readResult,
            workDir: workRoot,
            label: fileId,
            cofechaExe,
            timeoutSeconds: config.runtime.cofechaTimeoutSeconds,
        });
        const result = parseCofechaResult(context.outText);
        const sourceHashAfterCofecha = sha256Bytes(readFileSync(inputPath));
        if (sourceHashAfterCofecha !== sourceHashBefore) {
            throw new Error("source hash changed while preparing manifest");
        }
        if (config.selection.minimumFileIntercorrelation !== undefined
            && result.seriesIntercorrelation < config.selection.minimumFileIntercorrelation) {
            excludedFiles.push({
                fileId,
                relativePath,
                reason: `file_intercorrelation_below_minimum:${result.seriesIntercorrelation}`,
            });
            console.log(
                `CAPABILITY_PREPARE_EXCLUDED file=${fileIndex + 1}/${config.fileIds.length}`
                + ` id=${fileId} reason=file_intercorrelation_below_minimum`,
            );
            continue;
        }
        if (config.selection.maximumFileProblemSegments !== undefined
            && result.possibleProblemsCount > config.selection.maximumFileProblemSegments) {
            excludedFiles.push({
                fileId,
                relativePath,
                reason: `file_problem_segments_above_maximum:${result.possibleProblemsCount}`,
            });
            console.log(
                `CAPABILITY_PREPARE_EXCLUDED file=${fileIndex + 1}/${config.fileIds.length}`
                + ` id=${fileId} reason=file_problem_segments_above_maximum`,
            );
            continue;
        }
        const eligibleTargetsBeforeLimit: CapabilityTarget[] = Array.from(loaded.series.values())
            .flatMap((series) => {
                const canonicalId = normalizeCofechaSeriesId(series.id);
                const masterCorrelation = result.masterCorrelations.get(canonicalId);
                const problemSegments = result.seriesProblemCounts.get(canonicalId);
                if (series.length < config.selection.minimumSeriesYears
                    || masterCorrelation === undefined
                    || masterCorrelation < config.selection.minimumMasterCorrelation
                    || problemSegments === undefined
                    || problemSegments > config.selection.maximumProblemSegments) {
                    return [];
                }
                return [{
                    targetId: series.id,
                    startYear: series.startYear,
                    endYear: series.endYear,
                    seriesYears: series.length,
                    zeroCount: series.zeroCount,
                    masterCorrelation,
                    problemSegments,
                }];
            })
            .sort((left, right) => left.targetId.localeCompare(right.targetId));
        const eligibleTargets = selectManifestTargets(
            config,
            fileId,
            eligibleTargetsBeforeLimit,
        );
        if (eligibleTargets.length === 0
            && config.selection.excludeFilesWithoutEligibleTargets) {
            excludedFiles.push({ fileId, relativePath, reason: "no_eligible_target" });
            console.log(
                `CAPABILITY_PREPARE_EXCLUDED file=${fileIndex + 1}/${config.fileIds.length}`
                + ` id=${fileId} reason=no_eligible_target`,
            );
            continue;
        }
        files.push({
            fileId,
            relativePath,
            sourceSha256: sourceHashBefore,
            cleanCofechaSha256: sha256(context.outText),
            seriesIntercorrelation: result.seriesIntercorrelation,
            possibleProblemSegments: result.possibleProblemsCount,
            totalSeries: loaded.series.size,
            eligibleTargetsBeforeLimit: eligibleTargetsBeforeLimit.length,
            eligibleTargets,
        });
        console.log(
            `CAPABILITY_PREPARE file=${fileIndex + 1}/${config.fileIds.length}`
            + ` id=${fileId} eligible=${eligibleTargets.length}`
            + ` beforeLimit=${eligibleTargetsBeforeLimit.length}`,
        );
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        excludedFiles.push({ fileId, relativePath, reason });
        console.error(`CAPABILITY_PREPARE_FAILED id=${fileId} reason=${reason}`);
    }
}

const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
}).trim();
const manifest: CapabilityManifest = {
    schemaVersion: 1,
    protocolVersion: config.protocolVersion,
    scenarioGeneratorVersion: config.scenarioGeneratorVersion ?? 1,
    createdAt: new Date().toISOString(),
    gitCommit,
    configPath: relative(repoRoot, configPath).replaceAll("\\", "/"),
    configSha256: sha256(configBytes),
    itrdbRoot: config.itrdbRoot,
    cofechaSha256: sha256(readFileSync(cofechaExe)),
    files,
    excludedFiles,
    counts: {
        requestedFiles: config.fileIds.length,
        includedFiles: files.length,
        excludedFiles: excludedFiles.length,
        totalSeries: files.reduce((sum, file) => sum + file.totalSeries, 0),
        eligibleTargetsBeforeLimit: files.reduce(
            (sum, file) => sum + (file.eligibleTargetsBeforeLimit ?? file.eligibleTargets.length),
            0,
        ),
        eligibleTargets: files.reduce((sum, file) => sum + file.eligibleTargets.length, 0),
    },
};
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const rows = files.flatMap((file) => file.eligibleTargets.map((target) => ({
    fileId: file.fileId,
    relativePath: file.relativePath,
    ...target,
})));
const headers = Object.keys(rows[0] ?? {});
const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => String(
        (row as unknown as Record<string, unknown>)[header] ?? "",
    )).join(",")),
].join("\n");
writeFileSync(outputPath.replace(/\.json$/i, ".csv"), `${csv}\n`, "utf8");
console.log(`ITRDB_OPERATION_CAPABILITY_MANIFEST ${JSON.stringify({
    outputPath,
    ...manifest.counts,
    excludedFiles,
})}`);
