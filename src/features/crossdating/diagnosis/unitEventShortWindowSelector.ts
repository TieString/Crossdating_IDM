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

export type UnitEventShortWindowSelection = {
    window: { startYear: number; endYear: number };
    recommendedWidth: 5 | 7;
    rule:
        | "independent_consensus_7"
        | "independent_high_margin_5";
};

const containsWindow = (
    outer: { startYear: number; endYear: number },
    inner: { startYear: number; endYear: number },
): boolean => (
    inner.startYear >= outer.startYear
    && inner.endYear <= outer.endYear
);

export const selectUnitEventShortWindow = (input: {
    eventType: UnitEventWindowType;
    learnedWindow: UnitEventWindowRankerResult;
    independentWindow: CalibratedEventWindowResult;
    currentPrimaryYear?: number;
    operationEvidence?: UnitEventRankerOperationEvidence;
}): UnitEventShortWindowSelection | null => {
    if (input.learnedWindow.recommendedWidth !== 9) return null;

    const { independentWindow } = input;
    if (
        independentWindow.width !== 5
        && independentWindow.width !== 7
    ) return null;
    if (!containsWindow(input.learnedWindow.window, independentWindow.window)) {
        return null;
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
    ) return null;
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
        return {
            window: independentWindow.window,
            recommendedWidth: 5,
            rule: "independent_high_margin_5",
        };
    }

    return null;
};
