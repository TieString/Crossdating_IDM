import type { DiagnosisEventType } from "@/features/crossdating/diagnosis/types";

export type CapabilityFamily = "Clean" | "A" | "B" | "C" | "D";
export type CapabilityEvaluationMode = "sequentialFrontier";
export type CapabilityAcceptanceTier = "blocking" | "optionalSuccess";
export type CapabilityOperation = Extract<
    DiagnosisEventType,
    "missingRing" | "falseRing" | "partialMove" | "wholeSeriesMove"
>;

export type CapabilityConfig = {
    schemaVersion: 1;
    protocolVersion:
        | "itrdb-operation-capability-v1"
        | "itrdb-operation-capability-v2"
        | "itrdb-operation-capability-v3"
        | "itrdb-operation-capability-v4-1000"
        | "itrdb-unified-adjudicator-v2"
        | "itrdb-frozen-external-v1";
    frozenDate: string;
    seed: string;
    scenarioGeneratorVersion: 3 | 4 | 5 | 6;
    itrdbRoot: string;
    fileIds: string[];
    generalizationSelection?: {
        fileSelectionSeed: string;
        candidateFileCount: number;
        priorManifestPaths: string[];
        requireUniqueBasename: true;
        usesSignalStrength: false;
        usesDiagnosisOutput: false;
    };
    selection: {
        minimumSeriesYears: number;
        minimumMasterCorrelation: number;
        maximumProblemSegments: number;
        maximumTargetZeroCount?: number;
        minimumTargetExcludedReferenceCores?: number;
        minimumFileIntercorrelation?: number;
        maximumFileProblemSegments?: number;
        fileCorrelationBandCounts?: {
            from060To070: number;
            from070To080: number;
            atLeast080: number;
        };
        minimumOlderContextYears: number;
        minimumNewerContextYears: number;
        maximumTargetsPerFile?: number;
        targetSelectionSeed?: string;
        globalTargetCount?: number;
        priorTargetsRetained?: number;
        excludeFilesWithoutEligibleTargets?: boolean;
        usesSignalStrength: false;
        usesDiagnosisOutput: false;
    };
    injection: {
        falseRingMode: "average" | "moderate" | "splitLike";
        partialShiftYears: number[];
        wholeShiftYears: number[];
        distantSpacingYears: number;
        nearSpacingYears: number | number[];
        distantEventCounts?: number[];
        nearUnitEventCounts?: number[];
        includeAdjacentOptionalSuccess?: boolean;
        allowedWindowWidths: number[];
    };
    families: Record<CapabilityFamily, string>;
    design?: {
        scenarioSampling: "exhaustivePerTarget" | "balancedOnePerFamily";
        splitId: string;
        datasetRole:
            | "development"
            | "calibration"
            | "finalHoldout"
            | "expandedFrozenHoldoutReuse"
            | "externalFrozenTest";
        casesPerTargetPerFamily: number;
        priorProtocolVersion?: string;
        targetExpansion?: "retainPrior500PlusDeterministic500";
        eventPositionWeights?: {
            middle: number;
            newer: number;
            barkNear: number;
        };
        lengthAwareEventCounts?: boolean;
    };
    statistics?: {
        clusterUnit: "file";
        bootstrapReplicates: number;
        confidenceLevel: number;
        targetCoverage: number;
        seed: string;
    };
    evaluationProtocol?: {
        version: "frontier-workflow-suggestion-v1";
        mainMetric: "workflowSuggestionAccuracy";
        denominator: "actualFrontierDiagnosisAttempts";
        unreachedEvents: "serialRecoveryOnly";
        wholeSeriesMoveSuccess: "negativeExactShiftNoWindow";
    };
    runtime: {
        workers: number;
        cofechaTimeoutSeconds: number;
    };
};

export type CapabilityTarget = {
    targetId: string;
    startYear: number;
    endYear: number;
    seriesYears: number;
    zeroCount: number;
    masterCorrelation: number;
    problemSegments: number;
    /** Clean, eligible reference cores remaining after excluding this target. */
    targetExcludedReferenceCores?: number;
};

export type CapabilityFile = {
    fileId: string;
    relativePath: string;
    sourceSha256: string;
    cleanCofechaSha256: string;
    seriesIntercorrelation: number;
    possibleProblemSegments: number;
    totalSeries: number;
    eligibleTargetsBeforeLimit?: number;
    eligibleTargets: CapabilityTarget[];
};

export type CapabilityExcludedFile = {
    fileId: string;
    relativePath: string | null;
    reason: string;
};

export type CapabilityManifest = {
    schemaVersion: 1;
    protocolVersion: CapabilityConfig["protocolVersion"];
    scenarioGeneratorVersion: 3 | 4 | 5 | 6;
    createdAt: string;
    gitCommit: string;
    configPath: string;
    configSha256: string;
    itrdbRoot: string;
    cofechaSha256: string;
    files: CapabilityFile[];
    excludedFiles: CapabilityExcludedFile[];
    counts: {
        requestedFiles: number;
        includedFiles: number;
        excludedFiles: number;
        totalSeries: number;
        eligibleTargetsBeforeLimit?: number;
        eligibleTargets: number;
    };
    expansion?: {
        priorProtocolVersion: string;
        priorTargetCount: number;
        addedTargetCount: number;
        availableTargetCount: number;
        selectionSeed: string;
    };
};

export type CapabilityTruth = {
    truthId: string;
    eventType: CapabilityOperation;
    year: number | null;
    shiftYears: number;
};

export type CapabilityCase = {
    index: number;
    caseId: string;
    family: CapabilityFamily;
    scenarioId: string;
    fileId: string;
    relativePath: string;
    targetId: string;
    seriesYears: number;
    targetStartYear: number;
    targetEndYear: number;
    masterCorrelation: number;
    problemSegments: number;
    spacingYears: number | null;
    partialShiftYears: number;
    wholeShiftYears: number;
    eventCount?: number;
    frontierPositionBand?: "middle" | "newer" | "barkNear" | null;
    frontierDistanceFromNewest?: number | null;
    evaluationMode: CapabilityEvaluationMode;
    acceptanceTier: CapabilityAcceptanceTier;
    truths: CapabilityTruth[];
};
