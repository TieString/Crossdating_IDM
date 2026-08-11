/// <reference lib="webworker" />

import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import {
    selectInsufficientReferencePairwiseFallback,
} from "@/features/crossdating/diagnosis/insufficientReferenceFallback";
import type {
    CrossdatingDiagnosis,
    ReviewWindowDisplayMode,
} from "@/features/crossdating/diagnosis/types";
import type { ReferenceSeriesConfig } from "@/features/crossdating/reference";
import {
    createPairwiseBootstrapReferenceConfig,
    createPairwiseBootstrapTargetReferenceConfig,
} from "@/features/crossdating/pairwiseBootstrap";
import type { RwlSiteData } from "@/features/rwl/types";

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
      }
    | {
        id: number;
        error: string;
      };

const ctx = self as DedicatedWorkerGlobalScope;

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

    try {
        const startedAt = performance.now();
        const targetReferenceConfig = createPairwiseBootstrapTargetReferenceConfig(
            siteData,
            referenceConfig,
            targetTree,
        );
        let diagnosis = diagnoseCrossdating(siteData, {
            referenceConfig: targetReferenceConfig,
            targetTrees: targetTree ? [targetTree] : [],
            cofechaText,
            reviewWindowDisplayMode,
            includeEventDecisionAudits,
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
            && referenceConfig?.classification) {
            const pairwiseReference = createPairwiseBootstrapReferenceConfig({
                siteData,
                flaggedAIds: referenceConfig.classification.candidateFlaggedIds,
                cofechaRunId: `${referenceConfig.cofechaRunId ?? "diagnosis"}-insufficient-reference`,
                rwlHash: referenceConfig.rwlHash ?? "",
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
                });
                diagnosis = selectInsufficientReferencePairwiseFallback(
                    diagnosis,
                    pairwiseDiagnosis,
                    siteData.get(targetTree),
                );
            }
        }
        ctx.postMessage({
            id,
            diagnosis,
            elapsedMs: performance.now() - startedAt,
        } satisfies DiagnosisWorkerResponse);
    } catch (error) {
        ctx.postMessage({
            id,
            error: error instanceof Error ? error.stack ?? error.message : String(error),
        } satisfies DiagnosisWorkerResponse);
    }
});
