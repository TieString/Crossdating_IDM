/**
 * Signal-only audit for recovering an event after the conservative ensemble abstains.
 *
 * Presence/type evidence and location evidence intentionally come from different objectives:
 * piecewise correlation gain gates the event, while cumulative change-point peaks locate it.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import {
    ar1WhitenSeries,
    correlationForSegment,
    preprocessSeries,
} from "./series";
import {
    scoreCumulativeLagChangePoints,
    type CumulativeLagChangePointScore,
} from "./cumulativeLagChangePoint";
import {
    scorePiecewiseChangePoints,
    type PiecewiseChangePointScore,
} from "./piecewiseChangePoint";
import {
    DEFAULT_MAX_PARTIAL_GAP_YEARS,
    firstFixedYearFromLastMovedYear,
    getAutomaticEventShiftCandidates,
    isNegativePartialShift,
} from "./partialMoveSemantics";
import type { DiagnosisEventType, SeriesCoreDiagnosis } from "./types";

type RecoverableEventType = Exclude<DiagnosisEventType, "wholeSeriesMove">;
type CumulativeScoreKey =
    | "combinedCumulative"
    | "differenceCumulative"
    | "whitenedCumulative";

export type GainGatedRecoveryLocation = {
    year: number;
    score: number;
};

export type GainGatedRecoveryVerification = {
    year: number;
    rawGain: number;
    differenceGain: number;
    whitenedGain: number;
    combinedGain: number;
};

export type GainGatedRecoveryHypothesis = {
    eventType: RecoverableEventType;
    shiftYears: number;
    gateYear: number;
    combinedGain: number;
    rawGain: number;
    cofechaGain: number;
    whitenedGain: number;
    differenceGain: number;
    combinedObjective: number;
    locations: GainGatedRecoveryLocation[];
    locationVerification?: GainGatedRecoveryVerification[];
};

export type GainGatedRecoveryOptions = {
    lags: number[];
    maxPartialGapYears: number;
    minSideYears: number;
    maximumLocations: number;
    unitWindowYears: number;
    partialWindowYears: number;
    verifyLocationCorrections: boolean;
    verificationHypothesisCount: number;
    fullVerificationHypothesisCount: number;
    verificationLocationCount: number;
    supplementalVerificationLocationCount: number;
};

export const DEFAULT_GAIN_GATED_RECOVERY_OPTIONS: GainGatedRecoveryOptions = {
    lags: getAutomaticEventShiftCandidates({
        maxPartialGapYears: DEFAULT_MAX_PARTIAL_GAP_YEARS,
        lagMin: -DEFAULT_MAX_PARTIAL_GAP_YEARS,
    }),
    maxPartialGapYears: DEFAULT_MAX_PARTIAL_GAP_YEARS,
    minSideYears: 18,
    maximumLocations: 5,
    unitWindowYears: 7,
    partialWindowYears: 9,
    verifyLocationCorrections: false,
    verificationHypothesisCount: 6,
    fullVerificationHypothesisCount: 6,
    verificationLocationCount: 2,
    supplementalVerificationLocationCount: 2,
};

export const verificationLocationCountForHypothesis = (
    hypothesisIndex: number,
    options: Pick<
        GainGatedRecoveryOptions,
        | "fullVerificationHypothesisCount"
        | "verificationLocationCount"
        | "supplementalVerificationLocationCount"
    >,
): number => (
    hypothesisIndex < Math.max(1, options.fullVerificationHypothesisCount)
        ? options.verificationLocationCount
        : options.supplementalVerificationLocationCount
);

export type GainGatedRecoveryAnalysis = {
    hypotheses: GainGatedRecoveryHypothesis[];
    piecewiseScores: PiecewiseChangePointScore[];
    cumulativeScores: CumulativeLagChangePointScore[];
    verificationContext?: GainGatedRecoveryVerificationContext;
};

const eventTypeForLag = (lag: number): RecoverableEventType | null => (
    lag === -1
        ? "missingRing"
        : lag === 1
            ? "falseRing"
            : isNegativePartialShift(lag)
                ? "partialMove"
                : null
);

const scoreKeyForLag = (lag: number): CumulativeScoreKey => (
    lag === -1
        ? "whitenedCumulative"
        : lag === 1
            ? "combinedCumulative"
            : "differenceCumulative"
);

const bestGainForLag = (
    rows: PiecewiseChangePointScore[],
    lag: number,
): PiecewiseChangePointScore | null => rows
    .filter((row) => row.olderLag === lag)
    .sort((left, right) => (
        right.combinedGain - left.combinedGain
        || right.combinedObjective - left.combinedObjective
        || right.year - left.year
    ))[0] ?? null;

const separatedLocations = (
    rows: CumulativeLagChangePointScore[],
    lag: number,
    scoreKey: CumulativeScoreKey,
    windowYears: number,
    maximumLocations: number,
): GainGatedRecoveryLocation[] => {
    const selected: GainGatedRecoveryLocation[] = [];
    rows
        .filter((row) => row.olderLag === lag)
        .sort((left, right) => (
            right[scoreKey] - left[scoreKey]
            || right.year - left.year
        ))
        .forEach((row) => {
            if (selected.length >= maximumLocations) return;
            if (selected.every((other) => Math.abs(other.year - row.year) > windowYears)) {
                selected.push({ year: row.year, score: row[scoreKey] });
            }
        });
    return selected;
};

const firstDifferences = (series: Map<number, number>): Map<number, number> => {
    const entries = [...series.entries()].sort((left, right) => left[0] - right[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return preprocessSeries(result);
};

const correctedAt = (
    diagnosis: SeriesCoreDiagnosis,
    eventType: RecoverableEventType,
    shiftYears: number,
    year: number,
): Map<number, number> => {
    const corrected = new Map<number, number>();
    diagnosis.rawTarget.forEach((value, sourceYear) => {
        if (eventType === "missingRing") {
            corrected.set(sourceYear <= year ? sourceYear - 1 : sourceYear, value);
        } else if (eventType === "falseRing") {
            if (sourceYear !== year) {
                corrected.set(sourceYear < year ? sourceYear + 1 : sourceYear, value);
            }
        } else {
            corrected.set(sourceYear < year ? sourceYear + shiftYears : sourceYear, value);
        }
    });
    return corrected;
};

const fullCorrelation = (
    target: Map<number, number>,
    master: Map<number, number>,
    diagnosis: SeriesCoreDiagnosis,
): number => correlationForSegment(
    target,
    master,
    diagnosis.targetRange.startYear,
    diagnosis.targetRange.endYear,
    0,
    30,
).correlation ?? -1;

export type GainGatedRecoveryVerificationContext = {
    rawMaster: Map<number, number>;
    differenceMaster: Map<number, number>;
    whitenedMaster: Map<number, number>;
    baseline: {
        raw: number;
        difference: number;
        whitened: number;
    };
    cache: Map<string, GainGatedRecoveryVerification>;
};

export const buildGainGatedRecoveryVerificationContext = (
    diagnosis: SeriesCoreDiagnosis,
): GainGatedRecoveryVerificationContext => {
    const rawMaster = preprocessSeries(diagnosis.master.data);
    const differenceMaster = firstDifferences(diagnosis.master.data);
    const whitenedMaster = ar1WhitenSeries(diagnosis.master.data);
    return {
        rawMaster,
        differenceMaster,
        whitenedMaster,
        baseline: {
            raw: fullCorrelation(
                preprocessSeries(diagnosis.rawTarget),
                rawMaster,
                diagnosis,
            ),
            difference: fullCorrelation(
                firstDifferences(diagnosis.rawTarget),
                differenceMaster,
                diagnosis,
            ),
            whitened: fullCorrelation(
                ar1WhitenSeries(diagnosis.rawTarget),
                whitenedMaster,
                diagnosis,
            ),
        },
        cache: new Map(),
    };
};

export const verifyGainGatedRecoveryYears = (
    diagnosis: SeriesCoreDiagnosis,
    context: GainGatedRecoveryVerificationContext,
    eventType: RecoverableEventType,
    shiftYears: number,
    years: number[],
): GainGatedRecoveryVerification[] => Array.from(new Set(years))
    .map((year): GainGatedRecoveryVerification => {
        const cacheKey = `${eventType}:${shiftYears}:${year}`;
        const cached = context.cache.get(cacheKey);
        if (cached) return cached;
        const corrected = correctedAt(diagnosis, eventType, shiftYears, year);
        const raw = fullCorrelation(
            preprocessSeries(corrected),
            context.rawMaster,
            diagnosis,
        );
        const difference = fullCorrelation(
            firstDifferences(corrected),
            context.differenceMaster,
            diagnosis,
        );
        const whitened = fullCorrelation(
            ar1WhitenSeries(corrected),
            context.whitenedMaster,
            diagnosis,
        );
        const rawGain = raw - context.baseline.raw;
        const differenceGain = difference - context.baseline.difference;
        const whitenedGain = whitened - context.baseline.whitened;
        const verification = {
            year,
            rawGain,
            differenceGain,
            whitenedGain,
            combinedGain: rawGain * 0.2 + differenceGain * 0.5 + whitenedGain * 0.3,
        };
        context.cache.set(cacheKey, verification);
        return verification;
    })
    .sort((left, right) => (
        right.combinedGain - left.combinedGain
        || right.differenceGain - left.differenceGain
        || right.year - left.year
    ));

const verifyLocations = (
    diagnosis: SeriesCoreDiagnosis,
    context: GainGatedRecoveryVerificationContext,
    eventType: RecoverableEventType,
    shiftYears: number,
    locations: GainGatedRecoveryLocation[],
    windowYears: number,
    locationCount: number,
): GainGatedRecoveryVerification[] => {
    const halfWindow = Math.floor((windowYears - 1) / 2);
    const years = new Set<number>();
    locations.slice(0, locationCount).forEach((location) => {
        for (
            let year = location.year - halfWindow;
            year <= location.year + halfWindow;
            year += 1
        ) {
            if (year >= diagnosis.targetRange.startYear
                && year <= diagnosis.targetRange.endYear) {
                years.add(year);
            }
        }
    });
    return verifyGainGatedRecoveryYears(
        diagnosis,
        context,
        eventType,
        shiftYears,
        [...years],
    );
};

export const analyzeGainGatedRecovery = (
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis | null,
    siteData: RwlSiteData,
    overrides: Partial<GainGatedRecoveryOptions> = {},
): GainGatedRecoveryAnalysis => {
    const baseOptions = { ...DEFAULT_GAIN_GATED_RECOVERY_OPTIONS, ...overrides };
    const options = {
        ...baseOptions,
        lags: overrides.lags ?? getAutomaticEventShiftCandidates({
            maxPartialGapYears: baseOptions.maxPartialGapYears,
            lagMin: -baseOptions.maxPartialGapYears,
            seriesLength:
                diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
            minimumSideYears: baseOptions.minSideYears,
        }),
    };
    const piecewise = scorePiecewiseChangePoints(diagnosis, cofechaDiagnosis, {
        lags: options.lags,
        minSideYears: options.minSideYears,
    });
    const cumulative = scoreCumulativeLagChangePoints(diagnosis, cofechaDiagnosis, {
        lags: options.lags,
        minSideYears: options.minSideYears,
        siteData,
    });

    const baseHypotheses = options.lags.flatMap((lag): GainGatedRecoveryHypothesis[] => {
        const gate = bestGainForLag(piecewise, lag);
        if (!gate) return [];
        const eventType = eventTypeForLag(lag);
        if (eventType === null) return [];
        const windowYears = eventType === "partialMove"
            ? options.partialWindowYears
            : options.unitWindowYears;
        const internalLocations = separatedLocations(
            cumulative,
            lag,
            scoreKeyForLag(lag),
            windowYears,
            options.maximumLocations,
        );
        const locations = eventType === "partialMove"
            ? internalLocations.map((location) => ({
                ...location,
                year: firstFixedYearFromLastMovedYear(location.year),
            }))
            : internalLocations;
        return [{
            eventType,
            shiftYears: lag,
            gateYear: eventType === "partialMove"
                ? firstFixedYearFromLastMovedYear(gate.year)
                : gate.year,
            combinedGain: gate.combinedGain,
            rawGain: gate.rawGain,
            cofechaGain: gate.cofechaGain,
            whitenedGain: gate.whitenedGain,
            differenceGain: gate.differenceGain,
            combinedObjective: gate.combinedObjective,
            locations,
        }];
    }).sort((left, right) => (
        right.combinedGain - left.combinedGain
        || right.combinedObjective - left.combinedObjective
    ));
    if (!options.verifyLocationCorrections) {
        return {
            hypotheses: baseHypotheses,
            piecewiseScores: piecewise,
            cumulativeScores: cumulative,
        };
    }

    const verificationContext = buildGainGatedRecoveryVerificationContext(diagnosis);
    const verifiedSignatures = new Set(
        baseHypotheses
            .slice(0, Math.max(1, options.verificationHypothesisCount))
            .map((hypothesis) => `${hypothesis.eventType}:${hypothesis.shiftYears}`),
    );
    const hypotheses = baseHypotheses.map((hypothesis, hypothesisIndex) => {
        const signature = `${hypothesis.eventType}:${hypothesis.shiftYears}`;
        if (!verifiedSignatures.has(signature)) return hypothesis;
        const windowYears = hypothesis.eventType === "partialMove"
            ? options.partialWindowYears
            : options.unitWindowYears;
        const locationCount = verificationLocationCountForHypothesis(
            hypothesisIndex,
            options,
        );
        return {
            ...hypothesis,
            locationVerification: verifyLocations(
                diagnosis,
                verificationContext,
                hypothesis.eventType,
                hypothesis.shiftYears,
                hypothesis.locations,
                windowYears,
                locationCount,
            ),
        };
    });
    return {
        hypotheses,
        piecewiseScores: piecewise,
        cumulativeScores: cumulative,
        verificationContext,
    };
};

export const scoreGainGatedRecoveryHypotheses = (
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis | null,
    siteData: RwlSiteData,
    overrides: Partial<GainGatedRecoveryOptions> = {},
): GainGatedRecoveryHypothesis[] => analyzeGainGatedRecovery(
    diagnosis,
    cofechaDiagnosis,
    siteData,
    overrides,
).hypotheses;
