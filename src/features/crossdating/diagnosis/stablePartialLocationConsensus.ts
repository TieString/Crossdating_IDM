/**
 * Location-only adjudication for a partial move already selected by the stable lag path.
 *
 * The operation and shift are immutable here. Broad path fits can place a transition on a
 * neighbouring plateau, so the final boundary is the robust consensus of four independent
 * location views around that path mode.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import { scoreBoundaryLocalCounterfactual } from "./boundaryLocalCounterfactual";
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

const medianYear = (years: readonly number[]): number => {
    const ordered = [...years].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 1
        ? ordered[middle]!
        : Math.round((ordered[middle - 1]! + ordered[middle]!) / 2);
};

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
    diagnosis: SeriesCoreDiagnosis,
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
        || fixedSideBaselineLag !== 0
        || !event.evidence.algorithmSources.includes(
            "stable_multiscale_bounded_path_frontier",
        )
    ) return event;

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
