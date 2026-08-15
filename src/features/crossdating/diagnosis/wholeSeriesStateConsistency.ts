import type { SeriesCoreDiagnosis } from "./types";

export type WholeSeriesStateConsistency = {
    segmentCount: number;
    shiftSupportCount: number;
    zeroSupportCount: number;
    supportFraction: number;
    weightedSupportFraction: number;
    olderEdgeSupportFraction: number;
    newerEdgeSupportFraction: number;
    oldestLag: number | null;
    newestLag: number | null;
    globalLag: number;
    globalLagMatchesShift: boolean;
};

/**
 * Describe whether a proposed whole-series shift is present at both chronology ends.
 * This is diagnostic evidence only; callers decide how much consistency is required.
 */
export const measureWholeSeriesStateConsistency = (
    diagnosis: Pick<SeriesCoreDiagnosis, "segments" | "globalSlidingMatch">,
    shiftYears: number,
): WholeSeriesStateConsistency => {
    const segments = diagnosis.segments
        .filter((segment) => (
            segment.bestR !== null
            && segment.samplePairs >= 8
        ))
        .slice()
        .sort((left, right) => (
            left.startYear - right.startYear
            || left.endYear - right.endYear
        ));
    const weightFor = (segment: (typeof segments)[number]): number => (
        Math.max(1, segment.samplePairs)
        * Math.max(0.1, segment.confidence)
    );
    const supportsShift = (segment: (typeof segments)[number]): boolean => (
        segment.bestLag === shiftYears
        || (
            diagnosis.globalSlidingMatch.bestGlobalLag === shiftYears
            && segment.wholeSeriesLagProbe?.lag === shiftYears
            && segment.wholeSeriesLagProbe.supportsLag
        )
    );
    const effectiveLag = (segment: (typeof segments)[number]): number => (
        supportsShift(segment) ? shiftYears : segment.bestLag
    );
    const totalWeight = segments.reduce((sum, segment) => sum + weightFor(segment), 0);
    const shiftWeight = segments.reduce((sum, segment) => (
        sum + (supportsShift(segment) ? weightFor(segment) : 0)
    ), 0);
    const edgeCount = Math.min(2, segments.length);
    const edgeSupportFraction = (
        edge: typeof segments,
    ): number => edge.length > 0
        ? edge.filter(supportsShift).length / edge.length
        : 0;
    const shiftSupportCount = segments.filter(supportsShift).length;

    return {
        segmentCount: segments.length,
        shiftSupportCount,
        zeroSupportCount: segments.filter((segment) => effectiveLag(segment) === 0).length,
        supportFraction: segments.length > 0
            ? shiftSupportCount / segments.length
            : 0,
        weightedSupportFraction: totalWeight > 0 ? shiftWeight / totalWeight : 0,
        olderEdgeSupportFraction: edgeSupportFraction(segments.slice(0, edgeCount)),
        newerEdgeSupportFraction: edgeSupportFraction(
            edgeCount > 0 ? segments.slice(-edgeCount) : [],
        ),
        oldestLag: segments[0] ? effectiveLag(segments[0]) : null,
        newestLag: segments.length > 0
            ? effectiveLag(segments[segments.length - 1])
            : null,
        globalLag: diagnosis.globalSlidingMatch.bestGlobalLag,
        globalLagMatchesShift:
            diagnosis.globalSlidingMatch.bestGlobalLag === shiftYears,
    };
};

export const wholeSeriesStateConsistencyNotes = (
    evidence: WholeSeriesStateConsistency,
): string[] => [
    `whole_state_segment_count=${evidence.segmentCount}`,
    `whole_state_shift_support_count=${evidence.shiftSupportCount}`,
    `whole_state_zero_support_count=${evidence.zeroSupportCount}`,
    `whole_state_support_fraction=${evidence.supportFraction.toFixed(6)}`,
    `whole_state_weighted_support_fraction=${evidence.weightedSupportFraction.toFixed(6)}`,
    `whole_state_older_edge_support_fraction=${evidence.olderEdgeSupportFraction.toFixed(6)}`,
    `whole_state_newer_edge_support_fraction=${evidence.newerEdgeSupportFraction.toFixed(6)}`,
    `whole_state_oldest_lag=${evidence.oldestLag ?? "none"}`,
    `whole_state_newest_lag=${evidence.newestLag ?? "none"}`,
    `whole_state_global_lag=${evidence.globalLag}`,
    `whole_state_global_lag_matches_shift=${evidence.globalLagMatchesShift}`,
];

/**
 * Non-terminal whole candidates need either a stable newer-end state or broad independent
 * agreement with the global lag. Terminal COFECHA baselines are validated separately.
 */
export const supportsNonTerminalWholeSeriesCandidate = (
    evidence: WholeSeriesStateConsistency,
): boolean => {
    if (evidence.segmentCount < 3) return false;
    const overlapTruncatedGlobalConsensus = evidence.globalLagMatchesShift
        && evidence.supportFraction >= 0.8
        && evidence.weightedSupportFraction >= 0.96;
    const stableZeroNewerSide = evidence.newestLag === 0
        && evidence.newerEdgeSupportFraction === 0
        && evidence.zeroSupportCount >= 2;
    if (stableZeroNewerSide && !overlapTruncatedGlobalConsensus) return false;
    const stableNewerState = evidence.newerEdgeSupportFraction === 1;
    const broadGlobalConsensus = evidence.globalLagMatchesShift
        && evidence.supportFraction >= 2 / 3
        && evidence.weightedSupportFraction >= 2 / 3;
    const robustSegmentMajority = evidence.segmentCount >= 8
        && evidence.shiftSupportCount >= 5
        && evidence.supportFraction > 0.5
        && evidence.weightedSupportFraction > 0.55;
    return stableNewerState
        || overlapTruncatedGlobalConsensus
        || broadGlobalConsensus
        || robustSegmentMajority;
};

/**
 * A broad whole-series baseline may be executed before unresolved local events. Unlike the
 * permissive non-terminal candidate gate above, this requires agreement from the global match,
 * nearly all weighted segments, and at least one chronology edge. This prevents a bounded lag
 * transition that merely ends at the whole baseline from replacing the baseline operation.
 */
export const supportsDominantWholeSeriesBaseline = (
    evidence: WholeSeriesStateConsistency,
): boolean => evidence.segmentCount >= 3
    && evidence.globalLagMatchesShift
    && evidence.supportFraction >= 0.84
    && evidence.weightedSupportFraction >= 0.88
    && Math.max(
        evidence.olderEdgeSupportFraction,
        evidence.newerEdgeSupportFraction,
    ) >= 0.9;
