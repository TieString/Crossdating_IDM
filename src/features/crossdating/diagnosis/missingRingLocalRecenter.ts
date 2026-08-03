import type { MissingRingCoarseCounterfactualRow } from "./missingRingCoarseCounterfactual";
import type {
    UnitEventRankerOperationEvidence,
    UnitEventRankerWindow,
} from "./unitEventWindowRanker";

const MODE_WIDTH = 13;

export type MissingRingLocalRecenterResult = {
    window: UnitEventRankerWindow;
    centerYear: number;
    peakYear: number;
    shiftYears: -2 | -1 | 1 | 2;
    advantage: number;
    rule: "boundary_feature_step_1" | "boundary_anchor_consensus_step_2";
};

type RecenterInput = {
    rows: readonly MissingRingCoarseCounterfactualRow[];
    currentWindow: UnitEventRankerWindow;
    containingWindow: UnitEventRankerWindow;
    currentPrimaryYear?: number;
    operationEvidence?: UnitEventRankerOperationEvidence;
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

const profilePeak = (
    rows: readonly MissingRingCoarseCounterfactualRow[],
    profile: "whitenedPredictiveMedianHuberEdge3Gain"
        | "whitenedOlderHuberBoundary7",
    possibleCenters: readonly number[],
): { peakYear: number; advantageAt: (year: number) => number } | null => {
    const ordered = [...rows].sort((left, right) => left.year - right.year);
    const values = ordered.map((row) => row.profiles[profile]);
    if (
        values.some((value) => value === undefined || !Number.isFinite(value))
    ) return null;
    const ranks = percentileRanks(values as number[]);
    const indexByYear = new Map(ordered.map((row, index) => [row.year, index]));
    const available = possibleCenters.filter((year) => indexByYear.has(year));
    if (available.length === 0) return null;
    const peakYear = available.reduce((best, year) => {
        const score = ranks[indexByYear.get(year) ?? 0] ?? 0;
        const bestScore = ranks[indexByYear.get(best) ?? 0] ?? 0;
        return score > bestScore || (score === bestScore && year > best)
            ? year
            : best;
    }, available[0] ?? 0);
    const peakScore = ranks[indexByYear.get(peakYear) ?? 0] ?? 0;
    return {
        peakYear,
        advantageAt: (year) => (
            peakScore - (ranks[indexByYear.get(year) ?? 0] ?? 0)
        ),
    };
};

const center = (window: UnitEventRankerWindow): number => Math.round(
    (window.startYear + window.endYear) / 2,
);

const direction = (from: number, to: number): -1 | 0 | 1 => (
    to < from ? -1 : to > from ? 1 : 0
);

export const recenterMissingRingNarrowWindow = (
    input: RecenterInput,
): MissingRingLocalRecenterResult | null => {
    const width = input.currentWindow.endYear - input.currentWindow.startYear + 1;
    if (width >= MODE_WIDTH || width % 2 === 0) return null;
    const currentCenter = center(input.currentWindow);
    const half = Math.floor(width / 2);
    const possibleCenters: number[] = [];
    for (
        let year = input.containingWindow.startYear + half;
        year <= input.containingWindow.endYear - half;
        year += 1
    ) possibleCenters.push(year);
    const peak = profilePeak(
        input.rows,
        "whitenedPredictiveMedianHuberEdge3Gain",
        possibleCenters,
    );
    if (!peak) return null;
    const peakDirection = direction(currentCenter, peak.peakYear);
    const distance = Math.abs(peak.peakYear - currentCenter);
    const advantage = peak.advantageAt(currentCenter);
    if (peakDirection === 0 || distance < 2 || advantage < 0.2) return null;

    const anchors = [
        input.currentPrimaryYear,
        input.operationEvidence?.bestYear,
        input.operationEvidence?.sideStepBestYear,
    ];
    const hasTightAnchorConsensus = anchors.every((year) => (
        year !== undefined && direction(currentCenter, year) === peakDirection
    )) && Math.max(...anchors as number[]) - Math.min(...anchors as number[]) <= 4;
    const magnitude = hasTightAnchorConsensus ? 2 : 1;
    const shiftYears = (peakDirection * magnitude) as -2 | -1 | 1 | 2;
    const window = {
        startYear: input.currentWindow.startYear + shiftYears,
        endYear: input.currentWindow.endYear + shiftYears,
    };
    if (
        window.startYear < input.containingWindow.startYear
        || window.endYear > input.containingWindow.endYear
    ) return null;
    return {
        window,
        centerYear: currentCenter + shiftYears,
        peakYear: peak.peakYear,
        shiftYears,
        advantage,
        rule: hasTightAnchorConsensus
            ? "boundary_anchor_consensus_step_2"
            : "boundary_feature_step_1",
    };
};

export const recenterMissingRingWideWindow = (
    rows: readonly MissingRingCoarseCounterfactualRow[],
    currentWindow: UnitEventRankerWindow,
    coarseWindow: UnitEventRankerWindow,
): MissingRingLocalRecenterResult | null => {
    if (currentWindow.endYear - currentWindow.startYear + 1 !== MODE_WIDTH) {
        return null;
    }
    const currentCenter = center(currentWindow);
    const possibleCenters: number[] = [];
    for (
        let year = coarseWindow.startYear + Math.floor(MODE_WIDTH / 2);
        year <= coarseWindow.endYear - Math.floor(MODE_WIDTH / 2);
        year += 1
    ) possibleCenters.push(year);
    const peak = profilePeak(
        rows,
        "whitenedOlderHuberBoundary7",
        possibleCenters,
    );
    if (!peak) return null;
    const peakDirection = direction(currentCenter, peak.peakYear);
    const advantage = peak.advantageAt(currentCenter);
    if (
        peakDirection === 0
        || Math.abs(peak.peakYear - currentCenter) !== 7
        || advantage < 0.2
    ) return null;
    const shiftYears = peakDirection as -1 | 1;
    return {
        window: {
            startYear: currentWindow.startYear + shiftYears,
            endYear: currentWindow.endYear + shiftYears,
        },
        centerYear: currentCenter + shiftYears,
        peakYear: peak.peakYear,
        shiftYears,
        advantage,
        rule: "boundary_feature_step_1",
    };
};
