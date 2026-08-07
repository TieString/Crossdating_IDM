import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
    extractPart6FlaggedASeriesIds,
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import { parseRwl } from "@/features/crossdating/diagnosis/__tests__/rdmFixture";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis/types";
import {
    createCofechaMasterReferenceConfig,
    createReferenceSeriesConfig,
} from "@/features/crossdating/reference";
import type { RwlSeries, RwlSiteData } from "@/features/rwl/types";

type MatchedObservation = {
    rawYear: number;
    crossdatedYear: number;
    value: number;
    offsetYears: number;
};

type OffsetRun = {
    offsetYears: number;
    observationCount: number;
    rawStartYear: number;
    rawEndYear: number;
    crossdatedStartYear: number;
    crossdatedEndYear: number;
};

type OperationTransition = {
    olderOffsetYears: number;
    newerOffsetYears: number;
    shiftYears: number;
    firstFixedYear: number;
    operationType: "missingRing" | "falseRing" | "partialMove" | "offsetTransition";
};

const valueFor = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
};

const rawPath = resolve(valueFor("--raw") ?? "D:/软件测试/ZSL/RAW.rwl");
const crossdatedPath = resolve(
    valueFor("--crossdated") ?? "D:/软件测试/ZSL/crossdated.rwl",
);
const rawOutPath = resolve(valueFor("--raw-out") ?? "D:/软件测试/ZSL/RAW.OUT");
const outputPath = resolve(
    valueFor("--output")
    ?? "D:/软件测试/ZSL/window-coverage-results/zsl-operation-truth.json",
);

const sha256 = (path: string): string => createHash("sha256")
    .update(readFileSync(path))
    .digest("hex");

const entries = (series: RwlSeries, includeZeros: boolean): Array<[number, number]> => (
    Array.from(series.valuesByYear.entries())
        .filter(([, value]) => value !== -9999 && (includeZeros || value !== 0))
        .sort((left, right) => left[0] - right[0])
);

const alignObservations = (
    raw: RwlSeries,
    crossdated: RwlSeries,
): {
    matched: MatchedObservation[];
    unmatchedRaw: Array<{ rawYear: number; value: number }>;
    crossdatedZeroYears: number[];
    reconstructionMatchesRaw: boolean;
} => {
    const rawEntries = entries(raw, true);
    const crossdatedEntries = entries(crossdated, false);
    const rowCount = rawEntries.length;
    const columnCount = crossdatedEntries.length;
    const dp = Array.from(
        { length: rowCount + 1 },
        () => new Uint16Array(columnCount + 1),
    );
    for (let row = 1; row <= rowCount; row += 1) {
        for (let column = 1; column <= columnCount; column += 1) {
            dp[row][column] = rawEntries[row - 1][1] === crossdatedEntries[column - 1][1]
                ? dp[row - 1][column - 1] + 1
                : Math.max(dp[row - 1][column], dp[row][column - 1]);
        }
    }

    const matchedRaw = new Array(rowCount).fill(false);
    const matched: MatchedObservation[] = [];
    let row = rowCount;
    let column = columnCount;
    while (row > 0 && column > 0) {
        const [rawYear, rawValue] = rawEntries[row - 1];
        const [crossdatedYear, crossdatedValue] = crossdatedEntries[column - 1];
        if (rawValue === crossdatedValue
            && dp[row][column] === dp[row - 1][column - 1] + 1) {
            matchedRaw[row - 1] = true;
            matched.push({
                rawYear,
                crossdatedYear,
                value: rawValue,
                offsetYears: crossdatedYear - rawYear,
            });
            row -= 1;
            column -= 1;
        } else if (dp[row - 1][column] >= dp[row][column - 1]) {
            row -= 1;
        } else {
            column -= 1;
        }
    }
    matched.reverse();

    return {
        matched,
        unmatchedRaw: rawEntries
            .filter((_, index) => !matchedRaw[index])
            .map(([rawYear, value]) => ({ rawYear, value })),
        crossdatedZeroYears: entries(crossdated, true)
            .filter(([, value]) => value === 0)
            .map(([year]) => year),
        reconstructionMatchesRaw: dp[rowCount][columnCount] === columnCount,
    };
};

const offsetRuns = (matched: readonly MatchedObservation[]): OffsetRun[] => {
    const runs: OffsetRun[] = [];
    matched.forEach((observation) => {
        const current = runs[runs.length - 1];
        if (current?.offsetYears === observation.offsetYears) {
            current.observationCount += 1;
            current.rawEndYear = observation.rawYear;
            current.crossdatedEndYear = observation.crossdatedYear;
            return;
        }
        runs.push({
            offsetYears: observation.offsetYears,
            observationCount: 1,
            rawStartYear: observation.rawYear,
            rawEndYear: observation.rawYear,
            crossdatedStartYear: observation.crossdatedYear,
            crossdatedEndYear: observation.crossdatedYear,
        });
    });
    return runs;
};

const transitionsFor = (runs: readonly OffsetRun[]): OperationTransition[] => (
    runs.slice(0, -1).map((older, index) => {
        const newer = runs[index + 1];
        const shiftYears = older.offsetYears - newer.offsetYears;
        return {
            olderOffsetYears: older.offsetYears,
            newerOffsetYears: newer.offsetYears,
            shiftYears,
            firstFixedYear: newer.crossdatedStartYear,
            operationType: shiftYears === -1
                ? "missingRing"
                : shiftYears === 1
                    ? "falseRing"
                    : shiftYears < -1
                        ? "partialMove"
                        : "offsetTransition",
        };
    })
);

const toSiteData = (input: Map<string, RwlSeries>): RwlSiteData => new Map(
    Array.from(input, ([seriesId, series]) => [
        seriesId,
        new Map(series.valuesByYear),
    ]),
);

const eventSummary = (event: DiagnosisEvent | null) => event ? {
    eventType: event.eventType,
    shiftYears: event.shiftYears ?? null,
    startYear: event.startYear,
    endYear: event.endYear,
    topYear: event.rankedYears[0]?.year ?? null,
    confidenceLevel: event.confidenceLevel,
    algorithmSources: event.evidence.algorithmSources,
    lagBefore: event.evidence.lagBefore,
    lagAfter: event.evidence.lagAfter,
    score: event.evidence.score,
    scoreMargin: event.evidence.scoreMargin,
    notes: event.evidence.notes,
} : null;

type ExpectedOperation = {
    eventType: "missingRing" | "falseRing" | "partialMove" | "wholeSeriesMove";
    shiftYears: number;
    firstFixedYear: number | null;
};

const expectedFrontier = (row: {
    wholeSeriesMove: { shiftYears: number } | null;
    transitions: OperationTransition[];
}): ExpectedOperation | null => {
    if (row.wholeSeriesMove) {
        return {
            eventType: "wholeSeriesMove",
            shiftYears: row.wholeSeriesMove.shiftYears,
            firstFixedYear: null,
        };
    }
    const transition = row.transitions.at(-1);
    if (!transition || transition.operationType === "offsetTransition") return null;
    return {
        eventType: transition.operationType,
        shiftYears: transition.shiftYears,
        firstFixedYear: transition.firstFixedYear,
    };
};

const matchesExpectedOperation = (
    predicted: DiagnosisEvent | null,
    expected: ExpectedOperation | null,
): boolean => {
    if (!expected) return predicted === null;
    if (!predicted || predicted.eventType !== expected.eventType) return false;
    if (expected.eventType === "missingRing") return true;
    if (expected.eventType === "falseRing") return true;
    if (expected.eventType === "wholeSeriesMove") {
        return predicted.evidence.lagBefore === expected.shiftYears;
    }
    return predicted.shiftYears === expected.shiftYears;
};

const rawText = readFileSync(rawPath, "utf8");
const crossdatedText = readFileSync(crossdatedPath, "utf8");
const rawOutText = readFileSync(rawOutPath, "utf8");
const raw = parseRwl(rawText);
const crossdated = parseRwl(crossdatedText);
const sharedIds = [...raw.keys()]
    .filter((seriesId) => crossdated.has(seriesId))
    .sort();

const series = sharedIds.map((seriesId) => {
    const rawSeries = raw.get(seriesId)!;
    const crossdatedSeries = crossdated.get(seriesId)!;
    const alignment = alignObservations(rawSeries, crossdatedSeries);
    const runs = offsetRuns(alignment.matched);
    const newerBaselineOffsetYears = runs.at(-1)?.offsetYears ?? null;
    const row = {
        seriesId,
        rawRange: [rawSeries.startYear, rawSeries.endYear],
        crossdatedRange: [crossdatedSeries.startYear, crossdatedSeries.endYear],
        rawObservationCount: entries(rawSeries, true).length,
        crossdatedNonZeroCount: entries(crossdatedSeries, false).length,
        matchedObservationCount: alignment.matched.length,
        reconstructionMatchesRaw: alignment.reconstructionMatchesRaw,
        unmatchedRaw: alignment.unmatchedRaw,
        crossdatedZeroYears: alignment.crossdatedZeroYears,
        offsetRuns: runs,
        newerBaselineOffsetYears,
        wholeSeriesMove: newerBaselineOffsetYears !== null
            && newerBaselineOffsetYears !== 0
            ? { shiftYears: newerBaselineOffsetYears }
            : null,
        transitions: transitionsFor(runs),
    };
    return { ...row, expectedFrontier: expectedFrontier(row) };
});

const rawSite = toSiteData(raw);
const crossdatedSite = toSiteData(crossdated);
const rawParts = splitReportByParts(rawOutText);
const rawResult = parseCofechaResult(rawOutText);
const rawFlaggedIds = extractPart6FlaggedASeriesIds(rawParts.get("PART 6") ?? "");
const rawReferenceConfig = createCofechaMasterReferenceConfig({
    siteData: rawSite,
    flaggedAIds: rawFlaggedIds,
    cofechaRunId: "zsl-raw-operation-audit",
    rwlHash: sha256(rawPath),
    masterDatingSeries: rawResult.masterDatingSeries,
});

const diagnoseMode = (
    mode: "raw-dynamic" | "isolated-crossdated-reference",
    seriesId: string,
): ReturnType<typeof diagnoseCrossdating> => {
    if (mode === "raw-dynamic") {
        return diagnoseCrossdating(rawSite, {
            targetTrees: [seriesId],
            referenceConfig: rawReferenceConfig,
            cofechaText: rawOutText,
            reviewWindowDisplayMode: "review",
            includeEventDecisionAudits: true,
        });
    }
    const site: RwlSiteData = new Map(crossdatedSite);
    site.set(seriesId, new Map(raw.get(seriesId)!.valuesByYear));
    return diagnoseCrossdating(site, {
        targetTrees: [seriesId],
        referenceConfig: createReferenceSeriesConfig(
            sharedIds.filter((candidate) => candidate !== seriesId),
        ),
        cofechaText: rawOutText,
        reviewWindowDisplayMode: "review",
        includeEventDecisionAudits: true,
    });
};

const diagnosisModes = ([
    "raw-dynamic",
    "isolated-crossdated-reference",
] as const).map((mode) => {
    const rows = series.map((truth) => {
        const diagnosis = diagnoseMode(mode, truth.seriesId);
        const predicted = diagnosis.reviewEvents?.[0] ?? null;
        const strict = diagnosis.events[0] ?? null;
        const decision = diagnosis.reviewWindowDecisions?.[0] ?? null;
        const audit = diagnosis.eventDecisionAudits?.[0] ?? null;
        return {
            seriesId: truth.seriesId,
            expected: truth.expectedFrontier,
            predicted: eventSummary(predicted),
            strict: eventSummary(strict),
            operationCorrect: matchesExpectedOperation(predicted, truth.expectedFrontier),
            reviewDecision: decision,
            auditFinalReason: audit?.finalReason ?? null,
            detectedBeforeFusion: audit?.detectedBeforeFusion ?? [],
            detectedAfterFusion: audit?.detectedAfterFusion ?? [],
            finalEvents: audit?.finalEvents ?? [],
        };
    });
    const expectedRows = rows.filter((row) => row.expected !== null);
    const cleanRows = rows.filter((row) => row.expected === null);
    return {
        mode,
        summary: {
            expectedCases: expectedRows.length,
            response: expectedRows.filter((row) => row.predicted !== null).length,
            operationCorrect: expectedRows.filter((row) => row.operationCorrect).length,
            cleanCases: cleanRows.length,
            cleanFalsePositive: cleanRows.filter((row) => row.predicted !== null).length,
        },
        rows,
    };
});

const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    inputs: {
        rawPath,
        rawSha256: sha256(rawPath),
        crossdatedPath,
        crossdatedSha256: sha256(crossdatedPath),
        rawOutPath,
        rawOutSha256: sha256(rawOutPath),
    },
    summary: {
        rawSeries: raw.size,
        crossdatedSeries: crossdated.size,
        sharedSeries: sharedIds.length,
        reconstructionFailures: series.filter((row) => !row.reconstructionMatchesRaw).length,
        wholeSeriesMoveSeries: series.filter((row) => row.wholeSeriesMove !== null).length,
        partialMoveTransitions: series.reduce(
            (sum, row) => sum + row.transitions.filter(
                (transition) => transition.operationType === "partialMove",
            ).length,
            0,
        ),
        missingRingTransitions: series.reduce(
            (sum, row) => sum + row.transitions.filter(
                (transition) => transition.operationType === "missingRing",
            ).length,
            0,
        ),
        falseRingTransitions: series.reduce(
            (sum, row) => sum + row.transitions.filter(
                (transition) => transition.operationType === "falseRing",
            ).length,
            0,
        ),
    },
    series,
    diagnosisModes,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, ...report.summary }, null, 2));
