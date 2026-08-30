import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
    extractPart6FlaggedASeriesIds,
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import { applyAuthoritativeModelDecision } from "@/features/crossdating/diagnosis/authoritativeModelProjection";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import { buildOnlineUnifiedEvidenceForTarget } from "@/features/crossdating/diagnosis/onlineUnifiedEvidenceRuntime";
import {
    inferOnlineUnifiedDiagnosis,
    warmOnlineUnifiedModel,
} from "@/features/crossdating/diagnosis/onlineUnifiedModel";
import {
    createProductionReferenceForEvaluation,
    loadRwl,
} from "./legacy-generalization/evaluator";
import type { SeriesCoreDiagnosis } from "@/features/crossdating/diagnosis/types";

const argumentsByName = Object.fromEntries(process.argv.slice(2).flatMap((argument) => {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    return match ? [[match[1]!, match[2]!]] : [];
}));
const warmStartedAt = performance.now();
warmOnlineUnifiedModel();
const modelWarmElapsedMs = performance.now() - warmStartedAt;
const attemptDir = resolve(argumentsByName["attempt-dir"] ?? "");
const targetId = argumentsByName["target-id"] ?? "";
if (!argumentsByName["attempt-dir"] || !targetId) {
    throw new Error("--attempt-dir and --target-id are required");
}

const rwlPath = join(attemptDir, "state.rwl");
const outPath = join(attemptDir, "VERYCOF.OUT");
const rwlBytes = readFileSync(rwlPath);
const outText = readFileSync(outPath, "utf8");
const loaded = await loadRwl(rwlPath, "tucson-auto");
const part6 = splitReportByParts(outText).get("PART 6") ?? "";
const reference = createProductionReferenceForEvaluation({
    siteData: loaded.siteData,
    targetId,
    flaggedAIds: extractPart6FlaggedASeriesIds(part6),
    cofechaRunId: "online-unified-reproduction",
    rwlHash: createHash("sha256").update(rwlBytes).digest("hex"),
    masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
}).referenceConfig;

const diagnosisStartedAt = performance.now();
let capturedCore: SeriesCoreDiagnosis | null = null;
const diagnosis = diagnoseCrossdating(loaded.siteData, {
    referenceConfig: reference,
    targetTrees: [targetId],
    cofechaText: outText,
    reviewWindowDisplayMode: "review",
    includeEventDecisionAudits: true,
    captureSeriesCore: (core) => {
        if (core.targetTree === targetId) capturedCore = core;
    },
});
const diagnosisElapsedMs = performance.now() - diagnosisStartedAt;
const packageStartedAt = performance.now();
const bundle = buildOnlineUnifiedEvidenceForTarget({
    diagnosis,
    siteData: loaded.siteData,
    targetTree: targetId,
    referenceConfig: reference,
    core: capturedCore,
});
const packageElapsedMs = performance.now() - packageStartedAt;
if (!bundle) throw new Error("online evidence bundle unavailable");
const inferenceStartedAt = performance.now();
const inference = inferOnlineUnifiedDiagnosis(bundle);
const inferenceElapsedMs = performance.now() - inferenceStartedAt;
const projected = applyAuthoritativeModelDecision(
    diagnosis,
    inference.decision,
    targetId,
    inference.selectedPackage?.event ?? null,
);

console.log(JSON.stringify({
    targetId,
    diagnosisElapsedMs,
    packageElapsedMs,
    inferenceElapsedMs,
    modelWarmElapsedMs,
    operationModelElapsedMs: inference.operationElapsedMs,
    locationModelElapsedMs: inference.locationElapsedMs,
    operationCandidateCount: inference.operationCandidateCount,
    locationCandidateCount: inference.locationCandidateCount,
    decision: inference.decision,
    projectedStatus: projected.authoritativeModelDecision?.status,
    projectedEvent: projected.reviewEvents?.[0] ?? null,
}, null, 2));
