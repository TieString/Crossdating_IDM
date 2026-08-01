/**
 * Adds a small, explicitly labelled review margin after all event decisions and
 * rankings are complete. The margin improves manual review coverage without
 * changing whether an event is emitted or which year remains the primary choice.
 */
import type {
    DiagnosisEvent,
    DiagnosisEventLocationAlternative,
    DiagnosisRankedYear,
    YearRange,
} from "./types";

export const REVIEW_EDGE_YEAR_TAG = "review_edge_year";
export const REVIEW_TOP_EDGE_GUARD_YEARS = 2;
export const REVIEW_TOP_EDGE_EXTRA_PADDING_YEARS = 0;

type ReviewWindow = {
    startYear: number;
    endYear: number;
    reviewCoreRange?: YearRange;
    rankedYears: DiagnosisRankedYear[];
};

const paddedRankedYears = (
    window: ReviewWindow,
    startYear: number,
    endYear: number,
): DiagnosisRankedYear[] => {
    const orderedCore = [...window.rankedYears]
        .sort((left, right) => left.rank - right.rank || right.year - left.year);
    const existingYears = new Set(orderedCore.map((row) => row.year));
    const topYear = orderedCore[0]?.year
        ?? Math.round((window.startYear + window.endYear) / 2);
    const minimumScore = orderedCore.length > 0
        ? Math.min(...orderedCore.map((row) => row.score))
        : 0;
    const edgeYears = Array.from(
        { length: endYear - startYear + 1 },
        (_, index) => startYear + index,
    )
        .filter((year) => !existingYears.has(year))
        .sort((left, right) => (
            Math.abs(left - topYear) - Math.abs(right - topYear)
            || right - left
        ));
    const edgeRows = edgeYears.map((year, index) => ({
        year,
        rank: orderedCore.length + index + 1,
        score: minimumScore - index - 1,
        evidenceTags: [REVIEW_EDGE_YEAR_TAG],
    }));
    return [...orderedCore, ...edgeRows].map((row, index) => ({
        ...row,
        rank: index + 1,
    }));
};

const padReviewWindow = <T extends ReviewWindow>(
    window: T,
    targetRange: YearRange,
    paddingYears: number,
    directionalExtraPaddingYears: number,
): T => {
    if (paddingYears <= 0 || window.reviewCoreRange) return window;
    const topYear = [...window.rankedYears]
        .sort((left, right) => left.rank - right.rank || right.year - left.year)[0]?.year;
    const olderExtra = topYear !== undefined
        && topYear - window.startYear <= REVIEW_TOP_EDGE_GUARD_YEARS
        ? directionalExtraPaddingYears
        : 0;
    const newerExtra = topYear !== undefined
        && window.endYear - topYear <= REVIEW_TOP_EDGE_GUARD_YEARS
        ? directionalExtraPaddingYears
        : 0;
    const startYear = Math.max(
        targetRange.startYear,
        window.startYear - paddingYears - olderExtra,
    );
    const endYear = Math.min(
        targetRange.endYear,
        window.endYear + paddingYears + newerExtra,
    );
    if (startYear === window.startYear && endYear === window.endYear) {
        return window;
    }
    return {
        ...window,
        startYear,
        endYear,
        reviewCoreRange: {
            startYear: window.startYear,
            endYear: window.endYear,
        },
        rankedYears: paddedRankedYears(window, startYear, endYear),
    };
};

const padLocationAlternative = (
    alternative: DiagnosisEventLocationAlternative,
    targetRange: YearRange,
    paddingYears: number,
    directionalExtraPaddingYears: number,
): DiagnosisEventLocationAlternative => (
    padReviewWindow(
        alternative,
        targetRange,
        paddingYears,
        directionalExtraPaddingYears,
    )
);

const compactVisibleLocationAlternatives = (
    primary: Pick<DiagnosisEvent, "startYear" | "endYear">,
    alternatives: DiagnosisEventLocationAlternative[],
): DiagnosisEventLocationAlternative[] => {
    const coveredYears = new Set<number>();
    for (let year = primary.startYear; year <= primary.endYear; year += 1) {
        coveredYears.add(year);
    }
    const compacted: DiagnosisEventLocationAlternative[] = [];
    for (const alternative of [...alternatives].sort((left, right) => (
        left.rank - right.rank
    ))) {
        let addsVisibleYear = false;
        for (
            let year = alternative.startYear;
            year <= alternative.endYear;
            year += 1
        ) {
            if (!coveredYears.has(year)) addsVisibleYear = true;
        }
        if (!addsVisibleYear) continue;
        for (
            let year = alternative.startYear;
            year <= alternative.endYear;
            year += 1
        ) {
            coveredYears.add(year);
        }
        compacted.push({
            ...alternative,
            rank: compacted.length + 1,
        });
    }
    return compacted;
};

const padEvent = (
    event: DiagnosisEvent,
    targetRange: YearRange,
    paddingYears: number,
    directionalExtraPaddingYears: number,
): DiagnosisEvent => {
    const padded = event.eventType === "wholeSeriesMove"
        ? event
        : padReviewWindow(
            event,
            targetRange,
            paddingYears,
            directionalExtraPaddingYears,
        );
    const paddedLocationAlternatives = event.locationAlternatives?.map(
        (alternative) => padLocationAlternative(
            alternative,
            targetRange,
            paddingYears,
            directionalExtraPaddingYears,
        ),
    );
    const locationAlternatives = paddedLocationAlternatives
        ? compactVisibleLocationAlternatives(padded, paddedLocationAlternatives)
        : undefined;
    const operationAlternatives = event.operationAlternatives?.map((alternative) => (
        padEvent(
            alternative,
            targetRange,
            paddingYears,
            directionalExtraPaddingYears,
        )
    ));
    if (padded === event
        && locationAlternatives === undefined
        && operationAlternatives === undefined) {
        return event;
    }
    const wasPadded = padded !== event;
    const olderPadding = wasPadded ? event.startYear - padded.startYear : 0;
    const newerPadding = wasPadded ? padded.endYear - event.endYear : 0;
    const directionalExtra = [
        ...(olderPadding > paddingYears ? ["older"] : []),
        ...(newerPadding > paddingYears ? ["newer"] : []),
    ];
    const notesWithoutLocations = padded.evidence.notes.filter((note) => (
        !/^location_option_\d+=/.test(note)
    ));
    return {
        ...padded,
        ...(locationAlternatives !== undefined ? { locationAlternatives } : {}),
        ...(operationAlternatives ? { operationAlternatives } : {}),
        ...(wasPadded || locationAlternatives !== undefined ? {
            evidence: {
                ...padded.evidence,
                notes: Array.from(new Set([
                    ...notesWithoutLocations,
                    ...(wasPadded ? [
                        `review_window_edge_padding=${paddingYears}`,
                        ...(directionalExtra.length > 0
                            ? [`review_window_directional_extra=${directionalExtra.join(",")}`]
                            : []),
                        `review_core_range=${event.startYear}-${event.endYear}`,
                    ] : []),
                    ...(locationAlternatives?.map((location) => (
                        `location_option_${location.rank}=`
                        + `${location.startYear}-${location.endYear}`
                    )) ?? []),
                ])),
            },
        } : {}),
    };
};

export const addDiagnosisReviewWindowPadding = (
    events: DiagnosisEvent[],
    targetRange: YearRange,
    paddingYears = 1,
    directionalExtraPaddingYears = REVIEW_TOP_EDGE_EXTRA_PADDING_YEARS,
): DiagnosisEvent[] => {
    const safePadding = Number.isFinite(paddingYears)
        ? Math.max(0, Math.floor(paddingYears))
        : 0;
    const safeDirectionalExtraPadding = Number.isFinite(directionalExtraPaddingYears)
        ? Math.max(0, Math.floor(directionalExtraPaddingYears))
        : 0;
    if (safePadding === 0) return events;
    return events.map((event) => padEvent(
        event,
        targetRange,
        safePadding,
        safeDirectionalExtraPadding,
    ));
};
