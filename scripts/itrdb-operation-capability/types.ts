import type { DiagnosisEventType } from "@/features/crossdating/diagnosis/types";

export type CapabilityFamily = "A" | "B" | "C" | "D";
export type CapabilityOperation = Extract<
    DiagnosisEventType,
    "missingRing" | "falseRing" | "partialMove" | "wholeSeriesMove"
>;

export type CapabilityConfig = {
    schemaVersion: 1;
    protocolVersion: "itrdb-operation-capability-v1";
    frozenDate: string;
    seed: string;
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
        minimumOlderContextYears: number;
        minimumNewerContextYears: number;
        maximumTargetsPerFile?: number;
        targetSelectionSeed?: string;
        excludeFilesWithoutEligibleTargets?: boolean;
        usesSignalStrength: false;
        usesDiagnosisOutput: false;
    };
    injection: {
        falseRingMode: "average" | "moderate" | "splitLike";
        partialShiftYears: number[];
        wholeShiftYears: number[];
        distantSpacingYears: number;
        nearSpacingYears: number;
        allowedWindowWidths: number[];
    };
    families: Record<CapabilityFamily, string>;
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
    scenarioGeneratorVersion: 1;
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
    truths: CapabilityTruth[];
};
