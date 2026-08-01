/**
 * Bounded opposite-transition scan for a lag excursion that later returns to its baseline.
 *
 * This targets nearby missing/false-ring pairs that cancel in long-window diagnostics. Each
 * hypothesis must prefer the shifted lag inside the excursion and the baseline lag in both
 * flanking contexts. It emits review-only events and never edits RWL data.
 */
import { cofechaStyleStandardize } from "../reference";
import { correlationForSegment } from "./series";
import type {
    DiagnosisConfidence,
    DiagnosisEvent,
    DiagnosisEventType,
    DiagnosisRankedYear,
    NumericSeries,
    SeriesCoreDiagnosis,
} from "./types";

export type PairedLagExcursionConfig = {
    minDurationYears: number;
    maxDurationYears: number;
    contextYears: number;
    minPairs: number;
    rawWeight: number;
    differenceWeight: number;
    minInteriorAdvantage: number;
    minContextAdvantage: number;
    minScore: number;
    maxEvents: number;
    boundaryWindowWidth: number;
};

export const DEFAULT_PAIRED_LAG_EXCURSION_CONFIG: PairedLagExcursionConfig = {
    minDurationYears: 6,
    maxDurationYears: 36,
    contextYears: 18,
    minPairs: 6,
    rawWeight: 0.3,
    differenceWeight: 0.7,
    minInteriorAdvantage: 0.12,
    minContextAdvantage: -0.02,
    minScore: 0.28,
    maxEvents: 1,
    boundaryWindowWidth: 7,
};

type Contrast = {
    score: number;
    pairs: number;
    raw: number | null;
    difference: number | null;
};

type Excursion = {
    baselineLag: number;
    pulseLag: number;
    startYear: number;
    endYear: number;
    score: number;
    interior: Contrast;
    left: Contrast;
    right: Contrast;
};

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const result = new Map<number, number>();
    const entries = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return result;
};

const correlationDifference = (
    target: NumericSeries,
    master: NumericSeries,
    startYear: number,
    endYear: number,
    preferredLag: number,
    alternativeLag: number,
    minPairs: number,
): { difference: number | null; pairs: number } => {
    const preferred = correlationForSegment(
        target,
        master,
        startYear,
        endYear,
        preferredLag,
        minPairs,
    );
    const alternative = correlationForSegment(
        target,
        master,
        startYear,
        endYear,
        alternativeLag,
        minPairs,
    );
    return {
        difference: preferred.correlation !== null && alternative.correlation !== null
            ? preferred.correlation - alternative.correlation
            : null,
        pairs: Math.min(preferred.samplePairs, alternative.samplePairs),
    };
};

const contrastFor = (
    target: NumericSeries,
    targetDifferences: NumericSeries,
    master: NumericSeries,
    masterDifferences: NumericSeries,
    startYear: number,
    endYear: number,
    preferredLag: number,
    alternativeLag: number,
    config: PairedLagExcursionConfig,
): Contrast => {
    const raw = correlationDifference(
        target,
        master,
        startYear,
        endYear,
        preferredLag,
        alternativeLag,
        config.minPairs,
    );
    const difference = correlationDifference(
        targetDifferences,
        masterDifferences,
        startYear,
        endYear,
        preferredLag,
        alternativeLag,
        Math.max(4, config.minPairs - 1),
    );
    const channels = [
        raw.difference === null ? null : { value: raw.difference, weight: config.rawWeight },
        difference.difference === null
            ? null
            : { value: difference.difference, weight: config.differenceWeight },
    ].filter((row): row is { value: number; weight: number } => row !== null);
    const weight = channels.reduce((sum, row) => sum + row.weight, 0);
    return {
        score: weight > 0
            ? channels.reduce((sum, row) => sum + row.value * row.weight, 0) / weight
            : Number.NEGATIVE_INFINITY,
        pairs: Math.min(raw.pairs || Number.POSITIVE_INFINITY, difference.pairs || Number.POSITIVE_INFINITY),
        raw: raw.difference,
        difference: difference.difference,
    };
};

const boundedWindow = (
    centerYear: number,
    width: number,
    minYear: number,
    maxYear: number,
): { startYear: number; endYear: number } => {
    const actualWidth = Math.max(1, Math.min(width, maxYear - minYear + 1));
    let startYear = centerYear - Math.floor((actualWidth - 1) / 2);
    startYear = Math.max(minYear, Math.min(startYear, maxYear - actualWidth + 1));
    return { startYear, endYear: startYear + actualWidth - 1 };
};

const eventTypeFor = (olderLag: number, newerLag: number): DiagnosisEventType => (
    newerLag - olderLag === 1 ? "missingRing" : "falseRing"
);

const confidenceFor = (score: number): DiagnosisConfidence => (
    score >= 0.8 ? "high" : score >= 0.5 ? "medium" : "low"
);

const boundaryRows = (
    excursions: Excursion[],
    selected: Excursion,
    boundary: "older" | "newer",
    startYear: number,
    endYear: number,
): DiagnosisRankedYear[] => {
    const scoreByYear = new Map<number, number>();
    excursions
        .filter((candidate) => (
            candidate.baselineLag === selected.baselineLag
            && candidate.pulseLag === selected.pulseLag
            && (boundary === "older"
                ? Math.abs(candidate.endYear - selected.endYear) <= 2
                : Math.abs(candidate.startYear - selected.startYear) <= 2)
        ))
        .forEach((candidate) => {
            const year = boundary === "older" ? candidate.startYear - 1 : candidate.endYear;
            scoreByYear.set(year, Math.max(scoreByYear.get(year) ?? Number.NEGATIVE_INFINITY, candidate.score));
        });
    return Array.from({ length: endYear - startYear + 1 }, (_, offset) => {
        const year = startYear + offset;
        return {
            year,
            score: scoreByYear.get(year) ?? selected.score - Math.abs(
                year - (boundary === "older" ? selected.startYear - 1 : selected.endYear),
            ) * 0.05,
            evidenceTags: ["paired_lag_excursion"],
        };
    })
        .sort((a, b) => b.score - a.score || b.year - a.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
};

const overlap = (a: Excursion, b: Excursion): boolean => (
    Math.max(a.startYear, b.startYear) <= Math.min(a.endYear, b.endYear)
);

export const locatePairedLagExcursionEvents = (
    diagnosis: SeriesCoreDiagnosis,
    overrides: Partial<PairedLagExcursionConfig> = {},
): DiagnosisEvent[] => {
    const config = { ...DEFAULT_PAIRED_LAG_EXCURSION_CONFIG, ...overrides };
    const target = new Map(
        cofechaStyleStandardize(diagnosis.rawTarget).map((point) => [point.year, point.value]),
    );
    const master = diagnosis.master.data;
    const targetDifferences = firstDifferences(target);
    const masterDifferences = firstDifferences(master);
    const baselineLags = Array.from(new Set([
        0,
        diagnosis.globalSlidingMatch.bestGlobalLag,
    ])).filter((lag) => Math.abs(lag) <= 6);
    const candidates: Excursion[] = [];

    baselineLags.forEach((baselineLag) => {
        ([-1, 1] as const).forEach((step) => {
            const pulseLag = baselineLag + step;
            const minimumStart = diagnosis.targetRange.startYear + config.contextYears;
            const maximumEnd = diagnosis.targetRange.endYear - config.contextYears;
            for (let startYear = minimumStart; startYear <= maximumEnd; startYear += 1) {
                const maximumDuration = Math.min(
                    config.maxDurationYears,
                    maximumEnd - startYear + 1,
                );
                for (
                    let duration = config.minDurationYears;
                    duration <= maximumDuration;
                    duration += 1
                ) {
                    const endYear = startYear + duration - 1;
                    const interior = contrastFor(
                        target,
                        targetDifferences,
                        master,
                        masterDifferences,
                        startYear,
                        endYear,
                        pulseLag,
                        baselineLag,
                        config,
                    );
                    if (interior.score < config.minInteriorAdvantage) continue;
                    const left = contrastFor(
                        target,
                        targetDifferences,
                        master,
                        masterDifferences,
                        startYear - config.contextYears,
                        startYear - 1,
                        baselineLag,
                        pulseLag,
                        config,
                    );
                    const right = contrastFor(
                        target,
                        targetDifferences,
                        master,
                        masterDifferences,
                        endYear + 1,
                        endYear + config.contextYears,
                        baselineLag,
                        pulseLag,
                        config,
                    );
                    if (left.score < config.minContextAdvantage
                        || right.score < config.minContextAdvantage) continue;
                    const score = interior.score * 1.25
                        + Math.min(left.score, right.score) * 0.75
                        + (left.score + right.score) * 0.25;
                    if (score < config.minScore) continue;
                    candidates.push({
                        baselineLag,
                        pulseLag,
                        startYear,
                        endYear,
                        score,
                        interior,
                        left,
                        right,
                    });
                }
            }
        });
    });

    const selected: Excursion[] = [];
    candidates
        .sort((a, b) => b.score - a.score
            || (a.endYear - a.startYear) - (b.endYear - b.startYear))
        .forEach((candidate) => {
            if (selected.length >= config.maxEvents || selected.some((other) => overlap(candidate, other))) return;
            selected.push(candidate);
        });

    return selected.flatMap((excursion, excursionIndex) => {
        const boundaries = [
            {
                kind: "older" as const,
                year: excursion.startYear - 1,
                olderLag: excursion.baselineLag,
                newerLag: excursion.pulseLag,
            },
            {
                kind: "newer" as const,
                year: excursion.endYear,
                olderLag: excursion.pulseLag,
                newerLag: excursion.baselineLag,
            },
        ];
        return boundaries.map((boundary): DiagnosisEvent => {
            const eventType = eventTypeFor(boundary.olderLag, boundary.newerLag);
            const window = boundedWindow(
                boundary.year,
                config.boundaryWindowWidth,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
            );
            return {
                id: `diagnosis-event-${diagnosis.targetTree}-paired-${excursionIndex}-${boundary.kind}-${eventType}-${boundary.year}`,
                seriesId: diagnosis.targetTree,
                eventType,
                ...window,
                rankedYears: boundaryRows(
                    candidates,
                    excursion,
                    boundary.kind,
                    window.startYear,
                    window.endYear,
                ),
                confidenceLevel: confidenceFor(excursion.score),
                evidence: {
                    algorithmSources: ["paired_lag_excursion"],
                    score: excursion.score,
                    scoreMargin: excursion.score,
                    baselineCorrelation: diagnosis.globalSlidingMatch.currentR,
                    correctedCorrelation: diagnosis.globalSlidingMatch.bestGlobalR,
                    correlationGain: null,
                    lagBefore: boundary.olderLag,
                    lagAfter: boundary.newerLag,
                    samplePairs: Math.min(
                        excursion.interior.pairs,
                        excursion.left.pairs,
                        excursion.right.pairs,
                    ),
                    candidateIds: [],
                    notes: [
                        `paired lag excursion ${excursion.baselineLag} -> ${excursion.pulseLag} -> ${excursion.baselineLag}`,
                        `excursion_duration_years=${excursion.endYear - excursion.startYear + 1}`,
                        `interior_advantage=${excursion.interior.score.toFixed(4)}`,
                        `left_context_advantage=${excursion.left.score.toFixed(4)}`,
                        `right_context_advantage=${excursion.right.score.toFixed(4)}`,
                        "score_is_relative_not_probability",
                    ],
                },
                alternativeTypes: ["partialMove"],
            };
        });
    });
};
