import type { FalseRingCoarseCounterfactualRow } from "./falseRingCoarseCounterfactual";

type Window = {
    startYear: number;
    endYear: number;
};

export type FalseRingPhysicalRecenterResult = {
    centerYear: number;
    window: Window;
    mergeAdvantage: number;
    remoteMargin: number;
};

export type FalseRingDirectConsensusRecenterResult = {
    centerYear: number;
    window: Window;
    candidateYear: number;
    shiftYears: -2 | -1 | 1 | 2;
    consensusCount: number;
    anchorCount: number;
};

const MERGE_ADVANTAGE_THRESHOLD = 0.04;
const REMOTE_MARGIN_THRESHOLD = 0.08;
const REMOTE_RADIUS_YEARS = 6;

/**
 * Recenter only when merging the deleted width into the older neighbour produces
 * a distinct physical peak outside the current window. This represents a measured
 * ring that was split into two adjacent measurements, not a generic correlation peak.
 */
export const selectFalseRingMergeOlderRecenter = (
    rows: readonly FalseRingCoarseCounterfactualRow[],
    currentWindow: Window,
): FalseRingPhysicalRecenterResult | null => {
    const scored = rows.flatMap((row) => {
        const mergeScore = row.profiles.falseMergeOlderDifferenceMasterHuber31;
        const directScore = row.profiles.differenceMasterHuber31;
        return mergeScore === undefined
            || !Number.isFinite(mergeScore)
            || !Number.isFinite(directScore)
            ? []
            : [{ year: row.year, mergeScore, directScore }];
    }).sort((left, right) => (
        right.mergeScore - left.mergeScore || right.year - left.year
    ));
    const selected = scored[0];
    if (!selected) return null;
    if (
        selected.year >= currentWindow.startYear
        && selected.year <= currentWindow.endYear
    ) return null;
    const remote = scored.find((row) => (
        Math.abs(row.year - selected.year) > REMOTE_RADIUS_YEARS
    ));
    if (!remote) return null;
    const mergeAdvantage = selected.mergeScore - selected.directScore;
    const remoteMargin = selected.mergeScore - remote.mergeScore;
    if (
        mergeAdvantage < MERGE_ADVANTAGE_THRESHOLD
        || remoteMargin < REMOTE_MARGIN_THRESHOLD
    ) return null;
    const width = currentWindow.endYear - currentWindow.startYear + 1;
    const half = Math.floor(width / 2);
    return {
        centerYear: selected.year,
        window: {
            startYear: selected.year - half,
            endYear: selected.year + half,
        },
        mergeAdvantage,
        remoteMargin,
    };
};

type DirectProfile = {
    name:
        | "differenceMasterR31"
        | "differenceMasterR21"
        | "differenceMasterHuber21"
        | "differenceReferenceWeightedR21"
        | "differenceReferenceWeightedR31"
        | "whitenedMasterR31";
    radius: 0 | 1 | 2;
    yearAdjustment: 0 | 1;
};

const DIRECT_PROFILES: readonly DirectProfile[] = [
    { name: "differenceMasterR31", radius: 1, yearAdjustment: 1 },
    { name: "differenceMasterR21", radius: 0, yearAdjustment: 0 },
    { name: "differenceMasterHuber21", radius: 2, yearAdjustment: 0 },
    { name: "differenceReferenceWeightedR21", radius: 2, yearAdjustment: 0 },
    { name: "differenceReferenceWeightedR31", radius: 2, yearAdjustment: 0 },
    { name: "whitenedMasterR31", radius: 1, yearAdjustment: 1 },
];

const peakYear = (
    rows: readonly FalseRingCoarseCounterfactualRow[],
    profile: DirectProfile,
): number | null => {
    const ordered = [...rows].sort((left, right) => left.year - right.year);
    const values = ordered.map((row) => row.profiles[profile.name]);
    if (
        values.length === 0
        || values.some((value) => value === undefined || !Number.isFinite(value))
    ) return null;
    const scores = (values as number[]).map((_, index) => {
        const start = Math.max(0, index - profile.radius);
        const end = Math.min(values.length - 1, index + profile.radius);
        let sum = 0;
        for (let cursor = start; cursor <= end; cursor += 1) {
            sum += values[cursor] as number;
        }
        return sum / (end - start + 1);
    });
    const selectedIndex = scores.reduce((best, score, index) => (
        score > (scores[best] ?? Number.NEGATIVE_INFINITY)
        || (
            score === scores[best]
            && (ordered[index]?.year ?? 0) > (ordered[best]?.year ?? 0)
        ) ? index : best
    ), 0);
    return (ordered[selectedIndex]?.year ?? 0) + profile.yearAdjustment;
};

/** Move an edge-adjacent window by at most two years when six direct deletions agree. */
export const selectFalseRingDirectConsensusRecenter = (
    rows: readonly FalseRingCoarseCounterfactualRow[],
    currentWindow: Window,
    anchors: readonly (number | undefined)[],
): FalseRingDirectConsensusRecenterResult | null => {
    const predictions = DIRECT_PROFILES.map((profile) => peakYear(rows, profile));
    if (predictions.some((year) => year === null)) return null;
    const candidateYear = predictions[4] as number;
    const centerYear = Math.round(
        (currentWindow.startYear + currentWindow.endYear) / 2,
    );
    const radius = Math.floor(
        (currentWindow.endYear - currentWindow.startYear) / 2,
    );
    const distance = Math.abs(candidateYear - centerYear);
    const consensusCount = (predictions as number[]).filter(
        (year) => Math.abs(year - candidateYear) <= 2,
    ).length;
    const anchorCount = anchors.filter((year) => (
        year !== undefined && Math.abs(year - candidateYear) <= 2
    )).length;
    if (
        distance < 3
        || distance - radius < -1
        || consensusCount < 5
        || anchorCount < 1
    ) return null;
    const shiftMagnitude = Math.min(distance, 2) as 1 | 2;
    const shiftYears = (
        candidateYear < centerYear ? -shiftMagnitude : shiftMagnitude
    ) as -2 | -1 | 1 | 2;
    return {
        centerYear: centerYear + shiftYears,
        window: {
            startYear: currentWindow.startYear + shiftYears,
            endYear: currentWindow.endYear + shiftYears,
        },
        candidateYear,
        shiftYears,
        consensusCount,
        anchorCount,
    };
};
