import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
    compareBootstrapReviewQueueCandidates,
    findAbsoluteUnidentifiableTruthYears,
} from "@/features/crossdating/diagnosis/bootstrapEvaluation";
import {
    extractPart6FlaggedASeriesIds,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import type {
    DiagnosisEvent,
    DiagnosisEventDecisionAudit,
    DiagnosisJointEventDecision,
    DiagnosisReviewWindowDecision,
} from "@/features/crossdating/diagnosis/types";
import { cofechaStyleStandardize } from "@/features/crossdating/reference";
import { insertMissingYearAtSide } from "@/features/rwl/edit";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    buildMultiMissingCorrupted,
    parseRwl,
} from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

type WorkerTargetResult = {
    seriesId: string;
    strictEvent: DiagnosisEvent | null;
    reviewEvent: DiagnosisEvent | null;
    reviewDecision: DiagnosisReviewWindowDecision;
    jointDecision: DiagnosisJointEventDecision;
    audit: DiagnosisEventDecisionAudit;
    referenceAnchorCount: number;
    durationMs: number;
};

type WorkerResponse = {
    requestId: string;
    targets?: WorkerTargetResult[];
    error?: string;
};

type WorkerRequest = {
    requestId: string;
    sitePath: string;
    cofechaOutPath: string;
    targetIds: string[];
    cofechaFlaggedIds: string[];
    pairwiseClusterIds: string[];
    usePairwiseBootstrap: boolean;
    runId: string;
    rwlHash: string;
};

type TruthState = {
    seriesId: string;
    truthYears: number[];
    remainingTruthYears: number[];
};

type EventOutcome = {
    response: boolean;
    eventType: DiagnosisEvent["eventType"] | null;
    operationCorrect: boolean;
    windowCovered: boolean;
    top1Exact: boolean;
    topYear: number | null;
    windowStart: number | null;
    windowEnd: number | null;
    windowWidth: number | null;
    confidence: DiagnosisEvent["confidenceLevel"] | null;
    score: number | null;
    scoreMargin: number | null;
    reviewOnly: boolean;
};

type ReviewChoiceOutcome = EventOutcome & {
    interpretation: "primary" | "alternative" | null;
};

type BenchmarkReferenceMode = "adaptive" | "pairwise-only";

type EventObservation = {
    round: number;
    eventId: string;
    seriesId: string;
    truthYear: number;
    absoluteIdentifiable: boolean;
    restoredOtherEvents: number;
    restoredOtherFraction: number;
    cofechaFlagged: boolean;
    cofechaFlaggedCount: number;
    referenceMode: "pairwise-leave-one-out" | "cofecha-pass-leave-one-out";
    referenceAnchorCount: number;
    referenceSourceCount: number;
    minimumReferenceDepth: number;
    medianReferenceDepth: number;
    globalZeroLagBestRate: number;
    globalAbsoluteLagP90: number;
    strictReason: DiagnosisEventDecisionAudit["finalReason"];
    reviewDecisionReason: DiagnosisReviewWindowDecision["reason"];
    reviewDecisionStatus: DiagnosisReviewWindowDecision["status"];
    jointDecisionStatus: DiagnosisJointEventDecision["status"];
    jointDecisionReason: DiagnosisJointEventDecision["reason"];
    jointProductionAgreement: DiagnosisJointEventDecision["productionAgreement"];
    jointProductionExactMatch: boolean;
    candidateCount: number;
    candidateModeCount: number;
    reviewQueueEnteredRound: number | null;
    strict: EventOutcome;
    review: EventOutcome;
    reviewChoice: ReviewChoiceOutcome;
};

type ApplicationRow = {
    round: number;
    eventId: string;
    seriesId: string;
    truthYear: number;
    sourceStatus: DiagnosisReviewWindowDecision["status"];
    suggestedWindow: { startYear: number; endYear: number };
    suggestedTopYear: number | null;
    interpretation: Exclude<ReviewChoiceOutcome["interpretation"], null>;
    recoveredBefore: number;
    recoveredAfter: number;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteNode = join(repoRoot, "node_modules", "vite-node", "vite-node.mjs");
const workerScript = join(repoRoot, "scripts", "co612-review-window-worker.ts");
const cofechaExe = join(
    repoRoot,
    "src-tauri",
    "bin",
    "cofecha-x86_64-pc-windows-msvc.exe",
);
const args = process.argv.slice(2);
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const hasFlag = (name: string): boolean => args.includes(name);
const inputPath = resolve(valueFor("--input") ?? "D:/软件测试/co612.rwl");
const outputRoot = resolve(
    valueFor("--output-dir") ?? "D:/软件测试/co612-review-window-results",
);
const runId = valueFor("--run-id")
    ?? `bootstrap-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runDir = join(outputRoot, runId);
const maxRounds = Math.max(1, Number(valueFor("--max-rounds") ?? 400));
const workerCount = Math.max(1, Math.min(
    16,
    Number(valueFor("--workers") ?? 8),
));
const minimumFirstSweepCorrectWindowsValue = valueFor(
    "--minimum-first-sweep-correct-windows",
);
const minimumFirstSweepCorrectWindows = minimumFirstSweepCorrectWindowsValue === null
    ? null
    : Number(minimumFirstSweepCorrectWindowsValue);
const resume = hasFlag("--resume");
const referenceModeValue = valueFor("--reference-mode") ?? "adaptive";
if (referenceModeValue !== "adaptive" && referenceModeValue !== "pairwise-only") {
    throw new Error("--reference-mode must be adaptive or pairwise-only");
}
const referenceMode: BenchmarkReferenceMode = referenceModeValue;

if (minimumFirstSweepCorrectWindows !== null
    && (!Number.isInteger(minimumFirstSweepCorrectWindows)
        || minimumFirstSweepCorrectWindows < 0)) {
    throw new Error("--minimum-first-sweep-correct-windows must be a non-negative integer");
}

if (!existsSync(inputPath)) throw new Error(`RWL not found: ${inputPath}`);
if (!existsSync(cofechaExe)) throw new Error(`COFECHA not found: ${cofechaExe}`);
mkdirSync(runDir, { recursive: true });
mkdirSync(join(runDir, "rounds"), { recursive: true });

const sourceBytes = readFileSync(inputPath);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
const parsed = parseRwl(sourceBytes.toString("utf8"));
const originalSite: RwlSiteData = new Map(Array.from(parsed, ([seriesId, series]) => [
    seriesId,
    new Map(series.valuesByYear),
]));
const truthBySeries = new Map(Array.from(parsed, ([seriesId, series]) => [
    seriesId,
    Array.from(series.valuesByYear)
        .filter(([, value]) => value === 0)
        .map(([year]) => year)
        .sort((left, right) => right - left),
]));
const totalTruthEvents = Array.from(truthBySeries.values()).reduce(
    (sum, years) => sum + years.length,
    0,
);
const commonTruthYears = findAbsoluteUnidentifiableTruthYears(
    originalSite,
    truthBySeries,
);

const cloneSite = (siteData: RwlSiteData): RwlSiteData => new Map(Array.from(
    siteData,
    ([seriesId, data]) => [seriesId, new Map(data)],
));

const buildInitialSite = (): RwlSiteData => {
    const initial = cloneSite(originalSite);
    truthBySeries.forEach((truthYears, seriesId) => {
        if (truthYears.length > 0) {
            initial.set(
                seriesId,
                buildMultiMissingCorrupted(
                    parsed.get(seriesId)!.valuesByYear,
                    truthYears,
                ),
            );
        }
    });
    return initial;
};

const zeroCount = (siteData: RwlSiteData): number => Array.from(
    siteData.values(),
).reduce((sum, data) => (
    sum + Array.from(data.values()).filter((value) => value === 0).length
), 0);

const parseSitePath = (path: string): RwlSiteData => new Map(Array.from(
    parseRwl(readFileSync(path, "utf8")),
    ([seriesId, series]) => [seriesId, new Map(series.valuesByYear)],
));

const eventOutcome = (
    event: DiagnosisEvent | null,
    truthYear: number,
): EventOutcome => {
    const operationCorrect = event?.eventType === "missingRing";
    const windowCovered = Boolean(
        operationCorrect
        && truthYear >= event!.startYear
        && truthYear <= event!.endYear,
    );
    return {
        response: event !== null,
        eventType: event?.eventType ?? null,
        operationCorrect,
        windowCovered,
        top1Exact: operationCorrect && event?.rankedYears[0]?.year === truthYear,
        topYear: event?.rankedYears[0]?.year ?? null,
        windowStart: event?.startYear ?? null,
        windowEnd: event?.endYear ?? null,
        windowWidth: event ? event.endYear - event.startYear + 1 : null,
        confidence: event?.confidenceLevel ?? null,
        score: event?.evidence.score ?? null,
        scoreMargin: event?.evidence.scoreMargin ?? null,
        reviewOnly: event?.reviewOnly === true,
    };
};

const reviewChoiceOutcome = (
    event: DiagnosisEvent | null,
    truthYear: number,
): ReviewChoiceOutcome => {
    const primary = eventOutcome(event, truthYear);
    const alternativeEvent = event?.interpretationAmbiguity?.alternative ?? null;
    const alternative = eventOutcome(alternativeEvent, truthYear);
    if ((!primary.operationCorrect || !primary.windowCovered)
        && alternative.operationCorrect
        && alternative.windowCovered) {
        return { ...alternative, interpretation: "alternative" };
    }
    return {
        ...primary,
        interpretation: event ? "primary" : null,
    };
};

const pearsonAtLag = (
    left: Map<number, number>,
    right: Map<number, number>,
    lag: number,
): number | null => {
    let count = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    left.forEach((x, year) => {
        const y = right.get(year + lag);
        if (y === undefined) return;
        count += 1;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
    });
    if (count < 50) return null;
    const numerator = sxy - sx * sy / count;
    const denominator = Math.sqrt(
        Math.max(0, sxx - sx * sx / count)
        * Math.max(0, syy - sy * sy / count),
    );
    return denominator > 0 ? numerator / denominator : null;
};

const standardizedSiteSeries = (siteData: RwlSiteData) => Array.from(
    siteData,
    ([seriesId, data]) => ({
        seriesId,
        residual: new Map(cofechaStyleStandardize(new Map(Array.from(data).flatMap(
            ([year, value]) => typeof value === "number"
                ? [[year, value] as [number, number]]
                : [],
        ))).map((point) => [point.year, point.value])),
    }),
).filter((row) => row.residual.size >= 50);

const selectPairwiseBootstrapCluster = (siteData: RwlSiteData): string[] => {
    const series = standardizedSiteSeries(siteData);
    const adjacency = new Map(series.map((row) => [row.seriesId, new Set<string>()]));
    for (let leftIndex = 0; leftIndex < series.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < series.length; rightIndex += 1) {
            const left = series[leftIndex];
            const right = series[rightIndex];
            const rows = Array.from({ length: 21 }, (_, index) => {
                const lag = index - 10;
                return { lag, correlation: pearsonAtLag(left.residual, right.residual, lag) };
            }).filter((row): row is { lag: number; correlation: number } => (
                row.correlation !== null
            )).sort((a, b) => b.correlation - a.correlation);
            const best = rows[0];
            const zero = rows.find((row) => row.lag === 0)?.correlation ?? -1;
            if (!best || zero < 0.30 || best.correlation - zero > 0.03) continue;
            adjacency.get(left.seriesId)?.add(right.seriesId);
            adjacency.get(right.seriesId)?.add(left.seriesId);
        }
    }
    const visited = new Set<string>();
    const components: string[][] = [];
    adjacency.forEach((_, start) => {
        if (visited.has(start)) return;
        const queue = [start];
        const component: string[] = [];
        visited.add(start);
        while (queue.length > 0) {
            const current = queue.shift()!;
            component.push(current);
            adjacency.get(current)?.forEach((neighbor) => {
                if (visited.has(neighbor)) return;
                visited.add(neighbor);
                queue.push(neighbor);
            });
        }
        components.push(component);
    });
    return components.sort((left, right) => right.length - left.length)[0] ?? [];
};

type PairwiseAlignmentSummary = {
    eligiblePairs: number;
    zeroLagBestPairs: number;
    zeroLagBestRate: number;
    meanAbsoluteBestLag: number;
    p90AbsoluteBestLag: number;
};

const summarizePairwiseAlignment = (siteData: RwlSiteData): PairwiseAlignmentSummary => {
    const series = standardizedSiteSeries(siteData);
    const lags: number[] = [];
    for (let leftIndex = 0; leftIndex < series.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < series.length; rightIndex += 1) {
            const rows = Array.from({ length: 21 }, (_, index) => {
                const lag = index - 10;
                return {
                    lag,
                    correlation: pearsonAtLag(
                        series[leftIndex].residual,
                        series[rightIndex].residual,
                        lag,
                    ),
                };
            }).filter((row): row is { lag: number; correlation: number } => (
                row.correlation !== null
            )).sort((left, right) => (
                right.correlation - left.correlation
                || Math.abs(left.lag) - Math.abs(right.lag)
            ));
            if (rows[0]) lags.push(Math.abs(rows[0].lag));
        }
    }
    lags.sort((left, right) => left - right);
    const zeroLagBestPairs = lags.filter((lag) => lag === 0).length;
    return {
        eligiblePairs: lags.length,
        zeroLagBestPairs,
        zeroLagBestRate: zeroLagBestPairs / Math.max(1, lags.length),
        meanAbsoluteBestLag: lags.reduce((sum, lag) => sum + lag, 0)
            / Math.max(1, lags.length),
        p90AbsoluteBestLag: lags[Math.max(0, Math.ceil(lags.length * 0.9) - 1)] ?? 0,
    };
};

class DiagnosisWorkerClient {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<string, {
        resolve: (response: WorkerResponse) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();

    constructor(index: number) {
        this.child = spawn(process.execPath, [viteNode, workerScript], {
            cwd: repoRoot,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        const output = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
        output.on("line", (line) => {
            if (!line.startsWith("CO612_WORKER_RESPONSE ")) return;
            const response = JSON.parse(
                line.slice("CO612_WORKER_RESPONSE ".length),
            ) as WorkerResponse;
            const pending = this.pending.get(response.requestId);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(response.requestId);
            if (response.error) pending.reject(new Error(response.error));
            else pending.resolve(response);
        });
        this.child.stderr.on("data", (data) => {
            appendFileSync(join(runDir, `worker-${index}.log`), data);
        });
        this.child.on("exit", (code) => {
            this.pending.forEach(({ reject, timer }) => {
                clearTimeout(timer);
                reject(new Error(`diagnosis worker exited with code ${code}`));
            });
            this.pending.clear();
        });
    }

    request(request: WorkerRequest): Promise<WorkerResponse> {
        return new Promise((resolveRequest, rejectRequest) => {
            const timer = setTimeout(() => {
                this.pending.delete(request.requestId);
                rejectRequest(new Error(`worker request timed out: ${request.requestId}`));
            }, 15 * 60_000);
            this.pending.set(request.requestId, {
                resolve: resolveRequest,
                reject: rejectRequest,
                timer,
            });
            this.child.stdin.write(`${JSON.stringify(request)}\n`);
        });
    }

    close(): void {
        this.child.stdin.end();
    }
}

const clients = Array.from({ length: workerCount }, (_, index) => (
    new DiagnosisWorkerClient(index + 1)
));

const diagnoseAllTargets = async (input: {
    label: string;
    sitePath: string;
    outPath: string;
    targetIds: string[];
    cofechaFlaggedIds: string[];
    pairwiseClusterIds: string[];
    usePairwiseBootstrap: boolean;
    rwlHash: string;
}): Promise<WorkerTargetResult[]> => {
    const chunks = Array.from({ length: clients.length }, () => [] as string[]);
    input.targetIds.forEach((seriesId, index) => {
        chunks[index % chunks.length].push(seriesId);
    });
    const responses = await Promise.all(chunks.map((targetIds, index) => (
        targetIds.length === 0
            ? Promise.resolve({ requestId: `${input.label}-${index}`, targets: [] })
            : clients[index].request({
                requestId: `${input.label}-${index}`,
                sitePath: input.sitePath,
                cofechaOutPath: input.outPath,
                targetIds,
                cofechaFlaggedIds: input.cofechaFlaggedIds,
                pairwiseClusterIds: input.pairwiseClusterIds,
                usePairwiseBootstrap: input.usePairwiseBootstrap,
                runId: `${runId}-${input.label}`,
                rwlHash: input.rwlHash,
            })
    )));
    const order = new Map(input.targetIds.map((seriesId, index) => [seriesId, index]));
    return responses.flatMap((response) => response.targets ?? []).sort((left, right) => (
        (order.get(left.seriesId) ?? Infinity) - (order.get(right.seriesId) ?? Infinity)
    ));
};

const canonicalIds = new Map(Array.from(originalSite.keys(), (seriesId) => [
    seriesId.trim().toUpperCase(),
    seriesId,
]));

const runCofechaState = (label: string, siteData: RwlSiteData) => {
    const stateDir = join(runDir, label);
    mkdirSync(stateDir, { recursive: true });
    const sitePath = join(stateDir, "state.rwl");
    const outPath = join(stateDir, "VERYCOF.OUT");
    writeFileSync(sitePath, formatTucson(siteData, false), "utf8");
    execFileSync(cofechaExe, [], {
        cwd: stateDir,
        input: "very\nstate.rwl\n\n\n\n\n\n\n",
        timeout: 30_000,
        stdio: ["pipe", "ignore", "pipe"],
    });
    const outText = readFileSync(outPath, "utf8");
    const parts = splitReportByParts(outText);
    const flaggedIds = extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? "")
        .flatMap((seriesId) => {
            const canonical = canonicalIds.get(seriesId.trim().toUpperCase());
            return canonical ? [canonical] : [];
        });
    const pairwiseClusterIds = selectPairwiseBootstrapCluster(siteData);
    return {
        stateDir,
        sitePath,
        outPath,
        flaggedIds,
        pairwiseClusterIds,
        usePairwiseBootstrap: referenceMode === "pairwise-only"
            || siteData.size - new Set(flaggedIds).size < 3,
        rwlHash: createHash("sha256").update(readFileSync(sitePath)).digest("hex"),
    };
};

const targetIds = Array.from(originalSite.keys()).sort();
const cleanBaselinePath = join(runDir, "clean-original-targets.json");
let cleanBaseline: WorkerTargetResult[];
if (resume && existsSync(cleanBaselinePath)) {
    cleanBaseline = JSON.parse(readFileSync(cleanBaselinePath, "utf8")) as WorkerTargetResult[];
} else {
    const cleanContext = runCofechaState("clean-original", originalSite);
    cleanBaseline = await diagnoseAllTargets({
        label: "clean-original",
        sitePath: cleanContext.sitePath,
        outPath: cleanContext.outPath,
        targetIds,
        cofechaFlaggedIds: cleanContext.flaggedIds,
        pairwiseClusterIds: cleanContext.pairwiseClusterIds,
        usePairwiseBootstrap: cleanContext.usePairwiseBootstrap,
        rwlHash: cleanContext.rwlHash,
    });
    writeFileSync(cleanBaselinePath, JSON.stringify(cleanBaseline), "utf8");
}

const checkpointPath = join(runDir, "checkpoint.json");
const checkpointSitePath = join(runDir, "checkpoint-current.rwl");
const observationsPath = join(runDir, "observations.jsonl");
const applicationsPath = join(runDir, "applications.jsonl");
const roundsPath = join(runDir, "rounds.jsonl");

let siteData: RwlSiteData;
let states: Map<string, TruthState>;
let nextRound: number;
let recoveredEvents: number;
let resumedInitialPairwiseAlignment: PairwiseAlignmentSummary | null = null;
if (resume && existsSync(checkpointPath) && existsSync(checkpointSitePath)) {
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
        sourceSha256: string;
        nextRound: number;
        recoveredEvents: number;
        states: TruthState[];
        initialPairwiseAlignment?: PairwiseAlignmentSummary;
        referenceMode?: BenchmarkReferenceMode;
    };
    if (checkpoint.sourceSha256 !== sourceSha256) {
        throw new Error("resume source hash does not match current co612.rwl");
    }
    if ((checkpoint.referenceMode ?? "adaptive") !== referenceMode) {
        throw new Error(
            `resume reference mode ${checkpoint.referenceMode ?? "adaptive"}`
            + ` does not match requested ${referenceMode}`,
        );
    }
    siteData = parseSitePath(checkpointSitePath);
    states = new Map(checkpoint.states.map((state) => [state.seriesId, state]));
    nextRound = checkpoint.nextRound;
    recoveredEvents = checkpoint.recoveredEvents;
    resumedInitialPairwiseAlignment = checkpoint.initialPairwiseAlignment ?? null;
} else {
    siteData = buildInitialSite();
    states = new Map(Array.from(truthBySeries, ([seriesId, truthYears]) => [
        seriesId,
        { seriesId, truthYears: [...truthYears], remainingTruthYears: [...truthYears] },
    ]));
    nextRound = 1;
    recoveredEvents = 0;
    [observationsPath, applicationsPath, roundsPath].forEach((path) => {
        if (existsSync(path)) rmSync(path);
    });
}
const firstExecutedRound = nextRound;
let firstSweepGate: {
    round: number;
    correctWindows: number;
    minimumCorrectWindows: number;
    passed: boolean;
    jointCompared: number;
    jointSame: number;
    jointOperationMismatches: number;
    jointLocationMismatches: number;
    jointPresenceMismatches: number;
    jointExactMatches: number;
    jointNonExactSeriesIds: string[];
} | null = null;

if (resume) {
    const retainCompletedRounds = (path: string) => {
        if (!existsSync(path)) return;
        const retained = readFileSync(path, "utf8")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { round: number })
            .filter((row) => row.round < nextRound);
        writeFileSync(
            path,
            retained.length > 0
                ? `${retained.map((row) => JSON.stringify(row)).join("\n")}\n`
                : "",
            "utf8",
        );
    };
    retainCompletedRounds(observationsPath);
    retainCompletedRounds(applicationsPath);
    retainCompletedRounds(roundsPath);
}

const firstReviewableRoundByEventId = new Map<string, number>();
if (existsSync(observationsPath)) {
    readFileSync(observationsPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EventObservation)
        .filter((row) => row.review.response)
        .forEach((row) => {
            const previous = firstReviewableRoundByEventId.get(row.eventId);
            if (previous === undefined || row.round < previous) {
                firstReviewableRoundByEventId.set(row.eventId, row.round);
            }
        });
}

const initialVerificationSite = buildInitialSite();
const initialZeroCount = zeroCount(initialVerificationSite);
if (initialZeroCount !== 0) {
    throw new Error(`hidden zero leaked into initial state: ${initialZeroCount}`);
}

const initialPairwiseAlignment = nextRound === 1
    ? summarizePairwiseAlignment(siteData)
    : resumedInitialPairwiseAlignment
        ?? summarizePairwiseAlignment(initialVerificationSite);
let stopReason = "max_rounds";

try {
    for (let round = nextRound; round <= maxRounds; round += 1) {
        const roundStartedAt = Date.now();
        const activeTargetIds = Array.from(states.values())
            .filter((state) => state.remainingTruthYears.length > 0)
            .map((state) => state.seriesId)
            .sort();
        const label = join("rounds", String(round).padStart(4, "0"));
        const context = runCofechaState(label, siteData);
        const roundPairwiseAlignment = summarizePairwiseAlignment(siteData);
        const results = await diagnoseAllTargets({
            label: `round-${round}`,
            sitePath: context.sitePath,
            outPath: context.outPath,
            targetIds: activeTargetIds,
            cofechaFlaggedIds: context.flaggedIds,
            pairwiseClusterIds: context.pairwiseClusterIds,
            usePairwiseBootstrap: context.usePairwiseBootstrap,
            rwlHash: context.rwlHash,
        });
        writeFileSync(
            join(context.stateDir, "target-diagnoses.json"),
            JSON.stringify(results),
            "utf8",
        );
        const bySeries = new Map(results.map((result) => [result.seriesId, result]));
        const activeObservations: EventObservation[] = [];
        states.forEach((state) => {
            const truthYear = state.remainingTruthYears[0];
            if (truthYear === undefined) return;
            const result = bySeries.get(state.seriesId);
            if (!result) throw new Error(`missing worker result for ${state.seriesId}`);
            const eventId = `${state.seriesId}:${truthYear}`;
            const strict = eventOutcome(result.strictEvent, truthYear);
            const review = eventOutcome(result.reviewEvent, truthYear);
            const reviewChoice = reviewChoiceOutcome(result.reviewEvent, truthYear);
            if (review.response && !firstReviewableRoundByEventId.has(eventId)) {
                firstReviewableRoundByEventId.set(eventId, round);
            }
            activeObservations.push({
                round,
                eventId,
                seriesId: state.seriesId,
                truthYear,
                absoluteIdentifiable: !commonTruthYears.has(truthYear),
                restoredOtherEvents: recoveredEvents,
                restoredOtherFraction: recoveredEvents / Math.max(1, totalTruthEvents - 1),
                cofechaFlagged: context.flaggedIds.includes(state.seriesId),
                cofechaFlaggedCount: context.flaggedIds.length,
                referenceMode: context.usePairwiseBootstrap
                    ? "pairwise-leave-one-out"
                    : "cofecha-pass-leave-one-out",
                referenceAnchorCount: result.referenceAnchorCount,
                referenceSourceCount: result.audit.referenceSourceCount,
                minimumReferenceDepth: result.audit.minimumReferenceDepth,
                medianReferenceDepth: result.audit.medianReferenceDepth,
                globalZeroLagBestRate: roundPairwiseAlignment.zeroLagBestRate,
                globalAbsoluteLagP90: roundPairwiseAlignment.p90AbsoluteBestLag,
                strictReason: result.audit.finalReason,
                reviewDecisionReason: result.reviewDecision.reason,
                reviewDecisionStatus: result.reviewDecision.status,
                jointDecisionStatus: result.jointDecision.status,
                jointDecisionReason: result.jointDecision.reason,
                jointProductionAgreement: result.jointDecision.productionAgreement,
                jointProductionExactMatch: result.jointDecision.productionExactMatch,
                candidateCount: result.audit.candidateCount,
                candidateModeCount: result.audit.candidateModeCount,
                reviewQueueEnteredRound: firstReviewableRoundByEventId.get(eventId) ?? null,
                strict,
                review,
                reviewChoice,
            });
        });
        activeObservations.forEach((row) => {
            appendFileSync(observationsPath, `${JSON.stringify(row)}\n`, "utf8");
        });
        const eligible = activeObservations.filter((row) => (
            row.absoluteIdentifiable
            && row.reviewChoice.operationCorrect
            && row.reviewChoice.windowCovered
        )).sort((left, right) => {
            const leftResult = bySeries.get(left.seriesId)!;
            const rightResult = bySeries.get(right.seriesId)!;
            return compareBootstrapReviewQueueCandidates({
                seriesId: left.seriesId,
                reviewQueueEnteredRound: left.reviewQueueEnteredRound,
                reviewStatus: leftResult.reviewDecision.status,
                score: left.reviewChoice.score,
            }, {
                seriesId: right.seriesId,
                reviewQueueEnteredRound: right.reviewQueueEnteredRound,
                reviewStatus: rightResult.reviewDecision.status,
                score: right.reviewChoice.score,
            });
        });
        const selected = eligible[0] ?? null;
        const roundAudit = {
            round,
            recoveredBefore: recoveredEvents,
            remainingEvents: totalTruthEvents - recoveredEvents,
            activeEvents: activeObservations.length,
            cofechaFlaggedCount: context.flaggedIds.length,
            pairwiseClusterSize: context.pairwiseClusterIds.length,
            pairwiseZeroLagBestRate: roundPairwiseAlignment.zeroLagBestRate,
            pairwiseAbsoluteLagP90: roundPairwiseAlignment.p90AbsoluteBestLag,
            referenceMode: context.usePairwiseBootstrap
                ? "pairwise-leave-one-out"
                : "cofecha-pass-leave-one-out",
            strictResponseRate: activeObservations.filter((row) => row.strict.response).length
                / Math.max(1, activeObservations.length),
            reviewResponseRate: activeObservations.filter((row) => row.review.response).length
                / Math.max(1, activeObservations.length),
            strictCoverageRate: activeObservations.filter((row) => row.strict.windowCovered).length
                / Math.max(1, activeObservations.length),
            reviewCoverageRate: activeObservations.filter((row) => row.review.windowCovered).length
                / Math.max(1, activeObservations.length),
            reviewChoiceCoverageRate: activeObservations.filter(
                (row) => row.reviewChoice.windowCovered,
            ).length / Math.max(1, activeObservations.length),
            alternativeChoiceCount: activeObservations.filter(
                (row) => row.reviewChoice.interpretation === "alternative",
            ).length,
            selectedEventId: selected?.eventId ?? null,
            durationMs: Date.now() - roundStartedAt,
        };
        appendFileSync(roundsPath, `${JSON.stringify(roundAudit)}\n`, "utf8");
        if (round === firstExecutedRound && minimumFirstSweepCorrectWindows !== null) {
            const correctWindows = activeObservations.filter((row) => (
                row.absoluteIdentifiable
                && row.review.operationCorrect
                && row.review.windowCovered
            )).length;
            firstSweepGate = {
                round,
                correctWindows,
                minimumCorrectWindows: minimumFirstSweepCorrectWindows,
                passed: correctWindows >= minimumFirstSweepCorrectWindows,
                jointCompared: activeObservations.length,
                jointSame: activeObservations.filter((row) => (
                    row.jointProductionAgreement === "same"
                )).length,
                jointOperationMismatches: activeObservations.filter((row) => (
                    row.jointProductionAgreement === "operation_mismatch"
                )).length,
                jointLocationMismatches: activeObservations.filter((row) => (
                    row.jointProductionAgreement === "location_mismatch"
                )).length,
                jointPresenceMismatches: activeObservations.filter((row) => (
                    row.jointProductionAgreement === "presence_mismatch"
                )).length,
                jointExactMatches: activeObservations.filter((row) => (
                    row.jointProductionExactMatch
                )).length,
                jointNonExactSeriesIds: activeObservations.filter((row) => (
                    !row.jointProductionExactMatch
                )).map((row) => row.seriesId),
            };
            if (!firstSweepGate.passed) {
                stopReason = "first_sweep_regression_gate_failed";
                break;
            }
        }
        if (!selected) {
            stopReason = "no_new_correct_review_window_after_full_sweep";
            break;
        }
        const selectedResult = bySeries.get(selected.seriesId)!;
        const current = siteData.get(selected.seriesId)!;
        siteData.set(
            selected.seriesId,
            insertMissingYearAtSide(current, selected.truthYear, "right"),
        );
        const state = states.get(selected.seriesId)!;
        state.remainingTruthYears.shift();
        const application: ApplicationRow = {
            round,
            eventId: selected.eventId,
            seriesId: selected.seriesId,
            truthYear: selected.truthYear,
            sourceStatus: selectedResult.reviewDecision.status,
            suggestedWindow: {
                startYear: selected.reviewChoice.windowStart!,
                endYear: selected.reviewChoice.windowEnd!,
            },
            suggestedTopYear: selected.reviewChoice.topYear,
            interpretation: selected.reviewChoice.interpretation!,
            recoveredBefore: recoveredEvents,
            recoveredAfter: recoveredEvents + 1,
        };
        recoveredEvents += 1;
        appendFileSync(applicationsPath, `${JSON.stringify(application)}\n`, "utf8");
        writeFileSync(checkpointSitePath, formatTucson(siteData, false), "utf8");
        writeFileSync(checkpointPath, JSON.stringify({
            sourceSha256,
            nextRound: round + 1,
            recoveredEvents,
            states: [...states.values()],
            initialPairwiseAlignment,
            referenceMode,
        }, null, 2), "utf8");
        console.log(
            `CO612_REVIEW_BOOTSTRAP_PROGRESS round=${round}`
            + ` recovered=${recoveredEvents}/${totalTruthEvents}`
            + ` selected=${selected.eventId}`
            + ` seconds=${(roundAudit.durationMs / 1000).toFixed(2)}`,
        );
        if (recoveredEvents === totalTruthEvents) {
            stopReason = "all_events_recovered";
            break;
        }
    }
} finally {
    clients.forEach((client) => client.close());
}

const sourceSha256After = createHash("sha256").update(readFileSync(inputPath)).digest("hex");
if (sourceSha256After !== sourceSha256) {
    throw new Error(`source RWL changed: ${sourceSha256} -> ${sourceSha256After}`);
}
const finalPairwiseAlignment = summarizePairwiseAlignment(siteData);
const summary = {
    inputPath,
    runDir,
    sourceSha256,
    sourceUnchanged: true,
    stopReason,
    referenceMode,
    workerCount,
    maxRounds,
    totalSeries: originalSite.size,
    totalTruthEvents,
    absoluteIdentifiableEvents: totalTruthEvents - Array.from(truthBySeries.values())
        .reduce((sum, years) => (
            sum + years.filter((year) => commonTruthYears.has(year)).length
        ), 0),
    absoluteUnidentifiableYears: [...commonTruthYears].sort((left, right) => left - right),
    recoveredEvents,
    remainingEvents: totalTruthEvents - recoveredEvents,
    initialZeroCount,
    cleanOriginal: {
        cases: cleanBaseline.length,
        strictFalsePositiveRate: cleanBaseline.filter((row) => row.strictEvent !== null).length
            / Math.max(1, cleanBaseline.length),
        reviewFalsePositiveRate: cleanBaseline.filter((row) => row.reviewEvent !== null).length
            / Math.max(1, cleanBaseline.length),
        jointSelectedRate: cleanBaseline.filter((row) => (
            row.jointDecision.event !== null
        )).length / Math.max(1, cleanBaseline.length),
        jointProductionAgreementRate: cleanBaseline.filter((row) => (
            row.jointDecision.productionAgreement === "same"
        )).length / Math.max(1, cleanBaseline.length),
    },
    relativeAlignment: {
        original: summarizePairwiseAlignment(originalSite),
        initial: initialPairwiseAlignment,
        final: finalPairwiseAlignment,
    },
    firstSweepGate,
};
writeFileSync(join(runDir, "run-summary.json"), JSON.stringify(summary, null, 2), "utf8");
console.log(`CO612_REVIEW_BOOTSTRAP_SUMMARY ${JSON.stringify(summary)}`);
if (firstSweepGate && !firstSweepGate.passed) {
    throw new Error(
        `first sweep correct review windows ${firstSweepGate.correctWindows}`
        + ` < required ${firstSweepGate.minimumCorrectWindows}`,
    );
}
