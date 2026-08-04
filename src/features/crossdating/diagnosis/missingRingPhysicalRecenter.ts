import type { MissingRingCoarseCounterfactualRow } from "./missingRingCoarseCounterfactual";
import type {
    UnitEventRankerCandidate,
    UnitEventRankerOperationEvidence,
    UnitEventRankerWindow,
} from "./unitEventWindowRanker";

export type MissingRingPhysicalRecenterRule =
    | "uncertain_pair_superset_13"
    | "remote_pair_consensus_13"
    | "side_conflict_pair_consensus_13"
    | "reference_side_fraction_13"
    | "sharp_newer_boundary_13"
    | "remote_newer_consensus_13";

export type MissingRingPhysicalRecenterResult = {
    window: UnitEventRankerWindow;
    rule: MissingRingPhysicalRecenterRule;
    supportCount: number;
};

export type MissingRingPhysicalRecenterInput = {
    years: readonly number[];
    ranks: ReadonlyMap<string, readonly number[]>;
    currentWindow: UnitEventRankerWindow;
    coarseWindow: UnitEventRankerWindow;
    coarseSource: string;
    candidates: readonly UnitEventRankerCandidate[];
    calibrationRule?: string;
    windowCenteringRule: string;
    learnedWindowMargin: number;
    learnedWindowRemoteMargin: number;
    nineYearSafety: number;
    nineYearSafetyThreshold: number;
    coarseModelMargin?: number;
    operationEvidence?: UnitEventRankerOperationEvidence;
    counterfactualRows: readonly MissingRingCoarseCounterfactualRow[];
};

const WIDE_WIDTH = 13;
const EPSILON = 1e-12;

const center = (window: UnitEventRankerWindow): number => (
    (window.startYear + window.endYear) / 2
);

const width = (window: UnitEventRankerWindow): number => (
    window.endYear - window.startYear + 1
);

const contains = (
    window: UnitEventRankerWindow,
    year: number | undefined,
): boolean => (
    year !== undefined
    && year >= window.startYear
    && year <= window.endYear
);

const overlapYears = (
    left: UnitEventRankerWindow,
    right: UnitEventRankerWindow,
): number => Math.max(
    0,
    Math.min(left.endYear, right.endYear)
        - Math.max(left.startYear, right.startYear)
        + 1,
);

const percentileRanks = (values: readonly number[]): number[] => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const result = new Array(values.length).fill(0);
    let start = 0;
    while (start < ordered.length) {
        let end = start + 1;
        while (
            end < ordered.length
            && ordered[end]?.value === ordered[start]?.value
        ) end += 1;
        const rank = ((start + end - 1) / 2)
            / Math.max(1, ordered.length - 1);
        for (let index = start; index < end; index += 1) {
            result[ordered[index]!.index] = rank;
        }
        start = end;
    }
    return result;
};

const bestMassWindow = (
    years: readonly number[],
    scores: readonly number[],
    coarseWindow: UnitEventRankerWindow,
    currentWindow: UnitEventRankerWindow,
): UnitEventRankerWindow | null => {
    if (years.length !== scores.length || years.length < WIDE_WIDTH) return null;
    let selected: (UnitEventRankerWindow & {
        mass: number;
        distance: number;
    }) | null = null;
    for (let index = 0; index <= years.length - WIDE_WIDTH; index += 1) {
        const startYear = years[index];
        const endYear = years[index + WIDE_WIDTH - 1];
        if (
            startYear === undefined
            || endYear === undefined
            || endYear - startYear + 1 !== WIDE_WIDTH
            || startYear < coarseWindow.startYear
            || endYear > coarseWindow.endYear
        ) continue;
        let mass = 0;
        for (let offset = 0; offset < WIDE_WIDTH; offset += 1) {
            mass += scores[index + offset] ?? 0;
        }
        const candidate = { startYear, endYear };
        const distance = Math.abs(center(candidate) - center(currentWindow));
        if (
            !selected
            || mass > selected.mass + EPSILON
            || (
                Math.abs(mass - selected.mass) <= EPSILON
                && distance < selected.distance
            )
        ) selected = { ...candidate, mass, distance };
    }
    return selected
        ? { startYear: selected.startYear, endYear: selected.endYear }
        : null;
};

const bestRankWindow = (
    input: MissingRingPhysicalRecenterInput,
    profile: string,
): UnitEventRankerWindow | null => {
    const scores = input.ranks.get(profile);
    return scores
        ? bestMassWindow(
                input.years,
                scores,
                input.coarseWindow,
                input.currentWindow,
            )
        : null;
};

const bestCounterfactualWindow = (
    input: MissingRingPhysicalRecenterInput,
    profile: "whitenedPredictiveMedianHuberEdge3Gain",
): UnitEventRankerWindow | null => {
    const ordered = [...input.counterfactualRows].sort(
        (left, right) => left.year - right.year,
    );
    const scores = percentileRanks(ordered.map(
        (row) => row.profiles[profile] ?? -10,
    ));
    return bestMassWindow(
        ordered.map((row) => row.year),
        scores,
        input.coarseWindow,
        input.currentWindow,
    );
};

const result = (
    window: UnitEventRankerWindow,
    rule: MissingRingPhysicalRecenterRule,
    supportCount = 1,
): MissingRingPhysicalRecenterResult => ({ window, rule, supportCount });

/**
 * Resolve the last missing-ring mode competition after width calibration.
 * Every remote move requires agreement from independently computed physical
 * evidence; the only widening rule must contain the existing window.
 */
export const selectMissingRingPhysicalRecenter = (
    input: MissingRingPhysicalRecenterInput,
): MissingRingPhysicalRecenterResult | null => {
    const operation = input.operationEvidence;
    if (!operation) return null;
    const pairWindow = bestRankWindow(
        input,
        "pairDifferenceGainWeighted",
    );
    if (pairWindow) {
        const containsCurrent = (
            pairWindow.startYear <= input.currentWindow.startYear
            && pairWindow.endYear >= input.currentWindow.endYear
        );
        if (
            width(input.currentWindow) < WIDE_WIDTH
            && containsCurrent
            && input.learnedWindowMargin <= 0.02
            && input.nineYearSafety < input.nineYearSafetyThreshold
            && input.calibrationRule
                === "unit_event_short_window_missing_concentrated_profile_9"
            && (operation.bestDifferenceGain ?? Infinity) <= 0.2
            && (operation.sideStepRemoteMargin ?? -Infinity) >= 0.15
        ) return result(pairWindow, "uncertain_pair_superset_13");

        if (
            input.windowCenteringRule === "missing_evidence_profile_mode"
            && center(pairWindow) <= center(input.currentWindow) - 8
            && (operation.bestDifferenceGain ?? Infinity) <= 0.45
            && (operation.sideStepRemoteMargin ?? -Infinity) >= 0.1
            && input.learnedWindowRemoteMargin >= 0.5
        ) return result(pairWindow, "remote_pair_consensus_13");

        if (
            input.windowCenteringRule === "missing_mode_side_corrector"
            && center(pairWindow) <= center(input.currentWindow) - 8
            && input.learnedWindowMargin > 0.1
            && input.learnedWindowRemoteMargin > 0.2
            && contains(pairWindow, operation.sideStepBestYear)
            && !contains(input.currentWindow, operation.sideStepBestYear)
        ) return result(pairWindow, "side_conflict_pair_consensus_13", 2);
    }

    const referenceFractionWindow = bestRankWindow(
        input,
        "pairPositiveSideStepFraction",
    );
    if (
        referenceFractionWindow
        && input.windowCenteringRule === "missing_physical_profile_mode"
        && center(referenceFractionWindow) <= center(input.currentWindow) - 2
        && (input.coarseModelMargin ?? -Infinity) >= 0.3
        && (operation.bestDifferenceGain ?? Infinity) <= 0.2
    ) {
        return result(
            referenceFractionWindow,
            "reference_side_fraction_13",
        );
    }

    const sharpBoundaryWindow = bestCounterfactualWindow(
        input,
        "whitenedPredictiveMedianHuberEdge3Gain",
    );
    if (
        sharpBoundaryWindow
        && input.windowCenteringRule === "missing_evidence_profile_mode"
        && input.currentWindow.startYear <= input.coarseWindow.startYear + 1
        && center(sharpBoundaryWindow) >= center(input.currentWindow) + 8
        && (operation.bestDifferenceGain ?? Infinity) <= 0.1
        && (input.coarseModelMargin ?? -Infinity) >= 0.3
    ) return result(sharpBoundaryWindow, "sharp_newer_boundary_13");

    const newerWindow = {
        startYear: input.coarseWindow.endYear - WIDE_WIDTH + 1,
        endYear: input.coarseWindow.endYear,
    };
    const newerSupport = input.candidates.filter((candidate) => (
        overlapYears(candidate, newerWindow) >= 5
        && center(candidate) > center(input.currentWindow) + 6
    )).length;
    if (
        input.coarseSource === "current_event"
        && input.coarseWindow.endYear - input.currentWindow.endYear >= 10
        && (operation.bestDifferenceGain ?? Infinity) <= 0.1
        && (operation.bestSideStepScore ?? Infinity) <= 0.25
        && newerSupport >= 4
    ) return result(newerWindow, "remote_newer_consensus_13", newerSupport);

    return null;
};
