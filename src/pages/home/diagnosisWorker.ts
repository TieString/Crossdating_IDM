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
    const { id, siteData, referenceConfig } = event.data;

    try {
        ctx.postMessage({
            id,
            diagnosis: diagnoseCrossdating(siteData, { referenceConfig }),
        } satisfies DiagnosisWorkerResponse);
    } catch (error) {
        ctx.postMessage({
            id,
            error: error instanceof Error ? error.message : String(error),
        } satisfies DiagnosisWorkerResponse);
    }
});
