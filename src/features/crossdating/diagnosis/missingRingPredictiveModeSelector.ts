import type { MissingRingCoarseCounterfactualRow } from "./missingRingCoarseCounterfactual";
import type { UnitEventRankerWindow } from "./unitEventWindowRanker";

const WINDOW_WIDTH = 13;
const PROFILE = "differencePredictiveEnsembleHuber31" as const;
const MINIMUM_START_DISTANCE = 5;
const MINIMUM_ADVANTAGE = 0.15;
const MINIMUM_REMOTE_MARGIN = 0.1;

export type MissingRingPredictiveModeResult = {
    window: UnitEventRankerWindow;
    peakYear: number;
    score: number;
    advantage: number;
    remoteMargin: number;
    startDistance: number;
    scoredWindows: Array<UnitEventRankerWindow & { score: number }>;
};

const percentileRanks = (values: readonly number[]): number[] => {
    if (values.length <= 1) return values.map(() => 0.5);
    const order = values.map((_, index) => index).sort((left, right) => (
        (values[left] ?? 0) - (values[right] ?? 0) || left - right
    ));
    const ranks = new Array<number>(values.length).fill(0);
    for (let start = 0; start < order.length;) {
        let end = start + 1;
        while (
            end < order.length
            && values[order[end] ?? 0] === values[order[start] ?? 0]
        ) end += 1;
        const rank = (start + end - 1) / (2 * (order.length - 1));
        for (let index = start; index < end; index += 1) {
            ranks[order[index] ?? 0] = rank;
        }
        start = end;
    }
    return ranks;
};

const boundedStart = (
    centerYear: number,
    firstYear: number,
    lastYear: number,
): number => Math.max(
    firstYear,
    Math.min(
        centerYear - Math.floor(WINDOW_WIDTH / 2),
        lastYear - WINDOW_WIDTH + 1,
    ),
);

/**
 * Replaces a remote missing-ring mode only when one independent predictive
 * insertion profile has a separated peak with calibrated cross-split support.
 */
export const selectMissingRingPredictiveMode = (
    rows: readonly MissingRingCoarseCounterfactualRow[],
    currentModeWindow: UnitEventRankerWindow,
): MissingRingPredictiveModeResult | null => {
    const ordered = [...rows].sort((left, right) => left.year - right.year);
    const firstYear = ordered[0]?.year;
    const lastYear = ordered[ordered.length - 1]?.year;
    if (
        firstYear === undefined
        || lastYear === undefined
        || lastYear - firstYear + 1 < WINDOW_WIDTH
        || ordered.some((row, index) => row.year !== firstYear + index)
    ) return null;

    const ranks = percentileRanks(ordered.map((row) => row.profiles[PROFILE]));
    const peakIndex = ranks.reduce((best, value, index) => (
        value > (ranks[best] ?? -Infinity)
        || (
            value === (ranks[best] ?? -Infinity)
            && (ordered[index]?.year ?? -Infinity)
                > (ordered[best]?.year ?? -Infinity)
        ) ? index : best
    ), 0);
    const peakYear = ordered[peakIndex]?.year;
    if (peakYear === undefined) return null;

    const selectedStart = boundedStart(peakYear, firstYear, lastYear);
    const currentCenter = Math.round(
        (currentModeWindow.startYear + currentModeWindow.endYear) / 2,
    );
    const currentStart = boundedStart(currentCenter, firstYear, lastYear);
    if (selectedStart === currentStart) return null;

    const scoreForStart = (startYear: number): number => {
        const centerIndex = startYear + Math.floor(WINDOW_WIDTH / 2) - firstYear;
        return ranks[centerIndex] ?? 0;
    };
    const selectedScore = scoreForStart(selectedStart);
    const currentScore = scoreForStart(currentStart);
    const competingScores: number[] = [];
    for (
        let start = firstYear;
        start <= lastYear - WINDOW_WIDTH + 1;
        start += 1
    ) {
        if (
            start + WINDOW_WIDTH - 1 < selectedStart
            || start > selectedStart + WINDOW_WIDTH - 1
        ) competingScores.push(scoreForStart(start));
    }
    const competingMaximum = competingScores.length > 0
        ? Math.max(...competingScores)
        : selectedScore;
    const remoteMargin = selectedScore - competingMaximum;
    const advantage = selectedScore - currentScore;
    const startDistance = Math.abs(selectedStart - currentStart);
    if (
        startDistance < MINIMUM_START_DISTANCE
        || advantage < MINIMUM_ADVANTAGE
        || remoteMargin < MINIMUM_REMOTE_MARGIN
    ) return null;

    return {
        window: {
            startYear: selectedStart,
            endYear: selectedStart + WINDOW_WIDTH - 1,
        },
        peakYear,
        score: selectedScore,
        advantage,
        remoteMargin,
        startDistance,
        scoredWindows: Array.from(
            { length: lastYear - firstYear - WINDOW_WIDTH + 2 },
            (_, index) => ({
                startYear: firstYear + index,
                endYear: firstYear + index + WINDOW_WIDTH - 1,
                score: scoreForStart(firstYear + index),
            }),
        ).sort((left, right) => (
            right.score - left.score || left.startYear - right.startYear
        )),
    };
};
