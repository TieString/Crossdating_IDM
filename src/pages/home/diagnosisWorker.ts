/// <reference lib="webworker" />

import {
    diagnoseCrossdating,
    type CrossdatingDiagnosis,
} from "@/features/crossdating/diagnosis";
import type { ReferenceSeriesConfig } from "@/features/crossdating/reference";
import type { RwlSiteData } from "@/features/rwl/types";

export type DiagnosisWorkerRequest = {
    id: number;
    siteData: RwlSiteData;
    referenceConfig: ReferenceSeriesConfig | null;
    // 当前 COFECHA .OUT 原始文本（仅当其与当前数据一致/新鲜时传入）。驱动 COFECHA [A] 段级 lag 候选生成。
    cofechaText?: string;
};

export type DiagnosisWorkerResponse =
    | {
        id: number;
        diagnosis: CrossdatingDiagnosis;
      }
    | {
        id: number;
        error: string;
      };

const ctx = self as DedicatedWorkerGlobalScope;

ctx.addEventListener("message", (event: MessageEvent<DiagnosisWorkerRequest>) => {
    const { id, siteData, referenceConfig, cofechaText } = event.data;

    try {
        ctx.postMessage({
            id,
            diagnosis: diagnoseCrossdating(siteData, { referenceConfig, cofechaText }),
        } satisfies DiagnosisWorkerResponse);
    } catch (error) {
        ctx.postMessage({
            id,
            error: error instanceof Error ? error.message : String(error),
        } satisfies DiagnosisWorkerResponse);
    }
});
