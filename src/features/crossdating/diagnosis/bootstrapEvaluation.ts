/** Pure helpers that keep hidden benchmark truth outside automatic bootstrap control flow. */
import type { RwlSiteData } from "@/features/rwl/types";
import { planDiagnosisEventEdit } from "./eventApply";
import type { DiagnosisEvent } from "./types";

export type BootstrapAutomaticSelection = {
    event: DiagnosisEvent;
    selectedYear: number;
};

const confidenceWeight = (event: DiagnosisEvent): number => (
    event.confidenceLevel === "high" ? 3 : event.confidenceLevel === "medium" ? 2 : 1
);

export const compareBootstrapEvents = (
    left: DiagnosisEvent,
    right: DiagnosisEvent,
): number => (
    confidenceWeight(right) - confidenceWeight(left)
    || (right.evidence.scoreMargin ?? 0) - (left.evidence.scoreMargin ?? 0)
    || right.evidence.score - left.evidence.score
    || (right.rankedYears[0]?.year ?? -Infinity)
        - (left.rankedYears[0]?.year ?? -Infinity)
);

/**
 * Chooses an executable automatic action from diagnosis output alone. Hidden truth is
 * intentionally absent from this interface so it cannot affect selection or application.
 */
export const selectAutomaticBootstrapApplication = (
    events: readonly DiagnosisEvent[],
    siteData: RwlSiteData,
): BootstrapAutomaticSelection | null => {
    const executable = events.flatMap((event) => {
        const selectedYear = event.rankedYears[0]?.year;
        const data = siteData.get(event.seriesId);
        if (selectedYear === undefined || !data || data.size === 0) return [];
        const years = Array.from(data.keys());
        const plan = planDiagnosisEventEdit(
            event,
            selectedYear,
            Math.min(...years),
            Math.max(...years),
        );
        return plan ? [{ event, selectedYear }] : [];
    });
    executable.sort((left, right) => compareBootstrapEvents(left.event, right.event));
    return executable[0] ?? null;
};

/**
 * A calendar year is absolutely unidentifiable when every series spanning that year
 * contains the same hidden missing-ring truth. This helper is evaluation-only.
 */
export const findAbsoluteUnidentifiableTruthYears = (
    originalSite: RwlSiteData,
    truthBySeries: ReadonlyMap<string, readonly number[]>,
): Set<number> => {
    const truthSets = new Map(Array.from(truthBySeries, ([seriesId, years]) => [
        seriesId,
        new Set(years),
    ]));
    const allTruthYears = new Set(Array.from(truthBySeries.values()).flatMap((years) => years));
    const result = new Set<number>();
    allTruthYears.forEach((year) => {
        const overlappingIds = Array.from(originalSite).flatMap(([seriesId, data]) => {
            if (data.size === 0) return [];
            const years = Array.from(data.keys());
            return year >= Math.min(...years) && year <= Math.max(...years)
                ? [seriesId]
                : [];
        });
        if (overlappingIds.length >= 2 && overlappingIds.every((seriesId) => (
            truthSets.get(seriesId)?.has(year) === true
        ))) result.add(year);
    });
    return result;
};
