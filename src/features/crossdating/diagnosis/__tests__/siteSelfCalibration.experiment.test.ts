import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getConfig } from "../config";
import { diagnoseSeriesCore } from "../segments";
import {
    correlationForSegment,
    fisherZ,
    preprocessSeries,
} from "../series";
import { cofechaStyleStandardize } from "../../reference";
import type { NumericSeries } from "../types";
import {
    scanExhaustiveUnitEdit,
    type ExhaustiveEditScore,
} from "./exhaustiveEditScan.experiment";
import {
    buildSyntheticSite,
    createEndAnchoredFalseRingCase,
    createEndAnchoredMissingRingCase,
    type RwlSeries,
} from "./rdmFixture";

type EventType = "missingRing" | "falseRing";
type TargetFeature = "rawFull" | "differenceFull" | "whitenedFull" | "comboFull";
type ExhaustiveFeature = "raw" | "difference" | "whitened" | "combo";
type CofechaFeature = "cofechaFull" | "cofechaDifference" | "cofechaBalanced";

type AuditRow = {
    year: number;
    features: Record<string, number>;
};

type AuditCase = {
    offset: number;
    groupId: string;
    eventType: string;
    truthYear: number;
    currentTopYear: number | null;
    currentRange: [number, number] | null;
    currentScore: number;
    currentMargin: number;
    currentConfidence: string;
    currentSources: string[];
    context: {
        file: string;
        target: string;
        signalStrength: number | null;
        referenceCount: number;
        normalizedPosition: number;
    };
    rows: AuditRow[];
};

type Selection = {
    startYear: number;
    endYear: number;
    topYear: number;
    massFraction: number;
};

type CalibrationFeatureScore = {
    feature: TargetFeature;
    selection: Selection;
    adjustedSelection: Selection;
    calibrationCount: number;
    calibrationHitRate: number;
    calibrationMeanDistance: number;
    calibrationMeanTopError: number;
    calibrationMedianSignedTopBias: number;
    calibrationTopBiasSpread: number;
    calibrationMass: number;
};

type CalibrationOutcome = {
    file: string;
    target: string;
    eventType: EventType;
    truthYear: number;
    currentHit: boolean;
    currentRange: number[] | null;
    currentTopYear: number | null;
    currentScore: number;
    currentMargin: number;
    currentConfidence: string;
    currentSources: string[];
    signalStrength: number | null;
    referenceCount: number;
    normalizedPosition: number;
    selectedFeature: TargetFeature | null;
    selectedRange: number[] | null;
    selectedHit: boolean;
    adjustedSelectedHit: boolean;
    selectedCalibrationHitRate: number;
    featureOracleHit: boolean;
    adjustedFeatureOracleHit: boolean;
    cofechaHits: Record<CofechaFeature, boolean>;
    cofechaSelections: Record<CofechaFeature, Selection | null>;
    anchoredHits: Record<string, boolean>;
    anchoredSelections: Record<string, Selection | null>;
    thresholdHits: Record<string, boolean>;
    featureScores: CalibrationFeatureScore[];
};

const featureMap: Record<TargetFeature, ExhaustiveFeature> = {
    rawFull: "raw",
    differenceFull: "difference",
    whitenedFull: "whitened",
    comboFull: "combo",
};

const targetFeatures = Object.keys(featureMap) as TargetFeature[];
const cofechaFeatures: CofechaFeature[] = [
    "cofechaFull",
    "cofechaDifference",
    "cofechaBalanced",
];
const stopMarkers = new Set([999, -999, 9990, -9999]);
const itrdbCandidates = [
    process.env.CROSSDATING_ITRDB_DIR,
    "D:/软件测试/数据/ITRDB/itrdb_download/measurements",
].filter((candidate): candidate is string => Boolean(candidate));
const itrdbDir = itrdbCandidates.find(existsSync) ?? itrdbCandidates[itrdbCandidates.length - 1];

const parseItrdb = (text: string): Map<string, RwlSeries> => {
    const byId = new Map<string, Map<number, number>>();
    text.split(/\r?\n/).forEach((raw) => {
        const tokens = raw.trim().split(/\s+/);
        if (tokens.length < 3) return;
        const id = tokens[0];
        const decade = Number(tokens[1]);
        if (!Number.isFinite(decade)) return;
        const values = byId.get(id) ?? new Map<number, number>();
        let year = decade;
        for (let index = 2; index < tokens.length; index += 1) {
            const value = Number(tokens[index]);
            if (!Number.isFinite(value)) continue;
            if (stopMarkers.has(value)) break;
            values.set(year, value);
            year += 1;
        }
        byId.set(id, values);
    });
    const result = new Map<string, RwlSeries>();
    byId.forEach((valuesByYear, id) => {
        if (valuesByYear.size === 0) return;
        const years = [...valuesByYear.keys()].sort((left, right) => left - right);
        if (years[0] < 1000 || years[years.length - 1] > 2100) return;
        const zeroCount = [...valuesByYear.values()].filter((value) => value === 0).length;
        result.set(id, {
            id,
            startYear: years[0],
            endYear: years[years.length - 1],
            valuesByYear,
            length: valuesByYear.size,
            zeroCount,
            nonZeroCount: valuesByYear.size - zeroCount,
        });
    });
    return result;
};

const overlap = (left: RwlSeries, right: RwlSeries): number => {
    let count = 0;
    left.valuesByYear.forEach((_, year) => {
        if (right.valuesByYear.has(year)) count += 1;
    });
    return count;
};

const boundedMassSelection = (
    rows: Array<{ year: number; score: number }>,
    width = 9,
    topCount = 8,
): Selection | null => {
    const ranked = rows
        .filter((row) => Number.isFinite(row.score))
        .sort((left, right) => right.score - left.score || right.year - left.year)
        .slice(0, topCount)
        .map((row, index) => ({
            ...row,
            rank: index + 1,
            weight: 1 / (index + 1),
        }));
    if (ranked.length === 0) return null;
    const minimumYear = Math.min(...rows.map((row) => row.year));
    const maximumYear = Math.max(...rows.map((row) => row.year));
    const starts = new Set<number>();
    ranked.forEach((row) => {
        for (let offset = 0; offset < width; offset += 1) {
            starts.add(Math.max(
                minimumYear,
                Math.min(row.year - offset, maximumYear - width + 1),
            ));
        }
    });
    const selected = [...starts]
        .map((startYear) => {
            const endYear = startYear + width - 1;
            const mass = ranked.reduce((sum, row) => (
                row.year >= startYear && row.year <= endYear ? sum + row.weight : sum
            ), 0);
            return { startYear, endYear, mass };
        })
        .sort((left, right) => (
            right.mass - left.mass || right.startYear - left.startYear
        ))[0];
    if (!selected) return null;
    const topYear = ranked
        .filter((row) => row.year >= selected.startYear && row.year <= selected.endYear)
        .sort((left, right) => right.score - left.score || right.year - left.year)[0]?.year;
    const totalMass = ranked.reduce((sum, row) => sum + row.weight, 0);
    return {
        startYear: selected.startYear,
        endYear: selected.endYear,
        topYear: topYear ?? ranked[0].year,
        massFraction: selected.mass / totalMass,
    };
};

const targetSelection = (
    rankCase: AuditCase,
    feature: TargetFeature,
): Selection | null => boundedMassSelection(rankCase.rows.map((row) => ({
    year: row.year,
    score: row.features[feature],
})));

const cofechaPreprocess = (series: NumericSeries): NumericSeries => new Map(
    cofechaStyleStandardize(series).map((point) => [point.year, point.value]),
);

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = [...series.entries()].sort((left, right) => left[0] - right[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return preprocessSeries(result);
};

const simulateUnitCorrection = (
    series: NumericSeries,
    eventType: EventType,
    year: number,
): NumericSeries => {
    const result = new Map<number, number>();
    series.forEach((value, sourceYear) => {
        if (eventType === "missingRing") {
            result.set(sourceYear <= year ? sourceYear - 1 : sourceYear, value);
        } else if (sourceYear !== year) {
            result.set(sourceYear < year ? sourceYear + 1 : sourceYear, value);
        }
    });
    return result;
};

const segmentCorrelation = (
    target: NumericSeries,
    master: NumericSeries,
    startYear: number,
    endYear: number,
    minimumPairs: number,
): number => correlationForSegment(
    target,
    master,
    startYear,
    endYear,
    0,
    minimumPairs,
).correlation ?? -1;

const cofechaTargetSelections = (
    allSeries: Map<string, RwlSeries>,
    targetId: string,
    eventType: EventType,
    truthYear: number,
): Record<CofechaFeature, Selection | null> => {
    const target = allSeries.get(targetId);
    if (!target) {
        return Object.fromEntries(
            cofechaFeatures.map((feature) => [feature, null]),
        ) as Record<CofechaFeature, null>;
    }
    const corrupted = eventType === "missingRing"
        ? createEndAnchoredMissingRingCase(target, truthYear).corrupted
        : createEndAnchoredFalseRingCase(target, truthYear, "moderate").corrupted;
    const site = buildSyntheticSite(
        allSeries,
        targetId,
        corrupted,
        { minReferences: 5, maxReferences: 24, minOverlap: 80 },
    ).site;
    if (!site) {
        return Object.fromEntries(
            cofechaFeatures.map((feature) => [feature, null]),
        ) as Record<CofechaFeature, null>;
    }
    const diagnosis = diagnoseSeriesCore(
        site,
        targetId,
        getConfig({ referenceConfig: null }),
        cofechaPreprocess,
    );
    if (!diagnosis) {
        return Object.fromEntries(
            cofechaFeatures.map((feature) => [feature, null]),
        ) as Record<CofechaFeature, null>;
    }
    const standardizedTarget = cofechaPreprocess(diagnosis.rawTarget);
    const master = diagnosis.master.data;
    const masterDifference = firstDifferences(master);
    const rows = [...diagnosis.rawTarget.keys()]
        .filter((year) => (
            year >= diagnosis.targetRange.startYear + 18
            && year <= diagnosis.targetRange.endYear - 18
        ))
        .sort((left, right) => left - right)
        .map((year) => {
            const corrected = simulateUnitCorrection(standardizedTarget, eventType, year);
            const correctedDifference = firstDifferences(corrected);
            const full = segmentCorrelation(
                corrected,
                master,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
                30,
            );
            const difference = segmentCorrelation(
                correctedDifference,
                masterDifference,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
                30,
            );
            const older = segmentCorrelation(
                corrected,
                master,
                diagnosis.targetRange.startYear,
                year - 2,
                15,
            );
            const newer = segmentCorrelation(
                corrected,
                master,
                year + 2,
                diagnosis.targetRange.endYear,
                15,
            );
            const olderYears = Math.max(1, year - diagnosis.targetRange.startYear - 1);
            const newerYears = Math.max(1, diagnosis.targetRange.endYear - year - 1);
            const balanced = (
                fisherZ(older) * Math.sqrt(olderYears)
                + fisherZ(newer) * Math.sqrt(newerYears)
            ) / (Math.sqrt(olderYears) + Math.sqrt(newerYears));
            return {
                year,
                cofechaFull: full,
                cofechaDifference: difference,
                cofechaBalanced: balanced,
            };
        });
    return Object.fromEntries(cofechaFeatures.map((feature) => [
        feature,
        boundedMassSelection(rows.map((row) => ({
            year: row.year,
            score: row[feature],
        }))),
    ])) as Record<CofechaFeature, Selection | null>;
};

type PreparedAnchorReference = {
    id: string;
    data: NumericSeries;
    correlation: number;
};

const aggregateReferenceMaster = (
    references: PreparedAnchorReference[],
    mode: "top1" | "top3" | "weighted8",
): NumericSeries => {
    const selected = mode === "top1"
        ? references.slice(0, 1)
        : mode === "top3"
            ? references.slice(0, 3)
            : references.slice(0, 8);
    const sums = new Map<number, number>();
    const weights = new Map<number, number>();
    selected.forEach((reference) => {
        const weight = mode === "weighted8"
            ? Math.max(0.05, reference.correlation + 0.15)
            : 1;
        reference.data.forEach((value, year) => {
            sums.set(year, (sums.get(year) ?? 0) + value * weight);
            weights.set(year, (weights.get(year) ?? 0) + weight);
        });
    });
    const result = new Map<number, number>();
    sums.forEach((sum, year) => {
        const weight = weights.get(year) ?? 0;
        if (weight > 0) result.set(year, sum / weight);
    });
    return preprocessSeries(result);
};

const anchoredTargetSelections = (
    allSeries: Map<string, RwlSeries>,
    targetId: string,
    eventType: EventType,
    truthYear: number,
): Record<string, Selection | null> => {
    const target = allSeries.get(targetId);
    if (!target) return {};
    const corrupted = eventType === "missingRing"
        ? createEndAnchoredMissingRingCase(target, truthYear).corrupted
        : createEndAnchoredFalseRingCase(target, truthYear, "moderate").corrupted;
    const targetData = preprocessSeries(corrupted);
    const years = [...corrupted.keys()].sort((left, right) => left - right);
    const startYear = years[0];
    const endYear = years[years.length - 1];
    const candidateYears = years.filter((year) => (
        year >= startYear + 18 && year <= endYear - 18
    ));
    const result: Record<string, Selection | null> = {};
    for (const anchorYears of [18, 24, 36, 60]) {
        const anchorStart = endYear - anchorYears + 1;
        const references = [...allSeries.values()]
            .filter((reference) => (
                reference.id !== targetId
                && reference.zeroCount === 0
                && overlap(reference, target) >= 80
            ))
            .map((reference) => {
                const data = preprocessSeries(reference.valuesByYear);
                return {
                    id: reference.id,
                    data,
                    correlation: segmentCorrelation(
                        targetData,
                        data,
                        anchorStart,
                        endYear,
                        Math.max(10, Math.floor(anchorYears * 0.6)),
                    ),
                };
            })
            .filter((reference) => reference.correlation > -1)
            .sort((left, right) => (
                right.correlation - left.correlation
                || left.id.localeCompare(right.id)
            ));
        for (const mode of ["top1", "top3", "weighted8"] as const) {
            const master = aggregateReferenceMaster(references, mode);
            const masterDifference = firstDifferences(master);
            const rows = candidateYears.map((year) => {
                const corrected = simulateUnitCorrection(targetData, eventType, year);
                const correctedDifference = firstDifferences(corrected);
                return {
                    year,
                    full: segmentCorrelation(
                        corrected,
                        master,
                        startYear,
                        endYear,
                        30,
                    ),
                    difference: segmentCorrelation(
                        correctedDifference,
                        masterDifference,
                        startYear,
                        endYear,
                        30,
                    ),
                };
            });
            for (const view of ["full", "difference"] as const) {
                const feature = `anchor${anchorYears}:${mode}:${view}`;
                result[feature] = boundedMassSelection(rows.map((row) => ({
                    year: row.year,
                    score: row[view],
                })));
            }
        }
    }
    return result;
};

const calibrationReferences = (
    series: Map<string, RwlSeries>,
    targetId: string,
    year: number,
    limit: number,
): RwlSeries[] => {
    const target = series.get(targetId);
    if (!target) return [];
    const targetStem = targetId.slice(0, -1).toLowerCase();
    return [...series.values()]
        .filter((candidate) => (
            candidate.id !== targetId
            && candidate.zeroCount === 0
            && candidate.length >= 120
            && candidate.valuesByYear.has(year - 30)
            && candidate.valuesByYear.has(year + 30)
            && overlap(candidate, target) >= 80
        ))
        .sort((left, right) => (
            Number(right.id.slice(0, -1).toLowerCase() === targetStem)
                - Number(left.id.slice(0, -1).toLowerCase() === targetStem)
            || overlap(right, target) - overlap(left, target)
            || left.id.localeCompare(right.id)
        ))
        .slice(0, limit);
};

const calibrationSelection = (
    allSeries: Map<string, RwlSeries>,
    excludedTargetId: string,
    reference: RwlSeries,
    eventType: EventType,
    year: number,
    feature: TargetFeature,
): Selection | null => {
    const calibrationSeries = new Map(
        [...allSeries.entries()].filter(([id]) => id !== excludedTargetId),
    );
    const corrupted = eventType === "missingRing"
        ? createEndAnchoredMissingRingCase(reference, year).corrupted
        : createEndAnchoredFalseRingCase(reference, year, "moderate").corrupted;
    const site = buildSyntheticSite(
        calibrationSeries,
        reference.id,
        corrupted,
        { minReferences: 4, maxReferences: 16, minOverlap: 70 },
    ).site;
    if (!site) return null;
    const diagnosis = diagnoseSeriesCore(
        site,
        reference.id,
        getConfig({ referenceConfig: null }),
    );
    if (!diagnosis) return null;
    const scores = scanExhaustiveUnitEdit(
        diagnosis,
        eventType === "missingRing" ? "insert" : "delete",
    );
    const scoreName = featureMap[feature];
    return boundedMassSelection(scores.map((row: ExhaustiveEditScore) => ({
        year: row.year,
        score: row[scoreName],
    })));
};

const windowDistance = (selection: Selection, year: number): number => (
    year < selection.startYear
        ? selection.startYear - year
        : year > selection.endYear
            ? year - selection.endYear
            : 0
);

const centeredSelection = (
    centerYear: number,
    rows: AuditRow[],
    width = 9,
): Selection => {
    const minimumYear = Math.min(...rows.map((row) => row.year));
    const maximumYear = Math.max(...rows.map((row) => row.year));
    let startYear = centerYear - Math.floor((width - 1) / 2);
    startYear = Math.max(minimumYear, Math.min(startYear, maximumYear - width + 1));
    return {
        startYear,
        endYear: startYear + width - 1,
        topYear: centerYear,
        massFraction: 0,
    };
};

const median = (values: number[]): number => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

const auditRoots = [
    resolve(".tmp-window-ranker-broad"),
    resolve(".tmp-window-ranker"),
];

const loadAuditCases = (offsets: number[]): AuditCase[] => offsets.flatMap((offset) => {
    const name = `offset-${offset}-cases-25.json`;
    const path = auditRoots.map((root) => resolve(root, name)).find(existsSync);
    if (!path) throw new Error(`Missing audit ${name}`);
    const payload = JSON.parse(readFileSync(path, "utf8")) as { cases: AuditCase[] };
    return payload.cases.map((row) => ({ ...row, offset }));
});

const enabled = process.env.RUN_SITE_CALIBRATION_EXPERIMENT === "1"
    && existsSync(itrdbDir);
const suite = enabled ? describe : describe.skip;

suite("site-local synthetic calibration experiment", () => {
    it("selects one narrow unit-event window using reference-core perturbations", () => {
        const offsets = (process.env.SITE_CAL_OFFSETS ?? "0")
            .split(",")
            .map(Number)
            .filter(Number.isFinite);
        const maximumCases = Number(process.env.SITE_CAL_CASES ?? 8);
        const referenceLimit = Number(process.env.SITE_CAL_REFS ?? 2);
        const requestedTypes = new Set(
            (process.env.SITE_CAL_TYPES ?? "missingRing,falseRing").split(","),
        );
        const rankCases = loadAuditCases(offsets)
            .filter((row): row is AuditCase & { eventType: EventType } => (
                (row.eventType === "missingRing" || row.eventType === "falseRing")
                && requestedTypes.has(row.eventType)
            ))
            .slice(0, maximumCases);
        const outcomes: CalibrationOutcome[] = [];
        for (const rankCase of rankCases) {
            const path = `${itrdbDir}${rankCase.context.file}`;
            const series = parseItrdb(readFileSync(path, "utf8"));
            const selections = targetFeatures
                .map((feature) => ({ feature, selection: targetSelection(rankCase, feature) }))
                .filter((row): row is { feature: TargetFeature; selection: Selection } => (
                    row.selection !== null
                ));
            const featureScores = selections.map(({ feature, selection }) => {
                const references = calibrationReferences(
                    series,
                    rankCase.context.target,
                    selection.topYear,
                    referenceLimit,
                );
                const calibrations = references
                    .map((reference) => calibrationSelection(
                        series,
                        rankCase.context.target,
                        reference,
                        rankCase.eventType,
                        selection.topYear,
                        feature,
                    ))
                    .filter((value): value is Selection => value !== null);
                const signedTopBiases = calibrations.map((value) => (
                    value.topYear - selection.topYear
                ));
                const calibrationMedianSignedTopBias = signedTopBiases.length > 0
                    ? median(signedTopBiases)
                    : 0;
                const adjustedSelection = centeredSelection(
                    Math.round(selection.topYear - calibrationMedianSignedTopBias),
                    rankCase.rows,
                );
                return {
                    feature,
                    selection,
                    adjustedSelection,
                    calibrationCount: calibrations.length,
                    calibrationHitRate: calibrations.length > 0
                        ? calibrations.filter((value) => (
                            windowDistance(value, selection.topYear) === 0
                        )).length / calibrations.length
                        : -1,
                    calibrationMeanDistance: calibrations.length > 0
                        ? calibrations.reduce((sum, value) => (
                            sum + windowDistance(value, selection.topYear)
                        ), 0) / calibrations.length
                        : Number.POSITIVE_INFINITY,
                    calibrationMeanTopError: calibrations.length > 0
                        ? calibrations.reduce((sum, value) => (
                            sum + Math.abs(value.topYear - selection.topYear)
                        ), 0) / calibrations.length
                        : Number.POSITIVE_INFINITY,
                    calibrationMedianSignedTopBias,
                    calibrationTopBiasSpread: signedTopBiases.length > 0
                        ? Math.max(...signedTopBiases) - Math.min(...signedTopBiases)
                        : Number.POSITIVE_INFINITY,
                    calibrationMass: calibrations.length > 0
                        ? calibrations.reduce((sum, value) => (
                            sum + value.massFraction
                        ), 0) / calibrations.length
                        : -1,
                };
            });
            const cofechaSelections = process.env.SITE_CAL_COFECHA === "1"
                ? cofechaTargetSelections(
                    series,
                    rankCase.context.target,
                    rankCase.eventType,
                    rankCase.truthYear,
                )
                : Object.fromEntries(
                    cofechaFeatures.map((feature) => [feature, null]),
                ) as Record<CofechaFeature, null>;
            const cofechaHits = Object.fromEntries(cofechaFeatures.map((feature) => [
                feature,
                cofechaSelections[feature]
                    ? windowDistance(cofechaSelections[feature], rankCase.truthYear) === 0
                    : false,
            ])) as Record<CofechaFeature, boolean>;
            const anchoredSelections = process.env.SITE_CAL_ANCHORED === "1"
                ? anchoredTargetSelections(
                    series,
                    rankCase.context.target,
                    rankCase.eventType,
                    rankCase.truthYear,
                )
                : {};
            const anchoredHits = Object.fromEntries(
                Object.entries(anchoredSelections).map(([feature, selection]) => [
                    feature,
                    selection ? windowDistance(selection, rankCase.truthYear) === 0 : false,
                ]),
            );
            const selected = featureScores.sort((left, right) => (
                right.calibrationHitRate - left.calibrationHitRate
                || left.calibrationMeanDistance - right.calibrationMeanDistance
                || left.calibrationTopBiasSpread - right.calibrationTopBiasSpread
                || left.calibrationMeanTopError - right.calibrationMeanTopError
                || right.calibrationMass - left.calibrationMass
                || targetFeatures.indexOf(left.feature) - targetFeatures.indexOf(right.feature)
            ))[0];
            const currentSelection = rankCase.currentRange
                && rankCase.currentTopYear !== null
                ? {
                    startYear: rankCase.currentRange[0],
                    endYear: rankCase.currentRange[1],
                    topYear: rankCase.currentTopYear,
                    massFraction: 0,
                }
                : null;
            const thresholdHits = Object.fromEntries([0, 0.5, 1].map((threshold) => {
                const choice = selected
                    && selected.calibrationHitRate >= threshold
                    ? selected.adjustedSelection
                    : currentSelection;
                return [
                    threshold.toFixed(1),
                    choice ? windowDistance(choice, rankCase.truthYear) === 0 : false,
                ];
            }));
            outcomes.push({
                file: rankCase.context.file,
                target: rankCase.context.target,
                eventType: rankCase.eventType,
                truthYear: rankCase.truthYear,
                currentHit: rankCase.currentRange
                    ? rankCase.truthYear >= rankCase.currentRange[0]
                        && rankCase.truthYear <= rankCase.currentRange[1]
                    : false,
                currentRange: rankCase.currentRange,
                currentTopYear: rankCase.currentTopYear,
                currentScore: rankCase.currentScore,
                currentMargin: rankCase.currentMargin,
                currentConfidence: rankCase.currentConfidence,
                currentSources: rankCase.currentSources,
                signalStrength: rankCase.context.signalStrength,
                referenceCount: rankCase.context.referenceCount,
                normalizedPosition: rankCase.context.normalizedPosition,
                selectedFeature: selected?.feature ?? null,
                selectedRange: selected
                    ? [selected.selection.startYear, selected.selection.endYear]
                    : null,
                selectedHit: selected
                    ? windowDistance(selected.selection, rankCase.truthYear) === 0
                    : false,
                adjustedSelectedHit: selected
                    ? windowDistance(selected.adjustedSelection, rankCase.truthYear) === 0
                    : false,
                selectedCalibrationHitRate: selected?.calibrationHitRate ?? -1,
                featureOracleHit: featureScores.some((row) => (
                    windowDistance(row.selection, rankCase.truthYear) === 0
                )),
                adjustedFeatureOracleHit: featureScores.some((row) => (
                    windowDistance(row.adjustedSelection, rankCase.truthYear) === 0
                )),
                cofechaHits,
                cofechaSelections,
                anchoredHits,
                anchoredSelections,
                thresholdHits,
                featureScores,
            });
        }
        const byType = Object.fromEntries(
            (["missingRing", "falseRing"] as const).map((eventType) => {
                const rows = outcomes.filter((row) => row.eventType === eventType);
                const anchoredFeatureNames = [...new Set(
                    rows.flatMap((row) => Object.keys(row.anchoredHits)),
                )];
                return [eventType, {
                    cases: rows.length,
                    currentCoverage: rows.filter((row) => row.currentHit).length
                        / Math.max(1, rows.length),
                    selectedCoverage: rows.filter((row) => row.selectedHit).length
                        / Math.max(1, rows.length),
                    adjustedSelectedCoverage:
                        rows.filter((row) => row.adjustedSelectedHit).length
                            / Math.max(1, rows.length),
                    featureOracleCoverage: rows.filter((row) => row.featureOracleHit).length
                        / Math.max(1, rows.length),
                    adjustedFeatureOracleCoverage:
                        rows.filter((row) => row.adjustedFeatureOracleHit).length
                            / Math.max(1, rows.length),
                    cofechaCoverage: Object.fromEntries(cofechaFeatures.map((feature) => [
                        feature,
                        rows.filter((row) => row.cofechaHits[feature]).length
                            / Math.max(1, rows.length),
                    ])),
                    cofechaOracleCoverage: rows.filter((row) => (
                        cofechaFeatures.some((feature) => row.cofechaHits[feature])
                    )).length / Math.max(1, rows.length),
                    anchoredCoverage: Object.fromEntries(
                        anchoredFeatureNames.map((feature) => [
                            feature,
                            rows.filter((row) => row.anchoredHits[feature]).length
                                / Math.max(1, rows.length),
                        ]),
                    ),
                    anchoredOracleCoverage: rows.filter((row) => (
                        anchoredFeatureNames.some((feature) => row.anchoredHits[feature])
                    )).length / Math.max(1, rows.length),
                    thresholdCoverage: Object.fromEntries([0, 0.5, 1].map((threshold) => {
                        const key = threshold.toFixed(1);
                        return [
                            key,
                            rows.filter((row) => row.thresholdHits[key]).length
                                / Math.max(1, rows.length),
                        ];
                    })),
                }];
            }),
        );
        const summary = {
            cases: outcomes.length,
            currentCoverage: outcomes.filter((row) => row.currentHit).length
                / Math.max(1, outcomes.length),
            selectedCoverage: outcomes.filter((row) => row.selectedHit).length
                / Math.max(1, outcomes.length),
            adjustedSelectedCoverage:
                outcomes.filter((row) => row.adjustedSelectedHit).length
                    / Math.max(1, outcomes.length),
            featureOracleCoverage: outcomes.filter((row) => row.featureOracleHit).length
                / Math.max(1, outcomes.length),
            adjustedFeatureOracleCoverage:
                outcomes.filter((row) => row.adjustedFeatureOracleHit).length
                    / Math.max(1, outcomes.length),
            cofechaCoverage: Object.fromEntries(cofechaFeatures.map((feature) => [
                feature,
                outcomes.filter((row) => row.cofechaHits[feature]).length
                    / Math.max(1, outcomes.length),
            ])),
            cofechaOracleCoverage: outcomes.filter((row) => (
                cofechaFeatures.some((feature) => row.cofechaHits[feature])
            )).length / Math.max(1, outcomes.length),
            anchoredCoverage: (() => {
                const features = [...new Set(
                    outcomes.flatMap((row) => Object.keys(row.anchoredHits)),
                )];
                return Object.fromEntries(features.map((feature) => [
                    feature,
                    outcomes.filter((row) => row.anchoredHits[feature]).length
                        / Math.max(1, outcomes.length),
                ]));
            })(),
            anchoredOracleCoverage: (() => {
                const features = [...new Set(
                    outcomes.flatMap((row) => Object.keys(row.anchoredHits)),
                )];
                return outcomes.filter((row) => (
                    features.some((feature) => row.anchoredHits[feature])
                )).length / Math.max(1, outcomes.length);
            })(),
            thresholdCoverage: Object.fromEntries([0, 0.5, 1].map((threshold) => {
                const key = threshold.toFixed(1);
                return [
                    key,
                    outcomes.filter((row) => row.thresholdHits[key]).length
                        / Math.max(1, outcomes.length),
                ];
            })),
            byType,
            ...(process.env.SITE_CAL_DETAILS === "1" ? { outcomes } : {}),
            ...(process.env.SITE_CAL_FAILURES === "1" ? {
                failures: outcomes
                    .filter((row) => !row.selectedHit)
                    .map((row) => ({
                        file: row.file,
                        target: row.target,
                        eventType: row.eventType,
                        truthYear: row.truthYear,
                        currentHit: row.currentHit,
                        selectedFeature: row.selectedFeature,
                        selectedRange: row.selectedRange,
                        featureScores: row.featureScores.map((score) => ({
                            feature: score.feature,
                            range: [
                                score.selection.startYear,
                                score.selection.endYear,
                            ],
                            truthHit: windowDistance(score.selection, row.truthYear) === 0,
                            calibrationHitRate: score.calibrationHitRate,
                            calibrationMeanDistance: score.calibrationMeanDistance,
                            calibrationMeanTopError: score.calibrationMeanTopError,
                            calibrationMass: score.calibrationMass,
                        })),
                    })),
            } : {}),
        };
        if (process.env.SITE_CAL_OUTPUT) {
            writeFileSync(
                resolve(process.env.SITE_CAL_OUTPUT),
                JSON.stringify({
                    schemaVersion: 1,
                    offsets,
                    referenceLimit,
                    outcomes,
                    summary: {
                        cases: summary.cases,
                        currentCoverage: summary.currentCoverage,
                        selectedCoverage: summary.selectedCoverage,
                        adjustedSelectedCoverage: summary.adjustedSelectedCoverage,
                        featureOracleCoverage: summary.featureOracleCoverage,
                        adjustedFeatureOracleCoverage: summary.adjustedFeatureOracleCoverage,
                        thresholdCoverage: summary.thresholdCoverage,
                        byType: summary.byType,
                    },
                }, null, 2),
                "utf8",
            );
        }
        // eslint-disable-next-line no-console
        console.log(`SITE_SELF_CALIBRATION ${JSON.stringify(summary)}`);
        expect(outcomes.length).toBeGreaterThan(0);
    }, 600_000);
});
