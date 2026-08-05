import { spawn } from "node:child_process";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import type {
    DiagnosisEvent,
    DiagnosisEventType,
} from "@/features/crossdating/diagnosis/types";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    buildSyntheticSite,
    createEndAnchoredFalseRingCase,
    createEndAnchoredMissingRingCase,
    parseRwl,
    valuesToTreeData,
    type FalseRingMode,
    type RwlSeries,
} from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

type UnitEventType = Extract<DiagnosisEventType, "missingRing" | "falseRing">;
type PositionBand = "edge_2_7" | "edge_8_14" | "near_15_29" | "interior_30_plus";
type PositionQuintile = "q1_oldest" | "q2" | "q3_middle" | "q4" | "q5_newest";
type PositionSide = "both" | "older" | "newer";

type CliOptions = {
    inputPath: string;
    outputDir: string;
    runId: string;
    runDir: string;
    workers: number;
    workerIndex: number | null;
    workerCount: number;
    edgeContext: number;
    minEdgeDistance: number;
    maxEdgeDistance: number | null;
    excludeOlderWithinYears: number | null;
    positionSide: PositionSide;
    seriesIds: Set<string> | null;
    eventTypes: UnitEventType[];
    maxCases: number | null;
    falseMode: FalseRingMode;
    statsOnly: boolean;
    resume: boolean;
    aggregateOnly: boolean;
};

type TargetPlan = {
    targetIndex: number;
    target: RwlSeries;
    baseSite: RwlSiteData;
    referenceCount: number;
    years: number[];
    skippedNearZero: number;
};

type EventPreview = {
    type: DiagnosisEventType;
    startYear: number;
    endYear: number;
    width: number;
    topYear: number | null;
    shiftYears: number | null;
    lagBefore: number | null;
    lagAfter: number | null;
    score: number;
    algorithmSources: string[];
    evidenceYears: Record<string, number>;
    evidenceMetrics: Record<string, number>;
};

type CaseRow = {
    caseId: string;
    seriesId: string;
    eventType: UnitEventType;
    truthYear: number;
    falseMode: FalseRingMode | null;
    seriesStartYear: number;
    seriesEndYear: number;
    seriesLength: number;
    referenceCount: number;
    edgeDistance: number;
    positionBand: PositionBand;
    positionQuintile: PositionQuintile;
    normalizedPosition: number;
    baselineFlagged: boolean;
    baselineEvents: EventPreview[];
    elapsedMs: number;
    error: string | null;
    predictionCount: number;
    predictions: EventPreview[];
    anyResponse: boolean;
    primaryType: DiagnosisEventType | null;
    primaryOperationCorrect: boolean;
    primaryWindowCovered: boolean;
    typedResponse: boolean;
    typedWindowCovered: boolean;
    typedWindowStart: number | null;
    typedWindowEnd: number | null;
    typedWindowWidth: number | null;
    typedTopYear: number | null;
    typedTruthRank: number | null;
    typedTop1Exact: boolean;
    typedTop1WithinOne: boolean;
    missDistance: number | null;
    missSide: "older" | "newer" | null;
};

type PreparedBenchmark = {
    sourceSeriesCount: number;
    plans: TargetPlan[];
    skippedSeries: Array<{ seriesId: string; reason: string }>;
    totalPositions: number;
    totalCases: number;
    skippedNearZero: number;
};

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const viteNodePath = join(repoRoot, "node_modules", "vite-node", "vite-node.mjs");
const DEFAULT_INPUT = "D:/软件测试/ZSL/crossdated.rwl";
const DEFAULT_OUTPUT = "D:/软件测试/ZSL/window-coverage-results";

const rawArgs = process.argv.slice(2);

const argumentValue = (name: string): string | null => {
    const index = rawArgs.indexOf(name);
    return index >= 0 && index + 1 < rawArgs.length ? rawArgs[index + 1] : null;
};

const integerArgument = (name: string, fallback: number): number => {
    const raw = argumentValue(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
    return value;
};

const commaSeparatedArgument = (name: string): string[] => (
    (argumentValue(name) ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
);

const timestampId = () => new Date().toISOString().replace(/[:.]/g, "-");

const options: CliOptions = (() => {
    const runId = argumentValue("--run-id") ?? timestampId();
    const outputDir = resolve(argumentValue("--output-dir") ?? DEFAULT_OUTPUT);
    const maxCasesRaw = argumentValue("--max-cases");
    const maxEdgeDistanceRaw = argumentValue("--max-edge-distance");
    const excludeOlderWithinRaw = argumentValue("--exclude-older-within");
    const falseMode = (argumentValue("--false-mode") ?? "splitLike") as FalseRingMode;
    const positionSide = (argumentValue("--side") ?? "both") as PositionSide;
    const seriesIds = commaSeparatedArgument("--series");
    const eventTypeArgument = argumentValue("--event-type") ?? "both";
    if (!["average", "moderate", "splitLike"].includes(falseMode)) {
        throw new Error("--false-mode must be average, moderate, or splitLike");
    }
    if (!["both", "older", "newer"].includes(positionSide)) {
        throw new Error("--side must be both, older, or newer");
    }
    if (!["both", "missingRing", "falseRing"].includes(eventTypeArgument)) {
        throw new Error("--event-type must be both, missingRing, or falseRing");
    }
    return {
        inputPath: resolve(argumentValue("--input") ?? DEFAULT_INPUT),
        outputDir,
        runId,
        runDir: resolve(argumentValue("--run-dir") ?? join(outputDir, runId)),
        workers: Math.max(
            1,
            integerArgument(
                "--workers",
                Math.min(6, Math.max(1, availableParallelism() - 1)),
            ),
        ),
        workerIndex: rawArgs.includes("--worker-index")
            ? integerArgument("--worker-index", 0)
            : null,
        workerCount: Math.max(1, integerArgument("--worker-count", 1)),
        edgeContext: Math.max(2, integerArgument("--edge-context", 2)),
        minEdgeDistance: Math.max(0, integerArgument("--min-edge-distance", 0)),
        maxEdgeDistance: maxEdgeDistanceRaw === null
            ? null
            : Math.max(0, integerArgument("--max-edge-distance", 0)),
        excludeOlderWithinYears: excludeOlderWithinRaw === null
            ? null
            : Math.max(0, integerArgument("--exclude-older-within", 0)),
        positionSide,
        seriesIds: seriesIds.length > 0 ? new Set(seriesIds) : null,
        eventTypes: eventTypeArgument === "both"
            ? ["missingRing", "falseRing"]
            : [eventTypeArgument as UnitEventType],
        maxCases: maxCasesRaw === null ? null : Math.max(1, Number(maxCasesRaw)),
        falseMode,
        statsOnly: rawArgs.includes("--stats-only"),
        resume: rawArgs.includes("--resume"),
        aggregateOnly: rawArgs.includes("--aggregate-only"),
    };
})();

const positionBand = (edgeDistance: number): PositionBand => {
    if (edgeDistance <= 7) return "edge_2_7";
    if (edgeDistance <= 14) return "edge_8_14";
    if (edgeDistance <= 29) return "near_15_29";
    return "interior_30_plus";
};

const positionQuintile = (
    year: number,
    startYear: number,
    endYear: number,
): PositionQuintile => {
    const normalized = (year - startYear) / Math.max(1, endYear - startYear);
    if (normalized < 0.2) return "q1_oldest";
    if (normalized < 0.4) return "q2";
    if (normalized < 0.6) return "q3_middle";
    if (normalized < 0.8) return "q4";
    return "q5_newest";
};

const previewEvent = (event: DiagnosisEvent): EventPreview => {
    const evidenceYears: Record<string, number> = {};
    const evidenceMetrics: Record<string, number> = {};
    event.evidence.notes.forEach((note) => {
        const match = note.match(/^([a-zA-Z0-9_]+_year)=(-?\d+)$/);
        if (match) evidenceYears[match[1]] = Number(match[2]);
        const metric = note.match(/^([a-zA-Z0-9_]+)=(-?\d+(?:\.\d+)?)$/);
        if (metric) evidenceMetrics[metric[1]] = Number(metric[2]);
    });
    return {
        type: event.eventType,
        startYear: event.startYear,
        endYear: event.endYear,
        width: event.endYear - event.startYear + 1,
        topYear: event.rankedYears[0]?.year ?? null,
        shiftYears: event.shiftYears ?? null,
        lagBefore: event.evidence.lagBefore,
        lagAfter: event.evidence.lagAfter,
        score: event.evidence.score,
        algorithmSources: event.evidence.algorithmSources,
        evidenceYears,
        evidenceMetrics,
    };
};

const prepareBenchmark = (): PreparedBenchmark => {
    if (!existsSync(options.inputPath)) {
        throw new Error(`RWL input not found: ${options.inputPath}`);
    }
    const source = parseRwl(readFileSync(options.inputPath, "utf8"));
    const plans: TargetPlan[] = [];
    const skippedSeries: Array<{ seriesId: string; reason: string }> = [];
    let skippedNearZero = 0;

    Array.from(source.values())
        .sort((left, right) => left.id.localeCompare(right.id))
        .forEach((target, targetIndex) => {
            if (options.seriesIds && !options.seriesIds.has(target.id)) return;
            const built = buildSyntheticSite(source, target.id, target.valuesByYear, {
                minReferences: 5,
                minOverlap: 80,
                maxReferences: 24,
            });
            if (!built.site) {
                skippedSeries.push({
                    seriesId: target.id,
                    reason: built.skipReason ?? "no eligible leave-one-out reference",
                });
                return;
            }
            const years: number[] = [];
            let targetSkippedNearZero = 0;
            for (
                let year = target.startYear + options.edgeContext;
                year <= target.endYear - options.edgeContext;
                year += 1
            ) {
                if (!target.valuesByYear.has(year)) continue;
                const olderDistance = year - target.startYear;
                const newerDistance = target.endYear - year;
                const distance = Math.min(olderDistance, newerDistance);
                if (
                    options.excludeOlderWithinYears !== null
                    && olderDistance <= options.excludeOlderWithinYears
                ) continue;
                if (distance < options.minEdgeDistance) continue;
                if (
                    options.maxEdgeDistance !== null
                    && distance > options.maxEdgeDistance
                ) continue;
                if (options.positionSide === "older" && olderDistance > newerDistance) continue;
                if (options.positionSide === "newer" && newerDistance > olderDistance) continue;
                let zeroNearby = false;
                for (let offset = -2; offset <= 2; offset += 1) {
                    if (target.valuesByYear.get(year + offset) === 0) {
                        zeroNearby = true;
                        break;
                    }
                }
                if (zeroNearby) {
                    targetSkippedNearZero += 1;
                    continue;
                }
                years.push(year);
            }
            skippedNearZero += targetSkippedNearZero;
            plans.push({
                targetIndex,
                target,
                baseSite: built.site,
                referenceCount: built.referenceIds.length,
                years,
                skippedNearZero: targetSkippedNearZero,
            });
        });

    const totalPositions = plans.reduce((sum, plan) => sum + plan.years.length, 0);
    return {
        sourceSeriesCount: source.size,
        plans,
        skippedSeries,
        totalPositions,
        totalCases: totalPositions * options.eventTypes.length,
        skippedNearZero,
    };
};

const cappedCaseCount = (prepared: PreparedBenchmark) => (
    options.maxCases === null
        ? prepared.totalCases
        : Math.min(prepared.totalCases, options.maxCases)
);

const caseIsWithinCap = (ordinal: number) => (
    options.maxCases === null || ordinal < options.maxCases
);

const caseIdFor = (
    target: RwlSeries,
    eventType: UnitEventType,
    truthYear: number,
) => `${target.id}|${eventType}|${truthYear}|${
    eventType === "falseRing" ? options.falseMode : "none"
}`;

const executeCase = (
    plan: TargetPlan,
    truthYear: number,
    eventType: UnitEventType,
    baselineEvents: EventPreview[],
): CaseRow => {
    const { target } = plan;
    const edgeDistance = Math.min(
        truthYear - target.startYear,
        target.endYear - truthYear,
    );
    const base = {
        caseId: caseIdFor(target, eventType, truthYear),
        seriesId: target.id,
        eventType,
        truthYear,
        falseMode: eventType === "falseRing" ? options.falseMode : null,
        seriesStartYear: target.startYear,
        seriesEndYear: target.endYear,
        seriesLength: target.length,
        referenceCount: plan.referenceCount,
        edgeDistance,
        positionBand: positionBand(edgeDistance),
        positionQuintile: positionQuintile(
            truthYear,
            target.startYear,
            target.endYear,
        ),
        normalizedPosition: (truthYear - target.startYear)
            / Math.max(1, target.endYear - target.startYear),
        baselineFlagged: baselineEvents.length > 0,
        baselineEvents,
    };
    const started = performance.now();

    try {
        const corrupted = eventType === "missingRing"
            ? createEndAnchoredMissingRingCase(target, truthYear).corrupted
            : createEndAnchoredFalseRingCase(
                target,
                truthYear,
                options.falseMode,
            ).corrupted;
        const site = new Map(plan.baseSite);
        site.set(target.id, valuesToTreeData(corrupted));
        const diagnosis = diagnoseCrossdating(site, {
            targetTrees: [target.id],
            referenceConfig: null,
        });
        const predictions = diagnosis.events.filter((event) => (
            event.seriesId === target.id
        ));
        const primary = predictions[0] ?? null;
        const typed = predictions.find((event) => event.eventType === eventType) ?? null;
        const typedWindowCovered = typed !== null
            && truthYear >= typed.startYear
            && truthYear <= typed.endYear;
        const missDistance = typed === null || typedWindowCovered
            ? null
            : truthYear < typed.startYear
                ? typed.startYear - truthYear
                : truthYear - typed.endYear;
        const truthRank = typed?.rankedYears.find((row) => row.year === truthYear)?.rank
            ?? null;
        const typedTopYear = typed?.rankedYears[0]?.year ?? null;

        return {
            ...base,
            elapsedMs: performance.now() - started,
            error: null,
            predictionCount: predictions.length,
            predictions: predictions.map(previewEvent),
            anyResponse: primary !== null,
            primaryType: primary?.eventType ?? null,
            primaryOperationCorrect: primary?.eventType === eventType,
            primaryWindowCovered: primary?.eventType === eventType
                && truthYear >= primary.startYear
                && truthYear <= primary.endYear,
            typedResponse: typed !== null,
            typedWindowCovered,
            typedWindowStart: typed?.startYear ?? null,
            typedWindowEnd: typed?.endYear ?? null,
            typedWindowWidth: typed === null
                ? null
                : typed.endYear - typed.startYear + 1,
            typedTopYear,
            typedTruthRank: truthRank,
            typedTop1Exact: typedTopYear === truthYear,
            typedTop1WithinOne: typedTopYear !== null
                && Math.abs(typedTopYear - truthYear) <= 1,
            missDistance,
            missSide: typed === null || typedWindowCovered
                ? null
                : truthYear < typed.startYear ? "older" : "newer",
        };
    } catch (error) {
        return {
            ...base,
            elapsedMs: performance.now() - started,
            error: error instanceof Error ? error.stack ?? error.message : String(error),
            predictionCount: 0,
            predictions: [],
            anyResponse: false,
            primaryType: null,
            primaryOperationCorrect: false,
            primaryWindowCovered: false,
            typedResponse: false,
            typedWindowCovered: false,
            typedWindowStart: null,
            typedWindowEnd: null,
            typedWindowWidth: null,
            typedTopYear: null,
            typedTruthRank: null,
            typedTop1Exact: false,
            typedTop1WithinOne: false,
            missDistance: null,
            missSide: null,
        };
    }
};

const runWorker = (prepared: PreparedBenchmark): void => {
    if (options.workerIndex === null) throw new Error("worker index is required");
    mkdirSync(options.runDir, { recursive: true });
    const outputPath = join(
        options.runDir,
        `cases.worker-${options.workerIndex}-of-${options.workerCount}.jsonl`,
    );
    const completedCaseIds = options.resume && existsSync(outputPath)
        ? new Set(
            readFileSync(outputPath, "utf8")
                .split(/\r?\n/)
                .filter(Boolean)
                .map((line) => (JSON.parse(line) as CaseRow).caseId),
        )
        : new Set<string>();
    if (!options.resume) writeFileSync(outputPath, "", "utf8");
    let ordinal = 0;
    let completed = 0;
    let buffer = "";

    const flush = () => {
        if (buffer.length === 0) return;
        appendFileSync(outputPath, buffer, "utf8");
        buffer = "";
    };

    for (const plan of prepared.plans) {
        const owned = plan.targetIndex % options.workerCount === options.workerIndex;
        const firstOrdinal = ordinal;
        const planCaseCount = plan.years.length * options.eventTypes.length;
        ordinal += planCaseCount;
        if (!owned || !caseIsWithinCap(firstOrdinal)) continue;

        let baselineEvents: EventPreview[] = [];
        try {
            baselineEvents = diagnoseCrossdating(plan.baseSite, {
                targetTrees: [plan.target.id],
                referenceConfig: null,
            }).events
                .filter((event) => event.seriesId === plan.target.id)
                .map(previewEvent);
        } catch (error) {
            console.error(
                `baseline ${plan.target.id} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        let planOrdinal = firstOrdinal;
        for (const year of plan.years) {
            for (const eventType of options.eventTypes) {
                const currentOrdinal = planOrdinal;
                planOrdinal += 1;
                if (!caseIsWithinCap(currentOrdinal)) continue;
                if (completedCaseIds.has(caseIdFor(plan.target, eventType, year))) {
                    continue;
                }
                const row = executeCase(plan, year, eventType, baselineEvents);
                buffer += `${JSON.stringify(row)}\n`;
                completed += 1;
                if (completed % 10 === 0) flush();
                if (completed % 100 === 0) {
                    console.log(
                        `progress cases=${completed} series=${plan.target.id} year=${year}`,
                    );
                }
            }
        }
    }
    flush();
    console.log(`complete cases=${completed} output=${outputPath}`);
};

const rate = (numerator: number, denominator: number) => (
    denominator === 0 ? 0 : numerator / denominator
);

const quantile = (values: number[], probability: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) * probability)];
};

const histogram = (values: Array<string | number | null>) => Object.fromEntries(
    Array.from(new Set(values.map((value) => String(value))))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
        .map((value) => [value, values.filter((candidate) => String(candidate) === value).length]),
);

const summarizeRows = (rows: CaseRow[]) => {
    const anyResponses = rows.filter((row) => row.anyResponse);
    const primaryCorrect = rows.filter((row) => row.primaryOperationCorrect);
    const primaryCovered = rows.filter((row) => row.primaryWindowCovered);
    const typedResponses = rows.filter((row) => row.typedResponse);
    const typedCovered = rows.filter((row) => row.typedWindowCovered);
    const typedMisses = typedResponses.filter((row) => !row.typedWindowCovered);
    const widths = typedResponses.flatMap((row) => (
        row.typedWindowWidth === null ? [] : [row.typedWindowWidth]
    ));
    const elapsed = rows.map((row) => row.elapsedMs);
    const topErrors = typedResponses.flatMap((row) => (
        row.typedTopYear === null ? [] : [Math.abs(row.typedTopYear - row.truthYear)]
    ));
    return {
        cases: rows.length,
        errors: rows.filter((row) => row.error !== null).length,
        anyResponseRate: rate(anyResponses.length, rows.length),
        refusalRate: rate(rows.length - anyResponses.length, rows.length),
        primaryOperationAccuracy: rate(primaryCorrect.length, rows.length),
        strictPrimaryWindowCoverage: rate(primaryCovered.length, rows.length),
        correctTypeResponseRate: rate(typedResponses.length, rows.length),
        correctTypeWindowCoverage: rate(typedCovered.length, rows.length),
        windowCoverageGivenTypeResponse: rate(typedCovered.length, typedResponses.length),
        coverageAfterOneYearPadding: rate(
            typedCovered.length
                + typedMisses.filter((row) => row.missDistance === 1).length,
            rows.length,
        ),
        top1ExactAll: rate(rows.filter((row) => row.typedTop1Exact).length, rows.length),
        top1ExactCovered: rate(
            typedCovered.filter((row) => row.typedTop1Exact).length,
            typedCovered.length,
        ),
        top1WithinOneAll: rate(
            rows.filter((row) => row.typedTop1WithinOne).length,
            rows.length,
        ),
        medianWindowWidth: quantile(widths, 0.5),
        p90WindowWidth: quantile(widths, 0.9),
        widthHistogram: histogram(widths),
        medianAbsoluteTopYearError: quantile(topErrors, 0.5),
        p90AbsoluteTopYearError: quantile(topErrors, 0.9),
        missDistanceHistogram: histogram(typedMisses.map((row) => row.missDistance)),
        missSideHistogram: histogram(typedMisses.map((row) => row.missSide)),
        primaryTypeHistogram: histogram(rows.map((row) => row.primaryType)),
        medianElapsedMs: quantile(elapsed, 0.5),
        p90ElapsedMs: quantile(elapsed, 0.9),
    };
};

const groupSummary = <K extends string>(
    rows: CaseRow[],
    key: (row: CaseRow) => K,
) => Object.fromEntries(
    Array.from(new Set(rows.map(key)))
        .sort()
        .map((group) => [group, summarizeRows(rows.filter((row) => key(row) === group))]),
);

const nestedGroupSummary = <Outer extends string, Inner extends string>(
    rows: CaseRow[],
    outerKey: (row: CaseRow) => Outer,
    innerKey: (row: CaseRow) => Inner,
) => Object.fromEntries(
    Array.from(new Set(rows.map(outerKey)))
        .sort()
        .map((outer) => [
            outer,
            groupSummary(rows.filter((row) => outerKey(row) === outer), innerKey),
        ]),
);

const csvEscape = (value: unknown): string => {
    const text = value === null || value === undefined
        ? ""
        : typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const writeCsv = (path: string, rows: CaseRow[]): void => {
    const columns: Array<keyof CaseRow> = [
        "caseId",
        "seriesId",
        "eventType",
        "truthYear",
        "falseMode",
        "seriesStartYear",
        "seriesEndYear",
        "seriesLength",
        "referenceCount",
        "edgeDistance",
        "positionBand",
        "positionQuintile",
        "normalizedPosition",
        "baselineFlagged",
        "elapsedMs",
        "error",
        "predictionCount",
        "anyResponse",
        "primaryType",
        "primaryOperationCorrect",
        "primaryWindowCovered",
        "typedResponse",
        "typedWindowCovered",
        "typedWindowStart",
        "typedWindowEnd",
        "typedWindowWidth",
        "typedTopYear",
        "typedTruthRank",
        "typedTop1Exact",
        "typedTop1WithinOne",
        "missDistance",
        "missSide",
        "baselineEvents",
        "predictions",
    ];
    const lines = [
        columns.join(","),
        ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
    ];
    writeFileSync(path, `${lines.join("\r\n")}\r\n`, "utf8");
};

const aggregate = (prepared: PreparedBenchmark) => {
    const shardFiles = readdirSync(options.runDir)
        .filter((name) => /^cases\.worker-\d+-of-\d+\.jsonl$/.test(name))
        .sort();
    const rows = shardFiles.flatMap((name) => (
        readFileSync(join(options.runDir, name), "utf8")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as CaseRow)
    ));
    rows.sort((left, right) => (
        left.seriesId.localeCompare(right.seriesId)
        || left.truthYear - right.truthYear
        || left.eventType.localeCompare(right.eventType)
    ));
    const duplicateIds = rows.length - new Set(rows.map((row) => row.caseId)).size;
    const expectedCases = cappedCaseCount(prepared);
    const summary = {
        generatedAt: new Date().toISOString(),
        inputPath: options.inputPath,
        runId: options.runId,
        configuration: {
            eventTypes: options.eventTypes,
            falseRingMode: options.falseMode,
            edgeContextYears: options.edgeContext,
            minEdgeDistance: options.minEdgeDistance,
            maxEdgeDistance: options.maxEdgeDistance,
            excludeOlderWithinYears: options.excludeOlderWithinYears,
            positionSide: options.positionSide,
            seriesIds: options.seriesIds ? [...options.seriesIds] : null,
            minReferences: 5,
            minReferenceOverlapYears: 80,
            maxReferences: 24,
            referenceMode: "leave-one-out internal master",
            locationAlternativesCounted: false,
            workers: options.workers,
            maxCases: options.maxCases,
        },
        source: {
            series: prepared.sourceSeriesCount,
            eligibleSeries: prepared.plans.length,
            skippedSeries: prepared.skippedSeries,
            eligiblePositions: prepared.totalPositions,
            skippedPositionsNearExistingZero: prepared.skippedNearZero,
            expectedCases,
            completedCases: rows.length,
            duplicateCaseIds: duplicateIds,
        },
        overall: summarizeRows(rows),
        baselineCleanOnly: summarizeRows(rows.filter((row) => !row.baselineFlagged)),
        byEventType: groupSummary(rows, (row) => row.eventType),
        byPositionBand: groupSummary(rows, (row) => row.positionBand),
        byPositionQuintile: groupSummary(rows, (row) => row.positionQuintile),
        baselineCleanByEventType: groupSummary(
            rows.filter((row) => !row.baselineFlagged),
            (row) => row.eventType,
        ),
        byEventTypeAndPositionBand: nestedGroupSummary(
            rows,
            (row) => row.eventType,
            (row) => row.positionBand,
        ),
        byEventTypeAndPositionQuintile: nestedGroupSummary(
            rows,
            (row) => row.eventType,
            (row) => row.positionQuintile,
        ),
        bySeries: groupSummary(rows, (row) => row.seriesId),
        examples: {
            errors: rows.filter((row) => row.error !== null).slice(0, 20),
            wrongPrimaryOperation: rows.filter((row) => (
                row.anyResponse && !row.primaryOperationCorrect
            )).slice(0, 20),
            missingRingWindowMisses: rows.filter((row) => (
                row.eventType === "missingRing"
                && row.typedResponse
                && !row.typedWindowCovered
            )).slice(0, 20),
            falseRingWindowMisses: rows.filter((row) => (
                row.eventType === "falseRing"
                && row.typedResponse
                && !row.typedWindowCovered
            )).slice(0, 20),
        },
    };
    const summaryPath = join(options.runDir, "summary.json");
    const csvPath = join(options.runDir, "cases.csv");
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    writeCsv(csvPath, rows);
    console.log(`RUN_SUMMARY ${JSON.stringify({
        source: summary.source,
        overall: summary.overall,
        baselineCleanOnly: summary.baselineCleanOnly,
        byEventType: summary.byEventType,
        byPositionBand: summary.byPositionBand,
        byPositionQuintile: summary.byPositionQuintile,
    })}`);
    console.log(`summary=${summaryPath}`);
    console.log(`cases=${csvPath}`);
    if (rows.length !== expectedCases || duplicateIds > 0) {
        throw new Error(
            `incomplete aggregate: expected=${expectedCases}, rows=${rows.length}, duplicates=${duplicateIds}`,
        );
    }
    return summary;
};

const pipeLines = (
    stream: NodeJS.ReadableStream,
    prefix: string,
    sink: "log" | "error",
) => {
    let pending = "";
    stream.on("data", (chunk) => {
        pending += String(chunk);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        lines.filter(Boolean).forEach((line) => console[sink](`${prefix}${line}`));
    });
    stream.on("end", () => {
        if (pending) console[sink](`${prefix}${pending}`);
    });
};

const runParent = async (prepared: PreparedBenchmark) => {
    if (!options.resume) rmSync(options.runDir, { force: true, recursive: true });
    mkdirSync(options.runDir, { recursive: true });
    const commonArgs = [
        "--input", options.inputPath,
        "--output-dir", options.outputDir,
        "--run-id", options.runId,
        "--run-dir", options.runDir,
        "--worker-count", String(options.workers),
        "--edge-context", String(options.edgeContext),
        "--min-edge-distance", String(options.minEdgeDistance),
        "--false-mode", options.falseMode,
        "--side", options.positionSide,
        "--event-type", options.eventTypes.length === 2
            ? "both"
            : options.eventTypes[0],
        ...(options.maxEdgeDistance === null
            ? []
            : ["--max-edge-distance", String(options.maxEdgeDistance)]),
        ...(options.excludeOlderWithinYears === null
            ? []
            : [
                "--exclude-older-within",
                String(options.excludeOlderWithinYears),
            ]),
        ...(options.seriesIds === null
            ? []
            : ["--series", [...options.seriesIds].join(",")]),
        ...(options.resume ? ["--resume"] : []),
        ...(options.maxCases === null
            ? []
            : ["--max-cases", String(options.maxCases)]),
    ];
    await Promise.all(Array.from({ length: options.workers }, (_, workerIndex) => (
        new Promise<void>((resolvePromise, rejectPromise) => {
            const child = spawn(process.execPath, [
                viteNodePath,
                scriptPath,
                "--",
                ...commonArgs,
                "--worker-index",
                String(workerIndex),
            ], {
                cwd: repoRoot,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
            pipeLines(child.stdout, `[worker ${workerIndex}] `, "log");
            pipeLines(child.stderr, `[worker ${workerIndex}] `, "error");
            child.on("error", rejectPromise);
            child.on("exit", (code) => {
                if (code === 0) resolvePromise();
                else rejectPromise(new Error(`worker ${workerIndex} exited ${code}`));
            });
        })
    )));
    return aggregate(prepared);
};

const main = async () => {
    const prepared = prepareBenchmark();
    const stats = {
        inputPath: options.inputPath,
        sourceSeries: prepared.sourceSeriesCount,
        eligibleSeries: prepared.plans.length,
        skippedSeries: prepared.skippedSeries,
        eligiblePositions: prepared.totalPositions,
        skippedPositionsNearExistingZero: prepared.skippedNearZero,
        eventCases: cappedCaseCount(prepared),
        edgeContextYears: options.edgeContext,
        minEdgeDistance: options.minEdgeDistance,
        maxEdgeDistance: options.maxEdgeDistance,
        excludeOlderWithinYears: options.excludeOlderWithinYears,
        positionSide: options.positionSide,
        eventTypes: options.eventTypes,
        falseRingMode: options.falseMode,
    };
    console.log(`BENCHMARK_STATS ${JSON.stringify(stats)}`);
    if (options.statsOnly) return;
    if (options.aggregateOnly) {
        aggregate(prepared);
        return;
    }
    if (options.workerIndex !== null) {
        runWorker(prepared);
        return;
    }
    await runParent(prepared);
};

await main();
