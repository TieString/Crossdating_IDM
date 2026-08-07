import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { availableParallelism, cpus, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    assertFrozenConfig,
    isResumableCompletedStage,
    sha256Bytes,
} from "./legacy-generalization/evaluator";
import { writeLegacyGeneralizationArtifacts } from "./legacy-generalization/summary";
import type {
    LegacyConfig,
    LegacyFilePlan,
    LegacyFileWorkerOutput,
    LegacyManifest,
    LegacyRunStatus,
} from "./legacy-generalization/types";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteNode = join(repoRoot, "node_modules", "vite-node", "vite-node.mjs");
const vitestBin = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const fileWorker = join(repoRoot, "scripts", "legacy-generalization", "file-worker.ts");
const args = process.argv.slice(2);
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const hasFlag = (name: string): boolean => args.includes(name);
const configPath = resolve(valueFor("--config")
    ?? "docs/benchmarks/legacy-cross-file-generalization-config-v1.json");
const manifestPath = resolve(valueFor("--manifest")
    ?? "docs/benchmarks/legacy-cross-file-generalization-manifest-v1.json");
const requestedPhase = valueFor("--phase") ?? "all";
if (!["all", "co612", "pilot", "single", "serial"].includes(requestedPhase)) {
    throw new Error(`invalid --phase: ${requestedPhase}`);
}
const quick = hasFlag("--quick");
const resume = hasFlag("--resume");
const configBytes = readFileSync(configPath);
const config = JSON.parse(configBytes.toString("utf8")) as LegacyConfig;
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8")) as LegacyManifest;
const configHash = assertFrozenConfig(config, manifest.configHash, configBytes);
const manifestHash = sha256Bytes(manifestBytes);
const injectionConfigHash = sha256Bytes(JSON.stringify(config.injection));
const runId = valueFor("--run-id")
    ?? `${quick ? "quick" : "full"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runDir = resolve(valueFor("--run-dir")
    ?? `D:/软件测试/legacy-cross-file-generalization-results/${runId}`);
const requestedWorkers = Number(valueFor("--workers"));
const workers = Number.isInteger(requestedWorkers) && requestedWorkers > 0
    ? Math.min(requestedWorkers, config.runtime.workers)
    : config.runtime.workers;
const maxRoundsValue = Number(valueFor("--max-rounds"));
const maxRounds = Number.isInteger(maxRoundsValue) && maxRoundsValue > 0
    ? maxRoundsValue
    : config.runtime.maxRounds;
const checkpointEveryValue = Number(valueFor("--checkpoint-every"));
const checkpointEvery = Number.isInteger(checkpointEveryValue) && checkpointEveryValue > 0
    ? checkpointEveryValue
    : config.runtime.checkpointEveryFiles;
const progressPath = resolve(valueFor("--progress-file") ?? join(runDir, "run-status.json"));
const checkpointsDir = join(runDir, "checkpoints");
const stageDir = join(checkpointsDir, "stages");
const runStartedAt = new Date().toISOString();
mkdirSync(runDir, { recursive: true });
mkdirSync(checkpointsDir, { recursive: true });
mkdirSync(stageDir, { recursive: true });
for (const logName of ["stdout.log", "stderr.log"]) {
    const path = join(runDir, logName);
    if (!existsSync(path)) writeFileSync(path, "", "utf8");
}

const resolveRepoPath = (path: string): string => (
    /^[A-Za-z]:[\\/]/.test(path) ? resolve(path) : resolve(repoRoot, path)
);
const sha256File = (path: string): string => createHash("sha256")
    .update(readFileSync(path)).digest("hex");
const git = (gitArgs: string[]): string => {
    const result = requireSpawnSync("git", gitArgs);
    if (result.code !== 0) throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
};

type SyncResult = { code: number; stdout: string; stderr: string };
function requireSpawnSync(command: string, commandArgs: string[]): SyncResult {
    const result = spawnSync(command, commandArgs, {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
    });
    return {
        code: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}

const runnerGitCommit = git(["rev-parse", "HEAD"]);
const gitDirty = git(["status", "--short"]).length > 0;
let peakMemoryBytes = process.memoryUsage().rss;
let status: LegacyRunStatus = {
    schemaVersion: 1,
    runId,
    gitCommit: runnerGitCommit,
    configHash,
    manifestHash,
    pid: process.pid,
    status: "PREPARING",
    currentPhase: null,
    currentFile: null,
    completedFiles: 0,
    totalFiles: quick
        ? manifest.files.filter((file) => file.role === "external-pilot").length
        : manifest.files.length,
    currentRound: null,
    recoveredEvents: 0,
    lastHeartbeatAt: runStartedAt,
    outputDir: runDir,
    exitCode: null,
    failureReason: null,
};

const writeStatus = (): void => {
    peakMemoryBytes = Math.max(peakMemoryBytes, process.memoryUsage().rss);
    status.lastHeartbeatAt = new Date().toISOString();
    const temporary = `${progressPath}.${process.pid}.tmp`;
    mkdirSync(dirname(progressPath), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, "utf8");
    renameSync(temporary, progressPath);
};
writeStatus();
const heartbeat = setInterval(writeStatus, config.runtime.heartbeatSeconds * 1000);
heartbeat.unref();

const log = (message: string): void => {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(line);
    appendFileSync(join(runDir, "runner.log"), `${line}\n`, "utf8");
    appendFileSync(join(runDir, "stdout.log"), `${line}\n`, "utf8");
};

const runChild = (input: {
    command: string;
    args: string[];
    cwd?: string;
    allowNonZero?: boolean;
}): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((done, fail) => {
    const child = spawn(input.command, input.args, {
        cwd: input.cwd ?? repoRoot,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: config.runtime.workerTimeoutMinutes * 60 * 1000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        stdout += text;
        appendFileSync(join(runDir, "stdout.log"), text, "utf8");
        process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        stderr += text;
        appendFileSync(join(runDir, "stderr.log"), text, "utf8");
        process.stderr.write(text);
    });
    child.on("error", fail);
    child.on("exit", (code) => {
        const exitCode = code ?? 1;
        if (exitCode !== 0 && !input.allowNonZero) {
            fail(new Error(`${input.command} exited ${exitCode}: ${stderr.slice(-2000)}`));
        } else {
            done({ code: exitCode, stdout, stderr });
        }
    });
});

const stagePath = (name: string): string => join(stageDir, `${name}.json`);
const completedStage = (name: string): boolean => {
    if (!resume || !existsSync(stagePath(name))) return false;
    try {
        return isResumableCompletedStage(JSON.parse(
            readFileSync(stagePath(name), "utf8"),
        ));
    } catch {
        return false;
    }
};
const markStage = (name: string, details: Record<string, unknown>): void => {
    writeFileSync(stagePath(name), `${JSON.stringify({
        stage: name,
        completedAt: new Date().toISOString(),
        ...details,
    }, null, 2)}\n`, "utf8");
};

const verifyInputs = (): { count: number; mismatches: string[] } => {
    const mismatches: string[] = [];
    Object.entries(manifest.inputHashes).forEach(([id, expected]) => {
        let path: string | null = null;
        if (id === "co612") path = resolveRepoPath(config.paths.co612Input);
        else if (id === "cofecha") path = resolveRepoPath(config.paths.cofechaSidecar);
        else {
            const file = manifest.files.find((row) => row.fileId === id)
                ?? manifest.directedRegressions.find((row) => row.fileId === id);
            path = file?.path ?? null;
        }
        if (!path || !existsSync(path)) {
            mismatches.push(`${id}:missing:${path ?? "unresolved"}`);
            return;
        }
        const actual = sha256File(path);
        if (actual !== expected) mismatches.push(`${id}:${actual}!=${expected}`);
    });
    return { count: Object.keys(manifest.inputHashes).length, mismatches };
};

const productionDifferential = (): { count: number; files: string[] } => {
    const result = requireSpawnSync("git", [
        "diff",
        "--name-only",
        config.productionProtection.baselineCommit,
        "--",
        ...config.productionProtection.protectedPaths,
    ]);
    if (result.code !== 0) throw new Error(`production diff failed: ${result.stderr}`);
    const files = result.stdout.split(/\r?\n/).filter(Boolean).filter((path) => (
        !path.replace(/\\/g, "/").includes(
            config.productionProtection.allowedNewTestPathFragment,
        )
    ));
    return { count: files.length, files };
};

const readJsonLines = <T>(path: string): T[] => readFileSync(path, "utf8")
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
const withoutRuntime = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutRuntime);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .filter(([key]) => !["durationMs", "createdAt", "runDir"].includes(key))
            .map(([key, nested]) => [key, withoutRuntime(nested)]));
    }
    return value;
};
const firstJsonDifference = (
    expected: unknown,
    actual: unknown,
    path = "$",
): { path: string; expected: unknown; actual: unknown } | null => {
    if (JSON.stringify(expected) === JSON.stringify(actual)) return null;
    if (Array.isArray(expected) && Array.isArray(actual)) {
        const length = Math.max(expected.length, actual.length);
        for (let index = 0; index < length; index += 1) {
            const difference = firstJsonDifference(expected[index], actual[index], `${path}[${index}]`);
            if (difference) return difference;
        }
    }
    if (expected && actual && typeof expected === "object" && typeof actual === "object") {
        const keys = Array.from(new Set([
            ...Object.keys(expected as Record<string, unknown>),
            ...Object.keys(actual as Record<string, unknown>),
        ])).sort();
        for (const key of keys) {
            const difference = firstJsonDifference(
                (expected as Record<string, unknown>)[key],
                (actual as Record<string, unknown>)[key],
                `${path}.${key}`,
            );
            if (difference) return difference;
        }
    }
    return { path, expected, actual };
};

const compareTrajectory = (
    expectedDir: string,
    actualDir: string,
    maximumRound: number | null,
) => {
    for (const name of ["observations.jsonl", "applications.jsonl", "rounds.jsonl"]) {
        const expected = readJsonLines<Record<string, unknown>>(join(expectedDir, name))
            .filter((row) => maximumRound === null || Number(row.round) <= maximumRound)
            .map(withoutRuntime);
        const actual = readJsonLines<Record<string, unknown>>(join(actualDir, name))
            .filter((row) => maximumRound === null || Number(row.round) <= maximumRound)
            .map(withoutRuntime);
        const difference = firstJsonDifference(expected, actual, `$.${name}`);
        if (difference) return difference;
    }
    return null;
};

const runCo612Gate = async (): Promise<Record<string, unknown>> => {
    const name = "CO612_REPRODUCTION";
    if (completedStage(name)) return JSON.parse(readFileSync(stagePath(name), "utf8"));
    status.currentPhase = name;
    status.currentFile = "co612";
    writeStatus();
    const outputRoot = join(checkpointsDir, "co612");
    const childRunId = quick ? "quick-two-rounds" : "full-reproduction";
    const childRunDir = join(outputRoot, childRunId);
    if (!resume && existsSync(childRunDir)) {
        const resolved = resolve(childRunDir);
        if (!resolved.startsWith(resolve(checkpointsDir))) {
            throw new Error(`refusing to remove outside checkpoints: ${resolved}`);
        }
        rmSync(resolved, { recursive: true, force: true });
    }
    const reproduction = config.co612Reproduction;
    const rounds = quick ? 2 : Number(reproduction.maxRounds);
    log(`starting co612 reproduction rounds=${rounds}`);
    await runChild({
        command: process.execPath,
        args: [
            join(repoRoot, "scripts", "run-co612-review-window-bootstrap.mjs"),
            "--input", resolveRepoPath(config.paths.co612Input),
            "--output-dir", outputRoot,
            "--run-id", childRunId,
            "--max-rounds", String(rounds),
            "--workers", String(reproduction.workerCount),
            ...(resume ? ["--resume"] : []),
        ],
    });
    const frozenDir = resolveRepoPath(config.paths.co612FrozenRun);
    const frozenBaselineArtifacts = [
        ["co612FrozenObservations", "observations.jsonl"],
        ["co612FrozenApplications", "applications.jsonl"],
        ["co612FrozenRounds", "rounds.jsonl"],
        ["co612FrozenRunSummary", "run-summary.json"],
        ["co612FrozenCleanTargets", "clean-original-targets.json"],
    ] as const;
    const frozenBaselineHashMismatches = frozenBaselineArtifacts.flatMap(
        ([hashKey, fileName]) => {
            const artifactPath = join(frozenDir, fileName);
            const expected = config.expectedHashes[hashKey];
            if (!expected) return [`${hashKey}:missing_expected_hash`];
            if (!existsSync(artifactPath)) return [`${fileName}:missing`];
            const actual = sha256File(artifactPath);
            return actual === expected ? [] : [`${fileName}:${actual}!=${expected}`];
        },
    );
    const trajectoryDifference = compareTrajectory(
        frozenDir,
        childRunDir,
        quick ? rounds : null,
    );
    const expectedRunSummary = JSON.parse(readFileSync(
        join(frozenDir, "run-summary.json"),
        "utf8",
    )) as Record<string, unknown>;
    const actualRunSummary = JSON.parse(readFileSync(
        join(childRunDir, "run-summary.json"),
        "utf8",
    )) as Record<string, unknown>;
    const baselineFields = (summary: Record<string, unknown>) => ({
        sourceSha256: summary.sourceSha256,
        sourceUnchanged: summary.sourceUnchanged,
        totalSeries: summary.totalSeries,
        totalTruthEvents: summary.totalTruthEvents,
        absoluteIdentifiableEvents: summary.absoluteIdentifiableEvents,
        absoluteUnidentifiableYears: summary.absoluteUnidentifiableYears,
        initialZeroCount: summary.initialZeroCount,
        cleanOriginal: summary.cleanOriginal,
        relativeAlignmentOriginal: (summary.relativeAlignment as Record<string, unknown>)
            ?.original,
        relativeAlignmentInitial: (summary.relativeAlignment as Record<string, unknown>)
            ?.initial,
    });
    const cleanBaselineDifference = firstJsonDifference(
        baselineFields(expectedRunSummary),
        baselineFields(actualRunSummary),
        "$.runSummaryBaseline",
    );
    let metricDifference: ReturnType<typeof firstJsonDifference> = null;
    let actualMetrics: Record<string, unknown> | null = null;
    if (!quick && trajectoryDifference === null && cleanBaselineDifference === null) {
        await runChild({
            command: process.execPath,
            args: [
                join(repoRoot, "scripts", "run-analyze-co612-review-window-bootstrap.mjs"),
                "--run-dir", childRunDir,
            ],
        });
        const analysis = JSON.parse(readFileSync(
            join(childRunDir, "analysis", "summary.json"),
            "utf8",
        )) as Record<string, any>;
        actualMetrics = {
            truthSeries: 45,
            truthEvents: analysis.source.totalTruthEvents,
            confirmed: analysis.confirmedWorkflow.confirmedCount,
            everCorrectWindow: Math.round(
                analysis.controls.lowerDisplayGateWithRetryEventualCorrectWindowCoverage
                * analysis.source.totalTruthEvents,
            ),
            firstWindowCoverage:
                analysis.controls.lowerDisplayGateWithRetryFirstResponse.coveredCount,
            firstResponse: analysis.controls.lowerDisplayGateWithRetryFirstResponse.responseCount,
            operationCorrectNumerator:
                analysis.controls.lowerDisplayGateWithRetryFirstResponse.operationCorrectCount,
            operationCorrectDenominator:
                analysis.controls.lowerDisplayGateWithRetryFirstResponse.responseCount,
            confirmedTop1: analysis.confirmedWorkflow.top1Count,
            windowMedian: analysis.confirmedWorkflow.medianWindowWidth,
            windowP90: analysis.confirmedWorkflow.p90WindowWidth,
            earliestTrajectoryDifference: null,
        };
        const expectedMetrics = Object.fromEntries(Object.entries(reproduction).filter(([key]) => (
            !["workerCount", "maxRounds"].includes(key)
        )));
        metricDifference = firstJsonDifference(expectedMetrics, actualMetrics, "$.metrics");
    }
    const gate = {
        gate: name,
        quick,
        rounds,
        frozenBaselineHashMismatches,
        trajectoryDifference,
        cleanBaselineDifference,
        metricDifference,
        actualMetrics,
        passed: frozenBaselineHashMismatches.length === 0
            && trajectoryDifference === null
            && cleanBaselineDifference === null
            && metricDifference === null,
        runDir: childRunDir,
    };
    markStage(name, gate);
    if (!gate.passed) throw Object.assign(
        new Error("STOPPED_AT_CO612_REPRODUCTION_GATE"),
        { gateDetails: gate },
    );
    return gate;
};

const runDirectedRegressions = async (): Promise<Array<Record<string, unknown>>> => {
    const name = "DIRECTED_REGRESSIONS";
    if (completedStage(name)) {
        const stage = JSON.parse(readFileSync(stagePath(name), "utf8")) as {
            results?: Array<Record<string, unknown>>;
        };
        return stage.results ?? [];
    }
    status.currentPhase = name;
    status.currentFile = null;
    writeStatus();
    const results: Array<Record<string, unknown>> = [];
    for (const regression of manifest.directedRegressions) {
        status.currentFile = regression.fileId;
        writeStatus();
        log(`${name} ${regression.fileId} ${regression.testPath}`);
        const result = await runChild({
            command: process.execPath,
            args: [vitestBin, "run", regression.testPath, "--reporter", "dot"],
            allowNonZero: true,
        });
        results.push({
            ...regression,
            passed: result.code === 0,
            exitCode: result.code,
            stdoutTail: result.stdout.slice(-4000),
            stderrTail: result.stderr.slice(-4000),
        });
    }
    markStage(name, {
        passed: results.filter((row) => row.passed === true).length,
        failed: results.filter((row) => row.passed !== true).length,
        results,
    });
    return results;
};

const validWorkerCheckpoint = (path: string, file: LegacyFilePlan): boolean => {
    if (!existsSync(path)) return false;
    try {
        const output = JSON.parse(readFileSync(path, "utf8")) as LegacyFileWorkerOutput;
        return output.fileId === file.fileId
            && output.sourceSha256Before === file.sha256
            && output.sourceSha256After === file.sha256
            && output.sourceMutationCount === 0;
    } catch {
        return false;
    }
};

const runWorkerFile = async (
    file: LegacyFilePlan,
    phase: "single" | "serial",
): Promise<LegacyFileWorkerOutput> => {
    const outputDir = join(checkpointsDir, phase);
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, `${file.fileId}.json`);
    if (resume && validWorkerCheckpoint(outputPath, file)) {
        return JSON.parse(readFileSync(outputPath, "utf8")) as LegacyFileWorkerOutput;
    }
    const workDir = join(runDir, "temp", `${phase}-${file.fileId}`);
    await runChild({
        command: process.execPath,
        args: [
            viteNode,
            fileWorker,
            "--",
            "--config", configPath,
            "--manifest", manifestPath,
            "--file-id", file.fileId,
            "--phase", phase,
            "--output", outputPath,
            "--work-dir", workDir,
            "--max-rounds", String(maxRounds),
            ...(quick ? ["--quick"] : []),
        ],
    });
    return JSON.parse(readFileSync(outputPath, "utf8")) as LegacyFileWorkerOutput;
};

const runFiles = async (
    stage: string,
    files: LegacyFilePlan[],
    phase: "single" | "serial",
    technicalGate: boolean,
): Promise<LegacyFileWorkerOutput[]> => {
    if (completedStage(stage)) {
        return files.map((file) => JSON.parse(readFileSync(
            join(checkpointsDir, phase, `${file.fileId}.json`),
            "utf8",
        )) as LegacyFileWorkerOutput);
    }
    status.currentPhase = stage;
    status.completedFiles = 0;
    status.totalFiles = files.length;
    writeStatus();
    const outputs: LegacyFileWorkerOutput[] = [];
    let nextIndex = 0;
    const active = new Set<string>();
    const consume = async (): Promise<void> => {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= files.length) return;
            const file = files[index];
            active.add(file.fileId);
            status.currentFile = Array.from(active).join(",");
            writeStatus();
            log(`${stage} ${index + 1}/${files.length} ${file.relativePath}`);
            const output = await runWorkerFile(file, phase);
            outputs.push(output);
            active.delete(file.fileId);
            status.completedFiles += 1;
            status.currentFile = Array.from(active).join(",") || null;
            if (status.completedFiles % checkpointEvery === 0) writeStatus();
            if (technicalGate && (
                output.errors.length > 0
                || output.sourceMutationCount > 0
                || output.saveReopenDifferentialCount > 0
            )) {
                throw new Error(
                    `pilot technical gate failed ${file.fileId}: errors=${output.errors.length}`
                    + ` mutations=${output.sourceMutationCount}`
                    + ` saveDiff=${output.saveReopenDifferentialCount}`,
                );
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(workers, files.length) }, consume));
    markStage(stage, {
        phase,
        files: files.length,
        sourceMutationCount: outputs.reduce((sum, output) => (
            sum + output.sourceMutationCount
        ), 0),
        errors: outputs.reduce((sum, output) => sum + output.errors.length, 0),
        saveReopenDifferentialCount: outputs.reduce((sum, output) => (
            sum + output.saveReopenDifferentialCount
        ), 0),
    });
    return outputs;
};

const loadAllOutputs = (): LegacyFileWorkerOutput[] => ["single", "serial"].flatMap((phase) => {
    const directory = join(checkpointsDir, phase);
    if (!existsSync(directory)) return [];
    return manifest.files.flatMap((file) => {
        const path = join(directory, `${file.fileId}.json`);
        return existsSync(path)
            ? [JSON.parse(readFileSync(path, "utf8")) as LegacyFileWorkerOutput]
            : [];
    });
});

const verifyOutputChecksums = (checksums: Record<string, string>): string[] => Object.entries(
    checksums,
).flatMap(([name, expected]) => {
    const actual = sha256File(join(runDir, name));
    return actual === expected ? [] : [`${name}:${actual}!=${expected}`];
});

const run = async (): Promise<void> => {
    status.status = "RUNNING";
    writeStatus();
    const inputs = verifyInputs();
    if (inputs.mismatches.length > 0) {
        throw new Error(`input hash mismatch: ${inputs.mismatches.join(" | ")}`);
    }
    const productionDiff = productionDifferential();
    if (productionDiff.count !== 0) {
        throw new Error(`baseline production differential=${productionDiff.count}: ${
            productionDiff.files.join(",")
        }`);
    }
    log(`frozen inputs=${inputs.count} config=${configHash} manifest=${manifestHash}`);
    let co612Gate: Record<string, unknown> | null = null;
    let directedRegressionResults: Array<Record<string, unknown>> = [];
    const pilotFiles = manifest.files.filter((file) => file.role === "external-pilot");
    const fullFiles = manifest.files.filter((file) => file.role === "external-full");
    if (["all", "co612"].includes(requestedPhase)) {
        co612Gate = await runCo612Gate();
        if (requestedPhase === "co612") {
            status.status = "COMPLETED";
            status.currentPhase = null;
            status.currentFile = null;
            status.exitCode = 0;
            writeStatus();
            return;
        }
    }
    directedRegressionResults = await runDirectedRegressions();
    if (["all", "pilot"].includes(requestedPhase)) {
        await runFiles("EXTERNAL_PILOT_SINGLE", pilotFiles, "single", true);
        await runFiles("EXTERNAL_PILOT_SERIAL", pilotFiles, "serial", true);
        markStage("EXTERNAL_PILOT_GATE", { passed: true, files: pilotFiles.length });
        if (requestedPhase === "pilot") {
            status.currentPhase = "BOOTSTRAP_AND_SUMMARY";
        }
    }
    if (requestedPhase === "single") {
        await runFiles("EXTERNAL_SINGLE_FULL", manifest.files, "single", false);
    } else if (requestedPhase === "serial") {
        await runFiles("EXTERNAL_SERIAL_FULL", manifest.files, "serial", false);
    } else if (requestedPhase === "all" && !quick) {
        await runFiles("EXTERNAL_SINGLE_FULL", fullFiles, "single", false);
        await runFiles("EXTERNAL_SERIAL_FULL", fullFiles, "serial", false);
    }
    status.currentPhase = "NEGATIVE_CONTROLS";
    markStage("NEGATIVE_CONTROLS", {
        source: "single-phase clean scenarios",
        files: loadAllOutputs().filter((output) => output.phase === "single").length,
    });
    status.currentPhase = "BOOTSTRAP_AND_SUMMARY";
    writeStatus();
    const outputs = loadAllOutputs();
    const artifacts = writeLegacyGeneralizationArtifacts({
        runDir,
        manifest,
        config,
        configHash,
        manifestHash,
        outputs,
        co612Gate,
        directedRegressions: directedRegressionResults,
        metadataBase: {
            runId,
            productionBaselineCommit: config.productionProtection.baselineCommit,
            runnerGitCommit,
            gitDirty,
            node: process.version,
            os: `${platform()} ${release()}`,
            cpu: cpus()[0]?.model ?? "unknown",
            logicalCpuCount: cpus().length,
            availableParallelism: availableParallelism(),
            workerCount: workers,
            maxRounds,
            quick,
            phase: requestedPhase,
            peakMemoryBytes,
            baselineProductionDifferential: productionDiff.count,
            injectionConfigHash,
            cofechaHash: manifest.inputHashes.cofecha,
            gateStatus: "passed",
            startedAt: runStartedAt,
            completedAt: new Date().toISOString(),
        },
    });
    markStage("BOOTSTRAP_AND_SUMMARY", {
        outputs: outputs.length,
        artifacts: artifacts.artifactCount,
    });
    status.currentPhase = "OUTPUT_HASH_VERIFICATION";
    const checksumFailures = verifyOutputChecksums(artifacts.checksums);
    if (checksumFailures.length > 0) {
        throw new Error(`output checksum mismatch: ${checksumFailures.join(" | ")}`);
    }
    markStage("OUTPUT_HASH_VERIFICATION", {
        checked: Object.keys(artifacts.checksums).length,
        failures: 0,
    });
    status.status = "COMPLETED";
    status.currentPhase = null;
    status.currentFile = null;
    status.exitCode = 0;
    writeStatus();
    log(`Legacy generalization ${quick ? "quick" : "full"} completed`);
};

try {
    await run();
} catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    appendFileSync(join(runDir, "stderr.log"), `${message}\n`, "utf8");
    const gateStopped = message.includes("STOPPED_AT_CO612_REPRODUCTION_GATE")
        || message.includes("technical gate")
        || message.includes("input hash mismatch")
        || message.includes("production differential");
    status.status = gateStopped ? "STOPPED_AT_GATE" : "FAILED";
    status.exitCode = 1;
    status.failureReason = message;
    writeStatus();
    console.error(message);
    process.exitCode = 1;
} finally {
    clearInterval(heartbeat);
}
