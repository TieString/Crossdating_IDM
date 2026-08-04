/**
 * Linear-time full-interval virtual insert/delete evidence.
 *
 * Pearson correlation only needs six sufficient statistics. An end-anchored unit edit is two
 * constant-lag ranges plus, for deletion, one bridge difference. Prefix statistics therefore
 * reproduce the virtual correction profile without cloning and rescoring the series per year.
 */
import type { NumericSeries, SeriesCoreDiagnosis } from "./types";

export type FullIntervalUnitEditEvidenceRow = {
    year: number;
    rawCorrelation: number;
    differenceCorrelation: number;
    combinedCorrelation: number;
    samplePairs: number;
    differencePairs: number;
    sideOlderAdvantage: number;
    sideNewerAdvantage: number;
    sideMinimumAdvantage: number;
    sideStepScore: number;
    correctedSideSupport: number;
    localSideOlderAdvantage11: number;
    localSideNewerAdvantage11: number;
    localSideStepScore11: number;
    localSideOlderAdvantage21: number;
    localSideNewerAdvantage21: number;
    localSideStepScore21: number;
    localSideOlderAdvantage31: number;
    localSideNewerAdvantage31: number;
    localSideStepScore31: number;
    olderSamplePairs: number;
    newerSamplePairs: number;
    olderDifferencePairs: number;
    newerDifferencePairs: number;
};

export type FullIntervalBaselineEvidence = {
    rawCorrelation: number;
    differenceCorrelation: number;
    combinedCorrelation: number;
    samplePairs: number;
    differencePairs: number;
};

type Sufficient = {
    count: number;
    sumX: number;
    sumY: number;
    sumXX: number;
    sumYY: number;
    sumXY: number;
};

type Prefix = {
    startYear: number;
    rows: Sufficient[];
};

type SideEvidence = {
    olderAdvantage: number;
    newerAdvantage: number;
    stepScore: number;
};

export type FullIntervalShiftEvidenceContext = {
    diagnosis: SeriesCoreDiagnosis;
    comparisonSeries: NumericSeries;
    baselineLag: number;
    startYear: number;
    endYear: number;
    target: NumericSeries;
    targetDifference: NumericSeries;
    masterDifference: NumericSeries;
    rawNewer: Prefix;
    differenceNewer: Prefix;
};

const empty = (): Sufficient => ({
    count: 0,
    sumX: 0,
    sumY: 0,
    sumXX: 0,
    sumYY: 0,
    sumXY: 0,
});

const add = (left: Sufficient, right: Sufficient): Sufficient => ({
    count: left.count + right.count,
    sumX: left.sumX + right.sumX,
    sumY: left.sumY + right.sumY,
    sumXX: left.sumXX + right.sumXX,
    sumYY: left.sumYY + right.sumYY,
    sumXY: left.sumXY + right.sumXY,
});

const subtract = (left: Sufficient, right: Sufficient): Sufficient => ({
    count: left.count - right.count,
    sumX: left.sumX - right.sumX,
    sumY: left.sumY - right.sumY,
    sumXX: left.sumXX - right.sumXX,
    sumYY: left.sumYY - right.sumYY,
    sumXY: left.sumXY - right.sumXY,
});

const pair = (x: number | undefined, y: number | undefined): Sufficient => (
    x === undefined || y === undefined
        ? empty()
        : {
            count: 1,
            sumX: x,
            sumY: y,
            sumXX: x * x,
            sumYY: y * y,
            sumXY: x * y,
        }
);

const differenceCache = new WeakMap<NumericSeries, NumericSeries>();

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const cached = differenceCache.get(series);
    if (cached) return cached;
    const entries = [...series.entries()].sort((a, b) => a[0] - b[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    differenceCache.set(series, result);
    return result;
};

const buildPrefix = (
    target: NumericSeries,
    master: NumericSeries,
    startYear: number,
    endYear: number,
    lag: number,
): Prefix => {
    const rows = [empty()];
    for (let year = startYear; year <= endYear; year += 1) {
        rows.push(add(
            rows[rows.length - 1],
            pair(target.get(year), master.get(year + lag)),
        ));
    }
    return { startYear, rows };
};

/**
 * Shares only the lag-0 side within one operation-grid scan. The context is deliberately
 * caller-owned and short-lived; retaining every shifted prefix on a series Map grows memory
 * linearly across repeated diagnoses.
 */
export const createFullIntervalShiftEvidenceContext = (
    diagnosis: SeriesCoreDiagnosis,
    comparisonSeries: NumericSeries = diagnosis.master.data,
    baselineLag = 0,
): FullIntervalShiftEvidenceContext => {
    const startYear = diagnosis.targetRange.startYear;
    const endYear = diagnosis.targetRange.endYear;
    const target = diagnosis.rawTarget;
    const targetDifference = firstDifferences(target);
    const masterDifference = firstDifferences(comparisonSeries);
    return {
        diagnosis,
        comparisonSeries,
        baselineLag,
        startYear,
        endYear,
        target,
        targetDifference,
        masterDifference,
        rawNewer: buildPrefix(
            target,
            comparisonSeries,
            startYear,
            endYear,
            baselineLag,
        ),
        differenceNewer: buildPrefix(
            targetDifference,
            masterDifference,
            startYear,
            endYear,
            baselineLag,
        ),
    };
};

const range = (
    prefix: Prefix,
    startYear: number,
    endYear: number,
): Sufficient => {
    if (endYear < startYear) return empty();
    const minimum = prefix.startYear;
    const maximum = minimum + prefix.rows.length - 2;
    const boundedStart = Math.max(minimum, startYear);
    const boundedEnd = Math.min(maximum, endYear);
    if (boundedEnd < boundedStart) return empty();
    return subtract(
        prefix.rows[boundedEnd - minimum + 1],
        prefix.rows[boundedStart - minimum],
    );
};

const correlation = (row: Sufficient, minPairs: number): number => {
    if (row.count < minPairs) return -1;
    const numerator = row.sumXY - row.sumX * row.sumY / row.count;
    const varianceX = row.sumXX - row.sumX * row.sumX / row.count;
    const varianceY = row.sumYY - row.sumY * row.sumY / row.count;
    const denominator = Math.sqrt(Math.max(0, varianceX) * Math.max(0, varianceY));
    return denominator > 0 ? numerator / denominator : -1;
};

const optionalCorrelation = (
    row: Sufficient,
    minPairs: number,
): number | null => {
    if (row.count < minPairs) return null;
    const value = correlation(row, minPairs);
    return value > -1 ? value : null;
};

const sideEvidence = (
    rawOlderCorrected: Sufficient,
    rawOlderBaseline: Sufficient,
    rawNewerFixed: Sufficient,
    rawNewerShifted: Sufficient,
    differenceOlderCorrected: Sufficient,
    differenceOlderBaseline: Sufficient,
    differenceNewerFixed: Sufficient,
    differenceNewerShifted: Sufficient,
    minimumPairs: number,
): SideEvidence => {
    const correlations = [
        optionalCorrelation(rawOlderCorrected, minimumPairs),
        optionalCorrelation(rawOlderBaseline, minimumPairs),
        optionalCorrelation(rawNewerFixed, minimumPairs),
        optionalCorrelation(rawNewerShifted, minimumPairs),
        optionalCorrelation(differenceOlderCorrected, minimumPairs),
        optionalCorrelation(differenceOlderBaseline, minimumPairs),
        optionalCorrelation(differenceNewerFixed, minimumPairs),
        optionalCorrelation(differenceNewerShifted, minimumPairs),
    ];
    if (correlations.some((value) => value === null)) {
        return {
            olderAdvantage: Number.NEGATIVE_INFINITY,
            newerAdvantage: Number.NEGATIVE_INFINITY,
            stepScore: Number.NEGATIVE_INFINITY,
        };
    }
    const [
        rawOlderCorrectedCorrelation,
        rawOlderBaselineCorrelation,
        rawNewerFixedCorrelation,
        rawNewerShiftedCorrelation,
        differenceOlderCorrectedCorrelation,
        differenceOlderBaselineCorrelation,
        differenceNewerFixedCorrelation,
        differenceNewerShiftedCorrelation,
    ] = correlations as number[];
    const olderAdvantage = (
        rawOlderCorrectedCorrelation - rawOlderBaselineCorrelation
    ) * 0.3 + (
        differenceOlderCorrectedCorrelation
        - differenceOlderBaselineCorrelation
    ) * 0.7;
    const newerAdvantage = (
        rawNewerFixedCorrelation - rawNewerShiftedCorrelation
    ) * 0.3 + (
        differenceNewerFixedCorrelation
        - differenceNewerShiftedCorrelation
    ) * 0.7;
    return {
        olderAdvantage,
        newerAdvantage,
        stepScore: Math.min(olderAdvantage, newerAdvantage)
            + (olderAdvantage + newerAdvantage) * 0.05,
    };
};

export const scoreFullIntervalShiftEvidence = (
    diagnosis: SeriesCoreDiagnosis,
    shiftYears: number,
    edgeYears = 15,
    comparisonSeries: NumericSeries = diagnosis.master.data,
    baselineLag = 0,
    sharedContext?: FullIntervalShiftEvidenceContext,
): FullIntervalUnitEditEvidenceRow[] => {
    if (!Number.isInteger(shiftYears) || shiftYears === 0) return [];
    const context = sharedContext ?? createFullIntervalShiftEvidenceContext(
        diagnosis,
        comparisonSeries,
        baselineLag,
    );
    const {
        startYear,
        endYear,
        target,
        targetDifference,
        masterDifference,
        rawNewer,
        differenceNewer,
    } = context;
    const master = context.comparisonSeries;
    const rawOlder = buildPrefix(
        target,
        master,
        startYear,
        endYear,
        baselineLag + shiftYears,
    );
    const differenceOlder = buildPrefix(
        targetDifference,
        masterDifference,
        startYear,
        endYear,
        baselineLag + shiftYears,
    );
    const candidateYears = [...target.keys()]
        .filter((year) => (
            year >= startYear + edgeYears
            && year <= endYear - edgeYears
        ))
        .sort((left, right) => left - right);
    const sideMinimumPairs = Math.max(8, Math.min(20, edgeYears));
    return candidateYears.map((year): FullIntervalUnitEditEvidenceRow => {
        const olderStart = startYear;
        const olderEnd = shiftYears > 0 ? year - shiftYears : year;
        const rawOlderCorrected = range(rawOlder, olderStart, olderEnd);
        const rawOlderBaseline = range(rawNewer, olderStart, olderEnd);
        const rawNewerFixed = range(rawNewer, year + 1, endYear);
        const rawNewerShifted = range(rawOlder, year + 1, endYear);
        let raw = add(rawOlderCorrected, rawNewerFixed);
        if (shiftYears > 0) {
            for (
                let sourceYear = olderEnd + 1;
                sourceYear <= year;
                sourceYear += 1
            ) {
                if (shiftYears === 1 && sourceYear === year) continue;
                const destinationYear = sourceYear + shiftYears;
                if (!target.has(destinationYear)) {
                    raw = add(
                        raw,
                        pair(target.get(sourceYear), master.get(destinationYear)),
                    );
                }
            }
        }
        const differenceOlderCorrected = range(
            differenceOlder,
            startYear + 1,
            olderEnd,
        );
        const differenceOlderBaseline = range(
            differenceNewer,
            startYear + 1,
            olderEnd,
        );
        const differenceNewerStart =
            shiftYears > 0 ? year + shiftYears + 2 : year + 2;
        const differenceNewerFixed = range(
            differenceNewer,
            differenceNewerStart,
            endYear,
        );
        const differenceNewerShifted = range(
            differenceOlder,
            differenceNewerStart,
            endYear,
        );
        let difference = add(
            differenceOlderCorrected,
            differenceNewerFixed,
        );
        if (shiftYears > 0) {
            const correctedValue = (destinationYear: number): number | undefined => {
                if (destinationYear > year && target.has(destinationYear)) {
                    return target.get(destinationYear);
                }
                const sourceYear = destinationYear - shiftYears;
                return sourceYear <= year
                    && !(shiftYears === 1 && sourceYear === year)
                    ? target.get(sourceYear)
                    : undefined;
            };
            for (
                let destinationYear = year + 1;
                destinationYear <= year + shiftYears + 1;
                destinationYear += 1
            ) {
                const previous = correctedValue(destinationYear - 1);
                const next = correctedValue(destinationYear);
                difference = add(
                    difference,
                    pair(
                        previous === undefined || next === undefined
                            ? undefined
                            : next - previous,
                        masterDifference.get(destinationYear),
                    ),
                );
            }
        }
        const rawCorrelation = correlation(raw, 30);
        const differenceCorrelation = correlation(difference, 30);
        const sideCorrelations = [
            optionalCorrelation(rawOlderCorrected, sideMinimumPairs),
            optionalCorrelation(rawOlderBaseline, sideMinimumPairs),
            optionalCorrelation(rawNewerFixed, sideMinimumPairs),
            optionalCorrelation(rawNewerShifted, sideMinimumPairs),
            optionalCorrelation(differenceOlderCorrected, sideMinimumPairs),
            optionalCorrelation(differenceOlderBaseline, sideMinimumPairs),
            optionalCorrelation(differenceNewerFixed, sideMinimumPairs),
            optionalCorrelation(differenceNewerShifted, sideMinimumPairs),
        ];
        const hasSideEvidence = sideCorrelations.every(
            (value) => value !== null,
        );
        const [
            rawOlderCorrectedCorrelation,
            rawOlderBaselineCorrelation,
            rawNewerFixedCorrelation,
            rawNewerShiftedCorrelation,
            differenceOlderCorrectedCorrelation,
            differenceOlderBaselineCorrelation,
            differenceNewerFixedCorrelation,
            differenceNewerShiftedCorrelation,
        ] = hasSideEvidence ? sideCorrelations as number[] : [];
        const sideOlderAdvantage = hasSideEvidence
            ? (
                rawOlderCorrectedCorrelation - rawOlderBaselineCorrelation
            ) * 0.3 + (
                differenceOlderCorrectedCorrelation
                - differenceOlderBaselineCorrelation
            ) * 0.7
            : Number.NEGATIVE_INFINITY;
        const sideNewerAdvantage = hasSideEvidence
            ? (
                rawNewerFixedCorrelation - rawNewerShiftedCorrelation
            ) * 0.3 + (
                differenceNewerFixedCorrelation
                - differenceNewerShiftedCorrelation
            ) * 0.7
            : Number.NEGATIVE_INFINITY;
        const sideMinimumAdvantage = Math.min(
            sideOlderAdvantage,
            sideNewerAdvantage,
        );
        const correctedSideSupport = hasSideEvidence
            ? Math.min(
                rawOlderCorrectedCorrelation * 0.3
                    + differenceOlderCorrectedCorrelation * 0.7,
                rawNewerFixedCorrelation * 0.3
                    + differenceNewerFixedCorrelation * 0.7,
            )
            : Number.NEGATIVE_INFINITY;
        const localSideEvidence = (sideYears: number): SideEvidence => {
            const minimumPairs = Math.max(5, Math.floor(sideYears * 0.55));
            const rawOlderStart = Math.max(
                olderStart,
                olderEnd - sideYears + 1,
            );
            const rawNewerStart = year + 1;
            const rawNewerEnd = Math.min(
                endYear,
                rawNewerStart + sideYears - 1,
            );
            const differenceOlderStart = Math.max(
                startYear + 1,
                olderEnd - sideYears + 1,
            );
            const differenceNewerEnd = Math.min(
                endYear,
                differenceNewerStart + sideYears - 1,
            );
            return sideEvidence(
                range(rawOlder, rawOlderStart, olderEnd),
                range(rawNewer, rawOlderStart, olderEnd),
                range(rawNewer, rawNewerStart, rawNewerEnd),
                range(rawOlder, rawNewerStart, rawNewerEnd),
                range(
                    differenceOlder,
                    differenceOlderStart,
                    olderEnd,
                ),
                range(
                    differenceNewer,
                    differenceOlderStart,
                    olderEnd,
                ),
                range(
                    differenceNewer,
                    differenceNewerStart,
                    differenceNewerEnd,
                ),
                range(
                    differenceOlder,
                    differenceNewerStart,
                    differenceNewerEnd,
                ),
                minimumPairs,
            );
        };
        const local11 = localSideEvidence(11);
        const local21 = localSideEvidence(21);
        const local31 = localSideEvidence(31);
        return {
            year,
            rawCorrelation,
            differenceCorrelation,
            combinedCorrelation: rawCorrelation * 0.3 + differenceCorrelation * 0.7,
            samplePairs: raw.count,
            differencePairs: difference.count,
            sideOlderAdvantage,
            sideNewerAdvantage,
            sideMinimumAdvantage,
            sideStepScore: Number.isFinite(sideMinimumAdvantage)
                ? sideMinimumAdvantage
                    + (sideOlderAdvantage + sideNewerAdvantage) * 0.05
                    + Math.max(-0.25, correctedSideSupport) * 0.05
                : Number.NEGATIVE_INFINITY,
            correctedSideSupport,
            localSideOlderAdvantage11: local11.olderAdvantage,
            localSideNewerAdvantage11: local11.newerAdvantage,
            localSideStepScore11: local11.stepScore,
            localSideOlderAdvantage21: local21.olderAdvantage,
            localSideNewerAdvantage21: local21.newerAdvantage,
            localSideStepScore21: local21.stepScore,
            localSideOlderAdvantage31: local31.olderAdvantage,
            localSideNewerAdvantage31: local31.newerAdvantage,
            localSideStepScore31: local31.stepScore,
            olderSamplePairs: rawOlderCorrected.count,
            newerSamplePairs: rawNewerFixed.count,
            olderDifferencePairs: differenceOlderCorrected.count,
            newerDifferencePairs: differenceNewerFixed.count,
        };
    });
};

export const scoreFullIntervalBaselineEvidence = (
    diagnosis: SeriesCoreDiagnosis,
    comparisonSeries: NumericSeries = diagnosis.master.data,
    baselineLag = 0,
): FullIntervalBaselineEvidence => {
    const startYear = diagnosis.targetRange.startYear;
    const endYear = diagnosis.targetRange.endYear;
    const target = diagnosis.rawTarget;
    const targetDifference = firstDifferences(target);
    const comparisonDifference = firstDifferences(comparisonSeries);
    const raw = range(
        buildPrefix(
            target,
            comparisonSeries,
            startYear,
            endYear,
            baselineLag,
        ),
        startYear,
        endYear,
    );
    const difference = range(
        buildPrefix(
            targetDifference,
            comparisonDifference,
            startYear,
            endYear,
            baselineLag,
        ),
        startYear + 1,
        endYear,
    );
    const rawCorrelation = correlation(raw, 30);
    const differenceCorrelation = correlation(difference, 30);
    return {
        rawCorrelation,
        differenceCorrelation,
        combinedCorrelation:
            rawCorrelation * 0.3 + differenceCorrelation * 0.7,
        samplePairs: raw.count,
        differencePairs: difference.count,
    };
};

export const scoreFullIntervalUnitEditEvidence = (
    diagnosis: SeriesCoreDiagnosis,
    editType: "insert" | "delete",
    edgeYears = 15,
    comparisonSeries: NumericSeries = diagnosis.master.data,
): FullIntervalUnitEditEvidenceRow[] => scoreFullIntervalShiftEvidence(
    diagnosis,
    editType === "insert" ? -1 : 1,
    edgeYears,
    comparisonSeries,
);
