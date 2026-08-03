import type {
    UnitEventRankerWindow,
    UnitEventWindowRankerInput,
} from "./unitEventWindowRanker";

const FAMILY_PROFILES = [
    [
        "cumulativeCombined",
        "cumulativeDifference",
        "cumulativeReferenceMean",
        "cumulativeReferenceMedian",
        "cumulativeReferenceVote",
    ],
    [
        "piecewiseCombinedObjective",
        "transitionSplitGain",
    ],
    [
        "pairDifferenceWeighted",
        "pairWhitenedMean",
        "pairPeakKernel5",
        "pairPeakKernel9",
    ],
    [
        "reference:rankMean",
        "reference:rankMedian",
        "reference:weightedRankMean",
        "reference:peakKernel5",
        "reference:peakKernel9",
        "reference:peakKernel13",
        "reference:windowVote25",
        "reference:weightedWindowVote25",
    ],
] as const;

const WINDOW_WIDTH = 13;
const MINIMUM_FAMILY_COUNT = 3;
const MINIMUM_FAMILY_VOTES = 2;
const MAXIMUM_FAMILY_SPREAD = 20;
const MINIMUM_CURRENT_ANCHOR_IMPROVEMENT = 1;

export type FalseRingFamilyModeResult = {
    window: UnitEventRankerWindow;
    score: number;
    gain: number;
    votes: number;
    spread: number;
    currentAnchorImprovement: number;
    scoredWindows: Array<UnitEventRankerWindow & { score: number }>;
};

export type FalseRingFamilyModeAcceptance =
    | "currentAnchor"
    | "boundedConsensus"
    | "unanimousRemote"
    | "validatedRemote";

const mean = (values: readonly number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : (sorted[middle] ?? 0);
};

const normalize = (values: readonly number[]): number[] => {
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const span = maximum - minimum;
    return span <= 1e-12
        ? values.map(() => 0)
        : values.map((value) => (value - minimum) / span);
};

const bestIndex = (values: readonly number[]): number => values.reduce(
    (best, value, index) => value > (values[best] ?? -Infinity)
        ? index
        : best,
    0,
);

const buildPrefix = (values: readonly number[]): number[] => {
    const prefix = new Array<number>(values.length + 1).fill(0);
    for (let index = 0; index < values.length; index += 1) {
        prefix[index + 1] = (prefix[index] ?? 0) + (values[index] ?? 0);
    }
    return prefix;
};

export const selectFalseRingFamilyMode = (
    input: UnitEventWindowRankerInput,
    currentModeWindow: UnitEventRankerWindow,
    acceptance: FalseRingFamilyModeAcceptance = "currentAnchor",
): FalseRingFamilyModeResult | null => {
    if (
        !(
            input.eventType === "falseRing"
            || (
                acceptance === "validatedRemote"
                && input.eventType === "missingRing"
            )
        )
        || !input.coarseWindow
        || input.currentPrimaryYear === undefined
    ) return null;
    const starts: number[] = [];
    for (
        let start = input.coarseWindow.startYear;
        start <= input.coarseWindow.endYear - WINDOW_WIDTH + 1;
        start += 1
    ) starts.push(start);
    if (starts.length === 0) return null;

    const indexByYear = new Map(input.years.map((year, index) => [
        year,
        index,
    ]));
    const familyCurves: number[][] = [];
    for (const profileNames of FAMILY_PROFILES) {
        const profileCurves: number[][] = [];
        for (const profileName of profileNames) {
            const profile = input.ranks.get(profileName);
            if (!profile || profile.length !== input.years.length) continue;
            const prefix = buildPrefix(profile);
            const masses = starts.map((start) => {
                const startIndex = indexByYear.get(start);
                const endIndex = indexByYear.get(start + WINDOW_WIDTH - 1);
                if (
                    startIndex === undefined
                    || endIndex === undefined
                    || endIndex - startIndex !== WINDOW_WIDTH - 1
                ) return 0;
                return (prefix[endIndex + 1] ?? 0)
                    - (prefix[startIndex] ?? 0);
            });
            profileCurves.push(normalize(masses));
        }
        if (profileCurves.length === 0) continue;
        familyCurves.push(starts.map((_, index) => mean(
            profileCurves.map((curve) => curve[index] ?? 0),
        )));
    }
    if (familyCurves.length < MINIMUM_FAMILY_COUNT) return null;

    const aggregate = starts.map((_, index) => median(
        familyCurves.map((curve) => curve[index] ?? 0),
    ));
    const selectedIndex = bestIndex(aggregate);
    const currentIndex = starts.reduce((best, start, index) => (
        Math.abs(start - currentModeWindow.startYear)
            < Math.abs((starts[best] ?? start) - currentModeWindow.startYear)
            ? index
            : best
    ), 0);
    const selectedStart = starts[selectedIndex];
    const currentStart = starts[currentIndex];
    if (selectedStart === undefined || currentStart === undefined) return null;

    const familyBestStarts = familyCurves.map((curve) => (
        starts[bestIndex(curve)] ?? selectedStart
    ));
    const votes = familyBestStarts.filter((start) => (
        Math.abs(start - selectedStart) <= 2
    )).length;
    const spread = Math.max(...familyBestStarts)
        - Math.min(...familyBestStarts);
    const selectedCenter = selectedStart + Math.floor(WINDOW_WIDTH / 2);
    const currentCenter = currentStart + Math.floor(WINDOW_WIDTH / 2);
    const currentAnchorImprovement = Math.abs(
        currentCenter - input.currentPrimaryYear,
    ) - Math.abs(selectedCenter - input.currentPrimaryYear);
    const gain = (aggregate[selectedIndex] ?? 0)
        - (aggregate[currentIndex] ?? 0);
    const distance = Math.abs(selectedStart - currentStart);
    const unanimous = familyCurves.length === FAMILY_PROFILES.length
        && votes === familyCurves.length;
    const accepted = acceptance === "validatedRemote"
        ? input.eventType === "missingRing"
            ? distance >= 5
                && gain >= 0
                && votes >= 1
                && spread <= 8
                && currentAnchorImprovement >= -2
            : distance >= 9
                && gain >= 0
                && votes >= 3
                && spread <= 8
        : acceptance === "unanimousRemote"
        ? unanimous
            && distance >= 5
            && gain >= 0.1
            && spread <= 3
        : acceptance === "boundedConsensus"
            ? unanimous
                && distance >= 2
                && distance <= 4
                && gain >= 0
                && spread <= 3
                && currentAnchorImprovement >= -2
        : gain >= 0
            && votes >= MINIMUM_FAMILY_VOTES
            && spread <= MAXIMUM_FAMILY_SPREAD
            && currentAnchorImprovement
                >= MINIMUM_CURRENT_ANCHOR_IMPROVEMENT;
    if (selectedStart === currentStart || !accepted) return null;

    return {
        window: {
            startYear: selectedStart,
            endYear: selectedStart + WINDOW_WIDTH - 1,
        },
        score: aggregate[selectedIndex] ?? 0,
        gain,
        votes,
        spread,
        currentAnchorImprovement,
        scoredWindows: starts.map((startYear, index) => ({
            startYear,
            endYear: startYear + WINDOW_WIDTH - 1,
            score: aggregate[index] ?? 0,
        })).sort((left, right) => (
            right.score - left.score || left.startYear - right.startYear
        )),
    };
};
