import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    itrdbDatasetGroup,
    itrdbEndpointStratum,
    itrdbReferenceDepthStratum,
    itrdbSeriesLengthStratum,
} from "@/features/crossdating/diagnosis/__tests__/itrdbValidationProtocol";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis/types";

type Context = {
    file: string;
    datasetGroup?: string;
    target: string;
    year: number;
    seriesLength: number;
    naturalZeroCount: number;
    positionStratum: string;
    signalStrength: number | null;
    referenceCount: number;
    olderContextYears: number;
    newerContextYears: number;
    baselineFlagged?: boolean;
};

type EventOutcome = {
    context: Context;
    eventType: "missingRing" | "falseRing" | "partialMove";
    systemResponded: boolean;
    primaryEventType: DiagnosisEvent["eventType"] | null;
    primaryEventShiftYears: number | null;
    primaryPredictionTopYear: number | null;
    primaryPredictionRange: [number, number] | null;
};

type CleanOutcome = {
    context: Context;
    falsePositive: boolean;
    predictions: number;
};

type Audit = {
    schemaVersion: number;
    fileSplit: string | null;
    files: number;
    splitPoolFiles: number;
    attempted: number;
    excludedBaselineFlaggedCases: number;
    eventCaseOutcomes: EventOutcome[];
    cleanCaseOutcomes: CleanOutcome[];
};

const args = process.argv.slice(2);
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const inputPath = resolve(valueFor("--input") ?? "itrdb-formal-audit.json");
const outputPath = resolve(valueFor("--output") ?? "itrdb-formal-summary.json");
const audit = JSON.parse(readFileSync(inputPath, "utf8")) as Audit;

const percentile = (values: number[], probability: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1)];
};

const summarizeEvents = (rows: EventOutcome[]) => {
    const responded = rows.filter((row) => row.systemResponded);
    const operationCorrect = rows.filter((row) => row.primaryEventType === row.eventType);
    const covered = operationCorrect.filter((row) => (
        row.primaryPredictionRange !== null
        && row.context.year >= row.primaryPredictionRange[0]
        && row.context.year <= row.primaryPredictionRange[1]
    ));
    const widths = operationCorrect.flatMap((row) => row.primaryPredictionRange
        ? [row.primaryPredictionRange[1] - row.primaryPredictionRange[0] + 1]
        : []);
    return {
        cases: rows.length,
        responseRate: responded.length / Math.max(1, rows.length),
        operationAccuracy: operationCorrect.length / Math.max(1, rows.length),
        operationAccuracyAnswered: operationCorrect.length / Math.max(1, responded.length),
        primaryWindowCoverage: covered.length / Math.max(1, rows.length),
        conditionalWindowCoverage: covered.length / Math.max(1, operationCorrect.length),
        top1: operationCorrect.filter((row) => (
            row.primaryPredictionTopYear === row.context.year
        )).length / Math.max(1, rows.length),
        refusalRate: rows.filter((row) => !row.systemResponded).length
            / Math.max(1, rows.length),
        partialMoveMisclassificationRate: rows.filter((row) => (
            row.primaryEventType === "partialMove"
        )).length / Math.max(1, rows.length),
        medianWindowWidth: percentile(widths, 0.5),
        p90WindowWidth: percentile(widths, 0.9),
        operationConfusion: Object.fromEntries(Array.from(new Set(
            rows.map((row) => row.primaryEventType ?? "refusal"),
        )).sort().map((eventType) => [
            eventType,
            rows.filter((row) => (row.primaryEventType ?? "refusal") === eventType).length,
        ])),
    };
};

const summarizeClean = (rows: CleanOutcome[]) => ({
    cases: rows.length,
    falsePositiveRate: rows.filter((row) => row.falsePositive).length
        / Math.max(1, rows.length),
    predictions: rows.reduce((sum, row) => sum + row.predictions, 0),
});

const summarizeGroup = (
    eventRows: EventOutcome[],
    cleanRows: CleanOutcome[],
    predicate: (context: Context) => boolean,
) => ({
    events: summarizeEvents(eventRows.filter((row) => predicate(row.context))),
    clean: summarizeClean(cleanRows.filter((row) => predicate(row.context))),
});

const groupValues = <T>(rows: T[], key: (row: T) => string): string[] => (
    Array.from(new Set(rows.map(key))).sort()
);

const events = audit.eventCaseOutcomes.filter((row) => (
    row.eventType === "missingRing" || row.eventType === "falseRing"
));
const clean = audit.cleanCaseOutcomes;
const datasetGroups = groupValues(events, (row) => (
    row.context.datasetGroup ?? itrdbDatasetGroup(row.context.file)
));
const signalValues = events.flatMap((row) => (
    row.context.signalStrength === null ? [] : [row.context.signalStrength]
)).sort((a, b) => a - b);
const signalCut = (probability: number): number | null => signalValues.length > 0
    ? signalValues[Math.floor((signalValues.length - 1) * probability)]
    : null;
const signalThresholds = { weakMaximum: signalCut(1 / 3), mediumMaximum: signalCut(2 / 3) };
const signalStratum = (context: Context): string => {
    if (context.signalStrength === null
        || signalThresholds.weakMaximum === null
        || signalThresholds.mediumMaximum === null) return "unavailable";
    if (context.signalStrength <= signalThresholds.weakMaximum) return "weak";
    if (context.signalStrength <= signalThresholds.mediumMaximum) return "medium";
    return "strong";
};

const summary = {
    schemaVersion: 1,
    sourceAudit: inputPath,
    fileSplit: audit.fileSplit,
    files: audit.files,
    splitPoolFiles: audit.splitPoolFiles,
    sampledTargets: audit.attempted,
    baselineFlaggedTargets: audit.excludedBaselineFlaggedCases,
    selectionUsesSignal: false,
    overall: summarizeEvents(events),
    missingRing: summarizeEvents(events.filter((row) => row.eventType === "missingRing")),
    falseRing: summarizeEvents(events.filter((row) => row.eventType === "falseRing")),
    clean: summarizeClean(clean),
    baselineClean: summarizeGroup(
        events,
        clean,
        (context) => context.baselineFlagged === false,
    ),
    baselineFlagged: summarizeGroup(
        events,
        clean,
        (context) => context.baselineFlagged === true,
    ),
    byDataset: Object.fromEntries(datasetGroups.map((datasetGroup) => [
        datasetGroup,
        summarizeGroup(events, clean, (context) => (
            (context.datasetGroup ?? itrdbDatasetGroup(context.file)) === datasetGroup
        )),
    ])),
    bySeriesLength: Object.fromEntries([
        "years_120_199",
        "years_200_399",
        "years_400_plus",
    ].map((stratum) => [
        stratum,
        summarizeGroup(events, clean, (context) => (
            itrdbSeriesLengthStratum(context.seriesLength) === stratum
        )),
    ])),
    byReferenceDepth: Object.fromEntries([
        "refs_5_9",
        "refs_10_19",
        "refs_20_plus",
    ].map((stratum) => [
        stratum,
        summarizeGroup(events, clean, (context) => (
            itrdbReferenceDepthStratum(context.referenceCount) === stratum
        )),
    ])),
    byEndpointDistance: Object.fromEntries([
        "older_14_29",
        "interior_30_plus",
        "newer_15_29",
        "newer_2_14",
    ].map((stratum) => [
        stratum,
        summarizeGroup(events, clean, (context) => (
            itrdbEndpointStratum(
                context.olderContextYears,
                context.newerContextYears,
            ) === stratum
        )),
    ])),
    byPosition: Object.fromEntries(groupValues(events, (row) => (
        row.context.positionStratum
    )).map((stratum) => [
        stratum,
        summarizeGroup(events, clean, (context) => context.positionStratum === stratum),
    ])),
    bySignal: Object.fromEntries([
        "weak",
        "medium",
        "strong",
        "unavailable",
    ].map((stratum) => [
        stratum,
        summarizeGroup(events, clean, (context) => signalStratum(context) === stratum),
    ])),
    signalThresholds,
};

writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
// eslint-disable-next-line no-console
console.log(`ITRDB_FORMAL_SUMMARY ${JSON.stringify(summary)}`);
