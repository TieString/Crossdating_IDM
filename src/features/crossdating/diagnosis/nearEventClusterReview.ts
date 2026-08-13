import type {
    DiagnosisEvent,
    DiagnosisEventType,
    DiagnosisNearEventClusterReview,
    DiagnosisReviewEventCheckpoint,
} from "./types";

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
): { startYear: number; endYear: number } | null => {
    const first = evidenceYears[0];
    const last = evidenceYears[evidenceYears.length - 1];
    const span = last - first + 1;
    const width = ALLOWED_WINDOW_WIDTHS.find((candidate) => candidate >= span);
    if (!width) return null;
    const rangeStart = event.seriesRange?.startYear ?? first;
    const rangeEnd = event.seriesRange?.endYear ?? last;
    if (rangeEnd - rangeStart + 1 < width) return null;
    const centered = Math.round((first + last - width + 1) / 2);
    const minimumStart = Math.max(rangeStart, last - width + 1);
    const maximumStart = Math.min(first, rangeEnd - width + 1);
    const startYear = Math.max(minimumStart, Math.min(centered, maximumStart));
    return { startYear, endYear: startYear + width - 1 };
};

export const attachNearEventClusterReview = (
    checkpoints: readonly DiagnosisReviewEventCheckpoint[],
    preferredEvent: DiagnosisEvent | null,
): DiagnosisEvent | null => {
    const finalEvents = checkpoints.filter((checkpoint) => (
        checkpoint.stage === "final" && checkpoint.authority !== "supplemental"
    )).flatMap(({ event }) => evidenceForEvent(event));
    const chain = finalTransitionChain(checkpoints);
    const candidates = [
        ...(preferredEvent ? evidenceForEvent(preferredEvent) : []),
        ...finalEvents,
        ...(chain ? [chain] : []),
    ].sort((left, right) => (
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
