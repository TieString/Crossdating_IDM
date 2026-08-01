/** Conservative missing-ring reranking when a nearby explicit zero distorts a window edge. */
import type { RwlTreeData } from "@/features/rwl/types";
import type {
    DiagnosisEvent,
    DiagnosisEventLocationAlternative,
    DiagnosisRankedYear,
} from "./types";

export const EXPLICIT_ZERO_MIDPOINT_GUARD_SOURCE = "explicit_zero_midpoint_guard";
const MINIMUM_TOP_DISTANCE_FROM_MIDPOINT = 3;
const MAXIMUM_ZERO_DISTANCE_FROM_MIDPOINT = 10;

type RankableWindow = {
    startYear: number;
    endYear: number;
    rankedYears: DiagnosisRankedYear[];
};

type RerankedWindow<T extends RankableWindow> = {
    value: T;
    changed: boolean;
    previousTopYear: number | null;
    selectedYear: number | null;
    nearbyZeroYear: number | null;
};

const explicitZeroYears = (treeData: RwlTreeData | undefined): number[] => (
    Array.from(treeData?.entries() ?? [])
        .filter(([, value]) => value === 0)
        .map(([year]) => year)
        .sort((left, right) => left - right)
);

const nearestYear = (years: number[], target: number): number | null => (
    years.reduce<number | null>((nearest, year) => (
        nearest === null || Math.abs(year - target) < Math.abs(nearest - target)
            ? year
            : nearest
    ), null)
);

const rerankWindow = <T extends RankableWindow>(
    window: T,
    zeroYears: number[],
): RerankedWindow<T> => {
    const ordered = [...window.rankedYears]
        .sort((left, right) => left.rank - right.rank || right.year - left.year);
    const previousTopYear = ordered[0]?.year ?? null;
    const midpoint = Math.round((window.startYear + window.endYear) / 2);
    const midpointRow = ordered.find((row) => row.year === midpoint);
    const nearbyZeroYear = nearestYear(zeroYears, midpoint);
    if (previousTopYear === null
        || !midpointRow
        || Math.abs(previousTopYear - midpoint) < MINIMUM_TOP_DISTANCE_FROM_MIDPOINT
        || nearbyZeroYear === null
        || Math.abs(nearbyZeroYear - midpoint) > MAXIMUM_ZERO_DISTANCE_FROM_MIDPOINT
        || Math.abs(nearbyZeroYear - midpoint)
            <= Math.abs(nearbyZeroYear - previousTopYear)) {
        return {
            value: window,
            changed: false,
            previousTopYear,
            selectedYear: null,
            nearbyZeroYear,
        };
    }

    const maximumScore = Math.max(...ordered.map((row) => row.score));
    const promoted = {
        ...midpointRow,
        score: maximumScore + Math.max(1e-6, Math.abs(maximumScore) * 1e-6),
        evidenceTags: Array.from(new Set([
            ...midpointRow.evidenceTags,
            EXPLICIT_ZERO_MIDPOINT_GUARD_SOURCE,
        ])).sort(),
    };
    const rankedYears = [
        promoted,
        ...ordered.filter((row) => row.year !== midpoint),
    ].map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        value: { ...window, rankedYears },
        changed: true,
        previousTopYear,
        selectedYear: midpoint,
        nearbyZeroYear,
    };
};

const rerankEvent = (
    event: DiagnosisEvent,
    zeroYears: number[],
): DiagnosisEvent => {
    const operationAlternatives = event.operationAlternatives?.map((alternative) => (
        rerankEvent(alternative, zeroYears)
    ));
    if (event.eventType !== "missingRing") {
        return operationAlternatives
            ? { ...event, operationAlternatives }
            : event;
    }

    const primary = rerankWindow(event, zeroYears);
    let changedLocationCount = 0;
    const locationAlternatives = event.locationAlternatives?.map((location) => {
        const result = rerankWindow(location, zeroYears);
        if (result.changed) changedLocationCount += 1;
        return result.value as DiagnosisEventLocationAlternative;
    });
    const changed = primary.changed || changedLocationCount > 0;
    if (!changed && !operationAlternatives) return event;

    return {
        ...primary.value,
        ...(locationAlternatives ? { locationAlternatives } : {}),
        ...(operationAlternatives ? { operationAlternatives } : {}),
        ...(changed ? {
            evidence: {
                ...event.evidence,
                algorithmSources: Array.from(new Set([
                    ...event.evidence.algorithmSources,
                    EXPLICIT_ZERO_MIDPOINT_GUARD_SOURCE,
                ])).sort(),
                notes: Array.from(new Set([
                    ...event.evidence.notes,
                    "year_ranking=explicit_zero_midpoint_guard",
                    ...(primary.changed ? [
                        `explicit_zero_previous_top_year=${primary.previousTopYear}`,
                        `explicit_zero_selected_year=${primary.selectedYear}`,
                        `explicit_zero_nearby_year=${primary.nearbyZeroYear}`,
                    ] : []),
                    ...(changedLocationCount > 0
                        ? [`explicit_zero_reranked_locations=${changedLocationCount}`]
                        : []),
                ])),
            },
        } : {}),
    };
};

export const rerankMissingEventsNearExplicitZeros = (
    events: DiagnosisEvent[],
    treeData: RwlTreeData | undefined,
): DiagnosisEvent[] => {
    const zeroYears = explicitZeroYears(treeData);
    if (zeroYears.length === 0) return events;
    return events.map((event) => rerankEvent(event, zeroYears));
};
