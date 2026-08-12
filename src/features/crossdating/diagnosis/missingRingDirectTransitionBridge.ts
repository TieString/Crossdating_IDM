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

export type MissingRingDiffuseOlderConsensusRecenter = {
    window: MissingRingBridgeWindow;
    discardedWindow: MissingRingBridgeWindow;
    scanTopYear: number;
    directTransitionYear: number;
    candidateTopYear: number;
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

/**
 * Recovers an older mode only when two independent boundary channels agree and the learned
 * 13-year locator has no concentrated mode of its own. The candidate anchor must fit in the
 * translated window, so this cannot jump to a detached scan peak by itself.
 */
export const selectMissingRingDiffuseOlderConsensusRecenter = (input: {
    currentWindow: MissingRingBridgeWindow;
    minimumYear: number;
    maximumYear: number;
    scanTopYear: number | null;
    directTransitionYear: number | null;
    candidateTopYear: number | null;
    candidateTopProbability: number | undefined;
    candidateTopMargin: number | undefined;
    locatorConcentration: number;
    locatorRemoteMargin: number;
    pairReferenceCount: number;
}): MissingRingDiffuseOlderConsensusRecenter | null => {
    const {
        currentWindow,
        scanTopYear,
        directTransitionYear,
        candidateTopYear,
    } = input;
    if (
        widthOf(currentWindow) !== REVIEW_WINDOW_WIDTH
        || scanTopYear === null
        || directTransitionYear === null
        || candidateTopYear === null
        || scanTopYear >= currentWindow.startYear
        || directTransitionYear >= currentWindow.startYear
        || Math.abs(scanTopYear - directTransitionYear) > 1
        || currentWindow.startYear - Math.max(
            scanTopYear,
            directTransitionYear,
        ) > 7
        || Math.abs(candidateTopYear - scanTopYear) > 5
        || Math.abs(candidateTopYear - directTransitionYear) > 6
        || (input.candidateTopProbability ?? Number.NEGATIVE_INFINITY) < 0.45
        || (input.candidateTopMargin ?? Number.NEGATIVE_INFINITY) < 0.35
        || input.locatorConcentration > 0.01
        || input.locatorRemoteMargin > 0.01
        || input.pairReferenceCount < 8
    ) return null;

    const minimumAnchor = Math.min(
        scanTopYear,
        directTransitionYear,
        candidateTopYear,
    );
    const maximumAnchor = Math.max(
        scanTopYear,
        directTransitionYear,
        candidateTopYear,
    );
    if (maximumAnchor - minimumAnchor >= REVIEW_WINDOW_WIDTH) return null;

    const minimumStart = Math.max(
        input.minimumYear,
        maximumAnchor - REVIEW_WINDOW_WIDTH + 1,
    );
    const maximumStart = Math.min(
        input.maximumYear - REVIEW_WINDOW_WIDTH + 1,
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
        || !contains(window, scanTopYear)
        || !contains(window, directTransitionYear)
        || !contains(window, candidateTopYear)
    ) return null;

    return {
        window,
        discardedWindow: { ...currentWindow },
        scanTopYear,
        directTransitionYear,
        candidateTopYear,
        shiftYears: window.startYear - currentWindow.startYear,
    };
};
