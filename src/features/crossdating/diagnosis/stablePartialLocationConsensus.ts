/**
 * Location-only adjudication for a partial move already selected by the stable lag path.
 *
 * The operation and shift are immutable here. Broad path fits can place a transition on a
 * neighbouring plateau, so the final boundary is the robust consensus of four independent
 * location views around that path mode.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import { scoreBoundaryLocalCounterfactual } from "./boundaryLocalCounterfactual";
import {
    preservesStrongBoundedPathMode,
    strongBoundedPathLocation,
} from "./locationAuthority";
import { scoreNegativePartialMoveBoundaries } from "./partialBreakpointRefinement";
import { scorePerReferenceCounterfactualEvidence } from "./perReferenceCounterfactualEvidence";
import type {
    DiagnosisEvent,
    DiagnosisRankedYear,
    SeriesCoreDiagnosis,
} from "./types";

export type StablePartialLocationConsensus = {
    pathYear: number;
    localCorrelationYear: number;
    localStepYear: number;
    referenceVoteYear: number;
    centerYear: number;
};

export type StablePartialRankEdgeShift = -2 | 0 | 2;

export const selectStablePartialRankEdgeShift = (
    rankedYears: readonly DiagnosisRankedYear[],
): StablePartialRankEdgeShift => {
    if (rankedYears.length !== 13) return 0;
    const chronological = [...rankedYears].sort((left, right) => left.year - right.year);
    const olderRank = Math.min(...chronological.slice(0, 2).map(({ rank }) => rank));
    const newerRank = Math.min(...chronological.slice(-2).map(({ rank }) => rank));
    if (olderRank <= 3 && newerRank >= 7) return -2;
    if (newerRank <= 3 && olderRank >= 7) return 2;
    return 0;
};

const medianYear = (years: readonly number[]): number => {
    const ordered = [...years].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 1
        ? ordered[middle]!
        : Math.round((ordered[middle - 1]! + ordered[middle]!) / 2);
};

const noteNumber = (event: DiagnosisEvent, prefix: string): number | null => {
    const note = [...event.evidence.notes].reverse().find((value) => (
        value.startsWith(prefix)
    ));
    const parsed = Number(note?.slice(prefix.length));
    return Number.isFinite(parsed) ? parsed : null;
};

export const allowsNewerUnitChainLocationConsensus = (
    event: DiagnosisEvent,
    proposedStartYear: number,
): boolean => (
    (noteNumber(event, "stable_bounded_path_transition_count=") ?? 0) >= 2
    && event.evidence.notes.includes(
        "stable_bounded_path_all_transitions_partial=false",
    )
    && proposedStartYear > event.endYear
);

export const selectStablePartialLocationConsensus = (
    pathYear: number,
    localCorrelationYear: number,
    localStepYear: number,
    referenceVoteYear: number,
): StablePartialLocationConsensus => ({
    pathYear,
    localCorrelationYear,
    localStepYear,
    referenceVoteYear,
    centerYear: medianYear([
        pathYear,
        localCorrelationYear,
        localStepYear,
        referenceVoteYear,
    ]),
});

const bestLocalYear = <Row extends { year: number }>(
    rows: readonly Row[],
    pathYear: number,
    score: (row: Row) => number,
    radius = 15,
): number | null => rows
    .filter((row) => Math.abs(row.year - pathYear) <= radius)
    .filter((row) => Number.isFinite(score(row)))
    .sort((left, right) => score(right) - score(left) || right.year - left.year)[0]
    ?.year ?? null;

const boundedWindow = (
    centerYear: number,
    diagnosis: Pick<SeriesCoreDiagnosis, "targetRange">,
): { startYear: number; endYear: number } => {
    const requestedWidth = 13;
    const availableWidth = diagnosis.targetRange.endYear
        - diagnosis.targetRange.startYear
        + 1;
    const width = Math.max(1, Math.min(requestedWidth, availableWidth));
    let startYear = centerYear - Math.floor((width - 1) / 2);
    startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(startYear, diagnosis.targetRange.endYear - width + 1),
    );
    return { startYear, endYear: startYear + width - 1 };
};

/**
 * Restores a detached final partial window to the complete lag-state breakpoint that supports
 * the already selected operation. Small local adjustments remain untouched; only a distant
 * downstream rewrite is corrected here.
 */
export const centerDetachedPartialOnStrongBoundedPath = (
    event: DiagnosisEvent,
    diagnosis: Pick<SeriesCoreDiagnosis, "targetRange">,
    minimumDistanceYears = 10,
): DiagnosisEvent => {
    if (event.eventType !== "partialMove") return event;
    const path = strongBoundedPathLocation(event);
    const currentTopYear = event.rankedYears[0]?.year ?? null;
    if (!path
        || path.topYear === null
        || currentTopYear === null
        || Math.abs(path.topYear - currentTopYear) < minimumDistanceYears) {
        return event;
    }
    const window = boundedWindow(path.topYear, diagnosis);
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const maximumScore = Math.max(0, ...event.rankedYears.map(({ score }) => score));
    const minimumScore = Math.min(0, ...event.rankedYears.map(({ score }) => score));
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => window.startYear + index,
    ).map((year) => {
        const existing = prior.get(year);
        return {
            year,
            rank: 0,
            score: year === path.topYear
                ? maximumScore + Math.max(1e-9, Math.abs(maximumScore) * 1e-12)
                : existing?.score ?? minimumScore - 1,
            evidenceTags: Array.from(new Set([...(existing?.evidenceTags ?? []),
                "detached_strong_partial_path_center",
            ])).sort(),
        };
    }).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...event,
        id: `${event.id}-strong-path-center-${path.topYear}`,
        ...window,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "detached_strong_partial_path_center",
            ])).sort(),
            notes: Array.from(new Set([
                ...event.evidence.notes,
                `detached_partial_previous_window=${event.startYear}-${event.endYear}`,
                `detached_partial_previous_top_year=${currentTopYear}`,
                `detached_partial_strong_path_year=${path.topYear}`,
                `detached_partial_center_distance=${Math.abs(
                    path.topYear - currentTopYear,
                )}`,
            ])),
        },
    };
};

const rerank = (
    event: DiagnosisEvent,
    startYear: number,
    endYear: number,
    centerYear: number,
): DiagnosisRankedYear[] => {
    const previous = new Map(event.rankedYears.map((row) => [row.year, row]));
    return Array.from(
        { length: endYear - startYear + 1 },
        (_, index) => startYear + index,
    ).map((year) => {
        const prior = previous.get(year);
        return {
            year,
            rank: 0,
            score: year === centerYear
                ? 2
                : 1 / (1 + Math.abs(year - centerYear))
                    + (prior?.score ?? 0) * 1e-9,
            evidenceTags: Array.from(new Set([
                ...(prior?.evidenceTags ?? []),
                "stable_partial_location_consensus",
            ])).sort(),
        };
    }).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
};

export const refineStablePartialMoveLocation = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    fixedSideBaselineLag = 0,
): DiagnosisEvent => {
    const pathYear = Math.round((event.startYear + event.endYear) / 2);
    if (
        event.eventType !== "partialMove"
        || event.shiftSide !== "older"
        || event.shiftYears === undefined
        || event.shiftYears >= -1
        // The local scorers compare the fixed side with lag zero. A non-zero whole baseline
        // needs its own baseline-aware location views and must retain the upstream window.
        || !event.evidence.algorithmSources.includes(
            "stable_multiscale_bounded_path_frontier",
        )
    ) return event;

    // The stable frontier has already combined the path and the exhaustive operation-year
    // scan. A third location model may add evidence, but must not re-center that joint result.
    if (event.evidence.notes.some((note) => (
        note.startsWith("stable_bounded_path_operation_year=")
    ))) {
        return {
            ...event,
            evidence: {
                ...event.evidence,
                notes: Array.from(new Set([
                    ...event.evidence.notes,
                    "stable_partial_location_retained=joint_operation_year_calibration",
                ])),
            },
        };
    }
    // The local scorers below assume that the fixed side is at lag zero.
    if (fixedSideBaselineLag !== 0) return event;

    const localCorrelationYear = bestLocalYear(
        scoreNegativePartialMoveBoundaries(diagnosis, event.shiftYears),
        pathYear,
        (row) => row.combo61,
    );
    const localStepYear = bestLocalYear(
        scoreBoundaryLocalCounterfactual(diagnosis, event.shiftYears),
        pathYear,
        (row) => row.stepMinimum9,
    );
    const referenceVoteYear = bestLocalYear(
        scorePerReferenceCounterfactualEvidence(
            diagnosis,
            siteData,
            event.shiftYears,
            { baselineLagCenter: fixedSideBaselineLag },
        ),
        pathYear,
        (row) => row.fixedLagStepPeakKernel9,
    );
    if (
        localCorrelationYear === null
        || localStepYear === null
        || referenceVoteYear === null
    ) return event;

    // A maximum at the edge of this deliberately bounded search is a clipped mode, not a
    // localized reference vote. Keep the path vote neutral until a wider locator verifies it.
    const boundedReferenceVoteYear = Math.abs(referenceVoteYear - pathYear) >= 15
        ? pathYear
        : referenceVoteYear;

    const consensus = selectStablePartialLocationConsensus(
        pathYear,
        localCorrelationYear,
        localStepYear,
        boundedReferenceVoteYear,
    );
    const { startYear, endYear } = boundedWindow(consensus.centerYear, diagnosis);
    if (!preservesStrongBoundedPathMode(event, startYear, endYear)
        && !allowsNewerUnitChainLocationConsensus(event, startYear)) {
        return {
            ...event,
            evidence: {
                ...event.evidence,
                notes: Array.from(new Set([
                    ...event.evidence.notes,
                    "stable_partial_location_rejected=detached_from_strong_bounded_path",
                    `stable_partial_location_rejected_window=${startYear}-${endYear}`,
                ])),
            },
        };
    }
    return {
        ...event,
        id: `${event.id}-location-consensus`,
        startYear,
        endYear,
        rankedYears: rerank(event, startYear, endYear, consensus.centerYear),
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "stable_partial_location_consensus",
            ])).sort(),
            locationEvidence: [
                ...(event.evidence.locationEvidence ?? []),
                {
                    source: "stable_partial_location_consensus",
                    startYear,
                    endYear,
                    topYear: consensus.centerYear,
                    referenceCount: diagnosis.master.sourceTrees.length,
                    concentration: Math.max(
                        0,
                        1 - (
                            Math.max(
                                consensus.pathYear,
                                consensus.localCorrelationYear,
                                consensus.localStepYear,
                                consensus.referenceVoteYear,
                            ) - Math.min(
                                consensus.pathYear,
                                consensus.localCorrelationYear,
                                consensus.localStepYear,
                                consensus.referenceVoteYear,
                            )
                        ) / 30,
                    ),
                    remoteMargin: null,
                    calibrated: true,
                },
            ],
            notes: Array.from(new Set([
                ...event.evidence.notes,
                `stable_partial_location_path_year=${consensus.pathYear}`,
                `stable_partial_location_correlation_year=${
                    consensus.localCorrelationYear
                }`,
                `stable_partial_location_step_year=${consensus.localStepYear}`,
                `stable_partial_location_reference_year=${consensus.referenceVoteYear}`,
                ...(boundedReferenceVoteYear === referenceVoteYear
                    ? []
                    : [`stable_partial_location_clipped_reference_year=${referenceVoteYear}`]),
                `stable_partial_location_center=${consensus.centerYear}`,
            ])),
        },
    };
};

export const addStablePartialRankEdgeGuard = (
    event: DiagnosisEvent,
    diagnosis: Pick<SeriesCoreDiagnosis, "targetRange">,
): DiagnosisEvent => {
    if (event.eventType !== "partialMove"
        || strongBoundedPathLocation(event) === null) return event;
    const shift = selectStablePartialRankEdgeShift(event.rankedYears);
    if (shift === 0) return event;
    const width = event.endYear - event.startYear + 1;
    let startYear = event.startYear + shift;
    startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(startYear, diagnosis.targetRange.endYear - width + 1),
    );
    const endYear = startYear + width - 1;
    if ((startYear === event.startYear && endYear === event.endYear)
        || !preservesStrongBoundedPathMode(event, startYear, endYear)) return event;
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const minimumScore = Math.min(...event.rankedYears.map(({ score }) => score));
    const rankedYears = Array.from({ length: width }, (_, index) => {
        const year = startYear + index;
        const existing = prior.get(year);
        return existing ? { ...existing } : {
            year,
            rank: 0,
            score: minimumScore - 1,
            evidenceTags: ["stable_partial_rank_edge_guard"],
        };
    }).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...event,
        id: `${event.id}-rank-edge-${shift > 0 ? "newer" : "older"}`,
        startYear,
        endYear,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "stable_partial_rank_edge_guard",
            ])).sort(),
            notes: Array.from(new Set([
                ...event.evidence.notes,
                `stable_partial_rank_edge_shift=${shift}`,
                `stable_partial_rank_edge_previous_window=${
                    event.startYear
                }-${event.endYear}`,
            ])),
        },
    };
};
