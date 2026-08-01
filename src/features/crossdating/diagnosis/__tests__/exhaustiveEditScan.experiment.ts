import {
    ar1WhitenSeries,
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "../series";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    firstFixedYearFromLastMovedYear,
    getAutomaticPartialShiftCandidates,
} from "../partialMoveSemantics";
import type { NumericSeries, SeriesCoreDiagnosis } from "../types";

export type ExhaustiveScoreName = "raw" | "difference" | "whitened" | "combo";

export type ExhaustiveEditScore = {
    year: number;
    shiftYears?: number;
    raw: number;
    difference: number;
    whitened: number;
    combo: number;
};

export type LocalizedExhaustiveScore = ExhaustiveEditScore & {
    differenceGain21: number;
    differenceGain31: number;
    differenceGain41: number;
    differenceGain61: number;
    whitenedGain31: number;
    whitenedGain61: number;
};

export type LocalizedScoreName = keyof Pick<LocalizedExhaustiveScore,
    | "differenceGain21"
    | "differenceGain31"
    | "differenceGain41"
    | "differenceGain61"
    | "whitenedGain31"
    | "whitenedGain61"
>;

export type PairwiseExhaustiveScore = {
    year: number;
    shiftYears?: number;
    differenceMean: number;
    differenceMedian: number;
    differenceTrimmed: number;
    differenceWeighted: number;
    whitenedMean: number;
    whitenedMedian: number;
    differenceMeanGain: number;
    differenceMedianGain: number;
    differenceTrimmedGain: number;
    differenceWeightedGain: number;
    whitenedMeanGain: number;
    whitenedMedianGain: number;
};

export type PairwiseScoreName = Exclude<keyof PairwiseExhaustiveScore, "year" | "shiftYears">;

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return preprocessSeries(result);
};

const mean = (values: number[]): number => (
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : -1
);

const median = (values: number[]): number => {
    if (values.length === 0) return -1;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

type PairwiseReference = {
    data: NumericSeries;
    weight: number;
};

const pairwiseReferences = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    transform: (series: NumericSeries) => NumericSeries,
): PairwiseReference[] => {
    const baseline = transform(diagnosis.rawTarget);
    return diagnosis.master.sourceTrees
        .map((tree) => {
            const data = transform(toNumericSeries(siteData.get(tree)));
            const referenceR = correlationForSegment(
                baseline,
                data,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
                0,
                30,
            ).correlation;
            return {
                data,
                correlation: referenceR ?? -1,
                weight: Math.max(0, referenceR ?? 0) + 0.1,
            };
        })
        .filter((reference) => reference.correlation > -0.25)
        .sort((a, b) => b.correlation - a.correlation)
        .slice(0, 16);
};

const pairwiseCorrelations = (
    corrected: NumericSeries,
    references: PairwiseReference[],
    diagnosis: SeriesCoreDiagnosis,
): Array<{ correlation: number; weight: number }> => references
    .map((reference) => ({
        correlation: correlationForSegment(
            corrected,
            reference.data,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
            0,
            30,
        ).correlation,
        weight: reference.weight,
    }))
    .filter((row): row is { correlation: number; weight: number } => row.correlation !== null);

const aggregatePairwise = (
    rows: Array<{ correlation: number; weight: number }>,
): { mean: number; median: number; trimmed: number; weighted: number } => {
    if (rows.length === 0) return { mean: -1, median: -1, trimmed: -1, weighted: -1 };
    const values = rows.map((row) => row.correlation).sort((a, b) => a - b);
    const trim = Math.floor(values.length * 0.2);
    const trimmed = values.slice(trim, Math.max(trim + 1, values.length - trim));
    const weightSum = rows.reduce((sum, row) => sum + row.weight, 0);
    return {
        mean: mean(values),
        median: median(values),
        trimmed: mean(trimmed),
        weighted: weightSum > 0
            ? rows.reduce((sum, row) => sum + row.correlation * row.weight, 0) / weightSum
            : mean(values),
    };
};

type PairwiseContext = {
    differenceReferences: PairwiseReference[];
    whitenedReferences: PairwiseReference[];
    differenceBaseline: ReturnType<typeof aggregatePairwise>;
    whitenedBaseline: ReturnType<typeof aggregatePairwise>;
};

const buildPairwiseContext = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
): PairwiseContext => {
    const differenceReferences = pairwiseReferences(diagnosis, siteData, firstDifferences);
    const whitenedReferences = pairwiseReferences(diagnosis, siteData, ar1WhitenSeries);
    return {
        differenceReferences,
        whitenedReferences,
        differenceBaseline: aggregatePairwise(pairwiseCorrelations(
            firstDifferences(diagnosis.rawTarget),
            differenceReferences,
            diagnosis,
        )),
        whitenedBaseline: aggregatePairwise(pairwiseCorrelations(
            ar1WhitenSeries(diagnosis.rawTarget),
            whitenedReferences,
            diagnosis,
        )),
    };
};

const pairwiseScore = (
    corrected: NumericSeries,
    diagnosis: SeriesCoreDiagnosis,
    context: PairwiseContext,
    year: number,
    shiftYears?: number,
): PairwiseExhaustiveScore => {
    const difference = aggregatePairwise(pairwiseCorrelations(
        firstDifferences(corrected),
        context.differenceReferences,
        diagnosis,
    ));
    const whitened = aggregatePairwise(pairwiseCorrelations(
        ar1WhitenSeries(corrected),
        context.whitenedReferences,
        diagnosis,
    ));
    return {
        year,
        ...(shiftYears === undefined ? {} : { shiftYears }),
        differenceMean: difference.mean,
        differenceMedian: difference.median,
        differenceTrimmed: difference.trimmed,
        differenceWeighted: difference.weighted,
        whitenedMean: whitened.mean,
        whitenedMedian: whitened.median,
        differenceMeanGain: difference.mean - context.differenceBaseline.mean,
        differenceMedianGain: difference.median - context.differenceBaseline.median,
        differenceTrimmedGain: difference.trimmed - context.differenceBaseline.trimmed,
        differenceWeightedGain: difference.weighted - context.differenceBaseline.weighted,
        whitenedMeanGain: whitened.mean - context.whitenedBaseline.mean,
        whitenedMedianGain: whitened.median - context.whitenedBaseline.median,
    };
};

const correlation = (
    target: NumericSeries,
    master: NumericSeries,
    startYear: number,
    endYear: number,
): number => correlationForSegment(
    target,
    master,
    startYear,
    endYear,
    0,
    30,
).correlation ?? -1;

const localGain = (
    corrected: NumericSeries,
    baseline: NumericSeries,
    master: NumericSeries,
    centerYear: number,
    width: number,
): number => {
    const half = Math.floor((width - 1) / 2);
    const minPairs = Math.max(8, Math.floor(width * 0.55));
    const correctedR = correlationForSegment(
        corrected,
        master,
        centerYear - half,
        centerYear + half,
        0,
        minPairs,
    ).correlation;
    const baselineR = correlationForSegment(
        baseline,
        master,
        centerYear - half,
        centerYear + half,
        0,
        minPairs,
    ).correlation;
    return (correctedR ?? -1) - (baselineR ?? -1);
};

type LocalizedContext = {
    differenceBaseline: NumericSeries;
    differenceMaster: NumericSeries;
    whitenedBaseline: NumericSeries;
    whitenedMaster: NumericSeries;
};

const localizedContext = (diagnosis: SeriesCoreDiagnosis): LocalizedContext => ({
    differenceBaseline: firstDifferences(diagnosis.rawTarget),
    differenceMaster: firstDifferences(diagnosis.master.data),
    whitenedBaseline: ar1WhitenSeries(diagnosis.rawTarget),
    whitenedMaster: ar1WhitenSeries(diagnosis.master.data),
});

const localizedScore = (
    corrected: NumericSeries,
    diagnosis: SeriesCoreDiagnosis,
    context: LocalizedContext,
    year: number,
    shiftYears?: number,
): LocalizedExhaustiveScore => {
    const differenceCorrected = firstDifferences(corrected);
    const whitenedCorrected = ar1WhitenSeries(corrected);
    return {
        year,
        ...(shiftYears === undefined ? {} : { shiftYears }),
        ...scoreExhaustiveSeries(corrected, diagnosis),
        differenceGain21: localGain(
            differenceCorrected,
            context.differenceBaseline,
            context.differenceMaster,
            year,
            21,
        ),
        differenceGain31: localGain(
            differenceCorrected,
            context.differenceBaseline,
            context.differenceMaster,
            year,
            31,
        ),
        differenceGain41: localGain(
            differenceCorrected,
            context.differenceBaseline,
            context.differenceMaster,
            year,
            41,
        ),
        differenceGain61: localGain(
            differenceCorrected,
            context.differenceBaseline,
            context.differenceMaster,
            year,
            61,
        ),
        whitenedGain31: localGain(
            whitenedCorrected,
            context.whitenedBaseline,
            context.whitenedMaster,
            year,
            31,
        ),
        whitenedGain61: localGain(
            whitenedCorrected,
            context.whitenedBaseline,
            context.whitenedMaster,
            year,
            61,
        ),
    };
};

export const scoreExhaustiveSeries = (
    corrected: NumericSeries,
    diagnosis: SeriesCoreDiagnosis,
): Omit<ExhaustiveEditScore, "year" | "shiftYears"> => {
    const target = preprocessSeries(corrected);
    const master = diagnosis.master.data;
    const correctedYears = [...corrected.keys()].sort((left, right) => left - right);
    const correctedStartYear =
        correctedYears[0] ?? diagnosis.targetRange.startYear;
    const correctedEndYear =
        correctedYears[correctedYears.length - 1]
        ?? diagnosis.targetRange.endYear;
    const raw = correlation(
        target,
        master,
        correctedStartYear,
        correctedEndYear,
    );
    const difference = correlation(
        firstDifferences(target),
        firstDifferences(master),
        correctedStartYear,
        correctedEndYear,
    );
    const whitened = correlation(
        ar1WhitenSeries(corrected),
        ar1WhitenSeries(master),
        correctedStartYear,
        correctedEndYear,
    );
    return {
        raw,
        difference,
        whitened,
        combo: raw * 0.2 + difference * 0.5 + whitened * 0.3,
    };
};

const simulateInsertGap = (series: NumericSeries, insertYear: number): NumericSeries => {
    const result = new Map<number, number>();
    series.forEach((value, year) => {
        result.set(year <= insertYear ? year - 1 : year, value);
    });
    return result;
};

const simulateDelete = (series: NumericSeries, deleteYear: number): NumericSeries => {
    const result = new Map<number, number>();
    series.forEach((value, year) => {
        if (year !== deleteYear) result.set(year < deleteYear ? year + 1 : year, value);
    });
    return result;
};

const simulateOlderMove = (
    series: NumericSeries,
    boundaryYear: number,
    shiftYears: number,
): NumericSeries => {
    const result = new Map<number, number>();
    series.forEach((value, year) => {
        result.set(year <= boundaryYear ? year + shiftYears : year, value);
    });
    return result;
};

const candidateYears = (diagnosis: SeriesCoreDiagnosis, edgeYears: number): number[] => (
    Array.from(diagnosis.rawTarget.keys())
        .filter((year) => (
            year >= diagnosis.targetRange.startYear + edgeYears
            && year <= diagnosis.targetRange.endYear - edgeYears
        ))
        .sort((a, b) => a - b)
);

export const scanExhaustiveUnitEdit = (
    diagnosis: SeriesCoreDiagnosis,
    editType: "insert" | "delete",
): ExhaustiveEditScore[] => candidateYears(diagnosis, 15)
    .map((year) => ({
        year,
            ...scoreExhaustiveSeries(
            editType === "insert"
                ? simulateInsertGap(diagnosis.rawTarget, year)
                : simulateDelete(diagnosis.rawTarget, year),
            diagnosis,
        ),
    }));

export const scanExhaustivePartialMove = (
    diagnosis: SeriesCoreDiagnosis,
    shifts = getAutomaticPartialShiftCandidates(),
): ExhaustiveEditScore[] => candidateYears(diagnosis, 20)
    .flatMap((lastMovedYear) => shifts
    .map((shiftYears) => ({
        year: firstFixedYearFromLastMovedYear(lastMovedYear),
        shiftYears,
        ...scoreExhaustiveSeries(
            simulateOlderMove(diagnosis.rawTarget, lastMovedYear, shiftYears),
            diagnosis,
        ),
    })));

export const scanLocalizedUnitEdit = (
    diagnosis: SeriesCoreDiagnosis,
    editType: "insert" | "delete",
): LocalizedExhaustiveScore[] => {
    const context = localizedContext(diagnosis);
    return candidateYears(diagnosis, 15).map((year) => {
        const corrected = editType === "insert"
            ? simulateInsertGap(diagnosis.rawTarget, year)
            : simulateDelete(diagnosis.rawTarget, year);
        return localizedScore(corrected, diagnosis, context, year);
    });
};

export const scanLocalizedPartialMove = (
    diagnosis: SeriesCoreDiagnosis,
): LocalizedExhaustiveScore[] => {
    const context = localizedContext(diagnosis);
    return candidateYears(diagnosis, 20)
        .flatMap((lastMovedYear) => getAutomaticPartialShiftCandidates()
        .map((shiftYears) => (
            localizedScore(
                simulateOlderMove(diagnosis.rawTarget, lastMovedYear, shiftYears),
                diagnosis,
                context,
                firstFixedYearFromLastMovedYear(lastMovedYear),
                shiftYears,
            )
        )));
};

export const scanPairwiseUnitEdit = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    editType: "insert" | "delete",
): PairwiseExhaustiveScore[] => {
    const context = buildPairwiseContext(diagnosis, siteData);
    return candidateYears(diagnosis, 15).map((year) => pairwiseScore(
        editType === "insert"
            ? simulateInsertGap(diagnosis.rawTarget, year)
            : simulateDelete(diagnosis.rawTarget, year),
        diagnosis,
        context,
        year,
    ));
};

export const scanPairwisePartialMove = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
): PairwiseExhaustiveScore[] => {
    const context = buildPairwiseContext(diagnosis, siteData);
    return candidateYears(diagnosis, 20)
        .flatMap((lastMovedYear) => getAutomaticPartialShiftCandidates()
        .map((shiftYears) => pairwiseScore(
            simulateOlderMove(diagnosis.rawTarget, lastMovedYear, shiftYears),
            diagnosis,
            context,
            firstFixedYearFromLastMovedYear(lastMovedYear),
            shiftYears,
        )));
};

export const bestPairwiseScore = (
    scores: PairwiseExhaustiveScore[],
    scoreName: PairwiseScoreName,
): PairwiseExhaustiveScore | null => [...scores]
    .sort((a, b) => b[scoreName] - a[scoreName] || b.year - a.year)[0] ?? null;

export const pairwiseRemoteMargin = (
    scores: PairwiseExhaustiveScore[],
    best: PairwiseExhaustiveScore,
    scoreName: PairwiseScoreName,
    exclusionYears: number,
): number => {
    const remote = scores
        .filter((row) => (
            Math.abs(row.year - best.year) > exclusionYears
            || row.shiftYears !== best.shiftYears
        ))
        .sort((a, b) => b[scoreName] - a[scoreName])[0];
    return best[scoreName] - (remote?.[scoreName] ?? best[scoreName]);
};

export const bestLocalizedScore = (
    scores: LocalizedExhaustiveScore[],
    scoreName: LocalizedScoreName,
): LocalizedExhaustiveScore | null => [...scores]
    .sort((a, b) => b[scoreName] - a[scoreName] || b.year - a.year)[0] ?? null;

export const bestExhaustiveScore = (
    scores: ExhaustiveEditScore[],
    scoreName: ExhaustiveScoreName,
): ExhaustiveEditScore | null => [...scores]
    .sort((a, b) => b[scoreName] - a[scoreName] || b.year - a.year)[0] ?? null;

export const exhaustiveRemoteMargin = (
    scores: ExhaustiveEditScore[],
    best: ExhaustiveEditScore,
    scoreName: ExhaustiveScoreName,
    exclusionYears: number,
): number => {
    const remote = scores
        .filter((row) => (
            Math.abs(row.year - best.year) > exclusionYears
            || row.shiftYears !== best.shiftYears
        ))
        .sort((a, b) => b[scoreName] - a[scoreName])[0];
    return best[scoreName] - (remote?.[scoreName] ?? best[scoreName]);
};
