/** Finite co612 natural-zero frontier matrix: single, bark-prefix, and serial recovery. */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
    extractPart6FlaggedASeriesIds,
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import {
    diagnosisEventInterpretationChain,
    diagnoseCrossdating,
    getDisplayedDiagnosisEvents,
} from "@/features/crossdating/diagnosis";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis/types";
import { createCofechaMasterReferenceConfig } from "@/features/crossdating/reference";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    buildMultiMissingCorrupted,
    parseRwl,
    type RwlSeries,
} from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

type Protocol = "single" | "prefix" | "serial";

type SeriesPlan = {
    target: RwlSeries;
    truthYears: number[];
};

type MatrixCase = {
    caseId: string;
    protocol: Protocol;
    target: RwlSeries;
    truthYears: number[];
    removedYears: number[];
    expectedFrontierYear: number;
    step: number;
};

type EventPreview = {
    eventType: DiagnosisEvent["eventType"];
    shiftYears: number | null;
    topYear: number | null;
    startYear: number;
    endYear: number;
    sources: string[];
};

type CaseRow = {
    caseId: string;
    protocol: Protocol;
    seriesId: string;
    step: number;
    originalMissingCount: number;
    removedMissingCount: number;
    expectedFrontierYear: number;
    endpointDistanceYears: number;
    elapsedMs: number;
    error: string | null;
    cofechaTargetFlagged: boolean;
    response: boolean;
    primaryType: DiagnosisEvent["eventType"] | null;
    primaryShiftYears: number | null;
    primaryTopYear: number | null;
    primaryWindowStart: number | null;
    primaryWindowEnd: number | null;
    primaryWindowCovered: boolean;
    strictMissingSuccess: boolean;
    interpretationKind: DiagnosisEvent["interpretationAmbiguity"] extends infer T
        ? T extends { kind: infer K } ? K : null
        : null;
    hasMissingReviewInterpretation: boolean;
    workflowTopYear: number | null;
    workflowWindowStart: number | null;
    workflowWindowEnd: number | null;
    workflowWindowCovered: boolean;
    endpointWholeBounded: boolean;
    cumulativeWholeAlias: boolean;
    workflowSuggestionSuccess: boolean;
    failureReason: string | null;
    primary: EventPreview | null;
    missingReview: EventPreview | null;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const viteNodePath = join(repoRoot, "node_modules", "vite-node", "vite-node.mjs");
const expectedSourceHash =
    "b1d4756303eb1c8af9805e5f14a95b7e4e04c6ef18ada0a86aa9dedf715af048";
const args = process.argv.slice(2);
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const cofechaInput = valueFor("--cofecha-exe")
    ?? process.env.COFECHA_EXE
    ?? "";
const cofechaExe = cofechaInput ? resolve(cofechaInput) : "";
const inputPath = resolve(valueFor("--input")
    ?? join(repoRoot, "test-data", "co612.rwl"));
const outputRoot = resolve(valueFor("--output-dir")
    ?? join(repoRoot, ".benchmark-results", "co612-zero-frontier-matrix"));
const runId = valueFor("--run-id")
    ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runDir = resolve(valueFor("--run-dir") ?? join(outputRoot, runId));
const workerIndexValue = valueFor("--worker-index");
const workerIndex = workerIndexValue === null ? null : Number(workerIndexValue);
const requestedWorkers = Number(valueFor("--workers"));
const workers = Number.isInteger(requestedWorkers) && requestedWorkers > 0
    ? requestedWorkers
    : Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
const workerCount = Number(valueFor("--worker-count") ?? workers);
const requestedProtocols = (valueFor("--protocols") ?? "single,prefix,serial")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
const validProtocols = new Set<Protocol>(["single", "prefix", "serial"]);
if (requestedProtocols.some((value) => !validProtocols.has(value as Protocol))) {
    throw new Error(`invalid --protocols: ${requestedProtocols.join(",")}`);
}
const protocols = requestedProtocols as Protocol[];
const selectedSeries = valueFor("--series")
    ?.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean) ?? null;

const assertSafeRunDirectory = (): void => {
    const rel = relative(outputRoot, runDir);
    if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`)) {
        throw new Error(`unsafe result directory: ${runDir}`);
    }
};

if (!existsSync(inputPath)) throw new Error(`RWL not found: ${inputPath}`);
if (!cofechaExe || !existsSync(cofechaExe)) {
    throw new Error("COFECHA executable not found; pass --cofecha-exe PATH or set COFECHA_EXE");
}
assertSafeRunDirectory();
const sourceBytes = readFileSync(inputPath);
const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
if (sourceHash !== expectedSourceHash) {
    throw new Error(`unexpected ITRDB co612 source hash: ${sourceHash}`);
}

const parsed = parseRwl(sourceBytes.toString("utf8"));
const cleanSite: RwlSiteData = new Map(Array.from(parsed, ([seriesId, series]) => [
    seriesId,
    new Map(series.valuesByYear),
]));
const seriesPlans: SeriesPlan[] = Array.from(parsed.values())
    .map((target) => ({
        target,
        truthYears: Array.from(target.valuesByYear)
            .filter(([, value]) => value === 0)
            .map(([year]) => year)
            .sort((left, right) => right - left),
    }))
    .filter((plan) => plan.truthYears.length > 0)
    .filter((plan) => !selectedSeries
        || selectedSeries.includes(plan.target.id.toLowerCase()));

const matrixCases: MatrixCase[] = seriesPlans.flatMap((plan) => protocols.flatMap(
    (protocol) => plan.truthYears.map((truthYear, index) => {
        const removedYears = protocol === "single"
            ? [truthYear]
            : protocol === "prefix"
                ? plan.truthYears.slice(0, index + 1)
                : plan.truthYears.slice(index);
        const expectedFrontierYear = protocol === "prefix"
            ? plan.truthYears[0]!
            : truthYear;
        return {
            caseId: `${protocol}:${plan.target.id}:${index + 1}:${expectedFrontierYear}`,
            protocol,
            target: plan.target,
            truthYears: plan.truthYears,
            removedYears,
            expectedFrontierYear,
            step: index + 1,
        };
    }),
));

const topYear = (event: DiagnosisEvent): number | null => [...event.rankedYears]
    .sort((left, right) => left.rank - right.rank || right.score - left.score)[0]
    ?.year ?? null;

const previewEvent = (event: DiagnosisEvent | null): EventPreview | null => event ? {
    eventType: event.eventType,
    shiftYears: event.shiftYears ?? null,
    topYear: topYear(event),
    startYear: event.startYear,
    endYear: event.endYear,
    sources: event.evidence.algorithmSources,
} : null;

const missingReviewEvent = (event: DiagnosisEvent | null): DiagnosisEvent | null => {
    if (!event) return null;
    return diagnosisEventInterpretationChain(event).find(
        (interpretation) => interpretation.eventType === "missingRing",
    ) ?? null;
};

const windowCovers = (event: DiagnosisEvent | null, year: number): boolean => Boolean(
    event && year >= event.startYear && year <= event.endYear,
);

const runCofecha = (siteData: RwlSiteData): string => {
    const workDir = mkdtempSync(join(tmpdir(), "co612-zero-frontier-"));
    try {
        writeFileSync(join(workDir, "INPUT.RWL"), formatTucson(siteData, false), "utf8");
        execFileSync(cofechaExe, [], {
            cwd: workDir,
            input: "very\nINPUT.RWL\n\n\n\n\n\n\n",
            timeout: 30_000,
            stdio: ["pipe", "ignore", "pipe"],
        });
        return readFileSync(join(workDir, "VERYCOF.OUT"), "utf8");
    } finally {
        rmSync(workDir, { force: true, recursive: true });
    }
};

const executeCase = (item: MatrixCase): CaseRow => {
    const started = performance.now();
    const base = {
        caseId: item.caseId,
        protocol: item.protocol,
        seriesId: item.target.id,
        step: item.step,
        originalMissingCount: item.truthYears.length,
        removedMissingCount: item.removedYears.length,
        expectedFrontierYear: item.expectedFrontierYear,
        endpointDistanceYears: item.target.endYear - item.expectedFrontierYear,
    };
    try {
        const siteData = new Map(cleanSite);
        siteData.set(item.target.id, buildMultiMissingCorrupted(
            item.target.valuesByYear,
            item.removedYears,
        ));
        const outText = runCofecha(siteData);
        const result = parseCofechaResult(outText);
        const flaggedIds = extractPart6FlaggedASeriesIds(
            splitReportByParts(outText).get("PART 6") ?? "",
        );
        const referenceConfig = createCofechaMasterReferenceConfig({
            siteData,
            flaggedAIds: flaggedIds,
            cofechaRunId: item.caseId,
            rwlHash: item.caseId,
            masterDatingSeries: result.masterDatingSeries,
        });
        const diagnosis = diagnoseCrossdating(siteData, {
            referenceConfig,
            targetTrees: [item.target.id],
            cofechaText: outText,
            reviewWindowDisplayMode: "review",
            sharedZeroMarkerMode: "local2",
        });
        const primary = getDisplayedDiagnosisEvents(diagnosis).find(
            (event) => event.seriesId === item.target.id,
        ) ?? null;
        const missingReview = missingReviewEvent(primary);
        const primaryWindowCovered = windowCovers(primary, item.expectedFrontierYear);
        const strictMissingSuccess = primary?.eventType === "missingRing"
            && primaryWindowCovered;
        const workflowWindowCovered = windowCovers(
            missingReview,
            item.expectedFrontierYear,
        );
        const endpointWholeBounded = primary?.eventType !== "wholeSeriesMove"
            || (
                base.endpointDistanceYears <= 15
                && (primary.shiftYears ?? 0) < 0
                && Math.abs(primary.shiftYears ?? 0) <= 3
                && workflowWindowCovered
            );
        const cumulativeWholeAlias = primary?.eventType === "wholeSeriesMove"
            && !endpointWholeBounded;
        const workflowSuggestionSuccess = workflowWindowCovered
            && endpointWholeBounded;
        const failureReason = workflowSuggestionSuccess
            ? null
            : primary === null
                ? "refused"
                : cumulativeWholeAlias
                    ? "cumulative_whole_alias"
                    : missingReview === null
                        ? "missing_review_unavailable"
                        : "window_miss";
        return {
            ...base,
            elapsedMs: performance.now() - started,
            error: null,
            cofechaTargetFlagged: Array.from(flaggedIds).some(
                (id) => id.toLowerCase() === item.target.id.toLowerCase(),
            ),
            response: primary !== null,
            primaryType: primary?.eventType ?? null,
            primaryShiftYears: primary?.shiftYears ?? null,
            primaryTopYear: primary ? topYear(primary) : null,
            primaryWindowStart: primary?.startYear ?? null,
            primaryWindowEnd: primary?.endYear ?? null,
            primaryWindowCovered,
            strictMissingSuccess,
            interpretationKind: primary?.interpretationAmbiguity?.kind ?? null,
            hasMissingReviewInterpretation: missingReview !== null,
            workflowTopYear: missingReview ? topYear(missingReview) : null,
            workflowWindowStart: missingReview?.startYear ?? null,
            workflowWindowEnd: missingReview?.endYear ?? null,
            workflowWindowCovered,
            endpointWholeBounded,
            cumulativeWholeAlias,
            workflowSuggestionSuccess,
            failureReason,
            primary: previewEvent(primary),
            missingReview: previewEvent(missingReview),
        };
    } catch (error) {
        return {
            ...base,
            elapsedMs: performance.now() - started,
            error: error instanceof Error ? error.stack ?? error.message : String(error),
            cofechaTargetFlagged: false,
            response: false,
            primaryType: null,
            primaryShiftYears: null,
            primaryTopYear: null,
            primaryWindowStart: null,
            primaryWindowEnd: null,
            primaryWindowCovered: false,
            strictMissingSuccess: false,
            interpretationKind: null,
            hasMissingReviewInterpretation: false,
            workflowTopYear: null,
            workflowWindowStart: null,
            workflowWindowEnd: null,
            workflowWindowCovered: false,
            endpointWholeBounded: false,
            cumulativeWholeAlias: false,
            workflowSuggestionSuccess: false,
            failureReason: "error",
            primary: null,
            missingReview: null,
        };
    }
};

const rate = (count: number, total: number): number => total > 0 ? count / total : 0;
const summarizeRows = (rows: CaseRow[]) => ({
    cases: rows.length,
    responseRate: rate(rows.filter((row) => row.response).length, rows.length),
    strictMissingSuccessRate: rate(
        rows.filter((row) => row.strictMissingSuccess).length,
        rows.length,
    ),
    workflowSuggestionSuccessRate: rate(
        rows.filter((row) => row.workflowSuggestionSuccess).length,
        rows.length,
    ),
    refusalRate: rate(rows.filter((row) => !row.response).length, rows.length),
    cumulativeWholeAliasRate: rate(
        rows.filter((row) => row.cumulativeWholeAlias).length,
        rows.length,
    ),
    missingReviewAvailableRate: rate(
        rows.filter((row) => row.hasMissingReviewInterpretation).length,
        rows.length,
    ),
    failureReasons: Object.fromEntries(Array.from(new Set(
        rows.map((row) => row.failureReason ?? "success"),
    )).sort().map((reason) => [
        reason,
        rows.filter((row) => (row.failureReason ?? "success") === reason).length,
    ])),
});

const workerOutputPath = (index: number): string => join(
    runDir,
    `cases.worker-${index}-of-${workerCount}.jsonl`,
);

const runWorker = (): void => {
    if (workerIndex === null) throw new Error("worker index is required");
    mkdirSync(runDir, { recursive: true });
    const outputPath = workerOutputPath(workerIndex);
    writeFileSync(outputPath, "", "utf8");
    let completed = 0;
    matrixCases.forEach((item, index) => {
        if (index % workerCount !== workerIndex) return;
        appendFileSync(outputPath, `${JSON.stringify(executeCase(item))}\n`, "utf8");
        completed += 1;
        if (completed % 20 === 0) {
            console.log(`progress worker=${workerIndex} cases=${completed} last=${item.caseId}`);
        }
    });
    console.log(`complete worker=${workerIndex} cases=${completed} output=${outputPath}`);
};

const csvEscape = (value: unknown): string => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const aggregate = (): void => {
    const rows = Array.from({ length: workerCount }, (_, index) => workerOutputPath(index))
        .flatMap((path) => readFileSync(path, "utf8")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as CaseRow));
    if (rows.length !== matrixCases.length) {
        throw new Error(`incomplete matrix: expected=${matrixCases.length} actual=${rows.length}`);
    }
    const finalSourceHash = createHash("sha256").update(readFileSync(inputPath)).digest("hex");
    const summary = {
        inputPath,
        sourceSha256: sourceHash,
        sourceUnchanged: finalSourceHash === sourceHash,
        totalSeries: parsed.size,
        seriesWithZeros: seriesPlans.length,
        naturalZeroCount: seriesPlans.reduce(
            (sum, plan) => sum + plan.truthYears.length,
            0,
        ),
        protocols,
        expectedCases: matrixCases.length,
        overall: summarizeRows(rows),
        byProtocol: Object.fromEntries(protocols.map((protocol) => [
            protocol,
            summarizeRows(rows.filter((row) => row.protocol === protocol)),
        ])),
        bySeries: Object.fromEntries(seriesPlans.map((plan) => [
            plan.target.id,
            summarizeRows(rows.filter((row) => row.seriesId === plan.target.id)),
        ])),
        failures: rows.filter((row) => !row.workflowSuggestionSuccess),
    };
    writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    const scalarColumns = [
        "caseId",
        "protocol",
        "seriesId",
        "step",
        "originalMissingCount",
        "removedMissingCount",
        "expectedFrontierYear",
        "endpointDistanceYears",
        "elapsedMs",
        "error",
        "cofechaTargetFlagged",
        "response",
        "primaryType",
        "primaryShiftYears",
        "primaryTopYear",
        "primaryWindowStart",
        "primaryWindowEnd",
        "primaryWindowCovered",
        "strictMissingSuccess",
        "interpretationKind",
        "hasMissingReviewInterpretation",
        "workflowTopYear",
        "workflowWindowStart",
        "workflowWindowEnd",
        "workflowWindowCovered",
        "endpointWholeBounded",
        "cumulativeWholeAlias",
        "workflowSuggestionSuccess",
        "failureReason",
    ] as const;
    writeFileSync(join(runDir, "cases.csv"), [
        scalarColumns.join(","),
        ...rows.map((row) => scalarColumns.map((column) => csvEscape(row[column])).join(",")),
    ].join("\r\n") + "\r\n", "utf8");
    console.log(`CO612_ZERO_FRONTIER_MATRIX ${JSON.stringify({
        runDir,
        sourceUnchanged: summary.sourceUnchanged,
        expectedCases: summary.expectedCases,
        overall: summary.overall,
        byProtocol: summary.byProtocol,
    })}`);
};

const pipeLines = (stream: NodeJS.ReadableStream, prefix: string, error = false) => {
    let pending = "";
    stream.on("data", (chunk) => {
        pending += String(chunk);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        lines.filter(Boolean).forEach((line) => (
            error ? console.error : console.log
        )(`${prefix}${line}`));
    });
    stream.on("end", () => {
        if (pending) (error ? console.error : console.log)(`${prefix}${pending}`);
    });
};

const runParent = async (): Promise<void> => {
    rmSync(runDir, { force: true, recursive: true });
    mkdirSync(runDir, { recursive: true });
    const commonArgs = [
        "--input", inputPath,
        "--output-dir", outputRoot,
        "--run-id", runId,
        "--run-dir", runDir,
        "--worker-count", String(workers),
        "--workers", String(workers),
        "--protocols", protocols.join(","),
        ...(selectedSeries ? ["--series", selectedSeries.join(",")] : []),
    ];
    await Promise.all(Array.from({ length: workers }, (_, index) => new Promise<void>(
        (done, fail) => {
            const child = spawn(process.execPath, [
                viteNodePath,
                scriptPath,
                "--",
                ...commonArgs,
                "--worker-index", String(index),
            ], {
                cwd: repoRoot,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
            pipeLines(child.stdout, `[worker ${index}] `);
            pipeLines(child.stderr, `[worker ${index}] `, true);
            child.on("error", fail);
            child.on("exit", (code) => (
                code === 0 ? done() : fail(new Error(`worker ${index} exited ${code}`))
            ));
        },
    )));
    aggregate();
};

console.log(`CO612_ZERO_FRONTIER_MATRIX_STATS ${JSON.stringify({
    inputPath,
    sourceHash,
    seriesWithZeros: seriesPlans.length,
    naturalZeroCount: seriesPlans.reduce((sum, plan) => sum + plan.truthYears.length, 0),
    protocols,
    cases: matrixCases.length,
    workers,
    runDir,
})}`);
if (workerIndex !== null) {
    runWorker();
} else {
    await runParent();
}
