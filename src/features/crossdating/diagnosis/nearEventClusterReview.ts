import type {
    DiagnosisEvent,
    DiagnosisEventType,
    DiagnosisNearEventClusterReview,
    DiagnosisReviewEventCheckpoint,
} from "./types";
import type { StableNearLagCluster } from "./nearLagCluster";

const ALLOWED_WINDOW_WIDTHS = [5, 7, 9, 13] as const;
const MAXIMUM_CLUSTER_SPAN_YEARS = 13;

type ClusterEvidence = DiagnosisNearEventClusterReview & {
    event: DiagnosisEvent;
    windowEvidenceYears?: number[];
};

const topYear = (event: DiagnosisEvent): number | null => (
    [...event.rankedYears].sort((left, right) => (
        left.rank - right.rank || right.score - left.score || right.year - left.year
    ))[0]?.year ?? null
);

const noteValue = (event: DiagnosisEvent, key: string): string | null => {
    const prefix = `${key}=`;
    return [...event.evidence.notes].reverse()
        .find((note) => note.startsWith(prefix))
        ?.slice(prefix.length) ?? null;
};

const noteNumber = (event: DiagnosisEvent, key: string): number | null => {
    const value = Number(noteValue(event, key));
    return Number.isFinite(value) ? value : null;
};

const noteYears = (event: DiagnosisEvent, key: string): number[] => (
    (noteValue(event, key) ?? "")
        .split(",")
        .map(Number)
        .filter((year) => Number.isInteger(year))
);

const uniqueSortedYears = (years: readonly number[]): number[] => (
    [...new Set(years)].sort((left, right) => left - right)
);

const isBoundedCluster = (years: readonly number[]): boolean => years.length >= 2
    && years[years.length - 1] - years[0] + 1 <= MAXIMUM_CLUSTER_SPAN_YEARS;

const operationShift = (event: DiagnosisEvent): number | null => (
    event.eventType === "missingRing"
        ? -1
        : event.eventType === "falseRing"
            ? 1
            : event.eventType === "partialMove"
                ? event.shiftYears ?? null
                : null
);

const isExactLocalTransition = (event: DiagnosisEvent): boolean => {
    const shift = operationShift(event);
    return shift !== null
        && event.evidence.lagBefore !== null
        && event.evidence.lagAfter !== null
        && event.evidence.lagBefore - event.evidence.lagAfter === shift;
};

const evidenceForEvent = (event: DiagnosisEvent): ClusterEvidence[] => {
    if (event.nearEventCluster) {
        return [{
            ...event.nearEventCluster,
            event,
            windowEvidenceYears: [event.startYear, event.endYear],
        }];
    }
    if (event.eventType === "wholeSeriesMove" || event.evidence.samplePairs < 30) return [];
    const results: ClusterEvidence[] = [];
    const add = (
        years: readonly number[],
        eventCount: number,
        operationTypes: readonly DiagnosisEventType[],
        source: DiagnosisNearEventClusterReview["source"],
        windowEvidenceYears?: readonly number[],
    ): void => {
        const normalized = uniqueSortedYears(years);
        if (!isBoundedCluster(normalized)) return;
        const normalizedWindowYears = uniqueSortedYears(windowEvidenceYears ?? years);
        if (!isBoundedCluster(normalizedWindowYears)) return;
        results.push({
            kind: "nearEventCluster",
            event,
            eventCount: Math.max(eventCount, normalized.length),
            evidenceYears: normalized,
            operationTypes: [...new Set(operationTypes)].sort(),
            source,
            ...(windowEvidenceYears
                ? { windowEvidenceYears: normalizedWindowYears }
                : {}),
        });
    };

    const missingYears = noteYears(event, "sequential_missing_unit_event_years");
    if (event.evidence.algorithmSources.includes("sequential_missing_staircase_head")) {
        add(missingYears, missingYears.length, ["missingRing"], "sequentialUnitPath");
    }
    const falseYears = noteYears(event, "sequential_false_delete_years");
    if (event.evidence.algorithmSources.includes("sequential_false_staircase_head")) {
        add(falseYears, falseYears.length, ["falseRing"], "sequentialUnitPath");
    }
    const explicitMissingYears = noteYears(event, "explicit_staircase_missing_years");
    if (event.eventType === "missingRing"
        && explicitMissingYears.length >= 2
        && event.evidence.algorithmSources.includes(
            "compressed_missing_staircase_projection",
        )
        && event.evidence.algorithmSources.includes(
            "explicit_partial_vs_missing_staircase",
        )) {
        add(
            explicitMissingYears,
            explicitMissingYears.length,
            ["missingRing"],
            "explicitUnitStaircase",
            [Math.min(...explicitMissingYears) - 1, ...explicitMissingYears],
        );
    }

    const mixedOlder = noteNumber(event, "completed_mixed_older_boundary");
    const mixedNewer = noteNumber(event, "completed_mixed_newer_boundary");
    const mixedSourceAnchored = noteValue(
        event,
        "completed_mixed_source_segment_anchored",
    ) === "true";
    const exactBoundedAggregate = event.evidence.algorithmSources.includes(
        "bounded_complete_lag_path",
    ) && event.evidence.lagBefore !== null
        && event.evidence.lagAfter !== null
        && event.evidence.lagBefore - event.evidence.lagAfter
            === operationShift(event);
    if (mixedOlder !== null && mixedNewer !== null && event.evidence.algorithmSources.some(
        (source) => source === "completed_partial_missing_composition"
            || source === "completed_partial_false_composition",
    ) && (mixedSourceAnchored || !exactBoundedAggregate)) {
        const unitType = noteValue(event, "completed_mixed_unit_type") === "falseRing"
            ? "falseRing" as const
            : "missingRing" as const;
        add(
            [mixedOlder, mixedNewer],
            2,
            ["partialMove", unitType],
            "completedMixedCorrection",
        );
    }

    const componentPairs = [
        [
            noteNumber(event, "completed_partial_pair_older_year"),
            noteNumber(event, "cumulative_partial_component_year"),
        ],
        [
            noteNumber(event, "cumulative_unit_pair_partial_year"),
            noteNumber(event, "cumulative_unit_pair_unit_year"),
        ],
    ];
    componentPairs.forEach((years) => {
        if (years.every((year): year is number => year !== null)) {
            add(years, 2, [event.eventType, "partialMove"], "cumulativeComponentPath");
        }
    });
    return results;
};

const finalTransitionChain = (
    checkpoints: readonly DiagnosisReviewEventCheckpoint[],
): ClusterEvidence | null => {
    const finals = checkpoints.filter((checkpoint) => (
        checkpoint.stage === "final"
        && checkpoint.authority !== "supplemental"
        && checkpoint.event.eventType !== "wholeSeriesMove"
        && isExactLocalTransition(checkpoint.event)
    ));
    const byTransition = new Map<string, DiagnosisEvent>();
    finals.forEach(({ event }) => {
        const year = topYear(event);
        if (year === null) return;
        const key = [event.evidence.lagBefore, event.evidence.lagAfter, year].join(":");
        byTransition.set(key, event);
    });
    const events = [...byTransition.values()];
    const years = uniqueSortedYears(events.flatMap((event) => {
        const year = topYear(event);
        return year === null ? [] : [year];
    }));
    if (!isBoundedCluster(years) || events.length < 2) return null;
    const event = [...events].sort((left, right) => (
        (topYear(right) ?? -Infinity) - (topYear(left) ?? -Infinity)
    ))[0];
    return {
        kind: "nearEventCluster",
        event,
        eventCount: events.length,
        evidenceYears: years,
        operationTypes: [...new Set(events.map((candidate) => candidate.eventType))].sort(),
        source: "selectedFinalTransitionChain",
    };
};

const clusterWindow = (
    evidenceYears: readonly number[],
    event: DiagnosisEvent,
    minimumWidth = 5,
): { startYear: number; endYear: number } | null => {
    const first = evidenceYears[0];
    const last = evidenceYears[evidenceYears.length - 1];
    const span = last - first + 1;
    const width = ALLOWED_WINDOW_WIDTHS.find((candidate) => (
        candidate >= span && candidate >= minimumWidth
    ));
    if (!width) return null;
    const rangeStart = event.seriesRange?.startYear ?? first;
    const rangeEnd = event.seriesRange?.endYear ?? last;
    if (rangeEnd - rangeStart + 1 < width) return null;
    const centered = Math.floor((first + last - width + 1) / 2);
    const minimumStart = Math.max(rangeStart, last - width + 1);
    const maximumStart = Math.min(first, rangeEnd - width + 1);
    const startYear = Math.max(minimumStart, Math.min(centered, maximumStart));
    return { startYear, endYear: startYear + width - 1 };
};

export const createNearLagClusterReviewEvent = (
    cluster: StableNearLagCluster,
    seriesRange: { startYear: number; endYear: number },
): DiagnosisEvent | null => {
    const evidenceStart = cluster.evidenceYears[0];
    const evidenceEnd = cluster.evidenceYears[cluster.evidenceYears.length - 1];
    if (evidenceStart === undefined || evidenceEnd === undefined) return null;
    const width = 13;
    if (seriesRange.endYear - seriesRange.startYear + 1 < width) return null;
    // Half-year ties lean older because prior window audits showed a systematic newer bias.
    const centered = Math.floor((evidenceStart + evidenceEnd - width + 1) / 2);
    const minimumStart = Math.max(seriesRange.startYear, evidenceEnd - width + 1);
    const maximumStart = Math.min(evidenceStart, seriesRange.endYear - width + 1);
    const startYear = Math.max(minimumStart, Math.min(centered, maximumStart));
    const endYear = startYear + width - 1;
    const centerYear = Math.round((evidenceStart + evidenceEnd) / 2);
    const representative = cluster.representative;
    return {
        ...representative,
        id: `${representative.id}-stable-near-cluster-${startYear}-${endYear}`,
        startYear,
        endYear,
        reviewCoreRange: { startYear, endYear },
        rankedYears: Array.from({ length: width }, (_, index) => {
            const year = startYear + index;
            return {
                year,
                score: -Math.abs(year - centerYear),
                rank: 0,
                evidenceTags: ["stable_near_lag_cluster_path"],
            };
        }).sort((left, right) => (
            right.score - left.score || right.year - left.year
        )).map((row, index) => ({ ...row, rank: index + 1 })),
        reviewOnly: true,
        nearEventCluster: {
            kind: "nearEventCluster",
            eventCount: cluster.eventCount,
            evidenceYears: [...cluster.evidenceYears],
            operationTypes: [...cluster.operationTypes],
            source: "stableLocalLagPath",
        },
        seriesRange: { ...seriesRange },
        evidence: {
            ...representative.evidence,
            algorithmSources: Array.from(new Set([
                ...representative.evidence.algorithmSources,
                "stable_near_lag_cluster_path",
                "near_event_cluster_review",
            ])).sort(),
            notes: Array.from(new Set([
                ...representative.evidence.notes,
                `near_event_cluster_count=${cluster.eventCount}`,
                `near_event_cluster_years=${cluster.evidenceYears.join(",")}`,
                "near_event_cluster_source=stableLocalLagPath",
                `near_event_cluster_maximum_year_drift=${cluster.maximumYearDrift}`,
                "near_event_cluster_non_executable=true",
            ])),
        },
    };
};

const clusterMatchesPreferredMode = (
    cluster: ClusterEvidence,
    preferredEvent: DiagnosisEvent | null,
): boolean => {
    if (!preferredEvent || cluster.event.id === preferredEvent.id) return true;
    const evidenceYears = cluster.windowEvidenceYears ?? cluster.evidenceYears;
    const evidenceStart = evidenceYears[0];
    const evidenceEnd = evidenceYears[evidenceYears.length - 1];
    return Math.max(evidenceStart, preferredEvent.startYear)
        <= Math.min(evidenceEnd, preferredEvent.endYear)
        || Math.max(cluster.event.startYear, preferredEvent.startYear)
            <= Math.min(cluster.event.endYear, preferredEvent.endYear);
};

export const attachNearEventClusterReview = (
    checkpoints: readonly DiagnosisReviewEventCheckpoint[],
    preferredEvent: DiagnosisEvent | null,
): DiagnosisEvent | null => {
    const finalEvents = checkpoints.filter((checkpoint) => (
        checkpoint.stage === "final"
        && (checkpoint.authority !== "supplemental" || checkpoint.event.nearEventCluster)
    )).flatMap(({ event }) => evidenceForEvent(event));
    const chain = finalTransitionChain(checkpoints);
    const candidates = [
        ...(preferredEvent ? evidenceForEvent(preferredEvent) : []),
        ...finalEvents,
        ...(chain ? [chain] : []),
    ].filter((candidate) => clusterMatchesPreferredMode(
        candidate,
        preferredEvent,
    )).sort((left, right) => (
        right.eventCount - left.eventCount
        || right.evidenceYears.length - left.evidenceYears.length
        || (topYear(right.event) ?? -Infinity) - (topYear(left.event) ?? -Infinity)
    ));
    const selected = candidates[0];
    if (!selected) return preferredEvent;
    const base = preferredEvent ?? selected.event;
    const window = clusterWindow(
        selected.windowEvidenceYears ?? selected.evidenceYears,
        base,
        selected.source === "sequentialUnitPath"
            ? Math.min(13, selected.evidenceYears.length >= 2 ? 9 : 5)
            : selected.source === "explicitUnitStaircase"
                ? 9
                : 13,
    );
    if (!window) return preferredEvent;
    return {
        ...base,
        id: `${base.id}-near-event-cluster-${window.startYear}-${window.endYear}`,
        ...window,
        reviewCoreRange: { ...window },
        reviewOnly: true,
        nearEventCluster: {
            kind: selected.kind,
            eventCount: selected.eventCount,
            evidenceYears: [...selected.evidenceYears],
            operationTypes: [...selected.operationTypes],
            source: selected.source,
        },
        evidence: {
            ...base.evidence,
            algorithmSources: Array.from(new Set([
                ...base.evidence.algorithmSources,
                "near_event_cluster_review",
            ])).sort(),
            notes: Array.from(new Set([
                ...base.evidence.notes,
                `near_event_cluster_count=${selected.eventCount}`,
                `near_event_cluster_years=${selected.evidenceYears.join(",")}`,
                `near_event_cluster_source=${selected.source}`,
                "near_event_cluster_non_executable=true",
            ])),
        },
    };
};
