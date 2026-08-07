import type {
    DiagnosisEvent,
    DiagnosisEventDecisionAudit,
    DiagnosisReviewWindowDecision,
} from "@/features/crossdating/diagnosis/types";

export type LegacyTruthQuality =
    | "exact-injected"
    | "natural-confirmed"
    | "weak-natural"
    | "negative-clean";

export type LegacyTruthSpec = {
    truthId: string;
    eventType: DiagnosisEvent["eventType"];
    year: number | null;
    shiftYears: number;
    observationId: string;
};

export type LegacyScenarioPlan = {
    scenarioId: string;
    kind: string;
    truthQuality: LegacyTruthQuality;
    eventComplexity: string;
    targetId: string;
    saveReopenPair: boolean;
    truths: LegacyTruthSpec[];
    parameters: Record<string, unknown>;
};

export type LegacyTargetPlan = {
    targetId: string;
    startYear: number;
    endYear: number;
    seriesLength: number;
    zeroCount: number;
    referenceCount: number;
    scenarios: LegacyScenarioPlan[];
};

export type LegacyFilePlan = {
    fileId: string;
    role: "external-pilot" | "external-full";
    source: string;
    path: string;
    relativePath: string;
    sha256: string;
    rwlFormat: string;
    seriesCount: number;
    usableTargetCount: number;
    chronologyRange: { startYear: number; endYear: number };
    truthQuality: LegacyTruthQuality[];
    developmentExposure: "known" | "unknown" | "none";
    developmentExposureNote: string;
    cleanBaselineAvailable: boolean;
    referenceAvailable: boolean;
    cofechaAvailable: boolean;
    unavailableReason: string | null;
    negativeTargetIds: string[];
    targets: LegacyTargetPlan[];
};

export type LegacyDirectedRegression = {
    fileId: string;
    source: string;
    path: string;
    sha256: string;
    truthQuality: LegacyTruthQuality;
    developmentExposure: "known" | "unknown" | "none";
    targetId: string;
    purpose: string;
    testPath: string;
    truthYears?: number[];
    expectedFirstFixedYear?: number;
    expectedShiftYears?: number;
};

export type LegacyManifest = {
    schemaVersion: number;
    protocolVersion: string;
    gitCommit: string;
    configPath: string;
    configHash: string;
    createdBeforeExternalEvaluation: boolean;
    selection: Record<string, unknown>;
    inputHashes: Record<string, string>;
    files: LegacyFilePlan[];
    directedRegressions: LegacyDirectedRegression[];
};

export type LegacyConfig = {
    schemaVersion: number;
    protocolVersion: string;
    frozenDate: string;
    gitCommit: string;
    seed: string;
    paths: Record<string, string>;
    expectedHashes: Record<string, string>;
    legacy: {
        reviewDisplayMode: "review";
        allowedWindowWidths: number[];
        includeEventDecisionAudits: boolean;
        targetExcludedFromReference: boolean;
        referenceFallback: string;
        fifo: {
            scope: string;
            primaryOrder: string;
            tieBreakers: string[];
            truthBlindQueue: boolean;
            maximumApplicationsPerRound: number;
        };
    };
    selection: Record<string, unknown>;
    injection: {
        falseRingMode: "average" | "moderate" | "splitLike";
        partialMoveShiftYears: number;
        contiguousBlockShiftYears: number;
        wholeSeriesShiftYears: number;
        multiDiscreteMissingCounts: number[];
        minimumDiscreteSpacingYears: number;
        endpointNewerDistanceYears: number;
        cropOlderYears: number;
        compositeWholeSeriesShiftYears: number;
        compositePartialShiftYears: number;
        scenarioOrder: string[];
        serialScenarioOrder: string[];
    };
    qualityBins: Record<string, number[]>;
    runtime: {
        workers: number;
        maxRounds: number;
        checkpointEveryFiles: number;
        heartbeatSeconds: number;
        workerTimeoutMinutes: number;
        cofechaTimeoutSeconds: number;
        bootstrapReplicates: number;
        bootstrapSeed: number;
    };
    acceptance: Record<string, number>;
    co612Reproduction: Record<string, number | null>;
    productionProtection: {
        baselineCommit: string;
        protectedPaths: string[];
        allowedNewTestPathFragment: string;
    };
};

export type LegacyQualityMetrics = {
    leaveOneOutCorrelation: number | null;
    fileInterseriesCorrelationMedian: number | null;
    fileInterseriesCorrelationIqr: number | null;
    validOverlapYears: number;
    effectiveReferenceSourceCount: number;
    referenceDepthMedian: number | null;
    referenceDepthMinimum: number | null;
    segmentCorrelationMedian: number | null;
    segmentCorrelationIqr: number | null;
    segmentStability: number | null;
    cofechaPassAnchorRatio: number | null;
    zeroMissingDensity: number;
    discreteZeroCount: number;
    longestZeroMissingBlock: number;
    seriesLength: number;
    identifiability: "absolute-identifiable" | "absolute-unidentifiable" | "unknown";
    unavailableReason: string | null;
};

export type LegacyDiagnosisSnapshot = {
    strictEvent: DiagnosisEvent | null;
    reviewEvent: DiagnosisEvent | null;
    candidates: Array<Record<string, unknown>>;
    audit: DiagnosisEventDecisionAudit | null;
    reviewDecision: DiagnosisReviewWindowDecision | null;
    referenceMode: "cofecha-pass-leave-one-out" | "cofecha-master-leave-one-out";
    referenceAnchorCount: number;
    durationMs: number;
    error: string | null;
};

export type LegacyCaseRow = {
    caseId: string;
    fileId: string;
    relativePath: string;
    source: string;
    developmentExposure: string;
    seriesId: string;
    scenarioId: string;
    scenarioKind: string;
    scenarioPair: "before-save" | "after-reopen";
    truthQuality: LegacyTruthQuality;
    eventComplexity: string;
    truthId: string | null;
    truthEventType: DiagnosisEvent["eventType"] | null;
    truthYear: number | null;
    truthShiftYears: number | null;
    absoluteIdentifiable: boolean;
    response: boolean;
    eventCount: number;
    predictedType: DiagnosisEvent["eventType"] | null;
    predictedShiftYears: number | null;
    typeCorrect: boolean | null;
    shiftCorrect: boolean | null;
    operationCorrect: boolean | null;
    windowApplicable: boolean;
    windowCovered: boolean | null;
    top1Exact: boolean | null;
    topYear: number | null;
    windowStart: number | null;
    windowEnd: number | null;
    windowWidth: number | null;
    breakpointError: number | null;
    saveReopenStable: boolean | null;
    strictResponse: boolean;
    reviewResponse: boolean;
    refusalReason: string | null;
    referenceMode: string;
    referenceAnchorCount: number;
    referenceSourceCount: number | null;
    minimumReferenceDepth: number | null;
    medianReferenceDepth: number | null;
    cofechaFlagged: boolean;
    elapsedMs: number;
    quality: LegacyQualityMetrics;
    error: string | null;
};

export type LegacyEventRow = {
    caseId: string;
    fileId: string;
    seriesId: string;
    scenarioId: string;
    scenarioPair: "before-save" | "after-reopen";
    sourceLayer: "strict" | "review";
    event: DiagnosisEvent;
};

export type LegacySerialRound = {
    fileId: string;
    relativePath: string;
    scenarioId: string;
    round: number;
    currentSeries: string | null;
    currentTruthId: string | null;
    remainingEvents: number;
    recoveredEvents: number;
    activeSeries: number;
    reviewQueueSize: number;
    selectedTruthId: string | null;
    selectedSeriesId: string | null;
    selectedQueueEnteredRound: number | null;
    selectedOperationCorrect: boolean | null;
    selectedWindowCovered: boolean | null;
    selectedTop1Exact: boolean | null;
    cofechaFlaggedCount: number;
    referenceAnchorCount: number | null;
    durationMs: number;
    stateHashBefore: string;
    stateHashAfter: string;
    stopReason: string | null;
};

export type LegacySerialEventState = {
    truthId: string;
    fileId: string;
    seriesId: string;
    scenarioId: string;
    eventType: DiagnosisEvent["eventType"];
    truthYear: number | null;
    truthShiftYears: number;
    firstResponseRound: number | null;
    firstResponseOperationCorrect: boolean | null;
    firstResponseWindowCovered: boolean | null;
    firstResponseTop1Exact: boolean | null;
    firstCorrectWindowRound: number | null;
    firstQueueRound: number | null;
    confirmedRound: number | null;
    responseCount: number;
    directFrontierFailure: boolean;
    blockedByPriorEvent: boolean;
    top1AtConfirmation: boolean | null;
    windowWidthAtConfirmation: number | null;
    failureReason: string | null;
};

export type LegacyFileWorkerOutput = {
    schemaVersion: number;
    phase: "single" | "serial";
    fileId: string;
    sourceSha256Before: string;
    sourceSha256After: string;
    sourceMutationCount: number;
    qualityByTarget: Record<string, LegacyQualityMetrics>;
    cases: LegacyCaseRow[];
    events: LegacyEventRow[];
    serialRounds: LegacySerialRound[];
    serialEvents: LegacySerialEventState[];
    saveReopenDifferentialCount: number;
    errors: Array<{ scope: string; error: string }>;
    startedAt: string;
    completedAt: string;
    runtimeMs: number;
};

export type LegacyRunStatus = {
    schemaVersion: number;
    runId: string;
    gitCommit: string;
    configHash: string;
    manifestHash: string;
    pid: number;
    status: "PREPARING" | "RUNNING" | "COMPLETED" | "FAILED" | "STOPPED_AT_GATE";
    currentPhase: string | null;
    currentFile: string | null;
    completedFiles: number;
    totalFiles: number;
    currentRound: number | null;
    recoveredEvents: number;
    lastHeartbeatAt: string;
    outputDir: string;
    exitCode: number | null;
    failureReason: string | null;
};
