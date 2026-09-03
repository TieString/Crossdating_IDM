import type {
    CrossdatingDiagnosis,
    DiagnosisConfidence,
    DiagnosisEvent,
    DiagnosisEventInterpretationAmbiguity,
    DiagnosisEventAuditSnapshot,
    DiagnosisEventDecisionAudit,
    DiagnosisEventType,
    YearRange,
} from "./types";
import {
    attachWholeLocalEventInterpretation,
    makeEndpointMissingReviewFromWhole,
} from "./endpointWholeMissingInterpretation";
import { attachMissingPartialInterpretation } from "./missingPartialInterpretation";

export const ONLINE_UNIFIED_EVIDENCE_VERSION = "online-unified-evidence-v1";
export const ONLINE_UNIFIED_MODEL_VERSION = "applied-residual-unified-v12-online-v1";

export type OnlineUnifiedClaimStage =
    | "strict"
    | "review"
    | "candidate"
    | "detected"
    | "fused"
    | "retained"
    | "displayed"
    | "final"
    | "joint"
    | "locator"
    | "boundedPath";

export type OnlineUnifiedEventClaim = {
    claimId: string;
    stage: OnlineUnifiedClaimStage;
    eventType: DiagnosisEventType;
    shiftYears: number;
    startYear: number;
    endYear: number;
    topYear: number | null;
    confidence: DiagnosisConfidence;
    score: number;
    scoreMargin: number;
    lagBefore: number | null;
    lagAfter: number | null;
    samplePairs: number;
    baselineCorrelation: number | null;
    correctedCorrelation: number | null;
    correlationGain: number | null;
    algorithmSources: string[];
    notes: string[];
    candidateIds: string[];
};

export type OnlineUnifiedGridOperation = {
    eventType: "missingRing" | "falseRing" | "partialMove";
    shiftYears: number;
    bestYear: number;
    dynamicScore: number;
    bestRawGain: number;
    bestDifferenceGain: number;
    bestCombinedGain: number;
    topThreeDifferenceGain: number;
    remoteDifferenceMargin: number;
    baselineLag: number;
    profilePeaks?: OnlineUnifiedOperationProfilePeak[];
    yearProfile?: OnlineUnifiedOperationYearProfile[];
};

export type OnlineUnifiedOperationYearProfile = {
    year: number;
    rawGain: number;
    differenceGain: number;
    combinedGain: number;
    sideStepScore: number;
    sideMinimumAdvantage: number;
    correctedSideSupport: number;
};

export type OnlineUnifiedOperationProfilePeak = {
    source:
        | "rawGain"
        | "differenceGain"
        | "combinedGain"
        | "sideStep"
        | "sideMinimumAdvantage"
        | "correctedSideSupport";
    year: number;
    score: number;
    remoteMargin: number;
};

export type OnlineUnifiedSelectionAnchor = {
    eventType: "missingRing" | "falseRing" | "partialMove";
    shiftYears: number;
    bestYear: number;
    score: number;
    scoreMargin: number;
    shiftScoreMargin: number | null;
};

export type OnlineUnifiedEventSource = {
    stage: OnlineUnifiedClaimStage;
    event: DiagnosisEvent;
};

export type OnlineUnifiedEvidenceBundle = {
    schemaVersion: 1;
    evidenceVersion: typeof ONLINE_UNIFIED_EVIDENCE_VERSION;
    seriesId: string;
    targetRange: YearRange;
    cofechaFlagged: boolean;
    referenceSourceCount: number;
    minimumReferenceDepth: number;
    medianReferenceDepth: number;
    candidateCount: number;
    candidateModeCount: number;
    finalReason: string;
    pass: Record<string, number>;
    claims: OnlineUnifiedEventClaim[];
    /** Runtime-only executable events. They never enter model features or scoring. */
    eventSources?: OnlineUnifiedEventSource[];
    operations: OnlineUnifiedGridOperation[];
    dynamicSelection: OnlineUnifiedSelectionAnchor | null;
    unitSelection: OnlineUnifiedSelectionAnchor | null;
    rawGlobalLag: number;
    cofechaGlobalLag: number;
};

export type OnlineUnifiedOperationIdentity = {
    eventType: DiagnosisEventType | "noEvent";
    shiftYears: number;
};

export type OnlineUnifiedOperationCandidate = OnlineUnifiedOperationIdentity & {
    packageId: string;
    identityGroup: string;
    features: Record<string, number>;
};

export type OnlineUnifiedLocationPackage = OnlineUnifiedOperationIdentity & {
    packageId: string;
    identityGroup: string;
    startYear: number;
    endYear: number;
    topYear: number;
    width: 5 | 7 | 9 | 13;
    features: Record<string, number>;
};

export type OnlineUnifiedExecutablePackage = {
    packageId: string;
    identityGroup: string;
    event: DiagnosisEvent;
};

const STAGE_PRIORITY: Record<OnlineUnifiedClaimStage, number> = {
    strict: 0.95,
    review: 1,
    candidate: 0.2,
    detected: 0.4,
    fused: 0.55,
    retained: 0.7,
    displayed: 0.82,
    final: 0.92,
    joint: 0.9,
    locator: 0.76,
    boundedPath: 0.65,
};

const CONFIDENCE_SCORE: Record<DiagnosisConfidence, number> = {
    low: 0.2,
    medium: 0.6,
    high: 1,
};

const SOURCE_TOKENS = [
    "candidate",
    "path",
    "bounded",
    "reference",
    "counterfactual",
    "cofecha",
    "endpoint",
    "sequential",
    "partial",
    "whole",
    "locator",
    "unit",
] as const;

const PROFILE_PEAK_SOURCES = [
    "rawGain",
    "differenceGain",
    "combinedGain",
    "sideStep",
    "sideMinimumAdvantage",
    "correctedSideSupport",
] as const;

const SAME_SHIFT_PARTIAL_GRID_FEATURES = [
    "grid_dynamic_score",
    "grid_best_raw_gain",
    "grid_best_difference_gain",
    "grid_best_combined_gain",
    "grid_top_three_difference_gain",
    "grid_remote_difference_margin",
    "grid_baseline_lag",
    "grid_profile_peak_count",
    "grid_profile_peak_year_spread",
    "grid_profile_peak_max_score",
    "grid_profile_peak_max_margin",
    ...PROFILE_PEAK_SOURCES.flatMap((source) => [
        `grid_profile_${source}_score`,
        `grid_profile_${source}_margin`,
    ]),
] as const;

const OPERATION_NUMERIC_FEATURES = [
    "claim_count",
    "claim_stage_count",
    "claim_max_stage",
    "claim_max_score",
    "claim_mean_score",
    "claim_max_margin",
    "claim_mean_margin",
    "claim_max_confidence",
    "claim_max_correlation_gain",
    "claim_mean_correlation_gain",
    "claim_max_sample_pairs",
    "claim_newest_top_fraction",
    "claim_newest_end_fraction",
    "grid_available",
    "grid_dynamic_score",
    "grid_best_raw_gain",
    "grid_best_difference_gain",
    "grid_best_combined_gain",
    "grid_top_three_difference_gain",
    "grid_remote_difference_margin",
    "grid_baseline_lag",
    "grid_profile_peak_count",
    "grid_profile_peak_year_spread",
    "grid_profile_peak_max_score",
    "grid_profile_peak_max_margin",
    ...PROFILE_PEAK_SOURCES.flatMap((source) => [
        `grid_profile_${source}_score`,
        `grid_profile_${source}_margin`,
    ]),
    "dynamic_selected",
    "dynamic_score",
    "dynamic_score_margin",
    "unit_selected",
    "unit_score",
    "unit_score_margin",
    "distance_to_raw_global_lag",
    "distance_to_cofecha_global_lag",
    "raw_global_lag_match",
    "cofecha_global_lag_match",
    "same_shift_partial_grid_available",
    ...SAME_SHIFT_PARTIAL_GRID_FEATURES.map((name) => (
        `same_shift_partial_${name}`
    )),
] as const;

const LOCATION_NUMERIC_FEATURES = [
    "year_fraction",
    "distance_from_oldest",
    "distance_from_newest",
    "claim_exact_count",
    "claim_within_1_count",
    "claim_within_2_count",
    "claim_within_4_count",
    "claim_within_6_count",
    "claim_min_distance",
    "claim_median_distance",
    "claim_signed_median_distance",
    "nearest_claim_score",
    "nearest_claim_margin",
    "nearest_claim_confidence",
    "nearest_claim_stage",
    "nearest_claim_correlation_gain",
    "grid_distance",
    "grid_exact",
    "dynamic_distance",
    "dynamic_exact",
    "unit_distance",
    "unit_exact",
    "profile_raw_gain",
    "profile_difference_gain",
    "profile_combined_gain",
    "profile_side_step_score",
    "profile_side_minimum_advantage",
    "profile_corrected_side_support",
    ...[
        "raw_gain",
        "difference_gain",
        "combined_gain",
        "side_step_score",
        "side_minimum_advantage",
        "corrected_side_support",
    ].flatMap((metric) => [
        `profile_${metric}_delta_from_previous`,
        `profile_${metric}_delta_to_next`,
        `profile_${metric}_second_difference`,
        `profile_${metric}_neighbor_advantage_2`,
        `profile_${metric}_neighbor_advantage_4`,
        `profile_${metric}_left_right_delta_4`,
        `profile_${metric}_local_quantile_4`,
    ]),
    ...SOURCE_TOKENS.flatMap((token) => [
        `source_${token}_within_2`,
        `source_${token}_within_6`,
    ]),
] as const;

const PROFILE_LOCATION_METRICS = [
    ["raw_gain", "rawGain"],
    ["difference_gain", "differenceGain"],
    ["combined_gain", "combinedGain"],
    ["side_step_score", "sideStepScore"],
    ["side_minimum_advantage", "sideMinimumAdvantage"],
    ["corrected_side_support", "correctedSideSupport"],
] as const satisfies readonly [
    string,
    Exclude<keyof OnlineUnifiedOperationYearProfile, "year">,
][];

const finite = (value: number | null | undefined, fallback = 0): number => (
    typeof value === "number" && Number.isFinite(value) ? value : fallback
);

const meanOr = (values: readonly number[], fallback: number): number => (
    values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : fallback
);

const profileShapeFeatures = (
    rows: readonly OnlineUnifiedOperationYearProfile[] | undefined,
    year: number,
): Record<string, number> => {
    const current = rows?.find((row) => row.year === year);
    if (!current || !rows) return {};
    const previous = rows.find((row) => row.year === year - 1);
    const next = rows.find((row) => row.year === year + 1);
    const features: Record<string, number> = {};
    PROFILE_LOCATION_METRICS.forEach(([name, key]) => {
        const center = finite(current[key]);
        const previousValue = finite(previous?.[key], center);
        const nextValue = finite(next?.[key], center);
        const neighbors2 = rows.filter((row) => (
            row.year !== year && Math.abs(row.year - year) <= 2
        )).map((row) => finite(row[key]));
        const neighbors4 = rows.filter((row) => (
            row.year !== year && Math.abs(row.year - year) <= 4
        )).map((row) => finite(row[key]));
        const left4 = rows.filter((row) => (
            row.year < year && row.year >= year - 4
        )).map((row) => finite(row[key]));
        const right4 = rows.filter((row) => (
            row.year > year && row.year <= year + 4
        )).map((row) => finite(row[key]));
        features[`profile_${name}_delta_from_previous`] = center - previousValue;
        features[`profile_${name}_delta_to_next`] = center - nextValue;
        features[`profile_${name}_second_difference`] = (
            2 * center - previousValue - nextValue
        );
        features[`profile_${name}_neighbor_advantage_2`] = (
            center - meanOr(neighbors2, center)
        );
        features[`profile_${name}_neighbor_advantage_4`] = (
            center - meanOr(neighbors4, center)
        );
        features[`profile_${name}_left_right_delta_4`] = (
            meanOr(left4, center) - meanOr(right4, center)
        );
        features[`profile_${name}_local_quantile_4`] = neighbors4.length > 0
            ? neighbors4.filter((value) => value <= center).length / neighbors4.length
            : 0.5;
    });
    return features;
};

export const effectiveOnlineShift = (
    eventType: DiagnosisEventType,
    shiftYears: number | null | undefined,
): number => {
    if (eventType === "missingRing") return -1;
    if (eventType === "falseRing") return 1;
    return shiftYears ?? 0;
};

const claimIdentity = (claim: Pick<OnlineUnifiedEventClaim, "eventType" | "shiftYears">) => (
    `${claim.eventType}:${claim.shiftYears}`
);

export const onlineUnifiedOperationIdentity = (
    candidate: OnlineUnifiedOperationIdentity,
) => (
    `${candidate.eventType}:${candidate.shiftYears}`
);

const operationIdentity = onlineUnifiedOperationIdentity;

const topYearOf = (event: DiagnosisEvent): number | null => (
    [...event.rankedYears].sort((left, right) => (
        left.rank - right.rank || right.score - left.score || right.year - left.year
    ))[0]?.year ?? null
);

const claimFromEvent = (
    event: DiagnosisEvent,
    stage: OnlineUnifiedClaimStage,
): OnlineUnifiedEventClaim => ({
    claimId: `${stage}:${event.id}`,
    stage,
    eventType: event.eventType,
    shiftYears: effectiveOnlineShift(event.eventType, event.shiftYears),
    startYear: event.startYear,
    endYear: event.endYear,
    topYear: topYearOf(event),
    confidence: event.confidenceLevel,
    score: finite(event.evidence.score),
    scoreMargin: finite(event.evidence.scoreMargin),
    lagBefore: event.evidence.lagBefore,
    lagAfter: event.evidence.lagAfter,
    samplePairs: finite(event.evidence.samplePairs),
    baselineCorrelation: event.evidence.baselineCorrelation,
    correctedCorrelation: event.evidence.correctedCorrelation,
    correlationGain: event.evidence.correlationGain,
    algorithmSources: [...event.evidence.algorithmSources],
    notes: [...event.evidence.notes],
    candidateIds: [...event.evidence.candidateIds],
});

const claimFromAudit = (
    event: DiagnosisEventAuditSnapshot,
    stage: OnlineUnifiedClaimStage,
    index: number,
): OnlineUnifiedEventClaim => ({
    claimId: `${stage}:audit:${index}:${event.eventType}:${event.startYear}:${event.endYear}`,
    stage,
    eventType: event.eventType,
    shiftYears: effectiveOnlineShift(event.eventType, event.shiftYears),
    startYear: event.startYear,
    endYear: event.endYear,
    topYear: event.topYear,
    confidence: event.confidenceLevel,
    score: finite(event.score),
    scoreMargin: finite(event.scoreMargin),
    lagBefore: event.lagBefore,
    lagAfter: event.lagAfter,
    samplePairs: finite(event.samplePairs),
    baselineCorrelation: event.baselineCorrelation,
    correctedCorrelation: event.correctedCorrelation,
    correlationGain: event.correlationGain,
    algorithmSources: [...event.algorithmSources],
    notes: [...event.notes],
    candidateIds: [],
});

const visitEvent = (
    event: DiagnosisEvent | undefined,
    stage: OnlineUnifiedClaimStage,
    output: OnlineUnifiedEventClaim[],
    eventSources?: OnlineUnifiedEventSource[],
): void => {
    if (!event) return;
    output.push(claimFromEvent(event, stage));
    eventSources?.push({ stage, event });
    event.operationAlternatives?.forEach((alternative) => visitEvent(
        alternative,
        stage,
        output,
        eventSources,
    ));
    visitEvent(
        event.interpretationAmbiguity?.alternative,
        stage,
        output,
        eventSources,
    );
};

const auditStageEvents = (
    audit: DiagnosisEventDecisionAudit,
): Array<[OnlineUnifiedClaimStage, DiagnosisEventAuditSnapshot[]]> => [
    ["candidate", audit.candidateProjectedEvents],
    ["detected", audit.detectedBeforeFusion],
    ["fused", audit.detectedAfterFusion],
    ["retained", audit.retainedAfterEndpointGuard],
    ["displayed", audit.displayedBeforeLocator],
    ["final", audit.finalEvents],
];

const appendBoundedAuditClaims = (
    audit: DiagnosisEventDecisionAudit,
    output: OnlineUnifiedEventClaim[],
): void => {
    const bounded = audit.stableBoundedPathEvidence;
    const events = bounded ? [
        bounded.selectedPathEvent,
        bounded.newestPathEvent,
        bounded.recoveredFrontier,
        bounded.nearExactPartialCheckpoint,
        bounded.terminalOperationAnchoredPartialCheckpoint,
        bounded.collapsedMissingFalsePartialCheckpoint,
        bounded.parsimoniousPartialCheckpoint,
        bounded.regularizedPartialConsensus,
        ...(bounded.nearPathProbes.stronger?.events ?? []),
        ...(bounded.nearPathProbes.regularized?.events ?? []),
        ...bounded.parsimoniousSinglePathProbes.defaultStronger,
        ...bounded.parsimoniousSinglePathProbes.defaultRegularized,
        ...bounded.parsimoniousSinglePathProbes.zeroTerminalStronger,
        ...bounded.parsimoniousSinglePathProbes.zeroTerminalRegularized,
        ...(bounded.conservativeStrongerPath?.events ?? []),
        ...(bounded.conservativeRegularizedPath?.events ?? []),
    ].filter((event): event is DiagnosisEventAuditSnapshot => event !== null) : [];
    events.forEach((event, index) => output.push(claimFromAudit(
        event,
        "boundedPath",
        index,
    )));
    const positive = audit.positiveUnitChainEvidence;
    if (positive) {
        [
            positive.nearCrossPenaltyFrontier,
            positive.regularizedCrossPenaltyFrontier,
            positive.singlePathFrontier,
        ].filter((event): event is DiagnosisEventAuditSnapshot => event !== null)
            .forEach((event, index) => output.push(claimFromAudit(
                event,
                "boundedPath",
                events.length + index,
            )));
    }
    audit.locatorDecisions?.forEach((decision, decisionIndex) => {
        [
            decision.preLocatorEvent,
            decision.proposedEvent,
            decision.selectedEvent,
        ].filter((event): event is DiagnosisEventAuditSnapshot => event !== null)
            .forEach((event, eventIndex) => output.push(claimFromAudit(
                event,
                "locator",
                decisionIndex * 3 + eventIndex,
            )));
    });
};

const deduplicateClaims = (
    claims: readonly OnlineUnifiedEventClaim[],
): OnlineUnifiedEventClaim[] => {
    const seen = new Set<string>();
    return claims.filter((claim) => {
        const key = [
            claim.stage,
            claim.eventType,
            claim.shiftYears,
            claim.startYear,
            claim.endYear,
            claim.topYear,
            claim.score.toFixed(8),
        ].join(":");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const claimWasProducedByOnlineUnifiedModel = (
    claim: OnlineUnifiedEventClaim,
): boolean => claim.algorithmSources.some((source) => (
    source.trim().toLowerCase().replace(/[-\s]+/g, "_") === "online_unified_model"
));

const deduplicateEventSources = (
    sources: readonly OnlineUnifiedEventSource[],
): OnlineUnifiedEventSource[] => {
    const seen = new Set<string>();
    return sources.filter(({ stage, event }) => {
        const key = [stage, event.id].join(":");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

export const buildOnlineUnifiedEvidenceBundle = (input: {
    diagnosis: CrossdatingDiagnosis;
    seriesId: string;
    operations: readonly OnlineUnifiedGridOperation[];
    dynamicSelection: OnlineUnifiedSelectionAnchor | null;
    unitSelection: OnlineUnifiedSelectionAnchor | null;
    rawGlobalLag: number;
    cofechaGlobalLag: number;
}): OnlineUnifiedEvidenceBundle | null => {
    const audit = input.diagnosis.eventDecisionAudits?.find(
        (candidate) => candidate.seriesId === input.seriesId,
    );
    if (!audit?.targetRange) return null;
    const claims: OnlineUnifiedEventClaim[] = [];
    const eventSources: OnlineUnifiedEventSource[] = [];
    input.diagnosis.events.forEach((event) => visitEvent(
        event,
        "strict",
        claims,
        eventSources,
    ));
    input.diagnosis.reviewEvents?.forEach((event) => visitEvent(
        event,
        "review",
        claims,
        eventSources,
    ));
    auditStageEvents(audit).forEach(([stage, events]) => {
        events.forEach((event, index) => claims.push(claimFromAudit(event, stage, index)));
    });
    appendBoundedAuditClaims(audit, claims);
    input.diagnosis.jointEventDecisions?.forEach((decision) => {
        if (decision.seriesId === input.seriesId && decision.event) {
            visitEvent(decision.event, "joint", claims, eventSources);
        }
    });
    return {
        schemaVersion: 1,
        evidenceVersion: ONLINE_UNIFIED_EVIDENCE_VERSION,
        seriesId: input.seriesId,
        targetRange: audit.targetRange,
        cofechaFlagged: audit.cofechaFlagged,
        referenceSourceCount: audit.referenceSourceCount,
        minimumReferenceDepth: audit.minimumReferenceDepth,
        medianReferenceDepth: audit.medianReferenceDepth,
        candidateCount: audit.candidateCount,
        candidateModeCount: audit.candidateModeCount,
        finalReason: audit.finalReason,
        pass: Object.fromEntries(Object.entries(audit.pass).flatMap(([key, value]) => (
            typeof value === "number" ? [[key, value]] : []
        ))),
        // The online model may run repeatedly while the same working data is open. Its previous
        // answer remains available as an executable interpretation source, but it must never be
        // fed back as evidence for the next answer. Otherwise the model can merely reproduce its
        // own earlier package instead of adjudicating the underlying lag/counterfactual evidence.
        claims: deduplicateClaims(claims.filter(
            (claim) => !claimWasProducedByOnlineUnifiedModel(claim),
        )),
        eventSources: deduplicateEventSources(eventSources),
        operations: [...input.operations],
        dynamicSelection: input.dynamicSelection,
        unitSelection: input.unitSelection,
        rawGlobalLag: input.rawGlobalLag,
        cofechaGlobalLag: input.cofechaGlobalLag,
    };
};

const average = (values: readonly number[]): number => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;

const median = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    const ordered = [...values].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 0
        ? (ordered[middle - 1]! + ordered[middle]!) / 2
        : ordered[middle]!;
};

const identityAllowed = (identity: OnlineUnifiedOperationIdentity): boolean => (
    identity.eventType === "noEvent"
    || identity.eventType === "missingRing"
    || identity.eventType === "falseRing"
    || (identity.eventType === "partialMove" && identity.shiftYears < -1)
    || (identity.eventType === "wholeSeriesMove" && identity.shiftYears < 0)
);

const normalizedRangePosition = (year: number, range: YearRange): number => (
    (year - range.startYear) / Math.max(1, range.endYear - range.startYear)
);

const sourceTokenPresent = (
    claim: OnlineUnifiedEventClaim,
    token: string,
): boolean => claim.algorithmSources.some((source) => source.toLowerCase().includes(token))
    || claim.notes.some((note) => note.toLowerCase().includes(token));

const featureToken = (value: string): string => value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

const noteCarriesAbsoluteCalendarPosition = (key: string): boolean => (
    /(^|_)(year|years|start|end|range|window|center|boundary)($|_)/.test(key)
);

const NUMERIC_NOTE_CACHE = new WeakMap<OnlineUnifiedEventClaim, Array<[string, number]>>();

const numericNoteEntries = (
    claim: OnlineUnifiedEventClaim,
): Array<[string, number]> => {
    const cached = NUMERIC_NOTE_CACHE.get(claim);
    if (cached) return cached;
    const entries = claim.notes.flatMap((note) => {
        const separator = note.indexOf("=");
        if (separator <= 0) return [];
        const key = featureToken(note.slice(0, separator));
        const value = Number(note.slice(separator + 1));
        if (!key || noteCarriesAbsoluteCalendarPosition(key) || !Number.isFinite(value)) {
            return [];
        }
        return [[key, value] as [string, number]];
    });
    NUMERIC_NOTE_CACHE.set(claim, entries);
    return entries;
};

const appendClaimNoteAggregates = (
    features: Record<string, number>,
    claims: readonly OnlineUnifiedEventClaim[],
    prefix: string,
): void => {
    const values = new Map<string, number[]>();
    claims.forEach((claim) => numericNoteEntries(claim).forEach(([key, value]) => {
        const existing = values.get(key);
        if (existing) existing.push(value);
        else values.set(key, [value]);
    }));
    values.forEach((entries, key) => {
        features[`${prefix}_${key}_max`] = Math.max(...entries);
        features[`${prefix}_${key}_mean`] = average(entries);
    });
};

const addRelativeFeatures = <Row extends { features: Record<string, number> }>(
    rows: Row[],
    featureNames: readonly string[],
): Row[] => {
    featureNames.forEach((featureName) => {
        const values = rows.map((row) => finite(row.features[featureName]));
        const mean = average(values);
        const variance = values.length > 1
            ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0)
                / (values.length - 1)
            : 0;
        const standard = Math.sqrt(Math.max(0, variance));
        const maximum = Math.max(...values);
        const ordered = [...values].sort((left, right) => left - right);
        const rankBounds = new Map<number, { first: number; last: number }>();
        ordered.forEach((value, index) => {
            const bounds = rankBounds.get(value);
            if (bounds) {
                bounds.last = index;
            } else {
                rankBounds.set(value, { first: index, last: index });
            }
        });
        rows.forEach((row, index) => {
            const value = values[index]!;
            const bounds = rankBounds.get(value) ?? { first: 0, last: 0 };
            row.features[`${featureName}__rank`] = ordered.length > 0
                ? ((bounds.first + bounds.last) / 2 + 1) / ordered.length
                : 0;
            row.features[`${featureName}__z`] = standard > 0
                ? Math.max(-8, Math.min(8, (value - mean) / standard))
                : 0;
            row.features[`${featureName}__winner_margin`] = standard > 0
                ? Math.max(-12, Math.min(0, (value - maximum) / standard))
                : 0;
        });
    });
    return rows;
};

const operationClaimFeatures = (
    bundle: OnlineUnifiedEvidenceBundle,
    identity: OnlineUnifiedOperationIdentity,
): Record<string, number> => {
    const claims = bundle.claims.filter((claim) => (
        claimIdentity(claim) === operationIdentity(identity)
    ));
    const stageCount = new Set(claims.map((claim) => claim.stage)).size;
    const correlationGains = claims.map((claim) => finite(claim.correlationGain));
    const grid = bundle.operations.find((operation) => (
        operationIdentity(operation) === operationIdentity(identity)
    ));
    const dynamicSelected = bundle.dynamicSelection !== null
        && operationIdentity(bundle.dynamicSelection) === operationIdentity(identity);
    const unitSelected = bundle.unitSelection !== null
        && operationIdentity(bundle.unitSelection) === operationIdentity(identity);
    const profilePeaks = grid?.profilePeaks ?? [];
    const profileYears = profilePeaks.map((peak) => peak.year);
    const features: Record<string, number> = {
        event_type_missingRing: Number(identity.eventType === "missingRing"),
        event_type_falseRing: Number(identity.eventType === "falseRing"),
        event_type_partialMove: Number(identity.eventType === "partialMove"),
        event_type_wholeSeriesMove: Number(identity.eventType === "wholeSeriesMove"),
        event_type_noEvent: Number(identity.eventType === "noEvent"),
        shift_years: identity.shiftYears,
        shift_magnitude: Math.abs(identity.shiftYears),
        shift_log_magnitude: Math.log1p(Math.abs(identity.shiftYears)),
        shift_negative: Number(identity.shiftYears < 0),
        shift_unit: Number(Math.abs(identity.shiftYears) === 1),
        cofecha_flagged: Number(bundle.cofechaFlagged),
        reference_source_count: bundle.referenceSourceCount,
        minimum_reference_depth: bundle.minimumReferenceDepth,
        median_reference_depth: bundle.medianReferenceDepth,
        diagnosis_candidate_count: bundle.candidateCount,
        diagnosis_candidate_mode_count: bundle.candidateModeCount,
        claim_count: claims.length,
        claim_stage_count: stageCount,
        claim_max_stage: Math.max(0, ...claims.map((claim) => STAGE_PRIORITY[claim.stage])),
        claim_max_score: Math.max(0, ...claims.map((claim) => claim.score)),
        claim_mean_score: average(claims.map((claim) => claim.score)),
        claim_max_margin: Math.max(0, ...claims.map((claim) => claim.scoreMargin)),
        claim_mean_margin: average(claims.map((claim) => claim.scoreMargin)),
        claim_max_confidence: Math.max(
            0,
            ...claims.map((claim) => CONFIDENCE_SCORE[claim.confidence]),
        ),
        claim_max_correlation_gain: Math.max(0, ...correlationGains),
        claim_mean_correlation_gain: average(correlationGains),
        claim_max_sample_pairs: Math.max(0, ...claims.map((claim) => claim.samplePairs)),
        claim_newest_top_fraction: Math.max(
            0,
            ...claims.flatMap((claim) => claim.topYear === null
                ? []
                : [normalizedRangePosition(claim.topYear, bundle.targetRange)]),
        ),
        claim_newest_end_fraction: Math.max(
            0,
            ...claims.map((claim) => normalizedRangePosition(
                claim.endYear,
                bundle.targetRange,
            )),
        ),
        grid_available: Number(grid !== undefined),
        grid_dynamic_score: finite(grid?.dynamicScore),
        grid_best_raw_gain: finite(grid?.bestRawGain),
        grid_best_difference_gain: finite(grid?.bestDifferenceGain),
        grid_best_combined_gain: finite(grid?.bestCombinedGain),
        grid_top_three_difference_gain: finite(grid?.topThreeDifferenceGain),
        grid_remote_difference_margin: finite(grid?.remoteDifferenceMargin),
        grid_baseline_lag: finite(grid?.baselineLag),
        grid_profile_peak_count: profilePeaks.length,
        grid_profile_peak_year_spread: profileYears.length > 0
            ? Math.max(...profileYears) - Math.min(...profileYears) : 0,
        grid_profile_peak_max_score: Math.max(
            0,
            ...profilePeaks.map((peak) => finite(peak.score)),
        ),
        grid_profile_peak_max_margin: Math.max(
            0,
            ...profilePeaks.map((peak) => finite(peak.remoteMargin)),
        ),
        dynamic_selected: Number(dynamicSelected),
        dynamic_score: dynamicSelected ? finite(bundle.dynamicSelection?.score) : 0,
        dynamic_score_margin: dynamicSelected
            ? finite(bundle.dynamicSelection?.scoreMargin) : 0,
        unit_selected: Number(unitSelected),
        unit_score: unitSelected ? finite(bundle.unitSelection?.score) : 0,
        unit_score_margin: unitSelected ? finite(bundle.unitSelection?.scoreMargin) : 0,
        distance_to_raw_global_lag: Math.abs(identity.shiftYears - bundle.rawGlobalLag),
        distance_to_cofecha_global_lag: Math.abs(
            identity.shiftYears - bundle.cofechaGlobalLag,
        ),
        raw_global_lag_match: Number(identity.shiftYears === bundle.rawGlobalLag),
        cofecha_global_lag_match: Number(identity.shiftYears === bundle.cofechaGlobalLag),
    };
    PROFILE_PEAK_SOURCES.forEach((source) => {
        const peak = profilePeaks.find((candidate) => candidate.source === source);
        features[`grid_profile_${source}_score`] = finite(peak?.score);
        features[`grid_profile_${source}_margin`] = finite(peak?.remoteMargin);
    });
    SOURCE_TOKENS.forEach((token) => {
        features[`source_${token}_claim_count`] = claims.filter(
            (claim) => sourceTokenPresent(claim, token),
        ).length;
    });
    const exactSources = new Set(claims.flatMap((claim) => claim.algorithmSources));
    exactSources.forEach((source) => {
        features[`source_exact_${featureToken(source)}_count`] = claims.filter(
            (claim) => claim.algorithmSources.includes(source),
        ).length;
    });
    appendClaimNoteAggregates(features, claims, "note");
    Object.entries(bundle.pass).forEach(([key, value]) => {
        features[`pass_${key}`] = value;
    });
    features[`final_reason_${bundle.finalReason}`] = 1;
    return features;
};

export const buildOnlineUnifiedOperationCandidates = (
    bundle: OnlineUnifiedEvidenceBundle,
): OnlineUnifiedOperationCandidate[] => {
    const identities = new Map<string, OnlineUnifiedOperationIdentity>();
    const add = (identity: OnlineUnifiedOperationIdentity): void => {
        if (identityAllowed(identity)) identities.set(operationIdentity(identity), identity);
    };
    add({ eventType: "noEvent", shiftYears: 0 });
    bundle.operations.forEach((operation) => {
        add(operation);
        if (operation.shiftYears < 0) {
            add({ eventType: "wholeSeriesMove", shiftYears: operation.shiftYears });
        }
    });
    bundle.claims.forEach(add);
    [-1, bundle.rawGlobalLag, bundle.cofechaGlobalLag].forEach((shiftYears) => {
        if (shiftYears < 0) add({ eventType: "wholeSeriesMove", shiftYears });
    });
    const rows = [...identities.values()].map((identity) => {
        const identityGroup = `${bundle.seriesId}|${operationIdentity(identity)}`;
        return {
            ...identity,
            packageId: `online-operation:${identityGroup}`,
            identityGroup,
            features: operationClaimFeatures(bundle, identity),
        };
    });
    const partialByShift = new Map(rows.filter((row) => (
        row.eventType === "partialMove" && row.shiftYears < -1
    )).map((row) => [row.shiftYears, row]));
    rows.forEach((row) => {
        if (row.eventType !== "wholeSeriesMove") return;
        const partial = partialByShift.get(row.shiftYears);
        if (!partial) return;
        row.features.same_shift_partial_grid_available = finite(
            partial.features.grid_available,
        );
        SAME_SHIFT_PARTIAL_GRID_FEATURES.forEach((name) => {
            row.features[`same_shift_partial_${name}`] = finite(
                partial.features[name],
            );
        });
    });
    return addRelativeFeatures(rows, OPERATION_NUMERIC_FEATURES);
};

const operationPrefilterFeature = (
    candidate: OnlineUnifiedOperationCandidate,
    name: string,
): number => finite(candidate.features[name]);

const operationPrefilterScore = (
    candidate: OnlineUnifiedOperationCandidate,
): number => operationPrefilterFeature(candidate, "claim_max_stage") * 4
    + Math.log1p(operationPrefilterFeature(candidate, "claim_count"))
    + operationPrefilterFeature(candidate, "claim_max_confidence")
    + operationPrefilterFeature(candidate, "grid_available") * 0.4
    + operationPrefilterFeature(candidate, "dynamic_selected") * 3
    + operationPrefilterFeature(candidate, "unit_selected") * 2
    + operationPrefilterFeature(candidate, "raw_global_lag_match") * 2.5
    + operationPrefilterFeature(candidate, "cofecha_global_lag_match") * 2.5
    + operationPrefilterFeature(candidate, "grid_dynamic_score") * 3;

/** Shared truth-blind operation shortlist used by frozen export and Tauri inference. */
export const shortlistOnlineUnifiedOperationCandidates = (
    candidates: readonly OnlineUnifiedOperationCandidate[],
): OnlineUnifiedOperationCandidate[] => {
    const ordered = [...candidates].sort((left, right) => (
        operationPrefilterScore(right) - operationPrefilterScore(left)
        || left.packageId.localeCompare(right.packageId)
    ));
    const family = [
        "noEvent",
        "missingRing",
        "falseRing",
        "partialMove",
        "wholeSeriesMove",
    ].flatMap((eventType) => ordered.filter(
        (candidate) => candidate.eventType === eventType,
    ).slice(0, 12));
    return [...new Map([...family, ...ordered.slice(0, 64)].map((candidate) => (
        [candidate.packageId, candidate]
    ))).values()];
};

type LocationAnchor = {
    year: number;
    source: string;
    score: number;
    margin: number;
    confidence: number;
    stage: number;
    correlationGain: number;
};

const locationAnchors = (
    bundle: OnlineUnifiedEvidenceBundle,
    identity: OnlineUnifiedOperationIdentity,
    includeProfilePeaks: boolean,
): LocationAnchor[] => {
    const key = operationIdentity(identity);
    const claims = bundle.claims.filter((claim) => claimIdentity(claim) === key);
    const output: LocationAnchor[] = claims.flatMap((claim) => {
        const years = new Set<number>();
        if (claim.topYear !== null) years.add(claim.topYear);
        years.add(Math.round((claim.startYear + claim.endYear) / 2));
        return [...years].map((year) => ({
            year,
            source: `${claim.stage} ${claim.algorithmSources.join(" ")}`,
            score: claim.score,
            margin: claim.scoreMargin,
            confidence: CONFIDENCE_SCORE[claim.confidence],
            stage: STAGE_PRIORITY[claim.stage],
            correlationGain: finite(claim.correlationGain),
        }));
    });
    const grid = bundle.operations.find((operation) => operationIdentity(operation) === key);
    if (grid) {
        output.push({
            year: grid.bestYear,
            source: "counterfactual grid",
            score: grid.dynamicScore,
            margin: grid.remoteDifferenceMargin,
            confidence: 0.7,
            stage: 0.5,
            correlationGain: grid.bestCombinedGain,
        });
        if (includeProfilePeaks) {
            (grid.profilePeaks ?? []).forEach((peak) => output.push({
                year: peak.year,
                source: `counterfactual profile ${peak.source}`,
                score: peak.score,
                margin: peak.remoteMargin,
                confidence: 0.7,
                stage: 0.52,
                correlationGain: peak.score,
            }));
        }
    }
    for (const [source, selection] of [
        ["dynamic", bundle.dynamicSelection],
        ["unit", bundle.unitSelection],
    ] as const) {
        if (selection && operationIdentity(selection) === key) {
            output.push({
                year: selection.bestYear,
                source,
                score: selection.score,
                margin: selection.scoreMargin,
                confidence: 0.8,
                stage: 0.6,
                correlationGain: 0,
            });
        }
    }
    return output;
};

const offsetWindow = (
    topYear: number,
    width: 5 | 7 | 9 | 13,
    topOffset: number,
    range: YearRange,
): { startYear: number; endYear: number } | null => {
    const startYear = topYear - topOffset;
    const endYear = startYear + width - 1;
    return startYear >= range.startYear && endYear <= range.endYear
        ? { startYear, endYear }
        : null;
};

const rangeOverlap = (
    left: { startYear: number; endYear: number },
    right: { startYear: number; endYear: number },
): number => Math.max(
    0,
    Math.min(left.endYear, right.endYear) - Math.max(left.startYear, right.startYear) + 1,
);

const locationWindowFeatures = (
    claims: readonly OnlineUnifiedEventClaim[],
    topYear: number,
    width: 5 | 7 | 9 | 13,
    startYear: number,
    endYear: number,
): Record<string, number> => {
    const overlaps = claims.map((claim) => rangeOverlap(
        { startYear, endYear },
        claim,
    ));
    const normalizedOverlaps = overlaps.map((overlap, index) => overlap / Math.max(
        width,
        claims[index]!.endYear - claims[index]!.startYear + 1,
    ));
    const topOffset = topYear - startYear;
    const features: Record<string, number> = {
        top_offset: topOffset,
        top_offset_fraction: topOffset / Math.max(1, width - 1),
        window_center_delta_top: (startYear + endYear) / 2 - topYear,
        claim_window_exact_count: claims.filter((claim) => (
            claim.startYear === startYear && claim.endYear === endYear
        )).length,
        claim_window_top_exact_count: claims.filter((claim) => (
            claim.startYear === startYear
            && claim.endYear === endYear
            && claim.topYear === topYear
        )).length,
        claim_window_max_overlap: Math.max(0, ...overlaps),
        claim_window_max_overlap_ratio: Math.max(0, ...normalizedOverlaps),
        claim_window_min_start_distance: claims.length > 0
            ? Math.min(...claims.map((claim) => Math.abs(claim.startYear - startYear)))
            : 99,
        claim_window_min_end_distance: claims.length > 0
            ? Math.min(...claims.map((claim) => Math.abs(claim.endYear - endYear)))
            : 99,
        claim_top_offset_match_count: claims.filter((claim) => (
            claim.topYear !== null && claim.topYear - claim.startYear === topOffset
        )).length,
    };
    const exactClaims = claims.filter((claim) => (
        claim.startYear === startYear && claim.endYear === endYear
    ));
    const overlappingClaims = claims.filter((claim) => rangeOverlap(
        { startYear, endYear },
        claim,
    ) >= Math.min(5, width));
    appendClaimNoteAggregates(features, exactClaims, "exact_window_note");
    appendClaimNoteAggregates(features, overlappingClaims, "overlap_window_note");
    return features;
};

const locationFeatures = (
    bundle: OnlineUnifiedEvidenceBundle,
    identity: OnlineUnifiedOperationIdentity,
    anchors: readonly LocationAnchor[],
    topYear: number,
    width: 5 | 7 | 9 | 13,
): Record<string, number> => {
    const distances = anchors.map((anchor) => Math.abs(anchor.year - topYear));
    const signedDistances = anchors.map((anchor) => topYear - anchor.year);
    const nearest = anchors.slice().sort((left, right) => (
        Math.abs(left.year - topYear) - Math.abs(right.year - topYear)
        || right.stage - left.stage
        || right.score - left.score
    ))[0];
    const grid = bundle.operations.find(
        (operation) => operationIdentity(operation) === operationIdentity(identity),
    );
    const dynamic = bundle.dynamicSelection
        && operationIdentity(bundle.dynamicSelection) === operationIdentity(identity)
        ? bundle.dynamicSelection : null;
    const unit = bundle.unitSelection
        && operationIdentity(bundle.unitSelection) === operationIdentity(identity)
        ? bundle.unitSelection : null;
    const profile = grid?.yearProfile?.find((row) => row.year === topYear);
    const features: Record<string, number> = {
        event_type_missingRing: Number(identity.eventType === "missingRing"),
        event_type_falseRing: Number(identity.eventType === "falseRing"),
        event_type_partialMove: Number(identity.eventType === "partialMove"),
        shift_years: identity.shiftYears,
        shift_magnitude: Math.abs(identity.shiftYears),
        width,
        width_5: Number(width === 5),
        width_7: Number(width === 7),
        width_9: Number(width === 9),
        width_13: Number(width === 13),
        year_fraction: normalizedRangePosition(topYear, bundle.targetRange),
        distance_from_oldest: topYear - bundle.targetRange.startYear,
        distance_from_newest: bundle.targetRange.endYear - topYear,
        claim_exact_count: distances.filter((distance) => distance === 0).length,
        claim_within_1_count: distances.filter((distance) => distance <= 1).length,
        claim_within_2_count: distances.filter((distance) => distance <= 2).length,
        claim_within_4_count: distances.filter((distance) => distance <= 4).length,
        claim_within_6_count: distances.filter((distance) => distance <= 6).length,
        claim_min_distance: distances.length > 0 ? Math.min(...distances) : 99,
        claim_median_distance: median(distances),
        claim_signed_median_distance: median(signedDistances),
        nearest_claim_score: nearest?.score ?? 0,
        nearest_claim_margin: nearest?.margin ?? 0,
        nearest_claim_confidence: nearest?.confidence ?? 0,
        nearest_claim_stage: nearest?.stage ?? 0,
        nearest_claim_correlation_gain: nearest?.correlationGain ?? 0,
        grid_distance: grid ? Math.abs(topYear - grid.bestYear) : 99,
        grid_exact: Number(grid?.bestYear === topYear),
        dynamic_distance: dynamic ? Math.abs(topYear - dynamic.bestYear) : 99,
        dynamic_exact: Number(dynamic?.bestYear === topYear),
        unit_distance: unit ? Math.abs(topYear - unit.bestYear) : 99,
        unit_exact: Number(unit?.bestYear === topYear),
        profile_raw_gain: finite(profile?.rawGain),
        profile_difference_gain: finite(profile?.differenceGain),
        profile_combined_gain: finite(profile?.combinedGain),
        profile_side_step_score: finite(profile?.sideStepScore),
        profile_side_minimum_advantage: finite(profile?.sideMinimumAdvantage),
        profile_corrected_side_support: finite(profile?.correctedSideSupport),
        ...profileShapeFeatures(grid?.yearProfile, topYear),
    };
    SOURCE_TOKENS.forEach((token) => {
        const matching = anchors.filter((anchor) => anchor.source.toLowerCase().includes(token));
        features[`source_${token}_within_2`] = matching.filter(
            (anchor) => Math.abs(anchor.year - topYear) <= 2,
        ).length;
        features[`source_${token}_within_6`] = matching.filter(
            (anchor) => Math.abs(anchor.year - topYear) <= 6,
        ).length;
    });
    if (nearest) {
        const nearestClaims = anchors
            .filter((anchor) => anchor.year === nearest.year)
            .flatMap((anchor) => bundle.claims.filter((claim) => (
                claimIdentity(claim) === operationIdentity(identity)
                && (claim.topYear === anchor.year
                    || Math.round((claim.startYear + claim.endYear) / 2) === anchor.year)
            )));
        appendClaimNoteAggregates(features, nearestClaims, "nearest_note");
    }
    return features;
};

export const buildOnlineUnifiedLocationPackages = (
    bundle: OnlineUnifiedEvidenceBundle,
    identity: OnlineUnifiedOperationIdentity,
    options?: {
        includeWindow?: (candidate: {
            topYear: number;
            width: 5 | 7 | 9 | 13;
            startYear: number;
            endYear: number;
        }) => boolean;
        /** Keep one executable review window per physical year for online inference. */
        compactWindowPerYear?: boolean;
        /** Candidate expansion is frozen with the model and must be enabled explicitly. */
        searchRadiusYears?: number;
        /** Profile peaks alter the candidate set and therefore require a matching model. */
        includeProfilePeaks?: boolean;
        /** Full yearly profiles are frozen with the location model. */
        includeYearProfile?: boolean;
    },
): OnlineUnifiedLocationPackage[] => {
    if (identity.eventType === "noEvent" || identity.eventType === "wholeSeriesMove") {
        return [];
    }
    const anchors = locationAnchors(
        bundle,
        identity,
        options?.includeProfilePeaks === true,
    );
    const profileOperation = bundle.operations.find((operation) => (
        operationIdentity(operation) === operationIdentity(identity)
    ));
    if (anchors.length === 0
        && !(options?.includeYearProfile === true
            && (profileOperation?.yearProfile?.length ?? 0) > 0)) return [];
    const identityClaims = bundle.claims.filter((claim) => (
        claimIdentity(claim) === operationIdentity(identity)
    ));
    const candidateYearSet = new Set<number>();
    const searchRadiusYears = Math.max(0, Math.floor(options?.searchRadiusYears ?? 13));
    anchors.forEach((anchor) => {
        for (let offset = -searchRadiusYears; offset <= searchRadiusYears; offset += 1) {
            const year = anchor.year + offset;
            if (year >= bundle.targetRange.startYear && year <= bundle.targetRange.endYear) {
                candidateYearSet.add(year);
            }
        }
    });
    if (options?.includeYearProfile === true) {
        profileOperation?.yearProfile?.forEach((row) => {
            if (row.year >= bundle.targetRange.startYear
                && row.year <= bundle.targetRange.endYear) {
                candidateYearSet.add(row.year);
            }
        });
    }
    const candidateYears = [...candidateYearSet].sort((left, right) => left - right);
    const widths = [5, 7, 9, 13] as const;
    const identityGroup = `${bundle.seriesId}|${operationIdentity(identity)}`;
    const yearRows = addRelativeFeatures(candidateYears.map((topYear) => ({
        ...identity,
        packageId: `online-location-year:${identityGroup}:${topYear}`,
        identityGroup,
        startYear: topYear,
        endYear: topYear,
        topYear,
        width: 13 as const,
        features: locationFeatures(bundle, identity, anchors, topYear, 13),
    })), LOCATION_NUMERIC_FEATURES);
    const materialize = (
        yearRow: (typeof yearRows)[number],
        width: 5 | 7 | 9 | 13,
        window: { startYear: number; endYear: number },
    ): OnlineUnifiedLocationPackage => ({
        ...yearRow,
        packageId: [
            "online-location",
            identityGroup,
            yearRow.topYear,
            window.startYear,
            window.endYear,
        ].join(":"),
        ...window,
        width,
        features: {
            ...yearRow.features,
            width,
            width_5: Number(width === 5),
            width_7: Number(width === 7),
            width_9: Number(width === 9),
            width_13: Number(width === 13),
            ...locationWindowFeatures(
                identityClaims,
                yearRow.topYear,
                width,
                window.startYear,
                window.endYear,
            ),
        },
    });
    const windowOptions = (yearRow: (typeof yearRows)[number]) => widths.flatMap(
        (width) => Array.from(
            { length: width },
            (_, topOffset) => topOffset,
        ).flatMap((topOffset) => {
            const { topYear } = yearRow;
            const window = offsetWindow(
                topYear,
                width,
                topOffset,
                bundle.targetRange,
            );
            if (!window) return [];
            if (options?.includeWindow && !options.includeWindow({
                topYear,
                width,
                startYear: window.startYear,
                endYear: window.endYear,
            })) return [];
            const overlaps = identityClaims.map((claim) => rangeOverlap(window, claim));
            return [{
                width,
                ...window,
                topExactCount: identityClaims.filter((claim) => (
                    claim.startYear === window.startYear
                    && claim.endYear === window.endYear
                    && claim.topYear === topYear
                )).length,
                exactCount: identityClaims.filter((claim) => (
                    claim.startYear === window.startYear
                    && claim.endYear === window.endYear
                )).length,
                maximumOverlapRatio: Math.max(0, ...overlaps.map((overlap, index) => (
                    overlap / Math.max(
                        width,
                        identityClaims[index]!.endYear
                            - identityClaims[index]!.startYear + 1,
                    )
                ))),
                centerDistance: Math.abs(
                    (window.startYear + window.endYear) / 2 - topYear,
                ),
            }];
        }),
    );
    if (options?.compactWindowPerYear !== false) {
        return yearRows.flatMap((yearRow) => {
            const selected = windowOptions(yearRow).sort((left, right) => (
                right.topExactCount - left.topExactCount
                || right.exactCount - left.exactCount
                || right.maximumOverlapRatio - left.maximumOverlapRatio
                || right.width - left.width
                || left.centerDistance - right.centerDistance
                || left.startYear - right.startYear
            ))[0];
            return selected
                ? [materialize(yearRow, selected.width, selected)]
                : [];
        });
    }
    const packages = yearRows.flatMap((yearRow) => windowOptions(yearRow).map(
        (window) => materialize(yearRow, window.width, window),
    ));
    return [...new Map(packages.map((candidate) => (
        [candidate.packageId, candidate]
    ))).values()];
};

const locationPrefilterFeature = (
    candidate: OnlineUnifiedLocationPackage,
    name: string,
): number => finite(candidate.features[name]);

const locationPrefilterScore = (
    candidate: OnlineUnifiedLocationPackage,
): number => locationPrefilterFeature(candidate, "claim_exact_count") * 6
    + locationPrefilterFeature(candidate, "claim_within_2_count") * 2
    + locationPrefilterFeature(candidate, "claim_within_6_count")
    + locationPrefilterFeature(candidate, "claim_window_top_exact_count") * 12
    + locationPrefilterFeature(candidate, "claim_window_exact_count") * 8
    + locationPrefilterFeature(candidate, "claim_window_max_overlap_ratio") * 3
    + locationPrefilterFeature(candidate, "grid_exact") * 4
    + locationPrefilterFeature(candidate, "dynamic_exact") * 3
    + locationPrefilterFeature(candidate, "unit_exact") * 2
    - locationPrefilterFeature(candidate, "claim_min_distance") * 0.2;

/** Shared truth-blind shortlist used by both frozen-data export and Tauri inference. */
export const shortlistOnlineUnifiedLocationPackages = (
    candidates: readonly OnlineUnifiedLocationPackage[],
    limit = 128,
): OnlineUnifiedLocationPackage[] => [...candidates].sort((left, right) => {
    return locationPrefilterScore(right) - locationPrefilterScore(left)
        || left.packageId.localeCompare(right.packageId);
}).slice(0, limit);

export const onlineUnifiedFeatureVector = (
    features: Readonly<Record<string, number>>,
    names: readonly string[],
): number[] => names.map((name) => finite(features[name]));

const nearestExecutableClaim = (
    bundle: OnlineUnifiedEvidenceBundle,
    identity: OnlineUnifiedOperationIdentity,
    topYear: number | null,
): OnlineUnifiedEventClaim | undefined => bundle.claims
    .filter((claim) => claimIdentity(claim) === operationIdentity(identity))
    .sort((left, right) => {
        const leftYear = left.topYear ?? Math.round((left.startYear + left.endYear) / 2);
        const rightYear = right.topYear ?? Math.round((right.startYear + right.endYear) / 2);
        const leftDistance = topYear === null ? 0 : Math.abs(leftYear - topYear);
        const rightDistance = topYear === null ? 0 : Math.abs(rightYear - topYear);
        return leftDistance - rightDistance
            || STAGE_PRIORITY[right.stage] - STAGE_PRIORITY[left.stage]
            || right.score - left.score;
    })[0];

const packageConfidence = (
    claim: OnlineUnifiedEventClaim | undefined,
    scoreMargin: number,
): DiagnosisConfidence => {
    if (claim?.confidence === "high" && scoreMargin >= 0.05) return "high";
    if (claim?.confidence !== "low" || scoreMargin >= 0.02) return "medium";
    return "low";
};

const VALID_LOCAL_WINDOW_WIDTHS = new Set([5, 7, 9, 13]);

const eventSourceDistance = (
    event: DiagnosisEvent,
    topYear: number | null,
): number => {
    if (topYear === null) return 0;
    const sourceTop = topYearOf(event)
        ?? Math.round((event.startYear + event.endYear) / 2);
    return Math.abs(sourceTop - topYear);
};

const automaticEventIdentityAllowed = (event: DiagnosisEvent): boolean => identityAllowed({
    eventType: event.eventType,
    shiftYears: effectiveOnlineShift(event.eventType, event.shiftYears),
});

const sourceEventIsPackageCompatible = (
    event: DiagnosisEvent,
    bundle: OnlineUnifiedEvidenceBundle,
): boolean => {
    if (event.seriesId !== bundle.seriesId
        || event.stale === true
        || !automaticEventIdentityAllowed(event)) return false;
    if (event.eventType === "wholeSeriesMove") return true;
    const width = event.endYear - event.startYear + 1;
    return VALID_LOCAL_WINDOW_WIDTHS.has(width)
        && event.startYear >= bundle.targetRange.startYear
        && event.endYear <= bundle.targetRange.endYear
        && event.rankedYears.some((row) => (
            row.year >= event.startYear && row.year <= event.endYear
        ));
};

const cloneAmbiguityEvidence = (
    ambiguity: DiagnosisEventInterpretationAmbiguity,
): DiagnosisEventInterpretationAmbiguity["evidence"] => {
    if (ambiguity.kind === "missingRingsOrPartialMove") {
        if (ambiguity.evidence.interpretationBasis === "frozenConditionalMissingReview") {
            return { ...ambiguity.evidence, missingYears: [...ambiguity.evidence.missingYears] };
        }
        return {
            ...ambiguity.evidence,
            missingYears: [...ambiguity.evidence.missingYears],
            virtualCountEvaluation: ambiguity.evidence.virtualCountEvaluation ? {
                ...ambiguity.evidence.virtualCountEvaluation,
                years: [...ambiguity.evidence.virtualCountEvaluation.years],
            } : undefined,
            completedComposition: ambiguity.evidence.completedComposition
                ? { ...ambiguity.evidence.completedComposition }
                : undefined,
        };
    }
    if (ambiguity.kind === "sequentialOperationRecovery") {
        return { ...ambiguity.evidence };
    }
    return {
        ...ambiguity.evidence,
        finalEvidenceClaims: [...ambiguity.evidence.finalEvidenceClaims],
    };
};

const cloneExecutableEquivalentEvent = (
    source: DiagnosisEvent,
    bundle: OnlineUnifiedEvidenceBundle,
    packageId: string,
    depth: number,
    visited: Set<DiagnosisEvent>,
): DiagnosisEvent | null => {
    if (depth > 3
        || visited.has(source)
        || !sourceEventIsPackageCompatible(source, bundle)) return null;
    const nextVisited = new Set(visited);
    nextVisited.add(source);
    const sourceAmbiguity = source.interpretationAmbiguity;
    const clonedAlternative = sourceAmbiguity
        ? cloneExecutableEquivalentEvent(
            sourceAmbiguity.alternative,
            bundle,
            packageId,
            depth + 1,
            nextVisited,
        )
        : null;
    const ambiguity = sourceAmbiguity && clonedAlternative ? {
        kind: sourceAmbiguity.kind,
        alternative: clonedAlternative,
        evidence: cloneAmbiguityEvidence(sourceAmbiguity),
    } as DiagnosisEventInterpretationAmbiguity : undefined;
    const sourceTop = topYearOf(source);
    const event: DiagnosisEvent = {
        ...source,
        id: [
            packageId,
            "interpretation",
            depth,
            source.eventType,
            sourceTop ?? "whole",
        ].join(":"),
        rankedYears: source.rankedYears
            .filter((row) => row.year >= source.startYear && row.year <= source.endYear)
            .map((row) => ({ ...row, evidenceTags: [...row.evidenceTags] })),
        reviewCoreRange: source.reviewCoreRange
            ? { ...source.reviewCoreRange }
            : undefined,
        alternativeTypes: ambiguity
            ? [ambiguity.alternative.eventType]
            : [],
        locationAlternatives: undefined,
        operationAlternatives: undefined,
        interpretationAmbiguity: ambiguity,
        seriesRange: { ...bundle.targetRange },
        stale: false,
        evidence: {
            ...source.evidence,
            algorithmSources: [...new Set([
                ...source.evidence.algorithmSources,
                "online_unified_equivalent_interpretation",
            ])],
            candidateIds: [],
            notes: [...new Set([
                ...source.evidence.notes,
                "equivalent_interpretation_package=" + packageId,
            ])],
            locationEvidence: source.evidence.locationEvidence?.map((entry) => ({
                ...entry,
            })),
        },
    };
    if (event.eventType === "missingRing" || event.eventType === "falseRing") {
        delete event.shiftYears;
        delete event.shiftSide;
    }
    return event;
};

const matchingInterpretationSource = (
    bundle: OnlineUnifiedEvidenceBundle,
    identity: OnlineUnifiedOperationIdentity,
    topYear: number | null,
): OnlineUnifiedEventSource | null => (
    bundle.eventSources ?? []
).filter(({ event }) => (
    sourceEventIsPackageCompatible(event, bundle)
    && event.interpretationAmbiguity !== undefined
    && event.eventType === identity.eventType
    && effectiveOnlineShift(event.eventType, event.shiftYears) === identity.shiftYears
)).sort((left, right) => (
    eventSourceDistance(left.event, topYear) - eventSourceDistance(right.event, topYear)
    || STAGE_PRIORITY[right.stage] - STAGE_PRIORITY[left.stage]
    || right.event.evidence.score - left.event.evidence.score
))[0] ?? null;

const attachFallbackMissingInterpretation = (
    partial: DiagnosisEvent,
    bundle: OnlineUnifiedEvidenceBundle,
): DiagnosisEvent => {
    if (partial.eventType !== "partialMove"
        || (partial.shiftYears ?? 0) >= -1
        || partial.interpretationAmbiguity) return partial;
    const firstFixedYear = topYearOf(partial)
        ?? Math.round((partial.startYear + partial.endYear) / 2);
    const missingYear = Math.max(
        partial.startYear,
        Math.min(partial.endYear, firstFixedYear - 1),
    );
    const missing: DiagnosisEvent = {
        ...partial,
        id: [
            partial.id,
            "interpretation",
            "missingRing",
            missingYear,
        ].join(":"),
        eventType: "missingRing",
        rankedYears: [{
            year: missingYear,
            rank: 1,
            score: partial.evidence.score,
            evidenceTags: ["online_unified_partial_boundary_fallback"],
        }],
        alternativeTypes: [],
        interpretationAmbiguity: undefined,
        shiftYears: undefined,
        shiftSide: undefined,
        reviewOnly: true,
        evidence: {
            ...partial.evidence,
            algorithmSources: [...new Set([
                ...partial.evidence.algorithmSources,
                "online_unified_partial_boundary_fallback",
            ])],
            lagBefore: -1,
            lagAfter: 0,
            candidateIds: [],
            notes: [...new Set([
                ...partial.evidence.notes,
                "interpretation=discrete_missing_ring_frontier",
                "interpretation_count=cumulative_lag_only",
            ])],
        },
    };
    return attachMissingPartialInterpretation(partial, missing, {
        interpretationBasis: "virtualSequentialFrontier",
        missingRingCount: Math.abs(partial.shiftYears!),
        cumulativeShiftYears: partial.shiftYears!,
        missingYears: [],
        partialFirstFixedYear: firstFixedYear,
        normalizedCounterfactualGainDifference: 0,
        masterMargin: 0,
        referenceMedianMargin: 0,
        referenceCount: bundle.referenceSourceCount,
        missingReferenceSupport: 0,
        partialReferenceSupport: 0,
        countEvidence: "cumulativeLagOnly",
        frontierYear: missingYear,
        frontierLocalization: "partialBoundaryFallback",
    });
};

const bestFallbackLocalSource = (
    bundle: OnlineUnifiedEvidenceBundle,
    wholeShiftYears: number,
): OnlineUnifiedEventSource | null => (
    bundle.eventSources ?? []
).filter(({ event }) => (
    sourceEventIsPackageCompatible(event, bundle)
    && (
        event.eventType === "partialMove"
        || event.eventType === "missingRing"
    )
)).sort((left, right) => {
    const leftPartial = Number(left.event.eventType === "partialMove");
    const rightPartial = Number(right.event.eventType === "partialMove");
    const leftExactPartial = Number(
        left.event.eventType === "partialMove" && left.event.shiftYears === wholeShiftYears,
    );
    const rightExactPartial = Number(
        right.event.eventType === "partialMove" && right.event.shiftYears === wholeShiftYears,
    );
    return rightExactPartial - leftExactPartial
        || rightPartial - leftPartial
        || STAGE_PRIORITY[right.stage] - STAGE_PRIORITY[left.stage]
        || right.event.evidence.scoreMargin - left.event.evidence.scoreMargin
        || right.event.evidence.score - left.event.evidence.score
        || (topYearOf(right.event) ?? Number.NEGATIVE_INFINITY)
            - (topYearOf(left.event) ?? Number.NEGATIVE_INFINITY)
        || right.event.startYear - left.event.startYear;
})[0] ?? null;

const attachExecutableInterpretations = (
    primary: DiagnosisEvent,
    bundle: OnlineUnifiedEvidenceBundle,
    identity: OnlineUnifiedOperationIdentity,
    topYear: number | null,
): DiagnosisEvent => {
    const source = matchingInterpretationSource(bundle, identity, topYear);
    const sourceAmbiguity = source?.event.interpretationAmbiguity;
    const clonedAlternative = sourceAmbiguity
        ? cloneExecutableEquivalentEvent(
            sourceAmbiguity.alternative,
            bundle,
            primary.id,
            1,
            new Set(source ? [source.event] : []),
        )
        : null;
    const completedAlternative = clonedAlternative?.eventType === "partialMove"
        ? attachFallbackMissingInterpretation(clonedAlternative, bundle)
        : clonedAlternative;
    if (primary.eventType === "wholeSeriesMove" && (primary.shiftYears ?? 0) < 0) {
        const localSource = bestFallbackLocalSource(bundle, primary.shiftYears!);
        const clonedLocal = localSource
            ? cloneExecutableEquivalentEvent(
                localSource.event,
                bundle,
                primary.id,
                1,
                new Set(source ? [source.event] : []),
            )
            : null;
        const completedLocal = clonedLocal?.eventType === "partialMove"
            ? attachFallbackMissingInterpretation(clonedLocal, bundle)
            : clonedLocal;
        // A local event owns its own operation identity. Requiring it to copy the whole-series
        // shift discarded validated large-gap breakpoints and exposed only their unit-event
        // children. The model's primary answer is unchanged; this only completes its review package.
        const local = completedAlternative?.eventType === "partialMove"
            ? completedAlternative
            : completedLocal?.eventType === "partialMove"
                ? completedLocal
                : completedAlternative
                    ?? completedLocal
                    ?? makeEndpointMissingReviewFromWhole(primary);
        if (!local) return primary;
        return {
            ...attachWholeLocalEventInterpretation(primary, local, {
                wholeShiftYears: primary.shiftYears!,
                localEventType: local.eventType as Exclude<
                    DiagnosisEventType,
                    "wholeSeriesMove"
                >,
                localWindowWidth: (
                    local.endYear - local.startYear + 1
                ) as 5 | 7 | 9 | 13,
                localEvidenceSource: local === completedLocal || local === completedAlternative
                    ? "diagnosed"
                    : "syntheticEndpointReview",
                operationScoreMargin: primary.evidence.scoreMargin,
                finalEvidenceClaims: [],
            }),
            alternativeTypes: [local.eventType],
        };
    }
    if (sourceAmbiguity && completedAlternative) {
        return {
            ...primary,
            alternativeTypes: [completedAlternative.eventType],
            interpretationAmbiguity: {
                kind: sourceAmbiguity.kind,
                alternative: completedAlternative,
                evidence: cloneAmbiguityEvidence(sourceAmbiguity),
            } as DiagnosisEventInterpretationAmbiguity,
        };
    }
    if (primary.eventType === "partialMove") {
        return attachFallbackMissingInterpretation(primary, bundle);
    }
    return primary;
};

/**
 * Materializes the model choice into a self-contained event. Applying this event
 * never needs to find a legacy event or candidate with the same identity.
 */
export const buildOnlineUnifiedExecutablePackage = (input: {
    bundle: OnlineUnifiedEvidenceBundle;
    candidate: OnlineUnifiedOperationCandidate | OnlineUnifiedLocationPackage;
    score: number;
    scoreMargin: number;
    modelVersion?: string;
    /** A frozen model supplies its own directed review; never synthesize a chain. */
    interpretationPolicy?: "legacy" | "model-owned";
}): OnlineUnifiedExecutablePackage | null => {
    const { bundle, candidate, score, scoreMargin } = input;
    if (candidate.eventType === "noEvent") return null;
    const isLocation = "topYear" in candidate;
    const topYear = isLocation ? candidate.topYear : null;
    const startYear = isLocation ? candidate.startYear : bundle.targetRange.startYear;
    const endYear = isLocation ? candidate.endYear : bundle.targetRange.endYear;
    const claim = nearestExecutableClaim(bundle, candidate, topYear);
    const eventType = candidate.eventType;
    const event: DiagnosisEvent = {
        id: candidate.packageId,
        seriesId: bundle.seriesId,
        eventType,
        startYear,
        endYear,
        rankedYears: topYear === null ? [] : [{
            year: topYear,
            rank: 1,
            score,
            evidenceTags: ["online_unified_model"],
        }],
        confidenceLevel: packageConfidence(claim, scoreMargin),
        evidence: {
            algorithmSources: [...new Set([
                ...(claim?.algorithmSources ?? []),
                "online_unified_model",
            ])],
            score,
            scoreMargin,
            baselineCorrelation: claim?.baselineCorrelation ?? null,
            correctedCorrelation: claim?.correctedCorrelation ?? null,
            correlationGain: claim?.correlationGain ?? null,
            lagBefore: claim?.lagBefore ?? null,
            lagAfter: claim?.lagAfter ?? null,
            samplePairs: claim?.samplePairs ?? 0,
            candidateIds: [],
            notes: [
                ...(claim?.notes ?? []),
                `authoritative_model=${input.modelVersion ?? ONLINE_UNIFIED_MODEL_VERSION}`,
                `authoritative_identity=${candidate.identityGroup}`,
                `authoritative_package=${candidate.packageId}`,
                "executable_package=self_contained",
            ],
        },
        alternativeTypes: [],
        shiftYears: eventType === "missingRing" || eventType === "falseRing"
            ? undefined
            : candidate.shiftYears,
        shiftSide: eventType === "partialMove" ? "older" : undefined,
        seriesRange: { ...bundle.targetRange },
        reviewOnly: false,
        stale: false,
    };
    const executableEvent = input.interpretationPolicy === "model-owned" ? event : attachExecutableInterpretations(
        event,
        bundle,
        candidate,
        topYear,
    );
    return {
        packageId: candidate.packageId,
        identityGroup: candidate.identityGroup,
        event: executableEvent,
    };
};
