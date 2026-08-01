/**
 * Reference-wise exact virtual insert/delete consensus.
 *
 * Every reference first chooses its own absolute baseline lag. The target is then virtually
 * corrected at every usable year, and gains are rank-normalized within that reference before
 * aggregation. This isolates a local unit event from a coexisting whole-series offset and keeps
 * one unusually strong reference from dominating the location profile.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import { scoreFullIntervalUnitEditEvidence } from "./fullIntervalUnitEditEvidence";
import {
    correlationForSegment,
    toNumericSeries,
} from "./series";
import type {
    DiagnosisEventType,
    NumericSeries,
    SeriesCoreDiagnosis,
} from "./types";

export type FullIntervalReferenceEditOptions = {
    edgeYears?: number;
    maximumReferences?: number;
    baselineLagRadius?: number;
    peakWindowWidth?: number;
};

export type FullIntervalReferenceEditRow = {
    year: number;
    eventType: DiagnosisEventType;
    referenceCount: number;
    rankMean: number;
    rankMedian: number;
    weightedRankMean: number;
    gainMean: number;
    gainMedian: number;
    weightedGainMean: number;
    positiveGainFraction: number;
    peakKernel5: number;
    peakKernel9: number;
    peakKernel13: number;
    windowVote17: number;
    weightedWindowVote17: number;
    baselineModeFraction: number;
};

type ReferenceProfileRow = {
    year: number;
    gain: number;
    rank: number;
};

type ReferenceProfile = {
    weight: number;
    baselineLag: number;
    peakYear: number;
    windowStartYear: number;
    windowEndYear: number;
    rows: ReferenceProfileRow[];
};

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = [...series.entries()].sort((left, right) => left[0] - right[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return result;
};

const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const ordered = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2
        ? ordered[middle]
        : (ordered[middle - 1] + ordered[middle]) / 2;
};

const percentileRanks = (values: number[]): number[] => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const result = new Array(values.length).fill(0);
    let start = 0;
    while (start < ordered.length) {
        let end = start + 1;
        while (end < ordered.length && ordered[end].value === ordered[start].value) {
            end += 1;
        }
        const rank = ((start + end - 1) / 2) / Math.max(1, ordered.length - 1);
        for (let index = start; index < end; index += 1) {
            result[ordered[index].index] = rank;
        }
        start = end;
    }
    return result;
};

const shiftReference = (
    reference: NumericSeries,
    lag: number,
): NumericSeries => new Map(
    [...reference.entries()].map(([year, value]) => [year - lag, value]),
);

const bestMassWindow = (
    rows: ReferenceProfileRow[],
    width: number,
): { startYear: number; endYear: number } => {
    let best = {
        startYear: rows[0].year,
        endYear: rows[0].year + width - 1,
        score: Number.NEGATIVE_INFINITY,
    };
    for (let startIndex = 0; startIndex < rows.length; startIndex += 1) {
        const startYear = rows[startIndex].year;
        const endYear = startYear + width - 1;
        let score = 0;
        let count = 0;
        for (let index = startIndex; index < rows.length; index += 1) {
            if (rows[index].year > endYear) break;
            score += rows[index].rank;
            count += 1;
        }
        const normalized = score / Math.sqrt(Math.max(1, count));
        if (normalized > best.score) {
            best = { startYear, endYear, score: normalized };
        }
    }
    return best;
};

const scoreReference = (
    diagnosis: SeriesCoreDiagnosis,
    reference: NumericSeries,
    editType: "insert" | "delete",
    edgeYears: number,
    baselineLagRadius: number,
    peakWindowWidth: number,
): ReferenceProfile | null => {
    const lags = Array.from(
        { length: baselineLagRadius * 2 + 1 },
        (_, index) => index - baselineLagRadius,
    );
    const rankedLags = lags
        .map((lag) => ({
            lag,
            result: correlationForSegment(
                diagnosis.rawTarget,
                reference,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
                lag,
                30,
            ),
        }))
        .filter((row) => row.result.correlation !== null)
        .sort((left, right) => (
            right.result.correlation! - left.result.correlation!
            || Math.abs(left.lag) - Math.abs(right.lag)
        ));
    const baseline = rankedLags[0];
    if (!baseline || baseline.result.correlation! <= -0.1) return null;
    const shiftedReference = shiftReference(reference, baseline.lag);
    const baselineDifference = correlationForSegment(
        firstDifferences(diagnosis.rawTarget),
        firstDifferences(shiftedReference),
        diagnosis.targetRange.startYear,
        diagnosis.targetRange.endYear,
        0,
        30,
    ).correlation ?? -1;
    const rows = scoreFullIntervalUnitEditEvidence(
        diagnosis,
        editType,
        edgeYears,
        shiftedReference,
    );
    if (rows.length < 15) return null;
    const gains = rows.map((row) => (
        (row.rawCorrelation - baseline.result.correlation!) * 0.3
        + (row.differenceCorrelation - baselineDifference) * 0.7
    ));
    const ranks = percentileRanks(gains);
    const profileRows = rows.map((row, index) => ({
        year: row.year,
        gain: gains[index],
        rank: ranks[index],
    }));
    const peak = profileRows.reduce(
        (best, row) => row.rank > best.rank ? row : best,
        profileRows[0],
    );
    const window = bestMassWindow(profileRows, peakWindowWidth);
    return {
        weight: Math.max(0.05, baseline.result.correlation! + 0.15),
        baselineLag: baseline.lag,
        peakYear: peak.year,
        windowStartYear: window.startYear,
        windowEndYear: window.endYear,
        rows: profileRows,
    };
};

export const scoreFullIntervalReferenceEditEvidence = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    editType: "insert" | "delete",
    options: FullIntervalReferenceEditOptions = {},
): FullIntervalReferenceEditRow[] => {
    const edgeYears = Math.max(8, Math.floor(options.edgeYears ?? 15));
    const maximumReferences = Math.max(
        3,
        Math.floor(options.maximumReferences ?? 16),
    );
    const baselineLagRadius = Math.max(
        0,
        Math.floor(options.baselineLagRadius ?? 3),
    );
    const peakWindowWidth = Math.max(
        5,
        Math.floor(options.peakWindowWidth ?? 17),
    );
    const profiles = diagnosis.master.sourceTrees
        .map((tree) => toNumericSeries(siteData.get(tree)))
        .filter((reference) => reference.size >= 40)
        .map((reference) => scoreReference(
            diagnosis,
            reference,
            editType,
            edgeYears,
            baselineLagRadius,
            peakWindowWidth,
        ))
        .filter((profile): profile is ReferenceProfile => profile !== null)
        .sort((left, right) => right.weight - left.weight)
        .slice(0, maximumReferences);
    if (profiles.length < 3) return [];
    const rowsByReference = profiles.map((profile) => new Map(
        profile.rows.map((row) => [row.year, row]),
    ));
    const years = [...new Set(profiles.flatMap(
        (profile) => profile.rows.map((row) => row.year),
    ))].sort((left, right) => left - right);
    return years.flatMap((year): FullIntervalReferenceEditRow[] => {
        const available = profiles.flatMap((profile, index) => {
            const row = rowsByReference[index].get(year);
            return row ? [{ profile, row }] : [];
        });
        if (available.length < 3) return [];
        const totalWeight = available.reduce(
            (sum, item) => sum + item.profile.weight,
            0,
        );
        const modeCounts = new Map<number, number>();
        available.forEach(({ profile }) => {
            modeCounts.set(
                profile.baselineLag,
                (modeCounts.get(profile.baselineLag) ?? 0) + 1,
            );
        });
        const kernel = (radius: number) => available.reduce((sum, item) => (
            sum + Math.exp(
                -0.5 * ((year - item.profile.peakYear) / radius) ** 2,
            )
        ), 0) / available.length;
        return [{
            year,
            eventType: editType === "insert" ? "missingRing" : "falseRing",
            referenceCount: available.length,
            rankMean: available.reduce((sum, item) => sum + item.row.rank, 0)
                / available.length,
            rankMedian: median(available.map((item) => item.row.rank)),
            weightedRankMean: available.reduce(
                (sum, item) => sum + item.row.rank * item.profile.weight,
                0,
            ) / totalWeight,
            gainMean: available.reduce((sum, item) => sum + item.row.gain, 0)
                / available.length,
            gainMedian: median(available.map((item) => item.row.gain)),
            weightedGainMean: available.reduce(
                (sum, item) => sum + item.row.gain * item.profile.weight,
                0,
            ) / totalWeight,
            positiveGainFraction: available.filter((item) => item.row.gain > 0).length
                / available.length,
            peakKernel5: kernel(2.5),
            peakKernel9: kernel(4.5),
            peakKernel13: kernel(6.5),
            windowVote17: available.filter((item) => (
                year >= item.profile.windowStartYear
                && year <= item.profile.windowEndYear
            )).length / available.length,
            weightedWindowVote17: available.reduce((sum, item) => (
                sum + (
                    year >= item.profile.windowStartYear
                    && year <= item.profile.windowEndYear
                        ? item.profile.weight
                        : 0
                )
            ), 0) / totalWeight,
            baselineModeFraction: Math.max(...modeCounts.values())
                / available.length,
        }];
    });
};
