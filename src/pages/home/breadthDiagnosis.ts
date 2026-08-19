import type {
    DiagnosisConfidence,
    DiagnosisEvent,
    DiagnosisEventType,
} from "@/features/crossdating/diagnosis";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";

export type BreadthScanStatus = "idle" | "stale" | "scanning" | "paused" | "complete";

export type BreadthScanPauseReason =
    | "file-load"
    | "save"
    | "cofecha"
    | "selected-diagnosis";

export type BreadthSuggestionPriority = {
    /** Calibrated confidence plus whether the event passed the strict display gate. */
    reliabilityTier: number;
    /** Fraction of the target core that would be realigned by fixing this frontier. */
    frontierRatio: number;
    /** Target years on the affected side that overlap at least one other core. */
    sharedOverlapYears: number;
    /** Overlap years weighted by reference depth, capped to avoid large files dominating. */
    weightedReferenceOverlap: number;
    /** Calendar distance from the suggested frontier to the bark-side endpoint. */
    newerEndDistanceYears: number;
    windowWidth: number;
    evidenceMargin: number;
    correlationGain: number;
};

export type BreadthDiagnosisSuggestion = {
    fingerprint: string;
    eventId: string;
    seriesId: string;
    eventType: DiagnosisEventType;
    startYear: number;
    endYear: number;
    topYear: number;
    shiftYears?: number;
    confidenceLevel: DiagnosisConfidence;
    reviewOnly: boolean;
    priority: BreadthSuggestionPriority;
    firstSeenAt: number;
    firstSeenOrder: number;
};

export type BreadthDiagnosisNavigatorState = {
    status: BreadthScanStatus;
    pauseReason?: BreadthScanPauseReason;
    scannedCount: number;
    totalCount: number;
    suggestions: BreadthDiagnosisSuggestion[];
};

export const createEmptyBreadthDiagnosisNavigator = (): BreadthDiagnosisNavigatorState => ({
    status: "idle",
    scannedCount: 0,
    totalCount: 0,
    suggestions: [],
});

const normalizeSeriesId = (seriesId: string) => seriesId.trim().toUpperCase();

/**
 * Only COFECHA PART 6 A-flagged series are eligible. Previously observed frontiers among that
 * target set are rechecked first after a save; all other A targets retain file order.
 */
export const orderBreadthScanTargets = (
    seriesIds: readonly string[],
    cofechaFlaggedSeriesIds: readonly string[],
    previouslyPrioritizedSeriesIds: readonly string[] = [],
): string[] => {
    const flagged = new Set(cofechaFlaggedSeriesIds.map(normalizeSeriesId));
    const previousPriority = new Map<string, number>();
    previouslyPrioritizedSeriesIds.forEach((seriesId, index) => {
        const normalized = normalizeSeriesId(seriesId);
        if (!previousPriority.has(normalized)) previousPriority.set(normalized, index);
    });
    const eligibleSeriesIds = seriesIds.filter((seriesId) => (
        flagged.has(normalizeSeriesId(seriesId))
    ));
    const stableOrder = new Map(eligibleSeriesIds.map((seriesId, index) => (
        [normalizeSeriesId(seriesId), index]
    )));

    return [...eligibleSeriesIds].sort((left, right) => {
        const normalizedLeft = normalizeSeriesId(left);
        const normalizedRight = normalizeSeriesId(right);
        const leftPrevious = previousPriority.get(normalizedLeft);
        const rightPrevious = previousPriority.get(normalizedRight);
        if (leftPrevious !== undefined || rightPrevious !== undefined) {
            if (leftPrevious === undefined) return 1;
            if (rightPrevious === undefined) return -1;
            return leftPrevious - rightPrevious;
        }

        return (stableOrder.get(normalizedLeft) ?? 0) - (stableOrder.get(normalizedRight) ?? 0);
    });
};

const confidenceRank: Record<DiagnosisConfidence, number> = {
    high: 3,
    medium: 2,
    low: 1,
};

const hasMeasuredRing = (value: number | null | undefined): value is number => (
    typeof value === "number" && Number.isFinite(value) && value > 0
);

const findTreeData = (siteData: RwlSiteData | undefined, seriesId: string) => {
    if (!siteData) return undefined;
    const direct = siteData.get(seriesId);
    if (direct) return direct;
    const normalized = normalizeSeriesId(seriesId);
    return Array.from(siteData.entries()).find(([candidate]) => (
        normalizeSeriesId(candidate) === normalized
    ))?.[1];
};

const measuredYears = (treeData: RwlTreeData | undefined) => (
    treeData
        ? Array.from(treeData.entries())
            .filter(([, value]) => hasMeasuredRing(value))
            .map(([year]) => year)
            .sort((left, right) => left - right)
        : []
);

const fallbackPriority = (
    confidenceLevel: DiagnosisConfidence,
    reviewOnly: boolean,
    windowWidth: number,
): BreadthSuggestionPriority => ({
    reliabilityTier: confidenceRank[confidenceLevel] + (reviewOnly ? 0 : 2),
    frontierRatio: 0,
    sharedOverlapYears: 0,
    weightedReferenceOverlap: 0,
    newerEndDistanceYears: Number.MAX_SAFE_INTEGER,
    windowWidth,
    evidenceMargin: 0,
    correlationGain: 0,
});

/**
 * Estimate how useful a confirmed event would be to the next file-wide reference rebuild.
 * This counts currently overlapping observations that would be realigned; it does not claim
 * that the edit creates the same number of new calendar years.
 */
export const calculateBreadthSuggestionPriority = (
    event: DiagnosisEvent,
    siteData?: RwlSiteData,
): BreadthSuggestionPriority => {
    const topYear = event.rankedYears[0]?.year
        ?? Math.round((event.startYear + event.endYear) / 2);
    const targetData = findTreeData(siteData, event.seriesId);
    const targetYears = measuredYears(targetData);
    const seriesStart = targetYears[0]
        ?? event.seriesRange?.startYear
        ?? event.startYear;
    const seriesEnd = targetYears[targetYears.length - 1]
        ?? event.seriesRange?.endYear
        ?? event.endYear;
    const affectedEndYear = event.eventType === "wholeSeriesMove"
        ? seriesEnd
        : event.eventType === "partialMove"
            ? topYear - 1
            : topYear;
    const fallbackSpan = Math.max(1, seriesEnd - seriesStart + 1);
    const affectedTargetYears = targetYears.length > 0
        ? targetYears.filter((year) => year <= affectedEndYear)
        : [];
    const affectedSpan = Math.max(
        0,
        Math.min(seriesEnd, affectedEndYear) - seriesStart + 1,
    );
    let sharedOverlapYears = 0;
    let weightedReferenceOverlap = 0;

    if (siteData && affectedTargetYears.length > 0) {
        const normalizedTarget = normalizeSeriesId(event.seriesId);
        for (const year of affectedTargetYears) {
            let referenceDepth = 0;
            for (const [seriesId, treeData] of siteData) {
                if (normalizeSeriesId(seriesId) === normalizedTarget) continue;
                if (hasMeasuredRing(treeData.get(year))) referenceDepth += 1;
            }
            if (referenceDepth > 0) sharedOverlapYears += 1;
            weightedReferenceOverlap += Math.min(referenceDepth, 5);
        }
    }

    const reviewOnly = event.reviewOnly === true;
    return {
        reliabilityTier: Math.max(
            0,
            confidenceRank[event.confidenceLevel]
                + (reviewOnly ? 0 : 2),
        ),
        frontierRatio: targetYears.length > 0
            ? affectedTargetYears.length / targetYears.length
            : Math.min(1, affectedSpan / fallbackSpan),
        sharedOverlapYears,
        weightedReferenceOverlap,
        newerEndDistanceYears: event.eventType === "wholeSeriesMove"
            ? 0
            : Math.max(0, seriesEnd - affectedEndYear),
        windowWidth: event.eventType === "wholeSeriesMove"
            ? 0
            : Math.max(1, event.endYear - event.startYear + 1),
        evidenceMargin: Number.isFinite(event.evidence.scoreMargin)
            ? event.evidence.scoreMargin
            : 0,
        correlationGain: event.evidence.correlationGain !== null
            && Number.isFinite(event.evidence.correlationGain)
            ? event.evidence.correlationGain
            : 0,
    };
};

export const getBreadthSuggestionFingerprint = (event: DiagnosisEvent) => (
    [
        normalizeSeriesId(event.seriesId),
        event.eventType,
        event.startYear,
        event.endYear,
        event.rankedYears[0]?.year ?? "none",
        event.shiftYears ?? "none",
    ].join(":")
);

/**
 * A one- or two-year window wobble after another series is repaired is still the same
 * waiting frontier. A distant window (the next event in that core) receives a new fairness
 * order, which is used only after evidence and reference-recovery value tie.
 */
export const isSameBreadthFrontier = (
    previous: BreadthDiagnosisSuggestion | undefined,
    event: DiagnosisEvent,
) => {
    if (!previous
        || previous.seriesId !== event.seriesId
        || previous.eventType !== event.eventType
        || previous.shiftYears !== event.shiftYears) {
        return false;
    }

    const topYear = event.rankedYears[0]?.year
        ?? Math.round((event.startYear + event.endYear) / 2);
    const rangesOverlap = previous.startYear <= event.endYear
        && event.startYear <= previous.endYear;
    return rangesOverlap || Math.abs(previous.topYear - topYear) <= 2;
};

export const createBreadthDiagnosisSuggestion = (
    event: DiagnosisEvent,
    previous: BreadthDiagnosisSuggestion | undefined,
    firstSeenOrder: number,
    firstSeenAt = Date.now(),
    siteData?: RwlSiteData,
): BreadthDiagnosisSuggestion => {
    const preserveWaitingTime = isSameBreadthFrontier(previous, event);
    return {
        fingerprint: getBreadthSuggestionFingerprint(event),
        eventId: event.id,
        seriesId: event.seriesId,
        eventType: event.eventType,
        startYear: event.startYear,
        endYear: event.endYear,
        topYear: event.rankedYears[0]?.year
            ?? Math.round((event.startYear + event.endYear) / 2),
        ...(event.shiftYears === undefined ? {} : { shiftYears: event.shiftYears }),
        confidenceLevel: event.confidenceLevel,
        reviewOnly: event.reviewOnly === true,
        priority: calculateBreadthSuggestionPriority(event, siteData),
        firstSeenAt: preserveWaitingTime && previous ? previous.firstSeenAt : firstSeenAt,
        firstSeenOrder: preserveWaitingTime && previous ? previous.firstSeenOrder : firstSeenOrder,
    };
};

export const sortBreadthDiagnosisSuggestions = (
    suggestions: Iterable<BreadthDiagnosisSuggestion>,
) => [...suggestions].sort((left, right) => {
    const leftPriority = left.priority ?? fallbackPriority(
        left.confidenceLevel,
        left.reviewOnly,
        Math.max(1, left.endYear - left.startYear + 1),
    );
    const rightPriority = right.priority ?? fallbackPriority(
        right.confidenceLevel,
        right.reviewOnly,
        Math.max(1, right.endYear - right.startYear + 1),
    );
    return rightPriority.reliabilityTier - leftPriority.reliabilityTier
        || rightPriority.weightedReferenceOverlap - leftPriority.weightedReferenceOverlap
        || rightPriority.frontierRatio - leftPriority.frontierRatio
        || rightPriority.sharedOverlapYears - leftPriority.sharedOverlapYears
        || leftPriority.newerEndDistanceYears - rightPriority.newerEndDistanceYears
        || leftPriority.windowWidth - rightPriority.windowWidth
        || rightPriority.evidenceMargin - leftPriority.evidenceMargin
        || rightPriority.correlationGain - leftPriority.correlationGain
        || left.firstSeenOrder - right.firstSeenOrder
        || left.firstSeenAt - right.firstSeenAt
        || left.seriesId.localeCompare(right.seriesId);
});

export const getBreadthPriorityLabel = (suggestion: BreadthDiagnosisSuggestion) => {
    const reliability = suggestion.priority.reliabilityTier >= 5
        ? "高可信"
        : suggestion.priority.reliabilityTier >= 3
            ? "较可信"
            : "需复核";
    return suggestion.priority.frontierRatio >= 0.75
        ? `${reliability} · 前沿`
        : reliability;
};

export const getBreadthOperationLabel = (eventType: DiagnosisEventType) => {
    switch (eventType) {
        case "missingRing":
            return "可能缺轮";
        case "falseRing":
            return "可能伪轮";
        case "partialMove":
            return "可能局部移动";
        case "wholeSeriesMove":
            return "可能整体移动";
    }
};
