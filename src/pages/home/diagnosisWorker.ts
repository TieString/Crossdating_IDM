/// <reference lib="webworker" />

import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import type {
    CrossdatingDiagnosis,
    ReviewWindowDisplayMode,
} from "@/features/crossdating/diagnosis/types";
import type { ReferenceSeriesConfig } from "@/features/crossdating/reference";
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
    } = event.data;

    try {
        const startedAt = performance.now();
        ctx.postMessage({
            id,
            diagnosis: diagnoseCrossdating(siteData, {
                referenceConfig,
                targetTrees: targetTree ? [targetTree] : [],
                cofechaText,
                reviewWindowDisplayMode,
            }),
            elapsedMs: performance.now() - startedAt,
        } satisfies DiagnosisWorkerResponse);
    } catch (error) {
        ctx.postMessage({
            id,
            error: error instanceof Error ? error.stack ?? error.message : String(error),
        } satisfies DiagnosisWorkerResponse);
    }
});
