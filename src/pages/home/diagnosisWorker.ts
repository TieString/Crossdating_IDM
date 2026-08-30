/// <reference lib="webworker" />

import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import { applyAuthoritativeModelDecision } from "@/features/crossdating/diagnosis/authoritativeModelProjection";
import {
    selectInsufficientReferencePairwiseFallback,
} from "@/features/crossdating/diagnosis/insufficientReferenceFallback";
import type {
    AuthoritativeDiagnosisDecision,
    CrossdatingDiagnosis,
    DiagnosisEvent,
    ReviewWindowDisplayMode,
    SeriesCoreDiagnosis,
} from "@/features/crossdating/diagnosis/types";
import { buildOnlineUnifiedEvidenceForTarget } from "@/features/crossdating/diagnosis/onlineUnifiedEvidenceRuntime";
import {
    inferOnlineUnifiedDiagnosis,
    warmOnlineUnifiedModel,
} from "@/features/crossdating/diagnosis/onlineUnifiedModel";
import type { ReferenceSeriesConfig } from "@/features/crossdating/reference";
import {
    createPairwiseBootstrapReferenceConfig,
    createPairwiseBootstrapTargetReferenceConfig,
} from "@/features/crossdating/pairwiseBootstrap";
import type { RwlSiteData } from "@/features/rwl/types";
import { selectAutomaticDiagnosisReferenceConfig } from "./diagnosisReferencePolicy";
import { createEmptyCrossdatingDiagnosis } from "./workspaceState";

export type DiagnosisWorkerRequest = {
    id: number;
    siteData: RwlSiteData;
    referenceConfig: ReferenceSeriesConfig | null;
    targetTree?: string;
    // 当前 COFECHA .OUT 原始文本（仅当其与当前数据一致/新鲜时传入）。驱动 COFECHA [A] 段级 lag 候选生成。
    cofechaText?: string;
    // 后台广度扫描与当前可见诊断都使用 review 门槛；严格自动结果仍保留在 diagnosis.events。
    reviewWindowDisplayMode?: ReviewWindowDisplayMode;
    // 当前可见序列在保存前后需要完整假设链做跨证据裁决；后台广度扫描不请求该字段。
    includeEventDecisionAudits?: boolean;
};

export type DiagnosisWorkerResponse =
    | {
        id: number;
        diagnosis: CrossdatingDiagnosis;
        elapsedMs: number;
        evidenceElapsedMs: number;
        packageElapsedMs: number;
        modelElapsedMs: number;
        operationCandidateCount: number;
        locationCandidateCount: number;
      }
    | {
        id: number;
        error: string;
      };

const ctx = self as DedicatedWorkerGlobalScope;

warmOnlineUnifiedModel();

ctx.addEventListener("message", (event: MessageEvent<DiagnosisWorkerRequest>) => {
    const {
        id,
        siteData,
        referenceConfig,
        targetTree,
        cofechaText,
        reviewWindowDisplayMode,
        includeEventDecisionAudits,
    } = event.data;

    let phase = "reference";
    try {
        const startedAt = performance.now();
        const automaticReferenceConfig = selectAutomaticDiagnosisReferenceConfig(referenceConfig);
        if (!automaticReferenceConfig) {
            ctx.postMessage({
                id,
                diagnosis: createEmptyCrossdatingDiagnosis(),
                elapsedMs: performance.now() - startedAt,
                evidenceElapsedMs: performance.now() - startedAt,
                packageElapsedMs: 0,
                modelElapsedMs: 0,
                operationCandidateCount: 0,
                locationCandidateCount: 0,
            } satisfies DiagnosisWorkerResponse);
            return;
        }
        const targetReferenceConfig = createPairwiseBootstrapTargetReferenceConfig(
            siteData,
            automaticReferenceConfig,
            targetTree,
        );
        let effectiveReferenceConfig = targetReferenceConfig;
        phase = "evidence";
        let capturedCore: SeriesCoreDiagnosis | null = null;
        let diagnosis = diagnoseCrossdating(siteData, {
            referenceConfig: targetReferenceConfig,
            targetTrees: targetTree ? [targetTree] : [],
            cofechaText,
            reviewWindowDisplayMode,
            includeEventDecisionAudits: targetTree !== undefined
                ? true : includeEventDecisionAudits,
            captureSeriesCore: (core) => {
                if (core.targetTree === targetTree) capturedCore = core;
            },
        });
        const needsPairwiseFallback = targetTree !== undefined
            && targetReferenceConfig?.cofechaPassReference?.source !== "pairwise_bootstrap"
            && (diagnosis.reviewEvents?.length ?? 0) === 0
            && (diagnosis.eventDecisionAudits?.[0]?.finalReason
                === "insufficient_reference_depth"
                || diagnosis.reviewWindowDecisions?.[0]?.reason
                    === "partial_move_evidence_insufficient");
        if (needsPairwiseFallback
            && targetTree !== undefined
            && automaticReferenceConfig?.classification) {
            const pairwiseReference = createPairwiseBootstrapReferenceConfig({
                siteData,
                flaggedAIds: automaticReferenceConfig.classification.candidateFlaggedIds,
                cofechaRunId: `${automaticReferenceConfig.cofechaRunId ?? "diagnosis"}-insufficient-reference`,
                rwlHash: automaticReferenceConfig.rwlHash ?? "",
            });
            const targetPairwiseReference = createPairwiseBootstrapTargetReferenceConfig(
                siteData,
                pairwiseReference,
                targetTree,
            );
            if (targetPairwiseReference?.cofechaPassReference) {
                const pairwiseDiagnosis = diagnoseCrossdating(siteData, {
                    referenceConfig: targetPairwiseReference,
                    targetTrees: [targetTree],
                    cofechaText,
                    reviewWindowDisplayMode,
                    includeEventDecisionAudits,
                    captureSeriesCore: (core) => {
                        if (core.targetTree === targetTree) capturedCore = core;
                    },
                });
                diagnosis = selectInsufficientReferencePairwiseFallback(
                    diagnosis,
                    pairwiseDiagnosis,
                    siteData.get(targetTree),
                );
                effectiveReferenceConfig = targetPairwiseReference;
            }
        }
        const evidenceElapsedMs = performance.now() - startedAt;
        let packageElapsedMs = 0;
        let modelElapsedMs = 0;
        let operationCandidateCount = 0;
        let locationCandidateCount = 0;
        if (targetTree && effectiveReferenceConfig) {
            phase = "package";
            const packageStartedAt = performance.now();
            const bundle = buildOnlineUnifiedEvidenceForTarget({
                diagnosis,
                siteData,
                targetTree,
                referenceConfig: effectiveReferenceConfig,
                core: capturedCore,
            });
            packageElapsedMs = performance.now() - packageStartedAt;
            let decision: AuthoritativeDiagnosisDecision;
            let executableEvent: DiagnosisEvent | null = null;
            if (bundle) {
                phase = "model";
                const inference = inferOnlineUnifiedDiagnosis(bundle);
                decision = inference.decision;
                executableEvent = inference.selectedPackage?.event ?? null;
                modelElapsedMs = inference.operationElapsedMs + inference.locationElapsedMs;
                operationCandidateCount = inference.operationCandidateCount;
                locationCandidateCount = inference.locationCandidateCount;
            } else {
                decision = {
                    schemaVersion: 1,
                    modelVersion: "applied-residual-unified-v12-online-v1",
                    authority: "authoritative",
                    status: "refused",
                    eventType: "noEvent",
                    shiftYears: 0,
                    startYear: null,
                    endYear: null,
                    topYear: null,
                    identityGroup: null,
                    packageId: null,
                    refusalReason: "online_evidence_bundle_unavailable",
                };
            }
            phase = "projection";
            diagnosis = applyAuthoritativeModelDecision(
                diagnosis,
                decision,
                targetTree,
                executableEvent,
            );
        }
        ctx.postMessage({
            id,
            diagnosis,
            elapsedMs: performance.now() - startedAt,
            evidenceElapsedMs,
            packageElapsedMs,
            modelElapsedMs,
            operationCandidateCount,
            locationCandidateCount,
        } satisfies DiagnosisWorkerResponse);
    } catch (error) {
        ctx.postMessage({
            id,
            error: `[${phase}] ${error instanceof Error
                ? error.stack ?? error.message
                : String(error)}`,
        } satisfies DiagnosisWorkerResponse);
    }
});
