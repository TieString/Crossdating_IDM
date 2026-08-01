import { cofechaStyleStandardize } from "../reference";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    ar1WhitenSeries,
    correlationForSegment,
    fisherZ,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import {
    DEFAULT_MAX_PARTIAL_GAP_YEARS,
    getAutomaticEventShiftCandidates,
} from "./partialMoveSemantics";
import type { NumericSeries, SeriesCoreDiagnosis } from "./types";

export type PiecewiseChangePointScore = {
    year: number;
    olderLag: number;
    combinedObjective: number;
    combinedGain: number;
    rawObjective: number;
    cofechaObjective: number;
    whitenedObjective: number;
    differenceObjective: number;
    rawGain: number;
    cofechaGain: number;
    whitenedGain: number;
    differenceGain: number;
    olderPairs: number;
    newerPairs: number;
};

export type PiecewiseChangePointOptions = {
    lags?: number[];
    minSideYears?: number;
};

export type ReferenceConsensusChangePointScore = {
    year: number;
    olderLag: number;
    referenceCount: number;
    meanPercentile: number;
    medianPercentile: number;
    meanStandardizedObjective: number;
    supportFraction: number;
    weightedSupport: number;
    meanGain: number;
    positiveGainFraction: number;
};

export type ReferenceConsensusChangePointOptions = PiecewiseChangePointOptions & {
    maximumReferences?: number;
    supportRadiusYears?: number;
};

type View = {
    name: "raw" | "cofecha" | "whitened" | "difference";
    target: NumericSeries;
    master: NumericSeries;
    weight: number;
};

type ViewScore = {
    objective: number;
    gain: number;
    olderPairs: number;
    newerPairs: number;
};

type ViewBaseline = {
    olderZero: ReturnType<typeof correlationForSegment>;
    newerZero: ReturnType<typeof correlationForSegment>;
};

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

const cofechaPreprocess = (series: NumericSeries): NumericSeries => new Map(
    cofechaStyleStandardize(series).map((point) => [point.year, point.value]),
);

const mean = (values: number[]): number => (
    values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0
);

const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

const weightedFisher = (
    correlation: number | null,
    pairs: number,
): { value: number; weight: number } => {
    const weight = Math.max(0, pairs - 3);
    if (correlation === null || weight === 0) return { value: 0, weight: 0 };
    return {
        value: fisherZ(correlation) * weight,
        weight,
    };
};

const scoreView = (
    view: View,
    diagnosis: SeriesCoreDiagnosis,
    year: number,
    olderLag: number,
    minPairs: number,
    baseline: ViewBaseline,
): ViewScore | null => {
    const olderShifted = correlationForSegment(
        view.target,
        view.master,
        diagnosis.targetRange.startYear,
        year,
        olderLag,
        minPairs,
    );
    const { olderZero, newerZero } = baseline;
    if (olderShifted.correlation === null || newerZero.correlation === null) return null;

    const olderScore = weightedFisher(
        olderShifted.correlation,
        olderShifted.samplePairs,
    );
    const newerScore = weightedFisher(
        newerZero.correlation,
        newerZero.samplePairs,
    );
    const totalWeight = olderScore.weight + newerScore.weight;
    if (totalWeight === 0) return null;

    return {
        objective: (olderScore.value + newerScore.value) / totalWeight,
        gain: fisherZ(olderShifted.correlation) - fisherZ(olderZero.correlation),
        olderPairs: olderShifted.samplePairs,
        newerPairs: newerZero.samplePairs,
    };
};

const viewsFor = (
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis | null,
): View[] => {
    const rawTarget = preprocessSeries(diagnosis.rawTarget);
    const rawMaster = diagnosis.master.data;
    const views: View[] = [
        {
            name: "raw",
            target: rawTarget,
            master: rawMaster,
            weight: 0.2,
        },
        {
            name: "whitened",
            target: ar1WhitenSeries(diagnosis.rawTarget),
            master: ar1WhitenSeries(rawMaster),
            weight: 0.2,
        },
        {
            name: "difference",
            target: firstDifferences(diagnosis.rawTarget),
            master: firstDifferences(rawMaster),
            weight: 0.15,
        },
    ];
    if (cofechaDiagnosis) {
        views.push({
            name: "cofecha",
            target: cofechaPreprocess(diagnosis.rawTarget),
            master: cofechaDiagnosis.master.data,
            weight: 0.45,
        });
    }
    const weightSum = views.reduce((sum, view) => sum + view.weight, 0);
    return views.map((view) => ({ ...view, weight: view.weight / weightSum }));
};

export const scorePiecewiseChangePoints = (
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis | null = null,
    options: PiecewiseChangePointOptions = {},
): PiecewiseChangePointScore[] => {
    const minSideYears = options.minSideYears ?? 18;
    const lags = options.lags ?? getAutomaticEventShiftCandidates({
        maxPartialGapYears: DEFAULT_MAX_PARTIAL_GAP_YEARS,
        lagMin: -DEFAULT_MAX_PARTIAL_GAP_YEARS,
        seriesLength:
            diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
        minimumSideYears: minSideYears,
    });
    const views = viewsFor(diagnosis, cofechaDiagnosis);
    const rows: PiecewiseChangePointScore[] = [];

    for (
        let year = diagnosis.targetRange.startYear + minSideYears;
        year <= diagnosis.targetRange.endYear - minSideYears;
        year += 1
    ) {
        const minPairs = Math.max(10, Math.min(15, minSideYears - 2));
        const baselines = new Map<View["name"], ViewBaseline>();
        views.forEach((view) => {
            baselines.set(view.name, {
                olderZero: correlationForSegment(
                    view.target,
                    view.master,
                    diagnosis.targetRange.startYear,
                    year,
                    0,
                    minPairs,
                ),
                newerZero: correlationForSegment(
                    view.target,
                    view.master,
                    year + 1,
                    diagnosis.targetRange.endYear,
                    0,
                    minPairs,
                ),
            });
        });
        lags.forEach((olderLag) => {
            const byView = new Map<View["name"], ViewScore>();
            views.forEach((view) => {
                const score = scoreView(
                    view,
                    diagnosis,
                    year,
                    olderLag,
                    minPairs,
                    baselines.get(view.name)!,
                );
                if (score) byView.set(view.name, score);
            });
            if (!byView.has("raw")) return;
            const availableViews = views.filter((view) => byView.has(view.name));
            const availableWeight = availableViews.reduce((sum, view) => sum + view.weight, 0);
            const combinedObjective = availableViews.reduce((sum, view) => (
                sum + byView.get(view.name)!.objective * view.weight
            ), 0) / availableWeight;
            const combinedGain = availableViews.reduce((sum, view) => (
                sum + byView.get(view.name)!.gain * view.weight
            ), 0) / availableWeight;
            const raw = byView.get("raw")!;
            rows.push({
                year,
                olderLag,
                combinedObjective,
                combinedGain,
                rawObjective: raw.objective,
                cofechaObjective: byView.get("cofecha")?.objective ?? raw.objective,
                whitenedObjective: byView.get("whitened")?.objective ?? raw.objective,
                differenceObjective: byView.get("difference")?.objective ?? raw.objective,
                rawGain: raw.gain,
                cofechaGain: byView.get("cofecha")?.gain ?? raw.gain,
                whitenedGain: byView.get("whitened")?.gain ?? raw.gain,
                differenceGain: byView.get("difference")?.gain ?? raw.gain,
                olderPairs: raw.olderPairs,
                newerPairs: raw.newerPairs,
            });
        });
    }
    return rows;
};

export const bestPiecewiseChangePoint = (
    scores: PiecewiseChangePointScore[],
    olderLag: number,
    score: keyof Pick<PiecewiseChangePointScore, "combinedObjective" | "combinedGain">
        = "combinedObjective",
): PiecewiseChangePointScore | null => scores
    .filter((row) => row.olderLag === olderLag)
    .sort((a, b) => b[score] - a[score] || b.year - a.year)[0] ?? null;

type ReferenceBoundaryRow = {
    year: number;
    objective: number;
    gain: number;
    percentile: number;
    standardizedObjective: number;
};

type ReferenceBoundaryProfile = {
    weight: number;
    topYear: number;
    rows: Map<number, ReferenceBoundaryRow>;
};

const referenceBoundaryProfile = (
    target: NumericSeries,
    reference: NumericSeries,
    diagnosis: SeriesCoreDiagnosis,
    olderLag: number,
    minSideYears: number,
    weight: number,
): ReferenceBoundaryProfile | null => {
    const rows: Array<Omit<ReferenceBoundaryRow, "percentile" | "standardizedObjective">> = [];
    const minPairs = Math.max(10, Math.min(15, minSideYears - 2));
    for (
        let year = diagnosis.targetRange.startYear + minSideYears;
        year <= diagnosis.targetRange.endYear - minSideYears;
        year += 1
    ) {
        const olderShifted = correlationForSegment(
            target,
            reference,
            diagnosis.targetRange.startYear,
            year,
            olderLag,
            minPairs,
        );
        const olderZero = correlationForSegment(
            target,
            reference,
            diagnosis.targetRange.startYear,
            year,
            0,
            minPairs,
        );
        const newerZero = correlationForSegment(
            target,
            reference,
            year + 1,
            diagnosis.targetRange.endYear,
            0,
            minPairs,
        );
        if (olderShifted.correlation === null
            || olderZero.correlation === null
            || newerZero.correlation === null) {
            continue;
        }
        const older = weightedFisher(
            olderShifted.correlation,
            olderShifted.samplePairs,
        );
        const newer = weightedFisher(
            newerZero.correlation,
            newerZero.samplePairs,
        );
        const totalWeight = older.weight + newer.weight;
        if (totalWeight === 0) continue;
        rows.push({
            year,
            objective: (older.value + newer.value) / totalWeight,
            gain: fisherZ(olderShifted.correlation) - fisherZ(olderZero.correlation),
        });
    }
    if (rows.length < 10) return null;

    const objectiveMean = mean(rows.map((row) => row.objective));
    const objectiveVariance = mean(rows.map((row) => (
        (row.objective - objectiveMean) ** 2
    )));
    const objectiveScale = Math.sqrt(objectiveVariance) || 1;
    const ranked = [...rows].sort((a, b) => (
        a.objective - b.objective || a.year - b.year
    ));
    const percentileByYear = new Map(ranked.map((row, index) => [
        row.year,
        index / Math.max(1, ranked.length - 1),
    ]));
    const normalizedRows = rows.map((row) => ({
        ...row,
        percentile: percentileByYear.get(row.year) ?? 0,
        standardizedObjective: (row.objective - objectiveMean) / objectiveScale,
    }));
    const top = [...normalizedRows].sort((a, b) => (
        b.objective - a.objective || b.year - a.year
    ))[0];
    return {
        weight,
        topYear: top.year,
        rows: new Map(normalizedRows.map((row) => [row.year, row])),
    };
};

export const scoreReferenceConsensusChangePoints = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    options: ReferenceConsensusChangePointOptions = {},
): ReferenceConsensusChangePointScore[] => {
    const minSideYears = options.minSideYears ?? 18;
    const lags = options.lags ?? getAutomaticEventShiftCandidates({
        maxPartialGapYears: DEFAULT_MAX_PARTIAL_GAP_YEARS,
        lagMin: -DEFAULT_MAX_PARTIAL_GAP_YEARS,
        seriesLength:
            diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
        minimumSideYears: minSideYears,
    });
    const maximumReferences = options.maximumReferences ?? 24;
    const supportRadiusYears = options.supportRadiusYears ?? 3;
    const target = cofechaPreprocess(diagnosis.rawTarget);
    const references = diagnosis.master.sourceTrees
        .map((tree) => {
            const data = cofechaPreprocess(toNumericSeries(siteData.get(tree)));
            const global = correlationForSegment(
                target,
                data,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
                0,
                30,
            ).correlation;
            return {
                data,
                global: global ?? -1,
                weight: Math.max(0.05, global ?? 0),
            };
        })
        .filter((reference) => reference.global > -0.25)
        .sort((a, b) => b.global - a.global)
        .slice(0, maximumReferences);

    const result: ReferenceConsensusChangePointScore[] = [];
    lags.forEach((olderLag) => {
        const profiles = references
            .map((reference) => referenceBoundaryProfile(
                target,
                reference.data,
                diagnosis,
                olderLag,
                minSideYears,
                reference.weight,
            ))
            .filter((profile): profile is ReferenceBoundaryProfile => profile !== null);
        for (
            let year = diagnosis.targetRange.startYear + minSideYears;
            year <= diagnosis.targetRange.endYear - minSideYears;
            year += 1
        ) {
            const available = profiles.flatMap((profile) => {
                const row = profile.rows.get(year);
                return row ? [{ profile, row }] : [];
            });
            if (available.length < 3) continue;
            const totalWeight = available.reduce((sum, item) => sum + item.profile.weight, 0);
            const supporting = available.filter((item) => (
                Math.abs(item.profile.topYear - year) <= supportRadiusYears
            ));
            const gains = available.map((item) => item.row.gain);
            result.push({
                year,
                olderLag,
                referenceCount: available.length,
                meanPercentile: mean(available.map((item) => item.row.percentile)),
                medianPercentile: median(available.map((item) => item.row.percentile)),
                meanStandardizedObjective: mean(
                    available.map((item) => item.row.standardizedObjective),
                ),
                supportFraction: supporting.length / available.length,
                weightedSupport: totalWeight > 0
                    ? supporting.reduce((sum, item) => sum + item.profile.weight, 0) / totalWeight
                    : 0,
                meanGain: mean(gains),
                positiveGainFraction: gains.filter((gain) => gain > 0).length / gains.length,
            });
        }
    });
    return result;
};
