/**
 * Refines one already-detected unit event with a robust endpoint-anchored likelihood.
 *
 * The detector remains responsible for deciding whether an event exists and which
 * operation it represents. This module only chooses one compact review window.
 */
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import {
    COFECHA_REFERENCE_DEFAULT_OPTIONS,
    cofechaStyleStandardize,
} from "../reference";
import {
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import type {
    DiagnosisEvent,
    DiagnosisRankedYear,
    NumericSeries,
    SeriesCoreDiagnosis,
} from "./types";

const REFERENCE_LIMIT = 24;
const MIN_REFERENCE_COUNT = 5;
const MIN_REFERENCE_OVERLAP = 80;
const ENDPOINT_MARGIN_YEARS = 15;
const SERIES_ENDPOINT_MIN_DISTANCE = 2;
const SERIES_ENDPOINT_MAX_DISTANCE = 14;
const SERIES_ENDPOINT_ALIAS_MAX_DISTANCE = 29;
const AMBIGUOUS_ENDPOINT_MODE_MIN_MASS_RATIO = 1;
const FALSE_RING_REMOTE_POSTERIOR_MIN_JUMP = 16;
const FALSE_RING_PREVIOUS_MODE_RADIUS = 8;
const NEWER_ENDPOINT_LOCATION_EVIDENCE_PREFIXES = [
    "scan_top_year=",
    "candidate_top_year=",
    "reference_vote_year=",
] as const;
const CORE_WINDOW_WIDTH = 7;
const VIEW_WEIGHTS = {
    difference: 0.3,
    splineLog: 0.2,
    cofecha: 0.5,
} as const;
const FALSE_RING_NEWER_EDGE_EVIDENCE_PREFIXES = [
    "unit_local_raw31_year=",
    "unit_local_difference31_year=",
    "unit_local_whitened31_year=",
    "unit_local_combo31_year=",
    "unit_local_combo41_year=",
    "unit_local_combo61_year=",
    "unit_local_multiScale_year=",
    "unit_local_pairMean31_year=",
    "unit_local_pairMedian31_year=",
    "unit_local_pairTrimmed31_year=",
    "unit_local_pairWeighted31_year=",
    "unit_local_bestReference31_year=",
    "unit_local_pairedCore31_year=",
] as const;
const FALSE_RING_TOP_YEAR_EVIDENCE_PREFIXES = [
    "scan_top_year=",
    "raw_path_top_year=",
    "candidate_top_year=",
    "direct_transition_year=",
    "paired_breakpoint_year=",
    ...FALSE_RING_NEWER_EDGE_EVIDENCE_PREFIXES,
] as const;
const FALSE_RING_PREVIOUS_MODE_EVIDENCE_PREFIXES = [
    "scan_top_year=",
    "candidate_top_year=",
    "paired_breakpoint_year=",
] as const;

type ResidualViewName = keyof typeof VIEW_WEIGHTS;
type ResidualViews = {
    raw: NumericSeries;
    difference: NumericSeries;
    splineLog: NumericSeries;
    cofecha: NumericSeries;
};

type PreparedReference = {
    id: string;
    views: ResidualViews;
    weight: number;
};

export type EndpointResidualWindowCache = Map<
    string,
    { source: RwlTreeData; views: ResidualViews }
>;

export const createEndpointResidualWindowCache = (): EndpointResidualWindowCache => (
    new Map()
);

const mean = (values: readonly number[]): number => (
    values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0
);

const median = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    const ordered = [...values].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 0
        ? (ordered[middle - 1] + ordered[middle]) / 2
        : ordered[middle];
};

const populationSd = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    const center = mean(values);
    return Math.sqrt(mean(values.map((value) => (value - center) ** 2)));
};

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const difference = new Map<number, number>();
    series.forEach((value, year) => {
        const previous = series.get(year - 1);
        if (previous !== undefined) difference.set(year, value - previous);
    });
    return preprocessSeries(difference);
};

const transformedMap = (
    source: RwlTreeData,
    useAutoregressiveModel: boolean,
): NumericSeries => preprocessSeries(new Map(
    cofechaStyleStandardize(source, {
        ...COFECHA_REFERENCE_DEFAULT_OPTIONS,
        useAutoregressiveModel,
        useLogTransform: true,
        useFirstDifference: false,
    }).map((point) => [point.year, point.value]),
));

const transformSeries = (source: RwlTreeData): ResidualViews => {
    const raw = preprocessSeries(toNumericSeries(source));
    return {
        raw,
        difference: firstDifferences(raw),
        splineLog: transformedMap(source, false),
        cofecha: transformedMap(source, true),
    };
};

const cachedViews = (
    id: string,
    source: RwlTreeData,
    cache: EndpointResidualWindowCache,
): ResidualViews => {
    const existing = cache.get(id);
    if (existing?.source === source) return existing.views;
    const views = transformSeries(source);
    cache.set(id, { source, views });
    return views;
};

const overlapCount = (left: NumericSeries, right: NumericSeries): number => {
    let count = 0;
    const smaller = left.size <= right.size ? left : right;
    const larger = smaller === left ? right : left;
    smaller.forEach((_, year) => {
        if (larger.has(year)) count += 1;
    });
    return count;
};

const bestGlobalCorrelation = (
    target: NumericSeries,
    reference: NumericSeries,
    diagnosis: SeriesCoreDiagnosis,
): number => {
    let best = Number.NEGATIVE_INFINITY;
    for (let lag = -3; lag <= 3; lag += 1) {
        const correlation = correlationForSegment(
            target,
            reference,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
            lag,
            20,
        ).correlation;
        if (correlation !== null) best = Math.max(best, correlation);
    }
    return Number.isFinite(best) ? best : 0;
};

const prepareReferences = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    targetViews: ResidualViews,
    cache: EndpointResidualWindowCache,
): PreparedReference[] => {
    const availableIds = diagnosis.master.sourceTrees.length > 0
        ? diagnosis.master.sourceTrees
        : Array.from(siteData.keys()).filter((id) => id !== diagnosis.targetTree);
    const targetStem = diagnosis.targetTree.slice(0, -1).toLowerCase();
    return availableIds
        .map((id) => {
            const source = siteData.get(id);
            if (!source) return null;
            const raw = toNumericSeries(source);
            return {
                id,
                source,
                overlap: overlapCount(diagnosis.rawTarget, raw),
            };
        })
        .filter((row): row is {
            id: string;
            source: RwlTreeData;
            overlap: number;
        } => row !== null && row.overlap >= MIN_REFERENCE_OVERLAP)
        .sort((left, right) => right.overlap - left.overlap || left.id.localeCompare(right.id))
        .slice(0, REFERENCE_LIMIT)
        .map((row) => {
            const views = cachedViews(row.id, row.source, cache);
            const globalCorrelation = bestGlobalCorrelation(
                targetViews.raw,
                views.raw,
                diagnosis,
            );
            const paired = row.id.slice(0, -1).toLowerCase() === targetStem;
            return {
                id: row.id,
                views,
                weight: (Math.max(0, globalCorrelation) + 0.15) * (paired ? 2.5 : 1),
            };
        });
};

const weightedMaster = (
    references: PreparedReference[],
    viewName: ResidualViewName,
): NumericSeries => {
    const weightedSums = new Map<number, number>();
    const weights = new Map<number, number>();
    references.forEach((reference) => {
        const source = viewName === "difference"
            ? reference.views.raw
            : reference.views[viewName];
        source.forEach((value, year) => {
            weightedSums.set(
                year,
                (weightedSums.get(year) ?? 0) + value * reference.weight,
            );
            weights.set(year, (weights.get(year) ?? 0) + reference.weight);
        });
    });
    const rawMaster = new Map<number, number>();
    weightedSums.forEach((sum, year) => {
        const weight = weights.get(year) ?? 0;
        if (weight > 0) rawMaster.set(year, sum / weight);
    });
    const standardized = preprocessSeries(rawMaster);
    return viewName === "difference"
        ? firstDifferences(standardized)
        : standardized;
};

const yearReliability = (
    references: PreparedReference[],
    viewName: ResidualViewName,
): NumericSeries => {
    const buckets = new Map<number, number[]>();
    references.forEach((reference) => {
        reference.views[viewName].forEach((value, year) => {
            const values = buckets.get(year);
            if (values) values.push(value);
            else buckets.set(year, [value]);
        });
    });
    const unscaled = new Map<number, number>();
    buckets.forEach((values, year) => {
        if (values.length < 3) return;
        const center = median(values);
        const mad = median(values.map((value) => Math.abs(value - center))) * 1.4826;
        unscaled.set(year, Math.sqrt(values.length) / (0.35 + mad));
    });
    const scale = median(Array.from(unscaled.values())) || 1;
    return new Map(Array.from(unscaled.entries()).map(([year, value]) => [
        year,
        Math.max(0.25, Math.min(3, value / scale)),
    ]));
};

const huber = (value: number, transition = 1.5): number => {
    const absolute = Math.abs(value);
    return absolute <= transition
        ? 0.5 * absolute ** 2
        : transition * (absolute - transition * 0.5);
};

const boundaryScores = (
    target: NumericSeries,
    master: NumericSeries,
    reliability: NumericSeries,
    candidateYears: number[],
    lag: number,
    falseRing: boolean,
): Map<number, number> => {
    const preferences = new Map<number, number>();
    const nullLosses = new Map<number, number>();
    target.forEach((targetValue, year) => {
        const current = master.get(year);
        const shifted = master.get(year + lag);
        if (current === undefined || shifted === undefined) return;
        const pairReliability = Math.sqrt(
            (reliability.get(year) ?? 1) * (reliability.get(year + lag) ?? 1),
        );
        preferences.set(
            year,
            (huber(targetValue - current) - huber(targetValue - shifted))
                * pairReliability,
        );
        nullLosses.set(
            year,
            Math.min(
                huber(targetValue - current),
                huber(targetValue - shifted),
            ) * (reliability.get(year) ?? 1),
        );
    });
    const orderedPreferences = Array.from(preferences.entries())
        .sort((left, right) => left[0] - right[0]);
    const scores = new Map<number, number>();
    let running = 0;
    let preferenceIndex = 0;
    candidateYears.forEach((candidateYear) => {
        const olderEnd = falseRing ? candidateYear - 1 : candidateYear;
        while (
            preferenceIndex < orderedPreferences.length
            && orderedPreferences[preferenceIndex][0] <= olderEnd
        ) {
            running += orderedPreferences[preferenceIndex][1];
            preferenceIndex += 1;
        }
        scores.set(
            candidateYear,
            running + (falseRing ? nullLosses.get(candidateYear) ?? 0 : 0),
        );
    });
    return scores;
};

const posteriorByYear = (
    scores: Map<number, number>,
    temperature: number,
): Map<number, number> => {
    const values = Array.from(scores.values());
    const center = median(values);
    const mad = median(values.map((value) => Math.abs(value - center)));
    const scale = Math.max(1e-6, mad * 1.4826, populationSd(values) * 0.25);
    const masses = new Map<number, number>();
    let total = 0;
    scores.forEach((score, year) => {
        const standardized = (score - center) / scale;
        const mass = Math.exp(Math.max(-30, Math.min(30, standardized * temperature)));
        masses.set(year, mass);
        total += mass;
    });
    if (total <= 0) return new Map();
    return new Map(Array.from(masses.entries()).map(([year, mass]) => [
        year,
        mass / total,
    ]));
};

const bestWindow = (
    posterior: NumericSeries,
    candidateStart: number,
    candidateEnd: number,
    width: number,
): { startYear: number; endYear: number; mass: number } => {
    let bestStart = candidateStart;
    let bestMass = Number.NEGATIVE_INFINITY;
    for (
        let start = candidateStart;
        start <= candidateEnd - width + 1;
        start += 1
    ) {
        let mass = 0;
        for (let year = start; year < start + width; year += 1) {
            mass += posterior.get(year) ?? 0;
        }
        if (mass > bestMass) {
            bestMass = mass;
            bestStart = start;
        }
    }
    return {
        startYear: bestStart,
        endYear: bestStart + width - 1,
        mass: Math.max(0, bestMass),
    };
};

const expandTowardPreviousWindow = (
    core: { startYear: number; endYear: number; mass: number },
    event: DiagnosisEvent,
    posterior: NumericSeries,
    candidateStart: number,
    candidateEnd: number,
): { startYear: number; endYear: number; mass: number } => {
    if (event.eventType !== "falseRing") return core;
    const coreCenter = (core.startYear + core.endYear) / 2;
    const previousCenter = (event.startYear + event.endYear) / 2;
    const previousTop = event.rankedYears[0]?.year
        ?? Math.round(previousCenter);
    let startYear = core.startYear;
    let endYear = core.endYear;
    const addedYear = previousCenter < coreCenter && startYear > candidateStart
        ? startYear - 1
        : previousCenter > coreCenter && endYear < candidateEnd
            ? endYear + 1
            : null;
    if (addedYear === null || Math.abs(previousTop - addedYear) > 1) {
        return core;
    }
    if (addedYear < startYear) startYear = addedYear;
    else endYear = addedYear;
    let mass = 0;
    for (let year = startYear; year <= endYear; year += 1) {
        mass += posterior.get(year) ?? 0;
    }
    return { startYear, endYear, mass };
};

const posteriorMass = (
    posterior: NumericSeries,
    startYear: number,
    endYear: number,
): number => {
    let mass = 0;
    for (let year = startYear; year <= endYear; year += 1) {
        mass += posterior.get(year) ?? 0;
    }
    return mass;
};

const noteYear = (event: DiagnosisEvent, prefix: string): number | null => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const year = Number(note?.slice(prefix.length));
    return Number.isInteger(year) ? year : null;
};

export type EndpointConsensusBoundaryShift = {
    window: { startYear: number; endYear: number };
    centerYear: number;
    supportCount: number;
    shiftYears: number;
};

export const selectEndpointConsensusBoundaryShift = (input: {
    event: DiagnosisEvent;
    window: { startYear: number; endYear: number };
    previousTopYear: number;
    posteriorTopYear: number;
    currentTopYear: number;
}): EndpointConsensusBoundaryShift | null => {
    const evidenceYears = [
        noteYear(input.event, "paired_breakpoint_year="),
        noteYear(input.event, "reference_vote_year="),
        input.previousTopYear,
        input.posteriorTopYear,
    ].filter((year): year is number => year !== null);
    if (evidenceYears.length < 3) return null;
    const ordered = [...evidenceYears].sort((left, right) => left - right);
    const centerYear = ordered[Math.floor((ordered.length - 1) / 2)];
    const supportCount = evidenceYears.filter(
        (year) => Math.abs(year - centerYear) <= 5,
    ).length;
    if (
        supportCount < 3
        || Math.abs(input.currentTopYear - centerYear) > 7
    ) return null;
    const distance = centerYear < input.window.startYear
        ? input.window.startYear - centerYear
        : centerYear > input.window.endYear
            ? centerYear - input.window.endYear
            : 0;
    if (distance < 1 || distance > 4) return null;
    const shiftYears = centerYear < input.window.startYear
        ? -distance
        : distance;
    return {
        window: {
            startYear: input.window.startYear + shiftYears,
            endYear: input.window.endYear + shiftYears,
        },
        centerYear,
        supportCount,
        shiftYears,
    };
};

export const shouldTrimFalseRingNewerEdge = (
    event: DiagnosisEvent,
    window: { startYear: number; endYear: number },
    primaryTopYear: number,
    posteriorTopYear: number,
): boolean => {
    const newerEdgeEvidenceCount = FALSE_RING_NEWER_EDGE_EVIDENCE_PREFIXES
        .map((prefix) => noteYear(event, prefix))
        .filter((year): year is number => year !== null && year >= window.endYear)
        .length;
    return event.eventType === "falseRing"
        && window.endYear - window.startYear + 1 > 6
        && primaryTopYear < window.endYear
        && posteriorTopYear <= window.endYear - 3
        && newerEdgeEvidenceCount <= Math.floor(
            FALSE_RING_NEWER_EDGE_EVIDENCE_PREFIXES.length / 2,
        );
};

const ALLOWED_REVIEW_WINDOW_WIDTHS = new Set([5, 7, 9, 13]);

export const trimFalseRingNewerEdgeWindow = (
    window: { startYear: number; endYear: number },
    minimumStartYear: number,
): { startYear: number; endYear: number } => {
    const trimmed = {
        startYear: window.startYear,
        endYear: window.endYear - 1,
    };
    const trimmedWidth = trimmed.endYear - trimmed.startYear + 1;
    if (ALLOWED_REVIEW_WINDOW_WIDTHS.has(trimmedWidth)) return trimmed;
    const originalWidth = window.endYear - window.startYear + 1;
    if (!ALLOWED_REVIEW_WINDOW_WIDTHS.has(originalWidth)) return trimmed;
    const startYear = Math.max(minimumStartYear, window.startYear - 1);
    return { startYear, endYear: startYear + originalWidth - 1 };
};

export const shouldPromoteFalseRingPosteriorYear = (
    event: DiagnosisEvent,
    window: { startYear: number; endYear: number },
    currentTopYear: number,
    posteriorTopYear: number,
): boolean => {
    if (
        event.eventType !== "falseRing"
        || posteriorTopYear < window.startYear
        || posteriorTopYear > window.endYear
        || posteriorTopYear === currentTopYear
        || Math.abs(posteriorTopYear - currentTopYear) > 3
    ) {
        return false;
    }
    const evidenceYears = [
        ...FALSE_RING_TOP_YEAR_EVIDENCE_PREFIXES
            .map((prefix) => noteYear(event, prefix))
            .filter((year): year is number => year !== null),
        posteriorTopYear,
    ];
    const candidateExact = evidenceYears.filter(
        (year) => year === posteriorTopYear,
    ).length;
    const currentExact = evidenceYears.filter(
        (year) => year === currentTopYear,
    ).length;
    const candidateNear = evidenceYears.filter(
        (year) => Math.abs(year - posteriorTopYear) <= 1,
    ).length;
    const currentNear = evidenceYears.filter(
        (year) => Math.abs(year - currentTopYear) <= 1,
    ).length;
    return candidateExact >= 6
        && candidateExact >= currentExact
        && candidateNear > currentNear;
};

export const shouldRejectFalseRingRemotePosterior = (
    event: DiagnosisEvent,
    previousTopYear: number,
    posteriorTopYear: number,
): boolean => {
    if (
        event.eventType !== "falseRing"
        || Math.abs(posteriorTopYear - previousTopYear)
            < FALSE_RING_REMOTE_POSTERIOR_MIN_JUMP
    ) return false;
    return FALSE_RING_PREVIOUS_MODE_EVIDENCE_PREFIXES.every((prefix) => {
        const year = noteYear(event, prefix);
        return year !== null
            && Math.abs(year - previousTopYear)
                <= FALSE_RING_PREVIOUS_MODE_RADIUS;
    });
};

const promoteRankedYear = (
    rows: DiagnosisRankedYear[],
    promotedYear: number,
): DiagnosisRankedYear[] => {
    const ordered = [...rows].sort((left, right) => left.rank - right.rank);
    const promoted = ordered.find((row) => row.year === promotedYear);
    if (!promoted) return rows;
    return [
        {
            ...promoted,
            evidenceTags: Array.from(new Set([
                ...promoted.evidenceTags,
                "false_ring_endpoint_consensus",
            ])).sort(),
        },
        ...ordered.filter((row) => row.year !== promotedYear),
    ].map((row, index) => ({ ...row, rank: index + 1 }));
};

const rankedYears = (
    event: DiagnosisEvent,
    window: { startYear: number; endYear: number },
    posterior: NumericSeries,
): DiagnosisRankedYear[] => {
    const previous = new Map(event.rankedYears.map((row) => [row.year, row]));
    const years = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => window.startYear + index,
    );
    const previousRanks = new Map(
        event.rankedYears
            .filter((row) => (
                row.year >= window.startYear && row.year <= window.endYear
            ))
            .map((row, index) => [row.year, index + 1]),
    );
    const posteriorRanks = new Map(
        [...years]
            .sort((left, right) => (
                (posterior.get(right) ?? 0) - (posterior.get(left) ?? 0)
                || right - left
            ))
            .map((year, index) => [year, index + 1]),
    );
    return years
        .map((year) => ({
            year,
            rank: 0,
            score: previousRanks.has(year)
                ? 1 + 1 / (previousRanks.get(year) ?? years.length)
                : 0.5 / (posteriorRanks.get(year) ?? years.length),
            posterior: posterior.get(year) ?? 0,
            evidenceTags: Array.from(new Set([
                "endpoint_residual_posterior",
                ...(previous.get(year)?.evidenceTags ?? []),
            ])).sort(),
        }))
        .sort((left, right) => (
            right.score - left.score
            || right.posterior - left.posterior
            || right.year - left.year
        ))
        .map(({ posterior: _posterior, ...row }, index) => ({
            ...row,
            rank: index + 1,
        }));
};

const hasExplicitZeroNearEvent = (
    event: DiagnosisEvent,
    source: RwlTreeData | undefined,
): boolean => {
    for (let year = event.startYear - 2; year <= event.endYear + 2; year += 1) {
        if (source?.get(year) === 0) return true;
    }
    return false;
};

type SeriesEndpointSide = "older" | "newer";

export type NewerEndpointModeSelection = {
    selectedMode: "endpoint" | "interior";
    endpointMass: number;
    interiorMass: number;
    massRatio: number;
};

export const selectAmbiguousNewerEndpointMode = (input: {
    endpointMass: number;
    interiorMass: number;
}): NewerEndpointModeSelection => {
    const massRatio = input.endpointMass / Math.max(input.interiorMass, 1e-12);
    return {
        selectedMode: massRatio >= AMBIGUOUS_ENDPOINT_MODE_MIN_MASS_RATIO
            ? "endpoint"
            : "interior",
        endpointMass: input.endpointMass,
        interiorMass: input.interiorMass,
        massRatio,
    };
};

const primaryEventYear = (event: DiagnosisEvent): number => (
    event.rankedYears[0]?.year
    ?? Math.round((event.startYear + event.endYear) / 2)
);

const hasNewerEndpointAlias = (event: DiagnosisEvent): boolean => (
    event.evidence.algorithmSources.includes(
        "newer_endpoint_unit_alias_of_global_lag",
    )
);

const touchesNewerEndpointRange = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
): boolean => (
    Math.max(0, diagnosis.targetRange.endYear - event.endYear)
        <= SERIES_ENDPOINT_MAX_DISTANCE
);

export const isAutomaticOlderEndpointUnitEvent = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
): boolean => (
    (event.eventType === "missingRing" || event.eventType === "falseRing")
    && primaryEventYear(event) - diagnosis.targetRange.startYear
        <= SERIES_ENDPOINT_MAX_DISTANCE
);

export const hasOlderConsensusBeyondNewerEndpointRange = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
): boolean => {
    const endpointStart = diagnosis.targetRange.endYear
        - SERIES_ENDPOINT_MAX_DISTANCE;
    const locationYears = [
        primaryEventYear(event),
        ...NEWER_ENDPOINT_LOCATION_EVIDENCE_PREFIXES
            .map((prefix) => noteYear(event, prefix))
            .filter((year): year is number => year !== null),
    ];
    return locationYears.filter((year) => year < endpointStart).length >= 3;
};

const seriesEndpointSide = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
): SeriesEndpointSide | null => {
    const { startYear, endYear } = diagnosis.targetRange;
    const eventYear = primaryEventYear(event);
    const olderGap = Math.max(0, eventYear - startYear);
    // The older side has an explicit Top1-based exclusion boundary. The newer side remains
    // recall-oriented: a review window touching the endpoint range is enough to keep it.
    const newerGap = Math.max(0, endYear - event.endYear);
    const hasNearbyNewerAlias = hasNewerEndpointAlias(event)
        && newerGap <= SERIES_ENDPOINT_ALIAS_MAX_DISTANCE;
    const hasForcedNewerCompetitor = event.evidence.algorithmSources.includes(
        "newer_endpoint_unit_competitor_of_global_lag",
    );
    const olderAdjacent = olderGap <= SERIES_ENDPOINT_MAX_DISTANCE;
    const newerAdjacent = hasForcedNewerCompetitor || hasNearbyNewerAlias || (
        newerGap <= SERIES_ENDPOINT_MAX_DISTANCE
        && !hasOlderConsensusBeyondNewerEndpointRange(event, diagnosis)
    );
    if (!olderAdjacent && !newerAdjacent) return null;
    return olderAdjacent && (!newerAdjacent || olderGap <= newerGap)
        ? "older"
        : "newer";
};

export const refineUnitEventWithEndpointResidualWindow = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    cache: EndpointResidualWindowCache = createEndpointResidualWindowCache(),
): DiagnosisEvent => {
    if (event.eventType !== "missingRing" && event.eventType !== "falseRing") {
        return event;
    }
    const targetSource = siteData.get(diagnosis.targetTree);
    if (!targetSource || hasExplicitZeroNearEvent(event, targetSource)) return event;
    const endpointSide = seriesEndpointSide(event, diagnosis);
    const ambiguousNewerEndpoint = endpointSide === null && (
        touchesNewerEndpointRange(event, diagnosis)
        || hasNewerEndpointAlias(event)
    );
    const olderEndpointCalendarAdjustment = endpointSide === "older"
        ? event.eventType === "missingRing" ? -1 : 1
        : 0;
    const interiorStart = diagnosis.targetRange.startYear + ENDPOINT_MARGIN_YEARS;
    const interiorEnd = diagnosis.targetRange.endYear - ENDPOINT_MARGIN_YEARS;
    const newerEndpointStart = diagnosis.targetRange.endYear
        - SERIES_ENDPOINT_MAX_DISTANCE;
    const newerEndpointEnd = diagnosis.targetRange.endYear
        - SERIES_ENDPOINT_MIN_DISTANCE;
    const candidateStart = ambiguousNewerEndpoint
        ? interiorStart
        : endpointSide === "older"
        ? diagnosis.targetRange.startYear
            + SERIES_ENDPOINT_MIN_DISTANCE
            + olderEndpointCalendarAdjustment
        : endpointSide === "newer"
            ? newerEndpointStart
            : interiorStart;
    const candidateEnd = ambiguousNewerEndpoint
        ? newerEndpointEnd
        : endpointSide === "older"
        ? diagnosis.targetRange.startYear
            + SERIES_ENDPOINT_MAX_DISTANCE
            + olderEndpointCalendarAdjustment
        : endpointSide === "newer"
            ? newerEndpointEnd
            : interiorEnd;
    if (candidateEnd - candidateStart + 1 < CORE_WINDOW_WIDTH) return event;

    const targetViews = cachedViews(diagnosis.targetTree, targetSource, cache);
    const references = prepareReferences(diagnosis, siteData, targetViews, cache);
    if (references.length < MIN_REFERENCE_COUNT) return event;
    const candidateYears = Array.from(
        { length: candidateEnd - candidateStart + 1 },
        (_, index) => candidateStart + index,
    );
    const lag = event.eventType === "missingRing" ? -1 : 1;
    const combined = new Map(candidateYears.map((year) => [year, 0]));
    (Object.entries(VIEW_WEIGHTS) as Array<[ResidualViewName, number]>)
        .forEach(([viewName, weight]) => {
            const master = weightedMaster(references, viewName);
            const reliability = yearReliability(references, viewName);
            const scores = boundaryScores(
                targetViews[viewName],
                master,
                reliability,
                candidateYears,
                lag,
                event.eventType === "falseRing",
            );
            candidateYears.forEach((year) => {
                combined.set(
                    year,
                    (combined.get(year) ?? 0)
                        + (scores.get(year) ?? 0) * weight,
                );
            });
        });
    const temperature = event.eventType === "missingRing" ? 0.25 : 1;
    const posterior = posteriorByYear(combined, temperature);
    if (posterior.size === 0) return event;
    const ambiguousMode = ambiguousNewerEndpoint
        ? selectAmbiguousNewerEndpointMode({
            endpointMass: bestWindow(
                posterior,
                newerEndpointStart,
                newerEndpointEnd,
                CORE_WINDOW_WIDTH,
            ).mass,
            interiorMass: bestWindow(
                posterior,
                interiorStart,
                interiorEnd,
                CORE_WINDOW_WIDTH,
            ).mass,
        })
        : null;
    const selectedEndpointSide = ambiguousMode?.selectedMode === "endpoint"
        ? "newer"
        : endpointSide;
    const selectedCandidateStart = selectedEndpointSide === "newer"
        ? newerEndpointStart
        : selectedEndpointSide === "older"
            ? candidateStart
            : interiorStart;
    const selectedCandidateEnd = selectedEndpointSide === "newer"
        ? newerEndpointEnd
        : selectedEndpointSide === "older"
            ? candidateEnd
            : interiorEnd;
    const coreWindow = selectedEndpointSide
        ? {
            startYear: selectedCandidateStart,
            endYear: selectedCandidateEnd,
            mass: posteriorMass(
                posterior,
                selectedCandidateStart,
                selectedCandidateEnd,
            ),
        }
        : bestWindow(
            posterior,
            selectedCandidateStart,
            selectedCandidateEnd,
            CORE_WINDOW_WIDTH,
        );
    const expandedWindow = selectedEndpointSide
        ? coreWindow
        : expandTowardPreviousWindow(
            coreWindow,
            event,
            posterior,
            selectedCandidateStart,
            selectedCandidateEnd,
        );
    const previousTop = event.rankedYears[0]?.year
        ?? Math.round((event.startYear + event.endYear) / 2);
    const expandedPosteriorTop = [...posterior.entries()]
        .filter(([year]) => (
            year >= expandedWindow.startYear && year <= expandedWindow.endYear
        ))
        .sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]?.[0]
        ?? previousTop;
    const expandedRanking = rankedYears(event, expandedWindow, posterior);
    const newerEdgeEvidenceCount = FALSE_RING_NEWER_EDGE_EVIDENCE_PREFIXES
        .map((prefix) => noteYear(event, prefix))
        .filter((year): year is number => (
            year !== null && year >= expandedWindow.endYear
        )).length;
    const trimUnsupportedNewerEdge = selectedEndpointSide === null
        && shouldTrimFalseRingNewerEdge(
            event,
            expandedWindow,
            expandedRanking[0]?.year ?? expandedWindow.endYear,
            expandedPosteriorTop,
        );
    const trimmedWindow = trimUnsupportedNewerEdge
        ? trimFalseRingNewerEdgeWindow(expandedWindow, selectedCandidateStart)
        : null;
    const window = trimmedWindow
        ? {
            ...trimmedWindow,
            mass: posteriorMass(
                posterior,
                trimmedWindow.startYear,
                trimmedWindow.endYear,
            ),
        }
        : expandedWindow;
    const posteriorTop = trimUnsupportedNewerEdge
        ? [...posterior.entries()]
            .filter(([year]) => year >= window.startYear && year <= window.endYear)
            .sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]?.[0]
            ?? previousTop
        : expandedPosteriorTop;
    if (shouldRejectFalseRingRemotePosterior(
        event,
        previousTop,
        posteriorTop,
    )) {
        return {
            ...event,
            evidence: {
                ...event.evidence,
                algorithmSources: Array.from(new Set([
                    ...event.evidence.algorithmSources,
                    "false_ring_remote_posterior_rejected",
                ])).sort(),
                notes: [
                    ...event.evidence.notes,
                    "window_refinement=false_ring_remote_posterior_rejected",
                    `endpoint_residual_rejected_previous_top_year=${previousTop}`,
                    `endpoint_residual_rejected_posterior_top_year=${posteriorTop}`,
                    `endpoint_residual_rejected_jump_years=${
                        Math.abs(posteriorTop - previousTop)
                    }`,
                ],
            },
        };
    }
    const windowRanking = trimUnsupportedNewerEdge
        ? rankedYears(event, window, posterior)
        : expandedRanking;
    const endpointConsensusBoundaryShift = selectEndpointConsensusBoundaryShift({
        event,
        window,
        previousTopYear: previousTop,
        posteriorTopYear: posteriorTop,
        currentTopYear: windowRanking[0]?.year ?? previousTop,
    });
    const finalWindow = endpointConsensusBoundaryShift
        ? {
            ...endpointConsensusBoundaryShift.window,
            mass: posteriorMass(
                posterior,
                endpointConsensusBoundaryShift.window.startYear,
                endpointConsensusBoundaryShift.window.endYear,
            ),
        }
        : window;
    const finalWindowRanking = endpointConsensusBoundaryShift
        ? rankedYears(event, finalWindow, posterior)
        : windowRanking;
    const promotePosteriorTop = shouldPromoteFalseRingPosteriorYear(
        event,
        finalWindow,
        finalWindowRanking[0]?.year ?? previousTop,
        posteriorTop,
    );
    const ranking = promotePosteriorTop
        ? promoteRankedYear(finalWindowRanking, posteriorTop)
        : finalWindowRanking;
    return {
        ...event,
        id: `${event.id}-endpoint-residual-${finalWindow.startYear}-${finalWindow.endYear}`,
        startYear: finalWindow.startYear,
        endYear: finalWindow.endYear,
        rankedYears: ranking,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "endpoint_residual_posterior",
                ...(selectedEndpointSide ? ["series_endpoint_review_window"] : []),
                ...(ambiguousMode ? ["newer_endpoint_mode_competition"] : []),
                ...(promotePosteriorTop
                    ? ["false_ring_endpoint_consensus"]
                    : []),
                ...(endpointConsensusBoundaryShift
                    ? ["endpoint_consensus_boundary_shift"]
                    : []),
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                "window_refinement=endpoint_residual_posterior",
                ...(selectedEndpointSide ? [
                    `series_endpoint_side=${selectedEndpointSide}`,
                    `series_endpoint_calendar_adjustment=${
                        olderEndpointCalendarAdjustment
                    }`,
                    "window_refinement=series_endpoint_single_sided_13_year",
                ] : []),
                ...(ambiguousMode ? [
                    `newer_endpoint_mode_selected=${ambiguousMode.selectedMode}`,
                    `newer_endpoint_mode_endpoint_mass=${ambiguousMode.endpointMass.toFixed(6)}`,
                    `newer_endpoint_mode_interior_mass=${ambiguousMode.interiorMass.toFixed(6)}`,
                    `newer_endpoint_mode_mass_ratio=${ambiguousMode.massRatio.toFixed(6)}`,
                ] : []),
                `endpoint_residual_previous_range=${event.startYear}-${event.endYear}`,
                `endpoint_residual_previous_top_year=${previousTop}`,
                `endpoint_residual_core_range=${coreWindow.startYear}-${coreWindow.endYear}`,
                `endpoint_residual_posterior_top_year=${posteriorTop}`,
                `endpoint_residual_top_year=${ranking[0]?.year ?? previousTop}`,
                `endpoint_residual_window_mass=${finalWindow.mass.toFixed(6)}`,
                `endpoint_residual_reference_count=${references.length}`,
                ...(trimUnsupportedNewerEdge ? [
                    "window_refinement=false_ring_unsupported_newer_edge_trim",
                    `false_ring_newer_edge_support=${newerEdgeEvidenceCount}`,
                ] : []),
                ...(promotePosteriorTop ? [
                    "year_ranking_refinement=false_ring_endpoint_consensus",
                ] : []),
                ...(endpointConsensusBoundaryShift ? [
                    "window_refinement=endpoint_consensus_boundary_shift",
                    `endpoint_consensus_boundary_center_year=${
                        endpointConsensusBoundaryShift.centerYear
                    }`,
                    `endpoint_consensus_boundary_support_count=${
                        endpointConsensusBoundaryShift.supportCount
                    }`,
                    `endpoint_consensus_boundary_shift_years=${
                        endpointConsensusBoundaryShift.shiftYears
                    }`,
                ] : []),
            ],
        },
    };
};
