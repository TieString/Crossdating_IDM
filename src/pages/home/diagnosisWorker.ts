/// <reference lib="webworker" />

import { applyAuthoritativeModelDecision } from "@/features/crossdating/diagnosis/authoritativeModelProjection";
import { loadUnifiedV5Runtime } from "@/features/crossdating/diagnosis/unifiedV5Runtime";
import type { CrossdatingDiagnosis } from "@/features/crossdating/diagnosis/types";
import type { RwlSiteData } from "@/features/rwl/types";
import { createLatestRequestQueue } from "./latestRequestQueue";
import { createEmptyCrossdatingDiagnosis } from "./workspaceState";

export type DiagnosisWorkerRequest = {
    id: number;
    siteData: RwlSiteData;
    referenceReady: boolean;
    targetTree?: string;
    /** Physical file precision, retained even if an edit removed a terminator. */
    sourceStopMarker?: number;
};

export type DiagnosisWorkerResponse = {
    id: number;
    diagnosis: CrossdatingDiagnosis;
    elapsedMs: number;
    evidenceElapsedMs: number;
    packageElapsedMs: number;
    modelElapsedMs: number;
    operationCandidateCount: number;
    locationCandidateCount: number;
} | { id: number; error: string };

const ctx = self as DedicatedWorkerGlobalScope;

const enqueue = createLatestRequestQueue(async (request: DiagnosisWorkerRequest) => {
    const { id, siteData, referenceReady, targetTree, sourceStopMarker } = request;
    const startedAt = performance.now();
    let phase = "reference";
    try {
        // Preserve the workspace prerequisite; no selection means no diagnosis.
        if (!targetTree || !referenceReady) {
            ctx.postMessage({ id, diagnosis: createEmptyCrossdatingDiagnosis(), elapsedMs: performance.now() - startedAt,
                evidenceElapsedMs: 0, packageElapsedMs: 0, modelElapsedMs: 0,
                operationCandidateCount: 0, locationCandidateCount: 0 } satisfies DiagnosisWorkerResponse);
            return;
        }
        phase = "model-load";
        const runtime = await loadUnifiedV5Runtime();
        phase = "unified-v5";
        const inference = await runtime.infer(siteData, targetTree, sourceStopMarker);
        phase = "projection";
        const diagnosis = applyAuthoritativeModelDecision(createEmptyCrossdatingDiagnosis(), inference.decision,
            targetTree, inference.selectedPackage?.event ?? null);
        ctx.postMessage({ id, diagnosis, elapsedMs: performance.now() - startedAt,
            evidenceElapsedMs: inference.operationElapsedMs, packageElapsedMs: 0,
            modelElapsedMs: inference.operationElapsedMs + inference.locationElapsedMs,
            operationCandidateCount: inference.operationCandidateCount,
            locationCandidateCount: inference.locationCandidateCount } satisfies DiagnosisWorkerResponse);
    } catch (error) {
        ctx.postMessage({ id, error: "[" + phase + "] " + (error instanceof Error ? error.stack ?? error.message : String(error)) } satisfies DiagnosisWorkerResponse);
    }
}, (error, request) => ctx.postMessage({ id: request.id, error: String(error) } satisfies DiagnosisWorkerResponse));
ctx.addEventListener("message", (event: MessageEvent<DiagnosisWorkerRequest>) => enqueue(event.data));
