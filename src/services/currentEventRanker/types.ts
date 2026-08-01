export const CURRENT_EVENT_PROTOCOL_VERSION = "crossdating.current-event.v1" as const;
export const DEFAULT_CURRENT_EVENT_MODEL_ID = "current-event-range-v1.0.0" as const;
export const ADAPTIVE_CURRENT_EVENT_MODEL_ID = "current-event-adaptive-range-v1" as const;
export const RRF_CURRENT_EVENT_MODEL_ID = "current-event-missing-rrf-v1" as const;
export const SUPERSEDED_SINGLE_RANGE_MODEL_ID = "current-event-single-range-v1.1.0" as const;

export const migrateCurrentEventModelId = (modelId: string | null | undefined) => {
    if (modelId === SUPERSEDED_SINGLE_RANGE_MODEL_ID) {
        return ADAPTIVE_CURRENT_EVENT_MODEL_ID;
    }
    return modelId ?? DEFAULT_CURRENT_EVENT_MODEL_ID;
};

export type CurrentEventModelDescriptor = {
    id: string;
    displayName: string;
    description: string;
    bundleVersion: string;
    yearFeatureCount: number;
    rangeFeatureCount?: number | null;
    rangeReliabilityFeatureCount?: number | null;
    singleEventRange: boolean;
    adaptiveEventRange: boolean;
    deploymentVersion?: string | null;
    routeVersion?: string | null;
    operationScope: string[];
    existingZeroPolicy: "preserve" | "remove";
    topK: number;
    rangeRadius: number;
    maxConfirmations: number;
    manualOnly: boolean;
    diagnosticOnly: boolean;
    automaticWriteback: boolean;
    isDefault: boolean;
};

export const shouldRunCurrentEventAfterSave = (
    modelId: string,
    models: readonly CurrentEventModelDescriptor[],
) => !(models.find((model) => model.id === modelId)?.manualOnly
    ?? modelId === RRF_CURRENT_EVENT_MODEL_ID);

export type CurrentEventModelCatalog = {
    defaultModelId: string;
    models: CurrentEventModelDescriptor[];
};

export type CurrentEventConfirmedInsertion = {
    year: number;
};

export type CurrentEventRankRequest = {
    protocolVersion: typeof CURRENT_EVENT_PROTOCOL_VERSION;
    requestId: string;
    method: "rank_current_event";
    params: {
        rwlPath: string;
        targetSeriesId: string;
        existingZeroPolicy: "preserve" | "remove";
        confirmedInsertions: CurrentEventConfirmedInsertion[];
        topK: number;
        rangeRadius: number;
    };
};

export type CurrentEventSuggestionEvidence = {
    wholeSeriesCorrelationDelta?: number | null;
    localCorrelationDelta21?: number | null;
    localGlkDelta21?: number | null;
    masterNarrownessScore?: number | null;
    pathRank?: number | null;
    noneRank?: number | null;
    inferredLatestPathBase?: number | null;
};

export type CurrentEventSuggestion = {
    rank: number;
    centerYear: number;
    rangeStart: number;
    rangeEnd: number;
    rankingScore: number;
    baseRank?: number;
    rangePromoted?: boolean;
    legacyBinaryRank?: number;
    compressionRank?: number;
    evidence?: CurrentEventSuggestionEvidence;
};

export type CurrentEventRange = {
    startYear: number;
    endYear: number;
    centerYear: number;
    width: number;
    scope: "newest_unresolved_event";
    localizerScore: number;
    learnedScore?: number;
    intervalSoftmaxMass?: number;
    baseCenterRank: number;
    candidateCenterCount: number;
    scoreSemantics: string;
    adaptive?: boolean;
    shrunk?: boolean;
    windowPolicy?: "local_score_mass" | string;
    maxEnvelopeStart?: number;
    maxEnvelopeEnd?: number;
    evidencePeak?: number;
    evidenceMass?: number;
};

export type CurrentEventAdaptivePolicy = {
    mass_threshold: number;
    temperature: number;
    padding_years: number;
    min_core_width: number;
    peak_gate: number;
};

export type CurrentEventDescribeEventRange = {
    count: number;
    adaptive?: boolean;
    maxRadius: number;
    maxWidth: number;
    maxCenters: number;
    featureCount: number;
    scope: "newest_unresolved_event";
    adaptivePolicy?: CurrentEventAdaptivePolicy;
    reliabilityGate?: {
        independentFromYearGate: boolean;
        featureCount: number;
        threshold: number;
    };
};

export type CurrentEventDescribeResult = {
    protocolVersion: typeof CURRENT_EVENT_PROTOCOL_VERSION;
    bundleVersion: string;
    featureVariant: string;
    featureCount: number;
    candidatePool: "selected_top500";
    topK: number;
    eventRange?: CurrentEventDescribeEventRange;
    diagnosticOnly: boolean;
    automaticWriteback: boolean;
};

export type CurrentEventReliability = {
    accepted: boolean;
    score: number;
    threshold: number;
    semantics?: string;
    independentFromYearGate?: boolean;
};

export type CurrentEventResultState = {
    rwlPath?: string;
    targetSeriesId?: string;
    existingZeroPolicy?: string;
    confirmedInsertionsApplied?: number[];
    roundIndex?: number;
    targetStart?: number;
    targetEnd?: number;
    requestRangeRadiusIgnored?: number;
};

export type CurrentEventDiagnostics = {
    candidateCount?: number;
    referenceSeriesCount?: number;
    overlapYearCount?: number;
    baselineCorrelation?: number | null;
    hasNegativeLagSignal?: boolean;
    events?: Array<Record<string, unknown>>;
    eventRangeCandidateCount?: number;
};

export type CurrentEventRankResult = {
    status: "advice" | "range_advice" | "evidence_insufficient" | string;
    reasonCode?: string | null;
    message: string;
    routeVersion?: string;
    operationScope?: string | string[];
    eventRange?: CurrentEventRange | null;
    suggestions: CurrentEventSuggestion[];
    reliability?: CurrentEventReliability;
    yearReliability?: CurrentEventReliability;
    rangeReliability?: CurrentEventReliability;
    state?: CurrentEventResultState;
    diagnostics?: CurrentEventDiagnostics;
    scoreSemantics?: string | Record<string, string>;
    automaticWriteback?: boolean;
    diagnosticOnly?: boolean;
    elapsedMs?: number;
};

export type CurrentEventProtocolError = {
    code: string;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
};

export type CurrentEventRankResponse = {
    protocolVersion: typeof CURRENT_EVENT_PROTOCOL_VERSION;
    requestId: string | null;
    ok: boolean;
    result?: CurrentEventRankResult;
    error?: CurrentEventProtocolError;
};

export type CurrentEventTransportError = {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
};
