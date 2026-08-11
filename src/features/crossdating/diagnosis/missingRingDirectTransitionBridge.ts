export type MissingRingBridgeWindow = {
    startYear: number;
    endYear: number;
};

export type MissingRingDirectTransitionBridge = {
    window: MissingRingBridgeWindow;
    discardedWindow: MissingRingBridgeWindow;
    currentPrimaryYear: number;
    directTransitionYear: number;
    shiftYears: number;
};

const REVIEW_WINDOW_WIDTH = 13;
const MINIMUM_ANCHOR_DISTANCE = 7;
const MAXIMUM_ANCHOR_DISTANCE = REVIEW_WINDOW_WIDTH - 1;

const widthOf = (window: MissingRingBridgeWindow): number => (
    window.endYear - window.startYear + 1
);

const contains = (
    window: MissingRingBridgeWindow,
    year: number,
): boolean => year >= window.startYear && year <= window.endYear;

/**
 * Reconciles one ambiguous missing-ring mode with an independent lag transition.
 * The result is the smallest 13-year translation that retains both anchors.
 */
export const selectMissingRingDirectTransitionBridge = (input: {
    currentWindow: MissingRingBridgeWindow;
    coarseWindow: MissingRingBridgeWindow;
    currentPrimaryYear: number | undefined;
    directTransitionYear: number | null;
    locationAmbiguous: boolean;
}): MissingRingDirectTransitionBridge | null => {
    const {
        currentWindow,
        coarseWindow,
        currentPrimaryYear,
        directTransitionYear,
    } = input;
    if (
        !input.locationAmbiguous
        || currentPrimaryYear === undefined
        || directTransitionYear === null
        || widthOf(currentWindow) !== REVIEW_WINDOW_WIDTH
        || widthOf(coarseWindow) < REVIEW_WINDOW_WIDTH
        || !contains(currentWindow, currentPrimaryYear)
        || contains(currentWindow, directTransitionYear)
        || !contains(coarseWindow, currentPrimaryYear)
        || !contains(coarseWindow, directTransitionYear)
    ) return null;

    const anchorDistance = Math.abs(
        currentPrimaryYear - directTransitionYear,
    );
    if (
        anchorDistance < MINIMUM_ANCHOR_DISTANCE
        || anchorDistance > MAXIMUM_ANCHOR_DISTANCE
    ) return null;

    const minimumAnchor = Math.min(
        currentPrimaryYear,
        directTransitionYear,
    );
    const maximumAnchor = Math.max(
        currentPrimaryYear,
        directTransitionYear,
    );
    const minimumStart = Math.max(
        coarseWindow.startYear,
        maximumAnchor - REVIEW_WINDOW_WIDTH + 1,
    );
    const maximumStart = Math.min(
        coarseWindow.endYear - REVIEW_WINDOW_WIDTH + 1,
        minimumAnchor,
    );
    if (minimumStart > maximumStart) return null;

    const startYear = Math.max(
        minimumStart,
        Math.min(currentWindow.startYear, maximumStart),
    );
    const window = {
        startYear,
        endYear: startYear + REVIEW_WINDOW_WIDTH - 1,
    };
    if (
        window.startYear === currentWindow.startYear
        || !contains(window, currentPrimaryYear)
        || !contains(window, directTransitionYear)
    ) return null;

    return {
        window,
        discardedWindow: { ...currentWindow },
        currentPrimaryYear,
        directTransitionYear,
        shiftYears: window.startYear - currentWindow.startYear,
    };
};
