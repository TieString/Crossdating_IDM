/**
 * Semi-global, end-anchored sequence alignment for discrete ring edits.
 *
 * The newest end is fixed and the path may use only integer insert/delete gaps inside a narrow
 * band. Old-end overhang is free. This models missing and false rings directly and is not DTW.
 */
import { ar1WhitenSeries, preprocessSeries } from "./series";
import type {
    DiagnosisConfidence,
    DiagnosisEvent,
    DiagnosisEventType,
    DiagnosisRankedYear,
    NumericSeries,
    SeriesCoreDiagnosis,
} from "./types";

export type GlobalEditAlignmentConfig = {
    maximumEdits: number;
    diagonalBand: number;
    gapPenalty: number;
    rawWeight: number;
    whitenedWeight: number;
    signWeight: number;
    minimumScoreGain: number;
    eventWindowWidth: number;
    groupingYears: number;
};

export const DEFAULT_GLOBAL_EDIT_ALIGNMENT_CONFIG: GlobalEditAlignmentConfig = {
    maximumEdits: 5,
    diagonalBand: 7,
    gapPenalty: 1.35,
    rawWeight: 0.45,
    whitenedWeight: 0.45,
    signWeight: 0.1,
    minimumScoreGain: 1.5,
    eventWindowWidth: 7,
    groupingYears: 3,
};

type SequencePoint = {
    year: number;
    raw: number;
    whitened: number | null;
};

type Operation = "match" | "missing" | "false";

type BackPointer = {
    previousI: number;
    previousJ: number;
    previousEdits: number;
    operation: Operation;
};

type AlignmentGap = {
    type: "missing" | "false";
    year: number;
    contribution: number;
};

export type GlobalEditAlignmentResult = {
    score: number;
    noEditScore: number;
    scoreGain: number;
    gaps: AlignmentGap[];
    matchedPairs: number;
};

const sequenceForTarget = (diagnosis: SeriesCoreDiagnosis): SequencePoint[] => {
    const raw = preprocessSeries(diagnosis.rawTarget);
    const whitened = ar1WhitenSeries(diagnosis.rawTarget);
    return Array.from(raw.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([year, value]) => ({
            year,
            raw: value,
            whitened: whitened.get(year) ?? null,
        }));
};

const sequenceForMaster = (
    master: NumericSeries,
    newestYear: number,
    length: number,
): SequencePoint[] => {
    const raw = preprocessSeries(master);
    const whitened = ar1WhitenSeries(master);
    const points: SequencePoint[] = [];
    for (let year = newestYear; year > newestYear - length; year -= 1) {
        const value = raw.get(year);
        if (value === undefined) continue;
        points.push({ year, raw: value, whitened: whitened.get(year) ?? null });
    }
    return points;
};

const boundedSimilarity = (a: number, b: number): number => (
    1 - Math.min(3, Math.abs(a - b)) / 1.5
);

const matchScore = (
    target: SequencePoint,
    master: SequencePoint,
    config: GlobalEditAlignmentConfig,
): number => {
    const raw = boundedSimilarity(target.raw, master.raw);
    const whitened = target.whitened !== null && master.whitened !== null
        ? boundedSimilarity(target.whitened, master.whitened)
        : 0;
    const sign = Math.sign(target.raw) === Math.sign(master.raw) ? 1 : -1;
    return 1
        + raw * config.rawWeight
        + whitened * config.whitenedWeight
        + sign * config.signWeight;
};

const key = (i: number, j: number, edits: number): string => `${i}:${j}:${edits}`;

const noEditAlignmentScore = (
    target: SequencePoint[],
    master: SequencePoint[],
    config: GlobalEditAlignmentConfig,
): number => {
    const pairs = Math.min(target.length, master.length);
    let score = 0;
    for (let index = 0; index < pairs; index += 1) {
        score += matchScore(target[index], master[index], config);
    }
    return score;
};

export const runGlobalEditAlignment = (
    diagnosis: SeriesCoreDiagnosis,
    overrides: Partial<GlobalEditAlignmentConfig> = {},
): GlobalEditAlignmentResult | null => {
    const config = { ...DEFAULT_GLOBAL_EDIT_ALIGNMENT_CONFIG, ...overrides };
    const target = sequenceForTarget(diagnosis);
    if (target.length < 40) return null;
    const newestLag = Math.abs(diagnosis.globalSlidingMatch.bestGlobalLag) <= 3
        ? 0
        : diagnosis.globalSlidingMatch.bestGlobalLag;
    const master = sequenceForMaster(
        diagnosis.master.data,
        diagnosis.targetRange.endYear + newestLag,
        target.length + config.maximumEdits + config.diagonalBand,
    );
    if (master.length < 40) return null;

    const scores = new Map<string, number>();
    const back = new Map<string, BackPointer>();
    scores.set(key(0, 0, 0), 0);
    const update = (
        i: number,
        j: number,
        edits: number,
        score: number,
        pointer: BackPointer,
    ) => {
        const nextKey = key(i, j, edits);
        const current = scores.get(nextKey);
        if (current === undefined || score > current) {
            scores.set(nextKey, score);
            back.set(nextKey, pointer);
        }
    };

    for (let i = 0; i <= target.length; i += 1) {
        const minimumJ = Math.max(0, i - config.diagonalBand);
        const maximumJ = Math.min(master.length, i + config.diagonalBand);
        for (let j = minimumJ; j <= maximumJ; j += 1) {
            for (let edits = 0; edits <= config.maximumEdits; edits += 1) {
                const stateScore = scores.get(key(i, j, edits));
                if (stateScore === undefined) continue;
                if (i < target.length && j < master.length) {
                    update(i + 1, j + 1, edits, stateScore + matchScore(target[i], master[j], config), {
                        previousI: i,
                        previousJ: j,
                        previousEdits: edits,
                        operation: "match",
                    });
                }
                if (edits >= config.maximumEdits) continue;
                if (j < master.length) {
                    update(i, j + 1, edits + 1, stateScore - config.gapPenalty, {
                        previousI: i,
                        previousJ: j,
                        previousEdits: edits,
                        operation: "missing",
                    });
                }
                if (i < target.length) {
                    update(i + 1, j, edits + 1, stateScore - config.gapPenalty, {
                        previousI: i,
                        previousJ: j,
                        previousEdits: edits,
                        operation: "false",
                    });
                }
            }
        }
    }

    let best: { score: number; j: number; edits: number } | null = null;
    for (let j = Math.max(1, target.length - config.maximumEdits); j <= Math.min(master.length, target.length + config.maximumEdits); j += 1) {
        for (let edits = 1; edits <= config.maximumEdits; edits += 1) {
            const score = scores.get(key(target.length, j, edits));
            if (score === undefined || (best && score <= best.score)) continue;
            best = { score, j, edits };
        }
    }
    if (!best) return null;

    const gaps: AlignmentGap[] = [];
    let i = target.length;
    let j = best.j;
    let edits = best.edits;
    let matchedPairs = 0;
    while (i > 0 || j > 0) {
        const pointer = back.get(key(i, j, edits));
        if (!pointer) break;
        if (pointer.operation === "match") matchedPairs += 1;
        if (pointer.operation === "missing") {
            const point = master[pointer.previousJ];
            if (point) gaps.push({ type: "missing", year: point.year, contribution: -config.gapPenalty });
        }
        if (pointer.operation === "false") {
            const targetPoint = target[pointer.previousI];
            const masterPoint = master[pointer.previousJ];
            if (targetPoint) {
                gaps.push({
                    type: "false",
                    year: masterPoint?.year ?? targetPoint.year,
                    contribution: -config.gapPenalty,
                });
            }
        }
        i = pointer.previousI;
        j = pointer.previousJ;
        edits = pointer.previousEdits;
    }
    gaps.reverse();
    const noEditScore = noEditAlignmentScore(target, master, config);
    return {
        score: best.score,
        noEditScore,
        scoreGain: best.score - noEditScore,
        gaps,
        matchedPairs,
    };
};

const windowAround = (
    year: number,
    width: number,
    minimum: number,
    maximum: number,
): { startYear: number; endYear: number } => {
    const actualWidth = Math.min(width, maximum - minimum + 1);
    let startYear = year - Math.floor((actualWidth - 1) / 2);
    startYear = Math.max(minimum, Math.min(startYear, maximum - actualWidth + 1));
    return { startYear, endYear: startYear + actualWidth - 1 };
};

const confidenceFor = (gain: number): DiagnosisConfidence => (
    gain >= 8 ? "high" : gain >= 4 ? "medium" : "low"
);

const rankedYears = (startYear: number, endYear: number, centerYear: number): DiagnosisRankedYear[] => (
    Array.from({ length: endYear - startYear + 1 }, (_, offset) => {
        const year = startYear + offset;
        return {
            year,
            score: -Math.abs(year - centerYear),
            evidenceTags: ["global_banded_edit_alignment"],
        };
    })
        .sort((a, b) => b.score - a.score || a.year - b.year)
        .map((row, index) => ({ ...row, rank: index + 1 }))
);

type GapGroup = { type: AlignmentGap["type"]; years: number[] };

const groupGaps = (gaps: AlignmentGap[], radius: number): GapGroup[] => {
    const groups: GapGroup[] = [];
    [...gaps].sort((a, b) => a.year - b.year).forEach((gap) => {
        const current = groups[groups.length - 1];
        if (current && current.type === gap.type
            && gap.year - current.years[current.years.length - 1] <= radius) {
            current.years.push(gap.year);
        } else {
            groups.push({ type: gap.type, years: [gap.year] });
        }
    });
    return groups;
};

export const locateGlobalEditEvents = (
    diagnosis: SeriesCoreDiagnosis,
    overrides: Partial<GlobalEditAlignmentConfig> = {},
): DiagnosisEvent[] => {
    const config = { ...DEFAULT_GLOBAL_EDIT_ALIGNMENT_CONFIG, ...overrides };
    const result = runGlobalEditAlignment(diagnosis, config);
    if (!result || result.scoreGain < config.minimumScoreGain) return [];
    return groupGaps(result.gaps, config.groupingYears).map((group, index) => {
        const centerYear = Math.round(group.years.reduce((sum, year) => sum + year, 0) / group.years.length);
        const eventType: DiagnosisEventType = group.years.length === 1
            ? group.type === "missing" ? "missingRing" : "falseRing"
            : "partialMove";
        const width = eventType === "partialMove" ? 9 : config.eventWindowWidth;
        const window = windowAround(
            centerYear,
            width,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
        );
        const shiftYears = group.type === "missing" ? -group.years.length : group.years.length;
        return {
            id: `diagnosis-event-${diagnosis.targetTree}-global-edit-${index}-${centerYear}`,
            seriesId: diagnosis.targetTree,
            eventType,
            ...window,
            rankedYears: rankedYears(window.startYear, window.endYear, centerYear),
            confidenceLevel: confidenceFor(result.scoreGain),
            evidence: {
                algorithmSources: ["global_banded_edit_alignment"],
                score: result.scoreGain,
                scoreMargin: result.scoreGain,
                baselineCorrelation: diagnosis.globalSlidingMatch.currentR,
                correctedCorrelation: diagnosis.globalSlidingMatch.bestGlobalR,
                correlationGain: diagnosis.globalSlidingMatch.bestGlobalR === null
                    ? null
                    : diagnosis.globalSlidingMatch.bestGlobalR
                        - (diagnosis.globalSlidingMatch.currentR ?? 0),
                lagBefore: shiftYears,
                lagAfter: 0,
                samplePairs: result.matchedPairs,
                candidateIds: [],
                notes: ["semi_global_end_anchored_alignment", "score_is_not_probability"],
            },
            alternativeTypes: [],
            ...(eventType === "partialMove" ? {
                shiftYears,
                shiftSide: "older" as const,
            } : {}),
        };
    });
};
