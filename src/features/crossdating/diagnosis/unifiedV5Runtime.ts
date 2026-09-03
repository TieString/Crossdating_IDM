/** Application adapter: immutable one-operation output and one-way missing review. */
import type { RwlSiteData } from "../../rwl/types";
import type { AuthoritativeDiagnosisDecision, DiagnosisEvent } from "./types";
import { CofechaEngineEvidenceCache } from "./cofechaEngineEvidence";
import { normalizeCofechaRuntimeUnits } from "./cofechaInputUnits";
import { buildUnifiedV5Evidence } from "./unifiedV5Evidence";
import { V5_IDENTITIES, type V5Operation } from "./unifiedV5Operations";
import { UnifiedV5Predictor, UNIFIED_V5_RUNTIME_VERSION, UNIFIED_V5_SOURCE_SHA256, UNIFIED_V5_ASSET_SHA256, type UnifiedV5Model } from "./unifiedV5Model";
import { buildOnlineUnifiedExecutablePackage, ONLINE_UNIFIED_EVIDENCE_VERSION,
    type OnlineUnifiedEvidenceBundle, type OnlineUnifiedExecutablePackage } from "./onlineUnifiedEvidence";

type V5Prediction = ReturnType<UnifiedV5Predictor["predict"]>;
export type UnifiedV5Inference = {
    decision: AuthoritativeDiagnosisDecision;
    selectedPackage: OnlineUnifiedExecutablePackage | null;
    prediction: V5Prediction | null;
    stateHash: string;
    operationElapsedMs: number;
    locationElapsedMs: number;
    operationCandidateCount: number;
    locationCandidateCount: number;
};

export function createUnifiedV5MinimalBundle(site: RwlSiteData, targetId: string): OnlineUnifiedEvidenceBundle | null {
    const years = [...(site.get(targetId) ?? [])].filter(([, value]) => value !== null && value !== -9999).map(([y]) => y);
    if (!years.length) return null;
    // Transport-only adapter for the existing executable editor package. None of
    // these legacy diagnostic fields are model inputs to v5.
    return { schemaVersion: 1, evidenceVersion: ONLINE_UNIFIED_EVIDENCE_VERSION, seriesId: targetId,
        targetRange: { startYear: Math.min(...years), endYear: Math.max(...years) },
        cofechaFlagged: false, referenceSourceCount: Math.max(0, site.size - 1), minimumReferenceDepth: 0,
        medianReferenceDepth: 0, candidateCount: 0, candidateModeCount: 0, finalReason: "unified_v5_direct_evidence",
        pass: {}, claims: [], eventSources: [], operations: [], dynamicSelection: null, unitSelection: null,
        rawGlobalLag: 0, cofechaGlobalLag: 0 };
}

function refusal(reason: string): AuthoritativeDiagnosisDecision {
    return { schemaVersion: 1, modelVersion: UNIFIED_V5_RUNTIME_VERSION, authority: "authoritative", status: "refused",
        eventType: "noEvent", shiftYears: 0, startYear: null, endYear: null, topYear: null,
        identityGroup: null, packageId: null, refusalReason: reason };
}

const eventType = (operation: Exclude<V5Operation, "none">): DiagnosisEvent["eventType"] => (
    operation === "missing" ? "missingRing" : operation === "false" ? "falseRing" : operation === "partial" ? "partialMove" : "wholeSeriesMove"
);

function executable(bundle: OnlineUnifiedEvidenceBundle, operation: Exclude<V5Operation, "none">, shift: number,
    start: number | null, stateHash: string, score: number, margin: number) {
    const identityGroup = `${UNIFIED_V5_RUNTIME_VERSION}:${stateHash}:${operation}:${shift}`;
    const packageId = start === null ? identityGroup : `${identityGroup}:y${start}`;
    const common = { identityGroup, packageId, eventType: eventType(operation), shiftYears: shift, features: {} };
    const candidate = start === null ? common : { ...common, startYear: start, endYear: start + 12, topYear: start + 6, width: 13 };
    return buildOnlineUnifiedExecutablePackage({ bundle, candidate, score, scoreMargin: margin,
        modelVersion: UNIFIED_V5_RUNTIME_VERSION, interpretationPolicy: "model-owned" });
}

/** Pure UI/editor projection; no classification or location is recomputed here. */
export function projectUnifiedV5Prediction(bundle: OnlineUnifiedEvidenceBundle, prediction: V5Prediction,
    stateHash: string, referenceCount: number): Pick<UnifiedV5Inference, "decision" | "selectedPackage"> {
    const refused = (reason: string) => ({ decision: refusal(reason), selectedPackage: null });
    if (prediction.operation === "none") return refused("unified_v5_frozen_event_gate");
    const pkg = executable(bundle, prediction.operation, prediction.shift, prediction.windowStart, stateHash,
        prediction.identityScores[prediction.chosen]!, prediction.margin);
    if (!pkg) return refused("unified_v5_executable_unavailable");
    if (prediction.operation === "partial") {
        const missing = V5_IDENTITIES.findIndex(([op]) => op === "missing"), start = prediction.missingReviewStart!;
        const review = executable(bundle, "missing", -1, start, stateHash, prediction.identityScores[missing]!, prediction.margin);
        if (!review) return refused("unified_v5_missing_review_unavailable");
        pkg.event = { ...pkg.event, alternativeTypes: ["missingRing"], interpretationAmbiguity: {
            kind: "missingRingsOrPartialMove",
            alternative: { ...review.event, alternativeTypes: [], interpretationAmbiguity: undefined },
            evidence: { interpretationBasis: "frozenConditionalMissingReview", missingRingCount: Math.abs(prediction.shift),
                cumulativeShiftYears: prediction.shift, missingYears: [], partialFirstFixedYear: prediction.windowStart! + 6,
                countEvidence: "cumulativeLagOnly", frontierYear: start + 6, frontierLocalization: "multiReferenceCounterfactual",
                referenceCount, modelScoreMargin: prediction.identityScores[missing]! - prediction.identityScores[prediction.chosen]! },
        } };
    }
    const decision: AuthoritativeDiagnosisDecision = { schemaVersion: 1, modelVersion: UNIFIED_V5_RUNTIME_VERSION,
        authority: "authoritative", status: "selected", eventType: eventType(prediction.operation), shiftYears: prediction.shift,
        startYear: pkg.event.startYear, endYear: pkg.event.endYear,
        topYear: prediction.windowStart === null ? null : prediction.windowStart + 6,
        identityGroup: pkg.identityGroup, packageId: pkg.packageId, refusalReason: null };
    return { decision, selectedPackage: pkg };
}

/** Constructor injection supports identical frozen weights in tests and worker. */
export class UnifiedV5Runtime {
    readonly preprocessing = new CofechaEngineEvidenceCache(1024, true);
    readonly stats = { stateHits: 0, stateMisses: 0 };
    private readonly results = new Map<string, Promise<UnifiedV5Inference>>();
    constructor(readonly predictor: UnifiedV5Predictor, private readonly maximumStates = 32) {}

    async infer(siteData: RwlSiteData, targetId: string, sourceStopMarker = -9999): Promise<UnifiedV5Inference> {
        const site = normalizeCofechaRuntimeUnits(siteData, sourceStopMarker);
        const content = JSON.stringify([UNIFIED_V5_RUNTIME_VERSION, UNIFIED_V5_SOURCE_SHA256, targetId, [...site].map(([id, data]) => [id, [...data]])]);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
        const stateHash = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("");
        const previous = this.results.get(stateHash);
        if (previous) { this.stats.stateHits++; return previous; }
        this.stats.stateMisses++;
        const work = Promise.resolve().then(() => this.calculate(site, targetId, stateHash));
        this.results.set(stateHash, work);
        while (this.results.size > this.maximumStates) this.results.delete(this.results.keys().next().value!);
        try { return await work; }
        catch (error) { this.results.delete(stateHash); throw error; }
    }

    private calculate(site: RwlSiteData, targetId: string, stateHash: string): UnifiedV5Inference {
        const started = performance.now(), bundle = createUnifiedV5MinimalBundle(site, targetId);
        const prepared = this.preprocessing.build(site, targetId, -9999);
        const empty = (reason: string, prediction: V5Prediction | null = null): UnifiedV5Inference => ({
            decision: refusal(reason), selectedPackage: null, prediction, stateHash,
            operationElapsedMs: performance.now() - started, locationElapsedMs: 0,
            operationCandidateCount: prediction ? V5_IDENTITIES.length : 0,
            locationCandidateCount: prediction?.candidateScores.length ?? 0,
        });
        if (!bundle || !prepared) return empty("unified_v5_evidence_unavailable");
        const evidence = buildUnifiedV5Evidence(prepared.sample, [...site.get(targetId)!]);
        const prediction = this.predictor.predict(evidence.features, evidence.codes, evidence.starts, true);
        const projected = projectUnifiedV5Prediction(bundle, prediction, stateHash, prepared.referenceIds.length);
        return { ...projected, prediction, stateHash, operationElapsedMs: performance.now() - started,
            locationElapsedMs: 0, operationCandidateCount: V5_IDENTITIES.length, locationCandidateCount: evidence.codes.length };
    }
}

let ready: Promise<UnifiedV5Runtime> | null = null;
export const loadUnifiedV5Runtime = (): Promise<UnifiedV5Runtime> => ready ??= (async () => {
    let text: string;
    if (import.meta.env.SSR) {
        const [{ readFile }, { resolve }] = await Promise.all([import("node:fs/promises"), import("node:path")]);
        text = await readFile(resolve(process.cwd(), "public/models/unifiedV5Model.json"), "utf8");
    } else {
        const response = await fetch("/models/unifiedV5Model.json");
        if (!response.ok) throw new Error(`v5 model load failed: ${response.status}`);
        text = await response.text();
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const hash = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("");
    if (hash !== UNIFIED_V5_ASSET_SHA256) throw new Error("Frozen v5 asset hash mismatch");
    return new UnifiedV5Runtime(new UnifiedV5Predictor(JSON.parse(text) as UnifiedV5Model));
})();
