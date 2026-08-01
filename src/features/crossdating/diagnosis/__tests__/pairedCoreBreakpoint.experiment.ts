import { cofechaStyleStandardize } from "../../reference";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    ar1WhitenSeries,
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "../series";
import type { NumericSeries, SeriesCoreDiagnosis } from "../types";

export type PairedCoreBreakpointScore = {
    year: number;
    rawFull: number;
    differenceFull: number;
    whitenedFull: number;
    standardizedFull: number;
    comboFull: number;
    comboFullGain: number;
    combo31: number;
    combo31Gain: number;
    combo61: number;
    combo61Gain: number;
    multiScaleGain: number;
    rawHuberFull: number;
    differenceHuberFull: number;
    whitenedHuberFull: number;
    standardizedHuberFull: number;
    huberComboFull: number;
};

type PreparedSeries = {
    raw: NumericSeries;
    difference: NumericSeries;
    whitened: NumericSeries;
    standardized: NumericSeries;
};

type PreparedReference = PreparedSeries & { baselineCorrelation: number };

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

const prepare = (series: NumericSeries): PreparedSeries => ({
    raw: preprocessSeries(series),
    difference: firstDifferences(series),
    whitened: ar1WhitenSeries(series),
    standardized: new Map(cofechaStyleStandardize(series).map((point) => [
        point.year,
        point.value,
    ])),
});

const simulateCorrection = (
    series: NumericSeries,
    eventType: "missingRing" | "falseRing",
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

const median = (values: number[]): number => {
    if (values.length === 0) return -1;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

const aggregateCorrelation = (
    target: NumericSeries,
    references: PreparedReference[],
    key: keyof PreparedSeries,
    startYear: number,
    endYear: number,
    minPairs: number,
): number => median(references
    .map((reference) => correlationForSegment(
        target,
        reference[key],
        startYear,
        endYear,
        0,
        minPairs,
    ).correlation)
    .filter((value): value is number => value !== null));

const huberLoss = (residual: number, transition = 1.5): number => {
    const absolute = Math.abs(residual);
    return absolute <= transition
        ? 0.5 * absolute * absolute
        : transition * (absolute - transition * 0.5);
};

const robustSimilarity = (
    target: NumericSeries,
    reference: NumericSeries,
    startYear: number,
    endYear: number,
    minPairs: number,
): number | null => {
    let pairs = 0;
    let loss = 0;
    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const referenceValue = reference.get(year);
        if (targetValue === undefined || referenceValue === undefined) continue;
        loss += huberLoss(targetValue - referenceValue);
        pairs += 1;
    }
    return pairs >= minPairs ? -loss / pairs : null;
};

const aggregateSimilarity = (
    target: NumericSeries,
    references: PreparedReference[],
    key: keyof PreparedSeries,
    startYear: number,
    endYear: number,
    minPairs: number,
): number => median(references
    .map((reference) => robustSimilarity(
        target,
        reference[key],
        startYear,
        endYear,
        minPairs,
    ))
    .filter((value): value is number => value !== null));

const scorePrepared = (
    target: PreparedSeries,
    references: PreparedReference[],
    startYear: number,
    endYear: number,
    minPairs: number,
) => {
    const raw = aggregateCorrelation(target.raw, references, "raw", startYear, endYear, minPairs);
    const difference = aggregateCorrelation(
        target.difference,
        references,
        "difference",
        startYear,
        endYear,
        minPairs,
    );
    const whitened = aggregateCorrelation(
        target.whitened,
        references,
        "whitened",
        startYear,
        endYear,
        minPairs,
    );
    const standardized = aggregateCorrelation(
        target.standardized,
        references,
        "standardized",
        startYear,
        endYear,
        minPairs,
    );
    return {
        raw,
        difference,
        whitened,
        standardized,
        combo: raw * 0.2 + difference * 0.35 + whitened * 0.2 + standardized * 0.25,
    };
};

export const scorePairedCoreUnitBoundaries = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    eventType: "missingRing" | "falseRing",
): { referenceCount: number; scores: PairedCoreBreakpointScore[] } => {
    const targetStem = diagnosis.targetTree.slice(0, -1).toLowerCase();
    const baseline = prepare(diagnosis.rawTarget);
    const references = diagnosis.master.sourceTrees
        .filter((tree) => tree.slice(0, -1).toLowerCase() === targetStem)
        .map((tree) => {
            const prepared = prepare(toNumericSeries(siteData.get(tree)));
            const baselineCorrelation = correlationForSegment(
                baseline.raw,
                prepared.raw,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
                0,
                30,
            ).correlation ?? -1;
            return { ...prepared, baselineCorrelation };
        })
        .filter((reference) => reference.baselineCorrelation > -0.25)
        .sort((a, b) => b.baselineCorrelation - a.baselineCorrelation)
        .slice(0, 4);
    if (references.length === 0) return { referenceCount: 0, scores: [] };

    const fullBaseline = scorePrepared(
        baseline,
        references,
        diagnosis.targetRange.startYear,
        diagnosis.targetRange.endYear,
        30,
    );
    const scores: PairedCoreBreakpointScore[] = [];
    for (
        let year = diagnosis.targetRange.startYear + 30;
        year <= diagnosis.targetRange.endYear - 30;
        year += 1
    ) {
        const corrected = prepare(simulateCorrection(diagnosis.rawTarget, eventType, year));
        const full = scorePrepared(
            corrected,
            references,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
            30,
        );
        const baseline31 = scorePrepared(baseline, references, year - 15, year + 15, 16);
        const corrected31 = scorePrepared(corrected, references, year - 15, year + 15, 16);
        const baseline61 = scorePrepared(baseline, references, year - 30, year + 30, 32);
        const corrected61 = scorePrepared(corrected, references, year - 30, year + 30, 32);
        const comboFullGain = full.combo - fullBaseline.combo;
        const combo31Gain = corrected31.combo - baseline31.combo;
        const combo61Gain = corrected61.combo - baseline61.combo;
        const rawHuberFull = aggregateSimilarity(
            corrected.raw,
            references,
            "raw",
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
            30,
        );
        const differenceHuberFull = aggregateSimilarity(
            corrected.difference,
            references,
            "difference",
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
            30,
        );
        const whitenedHuberFull = aggregateSimilarity(
            corrected.whitened,
            references,
            "whitened",
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
            30,
        );
        const standardizedHuberFull = aggregateSimilarity(
            corrected.standardized,
            references,
            "standardized",
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
            30,
        );
        scores.push({
            year,
            rawFull: full.raw,
            differenceFull: full.difference,
            whitenedFull: full.whitened,
            standardizedFull: full.standardized,
            comboFull: full.combo,
            comboFullGain,
            combo31: corrected31.combo,
            combo31Gain,
            combo61: corrected61.combo,
            combo61Gain,
            multiScaleGain: comboFullGain * 0.5 + combo31Gain * 0.2 + combo61Gain * 0.3,
            rawHuberFull,
            differenceHuberFull,
            whitenedHuberFull,
            standardizedHuberFull,
            huberComboFull: rawHuberFull * 0.2
                + differenceHuberFull * 0.3
                + whitenedHuberFull * 0.15
                + standardizedHuberFull * 0.35,
        });
    }
    return { referenceCount: references.length, scores };
};
