/**
 * Static full-interval window localization for unit missing- and false-ring events.
 *
 * Both unit events first build independently proposed physical modes. A coarse-window
 * virtual correction table then resolves the final 13-year mode. The older selectors
 * remain as runtime fallbacks when that table is unavailable. Runtime is TypeScript-only.
 */
import modelData from "./unitEventWindowRankerModel.json";
import type { FalseRingCoarseCounterfactualRow } from "./falseRingCoarseCounterfactual";
import { selectFalseRingCounterfactualMode } from "./falseRingCounterfactualModeSelector";
import { selectFalseRingFamilyMode } from "./falseRingFamilyModeSelector";
import { selectFalseRingMode } from "./falseRingModeSelector";
import { calibrateFalseRingWindow } from "./falseRingWindowCalibrator";
import type { MissingRingCoarseCounterfactualRow } from "./missingRingCoarseCounterfactual";
import { selectMissingRingCounterfactualMode } from "./missingRingCounterfactualModeSelector";
import { selectMissingRingDirectMode } from "./missingRingDirectModeSelector";
import {
    recenterMissingRingNarrowWindow,
    recenterMissingRingWideWindow,
} from "./missingRingLocalRecenter";
import { selectMissingRingMode } from "./missingRingModeSelector";
import { selectMissingRingPredictiveMode } from "./missingRingPredictiveModeSelector";
import { selectUnitEventPointWindow } from "./unitEventPointWindowSelector";
import { selectFalseRingCounterfactualMassWindow } from "./unitCounterfactualMassSelector";

export type UnitEventWindowType = "missingRing" | "falseRing";

export type UnitEventRankerWindow = {
    startYear: number;
    endYear: number;
};

export type UnitEventRankerCandidate = UnitEventRankerWindow & {
    source: string;
    aggregateScore?: number;
    overlapConsensus?: number;
};

export type UnitEventRankerOperationEvidence = {
    bestYear: number;
    bestRawGain?: number;
    bestDifferenceGain?: number;
    bestCombinedGain?: number;
    topThreeDifferenceGain?: number;
    remoteDifferenceMargin?: number;
    sideStepBestYear?: number;
    bestSideStepScore?: number;
    topThreeSideStepScore?: number;
    bestSideMinimumAdvantage?: number;
    bestCorrectedSideSupport?: number;
    sideStepRemoteMargin?: number;
};

export type UnitEventWindowRankerInput = {
    eventType: UnitEventWindowType;
    years: readonly number[];
    ranks: ReadonlyMap<string, readonly number[]>;
    internalCandidates: readonly UnitEventRankerCandidate[];
    currentPrimaryYear?: number;
    coarseWindow?: UnitEventRankerWindow;
    corroboratedFalseRingModeCenterYear?: number;
    operationEvidence?: UnitEventRankerOperationEvidence;
    missingCounterfactualRows?: readonly MissingRingCoarseCounterfactualRow[];
    falseCounterfactualRows?: readonly FalseRingCoarseCounterfactualRow[];
};

export type UnitEventWindowRankerResult = {
    /** The single calibrated window exposed to the diagnosis pipeline. */
    window: UnitEventRankerWindow;
    /** The selected 13-year location mode before case-level width calibration. */
    modeWindow: UnitEventRankerWindow;
    recommendedWidth: 5 | 7 | 9 | 13;
    nineYearSafety: number;
    widthThreshold: number;
    windowCenteringRule:
        | "mode_mass"
        | "corroborated_point_peak"
        | "missing_anchor_calibration"
        | "missing_coarse_operation_conflict"
        | "missing_open_flank_calibration"
        | "missing_direct_mode_ranker"
        | "missing_direct_anchor_consensus"
        | "missing_side_step_mode"
        | "missing_predictive_remote_mode"
        | "missing_family_remote_mode"
        | "missing_boundary_feature_recenter"
        | "missing_boundary_anchor_recenter"
        | "missing_adjacent_mode_recenter"
        | "false_current_candidate_consensus"
        | "false_point_mode"
        | "false_point_narrow_mode"
        | "false_counterfactual_mass"
        | "false_family_mode_consensus"
        | "false_family_remote_mode"
        | "false_current_anchor_consensus"
        | "false_side_step_mode"
        | "false_current_remote_mode";
    widthFallbackRule:
        | "none"
        | "remote_side_evidence"
        | "corroborated_point_peak";
    widthSelectionRule:
        | "legacy_model"
        | "missing_point_model"
        | "false_transition_mass"
        | "false_current_candidate_consensus"
        | "false_point_wide_model"
        | "missing_point_wide_model"
        | "false_point_narrow_model"
        | "false_point_safety_model"
        | "false_counterfactual_mass"
        | "false_family_mode_consensus"
        | "false_current_anchor_consensus"
        | "false_side_step_mode"
        | "false_current_remote_mode"
        | "missing_high_confidence_narrow"
        | "missing_anchor_wide"
        | "missing_coarse_operation_conflict"
        | "missing_open_flank_wide"
        | "missing_direct_mode_ranker"
        | "missing_direct_anchor_consensus"
        | "missing_side_step_mode"
        | "missing_predictive_remote_mode"
        | "missing_family_remote_mode"
        | "false_family_remote_mode"
        | "missing_boundary_feature_recenter"
        | "missing_boundary_anchor_recenter"
        | "missing_adjacent_mode_recenter"
        | "missing_anchor_edge_wide";
    score: number;
    margin: number;
    remoteMargin: number;
    scoredWindows: Array<UnitEventRankerWindow & { score: number }>;
    prePointModeWindow: UnitEventRankerWindow;
    preFalseCurrentAnchorModeWindow: UnitEventRankerWindow;
    preDirectModeWindow: UnitEventRankerWindow;
};

export const shouldUseCorroboratedPointPeak = (input: {
    recommendedWidth: 5 | 7 | 9 | 13;
    centerYear: number;
    peakYear: number;
    sideStepBestYear?: number;
}): boolean => (
    input.recommendedWidth === 9
    && Math.abs(input.centerYear - input.peakYear) >= 2
    && input.sideStepBestYear !== undefined
    && Math.abs(input.sideStepBestYear - input.peakYear) <= 1
);

export const shouldRejectNarrowForRemoteSideEvidence = (input: {
    recommendedWidth: 5 | 7 | 9 | 13;
    centerYear: number;
    sideStepBestYear?: number;
    coarseWindow?: UnitEventRankerWindow;
}): boolean => {
    if (
        input.recommendedWidth !== 9
        || input.sideStepBestYear === undefined
        || !input.coarseWindow
    ) return false;
    const coarseSpan = Math.max(
        1,
        input.coarseWindow.endYear - input.coarseWindow.startYear,
    );
    return Math.abs(input.sideStepBestYear - input.centerYear) > 2 * coarseSpan;
};

const MISSING_RING_HIGH_CONFIDENCE_NARROW_THRESHOLD = 0.94;
const MISSING_RING_ANCHOR_SIDE_GAP = 3;
const MISSING_RING_OPEN_FLANK_SIDE_GAP = 20;

export type MissingRingWindowRefinement = {
    recommendedWidth: 5 | 7 | 9 | 13;
    centerYear: number;
    rule:
        | "none"
        | "high_confidence_narrow"
        | "anchor_wide"
        | "coarse_operation_conflict"
        | "open_flank_wide";
};

/**
 * Applies the file-grouped width calibration after the missing-ring point model.
 * Expansions are restricted to independently meaningful evidence conflicts so
 * a few difficult modes can use 13 years without widening the common case.
 */
export const refineMissingRingWindow = (input: {
    recommendedWidth: 5 | 7 | 9 | 13;
    centerYear: number;
    modeCenterYear: number;
    nineYearSafety: number;
    coarseWindow?: UnitEventRankerWindow;
    currentPrimaryYear?: number;
    operationEvidence?: UnitEventRankerOperationEvidence;
}): MissingRingWindowRefinement => {
    if (
        input.recommendedWidth === 13
        && input.nineYearSafety >= MISSING_RING_HIGH_CONFIDENCE_NARROW_THRESHOLD
    ) {
        return {
            recommendedWidth: 9,
            centerYear: input.modeCenterYear,
            rule: "high_confidence_narrow",
        };
    }
    if (input.recommendedWidth !== 9) {
        return {
            recommendedWidth: input.recommendedWidth,
            centerYear: input.centerYear,
            rule: "none",
        };
    }

    const operationYear = input.operationEvidence?.bestYear;
    const sideYear = input.operationEvidence?.sideStepBestYear;
    if (
        input.currentPrimaryYear === input.centerYear
        && operationYear === input.centerYear
        && sideYear !== undefined
        && sideYear >= input.centerYear + MISSING_RING_ANCHOR_SIDE_GAP
    ) {
        return {
            recommendedWidth: 13,
            centerYear: input.centerYear,
            rule: "anchor_wide",
        };
    }
    if (!input.coarseWindow) {
        return {
            recommendedWidth: 9,
            centerYear: input.centerYear,
            rule: "none",
        };
    }

    const coarseCenter = (
        input.coarseWindow.startYear + input.coarseWindow.endYear
    ) / 2;
    const newerFlankBias = 2 * (coarseCenter - input.modeCenterYear);
    if (
        newerFlankBias === 6
        && operationYear !== undefined
        && operationYear <= input.centerYear - 3
    ) {
        return {
            recommendedWidth: 13,
            centerYear: Math.round(coarseCenter),
            rule: "coarse_operation_conflict",
        };
    }
    if (
        newerFlankBias >= 12
        && sideYear !== undefined
        && sideYear >= input.centerYear + MISSING_RING_OPEN_FLANK_SIDE_GAP
    ) {
        return {
            recommendedWidth: 13,
            centerYear: input.centerYear + 2,
            rule: "open_flank_wide",
        };
    }
    return {
        recommendedWidth: 9,
        centerYear: input.centerYear,
        rule: "none",
    };
};

export const selectRemoteCurrentPrimaryMode = (input: {
    years: readonly number[];
    modeWindow: UnitEventRankerWindow;
    coarseWindow?: UnitEventRankerWindow;
    currentPrimaryYear?: number;
    minimumModeGap?: number;
}): UnitEventRankerWindow | null => {
    const current = input.currentPrimaryYear;
    if (
        current === undefined
        || !input.coarseWindow
        || current < input.coarseWindow.startYear
        || current > input.coarseWindow.endYear
    ) return null;
    // A false-ring delete shifts the older side toward newer calendar years.
    // Only a current-event anchor on the newer flank is independent evidence
    // for replacing the selected mode; an older-flank anchor competes with the
    // delete-year counterfactual and must not displace it.
    const gap = current > input.modeWindow.endYear
        ? current - input.modeWindow.endYear
        : 0;
    if (gap < (input.minimumModeGap ?? 1)) return null;
    const firstYear = input.years[0] ?? current;
    const lastYear = input.years[input.years.length - 1] ?? current;
    const startYear = Math.max(
        firstYear,
        Math.min(current - 6, lastYear - 12),
    );
    return { startYear, endYear: startYear + 12 };
};

const FALSE_RING_CURRENT_ANCHOR_MINIMUM_IMPROVEMENT = 2;

/**
 * Keeps the pre-point 13-year mode when point refinement moves it away from
 * the independently ranked current-event year by a meaningful amount.
 */
export const selectFalseRingCurrentAnchorMode = (input: {
    pointModeWindow: UnitEventRankerWindow;
    prePointModeWindow: UnitEventRankerWindow;
    currentPrimaryYear?: number;
}): UnitEventRankerWindow | null => {
    if (
        input.currentPrimaryYear === undefined
        || input.pointModeWindow.startYear
            === input.prePointModeWindow.startYear
    ) return null;
    const pointCenter = (
        input.pointModeWindow.startYear + input.pointModeWindow.endYear
    ) / 2;
    const prePointCenter = (
        input.prePointModeWindow.startYear
        + input.prePointModeWindow.endYear
    ) / 2;
    return Math.abs(prePointCenter - input.currentPrimaryYear)
        + FALSE_RING_CURRENT_ANCHOR_MINIMUM_IMPROVEMENT
        <= Math.abs(pointCenter - input.currentPrimaryYear)
        ? input.prePointModeWindow
        : null;
};

const MISSING_RING_DIRECT_ANCHOR_MINIMUM_VOTES = 2;
const MISSING_RING_DIRECT_SIDE_MINIMUM_REMOTE_MARGIN = 0.20;
const MISSING_RING_DIRECT_SIDE_MAXIMUM_WINDOW_GAP = 2;

const windowCenter = (window: UnitEventRankerWindow): number => (
    window.startYear + window.endYear
) / 2;

const distanceToWindow = (
    window: UnitEventRankerWindow,
    year: number,
): number => (
    year < window.startYear
        ? window.startYear - year
        : year > window.endYear
            ? year - window.endYear
            : 0
);

/**
 * Rejects a learned direct-mode displacement when independent event anchors
 * still support the fully refined mode that entered the direct ranker.
 */
export const selectMissingRingDirectAnchorMode = (input: {
    directModeWindow: UnitEventRankerWindow;
    preDirectModeWindow: UnitEventRankerWindow;
    currentPrimaryYear?: number;
    operationEvidence?: UnitEventRankerOperationEvidence;
}): UnitEventRankerWindow | null => {
    if (
        input.directModeWindow.startYear
            === input.preDirectModeWindow.startYear
    ) return null;
    const directCenter = windowCenter(input.directModeWindow);
    const preDirectCenter = windowCenter(input.preDirectModeWindow);
    const operation = input.operationEvidence;
    const anchors = [
        input.currentPrimaryYear,
        operation?.bestYear,
        operation?.sideStepBestYear,
    ];
    const preDirectVotes = anchors.filter((year) => (
        year !== undefined
        && distanceToWindow(input.preDirectModeWindow, year) === 0
        && Math.abs(year - preDirectCenter) < Math.abs(year - directCenter)
    )).length;
    if (preDirectVotes >= MISSING_RING_DIRECT_ANCHOR_MINIMUM_VOTES) {
        return input.preDirectModeWindow;
    }

    if (
        input.directModeWindow.startYear
            > input.preDirectModeWindow.startYear
        && (operation?.sideStepRemoteMargin ?? Infinity) < 0.02
    ) return input.preDirectModeWindow;

    const sideYear = operation?.sideStepBestYear;
    const sideMargin = operation?.sideStepRemoteMargin;
    if (
        sideYear !== undefined
        && sideMargin !== undefined
        && sideMargin >= MISSING_RING_DIRECT_SIDE_MINIMUM_REMOTE_MARGIN
        && distanceToWindow(input.preDirectModeWindow, sideYear)
            <= MISSING_RING_DIRECT_SIDE_MAXIMUM_WINDOW_GAP
        && distanceToWindow(input.preDirectModeWindow, sideYear)
            < distanceToWindow(input.directModeWindow, sideYear)
    ) return input.preDirectModeWindow;
    return null;
};

export const shouldWidenMissingRingFiveYear = (input: {
    recommendedWidth: 5 | 7 | 9 | 13;
    centerYear: number;
    currentPrimaryYear?: number;
    operationEvidence?: UnitEventRankerOperationEvidence;
}): boolean => {
    if (input.recommendedWidth !== 5) return false;
    const anchors = [
        input.currentPrimaryYear,
        input.operationEvidence?.bestYear,
        input.operationEvidence?.sideStepBestYear,
    ].filter((year): year is number => year !== undefined)
        .sort((left, right) => left - right);
    if (anchors.length < 2) return false;
    const anchorMedian = anchors[Math.floor(anchors.length / 2)]
        ?? input.centerYear;
    return Math.abs(anchorMedian - input.centerYear) >= 2;
};

export const selectMissingRingSideStepMode = (input: {
    years: readonly number[];
    modeWindow: UnitEventRankerWindow;
    operationEvidence?: UnitEventRankerOperationEvidence;
}): UnitEventRankerWindow | null => {
    const sideYear = input.operationEvidence?.sideStepBestYear;
    const sideMargin = input.operationEvidence?.sideStepRemoteMargin;
    if (
        sideYear === undefined
        || sideMargin === undefined
        || sideMargin < 0.15
        || distanceToWindow(input.modeWindow, sideYear) < 3
    ) return null;
    const direction = Math.sign(sideYear - windowCenter(input.modeWindow));
    const firstYear = input.years[0] ?? input.modeWindow.startYear;
    const lastYear = input.years[input.years.length - 1]
        ?? input.modeWindow.endYear;
    const startYear = Math.max(
        firstYear,
        Math.min(input.modeWindow.startYear + direction, lastYear - 12),
    );
    return startYear === input.modeWindow.startYear
        ? null
        : { startYear, endYear: startYear + 12 };
};

const FALSE_RING_SIDE_MODE_MINIMUM_OUTSIDE_YEARS = 5;
const FALSE_RING_SIDE_MODE_MINIMUM_REMOTE_MARGIN = 0.05;
const FALSE_RING_SIDE_MODE_MAXIMUM_SHIFT = 3;

export const selectFalseRingSideStepMode = (input: {
    years: readonly number[];
    modeWindow: UnitEventRankerWindow;
    operationEvidence?: UnitEventRankerOperationEvidence;
}): UnitEventRankerWindow | null => {
    const sideYear = input.operationEvidence?.sideStepBestYear;
    const sideMargin = input.operationEvidence?.sideStepRemoteMargin;
    if (sideYear === undefined || sideMargin === undefined) return null;
    const outsideYears = distanceToWindow(input.modeWindow, sideYear);
    if (
        outsideYears < FALSE_RING_SIDE_MODE_MINIMUM_OUTSIDE_YEARS
        || sideMargin < FALSE_RING_SIDE_MODE_MINIMUM_REMOTE_MARGIN
    ) return null;
    const center = windowCenter(input.modeWindow);
    const direction = Math.sign(sideYear - center);
    const shift = direction * Math.min(
        FALSE_RING_SIDE_MODE_MAXIMUM_SHIFT,
        Math.max(1, Math.round(outsideYears * 0.25)),
    );
    const firstYear = input.years[0] ?? input.modeWindow.startYear;
    const lastYear = input.years[input.years.length - 1]
        ?? input.modeWindow.endYear;
    const startYear = Math.max(
        firstYear,
        Math.min(input.modeWindow.startYear + shift, lastYear - 12),
    );
    return startYear === input.modeWindow.startYear
        ? null
        : { startYear, endYear: startYear + 12 };
};

const FALSE_RING_TRANSITION_NARROW_THRESHOLD = 0.65;
const FALSE_RING_NINE_YEAR_MINIMUM_SAFETY = 0.90;
const FALSE_RING_EDGE_FLANK_MAXIMUM_GAP = 0.02;

export const isFalseRingNineYearSafetyAccepted = (
    probability: number,
    modelThreshold: number,
): boolean => probability >= Math.max(
    modelThreshold,
    FALSE_RING_NINE_YEAR_MINIMUM_SAFETY,
);

export const selectFalseRingTransitionNarrowWindow = (input: {
    years: readonly number[];
    transitionRanks: readonly number[];
    differenceRanks?: readonly number[];
    modeWindow: UnitEventRankerWindow;
    currentPrimaryYear?: number;
    operationBestYear?: number;
    probability: number;
    probabilityThreshold: number;
}): UnitEventRankerWindow | null => {
    if (input.probability < Math.max(
        input.probabilityThreshold,
        FALSE_RING_TRANSITION_NARROW_THRESHOLD,
    )) return null;
    const yearIndexes = new Map(input.years.map((year, index) => [year, index]));
    let selectedStart: number | null = null;
    let selectedScore = Number.NEGATIVE_INFINITY;
    for (
        let startYear = input.modeWindow.startYear;
        startYear <= input.modeWindow.endYear - 8;
        startYear += 1
    ) {
        const startIndex = yearIndexes.get(startYear);
        if (startIndex === undefined) continue;
        const score = input.transitionRanks
            .slice(startIndex, startIndex + 9)
            .reduce((sum, value) => sum + finite(value), 0);
        if (score > selectedScore) {
            selectedStart = startYear;
            selectedScore = score;
        }
    }
    if (selectedStart === null) return null;
    if (
        input.operationBestYear === selectedStart + 9
        && selectedStart < input.modeWindow.endYear - 8
    ) {
        selectedStart += 1;
    } else if (
        input.operationBestYear === selectedStart - 1
        && selectedStart > input.modeWindow.startYear
    ) {
        selectedStart -= 1;
    }
    const offset = selectedStart - input.modeWindow.startYear;
    const centerYear = selectedStart + 4;
    if (
        offset === 3
        && input.currentPrimaryYear !== undefined
        && Math.abs(input.currentPrimaryYear - centerYear) > 2
    ) return null;
    const touchesModeEdge = selectedStart === input.modeWindow.startYear
        || selectedStart + 8 === input.modeWindow.endYear;
    if (touchesModeEdge && input.differenceRanks) {
        const retained: number[] = [];
        const discarded: number[] = [];
        for (
            let year = input.modeWindow.startYear;
            year <= input.modeWindow.endYear;
            year += 1
        ) {
            const index = yearIndexes.get(year);
            const value = index === undefined
                ? Number.NEGATIVE_INFINITY
                : input.differenceRanks[index] ?? Number.NEGATIVE_INFINITY;
            if (selectedStart <= year && year <= selectedStart + 8) {
                retained.push(value);
            } else {
                discarded.push(value);
            }
        }
        if (
            retained.length > 0
            && discarded.length > 0
            && Math.max(...discarded)
                >= Math.max(...retained) - FALSE_RING_EDGE_FLANK_MAXIMUM_GAP
        ) return null;
    }
    return { startYear: selectedStart, endYear: selectedStart + 8 };
};

type ModelTreeNode = {
    leaf_value: number;
} | {
    split_feature: number;
    threshold: number | string;
    decision_type: string;
    default_left: boolean;
    left_child: ModelTreeNode;
    right_child: ModelTreeNode;
};

type ModelTree = {
    tree_structure: ModelTreeNode;
};

type ModelDump = {
    tree_info: ModelTree[];
};

type EventModel = {
    model: ModelDump;
    widthRisk: {
        threshold: number;
        model: ModelDump;
    };
    candidateModel?: ModelDump;
    refinement?: {
        maximumCenterDistance: number;
        minimumSafety: number;
        centerClampYears: number;
        wideCenterPullYears: number;
    };
};

type UnitEventWindowRankerModel = {
    windowWidth: number;
    profileNames: string[];
    sourceNames: string[];
    eventTypes: Record<UnitEventWindowType, EventModel>;
};

const MODEL = modelData as unknown as UnitEventWindowRankerModel;

const mean = (values: readonly number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

const quantile = (values: readonly number[], fraction: number): number => {
    if (values.length === 0) return 0;
    const ordered = values.slice().sort((left, right) => left - right);
    const position = (ordered.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return ordered[lower] ?? 0;
    const weight = position - lower;
    return (ordered[lower] ?? 0) * (1 - weight)
        + (ordered[upper] ?? 0) * weight;
};

const standardDeviation = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    const average = mean(values);
    return Math.sqrt(mean(values.map((value) => (
        (value - average) ** 2
    ))));
};

const overlap = (
    left: UnitEventRankerWindow,
    right: UnitEventRankerWindow,
): number => {
    const intersection = Math.max(
        0,
        Math.min(left.endYear, right.endYear)
            - Math.max(left.startYear, right.startYear)
            + 1,
    );
    const union = Math.max(left.endYear, right.endYear)
        - Math.min(left.startYear, right.startYear)
        + 1;
    return intersection / Math.max(1, union);
};

const finite = (value: number | undefined): number => (
    Number.isFinite(value) ? value! : 0
);

type PreparedProfile = {
    values: number[];
    fullMean: number;
    peakIndex: number;
};

const prepareProfiles = (
    input: UnitEventWindowRankerInput,
): Map<string, PreparedProfile> => new Map(MODEL.profileNames.map((name) => {
    const source = input.ranks.get(name)
        ?? new Array(input.years.length).fill(0);
    const values = input.years.map((_, index) => (
        Math.fround(finite(source[index]))
    ));
    let peakIndex = 0;
    for (let index = 1; index < values.length; index += 1) {
        if (values[index] > values[peakIndex]) peakIndex = index;
    }
    return [name, {
        values,
        fullMean: mean(values),
        peakIndex,
    }];
}));

const profileFeatures = (
    profiles: ReadonlyMap<string, PreparedProfile>,
    startIndex: number,
): number[] => MODEL.profileNames.flatMap((profileName) => {
    const profile = profiles.get(profileName)!;
    const inside = Array.from(
        { length: MODEL.windowWidth },
        (_, offset) => profile.values[startIndex + offset] ?? 0,
    );
    const insideMean = mean(inside);
    return [
        insideMean,
        Math.max(0, ...inside),
        inside[Math.floor(MODEL.windowWidth / 2)] ?? 0,
        quantile(inside, 0.75),
        quantile(inside, 0.9),
        inside[0] ?? 0,
        inside[inside.length - 1] ?? 0,
        (inside[inside.length - 1] ?? 0) - (inside[0] ?? 0),
        insideMean - profile.fullMean,
        Number(
            profile.peakIndex >= startIndex
            && profile.peakIndex < startIndex + MODEL.windowWidth,
        ),
    ];
});

const candidateFeatures = (
    input: UnitEventWindowRankerInput,
    window: UnitEventRankerWindow,
): number[] => {
    const center = (window.startYear + window.endYear) / 2;
    const overlaps = input.internalCandidates.map((candidate) => (
        overlap(window, candidate)
    ));
    const containing = input.internalCandidates.filter((candidate) => (
        candidate.startYear <= center && center <= candidate.endYear
    ));
    const aggregate = containing.map((candidate) => (
        finite(candidate.aggregateScore)
    ));
    const consensus = containing.map((candidate) => (
        finite(candidate.overlapConsensus)
    ));
    const result = [
        Math.max(0, ...overlaps),
        mean(overlaps),
        overlaps.filter((value) => value >= 0.5).length,
        containing.length,
        Math.max(0, ...aggregate),
        mean(aggregate),
        Math.max(0, ...consensus),
        mean(consensus),
    ];
    MODEL.sourceNames.forEach((source) => {
        const matching = input.internalCandidates.filter((candidate) => (
            candidate.source === source
        ));
        result.push(
            Math.max(0, ...matching.map((candidate) => (
                overlap(window, candidate)
            ))),
            Number(matching.some((candidate) => (
                candidate.startYear <= center && center <= candidate.endYear
            ))),
        );
    });
    return result;
};

const anchorFeatures = (
    input: UnitEventWindowRankerInput,
    window: UnitEventRankerWindow,
): number[] => {
    const firstYear = input.years[0] ?? window.startYear;
    const lastYear = input.years[input.years.length - 1] ?? window.endYear;
    const span = Math.max(1, lastYear - firstYear);
    const center = (window.startYear + window.endYear) / 2;
    const operation = input.operationEvidence;
    const anchors = [
        input.currentPrimaryYear,
        operation?.bestYear,
        operation?.sideStepBestYear,
    ];
    const result: number[] = [];
    anchors.forEach((anchor) => {
        if (anchor === undefined) {
            result.push(1, 1, 0);
        } else {
            result.push(
                (center - anchor) / span,
                Math.abs(center - anchor) / span,
                Number(window.startYear <= anchor && anchor <= window.endYear),
            );
        }
    });
    result.push(
        finite(operation?.bestRawGain),
        finite(operation?.bestDifferenceGain),
        finite(operation?.bestCombinedGain),
        finite(operation?.topThreeDifferenceGain),
        finite(operation?.remoteDifferenceMargin),
        finite(operation?.bestSideStepScore),
        finite(operation?.topThreeSideStepScore),
        finite(operation?.sideStepRemoteMargin),
        (center - firstYear) / span,
        (window.startYear - firstYear) / span,
        (lastYear - window.endYear) / span,
    );
    return result;
};

const predictNode = (
    node: ModelTreeNode,
    features: readonly number[],
): number => {
    if ("leaf_value" in node) return node.leaf_value;
    const value = features[node.split_feature];
    if (!Number.isFinite(value)) {
        return predictNode(
            node.default_left ? node.left_child : node.right_child,
            features,
        );
    }
    const threshold = typeof node.threshold === "number"
        ? node.threshold
        : Number(node.threshold);
    const goLeft = node.decision_type === "<="
        ? value! <= threshold
        : value! === threshold;
    return predictNode(
        goLeft ? node.left_child : node.right_child,
        features,
    );
};

const windowFeatures = (
    input: UnitEventWindowRankerInput,
    profiles: ReadonlyMap<string, PreparedProfile>,
    startIndex: number,
): number[] => {
    const startYear = input.years[startIndex];
    const window = {
        startYear,
        endYear: startYear + MODEL.windowWidth - 1,
    };
    return [
        ...profileFeatures(profiles, startIndex),
        ...candidateFeatures(input, window),
        ...anchorFeatures(input, window),
    ].map(Math.fround);
};

const scoreFeatures = (
    features: readonly number[],
    model: ModelDump,
): number => model.tree_info.reduce(
    (sum, tree) => sum + predictNode(tree.tree_structure, features),
    0,
);

const sigmoid = (value: number): number => {
    if (value >= 0) {
        const inverse = Math.exp(-value);
        return 1 / (1 + inverse);
    }
    const exponential = Math.exp(value);
    return exponential / (1 + exponential);
};

type PreparedWindow = UnitEventRankerWindow & {
    startIndex: number;
    features: number[];
};

type ScoredWindow = PreparedWindow & {
    score: number;
};

const sortByScore = (windows: readonly ScoredWindow[]): ScoredWindow[] => (
    windows.slice().sort((left, right) => (
        right.score - left.score || right.startYear - left.startYear
    ))
);

const centeredWindowStart = (
    input: UnitEventWindowRankerInput,
    centerYear: number | undefined,
): number => {
    const firstYear = input.years[0] ?? 0;
    const lastYear = input.years[input.years.length - 1] ?? firstYear;
    const center = centerYear ?? firstYear;
    return Math.max(
        firstYear,
        Math.min(
            Math.round(center) - Math.floor(MODEL.windowWidth / 2),
            lastYear - MODEL.windowWidth + 1,
        ),
    );
};

const profileMassWindowStart = (
    input: UnitEventWindowRankerInput,
    profileName: string,
): number | null => {
    const values = input.ranks.get(profileName);
    if (!values || values.length < MODEL.windowWidth) return null;
    let score = values.slice(0, MODEL.windowWidth).reduce(
        (sum, value) => sum + finite(value),
        0,
    );
    let bestScore = score;
    let bestIndex = 0;
    for (
        let index = 1;
        index <= values.length - MODEL.windowWidth;
        index += 1
    ) {
        score += finite(values[index + MODEL.windowWidth - 1])
            - finite(values[index - 1]);
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    }
    return input.years[bestIndex] ?? null;
};

const fusedMassWindowStart = (
    input: UnitEventWindowRankerInput,
    profileNames: readonly string[],
): number | null => {
    const profiles = profileNames.flatMap((name) => {
        const values = input.ranks.get(name);
        return values ? [values] : [];
    });
    if (profiles.length === 0) return null;
    const values = input.years.map((_, index) => mean(
        profiles.map((profile) => finite(profile[index])),
    ));
    let score = values.slice(0, MODEL.windowWidth).reduce(
        (sum, value) => sum + value,
        0,
    );
    let bestScore = score;
    let bestIndex = 0;
    for (
        let index = 1;
        index <= values.length - MODEL.windowWidth;
        index += 1
    ) {
        score += values[index + MODEL.windowWidth - 1]
            - values[index - 1];
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    }
    return input.years[bestIndex] ?? null;
};

const falseRingCandidateStarts = (
    input: UnitEventWindowRankerInput,
): Set<number> => {
    const starts = new Set<number>();
    MODEL.profileNames.forEach((profileName) => {
        const start = profileMassWindowStart(input, profileName);
        if (start !== null) starts.add(start);
    });
    const operation = input.operationEvidence;
    [
        input.currentPrimaryYear,
        operation?.bestYear,
        operation?.sideStepBestYear,
    ].forEach((year) => starts.add(centeredWindowStart(input, year)));
    input.internalCandidates.forEach((candidate) => starts.add(
        centeredWindowStart(
            input,
            (candidate.startYear + candidate.endYear) / 2,
        ),
    ));
    [
        [
            "differenceFull",
            "comboFull",
            "cumulativeCombined",
            "cumulativeDifference",
        ],
        [
            "differenceFull",
            "comboFull",
            "cumulativeCombined",
            "piecewiseCombinedObjective",
            "transitionSplitGain",
            "cumulativeReferenceMean",
        ],
    ].forEach((profileNames) => {
        const start = fusedMassWindowStart(input, profileNames);
        if (start !== null) starts.add(start);
    });
    return starts;
};

const scoreWindowSafety = (
    selected: ScoredWindow,
    scoredWindows: readonly ScoredWindow[],
    riskModel: ModelDump,
): number => {
    const remote = scoredWindows.find((candidate) => (
        candidate.endYear < selected.startYear
        || candidate.startYear > selected.endYear
    ));
    const chronological = scoredWindows
        .slice()
        .sort((left, right) => left.startIndex - right.startIndex);
    const selectedIndex = chronological.findIndex((candidate) => (
        candidate.startIndex === selected.startIndex
    ));
    const adjacentScores = chronological
        .slice(Math.max(0, selectedIndex - 2), selectedIndex + 3)
        .filter((candidate) => candidate.startIndex !== selected.startIndex)
        .map((candidate) => candidate.score);
    const allScores = chronological.map((candidate) => candidate.score);
    const maximumScore = Math.max(...allScores);
    const masses = allScores.map((score) => (
        Math.exp(Math.max(-30, Math.min(0, score - maximumScore)))
    ));
    const massTotal = Math.max(
        1e-12,
        masses.reduce((sum, mass) => sum + mass, 0),
    );
    const probabilities = masses.map((mass) => mass / massTotal);
    const entropy = -probabilities.reduce(
        (sum, probability) => sum + probability
            * Math.log(Math.max(probability, 1e-12)),
        0,
    ) / Math.max(1e-12, Math.log(Math.max(2, probabilities.length)));
    const adjacentMaximum = adjacentScores.length > 0
        ? Math.max(...adjacentScores)
        : selected.score;
    const q90 = quantile(allScores, 0.9);
    const riskFeatures = [
        ...selected.features,
        selected.score,
        selected.score - (scoredWindows[1]?.score ?? selected.score),
        selected.score - (remote?.score ?? selected.score),
        standardDeviation(allScores),
        q90,
        quantile(allScores, 0.75),
        selected.score - q90,
        adjacentMaximum,
        selected.score - adjacentMaximum,
        entropy,
        Math.max(...probabilities),
        selectedIndex / Math.max(1, chronological.length - 1),
    ].map(Math.fround);
    return sigmoid(scoreFeatures(riskFeatures, riskModel));
};

export const rankUnitEventWindows = (
    input: UnitEventWindowRankerInput,
): UnitEventWindowRankerResult | null => {
    if (
        input.years.length < MODEL.windowWidth
        || !MODEL.eventTypes[input.eventType]
    ) {
        return null;
    }
    const eventModel = MODEL.eventTypes[input.eventType];
    const profiles = prepareProfiles(input);
    const preparedWindows: PreparedWindow[] = input.years.flatMap((
        startYear,
        startIndex,
    ) => {
        const endYear = startYear + MODEL.windowWidth - 1;
        const lastYear = input.years[input.years.length - 1] ?? endYear;
        return startIndex + MODEL.windowWidth <= input.years.length
            && endYear <= lastYear
            ? [{
                    startYear,
                    endYear,
                    startIndex,
                    features: windowFeatures(input, profiles, startIndex),
                }]
            : [];
    });
    const fineWindows = sortByScore(preparedWindows.map((candidate) => ({
        ...candidate,
        score: scoreFeatures(candidate.features, eventModel.model),
    })));
    const fineSelected = fineWindows[0];
    if (!fineSelected) return null;
    let nineYearSafety = scoreWindowSafety(
        fineSelected,
        fineWindows,
        eventModel.widthRisk.model,
    );

    let selected = fineSelected;
    let scoredWindows = fineWindows;
    let recommendedWidth: 5 | 7 | 9 | 13 = (
        nineYearSafety >= eventModel.widthRisk.threshold ? 9 : 13
    );
    let windowCenteringRule: UnitEventWindowRankerResult["windowCenteringRule"] =
        "mode_mass";
    let widthFallbackRule: UnitEventWindowRankerResult["widthFallbackRule"] =
        "none";
    let widthSelectionRule: UnitEventWindowRankerResult["widthSelectionRule"] =
        "legacy_model";
    let widthThreshold = eventModel.widthRisk.threshold;
    let narrowCenter = (
        fineSelected.startYear + fineSelected.endYear
    ) / 2;
    let modeCenter = narrowCenter;
    let falseRingConsensusModeApplied = false;
    let validatedRemoteModeApplied = false;

    if (input.eventType === "missingRing" && input.coarseWindow) {
        const selectorInput = {
            years: input.years,
            ranks: input.ranks,
            currentModeWindow: {
                startYear: fineSelected.startYear,
                endYear: fineSelected.endYear,
            },
            coarseWindow: input.coarseWindow,
            operationEvidence: input.operationEvidence,
        };
        const modeSelection = input.missingCounterfactualRows
            ? selectMissingRingCounterfactualMode(
                    selectorInput,
                    input.missingCounterfactualRows,
                )
            : selectMissingRingMode(selectorInput);
        if (modeSelection) {
            const byStart = new Map(preparedWindows.map((candidate) => [
                candidate.startYear,
                candidate,
            ]));
            const modeWindows = modeSelection.scoredWindows.flatMap((window) => {
                const candidate = byStart.get(window.startYear);
                return candidate ? [{ ...candidate, score: window.score }] : [];
            });
            const modeSelected = modeWindows[0];
            if (modeSelected) {
                selected = modeSelected;
                scoredWindows = modeWindows;
                modeCenter = (
                    modeSelected.startYear + modeSelected.endYear
                ) / 2;
                if (input.missingCounterfactualRows) {
                    recommendedWidth = 13;
                    nineYearSafety = 0;
                    widthThreshold = 1;
                }
            }
        }
    }

    if (
        input.eventType === "falseRing"
        && eventModel.candidateModel
        && eventModel.refinement
    ) {
        const candidateStarts = falseRingCandidateStarts(input);
        const candidateWindows = sortByScore(preparedWindows
            .filter((candidate) => candidateStarts.has(candidate.startYear))
            .map((candidate) => ({
                ...candidate,
                score: scoreFeatures(
                    candidate.features,
                    eventModel.candidateModel!,
                ),
            })));
        const candidateSelected = candidateWindows[0];
        if (candidateSelected) {
            selected = candidateSelected;
            scoredWindows = candidateWindows;
            const candidateCenter = (
                candidateSelected.startYear + candidateSelected.endYear
            ) / 2;
            const fineCenter = (
                fineSelected.startYear + fineSelected.endYear
            ) / 2;
            recommendedWidth = (
                nineYearSafety >= eventModel.refinement.minimumSafety
                && Math.abs(fineCenter - candidateCenter)
                    <= eventModel.refinement.maximumCenterDistance
            ) ? 9 : 13;
            widthThreshold = eventModel.refinement.minimumSafety;
            narrowCenter = Math.max(
                candidateCenter - eventModel.refinement.centerClampYears,
                Math.min(
                    fineCenter,
                    candidateCenter + eventModel.refinement.centerClampYears,
                ),
            );
            const deterministicStart = profileMassWindowStart(
                input,
                "differenceFull",
            );
            const deterministicCenter = deterministicStart === null
                ? candidateCenter
                : deterministicStart + Math.floor(MODEL.windowWidth / 2);
            const centerPull = Math.max(
                -eventModel.refinement.wideCenterPullYears,
                Math.min(
                    deterministicCenter - candidateCenter,
                    eventModel.refinement.wideCenterPullYears,
                ),
            );
            modeCenter = recommendedWidth === 9
                ? candidateCenter
                : candidateCenter + centerPull;

            const previousModeStart = modeCenter
                - Math.floor(MODEL.windowWidth / 2);
            const previousModeWindow = {
                startYear: previousModeStart,
                endYear: previousModeStart + MODEL.windowWidth - 1,
            };
            const previousWindow = recommendedWidth === 9
                ? {
                        startYear: narrowCenter - 4,
                        endYear: narrowCenter + 4,
                    }
                : previousModeWindow;
            const candidateRemote = candidateWindows.find((candidate) => (
                candidate.endYear < candidateSelected.startYear
                || candidate.startYear > candidateSelected.endYear
            ));
            const modeSelection = input.coarseWindow
                ? selectFalseRingMode({
                        years: input.years,
                        ranks: input.ranks,
                        currentModeWindow: previousModeWindow,
                        coarseWindow: input.coarseWindow,
                        operationEvidence: input.operationEvidence,
                    })
                : null;
            if (modeSelection) {
                const byStart = new Map(preparedWindows.map((candidate) => [
                    candidate.startYear,
                    candidate,
                ]));
                const modeWindows = modeSelection.scoredWindows.flatMap((window) => {
                    const candidate = byStart.get(window.startYear);
                    return candidate ? [{ ...candidate, score: window.score }] : [];
                });
                const modeSelected = modeWindows[0];
                if (modeSelected) {
                    const learnedModeWindow = {
                        startYear: modeSelected.startYear,
                        endYear: modeSelected.endYear,
                    };
                    const calibration = calibrateFalseRingWindow({
                        years: input.years,
                        ranks: input.ranks,
                        selectedModeWindow: learnedModeWindow,
                        learnedModeWindow,
                        previousModeWindow,
                        previousWindow,
                        coarseWindow: input.coarseWindow!,
                        currentPrimaryYear: input.currentPrimaryYear,
                        nineYearSafety,
                        nineYearSafetyThreshold: widthThreshold,
                        operationEvidence: input.operationEvidence,
                        learnedWindowScore: candidateSelected.score,
                        learnedWindowMargin: candidateSelected.score
                            - (candidateWindows[1]?.score ?? candidateSelected.score),
                        learnedWindowRemoteMargin: candidateSelected.score
                            - (candidateRemote?.score ?? candidateSelected.score),
                    });
                    recommendedWidth = calibration.recommendedWidth;
                    narrowCenter = (
                        calibration.window.startYear + calibration.window.endYear
                    ) / 2;
                    nineYearSafety = calibration.probability;
                    widthThreshold = calibration.threshold;
                    selected = modeSelected;
                    scoredWindows = modeWindows;
                    modeCenter = (
                        learnedModeWindow.startYear
                        + learnedModeWindow.endYear
                    ) / 2;
                }
            }
        }
    }

    if (
        input.eventType === "falseRing"
        && input.coarseWindow
        && input.falseCounterfactualRows
    ) {
        const previousModeWindow = {
            startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
            endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
        };
        const modeSelection = selectFalseRingCounterfactualMode({
            years: input.years,
            ranks: input.ranks,
            currentModeWindow: previousModeWindow,
            coarseWindow: input.coarseWindow,
            operationEvidence: input.operationEvidence,
        }, input.falseCounterfactualRows);
        if (modeSelection) {
            const byStart = new Map(preparedWindows.map((candidate) => [
                candidate.startYear,
                candidate,
            ]));
            const modeWindows = modeSelection.scoredWindows.flatMap((window) => {
                const candidate = byStart.get(window.startYear);
                return candidate ? [{ ...candidate, score: window.score }] : [];
            });
            const modeSelected = modeWindows[0];
            if (modeSelected) {
                selected = modeSelected;
                scoredWindows = modeWindows;
                modeCenter = (
                    modeSelected.startYear + modeSelected.endYear
                ) / 2;
                if (recommendedWidth !== 9) {
                    const transitionWindow = selectFalseRingTransitionNarrowWindow({
                        years: input.years,
                        transitionRanks:
                            input.ranks.get("transitionSplitGain") ?? [],
                        differenceRanks:
                            input.ranks.get("differenceFull") ?? [],
                        modeWindow: {
                            startYear: modeSelected.startYear,
                            endYear: modeSelected.endYear,
                        },
                        currentPrimaryYear: input.currentPrimaryYear,
                        operationBestYear: input.operationEvidence?.bestYear,
                        probability: nineYearSafety,
                        probabilityThreshold: widthThreshold,
                    });
                    if (transitionWindow) {
                        recommendedWidth = 9;
                        narrowCenter = (
                            transitionWindow.startYear + transitionWindow.endYear
                        ) / 2;
                        widthThreshold = Math.max(
                            widthThreshold,
                            FALSE_RING_TRANSITION_NARROW_THRESHOLD,
                        );
                        widthSelectionRule = "false_transition_mass";
                    }
                }
            }
        }
    }

    const prePointModeWindow = {
        startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
        endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
    };
    if (
        input.eventType === "missingRing"
        || (input.eventType === "falseRing" && recommendedWidth === 13)
    ) {
        const pointSelection = selectUnitEventPointWindow(input);
        if (pointSelection) {
            const byStart = new Map(preparedWindows.map((candidate) => [
                candidate.startYear,
                candidate,
            ]));
            const pointWindows = pointSelection.scoredWindows.flatMap((window) => {
                const candidate = byStart.get(window.startYear);
                return candidate ? [{ ...candidate, score: window.score }] : [];
            });
            const pointSelected = pointWindows[0];
            if (pointSelected) {
                selected = pointSelected;
                scoredWindows = pointWindows;
                modeCenter = pointSelection.centerYear;
                narrowCenter = pointSelection.centerYear;
                if (input.eventType === "falseRing") {
                    windowCenteringRule = "false_point_mode";
                    widthSelectionRule = "false_point_wide_model";
                } else {
                    recommendedWidth = pointSelection.recommendedWidth;
                    nineYearSafety = pointSelection.widthProbability;
                    widthThreshold = pointSelection.widthThreshold;
                    widthSelectionRule = "missing_point_model";
                    if (shouldRejectNarrowForRemoteSideEvidence({
                        recommendedWidth,
                        centerYear: pointSelection.centerYear,
                        sideStepBestYear: input.operationEvidence?.sideStepBestYear,
                        coarseWindow: input.coarseWindow,
                    })) {
                        recommendedWidth = 13;
                        widthFallbackRule = "remote_side_evidence";
                    } else if (shouldUseCorroboratedPointPeak({
                        recommendedWidth,
                        centerYear: pointSelection.centerYear,
                        peakYear: pointSelection.peakYear,
                        sideStepBestYear: input.operationEvidence?.sideStepBestYear,
                    })) {
                        modeCenter = pointSelection.peakYear;
                        narrowCenter = pointSelection.peakYear;
                        recommendedWidth = 13;
                        windowCenteringRule = "corroborated_point_peak";
                        widthFallbackRule = "corroborated_point_peak";
                    }
                }
            }
        }
    }

    if (input.eventType === "missingRing" && recommendedWidth === 13) {
        const wideSelection = selectUnitEventPointWindow(
            input,
            undefined,
            "wideMode",
        );
        if (wideSelection) {
            const byStart = new Map(preparedWindows.map((candidate) => [
                candidate.startYear,
                candidate,
            ]));
            const wideWindows = wideSelection.scoredWindows.flatMap((window) => {
                const candidate = byStart.get(window.startYear);
                return candidate ? [{ ...candidate, score: window.score }] : [];
            });
            const wideSelected = wideWindows[0];
            if (wideSelected) {
                selected = wideSelected;
                scoredWindows = wideWindows;
                modeCenter = wideSelection.centerYear;
                narrowCenter = wideSelection.centerYear;
                widthSelectionRule = "missing_point_wide_model";
            }
        }
    }

    if (input.eventType === "falseRing") {
        const previousRecommendedWidth = recommendedWidth;
        const currentModeWindow = {
            startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
            endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
        };
        const narrowSelection = selectUnitEventPointWindow(
            input,
            undefined,
            "narrowMode",
            {
                modeWindow: currentModeWindow,
                recommendedWidth,
                nineYearSafety,
                widthThreshold,
            },
        );
        if (narrowSelection) {
            const narrowWindow = narrowSelection.window;
            const offsetWithinMode = (
                narrowWindow.startYear - currentModeWindow.startYear
            );
            const symmetricWithinMode = (
                offsetWithinMode >= 1
                && offsetWithinMode <= 3
                && narrowWindow.endYear <= currentModeWindow.endYear
            );
            const safetyThreshold = previousRecommendedWidth === 9
                ? narrowSelection.existingNarrowThreshold
                : narrowSelection.existingWideThreshold;
            const useNarrow = (
                narrowSelection.safetyProbability !== undefined
                && safetyThreshold !== undefined
                && isFalseRingNineYearSafetyAccepted(
                    narrowSelection.safetyProbability,
                    safetyThreshold,
                )
                && (
                    previousRecommendedWidth === 9
                    || symmetricWithinMode
                )
            );
            nineYearSafety = narrowSelection.safetyProbability ?? 0;
            widthThreshold = safetyThreshold ?? 1;
            if (useNarrow) {
                recommendedWidth = 9;
                narrowCenter = narrowSelection.centerYear;
                windowCenteringRule = "false_point_narrow_mode";
                widthSelectionRule = "false_point_safety_model";
            } else {
                recommendedWidth = 13;
                widthSelectionRule = "false_point_safety_model";
            }
        }
    }

    if (input.eventType === "falseRing") {
        const currentModeWindow = {
            startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
            endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
        };
        const remoteCurrentMode = selectRemoteCurrentPrimaryMode({
            years: input.years,
            modeWindow: currentModeWindow,
            coarseWindow: input.coarseWindow,
            currentPrimaryYear: input.currentPrimaryYear,
        });
        if (remoteCurrentMode) {
            modeCenter = (
                remoteCurrentMode.startYear + remoteCurrentMode.endYear
            ) / 2;
            narrowCenter = modeCenter;
            recommendedWidth = 13;
            windowCenteringRule = "false_current_remote_mode";
            widthSelectionRule = "false_current_remote_mode";
            falseRingConsensusModeApplied = true;
        }
    }

    if (
        input.eventType === "falseRing"
        && input.corroboratedFalseRingModeCenterYear !== undefined
    ) {
        const minimumCenter = (input.years[0] ?? 0)
            + Math.floor(MODEL.windowWidth / 2);
        const maximumCenter = (
            input.years[input.years.length - 1] ?? minimumCenter
        ) - Math.floor(MODEL.windowWidth / 2);
        modeCenter = Math.max(
            minimumCenter,
            Math.min(
                maximumCenter,
                Math.round(input.corroboratedFalseRingModeCenterYear),
            ),
        );
        narrowCenter = modeCenter;
        recommendedWidth = 13;
        windowCenteringRule = "false_current_candidate_consensus";
        widthSelectionRule = "false_current_candidate_consensus";
        falseRingConsensusModeApplied = true;
    }

    if (input.eventType === "missingRing") {
        const refinement = refineMissingRingWindow({
            recommendedWidth,
            centerYear: Math.round(narrowCenter),
            modeCenterYear: Math.round(modeCenter),
            nineYearSafety,
            coarseWindow: input.coarseWindow,
            currentPrimaryYear: input.currentPrimaryYear,
            operationEvidence: input.operationEvidence,
        });
        if (refinement.rule !== "none") {
            const minimumCenter = (input.years[0] ?? refinement.centerYear) + 6;
            const maximumCenter = (
                input.years[input.years.length - 1] ?? refinement.centerYear
            ) - 6;
            const refinedCenter = Math.max(
                minimumCenter,
                Math.min(maximumCenter, refinement.centerYear),
            );
            recommendedWidth = refinement.recommendedWidth;
            modeCenter = refinedCenter;
            narrowCenter = refinedCenter;
            if (refinement.rule === "high_confidence_narrow") {
                widthThreshold = MISSING_RING_HIGH_CONFIDENCE_NARROW_THRESHOLD;
                widthSelectionRule = "missing_high_confidence_narrow";
            } else if (refinement.rule === "anchor_wide") {
                windowCenteringRule = "missing_anchor_calibration";
                widthSelectionRule = "missing_anchor_wide";
            } else if (refinement.rule === "coarse_operation_conflict") {
                windowCenteringRule = "missing_coarse_operation_conflict";
                widthSelectionRule = "missing_coarse_operation_conflict";
            } else {
                windowCenteringRule = "missing_open_flank_calibration";
                widthSelectionRule = "missing_open_flank_wide";
            }
        }
    }

    if (
        input.eventType === "falseRing"
        && recommendedWidth === 13
        && input.falseCounterfactualRows
        && !falseRingConsensusModeApplied
    ) {
        const massSelection = selectFalseRingCounterfactualMassWindow({
            rows: input.falseCounterfactualRows,
            currentModeWindow: {
                startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
                endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
            },
        });
        if (massSelection) {
            modeCenter = massSelection.centerYear;
            narrowCenter = massSelection.centerYear;
            windowCenteringRule = "false_counterfactual_mass";
            widthSelectionRule = "false_counterfactual_mass";
        }
    }

    if (
        input.eventType === "falseRing"
        && recommendedWidth === 13
        && windowCenteringRule === "false_counterfactual_mass"
    ) {
        const familyMode = selectFalseRingFamilyMode(input, {
            startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
            endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
        });
        if (familyMode) {
            const byStart = new Map(preparedWindows.map((candidate) => [
                candidate.startYear,
                candidate,
            ]));
            const familyWindows = familyMode.scoredWindows.flatMap((window) => {
                const candidate = byStart.get(window.startYear);
                return candidate ? [{ ...candidate, score: window.score }] : [];
            });
            const familySelected = familyWindows[0];
            if (familySelected) {
                selected = familySelected;
                scoredWindows = familyWindows;
                modeCenter = (
                    familyMode.window.startYear + familyMode.window.endYear
                ) / 2;
                narrowCenter = modeCenter;
                windowCenteringRule = "false_family_mode_consensus";
                widthSelectionRule = "false_family_mode_consensus";
            }
        }
    }

    if (
        input.eventType === "falseRing"
        && recommendedWidth === 13
        && windowCenteringRule === "false_point_mode"
    ) {
        const familyMode = selectFalseRingFamilyMode(input, {
            startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
            endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
        }, "unanimousRemote");
        if (familyMode) {
            const byStart = new Map(preparedWindows.map((candidate) => [
                candidate.startYear,
                candidate,
            ]));
            const familyWindows = familyMode.scoredWindows.flatMap((window) => {
                const candidate = byStart.get(window.startYear);
                return candidate ? [{ ...candidate, score: window.score }] : [];
            });
            const familySelected = familyWindows[0];
            if (familySelected) {
                selected = familySelected;
                scoredWindows = familyWindows;
                modeCenter = (
                    familyMode.window.startYear + familyMode.window.endYear
                ) / 2;
                narrowCenter = modeCenter;
                windowCenteringRule = "false_family_mode_consensus";
                widthSelectionRule = "false_family_mode_consensus";
            }
        }
    }

    const preFalseCurrentAnchorModeWindow = {
        startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
        endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
    };

    if (
        input.eventType === "falseRing"
        && recommendedWidth === 13
        && windowCenteringRule === "false_point_mode"
    ) {
        const anchorMode = selectFalseRingCurrentAnchorMode({
            pointModeWindow: {
                startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
                endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
            },
            prePointModeWindow,
            currentPrimaryYear: input.currentPrimaryYear,
        });
        if (anchorMode) {
            modeCenter = (
                anchorMode.startYear + anchorMode.endYear
            ) / 2;
            narrowCenter = modeCenter;
            windowCenteringRule = "false_current_anchor_consensus";
            widthSelectionRule = "false_current_anchor_consensus";
        }
    }

    if (
        input.eventType === "falseRing"
        && recommendedWidth === 13
        && windowCenteringRule === "false_current_anchor_consensus"
    ) {
        const familyMode = selectFalseRingFamilyMode(input, {
            startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
            endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
        }, "boundedConsensus");
        if (familyMode) {
            const byStart = new Map(preparedWindows.map((candidate) => [
                candidate.startYear,
                candidate,
            ]));
            const familyWindows = familyMode.scoredWindows.flatMap((window) => {
                const candidate = byStart.get(window.startYear);
                return candidate ? [{ ...candidate, score: window.score }] : [];
            });
            const familySelected = familyWindows[0];
            if (familySelected) {
                selected = familySelected;
                scoredWindows = familyWindows;
                modeCenter = (
                    familyMode.window.startYear + familyMode.window.endYear
                ) / 2;
                narrowCenter = modeCenter;
                windowCenteringRule = "false_family_mode_consensus";
                widthSelectionRule = "false_family_mode_consensus";
            }
        }
    }

    if (
        input.eventType === "falseRing"
        && recommendedWidth === 13
        && (
            windowCenteringRule === "false_point_mode"
            || windowCenteringRule === "false_current_anchor_consensus"
        )
    ) {
        const sideMode = selectFalseRingSideStepMode({
            years: input.years,
            modeWindow: {
                startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
                endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
            },
            operationEvidence: input.operationEvidence,
        });
        if (sideMode) {
            modeCenter = windowCenter(sideMode);
            narrowCenter = modeCenter;
            windowCenteringRule = "false_side_step_mode";
            widthSelectionRule = "false_side_step_mode";
        }
    }

    const preDirectModeWindow = {
        startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
        endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
    };

    if (input.eventType === "missingRing" && recommendedWidth === 13) {
        const currentModeWindow = {
            startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
            endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
        };
        const currentRemote = scoredWindows.find((candidate) => (
            candidate.endYear < selected.startYear
            || candidate.startYear > selected.endYear
        ));
        const directMode = selectMissingRingDirectMode(input, {
            modeWindow: currentModeWindow,
            currentWindow: currentModeWindow,
            recommendedWidth,
            learnedWindowScore: selected.score,
            learnedWindowMargin:
                selected.score - (scoredWindows[1]?.score ?? selected.score),
            learnedWindowRemoteMargin:
                selected.score - (currentRemote?.score ?? selected.score),
            nineYearSafety,
            nineYearSafetyThreshold: widthThreshold,
        });
        if (directMode) {
            const anchorMode = selectMissingRingDirectAnchorMode({
                directModeWindow: directMode.window,
                preDirectModeWindow: currentModeWindow,
                currentPrimaryYear: input.currentPrimaryYear,
                operationEvidence: input.operationEvidence,
            });
            if (anchorMode) {
                modeCenter = windowCenter(anchorMode);
                narrowCenter = modeCenter;
                windowCenteringRule = "missing_direct_anchor_consensus";
                widthSelectionRule = "missing_direct_anchor_consensus";
            }
            const byStart = new Map(preparedWindows.map((candidate) => [
                candidate.startYear,
                candidate,
            ]));
            const directWindows = directMode.scoredWindows.flatMap((window) => {
                const candidate = byStart.get(window.startYear);
                return candidate ? [{ ...candidate, score: window.score }] : [];
            });
            const directSelected = directWindows[0];
            if (directSelected && !anchorMode) {
                selected = directSelected;
                scoredWindows = directWindows;
                modeCenter = (
                    directMode.window.startYear + directMode.window.endYear
                ) / 2;
                narrowCenter = modeCenter;
                windowCenteringRule = "missing_direct_mode_ranker";
                widthSelectionRule = "missing_direct_mode_ranker";
            }
        }
    }

    if (input.eventType === "missingRing" && recommendedWidth === 13) {
        const sideMode = selectMissingRingSideStepMode({
            years: input.years,
            modeWindow: {
                startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
                endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
            },
            operationEvidence: input.operationEvidence,
        });
        if (sideMode) {
            modeCenter = windowCenter(sideMode);
            narrowCenter = modeCenter;
            windowCenteringRule = "missing_side_step_mode";
            widthSelectionRule = "missing_side_step_mode";
        }
    }

    if (input.coarseWindow) {
        const currentModeWindow = {
            startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
            endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
        };
        const predictiveMode = (
            input.eventType === "missingRing"
            && input.missingCounterfactualRows
        ) ? selectMissingRingPredictiveMode(
                input.missingCounterfactualRows,
                currentModeWindow,
            )
            : null;
        const familyMode = predictiveMode
            ? null
            : selectFalseRingFamilyMode(
                    input,
                    currentModeWindow,
                    "validatedRemote",
                );
        const remoteMode = predictiveMode ?? familyMode;
        if (remoteMode) {
            const byStart = new Map(preparedWindows.map((candidate) => [
                candidate.startYear,
                candidate,
            ]));
            const remoteWindows = remoteMode.scoredWindows.flatMap((window) => {
                const candidate = byStart.get(window.startYear);
                return candidate ? [{ ...candidate, score: window.score }] : [];
            });
            const remoteSelected = remoteWindows.find((candidate) => (
                candidate.startYear === remoteMode.window.startYear
            ));
            if (remoteSelected) {
                validatedRemoteModeApplied = true;
                selected = remoteSelected;
                scoredWindows = remoteWindows;
                modeCenter = (
                    remoteMode.window.startYear + remoteMode.window.endYear
                ) / 2;
                narrowCenter = modeCenter;
                recommendedWidth = 13;
                nineYearSafety = 0;
                widthThreshold = 1;
                if (input.eventType === "missingRing") {
                    windowCenteringRule = predictiveMode
                        ? "missing_predictive_remote_mode"
                        : "missing_family_remote_mode";
                    widthSelectionRule = predictiveMode
                        ? "missing_predictive_remote_mode"
                        : "missing_family_remote_mode";
                } else {
                    windowCenteringRule = "false_family_remote_mode";
                    widthSelectionRule = "false_family_remote_mode";
                }
            }
        }
    }

    if (
        input.eventType === "missingRing"
        && input.coarseWindow
        && input.missingCounterfactualRows
        && !validatedRemoteModeApplied
    ) {
        const currentModeWindow = {
            startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
            endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
        };
        if (recommendedWidth === 13) {
            const recentered = recenterMissingRingWideWindow(
                input.missingCounterfactualRows,
                currentModeWindow,
                input.coarseWindow,
            );
            if (recentered) {
                modeCenter = recentered.centerYear;
                narrowCenter = recentered.centerYear;
                windowCenteringRule = "missing_adjacent_mode_recenter";
                widthSelectionRule = "missing_adjacent_mode_recenter";
            }
        } else {
            const currentNarrowWindow = {
                startYear: Math.round(narrowCenter)
                    - Math.floor(recommendedWidth / 2),
                endYear: Math.round(narrowCenter)
                    + Math.floor(recommendedWidth / 2),
            };
            const recentered = recenterMissingRingNarrowWindow({
                rows: input.missingCounterfactualRows,
                currentWindow: currentNarrowWindow,
                containingWindow: currentModeWindow,
                currentPrimaryYear: input.currentPrimaryYear,
                operationEvidence: input.operationEvidence,
            });
            if (recentered) {
                narrowCenter = recentered.centerYear;
                windowCenteringRule = recentered.rule
                    === "boundary_anchor_consensus_step_2"
                    ? "missing_boundary_anchor_recenter"
                    : "missing_boundary_feature_recenter";
                widthSelectionRule = windowCenteringRule;
            }
        }
    }

    if (
        input.eventType === "falseRing"
        && shouldRejectNarrowForRemoteSideEvidence({
            recommendedWidth,
            centerYear: narrowCenter,
            sideStepBestYear: input.operationEvidence?.sideStepBestYear,
            coarseWindow: input.coarseWindow,
        })
    ) {
        recommendedWidth = 13;
        widthFallbackRule = "remote_side_evidence";
    }

    if (
        input.eventType === "missingRing"
        && shouldWidenMissingRingFiveYear({
            recommendedWidth,
            centerYear: narrowCenter,
            currentPrimaryYear: input.currentPrimaryYear,
            operationEvidence: input.operationEvidence,
        })
    ) {
        recommendedWidth = 7;
        widthSelectionRule = "missing_anchor_edge_wide";
    }

    const remote = scoredWindows.find((candidate) => (
        candidate.endYear < selected.startYear
        || candidate.startYear > selected.endYear
    ));
    const modeWindow = {
        startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
        endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
    };
    const finalWindow = recommendedWidth === 13
        ? modeWindow
        : {
                startYear: Math.round(narrowCenter)
                    - Math.floor(recommendedWidth / 2),
                endYear: Math.round(narrowCenter)
                    + Math.floor(recommendedWidth / 2),
            };
    return {
        window: finalWindow,
        modeWindow,
        recommendedWidth,
        nineYearSafety,
        widthThreshold,
        windowCenteringRule,
        widthFallbackRule,
        widthSelectionRule,
        score: selected.score,
        margin: selected.score - (scoredWindows[1]?.score ?? selected.score),
        remoteMargin: selected.score - (remote?.score ?? selected.score),
        scoredWindows: scoredWindows.map((candidate) => ({
            startYear: candidate.startYear,
            endYear: candidate.endYear,
            score: candidate.score,
        })),
        prePointModeWindow,
        preFalseCurrentAnchorModeWindow,
        preDirectModeWindow,
    };
};
