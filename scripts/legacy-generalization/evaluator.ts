import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
    extractPart6FlaggedASeriesIds,
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import { getConfig } from "@/features/crossdating/diagnosis/config";
import { INTERNAL_EVENT_PATH_CONFIG } from "@/features/crossdating/diagnosis/eventEnsemble";
import {
    createLagPathCache,
    diagnoseLagPath,
    locateBoundedLagStateEvents,
    scoreLagTransitionHypotheses,
} from "@/features/crossdating/diagnosis/eventPath";
import { getJointCounterfactualOperationScores } from "@/features/crossdating/diagnosis/jointCounterfactualOperation";
import { DEFAULT_MAX_PARTIAL_GAP_YEARS } from "@/features/crossdating/diagnosis/partialMoveSemantics";
import {
    scorePerReferenceCounterfactualEvidence,
    summarizePerReferenceCounterfactualRows,
} from "@/features/crossdating/diagnosis/perReferenceCounterfactualEvidence";
import { scoreBoundaryLocalCounterfactual } from "@/features/crossdating/diagnosis/boundaryLocalCounterfactual";
import { scoreNegativePartialMoveBoundaries } from "@/features/crossdating/diagnosis/partialBreakpointRefinement";
import { scoreUnitBoundaries } from "@/features/crossdating/diagnosis/unitBreakpointRefinement";
import { scoreCumulativeLagChangePoints } from "@/features/crossdating/diagnosis/cumulativeLagChangePoint";
import {
    scorePiecewiseChangePoints,
    scoreReferenceConsensusChangePoints,
} from "@/features/crossdating/diagnosis/piecewiseChangePoint";
import { scoreReferenceTransitionConsensus } from "@/features/crossdating/diagnosis/referenceTransitionConsensus";
import {
    scoreDynamicJointOperation,
    selectDynamicJointOperation,
    selectDynamicUnitOperation,
} from "@/features/crossdating/diagnosis/jointOperationSelector";
import {
    measureWholeSeriesStateConsistency,
    supportsNonTerminalWholeSeriesCandidate,
} from "@/features/crossdating/diagnosis/wholeSeriesStateConsistency";
import { preprocessSeries } from "@/features/crossdating/diagnosis/series";
import { diagnoseSeriesCore } from "@/features/crossdating/diagnosis/segments";
import type {
    DiagnosisEvent,
    SeriesCoreDiagnosis,
} from "@/features/crossdating/diagnosis/types";
import {
    classifyCofechaPart6Series,
    cofechaStyleStandardize,
    createCofechaMasterReferenceConfig,
    createCofechaPassReferenceConfig,
    type ReferenceSeriesConfig,
    type CofechaArImplementation,
    type CofechaLogImplementation,
    type CofechaSplineImplementation,
} from "@/features/crossdating/reference";
import {
    createPairwiseBootstrapReferenceConfig,
    createPairwiseBootstrapTargetReferenceConfig,
    selectPairwiseBootstrapCluster,
} from "@/features/crossdating/pairwiseBootstrap";
import {
    buildInternalReferenceModel,
    predictInternalTargetIncompatibility,
    scoreInternalTargetIncompatibility,
    setInternalTargetCandidate,
    shouldSuppressInternalStrictSuggestion,
    type InternalMasterMethod,
    type InternalCompatibilityLinearModel,
    type InternalTargetContribution,
} from "@/features/crossdating/internalReferenceModel";
import {
    createEndAnchoredFalseRingCase,
    createEndAnchoredMissingRingCase,
    createPartialRangeMoveCase,
    createPiecewiseLagMixedCase,
    createWholeSeriesMoveCase,
    type RwlSeries,
} from "@/features/crossdating/diagnosis/__tests__/rdmFixture";
import {
    deleteYearWithMode,
    getSeriesMoveConflicts,
    insertMissingYearAtSide,
    moveSeriesTailByOffset,
} from "@/features/rwl/edit";
import { formatHandlers, readRwlString } from "@/features/rwl";
import type {
    RwlFormat,
    RwlReadOptions,
    RwlReadResult,
    RwlSiteData,
    RwlTreeData,
} from "@/features/rwl/types";
import type {
    LegacyCaseRow,
    LegacyConfig,
    LegacyDiagnosisSnapshot,
    LegacyFilePlan,
    LegacyQualityMetrics,
    LegacyScenarioPlan,
    LegacyTruthSpec,
} from "./types";

export type LoadedRwl = {
    sourceText: string;
    sourceSha256: string;
    readResult: RwlReadResult;
    siteData: RwlSiteData;
    series: Map<string, RwlSeries>;
};

export type CofechaContext = {
    stateDir: string;
    sitePath: string;
    outPath: string;
    outText: string;
    flaggedIds: string[];
    rwlHash: string;
};

export const sha256Bytes = (value: string | Buffer): string => createHash("sha256")
    .update(value).digest("hex");

export const cloneSite = (siteData: RwlSiteData): RwlSiteData => new Map(
    Array.from(siteData, ([seriesId, values]) => [seriesId, new Map(values)]),
);

const observedSite = (siteData: RwlSiteData): RwlSiteData => new Map(
    Array.from(siteData, ([seriesId, values]) => [
        seriesId,
        new Map(Array.from(values).flatMap(([year, value]) => (
            typeof value === "number" && value !== -9999
                ? [[year, value] as [number, number]]
                : []
        ))),
    ]),
);

export const siteHash = (siteData: RwlSiteData): string => sha256Bytes(JSON.stringify(
    Array.from(siteData, ([seriesId, values]) => [
        seriesId,
        Array.from(values).filter((row): row is [number, number] => (
            typeof row[1] === "number" && row[1] !== -9999
        )).sort((left, right) => left[0] - right[0]),
    ]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
));

export const readRwlForEvaluation = async (
    sourceText: string,
    declaredFormat?: string,
    additionalOptions: RwlReadOptions = {},
): Promise<RwlReadResult> => {
    const preferFormat: RwlFormat | undefined = declaredFormat === "tucson-auto"
        ? "tucson"
        : undefined;
    return readRwlString(sourceText, {
        ...additionalOptions,
        edgeZeros: true,
        preferFormat,
    });
};

export const loadRwl = async (
    path: string,
    declaredFormat?: string,
    additionalOptions: RwlReadOptions = {},
): Promise<LoadedRwl> => {
    const bytes = readFileSync(path);
    const sourceText = bytes.toString("utf8");
    const readResult = await readRwlForEvaluation(
        sourceText,
        declaredFormat,
        additionalOptions,
    );
    const series = new Map(Array.from(readResult.data, ([id, valuesByYear]) => {
        const observedEntries = Array.from(valuesByYear).flatMap(([year, value]) => (
            typeof value === "number" && value !== -9999
                ? [[year, value] as [number, number]]
                : []
        ));
        const years = observedEntries.map(([year]) => year);
        const zeroCount = observedEntries.filter(([, value]) => value === 0).length;
        return [id, {
            id,
            valuesByYear: new Map(observedEntries),
            startYear: Math.min(...years),
            endYear: Math.max(...years),
            length: observedEntries.length,
            nonZeroCount: observedEntries.length - zeroCount,
            zeroCount,
        }];
    }));
    return {
        sourceText,
        sourceSha256: sha256Bytes(bytes),
        readResult,
        siteData: observedSite(readResult.data),
        series,
    };
};

export const formatLikeSource = (
    siteData: RwlSiteData,
    readResult: RwlReadResult,
): string => {
    const handler = formatHandlers[readResult.format];
    if (!handler?.format) throw new Error(`format unavailable: ${readResult.format}`);
    return handler.format(siteData, readResult.readOptions);
};

export const reopenFormattedSite = async (
    siteData: RwlSiteData,
    readResult: RwlReadResult,
): Promise<RwlSiteData> => {
    const reopened = await readRwlString(formatLikeSource(siteData, readResult), {
        edgeZeros: true,
        preferFormat: readResult.format === "unknown" ? undefined : readResult.format,
    });
    return observedSite(reopened.data);
};

export const runCofecha = (input: {
    siteData: RwlSiteData;
    readResult: RwlReadResult;
    workDir: string;
    label: string;
    cofechaExe: string;
    timeoutSeconds: number;
}): CofechaContext => {
    const stateDir = join(input.workDir, input.label);
    rmSync(stateDir, { force: true, recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const sitePath = join(stateDir, "state.rwl");
    const outPath = join(stateDir, "VERYCOF.OUT");
    writeFileSync(sitePath, formatLikeSource(input.siteData, input.readResult), "utf8");
    execFileSync(input.cofechaExe, [], {
        cwd: stateDir,
        input: "very\nstate.rwl\n\n\n\n\n\n\n",
        timeout: input.timeoutSeconds * 1000,
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
    });
    const outText = readFileSync(outPath, "utf8");
    const parts = splitReportByParts(outText);
    const canonical = new Map(Array.from(input.siteData.keys(), (seriesId) => [
        seriesId.trim().toUpperCase(),
        seriesId,
    ]));
    const flaggedIds = extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? "")
        .flatMap((seriesId) => {
            const resolved = canonical.get(seriesId.trim().toUpperCase());
            return resolved ? [resolved] : [];
        });
    return {
        stateDir,
        sitePath,
        outPath,
        outText,
        flaggedIds,
        rwlHash: sha256Bytes(readFileSync(sitePath)),
    };
};

const candidateAudit = (candidate: Record<string, unknown>) => ({
    id: candidate.id ?? null,
    operationType: candidate.operationType ?? null,
    mode: candidate.mode ?? null,
    targetTree: candidate.targetTree ?? null,
    targetYear: candidate.targetYear ?? null,
    suggestedLag: candidate.suggestedLag ?? null,
    deltaYears: candidate.deltaYears ?? null,
    score: candidate.score ?? null,
    algorithmSource: candidate.algorithmSource ?? null,
    recallSourceTags: (candidate.evidence as Record<string, unknown> | undefined)
        ?.recallSourceTags ?? null,
});

/** Mirrors the Tauri automatic-reference path before each target diagnosis. */
export const createProductionReferenceForEvaluation = (input: {
    siteData: RwlSiteData;
    targetId: string;
    flaggedAIds: Iterable<string>;
    cofechaRunId: string;
    rwlHash: string;
    masterDatingSeries: Map<number, number>;
}): {
    referenceConfig: ReferenceSeriesConfig;
    referenceMode: LegacyDiagnosisSnapshot["referenceMode"];
} => {
    const flaggedAIds = [...input.flaggedAIds];
    const classification = classifyCofechaPart6Series(
        Array.from(input.siteData.keys()),
        flaggedAIds,
        input.cofechaRunId,
    );
    const pairwiseBootstrapReference = classification.anchorPassIds.length < 3
        ? createPairwiseBootstrapReferenceConfig({
            siteData: input.siteData,
            flaggedAIds,
            cofechaRunId: input.cofechaRunId,
            rwlHash: input.rwlHash,
        })
        : null;
    const automaticReference = pairwiseBootstrapReference
        ?? createCofechaMasterReferenceConfig({
            siteData: input.siteData,
            flaggedAIds,
            cofechaRunId: input.cofechaRunId,
            rwlHash: input.rwlHash,
            masterDatingSeries: input.masterDatingSeries,
        });
    const referenceConfig = createPairwiseBootstrapTargetReferenceConfig(
        input.siteData,
        automaticReference,
        input.targetId,
    ) ?? automaticReference;
    const usesPairwiseBootstrap = referenceConfig.cofechaPassReference?.source
        === "pairwise_bootstrap";
    if (usesPairwiseBootstrap
        && referenceConfig.cofechaPassReference?.includedSeriesIds.includes(input.targetId)) {
        throw new Error(`target leaked into pairwise reference: ${input.targetId}`);
    }
    return {
        referenceConfig,
        referenceMode: usesPairwiseBootstrap
            ? "pairwise-bootstrap-target-excluded"
            : "cofecha-master",
    };
};

/** Builds a target-independent internal reference without reading any COFECHA output. */
export const createInternalReferenceForEvaluation = (input: {
    siteData: RwlSiteData;
    targetId: string;
    runId: string;
    rwlHash: string;
    referenceSet?: "stable-cluster" | "all-other";
    flagTarget?: boolean;
}): ReferenceSeriesConfig | null => {
    const targetExcludedSite = new Map(input.siteData);
    targetExcludedSite.delete(input.targetId);
    const clusterIds = input.referenceSet === "all-other"
        ? Array.from(targetExcludedSite.keys())
        : selectPairwiseBootstrapCluster(targetExcludedSite);
    if (clusterIds.length < 3) return null;
    const clusterSet = new Set(clusterIds);
    const internallyFlaggedIds = Array.from(input.siteData.keys()).filter(
        (seriesId) => !clusterSet.has(seriesId)
            && (seriesId !== input.targetId || input.flagTarget !== false),
    );
    const referenceConfig = createPairwiseBootstrapReferenceConfig({
        siteData: input.siteData,
        flaggedAIds: internallyFlaggedIds,
        cofechaRunId: `internal-pairwise-${input.runId}`,
        rwlHash: input.rwlHash,
        clusterIds,
    });
    if (referenceConfig?.selectedTrees.includes(input.targetId)) {
        throw new Error(`target leaked into internal reference: ${input.targetId}`);
    }
    return referenceConfig;
};

export type EvaluationReferenceStrategy =
    | "production"
    | "pairwise-only"
    | "pairwise-with-cofecha-evidence"
    | "cofecha-master-without-diagnosis-evidence"
    | "all-other-only"
    | "all-other-internal-flags"
    | "internal-model-unflagged"
    | "internal-model-flagged"
    | "internal-model-classifier"
    | "internal-model-safe-clean-gate";

export const diagnoseTruthBlind = (input: {
    siteData: RwlSiteData;
    targetId: string;
    context: CofechaContext;
    runId: string;
    includeOperationGrid?: boolean;
    referenceStrategy?: EvaluationReferenceStrategy;
    internalMasterMethod?: InternalMasterMethod;
    internalTargetContribution?: InternalTargetContribution;
    internalCompatibilityThreshold?: number;
    normalizeInternalSourceResiduals?: boolean;
    internalSplineImplementation?: CofechaSplineImplementation;
    internalArImplementation?: CofechaArImplementation;
    internalLogImplementation?: CofechaLogImplementation;
    internalPreSplineResidualBlendWeight?: number | null;
    internalAdaptivePreSplineResidualBlend?: boolean;
    internalCompatibilityModel?: InternalCompatibilityLinearModel;
}): LegacyDiagnosisSnapshot => {
    const started = performance.now();
    try {
        const referenceStrategy = input.referenceStrategy ?? "production";
        const usesProductionReference = referenceStrategy === "production"
            || referenceStrategy === "cofecha-master-without-diagnosis-evidence";
        const passesCofechaText = referenceStrategy === "production"
            || referenceStrategy === "pairwise-with-cofecha-evidence";
        const productionReference = usesProductionReference
            ? createProductionReferenceForEvaluation({
                siteData: input.siteData,
                targetId: input.targetId,
                flaggedAIds: input.context.flaggedIds,
                cofechaRunId: input.runId,
                rwlHash: input.context.rwlHash,
                masterDatingSeries: parseCofechaResult(
                    input.context.outText,
                ).masterDatingSeries,
            })
            : null;
        const rawInternalModel = referenceStrategy.startsWith("internal-model")
            ? buildInternalReferenceModel({
                siteData: input.siteData,
                targetId: input.targetId,
                runId: input.runId,
                rwlHash: input.context.rwlHash,
                method: input.internalMasterMethod,
                candidateTarget: referenceStrategy === "internal-model-flagged",
                targetContribution: input.internalTargetContribution,
                normalizeSourceResiduals: input.normalizeInternalSourceResiduals,
                splineImplementation: input.internalSplineImplementation,
                arImplementation: input.internalArImplementation,
                logImplementation: input.internalLogImplementation,
                preSplineResidualBlendWeight:
                    input.internalPreSplineResidualBlendWeight,
                adaptivePreSplineResidualBlend:
                    input.internalAdaptivePreSplineResidualBlend,
            })
            : null;
        const internalIncompatibilityScore = rawInternalModel
            ? scoreInternalTargetIncompatibility(rawInternalModel.targetCompatibility)
            : null;
        const internalIncompatibilityProbability = rawInternalModel
            && input.internalCompatibilityModel
            ? predictInternalTargetIncompatibility(
                rawInternalModel.targetCompatibility,
                input.internalCompatibilityModel,
            )
            : null;
        const internalModel = rawInternalModel
            ? setInternalTargetCandidate(
                rawInternalModel,
                input.targetId,
                referenceStrategy === "internal-model-flagged"
                    || referenceStrategy === "internal-model-safe-clean-gate"
                    || (referenceStrategy === "internal-model-classifier"
                        && (internalIncompatibilityProbability !== null
                            ? internalIncompatibilityProbability
                                >= input.internalCompatibilityModel!.threshold
                            : internalIncompatibilityScore !== null
                                && internalIncompatibilityScore >= (
                                    input.internalCompatibilityThreshold ?? 0.16239316239316237
                                ))),
            )
            : null;
        const referenceConfig = productionReference?.referenceConfig
            ?? internalModel?.referenceConfig
            ?? createInternalReferenceForEvaluation({
                siteData: input.siteData,
                targetId: input.targetId,
                runId: input.runId,
                rwlHash: input.context.rwlHash,
                referenceSet: referenceStrategy.startsWith("all-other")
                    ? "all-other"
                    : "stable-cluster",
                flagTarget: referenceStrategy !== "all-other-only",
            });
        if (!referenceConfig) {
            throw new Error(`internal reference unavailable: ${input.targetId}`);
        }
        const referenceMode = productionReference?.referenceMode
            ?? (internalModel
                ? "internal-model-target-excluded"
                : "pairwise-bootstrap-target-excluded");
        const diagnosis = diagnoseCrossdating(input.siteData, {
            referenceConfig,
            targetTrees: [input.targetId],
            cofechaText: passesCofechaText
                ? input.context.outText
                : undefined,
            includeEventDecisionAudits: true,
            reviewWindowDisplayMode: "review",
        });
        const operationGrid = input.includeOperationGrid === true
            ? (() => {
                const core = diagnoseSeriesCore(
                    input.siteData,
                    input.targetId,
                    getConfig({ referenceConfig }),
                    preprocessSeries,
                );
                if (!core) return null;
                const beforeFusion = diagnosis.eventDecisionAudits?.[0]
                    ?.detectedBeforeFusion ?? [];
                const hasWholeBaseline = beforeFusion.some(
                    (event) => event.eventType === "wholeSeriesMove",
                );
                const boundedTerminalLags = hasWholeBaseline
                    ? [...new Set(beforeFusion.flatMap((event) => (
                        event.eventType === "wholeSeriesMove"
                        && typeof event.shiftYears === "number"
                            ? [event.shiftYears]
                            : []
                    )))]
                    : [0];
                const productionBaselineLag = boundedTerminalLags.length === 1
                    ? boundedTerminalLags[0]!
                    : 0;
                const operations = getJointCounterfactualOperationScores(
                    core,
                    15,
                    DEFAULT_MAX_PARTIAL_GAP_YEARS,
                    productionBaselineLag,
                );
                const cofechaCore = diagnoseSeriesCore(
                    input.siteData,
                    input.targetId,
                    getConfig({ referenceConfig }),
                    (series) => new Map(cofechaStyleStandardize(series).map((point) => (
                        [point.year, point.value]
                    ))),
                );
                const pathConfig = {
                    ...INTERNAL_EVENT_PATH_CONFIG,
                    maxPartialGapYears: DEFAULT_MAX_PARTIAL_GAP_YEARS,
                };
                const pathAudit = (events: readonly DiagnosisEvent[]) => events.map((event) => ({
                    eventType: event.eventType,
                    shiftYears: effectiveShift(event),
                    startYear: event.startYear,
                    endYear: event.endYear,
                    topYear: event.rankedYears[0]?.year ?? null,
                    lagBefore: event.evidence.lagBefore,
                    lagAfter: event.evidence.lagAfter,
                    score: event.evidence.score,
                    locationEvidence: event.evidence.locationEvidence ?? [],
                }));
                const boundedPathAudit = (
                    pathDiagnosis: SeriesCoreDiagnosis | null,
                    useCofechaStandardization: boolean,
                    transitionPenalty = 3,
                    terminalLags: readonly number[] = boundedTerminalLags,
                    allowedLags?: readonly number[],
                    maxSegments = 5,
                    minRunYears = 18,
                ) => {
                    if (!pathDiagnosis) return null;
                    const result = locateBoundedLagStateEvents(
                        pathDiagnosis,
                        input.siteData,
                        {
                            ...pathConfig,
                            useCofechaStandardization,
                            transitionPenaltyUnit: transitionPenalty,
                            transitionPenaltyBig: transitionPenalty,
                            transitionPenaltyPerYear: 0,
                        },
                        {
                            maxSegments,
                            minRunYears,
                            windowWidth: 13,
                            terminalLags,
                            allowedLags,
                            minimumWholeLagGain: 8,
                        },
                    );
                    return result ? {
                        score: result.path.score,
                        bestConstantScore: result.path.bestConstantScore,
                        transitionGain: result.path.transitionGain,
                        wholeLagGain: result.path.wholeLagGain,
                        runnerUpMargin: result.path.runnerUpMargin,
                        runs: result.path.runs.map((run) => ({
                            lag: run.lag,
                            startYear: run.startYear,
                            endYear: run.endYear,
                            score: run.score,
                            samplePairs: run.samplePairs,
                        })),
                        events: pathAudit(result.events),
                    } : null;
                };
                const dynamicSelection = selectDynamicJointOperation(operations);
                const unitSelection = selectDynamicUnitOperation(operations);
                const reviewEvent = diagnosis.reviewEvents?.[0] ?? null;
                const reviewTopYear = reviewEvent?.rankedYears[0]?.year ?? null;
                const reviewBaselineLag = Number(
                    reviewEvent?.evidence.notes
                        .find((note) => note.startsWith(
                            "stable_bounded_path_baseline_lag=",
                        ))
                        ?.split("=")[1]
                        ?? reviewEvent?.evidence.lagAfter
                        ?? 0,
                );
                const profilePeaks = <Row extends { year: number }>(
                    rows: readonly Row[],
                    keys: readonly (keyof Omit<Row, "year">)[],
                    radius: number | null,
                ) => Object.fromEntries(keys.map((key) => {
                    const eligible = reviewTopYear === null || radius === null
                        ? rows
                        : rows.filter((row) => Math.abs(row.year - reviewTopYear) <= radius);
                    const best = [...eligible].sort((left, right) => (
                        Number(right[key]) - Number(left[key]) || right.year - left.year
                    ))[0];
                    return [String(key), best ? {
                        year: best.year,
                        score: Number(best[key]),
                    } : null];
                }));
                const reviewLocationProfiles = reviewEvent && reviewTopYear !== null
                    ? (() => {
                        const correctionYears = effectiveShift(reviewEvent);
                        if (correctionYears === null) return null;
                        if (reviewEvent.eventType === "partialMove") {
                            const partialRows = scoreNegativePartialMoveBoundaries(
                                core,
                                correctionYears,
                            );
                            const localRows = scoreBoundaryLocalCounterfactual(
                                core,
                                correctionYears,
                            );
                            const referenceRows = scorePerReferenceCounterfactualEvidence(
                                core,
                                input.siteData,
                                correctionYears,
                                { baselineLagCenter: reviewBaselineLag },
                            );
                            return {
                                eventType: reviewEvent.eventType,
                                shiftYears: correctionYears,
                                baselineLag: reviewBaselineLag,
                                reviewTopYear,
                                partialLocal: profilePeaks(partialRows, [
                                    "difference31",
                                    "combo31",
                                    "combo41",
                                    "combo61",
                                    "multiScale",
                                ], 15),
                                boundaryLocal: profilePeaks(localRows, [
                                    "stepMinimum3",
                                    "stepMean3",
                                    "stepMinimum5",
                                    "stepMean5",
                                    "stepMinimum9",
                                    "stepMean9",
                                ], 15),
                                referenceLocal: profilePeaks(referenceRows, [
                                    "differenceGainWeighted",
                                    "peakKernel9",
                                    "fixedLagStepWeighted",
                                    "fixedLagStepMedian",
                                    "fixedLagStepPeakKernel9",
                                ], 15),
                            };
                        }
                        if (reviewEvent.eventType === "missingRing"
                            || reviewEvent.eventType === "falseRing") {
                            const expanded = {
                                ...reviewEvent,
                                startYear: Math.max(
                                    core.targetRange.startYear,
                                    reviewEvent.startYear - 15,
                                ),
                                endYear: Math.min(
                                    core.targetRange.endYear,
                                    reviewEvent.endYear + 15,
                                ),
                            };
                            const unitRows = scoreUnitBoundaries(expanded, core, input.siteData);
                            return {
                                eventType: reviewEvent.eventType,
                                shiftYears: correctionYears,
                                baselineLag: reviewBaselineLag,
                                reviewTopYear,
                                unitLocal: profilePeaks(unitRows, [
                                    "combo11",
                                    "combo21",
                                    "combo31",
                                    "multiScale",
                                    "huberCombo5",
                                    "huberCombo7",
                                    "huberMultiScale",
                                    "pairMedian31",
                                    "pairWeighted31",
                                    "pairedCore31",
                                ], 15),
                            };
                        }
                        return null;
                    })()
                    : null;
                const perReferenceSelection = dynamicSelection?.operation.eventType
                    === "partialMove"
                    ? (() => {
                        const rows = scorePerReferenceCounterfactualEvidence(
                            core,
                            input.siteData,
                            dynamicSelection.operation.shiftYears,
                            { baselineLagCenter: productionBaselineLag },
                        );
                        const selectedRow = rows.slice().sort((left, right) => (
                            Math.abs(left.year - dynamicSelection.operation.bestYear)
                                - Math.abs(right.year - dynamicSelection.operation.bestYear)
                            || right.fixedLagStepWeighted - left.fixedLagStepWeighted
                        ))[0] ?? null;
                        return {
                            shiftYears: dynamicSelection.operation.shiftYears,
                            summary: summarizePerReferenceCounterfactualRows(rows),
                            selectedRow,
                        };
                    })()
                    : null;
                const globalWholeStateConsistency = core.globalSlidingMatch.bestGlobalLag === 0
                    ? null
                    : measureWholeSeriesStateConsistency(
                        core,
                        core.globalSlidingMatch.bestGlobalLag,
                    );
                return {
                    jointDecision: diagnosis.jointEventDecisions?.[0] ?? null,
                    coreGlobalSlidingMatch: core.globalSlidingMatch,
                    coreGlobalWholeStateConsistency: globalWholeStateConsistency
                        ? {
                            ...globalWholeStateConsistency,
                            supported: supportsNonTerminalWholeSeriesCandidate(
                                globalWholeStateConsistency,
                            ),
                        }
                        : null,
                    cofechaCoreGlobalSlidingMatch: cofechaCore?.globalSlidingMatch ?? null,
                    operations: operations.map((operation) => ({
                        eventType: operation.eventType,
                        shiftYears: operation.shiftYears,
                        bestYear: operation.bestYear,
                        dynamicScore: scoreDynamicJointOperation(operation, operations),
                        bestRawGain: operation.bestRawGain,
                        bestDifferenceGain: operation.bestDifferenceGain,
                        bestCombinedGain: operation.bestCombinedGain,
                        topThreeDifferenceGain: operation.topThreeDifferenceGain,
                        remoteDifferenceMargin: operation.remoteDifferenceMargin,
                        baselineLag: operation.baselineLag,
                    })),
                    dynamicSelection: dynamicSelection ? {
                        eventType: dynamicSelection.operation.eventType,
                        shiftYears: dynamicSelection.operation.shiftYears,
                        bestYear: dynamicSelection.operation.bestYear,
                        score: dynamicSelection.score,
                        scoreMargin: dynamicSelection.scoreMargin,
                        shiftScoreMargin: dynamicSelection.shiftScoreMargin,
                    } : null,
                    unitSelection: unitSelection ? {
                        eventType: unitSelection.operation.eventType,
                        shiftYears: unitSelection.operation.shiftYears,
                        bestYear: unitSelection.operation.bestYear,
                        score: unitSelection.score,
                        scoreMargin: unitSelection.scoreMargin,
                    } : null,
                    reviewLocationProfiles,
                    perReferenceSelection,
                    rawPathEvents: pathAudit(diagnoseLagPath(core, input.siteData, {
                        ...pathConfig,
                        useCofechaStandardization: false,
                        enablePulseScan: false,
                    }).events),
                    cofechaPathEvents: cofechaCore
                        ? pathAudit(diagnoseLagPath(
                            cofechaCore,
                            input.siteData,
                            pathConfig,
                        ).events)
                        : [],
                    boundedRawPath: boundedPathAudit(core, false),
                    boundedRawPathPenalty2: boundedPathAudit(core, false, 2),
                    boundedRawPathPenalty1: boundedPathAudit(core, false, 1),
                    boundedRawPathPenalty05: boundedPathAudit(core, false, 0.5),
                    boundedRawPathPenalty025: boundedPathAudit(core, false, 0.25),
                    boundedRawPathPenalty1Max6: boundedPathAudit(
                        core,
                        false,
                        1,
                        boundedTerminalLags,
                        undefined,
                        6,
                    ),
                    boundedRawPathPenalty05Max6: boundedPathAudit(
                        core,
                        false,
                        0.5,
                        boundedTerminalLags,
                        undefined,
                        6,
                    ),
                    boundedRawPathZeroTerminal: boundedPathAudit(core, false, 3, [0]),
                    boundedRawPathPenalty1ZeroTerminal: boundedPathAudit(core, false, 1, [0]),
                    boundedRawPathPenalty05ZeroTerminal: boundedPathAudit(core, false, 0.5, [0]),
                    boundedRawUnitPulsePenalty1: boundedPathAudit(
                        core,
                        false,
                        1,
                        [0],
                        [-1, 0, 1],
                    ),
                    boundedRawUnitPulsePenalty05: boundedPathAudit(
                        core,
                        false,
                        0.5,
                        [0],
                        [-1, 0, 1],
                    ),
                    boundedRawNearSinglePenalty2: boundedPathAudit(
                        core,
                        false,
                        2,
                        boundedTerminalLags,
                        undefined,
                        2,
                        2,
                    ),
                    boundedRawNearPathPenalty2: boundedPathAudit(
                        core,
                        false,
                        2,
                        boundedTerminalLags,
                        undefined,
                        6,
                        2,
                    ),
                    boundedRawNearPathPenalty1: boundedPathAudit(
                        core,
                        false,
                        1,
                        boundedTerminalLags,
                        undefined,
                        6,
                        2,
                    ),
                    boundedCofechaPath: boundedPathAudit(cofechaCore, true),
                };
            })()
            : null;
        const suppressStrictSuggestion = referenceStrategy === "internal-model-safe-clean-gate"
            && shouldSuppressInternalStrictSuggestion(
                internalIncompatibilityProbability,
                diagnosis.events[0] !== undefined,
                input.internalCompatibilityModel,
            );
        return {
            strictEvent: suppressStrictSuggestion ? null : diagnosis.events[0] ?? null,
            reviewEvent: suppressStrictSuggestion ? null : diagnosis.reviewEvents?.[0] ?? null,
            candidates: diagnosis.candidates.map((candidate) => candidateAudit(
                candidate as unknown as Record<string, unknown>,
            )),
            audit: diagnosis.eventDecisionAudits?.[0] ?? null,
            reviewDecision: diagnosis.reviewWindowDecisions?.[0] ?? null,
            operationGrid,
            referenceMode,
            referenceAnchorCount:
                referenceConfig.cofechaPassReference?.summary.includedCount
                ?? 0,
            internalTargetCompatibility: internalModel?.targetCompatibility ?? null,
            internalReferenceBlendAudit: internalModel?.adaptiveBlendAudit ?? null,
            internalTargetIncompatibilityScore: internalIncompatibilityScore,
            internalTargetIncompatibilityProbability: internalIncompatibilityProbability,
            durationMs: Math.round(performance.now() - started),
            error: null,
        };
    } catch (error) {
        return {
            strictEvent: null,
            reviewEvent: null,
            candidates: [],
            audit: null,
            reviewDecision: null,
            operationGrid: null,
            referenceMode: "cofecha-master",
            referenceAnchorCount: 0,
            internalTargetCompatibility: null,
            internalReferenceBlendAudit: null,
            internalTargetIncompatibilityScore: null,
            internalTargetIncompatibilityProbability: null,
            durationMs: Math.round(performance.now() - started),
            error: error instanceof Error ? error.stack ?? error.message : String(error),
        };
    }
};

type EvaluationOperationIdentity = {
    eventType: "missingRing" | "falseRing" | "partialMove";
    shiftYears: number;
};

/** Recomputes full yearly profiles for externally selected operation identities in one pass. */
export const scoreOperationIdentityRowsForEvaluation = (input: {
    siteData: RwlSiteData;
    targetId: string;
    context: CofechaContext;
    runId: string;
    operations: readonly EvaluationOperationIdentity[];
}) => {
    const { referenceConfig } = createProductionReferenceForEvaluation({
        siteData: input.siteData,
        targetId: input.targetId,
        flaggedAIds: input.context.flaggedIds,
        cofechaRunId: input.runId,
        rwlHash: input.context.rwlHash,
        masterDatingSeries: parseCofechaResult(input.context.outText).masterDatingSeries,
    });
    const diagnosis = diagnoseCrossdating(input.siteData, {
        referenceConfig,
        targetTrees: [input.targetId],
        cofechaText: input.context.outText,
        includeEventDecisionAudits: true,
        reviewWindowDisplayMode: "review",
    });
    const core = diagnoseSeriesCore(
        input.siteData,
        input.targetId,
        getConfig({ referenceConfig }),
        preprocessSeries,
    );
    if (!core) return [];
    const beforeFusion = diagnosis.eventDecisionAudits?.[0]?.detectedBeforeFusion ?? [];
    const wholeLags = [...new Set(beforeFusion.flatMap((event) => (
        event.eventType === "wholeSeriesMove" && typeof event.shiftYears === "number"
            ? [event.shiftYears]
            : []
    )))];
    const baselineLag = wholeLags.length === 1 ? wholeLags[0]! : 0;
    const operationScores = getJointCounterfactualOperationScores(
        core,
        15,
        DEFAULT_MAX_PARTIAL_GAP_YEARS,
        baselineLag,
    );
    const selected = new Set(input.operations.map((operation) => (
        `${operation.eventType}:${operation.shiftYears}`
    )));
    const selectedShifts = [...new Set(input.operations.map(
        (operation) => operation.shiftYears,
    ))];
    const cofechaCore = diagnoseSeriesCore(
        input.siteData,
        input.targetId,
        getConfig({ referenceConfig }),
        (series) => new Map(cofechaStyleStandardize(series).map((point) => (
            [point.year, point.value]
        ))),
    );
    const pathCache = createLagPathCache();
    const transitionConfig = {
        ...INTERNAL_EVENT_PATH_CONFIG,
        maxPartialGapYears: DEFAULT_MAX_PARTIAL_GAP_YEARS,
    };
    const rawTransitions = scoreLagTransitionHypotheses(
        core,
        input.siteData,
        { ...transitionConfig, useCofechaStandardization: false },
        pathCache,
    );
    const cofechaTransitions = scoreLagTransitionHypotheses(
        cofechaCore ?? core,
        input.siteData,
        transitionConfig,
        pathCache,
    );
    const cumulativeRows = scoreCumulativeLagChangePoints(
        core,
        cofechaCore,
        { lags: selectedShifts, siteData: input.siteData },
    );
    const piecewiseRows = scorePiecewiseChangePoints(
        core,
        cofechaCore,
        { lags: selectedShifts },
    );
    const referenceChangeRows = scoreReferenceConsensusChangePoints(
        core,
        input.siteData,
        { lags: selectedShifts },
    );
    const referenceTransitionRows = scoreReferenceTransitionConsensus(
        core,
        input.siteData,
        { correctionYears: selectedShifts },
    );
    const publicYear = (
        eventType: EvaluationOperationIdentity["eventType"],
        year: number,
    ): number => eventType === "partialMove" ? year + 1 : year;
    const rowsFor = <Row extends { year: number }>(
        rows: readonly Row[],
        eventType: EvaluationOperationIdentity["eventType"],
    ): Map<number, Row> => new Map(rows.map((row) => [
        publicYear(eventType, row.year),
        row,
    ]));
    return operationScores.filter((operation) => selected.has(
        `${operation.eventType}:${operation.shiftYears}`,
    )).map((operation) => {
        const eventType = operation.eventType;
        const shiftYears = operation.shiftYears;
        const rawTransition = rowsFor(
            rawTransitions.hypotheses.find(
                (hypothesis) => hypothesis.correctionYears === shiftYears,
            )?.rows ?? [],
            eventType,
        );
        const cofechaTransition = rowsFor(
            cofechaTransitions.hypotheses.find(
                (hypothesis) => hypothesis.correctionYears === shiftYears,
            )?.rows ?? [],
            eventType,
        );
        const cumulative = rowsFor(
            cumulativeRows.filter((row) => row.olderLag === shiftYears),
            eventType,
        );
        const piecewise = rowsFor(
            piecewiseRows.filter((row) => row.olderLag === shiftYears),
            eventType,
        );
        const referenceChange = rowsFor(
            referenceChangeRows.filter((row) => row.olderLag === shiftYears),
            eventType,
        );
        const referenceTransition = rowsFor(
            referenceTransitionRows.filter(
                (row) => row.correctionYears === shiftYears,
            ),
            eventType,
        );
        const perReference = rowsFor(
            scorePerReferenceCounterfactualEvidence(
                core,
                input.siteData,
                shiftYears,
                { baselineLagCenter: operation.baselineLag },
            ),
            eventType,
        );
        const boundaryLocal = eventType === "partialMove"
            ? new Map(scoreBoundaryLocalCounterfactual(
                core,
                shiftYears,
            ).map((row) => [row.year, row]))
            : new Map();
        const partialLocal = eventType === "partialMove"
            ? new Map(scoreNegativePartialMoveBoundaries(
                core,
                shiftYears,
            ).map((row) => [row.year, row]))
            : new Map();
        return {
            eventType,
            shiftYears,
            baselineLag: operation.baselineLag,
            bestYear: operation.bestYear,
            sideStepBestYear: operation.sideStepBestYear,
            rows: operation.rows.map((row) => ({
                ...row,
                rawTransition: rawTransition.get(row.year) ?? null,
                cofechaTransition: cofechaTransition.get(row.year) ?? null,
                cumulative: cumulative.get(row.year) ?? null,
                piecewise: piecewise.get(row.year) ?? null,
                referenceChange: referenceChange.get(row.year) ?? null,
                referenceTransition: referenceTransition.get(row.year) ?? null,
                perReference: perReference.get(row.year) ?? null,
                boundaryLocal: boundaryLocal.get(row.year) ?? null,
                partialLocal: partialLocal.get(row.year) ?? null,
            })),
        };
    });
};

/** Recomputes the full yearly counterfactual profile for one externally selected operation. */
export const scoreSelectedOperationRowsForEvaluation = (input: {
    siteData: RwlSiteData;
    targetId: string;
    context: CofechaContext;
    runId: string;
    eventType: EvaluationOperationIdentity["eventType"];
    shiftYears: number;
}) => {
    const [selected] = scoreOperationIdentityRowsForEvaluation({
        ...input,
        operations: [{
            eventType: input.eventType,
            shiftYears: input.shiftYears,
        }],
    });
    return selected ?? null;
};

type ResidualEvaluationOperation = EvaluationOperationIdentity & {
    year: number;
};

type LagTransitionScan = ReturnType<typeof scoreLagTransitionHypotheses>;

/**
 * Summarizes only transition evidence newer than a proposed correction.
 * The fixed/newer side is intentionally measured after the proposal is applied:
 * an older, out-of-order proposal should leave the real frontier in this region.
 */
const residualTransitionRegionSummary = (
    scan: LagTransitionScan,
    firstNewerYear: number,
) => {
    const rows = scan.hypotheses.flatMap((hypothesis) => (
        hypothesis.rows
            .filter((row) => row.year >= firstNewerYear)
            .map((row) => ({
                ...row,
                correctionYears: hypothesis.correctionYears,
            }))
    ));
    const ranked = rows.slice().sort((left, right) => (
        right.normalizedSplitGain - left.normalizedSplitGain
        || right.balancedAdvantage - left.balancedAdvantage
        || right.localGain31 - left.localGain31
    ));
    const strongest = ranked[0] ?? null;
    const top = ranked.slice(0, 3);
    return {
        rowCount: rows.length,
        correctionCount: new Set(rows.map((row) => row.correctionYears)).size,
        strongestCorrection: strongest?.correctionYears ?? 0,
        strongestYear: strongest?.year ?? 0,
        strongestNormalizedSplitGain: strongest?.normalizedSplitGain ?? 0,
        strongestBalancedAdvantage: strongest?.balancedAdvantage ?? 0,
        strongestLocalGain31: strongest?.localGain31 ?? 0,
        top3NormalizedSplitGainMean: meanFinite(
            top.map((row) => row.normalizedSplitGain),
        ),
        top3BalancedAdvantageMean: meanFinite(
            top.map((row) => row.balancedAdvantage),
        ),
    };
};

const residualPathRegionSummary = (
    path: ReturnType<typeof diagnoseLagPath>,
    firstNewerYear: number,
) => {
    const events = path.events.filter((event) => (
        (event.rankedYears[0]?.year ?? Number.NEGATIVE_INFINITY)
            >= firstNewerYear
    ));
    const newest = events.slice().sort((left, right) => (
        (right.rankedYears[0]?.year ?? 0) - (left.rankedYears[0]?.year ?? 0)
    ))[0] ?? null;
    const strongest = events.slice().sort((left, right) => (
        right.evidence.score - left.evidence.score
    ))[0] ?? null;
    return {
        eventCount: events.length,
        newestEventYear: newest?.rankedYears[0]?.year ?? 0,
        newestEventShift: newest ? effectiveShift(newest) ?? 0 : 0,
        strongestEventYear: strongest?.rankedYears[0]?.year ?? 0,
        strongestEventShift: strongest ? effectiveShift(strongest) ?? 0 : 0,
        strongestEventScore: strongest?.evidence.score ?? 0,
        strongestEventMargin: strongest?.evidence.scoreMargin ?? 0,
    };
};

const meanFinite = (values: Array<number | null | undefined>): number => {
    const finite = values.filter(
        (value): value is number => value !== null
            && value !== undefined
            && Number.isFinite(value),
    );
    return finite.length > 0
        ? finite.reduce((sum, value) => sum + value, 0) / finite.length
        : 0;
};

const residualCoreSummary = (core: SeriesCoreDiagnosis) => ({
    globalLag: core.globalSlidingMatch.bestGlobalLag,
    globalBestR: core.globalSlidingMatch.bestGlobalR ?? 0,
    globalCurrentR: core.globalSlidingMatch.currentR ?? 0,
    globalGain: (core.globalSlidingMatch.bestGlobalR ?? 0)
        - (core.globalSlidingMatch.currentR ?? 0),
    meanSegmentR0: meanFinite(core.segments.map((segment) => segment.r0)),
    meanSegmentBestR: meanFinite(core.segments.map((segment) => segment.bestR)),
    flaggedSegments: core.segments.filter((segment) => segment.flagged).length,
    nonzeroLagSegments: core.segments.filter((segment) => segment.bestLag !== 0).length,
    unresolvedA: core.unresolvedA,
    unresolvedB: core.unresolvedB,
});

/** Applies one proposal in memory and measures the residual chronology without hidden truth. */
export const scoreAppliedOperationResidualForEvaluation = (input: {
    siteData: RwlSiteData;
    targetId: string;
    context: CofechaContext;
    runId: string;
    operation: ResidualEvaluationOperation;
}) => {
    const { referenceConfig } = createProductionReferenceForEvaluation({
        siteData: input.siteData,
        targetId: input.targetId,
        flaggedAIds: input.context.flaggedIds,
        cofechaRunId: input.runId,
        rwlHash: input.context.rwlHash,
        masterDatingSeries: parseCofechaResult(input.context.outText).masterDatingSeries,
    });
    const config = getConfig({ referenceConfig });
    const before = diagnoseSeriesCore(
        input.siteData,
        input.targetId,
        config,
        preprocessSeries,
    );
    const current = input.siteData.get(input.targetId);
    if (!before || !current) return null;
    let corrected: RwlTreeData;
    try {
        if (input.operation.eventType === "missingRing") {
            corrected = insertMissingYearAtSide(
                current,
                input.operation.year,
                "right",
            );
        } else if (input.operation.eventType === "falseRing") {
            corrected = deleteYearWithMode(
                current,
                input.operation.year,
                "direct",
                "right",
            );
        } else {
            const years = [...current.keys()];
            corrected = moveSeriesTailByOffset(
                current,
                Math.min(...years),
                input.operation.year - 1,
                input.operation.shiftYears,
            );
        }
    } catch {
        return { applied: false };
    }
    const correctedSite = new Map(input.siteData);
    correctedSite.set(input.targetId, corrected);
    const after = diagnoseSeriesCore(
        correctedSite,
        input.targetId,
        config,
        preprocessSeries,
    );
    if (!after) return { applied: false };

    const pathConfig = {
        ...INTERNAL_EVENT_PATH_CONFIG,
        maxPartialGapYears: DEFAULT_MAX_PARTIAL_GAP_YEARS,
    };
    const beforeCache = createLagPathCache();
    const afterCache = createLagPathCache();
    const beforePath = diagnoseLagPath(
        before,
        input.siteData,
        pathConfig,
        beforeCache,
    );
    const afterPath = diagnoseLagPath(
        after,
        correctedSite,
        pathConfig,
        afterCache,
    );
    const beforeTransitions = scoreLagTransitionHypotheses(
        before,
        input.siteData,
        pathConfig,
        beforeCache,
    );
    const afterTransitions = scoreLagTransitionHypotheses(
        after,
        correctedSite,
        pathConfig,
        afterCache,
    );
    const transitionSummary = (
        scan: ReturnType<typeof scoreLagTransitionHypotheses>,
    ) => {
        const hypothesis = scan.hypotheses.find(
            (candidate) => candidate.correctionYears === input.operation.shiftYears,
        );
        const publicYear = input.operation.eventType === "partialMove"
            ? input.operation.year - 1
            : input.operation.year;
        const local = hypothesis?.rows.slice().sort((left, right) => (
            Math.abs(left.year - publicYear) - Math.abs(right.year - publicYear)
        ))[0] ?? null;
        const strongest = hypothesis?.rows.slice().sort((left, right) => (
            right.normalizedSplitGain - left.normalizedSplitGain
            || right.localGain31 - left.localGain31
        ))[0] ?? null;
        const strongestAny = scan.hypotheses.flatMap(
            (candidate) => candidate.rows,
        ).sort((left, right) => (
            right.normalizedSplitGain - left.normalizedSplitGain
            || right.localGain31 - left.localGain31
        ))[0] ?? null;
        return {
            localSplitGain: local?.splitGain ?? 0,
            localNormalizedSplitGain: local?.normalizedSplitGain ?? 0,
            localBalancedAdvantage: local?.balancedAdvantage ?? 0,
            localGain31: local?.localGain31 ?? 0,
            strongestYear: strongest?.year ?? 0,
            strongestNormalizedSplitGain: strongest?.normalizedSplitGain ?? 0,
            strongestLocalGain31: strongest?.localGain31 ?? 0,
            strongestAnyCorrection: strongestAny?.correctionYears ?? 0,
            strongestAnyYear: strongestAny?.year ?? 0,
            strongestAnyNormalizedSplitGain:
                strongestAny?.normalizedSplitGain ?? 0,
        };
    };
    const beforeCore = residualCoreSummary(before);
    const afterCore = residualCoreSummary(after);
    const beforeTransition = transitionSummary(beforeTransitions);
    const afterTransition = transitionSummary(afterTransitions);
    const firstNewerYear = input.operation.year + 1;
    const beforeNewerTransition = residualTransitionRegionSummary(
        beforeTransitions,
        firstNewerYear,
    );
    const afterNewerTransition = residualTransitionRegionSummary(
        afterTransitions,
        firstNewerYear,
    );
    const beforeNewerPath = residualPathRegionSummary(
        beforePath,
        firstNewerYear,
    );
    const afterNewerPath = residualPathRegionSummary(
        afterPath,
        firstNewerYear,
    );
    const newestAfterEvent = afterPath.events.slice().sort((left, right) => (
        right.endYear - left.endYear
    ))[0] ?? null;
    return {
        applied: true,
        beforeCore,
        afterCore,
        coreDelta: Object.fromEntries(Object.keys(beforeCore).map((key) => [
            key,
            Number(afterCore[key as keyof typeof afterCore])
                - Number(beforeCore[key as keyof typeof beforeCore]),
        ])),
        beforePath: {
            eventCount: beforePath.events.length,
            newestLag: beforePath.newestLag,
            newestLagMargin: beforePath.newestLagMargin,
        },
        afterPath: {
            eventCount: afterPath.events.length,
            newestLag: afterPath.newestLag,
            newestLagMargin: afterPath.newestLagMargin,
            newestEventYear: newestAfterEvent?.rankedYears[0]?.year ?? 0,
            newestEventShift: newestAfterEvent
                ? effectiveShift(newestAfterEvent) ?? 0
                : 0,
        },
        pathEventReduction: beforePath.events.length - afterPath.events.length,
        beforeTransition,
        afterTransition,
        transitionDelta: Object.fromEntries(Object.keys(beforeTransition).map((key) => [
            key,
            Number(afterTransition[key as keyof typeof afterTransition])
                - Number(beforeTransition[key as keyof typeof beforeTransition]),
        ])),
        newerSide: {
            firstYear: firstNewerYear,
            beforeTransition: beforeNewerTransition,
            afterTransition: afterNewerTransition,
            transitionDelta: Object.fromEntries(
                Object.keys(beforeNewerTransition).map((key) => [
                    key,
                    Number(
                        afterNewerTransition[
                            key as keyof typeof afterNewerTransition
                        ],
                    ) - Number(
                        beforeNewerTransition[
                            key as keyof typeof beforeNewerTransition
                        ],
                    ),
                ]),
            ),
            beforePath: beforeNewerPath,
            afterPath: afterNewerPath,
            pathDelta: Object.fromEntries(
                Object.keys(beforeNewerPath).map((key) => [
                    key,
                    Number(afterNewerPath[key as keyof typeof afterNewerPath])
                        - Number(beforeNewerPath[key as keyof typeof beforeNewerPath]),
                ]),
            ),
        },
    };
};

const treeRange = (tree: RwlTreeData): { startYear: number; endYear: number } => {
    const years = Array.from(tree.keys());
    return { startYear: Math.min(...years), endYear: Math.max(...years) };
};

export const buildScenarioSite = (
    cleanSite: RwlSiteData,
    cleanSeries: Map<string, RwlSeries>,
    scenario: LegacyScenarioPlan,
): RwlSiteData => {
    const site = cloneSite(cleanSite);
    const source = cleanSeries.get(scenario.targetId);
    if (!source) throw new Error(`target missing: ${scenario.targetId}`);
    const truths = scenario.truths;
    if (scenario.kind === "clean") return site;
    if (scenario.kind === "singleMissingRing" || scenario.kind === "endpointCropped") {
        let target = source;
        if (scenario.kind === "endpointCropped") {
            const cropYears = Number(scenario.parameters.cropOlderYears ?? 0);
            const croppedValues = new Map(Array.from(source.valuesByYear).filter(([year]) => (
                year >= source.startYear + cropYears
            )));
            target = {
                ...source,
                valuesByYear: croppedValues,
                startYear: source.startYear + cropYears,
                length: croppedValues.size,
                nonZeroCount: croppedValues.size,
            };
        }
        site.set(
            source.id,
            createEndAnchoredMissingRingCase(target, truths[0].year!).corrupted,
        );
        return site;
    }
    if (scenario.kind === "singleFalseRing") {
        site.set(source.id, createEndAnchoredFalseRingCase(
            source,
            truths[0].year!,
            String(scenario.parameters.falseRingMode ?? "moderate") as
                "average" | "moderate" | "splitLike",
        ).corrupted);
        return site;
    }
    if (scenario.kind === "singlePartialMove" || scenario.kind === "contiguousBlock") {
        site.set(source.id, createPartialRangeMoveCase(
            source,
            truths[0].year!,
            Math.abs(truths[0].shiftYears),
        ).corrupted);
        return site;
    }
    if (scenario.kind === "wholeSeriesMove") {
        site.set(source.id, createWholeSeriesMoveCase(source, -truths[0].shiftYears).corrupted);
        return site;
    }
    if (scenario.kind.startsWith("multiDiscreteMissing")) {
        site.set(source.id, createPiecewiseLagMixedCase(
            source,
            truths.map((item) => ({
                eventType: "missingRing" as const,
                year: item.year!,
                shiftYears: -1,
            })),
        ).corrupted);
        return site;
    }
    if (scenario.kind === "composite") {
        const localTruths = truths.filter((item) => item.eventType !== "wholeSeriesMove");
        const whole = truths.find((item) => item.eventType === "wholeSeriesMove");
        site.set(source.id, createPiecewiseLagMixedCase(
            source,
            localTruths.map((item) => ({
                eventType: item.eventType as "missingRing" | "falseRing" | "partialMove",
                year: item.year!,
                shiftYears: item.shiftYears,
                falseMode: item.eventType === "falseRing"
                    ? String(scenario.parameters.falseRingMode ?? "moderate") as
                        "average" | "moderate" | "splitLike"
                    : undefined,
            })),
            whole?.shiftYears ?? 0,
        ).corrupted);
        return site;
    }
    throw new Error(`unsupported scenario: ${scenario.kind}`);
};

export const canonicalEvent = (event: DiagnosisEvent | null): unknown => event === null
    ? null
    : {
        seriesId: event.seriesId,
        eventType: event.eventType,
        startYear: event.startYear,
        endYear: event.endYear,
        shiftYears: event.shiftYears ?? null,
        shiftSide: event.shiftSide ?? null,
        topYear: event.rankedYears[0]?.year ?? null,
        confidenceLevel: event.confidenceLevel,
        reviewOnly: event.reviewOnly === true,
    };

const semanticNumber = (value: number): number => (
    Number.isInteger(value) ? value : Number(value.toFixed(12))
);

const semanticValue = (value: unknown): unknown => {
    if (typeof value === "number") return semanticNumber(value);
    if (Array.isArray(value)) return value.map(semanticValue);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([
            key,
            nested,
        ]) => [key, semanticValue(nested)]));
    }
    return value;
};

export const canonicalSnapshot = (snapshot: LegacyDiagnosisSnapshot): unknown => semanticValue({
    strict: canonicalEvent(snapshot.strictEvent),
    review: canonicalEvent(snapshot.reviewEvent),
    candidates: snapshot.candidates,
    reviewStatus: snapshot.reviewDecision?.status ?? null,
    reviewReason: snapshot.reviewDecision?.reason ?? null,
});

export const snapshotsSemanticallyEqual = (
    left: LegacyDiagnosisSnapshot,
    right: LegacyDiagnosisSnapshot,
): boolean => JSON.stringify(canonicalSnapshot(left)) === JSON.stringify(canonicalSnapshot(right));

export const effectiveShift = (event: DiagnosisEvent | null): number | null => {
    if (!event) return null;
    if (event.eventType === "missingRing") return -1;
    if (event.eventType === "falseRing") return 1;
    return event.shiftYears ?? null;
};

const truthMatchesOperation = (
    event: DiagnosisEvent,
    truth: LegacyTruthSpec,
): boolean => event.eventType === truth.eventType
    && effectiveShift(event) === truth.shiftYears;

export const matchTruthAfterDiagnosis = (
    event: DiagnosisEvent | null,
    truths: readonly LegacyTruthSpec[],
): LegacyTruthSpec | null => {
    if (!event) return null;
    const matching = truths.filter((truth) => truthMatchesOperation(event, truth));
    if (matching.length === 0) return null;
    if (matching.length === 1 || event.eventType === "wholeSeriesMove") return matching[0];
    const anchor = event.rankedYears[0]?.year
        ?? Math.round((event.startYear + event.endYear) / 2);
    return [...matching].sort((left, right) => (
        Math.abs((left.year ?? anchor) - anchor) - Math.abs((right.year ?? anchor) - anchor)
        || String(left.truthId).localeCompare(String(right.truthId))
    ))[0];
};

export const makeCaseRow = (input: {
    file: LegacyFilePlan;
    scenario: LegacyScenarioPlan;
    pair: "before-save" | "after-reopen";
    snapshot: LegacyDiagnosisSnapshot;
    truth: LegacyTruthSpec | null;
    quality: LegacyQualityMetrics;
    saveReopenStable: boolean | null;
    cofechaFlagged: boolean;
}): LegacyCaseRow => {
    const event = input.snapshot.reviewEvent;
    const truth = input.truth;
    const response = event !== null;
    const typeCorrect = truth ? event?.eventType === truth.eventType : null;
    const shiftCorrect = truth
        ? effectiveShift(event) === truth.shiftYears
        : null;
    const operationCorrect = truth ? Boolean(typeCorrect && shiftCorrect) : null;
    const windowApplicable = truth !== null && truth.eventType !== "wholeSeriesMove";
    const windowCovered = windowApplicable
        ? Boolean(operationCorrect && event && truth?.year !== null
            && truth!.year! >= event.startYear && truth!.year! <= event.endYear)
        : null;
    const topYear = event?.rankedYears[0]?.year ?? null;
    return {
        caseId: `${input.scenario.scenarioId}:${input.pair}:${truth?.truthId ?? "negative"}`,
        fileId: input.file.fileId,
        relativePath: input.file.relativePath,
        source: input.file.source,
        developmentExposure: input.file.developmentExposure,
        seriesId: input.scenario.targetId,
        scenarioId: input.scenario.scenarioId,
        scenarioKind: input.scenario.kind,
        scenarioPair: input.pair,
        truthQuality: input.scenario.truthQuality,
        eventComplexity: input.scenario.eventComplexity,
        truthId: truth?.truthId ?? null,
        truthEventType: truth?.eventType ?? null,
        truthYear: truth?.year ?? null,
        truthShiftYears: truth?.shiftYears ?? null,
        absoluteIdentifiable: input.quality.identifiability !== "absolute-unidentifiable",
        response,
        eventCount: response ? 1 : 0,
        predictedType: event?.eventType ?? null,
        predictedShiftYears: effectiveShift(event),
        typeCorrect,
        shiftCorrect,
        operationCorrect,
        windowApplicable,
        windowCovered,
        top1Exact: windowApplicable && operationCorrect && truth?.year !== null
            ? topYear === truth!.year
            : null,
        topYear,
        windowStart: event?.startYear ?? null,
        windowEnd: event?.endYear ?? null,
        windowWidth: event ? event.endYear - event.startYear + 1 : null,
        breakpointError: windowApplicable && operationCorrect && truth?.year !== null
            && topYear !== null ? topYear - truth!.year! : null,
        saveReopenStable: input.saveReopenStable,
        strictResponse: input.snapshot.strictEvent !== null,
        reviewResponse: input.snapshot.reviewEvent !== null,
        refusalReason: input.snapshot.reviewDecision?.reason
            ?? input.snapshot.audit?.finalReason
            ?? null,
        referenceMode: input.snapshot.referenceMode,
        referenceAnchorCount: input.snapshot.referenceAnchorCount,
        referenceSourceCount: input.snapshot.audit?.referenceSourceCount ?? null,
        minimumReferenceDepth: input.snapshot.audit?.minimumReferenceDepth ?? null,
        medianReferenceDepth: input.snapshot.audit?.medianReferenceDepth ?? null,
        cofechaFlagged: input.cofechaFlagged,
        elapsedMs: input.snapshot.durationMs,
        quality: input.quality,
        error: input.snapshot.error,
    };
};

const pearson = (left: Map<number, number>, right: Map<number, number>): {
    correlation: number | null;
    overlap: number;
} => {
    let count = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    left.forEach((x, year) => {
        const y = right.get(year);
        if (y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return;
        count += 1;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
    });
    const numerator = sxy - sx * sy / Math.max(1, count);
    const denominator = Math.sqrt(
        Math.max(0, sxx - sx * sx / Math.max(1, count))
        * Math.max(0, syy - sy * sy / Math.max(1, count)),
    );
    return {
        correlation: count >= 20 && denominator > 0 ? numerator / denominator : null,
        overlap: count,
    };
};

const quantile = (values: number[], probability: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.max(
        0,
        Math.ceil(sorted.length * probability) - 1,
    ))];
};

const standardized = (tree: RwlTreeData): Map<number, number> => new Map(
    cofechaStyleStandardize(new Map(Array.from(tree).flatMap(([year, value]) => (
        typeof value === "number" && value > 0
            ? [[year, value] as [number, number]]
            : []
    )))).map((point) => [point.year, point.value]),
);

export const computeFileInterseries = (siteData: RwlSiteData): {
    median: number | null;
    iqr: number | null;
} => {
    const rows = Array.from(siteData, ([seriesId, values]) => ({
        seriesId,
        values: standardized(values),
    })).filter((row) => row.values.size >= 50);
    const correlations: number[] = [];
    for (let left = 0; left < rows.length; left += 1) {
        for (let right = left + 1; right < rows.length; right += 1) {
            const result = pearson(rows[left].values, rows[right].values);
            if (result.overlap >= 50 && result.correlation !== null) {
                correlations.push(result.correlation);
            }
        }
    }
    const q25 = quantile(correlations, 0.25);
    const q75 = quantile(correlations, 0.75);
    return {
        median: quantile(correlations, 0.5),
        iqr: q25 !== null && q75 !== null ? q75 - q25 : null,
    };
};

const longestZeroBlock = (tree: RwlTreeData): number => {
    const zeros = Array.from(tree).filter(([, value]) => value === 0)
        .map(([year]) => year).sort((left, right) => left - right);
    let longest = 0;
    let current = 0;
    let previous: number | null = null;
    zeros.forEach((year) => {
        current = previous !== null && year === previous + 1 ? current + 1 : 1;
        longest = Math.max(longest, current);
        previous = year;
    });
    return longest;
};

export const computeQualityMetrics = (input: {
    cleanSite: RwlSiteData;
    targetId: string;
    cleanSnapshot: LegacyDiagnosisSnapshot;
    context: CofechaContext;
    fileInterseries: { median: number | null; iqr: number | null };
}): LegacyQualityMetrics => {
    const target = input.cleanSite.get(input.targetId);
    if (!target) throw new Error(`quality target missing: ${input.targetId}`);
    const targetResidual = standardized(target);
    const targetExcludedFlags = new Set([...input.context.flaggedIds, input.targetId]);
    let reference = createCofechaPassReferenceConfig({
        siteData: input.cleanSite,
        flaggedAIds: targetExcludedFlags,
        cofechaRunId: `quality-${input.targetId}`,
        rwlHash: input.context.rwlHash,
    });
    if (!reference.cofechaPassReference) {
        reference = createCofechaMasterReferenceConfig({
            siteData: input.cleanSite,
            flaggedAIds: targetExcludedFlags,
            cofechaRunId: `quality-${input.targetId}`,
            rwlHash: input.context.rwlHash,
            masterDatingSeries: parseCofechaResult(
                input.context.outText,
            ).masterDatingSeries,
        });
    }
    const points = reference.cofechaPassReference?.points ?? [];
    const referenceMap = new Map(points.map((point) => [point.year, point.value]));
    const correlation = pearson(targetResidual, referenceMap);
    const years = Array.from(targetResidual.keys()).sort((left, right) => left - right);
    const segmentCorrelations: number[] = [];
    if (years.length > 0) {
        for (let start = years[0]; start + 49 <= years[years.length - 1]; start += 25) {
            const segmentTarget = new Map(Array.from(targetResidual).filter(([year]) => (
                year >= start && year <= start + 49
            )));
            const result = pearson(segmentTarget, referenceMap);
            if (result.overlap >= 25 && result.correlation !== null) {
                segmentCorrelations.push(result.correlation);
            }
        }
    }
    const q25 = quantile(segmentCorrelations, 0.25);
    const q75 = quantile(segmentCorrelations, 0.75);
    const zeroCount = Array.from(target.values()).filter((value) => value === 0).length;
    const depth = points.map((point) => point.replication);
    return {
        leaveOneOutCorrelation: correlation.correlation,
        fileInterseriesCorrelationMedian: input.fileInterseries.median,
        fileInterseriesCorrelationIqr: input.fileInterseries.iqr,
        validOverlapYears: correlation.overlap,
        effectiveReferenceSourceCount:
            reference.cofechaPassReference?.includedSeriesIds.length ?? 0,
        referenceDepthMedian: quantile(depth, 0.5),
        referenceDepthMinimum: depth.length > 0 ? Math.min(...depth) : null,
        segmentCorrelationMedian: quantile(segmentCorrelations, 0.5),
        segmentCorrelationIqr: q25 !== null && q75 !== null ? q75 - q25 : null,
        segmentStability: segmentCorrelations.length > 0
            ? segmentCorrelations.filter((value) => value >= 0.3).length
                / segmentCorrelations.length
            : null,
        cofechaPassAnchorRatio: input.cleanSite.size > 0
            ? (reference.classification?.anchorPassIds.length ?? 0) / input.cleanSite.size
            : null,
        zeroMissingDensity: zeroCount / Math.max(1, target.size),
        discreteZeroCount: zeroCount,
        longestZeroMissingBlock: longestZeroBlock(target),
        seriesLength: target.size,
        identifiability: "absolute-identifiable",
        unavailableReason: input.cleanSnapshot.error,
    };
};

export const applyConfirmedEvent = (
    site: RwlSiteData,
    event: DiagnosisEvent,
    truth: LegacyTruthSpec,
): { applied: boolean; reason: string | null } => {
    const current = site.get(event.seriesId);
    if (!current) return { applied: false, reason: "series_missing" };
    if (!truthMatchesOperation(event, truth)) {
        return { applied: false, reason: "operation_mismatch" };
    }
    if (event.eventType !== "wholeSeriesMove") {
        if (truth.year === null || truth.year < event.startYear || truth.year > event.endYear) {
            return { applied: false, reason: "truth_outside_window" };
        }
    }
    if (event.eventType === "missingRing") {
        site.set(event.seriesId, insertMissingYearAtSide(current, truth.year!, "right"));
        return { applied: true, reason: null };
    }
    if (event.eventType === "falseRing") {
        site.set(event.seriesId, deleteYearWithMode(current, truth.year!, "direct", "right"));
        return { applied: true, reason: null };
    }
    const shiftYears = event.shiftYears ?? 0;
    const range = treeRange(current);
    const startYear = range.startYear;
    const endYear = event.eventType === "partialMove" ? truth.year! - 1 : range.endYear;
    const conflicts = getSeriesMoveConflicts(current, startYear, endYear, shiftYears);
    if (conflicts.length > 0) {
        return { applied: false, reason: `move_conflict:${conflicts.join(",")}` };
    }
    site.set(event.seriesId, moveSeriesTailByOffset(
        current,
        startYear,
        endYear,
        shiftYears,
    ));
    return { applied: true, reason: null };
};

export const qualityBin = (
    value: number | null,
    cuts: number[],
): string => {
    if (value === null || !Number.isFinite(value)) return "unavailable";
    for (let index = 0; index < cuts.length - 1; index += 1) {
        if (value >= cuts[index] && value < cuts[index + 1]) {
            return `${cuts[index]}..${cuts[index + 1]}`;
        }
    }
    return `${cuts.at(-2)}..${cuts.at(-1)}`;
};

export const assertFrozenConfig = (
    config: LegacyConfig,
    manifestConfigHash: string,
    configBytes: Buffer,
): string => {
    const hash = sha256Bytes(configBytes);
    if (hash !== manifestConfigHash) {
        throw new Error(`config hash mismatch: ${hash} != ${manifestConfigHash}`);
    }
    if (config.schemaVersion !== 1) throw new Error("unsupported config schema");
    return hash;
};

export const isResumableCompletedStage = (stage: unknown): boolean => (
    Boolean(stage)
    && typeof stage === "object"
    && (stage as { passed?: unknown }).passed !== false
);
