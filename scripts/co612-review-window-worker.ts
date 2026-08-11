/** Persistent truth-blind worker for per-target co612 review-window diagnosis. */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import {
    parseCofechaResult,
} from "@/features/cofecha/formatter";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import {
    selectInsufficientReferencePairwiseFallback,
} from "@/features/crossdating/diagnosis/insufficientReferenceFallback";
import {
    createCofechaMasterReferenceConfig,
    createCofechaPassReferenceConfig,
} from "@/features/crossdating/reference";
import {
    createPairwiseBootstrapReferenceConfig,
    createPairwiseBootstrapTargetReferenceConfig,
} from "@/features/crossdating/pairwiseBootstrap";
import type { RwlSiteData } from "@/features/rwl/types";
import { parseRwl } from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

type WorkerRequest = {
    requestId: string;
    sitePath: string;
    cofechaOutPath: string;
    targetIds: string[];
    cofechaFlaggedIds: string[];
    pairwiseClusterIds: string[];
    usePairwiseBootstrap: boolean;
    runId: string;
    rwlHash: string;
};

const siteFromPath = (path: string): RwlSiteData => new Map(Array.from(
    parseRwl(readFileSync(path, "utf8")),
    ([seriesId, series]) => [seriesId, new Map(series.valuesByYear)],
));

const handle = (request: WorkerRequest) => {
    const siteData = siteFromPath(request.sitePath);
    const outText = readFileSync(request.cofechaOutPath, "utf8");
    const cofechaResult = parseCofechaResult(outText);
    const cofechaFlagged = new Set(request.cofechaFlaggedIds);
    const pairwiseCluster = new Set(request.pairwiseClusterIds);
    const pairwiseBootstrapReference = request.usePairwiseBootstrap
        ? createPairwiseBootstrapReferenceConfig({
            siteData,
            flaggedAIds: request.cofechaFlaggedIds,
            cofechaRunId: request.runId,
            rwlHash: request.rwlHash,
            clusterIds: request.pairwiseClusterIds,
        })
        : null;
    let fallbackPairwiseReference = pairwiseBootstrapReference;
    const targets = request.targetIds.map((seriesId) => {
        const startedAt = Date.now();
        const effectiveFlagged = request.usePairwiseBootstrap
            ? new Set(Array.from(siteData.keys()).filter((candidateId) => (
                !pairwiseCluster.has(candidateId) || candidateId === seriesId
            )))
            : new Set([...cofechaFlagged, seriesId]);
        let referenceConfig = pairwiseBootstrapReference
            ? createPairwiseBootstrapTargetReferenceConfig(
                siteData,
                pairwiseBootstrapReference,
                seriesId,
            )
            : createCofechaPassReferenceConfig({
                siteData,
                flaggedAIds: effectiveFlagged,
                cofechaRunId: `${request.runId}-${seriesId}`,
                rwlHash: request.rwlHash,
            });
        if (!referenceConfig.cofechaPassReference) {
            referenceConfig = createCofechaMasterReferenceConfig({
                siteData,
                flaggedAIds: effectiveFlagged,
                cofechaRunId: `${request.runId}-${seriesId}`,
                rwlHash: request.rwlHash,
                masterDatingSeries: cofechaResult.masterDatingSeries,
            });
        }
        let diagnosisReferenceConfig = referenceConfig;
        let diagnosis = diagnoseCrossdating(siteData, {
            referenceConfig,
            targetTrees: [seriesId],
            cofechaText: outText,
            includeEventDecisionAudits: true,
            reviewWindowDisplayMode: "review",
        });
        const needsPairwiseFallback = !request.usePairwiseBootstrap
            && (diagnosis.reviewEvents?.length ?? 0) === 0
            && diagnosis.eventDecisionAudits?.[0]?.finalReason
                === "insufficient_reference_depth";
        if (needsPairwiseFallback) {
            fallbackPairwiseReference ??= createPairwiseBootstrapReferenceConfig({
                siteData,
                flaggedAIds: request.cofechaFlaggedIds,
                cofechaRunId: `${request.runId}-insufficient-reference`,
                rwlHash: request.rwlHash,
                clusterIds: request.pairwiseClusterIds,
            });
            const targetPairwiseReference = createPairwiseBootstrapTargetReferenceConfig(
                siteData,
                fallbackPairwiseReference,
                seriesId,
            );
            if (targetPairwiseReference?.cofechaPassReference) {
                const pairwiseDiagnosis = diagnoseCrossdating(siteData, {
                    referenceConfig: targetPairwiseReference,
                    targetTrees: [seriesId],
                    cofechaText: outText,
                    includeEventDecisionAudits: true,
                    reviewWindowDisplayMode: "review",
                });
                const selected = selectInsufficientReferencePairwiseFallback(
                    diagnosis,
                    pairwiseDiagnosis,
                );
                if (selected === pairwiseDiagnosis) {
                    diagnosis = pairwiseDiagnosis;
                    diagnosisReferenceConfig = targetPairwiseReference;
                }
            }
        }
        const audit = diagnosis.eventDecisionAudits?.[0];
        const reviewDecision = diagnosis.reviewWindowDecisions?.[0];
        const jointDecision = diagnosis.jointEventDecisions?.[0];
        if (!audit || !reviewDecision || !jointDecision) {
            throw new Error(`missing review decision for ${seriesId}`);
        }
        return {
            seriesId,
            strictEvent: diagnosis.events[0] ?? null,
            reviewEvent: diagnosis.reviewEvents?.[0] ?? null,
            reviewDecision,
            jointDecision,
            audit,
            referenceAnchorCount:
                diagnosisReferenceConfig.classification?.anchorPassIds.length ?? 0,
            durationMs: Date.now() - startedAt,
        };
    });
    return { requestId: request.requestId, targets };
};

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
    if (!line.trim()) return;
    let requestId = "unknown";
    try {
        const request = JSON.parse(line) as WorkerRequest;
        requestId = request.requestId;
        process.stdout.write(`CO612_WORKER_RESPONSE ${JSON.stringify(handle(request))}\n`);
    } catch (error) {
        process.stdout.write(`CO612_WORKER_RESPONSE ${JSON.stringify({
            requestId,
            error: error instanceof Error ? error.stack ?? error.message : String(error),
        })}\n`);
    }
});
