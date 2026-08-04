/**
 * Event-specific counterfactual evidence for ranking years inside an already frozen 5-13 year
 * unit-event window. Expensive preparation is shared across candidate years and cached per
 * diagnosis; this layer never changes event acceptance or window selection.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import {
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import type { NumericSeries, SeriesCoreDiagnosis } from "./types";

export type UnitEventExactYearEvidenceType = "missingRing" | "falseRing";
type FalseRingCorrectionMode = "direct" | "mergeOlder";

export type UnitEventExactYearEvidence = {
    scoreByYear: ReadonlyMap<number, number>;
    profileName:
        | "differencePredictiveMedianHuberOlder5"
        | "differenceMasterR61";
    diagnosticProfiles?: ReadonlyMap<
        string,
        ReadonlyMap<number, number>
    >;
    fixedWindowProfiles?: ReadonlyMap<
        string,
        ReadonlyMap<number, number>
    >;
};

type PreparedReference = {
    original: NumericSeries;
    raw: NumericSeries;
    difference: NumericSeries;
    correlation: number;
};

type ReferencePredictor = {
    reference: NumericSeries;
    intercept: number;
    slope: number;
    weight: number;
    residualScale: number;
};

type ExactYearContext = {
    baselineOriginal: NumericSeries;
    baselineRaw: NumericSeries;
    baselineDifference: NumericSeries;
    masterDifference: NumericSeries;
    references: PreparedReference[];
    correctedRaw: Map<string, NumericSeries>;
    correctedDifference: Map<string, NumericSeries>;
    predictorCache: Map<string, ReferencePredictor[]>;
};

const CONTEXT_CACHE = new WeakMap<SeriesCoreDiagnosis, ExactYearContext>();

const mean = (values: readonly number[]): number => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : -1;

const median = (values: readonly number[]): number => {
    if (values.length === 0) return -1;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

const percentileRanks = (values: readonly number[]): number[] => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const result = Array<number>(values.length).fill(0);
    let start = 0;
    while (start < ordered.length) {
        let end = start + 1;
        while (
            end < ordered.length
            && ordered[end].value === ordered[start].value
        ) end += 1;
        const rank = values.length <= 1
            ? 0.5
            : (start + end - 1) / (2 * (values.length - 1));
        for (let index = start; index < end; index += 1) {
            result[ordered[index].index] = rank;
        }
        start = end;
    }
    return result;
};

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = [...series.entries()].sort((left, right) => left[0] - right[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) {
            result.set(year, value - previousValue);
        }
    }
    return preprocessSeries(result);
};

const buildContext = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
): ExactYearContext => {
    const cached = CONTEXT_CACHE.get(diagnosis);
    if (cached) return cached;
    const baselineRaw = preprocessSeries(diagnosis.rawTarget);
    const references = diagnosis.master.sourceTrees
        .map((tree) => {
            const source = toNumericSeries(siteData.get(tree));
            const raw = preprocessSeries(source);
            const correlation = [-3, -2, -1, 0, 1, 2, 3].reduce(
                (best, lag) => Math.max(
                    best,
                    correlationForSegment(
                        baselineRaw,
                        raw,
                        diagnosis.targetRange.startYear,
                        diagnosis.targetRange.endYear,
                        lag,
                        30,
                    ).correlation ?? -1,
                ),
                -1,
            );
            return {
                original: source,
                raw,
                difference: firstDifferences(source),
                correlation,
            };
        })
        .filter((reference) => reference.correlation > -0.1)
        .sort((left, right) => right.correlation - left.correlation)
        .slice(0, 10);
    const context: ExactYearContext = {
        baselineOriginal: new Map(diagnosis.rawTarget),
        baselineRaw,
        baselineDifference: firstDifferences(diagnosis.rawTarget),
        masterDifference: firstDifferences(diagnosis.master.data),
        references,
        correctedRaw: new Map(),
        correctedDifference: new Map(),
        predictorCache: new Map(),
    };
    CONTEXT_CACHE.set(diagnosis, context);
    return context;
};

const correctedRaw = (
    context: ExactYearContext,
    diagnosis: SeriesCoreDiagnosis,
    eventType: UnitEventExactYearEvidenceType,
    year: number,
    falseRingMode: FalseRingCorrectionMode = "direct",
): NumericSeries => {
    const key = `${eventType}:${falseRingMode}:${year}`;
    const cached = context.correctedRaw.get(key);
    if (cached) return cached;
    const result = preprocessSeries(simulateCorrection(
        diagnosis.rawTarget,
        eventType,
        year,
        falseRingMode,
    ));
    context.correctedRaw.set(key, result);
    return result;
};

const simulateCorrection = (
    series: NumericSeries,
    eventType: UnitEventExactYearEvidenceType,
    year: number,
    falseRingMode: FalseRingCorrectionMode = "direct",
): NumericSeries => {
    const corrected = new Map<number, number>();
    const deletedValue = eventType === "falseRing" && falseRingMode === "mergeOlder"
        ? series.get(year) ?? 0
        : 0;
    series.forEach((value, sourceYear) => {
        if (eventType === "missingRing") {
            corrected.set(sourceYear <= year ? sourceYear - 1 : sourceYear, value);
        } else if (sourceYear !== year) {
            const mergedValue = falseRingMode === "mergeOlder" && sourceYear === year - 1
                ? value + deletedValue
                : value;
            corrected.set(
                sourceYear < year ? sourceYear + 1 : sourceYear,
                mergedValue,
            );
        }
    });
    return corrected;
};

const correctedDifference = (
    context: ExactYearContext,
    diagnosis: SeriesCoreDiagnosis,
    eventType: UnitEventExactYearEvidenceType,
    year: number,
    falseRingMode: FalseRingCorrectionMode = "direct",
): NumericSeries => {
    const key = `${eventType}:${falseRingMode}:${year}`;
    const cached = context.correctedDifference.get(key);
    if (cached) return cached;
    const result = firstDifferences(simulateCorrection(
        diagnosis.rawTarget,
        eventType,
        year,
        falseRingMode,
    ));
    context.correctedDifference.set(key, result);
    return result;
};

const fitReferencePredictor = (
    target: NumericSeries,
    reference: NumericSeries,
    startYear: number,
    endYear: number,
): ReferencePredictor | null => {
    const pairs: Array<[number, number]> = [];
    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const referenceValue = reference.get(year);
        if (targetValue !== undefined && referenceValue !== undefined) {
            pairs.push([referenceValue, targetValue]);
        }
    }
    if (pairs.length < 12) return null;
    const referenceMean = mean(pairs.map(([value]) => value));
    const targetMean = mean(pairs.map(([, value]) => value));
    let covariance = 0;
    let referenceVariance = 0;
    let targetVariance = 0;
    pairs.forEach(([referenceValue, targetValue]) => {
        const referenceDelta = referenceValue - referenceMean;
        const targetDelta = targetValue - targetMean;
        covariance += referenceDelta * targetDelta;
        referenceVariance += referenceDelta * referenceDelta;
        targetVariance += targetDelta * targetDelta;
    });
    if (referenceVariance <= 0 || targetVariance <= 0) return null;
    const slope = covariance / referenceVariance;
    const intercept = targetMean - slope * referenceMean;
    const correlation = covariance / Math.sqrt(referenceVariance * targetVariance);
    const residualMeanSquare = mean(pairs.map(([referenceValue, targetValue]) => (
        targetValue - (intercept + slope * referenceValue)
    ) ** 2));
    if (!Number.isFinite(correlation)
        || !Number.isFinite(residualMeanSquare)
        || correlation <= 0.05) {
        return null;
    }
    return {
        reference,
        intercept,
        slope,
        residualScale: Math.max(1e-6, Math.sqrt(residualMeanSquare)),
        weight: Math.min(
            20,
            Math.max(0.01, correlation) ** 2
                / Math.max(0.1, residualMeanSquare),
        ),
    };
};

const newerSidePredictors = (
    context: ExactYearContext,
    diagnosis: SeriesCoreDiagnosis,
    window: { startYear: number; endYear: number },
    channel: "original" | "raw" | "difference" = "difference",
): ReferencePredictor[] => {
    const key = `${channel}:${window.startYear}:${window.endYear}`;
    const cached = context.predictorCache.get(key);
    if (cached) return cached;
    const startYear = window.endYear + 5;
    const endYear = Math.min(diagnosis.targetRange.endYear, startYear + 179);
    const result = context.references
        .map((reference) => fitReferencePredictor(
            channel === "original"
                ? context.baselineOriginal
                : channel === "raw"
                    ? context.baselineRaw
                    : context.baselineDifference,
            reference[channel],
            startYear,
            endYear,
        ))
        .filter((predictor): predictor is ReferencePredictor => predictor !== null)
        .sort((left, right) => right.weight - left.weight)
        .slice(0, 8);
    context.predictorCache.set(key, result);
    return result;
};

const huberLoss = (residual: number, transition = 1.5): number => {
    const absolute = Math.abs(residual);
    return absolute <= transition
        ? 0.5 * residual * residual
        : transition * (absolute - transition * 0.5);
};

const predictiveMedianHuber = (
    target: NumericSeries,
    predictors: readonly ReferencePredictor[],
    startYear: number,
    endYear: number,
): number => median(predictors.flatMap((predictor) => {
    let loss = 0;
    let pairs = 0;
    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const referenceValue = predictor.reference.get(year);
        if (targetValue === undefined || referenceValue === undefined) continue;
        const predicted = predictor.intercept + predictor.slope * referenceValue;
        loss += huberLoss(targetValue - predicted);
        pairs += 1;
    }
    return pairs >= 1 ? [-loss / pairs] : [];
}));

const predictiveWeightedHuber = (
    target: NumericSeries,
    predictors: readonly ReferencePredictor[],
    startYear: number,
    endYear: number,
): number => {
    let weightedScore = 0;
    let totalWeight = 0;
    predictors.forEach((predictor) => {
        let loss = 0;
        let pairs = 0;
        for (let year = startYear; year <= endYear; year += 1) {
            const targetValue = target.get(year);
            const referenceValue = predictor.reference.get(year);
            if (targetValue === undefined || referenceValue === undefined) continue;
            const predicted = predictor.intercept + predictor.slope * referenceValue;
            loss += huberLoss(targetValue - predicted);
            pairs += 1;
        }
        if (pairs === 0) return;
        weightedScore += (-loss / pairs) * predictor.weight;
        totalWeight += predictor.weight;
    });
    return totalWeight > 0 ? weightedScore / totalWeight : -1;
};

const falseWidthFit = (
    target: NumericSeries,
    predictors: readonly ReferencePredictor[],
    candidateYear: number,
    aggregate: "median" | "weighted",
): { direct: number; mergeOlder: number; mergeAdvantage: number } => {
    const insertedValue = target.get(candidateYear);
    const retainedValue = target.get(candidateYear - 1);
    if (insertedValue === undefined || retainedValue === undefined) {
        return { direct: -100, mergeOlder: -100, mergeAdvantage: 0 };
    }
    const rows = predictors.flatMap((predictor) => {
        const referenceValue = predictor.reference.get(candidateYear);
        if (referenceValue === undefined) return [];
        const predicted = predictor.intercept + predictor.slope * referenceValue;
        const scale = Math.max(1, predictor.residualScale);
        return [{
            direct: -huberLoss((retainedValue - predicted) / scale),
            mergeOlder: -huberLoss(
                (retainedValue + insertedValue - predicted) / scale,
            ),
            weight: predictor.weight,
        }];
    });
    if (rows.length === 0) {
        return { direct: -100, mergeOlder: -100, mergeAdvantage: 0 };
    }
    const summarize = (key: "direct" | "mergeOlder"): number => {
        if (aggregate === "median") return median(rows.map((row) => row[key]));
        const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
        return totalWeight > 0
            ? rows.reduce((sum, row) => sum + row[key] * row.weight, 0)
                / totalWeight
            : -100;
    };
    const direct = summarize("direct");
    const mergeOlder = summarize("mergeOlder");
    return {
        direct,
        mergeOlder,
        mergeAdvantage: mergeOlder - direct,
    };
};

const falseSourceStateHuber = (
    target: NumericSeries,
    predictor: ReferencePredictor,
    candidateYear: number,
    startYear: number,
    endYear: number,
): number => {
    let loss = 0;
    let pairs = 0;
    for (let sourceYear = startYear; sourceYear <= endYear; sourceYear += 1) {
        if (sourceYear === candidateYear) continue;
        const targetValue = target.get(sourceYear);
        const referenceYear = sourceYear < candidateYear
            ? sourceYear + 1
            : sourceYear;
        const referenceValue = predictor.reference.get(referenceYear);
        if (targetValue === undefined || referenceValue === undefined) continue;
        const predicted = predictor.intercept + predictor.slope * referenceValue;
        loss += huberLoss(targetValue - predicted);
        pairs += 1;
    }
    return pairs >= 2 ? -loss / pairs : -1;
};

const falseLagAdvantage = (
    target: NumericSeries,
    predictor: ReferencePredictor,
    sourceYear: number,
): number | null => {
    const targetValue = target.get(sourceYear);
    const zeroReference = predictor.reference.get(sourceYear);
    const olderReference = predictor.reference.get(sourceYear + 1);
    if (
        targetValue === undefined
        || zeroReference === undefined
        || olderReference === undefined
    ) return null;
    const zeroPrediction = predictor.intercept + predictor.slope * zeroReference;
    const olderPrediction = predictor.intercept + predictor.slope * olderReference;
    return huberLoss(targetValue - zeroPrediction)
        - huberLoss(targetValue - olderPrediction);
};

const falseBalancedLagStep = (
    target: NumericSeries,
    predictor: ReferencePredictor,
    candidateYear: number,
    startYear: number,
    endYear: number,
    statistic: "difference" | "minimum",
): number => {
    const older: number[] = [];
    const newer: number[] = [];
    for (let sourceYear = startYear; sourceYear <= endYear; sourceYear += 1) {
        if (sourceYear === candidateYear) continue;
        const advantage = falseLagAdvantage(target, predictor, sourceYear);
        if (advantage === null) continue;
        (sourceYear < candidateYear ? older : newer).push(advantage);
    }
    if (older.length < 2 || newer.length < 2) return -1;
    const olderAdvantage = median(older);
    const newerAdvantage = median(newer);
    return statistic === "minimum"
        ? Math.min(olderAdvantage, -newerAdvantage)
        : olderAdvantage - newerAdvantage;
};

const falseBoundaryBridgeHuber = (
    target: NumericSeries,
    predictor: ReferencePredictor,
    candidateYear: number,
    radius: number,
): number => {
    let loss = 0;
    let pairs = 0;
    for (let distance = 1; distance <= radius; distance += 1) {
        for (const [sourceYear, referenceYear] of [
            [candidateYear - distance, candidateYear - distance + 1],
            [candidateYear + distance, candidateYear + distance],
        ] as const) {
            const targetValue = target.get(sourceYear);
            const referenceValue = predictor.reference.get(referenceYear);
            if (targetValue === undefined || referenceValue === undefined) continue;
            const predicted = predictor.intercept + predictor.slope * referenceValue;
            loss += huberLoss(targetValue - predicted);
            pairs += 1;
        }
    }
    return pairs >= 2 ? -loss / pairs : -1;
};

const aggregatePredictorProfile = (
    years: readonly number[],
    predictors: readonly ReferencePredictor[],
    score: (predictor: ReferencePredictor, year: number) => number,
    aggregate: "median" | "weighted",
): ReadonlyMap<number, number> => new Map(years.map((year) => {
    const scores = predictors.map((predictor) => score(predictor, year));
    if (aggregate === "median") return [year, median(scores)];
    const totalWeight = predictors.reduce(
        (sum, predictor) => sum + predictor.weight,
        0,
    );
    return [
        year,
        totalWeight > 0
            ? scores.reduce(
                (sum, value, index) => sum + value * predictors[index].weight,
                0,
            ) / totalWeight
            : median(scores),
    ];
}));

const predictorConsensusProfiles = (
    years: readonly number[],
    predictors: readonly ReferencePredictor[],
    score: (predictor: ReferencePredictor, year: number) => number,
): {
    rankMean: ReadonlyMap<number, number>;
    rankMedian: ReadonlyMap<number, number>;
    topVoteFraction: ReadonlyMap<number, number>;
} => {
    const rankRows = predictors.map((predictor) => percentileRanks(
        years.map((year) => score(predictor, year)),
    ));
    const weights = predictors.map((predictor) => predictor.weight);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const topIndices = rankRows.map((ranks) => ranks.reduce(
        (best, value, index) => value > ranks[best] ? index : best,
        0,
    ));
    const rankMean = (index: number): number => totalWeight > 0
        ? rankRows.reduce(
            (sum, row, rowIndex) => sum + row[index] * weights[rowIndex],
            0,
        ) / totalWeight
        : mean(rankRows.map((row) => row[index]));
    return {
        rankMean: new Map(years.map((year, index) => [year, rankMean(index)])),
        rankMedian: new Map(years.map((year, index) => [
            year,
            median(rankRows.map((row) => row[index])),
        ])),
        topVoteFraction: new Map(years.map((year, index) => [
            year,
            rankRows.length > 0
                ? topIndices.filter((topIndex) => topIndex === index).length
                    / rankRows.length
                : 0,
        ])),
    };
};

const directHuber = (
    target: NumericSeries,
    reference: NumericSeries,
    startYear: number,
    endYear: number,
): number => {
    let loss = 0;
    let pairs = 0;
    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const referenceValue = reference.get(year);
        if (targetValue === undefined || referenceValue === undefined) continue;
        loss += huberLoss(targetValue - referenceValue);
        pairs += 1;
    }
    return pairs >= 2 ? -loss / pairs : -1;
};

const referenceConsensusProfiles = (
    years: readonly number[],
    correctedByYear: ReadonlyMap<number, NumericSeries>,
    predictors: readonly ReferencePredictor[],
    rangeForYear: (year: number) => { startYear: number; endYear: number },
): {
    rankMean: ReadonlyMap<number, number>;
    rankMedian: ReadonlyMap<number, number>;
    topVoteFraction: ReadonlyMap<number, number>;
} => {
    const rankRows = predictors.map((predictor) => {
        const scores = years.map((year) => {
            const range = rangeForYear(year);
            return predictiveMedianHuber(
                correctedByYear.get(year) ?? new Map(),
                [predictor],
                range.startYear,
                range.endYear,
            );
        });
        return percentileRanks(scores);
    });
    const weights = predictors.map((predictor) => predictor.weight);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const topIndices = rankRows.map((ranks) => ranks.reduce(
        (best, value, index) => value > ranks[best] ? index : best,
        0,
    ));
    const valueFor = (
        index: number,
        aggregate: "mean" | "median" | "vote",
    ): number => {
        if (rankRows.length === 0) return 0;
        if (aggregate === "median") {
            return median(rankRows.map((row) => row[index]));
        }
        if (aggregate === "vote") {
            return topIndices.filter((topIndex) => topIndex === index).length
                / rankRows.length;
        }
        return totalWeight > 0
            ? rankRows.reduce(
                (sum, row, rowIndex) => sum + row[index] * weights[rowIndex],
                0,
            ) / totalWeight
            : mean(rankRows.map((row) => row[index]));
    };
    return {
        rankMean: new Map(years.map((year, index) => [
            year,
            valueFor(index, "mean"),
        ])),
        rankMedian: new Map(years.map((year, index) => [
            year,
            valueFor(index, "median"),
        ])),
        topVoteFraction: new Map(years.map((year, index) => [
            year,
            valueFor(index, "vote"),
        ])),
    };
};

const buildMissingFixedWindowProfiles = (
    context: ExactYearContext,
    diagnosis: SeriesCoreDiagnosis,
    years: readonly number[],
): ReadonlyMap<string, ReadonlyMap<number, number>> => {
    const window = { startYear: years[0], endYear: years[years.length - 1] };
    const rawByYear = new Map(years.map((year) => [
        year,
        correctedRaw(context, diagnosis, "missingRing", year),
    ]));
    const differenceByYear = new Map(years.map((year) => [
        year,
        correctedDifference(context, diagnosis, "missingRing", year),
    ]));
    const predictors = newerSidePredictors(context, diagnosis, window);
    const profiles = new Map<string, ReadonlyMap<number, number>>();
    for (const padding of [0, 2, 6] as const) {
        const startYear = window.startYear - padding;
        const endYear = window.endYear + padding;
        const suffix = padding === 0
            ? "Window"
            : `WindowPlus${padding * 2}`;
        profiles.set(
            `rawMasterRFixed${suffix}`,
            new Map(years.map((year) => [
                year,
                correlationForSegment(
                    rawByYear.get(year) ?? new Map(),
                    diagnosis.master.data,
                    startYear,
                    endYear,
                    0,
                    2,
                ).correlation ?? -1,
            ])),
        );
        profiles.set(
            `differenceMasterRFixed${suffix}`,
            new Map(years.map((year) => [
                year,
                correlationForSegment(
                    differenceByYear.get(year) ?? new Map(),
                    context.masterDifference,
                    startYear,
                    endYear,
                    0,
                    2,
                ).correlation ?? -1,
            ])),
        );
        profiles.set(
            `differenceMasterHuberFixed${suffix}`,
            new Map(years.map((year) => [
                year,
                directHuber(
                    differenceByYear.get(year) ?? new Map(),
                    context.masterDifference,
                    startYear,
                    endYear,
                ),
            ])),
        );
        profiles.set(
            `differencePredictiveWeightedHuberFixed${suffix}`,
            new Map(years.map((year) => [
                year,
                predictiveWeightedHuber(
                    differenceByYear.get(year) ?? new Map(),
                    predictors,
                    startYear,
                    endYear,
                ),
            ])),
        );
    }
    return profiles;
};

const buildFalseBoundaryDiagnosticProfiles = (
    context: ExactYearContext,
    diagnosis: SeriesCoreDiagnosis,
    years: readonly number[],
): ReadonlyMap<string, ReadonlyMap<number, number>> => {
    const window = { startYear: years[0], endYear: years[years.length - 1] };
    const predictors = newerSidePredictors(context, diagnosis, window, "raw");
    const profiles = new Map<string, ReadonlyMap<number, number>>();
    const addProfileFamily = (
        prefix: string,
        scoreRows: readonly ReadonlyMap<number, number>[],
    ): void => {
        const scoreFor = (predictor: ReferencePredictor, year: number): number => {
            const predictorIndex = predictors.indexOf(predictor);
            return scoreRows[predictorIndex]?.get(year) ?? -1;
        };
        profiles.set(
            `${prefix}Median`,
            aggregatePredictorProfile(years, predictors, scoreFor, "median"),
        );
        profiles.set(
            `${prefix}Weighted`,
            aggregatePredictorProfile(years, predictors, scoreFor, "weighted"),
        );
        const consensus = predictorConsensusProfiles(years, predictors, scoreFor);
        profiles.set(`${prefix}RankMean`, consensus.rankMean);
        profiles.set(`${prefix}RankMedian`, consensus.rankMedian);
        profiles.set(`${prefix}TopVote`, consensus.topVoteFraction);
    };

    for (const padding of [0, 6] as const) {
        const suffix = padding === 0 ? "Window" : `WindowPlus${padding * 2}`;
        const startYear = window.startYear - padding;
        const endYear = window.endYear + padding;
        const rows = predictors.map((predictor) => new Map(years.map((year) => [
            year,
            falseSourceStateHuber(
                context.baselineRaw,
                predictor,
                year,
                startYear,
                endYear,
            ),
        ])));
        addProfileFamily(`falseStateFixed${suffix}`, rows);
        for (const statistic of ["difference", "minimum"] as const) {
            const balancedRows = predictors.map((predictor) => new Map(
                years.map((year) => [
                    year,
                    falseBalancedLagStep(
                        context.baselineRaw,
                        predictor,
                        year,
                        startYear,
                        endYear,
                        statistic,
                    ),
                ]),
            ));
            const statisticName = statistic === "difference"
                ? "Difference"
                : "MinimumSupport";
            addProfileFamily(
                `falseLagStep${statisticName}Fixed${suffix}`,
                balancedRows,
            );
        }
    }
    for (const radius of [1, 2, 3] as const) {
        const rows = predictors.map((predictor) => new Map(years.map((year) => [
            year,
            falseBoundaryBridgeHuber(
                context.baselineRaw,
                predictor,
                year,
                radius,
            ),
        ])));
        addProfileFamily(`falseBoundaryBridgeRadius${radius}`, rows);
    }
    return profiles;
};

const buildDiagnosticProfiles = (
    context: ExactYearContext,
    diagnosis: SeriesCoreDiagnosis,
    eventType: UnitEventExactYearEvidenceType,
    years: readonly number[],
): ReadonlyMap<string, ReadonlyMap<number, number>> => {
    const window = { startYear: years[0], endYear: years[years.length - 1] };
    const rawPredictors = newerSidePredictors(context, diagnosis, window, "raw");
    const differencePredictors = newerSidePredictors(
        context,
        diagnosis,
        window,
        "difference",
    );
    const originalPredictors = eventType === "falseRing"
        ? newerSidePredictors(context, diagnosis, window, "original")
        : [];
    const rawByYear = new Map(years.map((year) => [
        year,
        correctedRaw(context, diagnosis, eventType, year),
    ]));
    const differenceByYear = new Map(years.map((year) => [
        year,
        correctedDifference(context, diagnosis, eventType, year),
    ]));
    const mergeOlderRawByYear = eventType === "falseRing"
        ? new Map(years.map((year) => [
            year,
            correctedRaw(context, diagnosis, eventType, year, "mergeOlder"),
        ]))
        : null;
    const mergeOlderDifferenceByYear = eventType === "falseRing"
        ? new Map(years.map((year) => [
            year,
            correctedDifference(
                context,
                diagnosis,
                eventType,
                year,
                "mergeOlder",
            ),
        ]))
        : null;
    const profiles = new Map<string, ReadonlyMap<number, number>>();
    for (const aggregate of ["median", "weighted"] as const) {
        if (eventType !== "falseRing") break;
        const rows = new Map(years.map((year) => [
            year,
            falseWidthFit(
                context.baselineOriginal,
                originalPredictors,
                year,
                aggregate,
            ),
        ]));
        const prefix = aggregate === "median"
            ? "falseWidthMedian"
            : "falseWidthWeighted";
        profiles.set(`${prefix}DirectFit`, new Map(years.map((year) => [
            year,
            rows.get(year)?.direct ?? -100,
        ])));
        profiles.set(`${prefix}MergeOlderFit`, new Map(years.map((year) => [
            year,
            rows.get(year)?.mergeOlder ?? -100,
        ])));
        profiles.set(`${prefix}MergeAdvantage`, new Map(years.map((year) => [
            year,
            rows.get(year)?.mergeAdvantage ?? 0,
        ])));
    }
    const addPredictive = (
        name: string,
        corrected: ReadonlyMap<number, NumericSeries>,
        predictors: readonly ReferencePredictor[],
        startOffset: number,
        endOffset: number,
        aggregate: "median" | "weighted",
    ): void => {
        profiles.set(name, new Map(years.map((year) => [
            year,
            aggregate === "median"
                ? predictiveMedianHuber(
                    corrected.get(year) ?? new Map(),
                    predictors,
                    year + startOffset,
                    year + endOffset,
                )
                : predictiveWeightedHuber(
                    corrected.get(year) ?? new Map(),
                    predictors,
                    year + startOffset,
                    year + endOffset,
                ),
        ])));
    };
    const addPredictiveFixed = (
        name: string,
        corrected: ReadonlyMap<number, NumericSeries>,
        predictors: readonly ReferencePredictor[],
        startYear: number,
        endYear: number,
        aggregate: "median" | "weighted",
    ): void => {
        profiles.set(name, new Map(years.map((year) => [
            year,
            aggregate === "median"
                ? predictiveMedianHuber(
                    corrected.get(year) ?? new Map(),
                    predictors,
                    startYear,
                    endYear,
                )
                : predictiveWeightedHuber(
                    corrected.get(year) ?? new Map(),
                    predictors,
                    startYear,
                    endYear,
                ),
        ])));
    };
    for (const [channel, corrected, predictors] of [
        ["raw", rawByYear, rawPredictors],
        ["difference", differenceByYear, differencePredictors],
    ] as const) {
        addPredictive(
            `${channel}PredictiveMedianHuberOlder5`,
            corrected,
            predictors,
            -4,
            -1,
            "median",
        );
        for (const radius of [1, 2, 4] as const) {
            const width = radius * 2 + 1;
            addPredictive(
                `${channel}PredictiveMedianHuberBoundary${width}`,
                corrected,
                predictors,
                -radius,
                radius,
                "median",
            );
            addPredictive(
                `${channel}PredictiveWeightedHuberBoundary${width}`,
                corrected,
                predictors,
                -radius,
                radius,
                "weighted",
            );
        }
        const consensus5 = referenceConsensusProfiles(
            years,
            corrected,
            predictors,
            (year) => ({ startYear: year - 2, endYear: year + 2 }),
        );
        profiles.set(`${channel}ReferenceRankMeanBoundary5`, consensus5.rankMean);
        profiles.set(`${channel}ReferenceRankMedianBoundary5`, consensus5.rankMedian);
        profiles.set(
            `${channel}ReferenceTopVoteBoundary5`,
            consensus5.topVoteFraction,
        );
        for (const padding of [0, 2, 6] as const) {
            const fixedRange = {
                startYear: window.startYear - padding,
                endYear: window.endYear + padding,
            };
            const suffix = padding === 0
                ? "Window"
                : `WindowPlus${padding * 2}`;
            addPredictiveFixed(
                `${channel}PredictiveMedianHuberFixed${suffix}`,
                corrected,
                predictors,
                fixedRange.startYear,
                fixedRange.endYear,
                "median",
            );
            addPredictiveFixed(
                `${channel}PredictiveWeightedHuberFixed${suffix}`,
                corrected,
                predictors,
                fixedRange.startYear,
                fixedRange.endYear,
                "weighted",
            );
            const consensus = referenceConsensusProfiles(
                years,
                corrected,
                predictors,
                () => fixedRange,
            );
            profiles.set(
                `${channel}ReferenceRankMeanFixed${suffix}`,
                consensus.rankMean,
            );
            profiles.set(
                `${channel}ReferenceRankMedianFixed${suffix}`,
                consensus.rankMedian,
            );
            profiles.set(
                `${channel}ReferenceTopVoteFixed${suffix}`,
                consensus.topVoteFraction,
            );
        }
    }
    const masterChannels: Array<readonly [
        string,
        NumericSeries,
        ReadonlyMap<number, NumericSeries>,
        NumericSeries,
    ]> = [
        ["raw", context.baselineRaw, rawByYear, diagnosis.master.data],
        [
            "difference",
            context.baselineDifference,
            differenceByYear,
            context.masterDifference,
        ],
    ];
    if (mergeOlderRawByYear && mergeOlderDifferenceByYear) {
        masterChannels.push(
            [
                "falseMergeOlderRaw",
                context.baselineRaw,
                mergeOlderRawByYear,
                diagnosis.master.data,
            ],
            [
                "falseMergeOlderDifference",
                context.baselineDifference,
                mergeOlderDifferenceByYear,
                context.masterDifference,
            ],
        );
    }
    for (const [channel, baselineChannel, corrected, master] of masterChannels) {
        for (const width of [5, 9, 13] as const) {
            const radius = Math.floor(width / 2);
            profiles.set(`${channel}MasterR${width}`, new Map(years.map((year) => [
                year,
                correlationForSegment(
                    corrected.get(year) ?? new Map(),
                    master,
                    year - radius,
                    year + radius,
                    0,
                    2,
                ).correlation ?? -1,
            ])));
            profiles.set(
                `${channel}MasterHuber${width}`,
                new Map(years.map((year) => [
                    year,
                    directHuber(
                        corrected.get(year) ?? new Map(),
                        master,
                        year - radius,
                        year + radius,
                    ),
                ])),
            );
            profiles.set(`${channel}MasterRGain${width}`, new Map(years.map((year) => {
                const startYear = year - radius;
                const endYear = year + radius;
                const correctedCorrelation = correlationForSegment(
                    corrected.get(year) ?? new Map(),
                    master,
                    startYear,
                    endYear,
                    0,
                    2,
                ).correlation;
                const baselineCorrelation = correlationForSegment(
                    baselineChannel,
                    master,
                    startYear,
                    endYear,
                    0,
                    2,
                ).correlation;
                return [
                    year,
                    correctedCorrelation === null || baselineCorrelation === null
                        ? -1
                        : correctedCorrelation - baselineCorrelation,
                ];
            })));
            profiles.set(
                `${channel}MasterHuberGain${width}`,
                new Map(years.map((year) => {
                    const startYear = year - radius;
                    const endYear = year + radius;
                    return [
                        year,
                        directHuber(
                            corrected.get(year) ?? new Map(),
                            master,
                            startYear,
                            endYear,
                        ) - directHuber(
                            baselineChannel,
                            master,
                            startYear,
                            endYear,
                        ),
                    ];
                })),
            );
        }
        for (const padding of [0, 2, 6] as const) {
            const startYear = window.startYear - padding;
            const endYear = window.endYear + padding;
            const suffix = padding === 0
                ? "Window"
                : `WindowPlus${padding * 2}`;
            profiles.set(
                `${channel}MasterRFixed${suffix}`,
                new Map(years.map((year) => [
                    year,
                    correlationForSegment(
                        corrected.get(year) ?? new Map(),
                        master,
                        startYear,
                        endYear,
                        0,
                        2,
                    ).correlation ?? -1,
                ])),
            );
            profiles.set(
                `${channel}MasterHuberFixed${suffix}`,
                new Map(years.map((year) => [
                    year,
                    directHuber(
                        corrected.get(year) ?? new Map(),
                        master,
                        startYear,
                        endYear,
                    ),
                ])),
            );
        }
    }
    if (eventType === "falseRing") {
        buildFalseBoundaryDiagnosticProfiles(context, diagnosis, years).forEach(
            (scores, name) => profiles.set(name, scores),
        );
    }
    return profiles;
};

const buildFalsePhysicalProfiles = (
    context: ExactYearContext,
    diagnosis: SeriesCoreDiagnosis,
    years: readonly number[],
): ReadonlyMap<string, ReadonlyMap<number, number>> => {
    const startYear = years[0] - 6;
    const endYear = years[years.length - 1] + 6;
    const window = { startYear: years[0], endYear: years[years.length - 1] };
    const directRaw = new Map(years.map((year) => [
        year,
        correctedRaw(context, diagnosis, "falseRing", year),
    ]));
    const directDifference = new Map(years.map((year) => [
        year,
        correctedDifference(context, diagnosis, "falseRing", year),
    ]));
    const mergeRaw = new Map(years.map((year) => [
        year,
        correctedRaw(context, diagnosis, "falseRing", year, "mergeOlder"),
    ]));
    const mergeDifference = new Map(years.map((year) => [
        year,
        correctedDifference(
            context,
            diagnosis,
            "falseRing",
            year,
            "mergeOlder",
        ),
    ]));
    const profiles = new Map<string, ReadonlyMap<number, number>>();
    for (const [prefix, corrected, master] of [
        ["raw", directRaw, diagnosis.master.data],
        ["difference", directDifference, context.masterDifference],
        ["falseMergeOlderRaw", mergeRaw, diagnosis.master.data],
        ["falseMergeOlderDifference", mergeDifference, context.masterDifference],
    ] as const) {
        profiles.set(
            `${prefix}MasterRFixedWindowPlus12`,
            new Map(years.map((year) => [
                year,
                correlationForSegment(
                    corrected.get(year) ?? new Map(),
                    master,
                    startYear,
                    endYear,
                    0,
                    2,
                ).correlation ?? -1,
            ])),
        );
        if (prefix.toLowerCase().includes("difference")) {
            profiles.set(
                `${prefix}MasterHuberFixedWindowPlus12`,
                new Map(years.map((year) => [
                    year,
                    directHuber(
                        corrected.get(year) ?? new Map(),
                        master,
                        startYear,
                        endYear,
                    ),
                ])),
            );
        }
    }
    const predictors = newerSidePredictors(
        context,
        diagnosis,
        window,
        "original",
    );
    profiles.set(
        "falseWidthWeightedMergeAdvantage",
        new Map(years.map((year) => [
            year,
            falseWidthFit(
                context.baselineOriginal,
                predictors,
                year,
                "weighted",
            ).mergeAdvantage,
        ])),
    );
    return profiles;
};

const boundedRange = (
    centerYear: number,
    width: number,
    diagnosis: SeriesCoreDiagnosis,
): { startYear: number; endYear: number } => {
    const half = Math.floor((width - 1) / 2);
    let startYear = centerYear - half;
    let endYear = startYear + width - 1;
    if (startYear < diagnosis.targetRange.startYear) {
        endYear += diagnosis.targetRange.startYear - startYear;
        startYear = diagnosis.targetRange.startYear;
    }
    if (endYear > diagnosis.targetRange.endYear) {
        startYear -= endYear - diagnosis.targetRange.endYear;
        endYear = diagnosis.targetRange.endYear;
    }
    return {
        startYear: Math.max(diagnosis.targetRange.startYear, startYear),
        endYear: Math.min(diagnosis.targetRange.endYear, endYear),
    };
};

export const scoreUnitEventExactYearEvidence = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    eventType: UnitEventExactYearEvidenceType,
    years: readonly number[],
    includeDiagnosticProfiles = false,
): UnitEventExactYearEvidence | null => {
    if (years.length === 0) return null;
    const context = buildContext(diagnosis, siteData);
    if (eventType === "missingRing") {
        const window = { startYear: years[0], endYear: years[years.length - 1] };
        const predictors = newerSidePredictors(context, diagnosis, window);
        const evidence: UnitEventExactYearEvidence = {
            scoreByYear: new Map(years.map((year) => [
                year,
                predictiveMedianHuber(
                    correctedDifference(context, diagnosis, eventType, year),
                    predictors,
                    year - 2,
                    year - 1,
                ),
            ])),
            profileName: "differencePredictiveMedianHuberOlder5",
            fixedWindowProfiles: buildMissingFixedWindowProfiles(
                context,
                diagnosis,
                years,
            ),
        };
        return includeDiagnosticProfiles ? {
            ...evidence,
            diagnosticProfiles: buildDiagnosticProfiles(
                context,
                diagnosis,
                eventType,
                years,
            ),
        } : evidence;
    }
    const centerYear = Math.round((years[0] + years[years.length - 1]) / 2);
    const range = boundedRange(centerYear, 61, diagnosis);
    const evidence: UnitEventExactYearEvidence = {
        scoreByYear: new Map(years.map((year) => [
            year,
            correlationForSegment(
                correctedDifference(context, diagnosis, eventType, year),
                context.masterDifference,
                range.startYear,
                range.endYear,
                0,
                Math.max(6, Math.floor((range.endYear - range.startYear + 1) * 0.5)),
            ).correlation ?? -1,
        ])),
        profileName: "differenceMasterR61",
        fixedWindowProfiles: buildFalsePhysicalProfiles(
            context,
            diagnosis,
            years,
        ),
    };
    return includeDiagnosticProfiles ? {
        ...evidence,
        diagnosticProfiles: buildDiagnosticProfiles(
            context,
            diagnosis,
            eventType,
            years,
        ),
    } : evidence;
};
