import type {
    DiagnosisConfidence,
    DiagnosisEvent,
    DiagnosisEventType,
} from "@/features/crossdating/diagnosis";

export type BreadthScanStatus = "idle" | "stale" | "scanning" | "paused" | "complete";

export type BreadthScanPauseReason =
    | "file-load"
    | "save"
    | "cofecha"
    | "selected-diagnosis";

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

/** COFECHA-flagged series lead the scan, while order within each group stays stable. */
export const orderBreadthScanTargets = (
    seriesIds: readonly string[],
    cofechaFlaggedSeriesIds: readonly string[],
): string[] => {
    const flagged = new Set(cofechaFlaggedSeriesIds.map(normalizeSeriesId));
    return [...seriesIds].sort((left, right) => (
        Number(flagged.has(normalizeSeriesId(right)))
        - Number(flagged.has(normalizeSeriesId(left)))
    ));
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
 * waiting frontier. A distant window (the next event in that core) receives a new FIFO
 * order and naturally moves behind suggestions that were already waiting.
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
        firstSeenAt: preserveWaitingTime && previous ? previous.firstSeenAt : firstSeenAt,
        firstSeenOrder: preserveWaitingTime && previous ? previous.firstSeenOrder : firstSeenOrder,
    };
};

export const sortBreadthDiagnosisSuggestions = (
    suggestions: Iterable<BreadthDiagnosisSuggestion>,
) => [...suggestions].sort((left, right) => (
    left.firstSeenOrder - right.firstSeenOrder
    || left.firstSeenAt - right.firstSeenAt
    || left.seriesId.localeCompare(right.seriesId)
));

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
