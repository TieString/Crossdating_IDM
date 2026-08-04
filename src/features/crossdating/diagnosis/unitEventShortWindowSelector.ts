/**
 * Conservative 9-to-7/5-year calibration for unit ring events.
 *
 * The learned ranker owns the selected location mode. An independent physical
 * locator may only shorten an already accepted 9-year window when its complete
 * window stays inside that mode and the frozen event-specific safety gate passes.
 */
import type {
    CalibratedEventWindowResult,
} from "./calibratedEventWindow";
import {
    shouldWidenMissingRingFiveYear,
    type UnitEventRankerOperationEvidence,
    type UnitEventWindowRankerResult,
    type UnitEventWindowType,
} from "./unitEventWindowRanker";

const MISSING_RING_FIVE_YEAR_MINIMUM_OPERATION_MARGIN = 0.13;
const FALSE_RING_SEVEN_YEAR_MINIMUM_OPERATION_MARGIN = 0.10;
const FALSE_RING_FIVE_YEAR_MINIMUM_OPERATION_MARGIN = 0.09;
const FALSE_RING_FIVE_YEAR_MAXIMUM_SIDE_ANCHOR_DISTANCE = 4;
const MODE_WIDTH = 13;
const SHORT_WIDTH = 9;
const MISSING_PROFILE_DIRECTION_CONSENSUS = 0.8;
const MISSING_BOUNDARY_PROFILE_CONSENSUS = 0.9;
const MISSING_NEWER_PROFILE_MINIMUM_DIFFERENCE_GAIN = 0.35;
const MISSING_NEWER_PROFILE_MINIMUM_SIDE_MARGIN = 0.1;
const MISSING_CONCENTRATED_PROFILE_MAX_OFFSET_SPREAD = 2;
const FALSE_CONCENTRATED_PROFILE_MAX_OFFSET_SPREAD = 3;
const CONCENTRATED_PROFILE_MINIMUM_MODE_FRACTION = 0.5;
const CONCENTRATED_PROFILE_MAX_ANCHOR_SPREAD = 3;
const FALSE_CONCENTRATED_PROFILE_MINIMUM_ANCHOR_FLANK = 2;
const MISSING_COMPACT_ANCHOR_MAXIMUM_SPREAD = 2;
const MISSING_COMPACT_ANCHOR_MINIMUM_REMOTE_MARGIN = 0.08;
const MISSING_AMBIGUOUS_SIDE_MINIMUM_SCORE = 0.6;
const MISSING_AMBIGUOUS_SIDE_MAXIMUM_REMOTE_MARGIN = 0.08;
const MISSING_WEAK_PROFILE_MAXIMUM_DIFFERENCE_GAIN = 0.25;
const MISSING_WEAK_PROFILE_MAXIMUM_SIDE_MARGIN = 0.05;
const MISSING_PROFILE_NAMES = [
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeReferenceMedian",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
    "piecewiseCombinedObjective",
    "transitionSplitGain",
    "rawFull",
    "differenceFull",
    "comboFull",
    "whitenedFull",
    "pairDifferenceWeighted",
    "pairWhitenedMean",
] as const;
const FALSE_PROFILE_NAMES = [
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeReferenceMedian",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
    "cumulativeReferenceVoteCusum",
    "piecewiseCombinedObjective",
    "transitionSplitGain",
    "rawFull",
    "differenceFull",
    "comboFull",
    "whitenedFull",
    "pairDifferenceWeighted",
    "pairWhitenedMean",
] as const;
const MISSING_REFERENCE_PROFILE_NAMES = [
    "cumulativeReferenceMedian",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
] as const;
const FALSE_EVIDENCE_ARBITRATION_RULES = new Set<
    UnitEventWindowRankerResult["windowCenteringRule"]
>([
    "false_point_evidence_reversion",
    "false_operation_evidence_reversion",
    "false_family_anchor_reversion",
    "false_difference_profile_mode",
    "false_physical_profile_mode",
    "false_evidence_profile_mode",
    "false_reference_median_mode",
]);
const MISSING_FIXED_CALIBRATION_RULES = new Set<
    UnitEventWindowRankerResult["widthSelectionRule"]
>([
    "missing_family_profile_mode",
    "missing_anchor_consensus_uncertain_13",
]);

export type UnitEventShortWindowSelection = {
    window: { startYear: number; endYear: number };
    recommendedWidth: 5 | 7 | 9 | 13;
    rule:
        | "independent_consensus_7"
        | "independent_minimum_calibrated_7"
        | "independent_calibrated_9"
        | "independent_high_margin_5"
        | "missing_boundary_conflict_13"
        | "missing_profile_side_older_9"
        | "missing_reference_side_newer_9"
        | "missing_boundary_profile_newer_9"
        | "missing_profile_median_9"
        | "missing_concentrated_profile_9"
        | "missing_compact_anchor_9"
        | "missing_ambiguous_remote_side_13"
        | "missing_weak_profile_evidence_13"
        | "missing_adjacent_mode_13"
        | "false_evidence_arbitration_13"
        | "false_side_mode_flank_13"
        | "false_family_flank_13"
        | "false_counterfactual_side_conflict_13"
        | "false_family_profile_risk_13"
        | "false_family_profile_median_9"
        | "false_concentrated_profile_9"
        | "false_subtle_empty_recovery_9";
};

const containsWindow = (
    outer: { startYear: number; endYear: number },
    inner: { startYear: number; endYear: number },
): boolean => (
    inner.startYear >= outer.startYear
    && inner.endYear <= outer.endYear
);

const containsYear = (
    window: { startYear: number; endYear: number },
    year: number | undefined,
): boolean => (
    year !== undefined
    && year >= window.startYear
    && year <= window.endYear
);

const widthOf = (window: { startYear: number; endYear: number }): number => (
    window.endYear - window.startYear + 1
);

const boundedNineYearWindow = (
    modeWindow: { startYear: number; endYear: number },
    offset: number,
): { startYear: number; endYear: number } => {
    const startYear = Math.max(
        modeWindow.startYear,
        Math.min(
            modeWindow.startYear + Math.round(offset),
            modeWindow.endYear - SHORT_WIDTH + 1,
        ),
    );
    return { startYear, endYear: startYear + SHORT_WIDTH - 1 };
};

const preferredProfileOffset = (input: {
    years: readonly number[];
    values: readonly number[];
    modeWindow: { startYear: number; endYear: number };
}): number | null => {
    if (input.years.length !== input.values.length) return null;
    const indexByYear = new Map(input.years.map((year, index) => [year, index]));
    const scores = Array.from({ length: 5 }, (_, offset) => {
        const startYear = input.modeWindow.startYear + offset;
        let score = 0;
        for (let year = startYear; year < startYear + SHORT_WIDTH; year += 1) {
            const index = indexByYear.get(year);
            if (index === undefined) return Number.NEGATIVE_INFINITY;
            const value = input.values[index] ?? 0;
            score += Number.isFinite(value) ? value : 0;
        }
        return score;
    });
    const maximum = Math.max(...scores);
    if (!Number.isFinite(maximum)) return null;
    for (let offset = scores.length - 1; offset >= 0; offset -= 1) {
        if (Math.abs((scores[offset] ?? 0) - maximum) <= 1e-12) return offset;
    }
    return null;
};

const profileOffsets = (input: {
    years?: readonly number[];
    ranks?: ReadonlyMap<string, readonly number[]>;
    modeWindow: { startYear: number; endYear: number };
    profileNames: readonly string[];
}): Map<string, number> | null => {
    if (
        !input.years
        || !input.ranks
        || widthOf(input.modeWindow) !== MODE_WIDTH
    ) return null;
    const offsets = new Map<string, number>();
    input.profileNames.forEach((name) => {
        const values = input.ranks!.get(name);
        if (!values) return;
        const offset = preferredProfileOffset({
            years: input.years!,
            values,
            modeWindow: input.modeWindow,
        });
        if (offset !== null) offsets.set(name, offset);
    });
    return offsets.size === input.profileNames.length ? offsets : null;
};

const selectMissingRingNineYearSafety = (input: {
    learnedWindow: UnitEventWindowRankerResult;
    years?: readonly number[];
    ranks?: ReadonlyMap<string, readonly number[]>;
    operationEvidence?: UnitEventRankerOperationEvidence;
}): UnitEventShortWindowSelection | null => {
    const currentWindow = input.learnedWindow.window;
    const modeWindow = input.learnedWindow.modeWindow;
    if (
        input.learnedWindow.recommendedWidth !== SHORT_WIDTH
        || widthOf(currentWindow) !== SHORT_WIDTH
        || widthOf(modeWindow) !== MODE_WIDTH
    ) return null;
    const operation = input.operationEvidence;
    const sideYear = operation?.sideStepBestYear;
    const ambiguousRemoteSide = (
        input.learnedWindow.windowCenteringRule === "mode_mass"
        && input.learnedWindow.widthSelectionRule === "missing_point_model"
        && sideYear !== undefined
        && !containsYear(modeWindow, sideYear)
        && (operation?.bestSideStepScore ?? Number.NEGATIVE_INFINITY)
            >= MISSING_AMBIGUOUS_SIDE_MINIMUM_SCORE
        && (operation?.sideStepRemoteMargin ?? Number.POSITIVE_INFINITY)
            <= MISSING_AMBIGUOUS_SIDE_MAXIMUM_REMOTE_MARGIN
    );
    if (ambiguousRemoteSide) {
        return {
            window: modeWindow,
            recommendedWidth: 13,
            rule: "missing_ambiguous_remote_side_13",
        };
    }
    const offsets = profileOffsets({
        years: input.years,
        ranks: input.ranks,
        modeWindow,
        profileNames: MISSING_PROFILE_NAMES,
    });
    if (!offsets) return null;
    const currentOffset = currentWindow.startYear - modeWindow.startYear;
    const orderedOffsets = Array.from(offsets.values()).sort((a, b) => a - b);
    const medianOffset = orderedOffsets[Math.floor(orderedOffsets.length / 2)]!;
    const olderFraction = orderedOffsets.filter(
        (offset) => offset < currentOffset,
    ).length / orderedOffsets.length;
    const newerFraction = orderedOffsets.filter(
        (offset) => offset > currentOffset,
    ).length / orderedOffsets.length;
    if (
        input.learnedWindow.windowCenteringRule
            === "missing_boundary_feature_recenter"
        && sideYear !== undefined
        && sideYear > modeWindow.endYear
        && currentWindow.startYear - modeWindow.startYear >= 3
    ) {
        return {
            window: modeWindow,
            recommendedWidth: 13,
            rule: "missing_boundary_conflict_13",
        };
    }
    if (
        sideYear !== undefined
        && sideYear < currentWindow.startYear
        && olderFraction >= MISSING_PROFILE_DIRECTION_CONSENSUS
    ) {
        return {
            window: boundedNineYearWindow(modeWindow, medianOffset),
            recommendedWidth: 9,
            rule: "missing_profile_side_older_9",
        };
    }
    if (
        sideYear !== undefined
        && sideYear > currentWindow.endYear
        && MISSING_REFERENCE_PROFILE_NAMES.every((name) => (
            (offsets.get(name) ?? currentOffset) > currentOffset
        ))
    ) {
        const offset = Math.min(...MISSING_REFERENCE_PROFILE_NAMES.map(
            (name) => offsets.get(name)!,
        ));
        return {
            window: boundedNineYearWindow(modeWindow, offset),
            recommendedWidth: 9,
            rule: "missing_reference_side_newer_9",
        };
    }
    if (
        input.learnedWindow.windowCenteringRule
            === "missing_boundary_feature_recenter"
        && currentOffset <= 1
        && medianOffset >= currentOffset + 2
        && newerFraction >= MISSING_BOUNDARY_PROFILE_CONSENSUS
        && (operation?.bestDifferenceGain ?? Number.POSITIVE_INFINITY) <= 0.25
        && (operation?.remoteDifferenceMargin ?? 0) >= 0.1
        && (operation?.sideStepRemoteMargin ?? 0) >= 0.3
    ) {
        return {
            window: boundedNineYearWindow(modeWindow, medianOffset),
            recommendedWidth: 9,
            rule: "missing_boundary_profile_newer_9",
        };
    }
    if (
        input.learnedWindow.windowCenteringRule
            === "missing_adjacent_mode_recenter"
    ) {
        return {
            window: modeWindow,
            recommendedWidth: 13,
            rule: "missing_adjacent_mode_13",
        };
    }
    return null;
};

const selectFalseRingThirteenYearSafety = (input: {
    learnedWindow: UnitEventWindowRankerResult;
    proposedWindow: { startYear: number; endYear: number };
    operationEvidence?: UnitEventRankerOperationEvidence;
}): UnitEventShortWindowSelection | null => {
    const modeWindow = input.learnedWindow.modeWindow;
    const operation = input.operationEvidence;
    const sideYear = operation?.sideStepBestYear;
    const pointModeTouchesProposedEdge = (
        input.learnedWindow.widthSelectionRule
            === "false_point_narrow_evidence_wide"
        && operation?.bestYear !== undefined
        && (
            operation.bestYear <= input.proposedWindow.startYear
            || operation.bestYear >= input.proposedWindow.endYear
        )
    );
    if (FALSE_EVIDENCE_ARBITRATION_RULES.has(
        input.learnedWindow.windowCenteringRule,
    ) || pointModeTouchesProposedEdge) {
        return {
            window: modeWindow,
            recommendedWidth: 13,
            rule: "false_evidence_arbitration_13",
        };
    }
    if (
        input.learnedWindow.windowCenteringRule === "false_side_step_mode"
        && sideYear !== undefined
        && !containsYear(modeWindow, sideYear)
    ) {
        return {
            window: modeWindow,
            recommendedWidth: 13,
            rule: "false_side_mode_flank_13",
        };
    }
    const olderFamilyConflict = (
        sideYear !== undefined
        && sideYear < modeWindow.startYear
        && input.proposedWindow.startYear > modeWindow.startYear
        && (operation?.bestDifferenceGain ?? Number.POSITIVE_INFINITY) < 0.1
        && (operation?.remoteDifferenceMargin ?? Number.POSITIVE_INFINITY) < 0.1
    );
    const newerFamilyConflict = (
        sideYear !== undefined
        && sideYear - modeWindow.endYear >= 15
        && input.proposedWindow.endYear < modeWindow.endYear
    );
    if (
        input.learnedWindow.windowCenteringRule
            === "false_family_mode_consensus"
        && (olderFamilyConflict || newerFamilyConflict)
    ) {
        return {
            window: modeWindow,
            recommendedWidth: 13,
            rule: "false_family_flank_13",
        };
    }
    return null;
};

const sameWindow = (
    left: { startYear: number; endYear: number },
    right: { startYear: number; endYear: number },
): boolean => (
    left.startYear === right.startYear
    && left.endYear === right.endYear
);

const selectMedianProfileWindow = (input: {
    years?: readonly number[];
    ranks?: ReadonlyMap<string, readonly number[]>;
    modeWindow: { startYear: number; endYear: number };
    profileNames: readonly string[];
}): { window: { startYear: number; endYear: number }; offset: number } | null => {
    const offsets = profileOffsets(input);
    if (!offsets) return null;
    const ordered = Array.from(offsets.values()).sort((left, right) => left - right);
    const offset = ordered[Math.floor(ordered.length / 2)];
    if (offset === undefined) return null;
    return {
        window: boundedNineYearWindow(input.modeWindow, offset),
        offset,
    };
};

const selectConcentratedProfileWindow = (input: {
    eventType: UnitEventWindowType;
    learnedWindow: UnitEventWindowRankerResult;
    currentPrimaryYear?: number;
    operationEvidence?: UnitEventRankerOperationEvidence;
    years?: readonly number[];
    ranks?: ReadonlyMap<string, readonly number[]>;
}): UnitEventShortWindowSelection | null => {
    const modeWindow = input.learnedWindow.modeWindow;
    if (
        input.learnedWindow.recommendedWidth !== MODE_WIDTH
        || widthOf(input.learnedWindow.window) !== MODE_WIDTH
        || widthOf(modeWindow) !== MODE_WIDTH
    ) return null;
    const offsets = profileOffsets({
        years: input.years,
        ranks: input.ranks,
        modeWindow,
        profileNames: input.eventType === "missingRing"
            ? MISSING_PROFILE_NAMES
            : FALSE_PROFILE_NAMES,
    });
    if (!offsets) return null;
    const orderedOffsets = Array.from(offsets.values())
        .sort((left, right) => left - right);
    const minimumOffset = orderedOffsets[0];
    const maximumOffset = orderedOffsets[orderedOffsets.length - 1];
    const maximumProfileSpread = input.eventType === "missingRing"
        ? MISSING_CONCENTRATED_PROFILE_MAX_OFFSET_SPREAD
        : FALSE_CONCENTRATED_PROFILE_MAX_OFFSET_SPREAD;
    if (
        minimumOffset === undefined
        || maximumOffset === undefined
        || maximumOffset - minimumOffset > maximumProfileSpread
    ) return null;
    const offsetCounts = new Map<number, number>();
    orderedOffsets.forEach((offset) => {
        offsetCounts.set(offset, (offsetCounts.get(offset) ?? 0) + 1);
    });
    const maximumOffsetCount = Math.max(...offsetCounts.values());
    if (
        maximumOffsetCount / orderedOffsets.length
            < CONCENTRATED_PROFILE_MINIMUM_MODE_FRACTION
    ) return null;

    const operation = input.operationEvidence;
    const anchors = [
        input.currentPrimaryYear,
        operation?.bestYear,
        operation?.sideStepBestYear,
    ];
    if (anchors.some((year) => year === undefined)) return null;
    const completeAnchors = anchors as number[];
    if (
        Math.max(...completeAnchors) - Math.min(...completeAnchors)
            > CONCENTRATED_PROFILE_MAX_ANCHOR_SPREAD
    ) return null;

    const medianOffset = orderedOffsets[Math.floor(orderedOffsets.length / 2)];
    if (medianOffset === undefined) return null;
    const window = boundedNineYearWindow(modeWindow, medianOffset);
    const minimumAnchorFlank = input.eventType === "falseRing"
        ? FALSE_CONCENTRATED_PROFILE_MINIMUM_ANCHOR_FLANK
        : 0;
    if (
        !containsWindow(input.learnedWindow.window, window)
        || !completeAnchors.every((year) => (
            year >= window.startYear + minimumAnchorFlank
            && year <= window.endYear - minimumAnchorFlank
        ))
    ) return null;
    return {
        window,
        recommendedWidth: 9,
        rule: input.eventType === "missingRing"
            ? "missing_concentrated_profile_9"
            : "false_concentrated_profile_9",
    };
};

const reconcileMissingRingProfileWindow = (input: {
    learnedWindow: UnitEventWindowRankerResult;
    proposed: UnitEventShortWindowSelection | null;
    operationEvidence?: UnitEventRankerOperationEvidence;
    years?: readonly number[];
    ranks?: ReadonlyMap<string, readonly number[]>;
}): UnitEventShortWindowSelection | null => {
    const proposedWindow = input.proposed?.window ?? input.learnedWindow.window;
    const proposedWidth = input.proposed?.recommendedWidth
        ?? input.learnedWindow.recommendedWidth;
    const modeWindow = input.learnedWindow.modeWindow;
    if (proposedWidth >= MODE_WIDTH || widthOf(modeWindow) !== MODE_WIDTH) {
        return input.proposed;
    }
    const candidate = selectMedianProfileWindow({
        years: input.years,
        ranks: input.ranks,
        modeWindow,
        profileNames: MISSING_PROFILE_NAMES,
    });
    if (!candidate) return input.proposed;
    const sideYear = input.operationEvidence?.sideStepBestYear;
    if (
        sideYear !== undefined
        && (input.operationEvidence?.sideStepRemoteMargin ?? 0) >= 0.05
        && !containsYear(candidate.window, sideYear)
    ) return input.proposed;
    if (
        input.learnedWindow.windowCenteringRule === "mode_mass"
        && candidate.window.startYear - proposedWindow.startYear >= 2
        && (
            input.operationEvidence?.bestDifferenceGain
            ?? Number.POSITIVE_INFINITY
        ) < MISSING_NEWER_PROFILE_MINIMUM_DIFFERENCE_GAIN
        && (
            input.operationEvidence?.sideStepRemoteMargin
            ?? Number.NEGATIVE_INFINITY
        ) >= MISSING_NEWER_PROFILE_MINIMUM_SIDE_MARGIN
        && containsYear(proposedWindow, sideYear)
    ) return input.proposed;
    if (proposedWidth === SHORT_WIDTH && sameWindow(proposedWindow, candidate.window)) {
        return input.proposed;
    }
    if (
        input.learnedWindow.windowCenteringRule === "mode_mass"
        && input.learnedWindow.widthSelectionRule === "missing_point_model"
        && (input.operationEvidence?.bestDifferenceGain
            ?? Number.POSITIVE_INFINITY)
            <= MISSING_WEAK_PROFILE_MAXIMUM_DIFFERENCE_GAIN
        && (input.operationEvidence?.sideStepRemoteMargin
            ?? Number.POSITIVE_INFINITY)
            < MISSING_WEAK_PROFILE_MAXIMUM_SIDE_MARGIN
    ) {
        return {
            window: modeWindow,
            recommendedWidth: 13,
            rule: "missing_weak_profile_evidence_13",
        };
    }
    return {
        window: candidate.window,
        recommendedWidth: 9,
        rule: "missing_profile_median_9",
    };
};

const reconcileFalseRingProfileWindow = (input: {
    learnedWindow: UnitEventWindowRankerResult;
    proposed: UnitEventShortWindowSelection | null;
    operationEvidence?: UnitEventRankerOperationEvidence;
    years?: readonly number[];
    ranks?: ReadonlyMap<string, readonly number[]>;
}): UnitEventShortWindowSelection | null => {
    const proposedWindow = input.proposed?.window ?? input.learnedWindow.window;
    const proposedWidth = input.proposed?.recommendedWidth
        ?? input.learnedWindow.recommendedWidth;
    const modeWindow = input.learnedWindow.modeWindow;
    if (proposedWidth >= MODE_WIDTH || widthOf(modeWindow) !== MODE_WIDTH) {
        return input.proposed;
    }
    const operation = input.operationEvidence;
    const sideYear = operation?.sideStepBestYear;
    const sideMargin = operation?.sideStepRemoteMargin
        ?? Number.NEGATIVE_INFINITY;
    const counterfactualSideConflict = (
        input.learnedWindow.windowCenteringRule === "false_counterfactual_mass"
        && sideYear !== undefined
        && sideMargin >= 0.1
        && (
            (
                sideYear < modeWindow.startYear
                && proposedWindow.startYear > modeWindow.startYear
            )
            || (
                sideYear > modeWindow.endYear
                && proposedWindow.endYear < modeWindow.endYear
            )
        )
    );
    if (counterfactualSideConflict) {
        return {
            window: modeWindow,
            recommendedWidth: 13,
            rule: "false_counterfactual_side_conflict_13",
        };
    }
    if (
        input.learnedWindow.windowCenteringRule
            !== "false_family_mode_consensus"
    ) return input.proposed;
    const candidate = selectMedianProfileWindow({
        years: input.years,
        ranks: input.ranks,
        modeWindow,
        profileNames: FALSE_PROFILE_NAMES,
    });
    if (!candidate) return input.proposed;
    const currentOffset = proposedWindow.startYear - modeWindow.startYear;
    if (
        currentOffset >= 3
        && candidate.offset < currentOffset
        && sideMargin < 0.05
    ) {
        return {
            window: modeWindow,
            recommendedWidth: 13,
            rule: "false_family_profile_risk_13",
        };
    }
    if (
        sideYear !== undefined
        && sideMargin >= 0.05
        && !containsYear(candidate.window, sideYear)
    ) return input.proposed;
    if (proposedWidth === SHORT_WIDTH && sameWindow(proposedWindow, candidate.window)) {
        return input.proposed;
    }
    return {
        window: candidate.window,
        recommendedWidth: 9,
        rule: "false_family_profile_median_9",
    };
};

type UnitEventShortWindowInput = {
    eventType: UnitEventWindowType;
    learnedWindow: UnitEventWindowRankerResult;
    independentWindow?: CalibratedEventWindowResult;
    subtleFalseRingRecovery?: boolean;
    currentPrimaryYear?: number;
    operationEvidence?: UnitEventRankerOperationEvidence;
    years?: readonly number[];
    ranks?: ReadonlyMap<string, readonly number[]>;
};

const selectMissingCompactAnchorWindow = (
    input: UnitEventShortWindowInput,
): UnitEventShortWindowSelection | null => {
    const modeWindow = input.learnedWindow.modeWindow;
    const anchors = [
        input.currentPrimaryYear,
        input.operationEvidence?.bestYear,
        input.operationEvidence?.sideStepBestYear,
    ];
    if (
        input.eventType !== "missingRing"
        || input.learnedWindow.recommendedWidth !== MODE_WIDTH
        || widthOf(modeWindow) !== MODE_WIDTH
        || anchors.some((year) => year === undefined)
        || (input.operationEvidence?.remoteDifferenceMargin
            ?? Number.NEGATIVE_INFINITY)
            < MISSING_COMPACT_ANCHOR_MINIMUM_REMOTE_MARGIN
    ) return null;
    const completeAnchors = (anchors as number[]).sort((a, b) => a - b);
    if (
        completeAnchors[completeAnchors.length - 1] - completeAnchors[0]
            > MISSING_COMPACT_ANCHOR_MAXIMUM_SPREAD
    ) return null;
    const centerYear = completeAnchors[Math.floor(completeAnchors.length / 2)];
    const startYear = Math.max(
        modeWindow.startYear,
        Math.min(centerYear - 4, modeWindow.endYear - SHORT_WIDTH + 1),
    );
    const window = { startYear, endYear: startYear + SHORT_WIDTH - 1 };
    if (!completeAnchors.every((year) => (
        year >= window.startYear + 1 && year <= window.endYear - 1
    ))) return null;
    return {
        window,
        recommendedWidth: 9,
        rule: "missing_compact_anchor_9",
    };
};

const selectUnitEventShortWindowBase = (
    input: UnitEventShortWindowInput,
): UnitEventShortWindowSelection | null => {
    const selectMissingSafety = (): UnitEventShortWindowSelection | null => (
        input.eventType === "missingRing"
            ? selectMissingRingNineYearSafety({
                    learnedWindow: input.learnedWindow,
                    years: input.years,
                    ranks: input.ranks,
                    operationEvidence: input.operationEvidence,
                })
            : null
    );
    if (
        input.eventType === "falseRing"
        && input.subtleFalseRingRecovery === true
        && input.learnedWindow.recommendedWidth === MODE_WIDTH
        && widthOf(input.learnedWindow.modeWindow) === MODE_WIDTH
        && input.operationEvidence?.sideStepBestYear !== undefined
    ) {
        return {
            window: boundedNineYearWindow(
                input.learnedWindow.modeWindow,
                input.operationEvidence.sideStepBestYear
                    - input.learnedWindow.modeWindow.startYear
                    - Math.floor(SHORT_WIDTH / 2),
            ),
            recommendedWidth: 9,
            rule: "false_subtle_empty_recovery_9",
        };
    }
    if (
        input.eventType === "falseRing"
        && input.learnedWindow.recommendedWidth === 13
        && input.independentWindow
        && input.independentWindow.width <= 9
    ) {
        const centerYear = (
            input.independentWindow.window.startYear
            + input.independentWindow.window.endYear
        ) / 2;
        const startYear = Math.max(
            input.learnedWindow.window.startYear,
            Math.min(
                Math.round(centerYear) - 4,
                input.learnedWindow.window.endYear - 8,
            ),
        );
        const proposedWindow = {
            startYear,
            endYear: startYear + SHORT_WIDTH - 1,
        };
        const safety = selectFalseRingThirteenYearSafety({
            learnedWindow: input.learnedWindow,
            proposedWindow,
            operationEvidence: input.operationEvidence,
        });
        if (safety) return safety;
        return {
            window: proposedWindow,
            recommendedWidth: 9,
            rule: "independent_calibrated_9",
        };
    }
    const compactMissingAnchorWindow = selectMissingCompactAnchorWindow(input);
    if (compactMissingAnchorWindow) return compactMissingAnchorWindow;
    if (
        input.eventType === "missingRing"
        && input.learnedWindow.recommendedWidth === 13
        && MISSING_FIXED_CALIBRATION_RULES.has(
            input.learnedWindow.widthSelectionRule,
        )
    ) return null;
    const concentratedProfileWindow = selectConcentratedProfileWindow(input);
    if (concentratedProfileWindow) return concentratedProfileWindow;
    if (input.learnedWindow.recommendedWidth !== 9) return null;

    const { independentWindow } = input;
    if (!independentWindow) return selectMissingSafety();
    if (
        independentWindow.width !== 5
        && independentWindow.width !== 7
    ) return selectMissingSafety();
    if (!containsWindow(input.learnedWindow.window, independentWindow.window)) {
        return selectMissingSafety();
    }

    if (independentWindow.width === 7) {
        if (
            input.eventType === "falseRing"
            && (
                input.operationEvidence?.remoteDifferenceMargin
                ?? Number.NEGATIVE_INFINITY
            ) < FALSE_RING_SEVEN_YEAR_MINIMUM_OPERATION_MARGIN
        ) return null;
        return {
            window: independentWindow.window,
            recommendedWidth: 7,
            rule: "independent_consensus_7",
        };
    }

    const operationMargin =
        input.operationEvidence?.remoteDifferenceMargin
        ?? Number.NEGATIVE_INFINITY;
    if (
        input.eventType === "missingRing"
        && shouldWidenMissingRingFiveYear({
            recommendedWidth: 5,
            centerYear: (
                independentWindow.window.startYear
                + independentWindow.window.endYear
            ) / 2,
            currentPrimaryYear: input.currentPrimaryYear,
            operationEvidence: input.operationEvidence,
        })
    ) return selectMissingSafety();
    if (
        input.eventType === "missingRing"
        && operationMargin
            >= MISSING_RING_FIVE_YEAR_MINIMUM_OPERATION_MARGIN
    ) {
        return {
            window: independentWindow.window,
            recommendedWidth: 5,
            rule: "independent_high_margin_5",
        };
    }

    const sideStepBestYear = input.operationEvidence?.sideStepBestYear;
    if (
        input.eventType === "falseRing"
        && operationMargin >= FALSE_RING_FIVE_YEAR_MINIMUM_OPERATION_MARGIN
        && input.currentPrimaryYear !== undefined
        && sideStepBestYear !== undefined
        && Math.abs(sideStepBestYear - input.currentPrimaryYear)
            <= FALSE_RING_FIVE_YEAR_MAXIMUM_SIDE_ANCHOR_DISTANCE
    ) {
        const centerYear = (
            independentWindow.window.startYear
            + independentWindow.window.endYear
        ) / 2;
        const startYear = Math.max(
            input.learnedWindow.window.startYear,
            Math.min(
                Math.round(centerYear) - 3,
                input.learnedWindow.window.endYear - 6,
            ),
        );
        return {
            window: { startYear, endYear: startYear + 6 },
            recommendedWidth: 7,
            rule: "independent_minimum_calibrated_7",
        };
    }

    return selectMissingSafety();
};

export const selectUnitEventShortWindow = (
    input: UnitEventShortWindowInput,
): UnitEventShortWindowSelection | null => {
    if (
        input.eventType === "missingRing"
        && input.learnedWindow.widthSelectionRule
            === "missing_family_profile_mode"
    ) return null;
    const proposed = selectUnitEventShortWindowBase(input);
    if (input.eventType === "missingRing") {
        return reconcileMissingRingProfileWindow({
            learnedWindow: input.learnedWindow,
            proposed,
            operationEvidence: input.operationEvidence,
            years: input.years,
            ranks: input.ranks,
        });
    }
    return reconcileFalseRingProfileWindow({
        learnedWindow: input.learnedWindow,
        proposed,
        operationEvidence: input.operationEvidence,
        years: input.years,
        ranks: input.ranks,
    });
};
