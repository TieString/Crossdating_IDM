/** Runs the co612 natural-zero serial recovery protocol across a frozen ITRDB file set. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRwl } from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

type Config = {
    schemaVersion: number;
    protocolVersion: string;
    frozenDate: string;
    selection: Record<string, unknown>;
    itrdbRoot: string;
    fileIds: string[];
    runtime: {
        fileConcurrency: number;
        diagnosisWorkersPerFile: number;
    };
};

type ChildSummary = {
    inputPath: string;
    runDir: string;
    sourceSha256: string;
    sourceUnchanged: boolean;
    stopReason: string;
    totalSeries: number;
    totalTruthEvents: number;
    absoluteIdentifiableEvents: number;
    absoluteUnidentifiableYears: number[];
    recoveredEvents: number;
    remainingEvents: number;
    cleanOriginal: {
        cases: number;
        strictFalsePositiveRate: number;
        reviewFalsePositiveRate: number;
    };
    relativeAlignment: {
        original: { zeroLagBestRate: number; p90AbsoluteBestLag: number };
        initial: { zeroLagBestRate: number; p90AbsoluteBestLag: number };
        final: { zeroLagBestRate: number; p90AbsoluteBestLag: number };
    };
};

type Observation = {
    round: number;
    eventId: string;
    truthYear: number;
    absoluteIdentifiable: boolean;
    review: {
        response: boolean;
        eventType: string | null;
        operationCorrect: boolean;
        windowCovered: boolean;
        top1Exact: boolean;
        windowWidth: number | null;
    };
};

type Application = {
    eventId: string;
    truthYear: number;
    suggestedTopYear: number | null;
    suggestedWindow: { startYear: number; endYear: number };
};

type FilePlan = {
    fileId: string;
    inputPath: string;
    sourceSha256: string;
    totalSeries: number;
    truthEvents: number;
};

type FileResult = FilePlan & {
    status: "completed" | "failed";
    error: string | null;
    runDir: string;
    sourceUnchanged: boolean;
    stopReason: string | null;
    absoluteIdentifiableEvents: number;
    absoluteUnidentifiableYears: number[];
    recoveredEvents: number;
    recoveredCoverage: number | null;
    everResponseEvents: number;
    everResponseRate: number | null;
    firstResponseOperationCorrectEvents: number;
    firstResponseWindowCoveredEvents: number;
    firstResponsePartialMoveMismatches: number;
    everCorrectWindowEvents: number;
    everCorrectWindowCoverage: number | null;
    firstResponseOperationAccuracy: number | null;
    firstResponseConditionalCoverage: number | null;
    confirmedTop1: number;
    confirmedTop1Rate: number | null;
    cleanReviewFalsePositives: number;
    cleanReviewCases: number;
    cleanReviewFalsePositiveRate: number | null;
    windowMedian: number | null;
    windowP90: number | null;
    originalZeroLagRate: number | null;
    initialZeroLagRate: number | null;
    finalZeroLagRate: number | null;
    finalAbsoluteLagP90: number | null;
    durationSeconds: number;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    if (index >= 0) return args[index + 1] ?? null;
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    return inline?.slice(name.length + 1) ?? null;
};
const hasFlag = (name: string): boolean => args.includes(name)
    || args.includes(`${name}=true`);
const configPath = resolve(valueFor("--config")
    ?? "docs/benchmarks/itrdb-high-quality-natural-zero-serial-v1.json");
const configBytes = readFileSync(configPath);
const config = JSON.parse(configBytes.toString("utf8")) as Config;
const runId = valueFor("--run-id")
    ?? `natural-zero-serial-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outputRoot = resolve(valueFor("--output-dir")
    ?? "D:/软件测试/itrdb-natural-zero-serial-results");
const runDir = join(outputRoot, runId);
const requestedFileConcurrency = Number(valueFor("--file-concurrency"));
const fileConcurrency = Number.isInteger(requestedFileConcurrency)
    && requestedFileConcurrency > 0
    ? Math.min(4, requestedFileConcurrency)
    : config.runtime.fileConcurrency;
const requestedDiagnosisWorkers = Number(valueFor("--diagnosis-workers"));
const diagnosisWorkers = Number.isInteger(requestedDiagnosisWorkers)
    && requestedDiagnosisWorkers > 0
    ? Math.min(16, requestedDiagnosisWorkers)
    : config.runtime.diagnosisWorkersPerFile;
const resume = hasFlag("--resume");
const planOnly = hasFlag("--plan-only");
const requestedFileIds = valueFor("--file-ids")?.split(",")
    .map((value) => value.trim().toLowerCase()).filter(Boolean) ?? [];
const bootstrapRunner = join(repoRoot, "scripts", "run-co612-review-window-bootstrap.mjs");
mkdirSync(runDir, { recursive: true });

const sha256 = (bytes: Buffer | string): string => createHash("sha256")
    .update(bytes).digest("hex");
const ratio = (numerator: number, denominator: number): number | null => (
    denominator > 0 ? numerator / denominator : null
);
const percentile = (values: readonly number[], probability: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1)];
};
const readJsonLines = <T>(path: string): T[] => {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)
        .map((line) => JSON.parse(line) as T);
};
const csvCell = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
};
const writeCsv = (path: string, rows: readonly Record<string, unknown>[]): void => {
    if (rows.length === 0) {
        writeFileSync(path, "", "utf8");
        return;
    }
    const headers = Object.keys(rows[0]);
    writeFileSync(path, [
        headers.map(csvCell).join(","),
        ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
    ].join("\n"), "utf8");
};

const root = resolve(config.itrdbRoot);
const available = new Map<string, string[]>();
const scanRwlFiles = (directory: string): void => {
    readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            scanRwlFiles(path);
            return;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".rwl")) return;
        const key = entry.name.toLowerCase();
        const paths = available.get(key) ?? [];
        paths.push(path);
        available.set(key, paths);
    });
};
scanRwlFiles(root);
const selectedFileIds = requestedFileIds.length > 0
    ? config.fileIds.filter((fileId) => requestedFileIds.includes(fileId.toLowerCase()))
    : config.fileIds;
const missingRequestedIds = requestedFileIds.filter((fileId) => (
    !config.fileIds.some((configured) => configured.toLowerCase() === fileId)
));
if (missingRequestedIds.length > 0) {
    throw new Error(`file ids are not in the frozen config: ${missingRequestedIds.join(", ")}`);
}
const plans: FilePlan[] = selectedFileIds.map((fileId) => {
    const candidates = available.get(`${fileId.toLowerCase()}.rwl`) ?? [];
    if (candidates.length === 0) throw new Error(`ITRDB file not found: ${fileId}.rwl`);
    if (candidates.length > 1) {
        throw new Error(`ambiguous ITRDB file ${fileId}.rwl: ${candidates.join(", ")}`);
    }
    const inputPath = candidates[0];
    const bytes = readFileSync(inputPath);
    const parsed = parseRwl(bytes.toString("utf8"));
    const truthEvents = Array.from(parsed.values()).reduce((sum, series) => (
        sum + Array.from(series.valuesByYear.values()).filter((value) => value === 0).length
    ), 0);
    return {
        fileId,
        inputPath,
        sourceSha256: sha256(bytes),
        totalSeries: parsed.size,
        truthEvents,
    };
});
writeFileSync(join(runDir, "file-plan.json"), `${JSON.stringify(plans, null, 2)}\n`, "utf8");
if (planOnly) {
    console.log(`ITRDB_SERIAL_PLAN ${JSON.stringify({
        files: plans.length,
        totalSeries: plans.reduce((sum, row) => sum + row.totalSeries, 0),
        totalTruthEvents: plans.reduce((sum, row) => sum + row.truthEvents, 0),
        plans,
    })}`);
    process.exit(0);
}

const summarizeCompleted = (
    plan: FilePlan,
    child: ChildSummary,
    durationSeconds: number,
): FileResult => {
    const observations = readJsonLines<Observation>(join(child.runDir, "observations.jsonl"))
        .filter((row) => row.absoluteIdentifiable);
    const applications = readJsonLines<Application>(join(child.runDir, "applications.jsonl"));
    const firstResponseByEvent = new Map<string, Observation>();
    const everResponse = new Set<string>();
    const everCorrect = new Set<string>();
    observations.sort((left, right) => left.round - right.round).forEach((row) => {
        if (row.review.response) {
            everResponse.add(row.eventId);
            if (!firstResponseByEvent.has(row.eventId)) firstResponseByEvent.set(row.eventId, row);
        }
        if (row.review.operationCorrect && row.review.windowCovered) {
            everCorrect.add(row.eventId);
        }
    });
    const firstResponses = [...firstResponseByEvent.values()];
    const operationCorrect = firstResponses.filter((row) => row.review.operationCorrect);
    const cleanRows = existsSync(join(child.runDir, "clean-original-targets.json"))
        ? (JSON.parse(readFileSync(
            join(child.runDir, "clean-original-targets.json"),
            "utf8",
        )) as Array<{ reviewEvent: unknown | null }>)
        : [];
    const cleanReviewFalsePositives = cleanRows.filter((row) => row.reviewEvent !== null).length;
    const widths = applications.map((row) => (
        row.suggestedWindow.endYear - row.suggestedWindow.startYear + 1
    ));
    const confirmedTop1 = applications.filter((row) => (
        row.suggestedTopYear === row.truthYear
    )).length;
    return {
        ...plan,
        status: "completed",
        error: null,
        runDir: child.runDir,
        sourceUnchanged: child.sourceUnchanged
            && sha256(readFileSync(plan.inputPath)) === plan.sourceSha256,
        stopReason: child.stopReason,
        absoluteIdentifiableEvents: child.absoluteIdentifiableEvents,
        absoluteUnidentifiableYears: child.absoluteUnidentifiableYears,
        recoveredEvents: child.recoveredEvents,
        recoveredCoverage: ratio(child.recoveredEvents, child.absoluteIdentifiableEvents),
        everResponseEvents: everResponse.size,
        everResponseRate: ratio(everResponse.size, child.absoluteIdentifiableEvents),
        firstResponseOperationCorrectEvents: operationCorrect.length,
        firstResponseWindowCoveredEvents: operationCorrect.filter((row) => (
            row.review.windowCovered
        )).length,
        firstResponsePartialMoveMismatches: firstResponses.filter((row) => (
            row.review.eventType === "partialMove"
        )).length,
        everCorrectWindowEvents: everCorrect.size,
        everCorrectWindowCoverage: ratio(everCorrect.size, child.absoluteIdentifiableEvents),
        firstResponseOperationAccuracy: ratio(operationCorrect.length, firstResponses.length),
        firstResponseConditionalCoverage: ratio(
            operationCorrect.filter((row) => row.review.windowCovered).length,
            operationCorrect.length,
        ),
        confirmedTop1,
        confirmedTop1Rate: ratio(confirmedTop1, applications.length),
        cleanReviewFalsePositives,
        cleanReviewCases: cleanRows.length || child.cleanOriginal.cases,
        cleanReviewFalsePositiveRate: ratio(
            cleanReviewFalsePositives,
            cleanRows.length || child.cleanOriginal.cases,
        ),
        windowMedian: percentile(widths, 0.5),
        windowP90: percentile(widths, 0.9),
        originalZeroLagRate: child.relativeAlignment.original.zeroLagBestRate,
        initialZeroLagRate: child.relativeAlignment.initial.zeroLagBestRate,
        finalZeroLagRate: child.relativeAlignment.final.zeroLagBestRate,
        finalAbsoluteLagP90: child.relativeAlignment.final.p90AbsoluteBestLag,
        durationSeconds,
    };
};

const runFile = async (plan: FilePlan): Promise<FileResult> => {
    const childRunDir = join(runDir, plan.fileId);
    const summaryPath = join(childRunDir, "run-summary.json");
    if (resume && existsSync(summaryPath)) {
        const child = JSON.parse(readFileSync(summaryPath, "utf8")) as ChildSummary;
        if (child.sourceSha256 === plan.sourceSha256 && child.sourceUnchanged) {
            console.log(`ITRDB_SERIAL_RESUME file=${plan.fileId}`);
            return summarizeCompleted(plan, child, 0);
        }
    }
    const startedAt = Date.now();
    const stdoutPath = join(runDir, `${plan.fileId}.stdout.log`);
    const stderrPath = join(runDir, `${plan.fileId}.stderr.log`);
    writeFileSync(stdoutPath, "", "utf8");
    writeFileSync(stderrPath, "", "utf8");
    console.log(
        `ITRDB_SERIAL_START file=${plan.fileId} series=${plan.totalSeries}`
        + ` events=${plan.truthEvents}`,
    );
    const code = await new Promise<number>((resolveCode, rejectCode) => {
        const child = spawn(process.execPath, [
            bootstrapRunner,
            "--input", plan.inputPath,
            "--output-dir", runDir,
            "--run-id", plan.fileId,
            "--max-rounds", String(Math.max(1, plan.truthEvents + 1)),
            "--workers", String(diagnosisWorkers),
            ...(resume ? ["--resume"] : []),
        ], { cwd: repoRoot, windowsHide: true });
        child.stdout.on("data", (chunk: Buffer) => appendFileSync(stdoutPath, chunk));
        child.stderr.on("data", (chunk: Buffer) => appendFileSync(stderrPath, chunk));
        child.on("error", rejectCode);
        child.on("close", (exitCode) => resolveCode(exitCode ?? 1));
    });
    const durationSeconds = (Date.now() - startedAt) / 1000;
    if (code !== 0 || !existsSync(summaryPath)) {
        const error = existsSync(stderrPath)
            ? readFileSync(stderrPath, "utf8").slice(-4000)
            : `child exit ${code}`;
        console.log(`ITRDB_SERIAL_FAILED file=${plan.fileId} seconds=${durationSeconds.toFixed(1)}`);
        return {
            ...plan,
            status: "failed",
            error,
            runDir: childRunDir,
            sourceUnchanged: sha256(readFileSync(plan.inputPath)) === plan.sourceSha256,
            stopReason: null,
            absoluteIdentifiableEvents: 0,
            absoluteUnidentifiableYears: [],
            recoveredEvents: 0,
            recoveredCoverage: null,
            everResponseEvents: 0,
            everResponseRate: null,
            firstResponseOperationCorrectEvents: 0,
            firstResponseWindowCoveredEvents: 0,
            firstResponsePartialMoveMismatches: 0,
            everCorrectWindowEvents: 0,
            everCorrectWindowCoverage: null,
            firstResponseOperationAccuracy: null,
            firstResponseConditionalCoverage: null,
            confirmedTop1: 0,
            confirmedTop1Rate: null,
            cleanReviewFalsePositives: 0,
            cleanReviewCases: 0,
            cleanReviewFalsePositiveRate: null,
            windowMedian: null,
            windowP90: null,
            originalZeroLagRate: null,
            initialZeroLagRate: null,
            finalZeroLagRate: null,
            finalAbsoluteLagP90: null,
            durationSeconds,
        };
    }
    const child = JSON.parse(readFileSync(summaryPath, "utf8")) as ChildSummary;
    const result = summarizeCompleted(plan, child, durationSeconds);
    console.log(
        `ITRDB_SERIAL_DONE file=${plan.fileId} recovered=${result.recoveredEvents}`
        + `/${result.absoluteIdentifiableEvents}`
        + ` rate=${(result.recoveredCoverage ?? 0).toFixed(4)}`
        + ` seconds=${durationSeconds.toFixed(1)}`,
    );
    return result;
};

const results: FileResult[] = [];
let nextPlan = 0;
await Promise.all(Array.from({ length: Math.min(fileConcurrency, plans.length) }, async () => {
    while (nextPlan < plans.length) {
        const index = nextPlan;
        nextPlan += 1;
        const result = await runFile(plans[index]);
        results.push(result);
        writeFileSync(join(runDir, "partial-results.json"), `${JSON.stringify(
            [...results].sort((left, right) => left.fileId.localeCompare(right.fileId)),
            null,
            2,
        )}\n`, "utf8");
    }
}));
results.sort((left, right) => left.fileId.localeCompare(right.fileId));

const completed = results.filter((row) => row.status === "completed");
const sum = (selector: (row: FileResult) => number): number => completed.reduce(
    (total, row) => total + selector(row),
    0,
);
const aggregate = {
    schemaVersion: 1,
    protocolVersion: config.protocolVersion,
    runId,
    configPath,
    configHash: sha256(configBytes),
    gitCommit: spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
    }).stdout.trim(),
    gitDirty: spawnSync("git", ["status", "--short"], {
        cwd: repoRoot,
        encoding: "utf8",
    }).stdout.trim().length > 0,
    fileConcurrency,
    diagnosisWorkers,
    files: results.length,
    completedFiles: completed.length,
    failedFiles: results.length - completed.length,
    sourceUnchangedFiles: completed.filter((row) => row.sourceUnchanged).length,
    totalSeries: sum((row) => row.totalSeries),
    totalTruthEvents: sum((row) => row.truthEvents),
    absoluteIdentifiableEvents: sum((row) => row.absoluteIdentifiableEvents),
    recoveredEvents: sum((row) => row.recoveredEvents),
    recoveredCoverage: ratio(
        sum((row) => row.recoveredEvents),
        sum((row) => row.absoluteIdentifiableEvents),
    ),
    everResponseRate: ratio(
        sum((row) => row.everResponseEvents),
        sum((row) => row.absoluteIdentifiableEvents),
    ),
    everCorrectWindowCoverage: ratio(
        sum((row) => row.everCorrectWindowEvents),
        sum((row) => row.absoluteIdentifiableEvents),
    ),
    firstResponseOperationAccuracy: ratio(
        sum((row) => row.firstResponseOperationCorrectEvents),
        sum((row) => row.everResponseEvents),
    ),
    firstResponseConditionalCoverage: ratio(
        sum((row) => row.firstResponseWindowCoveredEvents),
        sum((row) => row.firstResponseOperationCorrectEvents),
    ),
    firstResponsePartialMoveMisclassificationRate: ratio(
        sum((row) => row.firstResponsePartialMoveMismatches),
        sum((row) => row.everResponseEvents),
    ),
    confirmedTop1Rate: ratio(
        sum((row) => row.confirmedTop1),
        sum((row) => row.recoveredEvents),
    ),
    cleanReviewFalsePositiveRate: ratio(
        sum((row) => row.cleanReviewFalsePositives),
        sum((row) => row.cleanReviewCases),
    ),
    windowMedian: percentile(completed.flatMap((row) => (
        readJsonLines<Application>(join(row.runDir, "applications.jsonl")).map((item) => (
            item.suggestedWindow.endYear - item.suggestedWindow.startYear + 1
        ))
    )), 0.5),
    windowP90: percentile(completed.flatMap((row) => (
        readJsonLines<Application>(join(row.runDir, "applications.jsonl")).map((item) => (
            item.suggestedWindow.endYear - item.suggestedWindow.startYear + 1
        ))
    )), 0.9),
    stopReasons: Object.fromEntries([...new Set(completed.map((row) => row.stopReason))]
        .map((reason) => [reason ?? "unknown", completed.filter((row) => (
            row.stopReason === reason
        )).length])),
};

writeFileSync(join(runDir, "file-results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
writeCsv(join(runDir, "file-results.csv"), results as unknown as Record<string, unknown>[]);
writeFileSync(join(runDir, "run-summary.json"), `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
const reportRows = results.map((row) => (
    `| ${row.fileId} | ${row.truthEvents} | ${row.absoluteIdentifiableEvents}`
    + ` | ${row.recoveredEvents} | ${row.recoveredCoverage?.toFixed(3) ?? "-"}`
    + ` | ${row.everCorrectWindowCoverage?.toFixed(3) ?? "-"}`
    + ` | ${row.cleanReviewFalsePositives}/${row.cleanReviewCases}`
    + ` | ${row.windowMedian ?? "-"}/${row.windowP90 ?? "-"}`
    + ` | ${row.stopReason ?? row.status} |`
));
writeFileSync(join(runDir, "report.md"), `# ITRDB 高质量文件自然缺轮串行恢复\n\n`
    + `- 文件：${aggregate.completedFiles}/${aggregate.files}\n`
    + `- 可绝对识别事件：${aggregate.absoluteIdentifiableEvents}\n`
    + `- 串行确认恢复：${aggregate.recoveredEvents}`
    + ` (${aggregate.recoveredCoverage?.toFixed(4) ?? "-"})\n`
    + `- 曾出现正确窗口：${aggregate.everCorrectWindowCoverage?.toFixed(4) ?? "-"}\n`
    + `- 首次响应条件覆盖：${aggregate.firstResponseConditionalCoverage?.toFixed(4) ?? "-"}\n`
    + `- 首次响应 partialMove 误判：${aggregate.firstResponsePartialMoveMisclassificationRate?.toFixed(4) ?? "-"}\n`
    + `- clean review 误报：${aggregate.cleanReviewFalsePositiveRate?.toFixed(4) ?? "-"}\n\n`
    + `| 文件 | 自然0 | 可识别 | 恢复 | 恢复率 | 曾正确窗 | clean误报 | 窗口M/P90 | 停止原因 |\n`
    + `|---|---:|---:|---:|---:|---:|---:|---:|---|\n`
    + `${reportRows.join("\n")}\n`, "utf8");
console.log(`ITRDB_SERIAL_SUMMARY ${JSON.stringify(aggregate)}`);
if (results.some((row) => row.status === "failed" || !row.sourceUnchanged)) {
    process.exitCode = 1;
}
