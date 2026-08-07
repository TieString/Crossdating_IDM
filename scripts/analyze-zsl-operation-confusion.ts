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
import {
    deriveZslSeriesTruth,
    expectedZslFrontier,
    observedEntries,
    type ExpectedZslOperation,
} from "./zsl-operation-truth";

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
const requestedTarget = valueFor("--target");

const sha256 = (path: string): string => createHash("sha256")
    .update(readFileSync(path))
    .digest("hex");

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

const matchesExpectedOperation = (
    predicted: DiagnosisEvent | null,
    expected: ExpectedZslOperation | null,
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
const analyzedIds = requestedTarget
    ? sharedIds.filter((seriesId) => (
        seriesId.trim().toUpperCase() === requestedTarget.trim().toUpperCase()
    ))
    : sharedIds;
if (requestedTarget && analyzedIds.length === 0) {
    throw new Error(`target not shared by RAW/crossdated: ${requestedTarget}`);
}

const series = analyzedIds.map((seriesId) => {
    const rawSeries = raw.get(seriesId)!;
    const crossdatedSeries = crossdated.get(seriesId)!;
    const truth = deriveZslSeriesTruth(rawSeries, crossdatedSeries);
    const row = {
        seriesId,
        rawRange: [rawSeries.startYear, rawSeries.endYear],
        crossdatedRange: [crossdatedSeries.startYear, crossdatedSeries.endYear],
        rawObservationCount: observedEntries(rawSeries, true).length,
        crossdatedNonZeroCount: observedEntries(crossdatedSeries, false).length,
        matchedObservationCount: truth.matched.length,
        reconstructionMatchesRaw: truth.reconstructionMatchesRaw,
        unmatchedRaw: truth.unmatchedRaw,
        crossdatedZeroYears: truth.crossdatedZeroYears,
        offsetRuns: truth.offsetRuns,
        newerBaselineOffsetYears: truth.newerBaselineOffsetYears,
        wholeSeriesMove: truth.wholeSeriesMove,
        transitions: truth.transitions,
    };
    return { ...row, expectedFrontier: expectedZslFrontier(row) };
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
        analyzedSeries: analyzedIds.length,
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
