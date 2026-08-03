/** Conservative final-mode correction from the full virtual-edit evidence curve. */
import {
    FALSE_RING_COUNTERFACTUAL_PROFILES,
    type FalseRingCoarseCounterfactualRow,
} from "./falseRingCoarseCounterfactual";

const WINDOW_WIDTH = 13;
const HALF_WIDTH = Math.floor(WINDOW_WIDTH / 2);

export type CounterfactualMassSelection = {
    window: { startYear: number; endYear: number };
    centerYear: number;
    aggregateAdvantage: number;
    minimumProfileAdvantage: number;
    medianProfileAdvantage: number;
    profileCenterDispersion: number;
    centerDistance: number;
    localMargin: number;
};

const mean = (values: readonly number[]): number => (
    values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
);

const median = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : sorted[middle] ?? 0;
};

const standardize = (values: readonly number[]): number[] => {
    const center = mean(values);
    const variance = mean(values.map((value) => (value - center) ** 2));
    const scale = Math.sqrt(variance) || 1;
    return values.map((value) => (value - center) / scale);
};

const rollingSums = (values: readonly number[]): number[] => {
    if (values.length < WINDOW_WIDTH) return [];
    const result = [values.slice(0, WINDOW_WIDTH).reduce(
        (sum, value) => sum + value,
        0,
    )];
    for (let index = 1; index <= values.length - WINDOW_WIDTH; index += 1) {
        result.push(
            (result[index - 1] ?? 0)
            - (values[index - 1] ?? 0)
            + (values[index + WINDOW_WIDTH - 1] ?? 0),
        );
    }
    return result;
};

const maximumIndex = (
    scores: readonly number[],
    years: readonly number[],
    currentCenter: number,
): number => scores.reduce((selected, score, index) => {
    const selectedScore = scores[selected] ?? Number.NEGATIVE_INFINITY;
    if (score !== selectedScore) return score > selectedScore ? index : selected;
    const distance = Math.abs((years[index] ?? 0) + HALF_WIDTH - currentCenter);
    const selectedDistance = Math.abs(
        (years[selected] ?? 0) + HALF_WIDTH - currentCenter,
    );
    if (distance !== selectedDistance) return distance < selectedDistance ? index : selected;
    return (years[index] ?? 0) > (years[selected] ?? 0) ? index : selected;
}, 0);

/**
 * Re-centers only a difficult 13-year false-ring mode. Thresholds were frozen
 * with file-grouped OOF plus calibration data before two reserved audits.
 */
export const selectFalseRingCounterfactualMassWindow = (input: {
    rows: readonly FalseRingCoarseCounterfactualRow[];
    currentModeWindow: { startYear: number; endYear: number };
}): CounterfactualMassSelection | null => {
    const rows = input.rows;
    if (
        rows.length < WINDOW_WIDTH
        || input.currentModeWindow.endYear
            - input.currentModeWindow.startYear + 1 !== WINDOW_WIDTH
        || rows.some((row, index) => (
            index > 0 && row.year !== (rows[index - 1]?.year ?? row.year) + 1
        ))
    ) return null;

    const years = rows.map((row) => row.year);
    const profileWindowScores = FALSE_RING_COUNTERFACTUAL_PROFILES.map((profile) => (
        rollingSums(standardize(rows.map((row) => row.profiles[profile] ?? -10)))
    ));
    const aggregateScores = profileWindowScores[0].map((_, index) => median(
        profileWindowScores.map((profile) => profile[index] ?? 0),
    ));
    const currentCenter = (
        input.currentModeWindow.startYear + input.currentModeWindow.endYear
    ) / 2;
    const selectedIndex = maximumIndex(aggregateScores, years, currentCenter);
    const firstYear = years[0] ?? input.currentModeWindow.startYear;
    const lastStartYear = (years[years.length - 1] ?? firstYear) - WINDOW_WIDTH + 1;
    const currentStartYear = Math.max(
        firstYear,
        Math.min(Math.round(currentCenter) - HALF_WIDTH, lastStartYear),
    );
    const currentIndex = currentStartYear - firstYear;
    if (currentIndex < 0 || currentIndex >= aggregateScores.length) return null;

    const profileAdvantages = profileWindowScores.map((profile) => (
        (profile[selectedIndex] ?? 0) - (profile[currentIndex] ?? 0)
    ));
    const profileCenters = profileWindowScores.map((profile) => (
        (years[maximumIndex(profile, years, currentCenter)] ?? firstYear) + HALF_WIDTH
    ));
    const selectedStartYear = years[selectedIndex] ?? currentStartYear;
    const selectedCenter = selectedStartYear + HALF_WIDTH;
    const competitors = aggregateScores.filter((_, index) => (
        Math.abs(((years[index] ?? firstYear) + HALF_WIDTH) - selectedCenter) > 2
    ));
    const aggregateAdvantage = (aggregateScores[selectedIndex] ?? 0)
        - (aggregateScores[currentIndex] ?? 0);
    const minimumProfileAdvantage = Math.min(...profileAdvantages);
    const medianProfileAdvantage = median(profileAdvantages);
    const profileCenterDispersion =
        Math.max(...profileCenters) - Math.min(...profileCenters);
    const centerDistance = Math.abs(selectedCenter - currentCenter);
    const competingScore = competitors.length > 0
        ? Math.max(...competitors)
        : aggregateScores[selectedIndex] ?? 0;
    const localMargin = (aggregateScores[selectedIndex] ?? 0) - competingScore;

    if (
        aggregateAdvantage < 0
        || minimumProfileAdvantage < -0.5
        || medianProfileAdvantage < 0
        || centerDistance > 8
        || localMargin < 0.1
        || selectedStartYear === input.currentModeWindow.startYear
    ) return null;

    return {
        window: {
            startYear: selectedStartYear,
            endYear: selectedStartYear + WINDOW_WIDTH - 1,
        },
        centerYear: selectedCenter,
        aggregateAdvantage,
        minimumProfileAdvantage,
        medianProfileAdvantage,
        profileCenterDispersion,
        centerDistance,
        localMargin,
    };
};
