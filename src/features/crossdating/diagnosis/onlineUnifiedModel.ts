import modelData from "./models/onlineUnifiedModel.json";
import {
    buildOnlineUnifiedExecutablePackage,
    buildOnlineUnifiedLocationPackages,
    buildOnlineUnifiedOperationCandidates,
    ONLINE_UNIFIED_MODEL_VERSION,
    onlineUnifiedFeatureVector,
    type OnlineUnifiedEvidenceBundle,
    type OnlineUnifiedExecutablePackage,
    type OnlineUnifiedOperationCandidate,
} from "./onlineUnifiedEvidence";
import type { AuthoritativeDiagnosisDecision } from "./types";

type ModelTreeNode = {
    leaf_value: number;
} | {
    split_feature: number;
    threshold: number | string;
    decision_type: string;
    default_left: boolean;
    left_child: ModelTreeNode;
    right_child: ModelTreeNode;
};

type OnlineUnifiedHead = {
    featureNames: string[];
    averageOutput: boolean;
    objective: string;
    treeInfo: Array<{
        shrinkage: number;
        tree_structure: ModelTreeNode;
    }>;
};

type OnlineUnifiedModel = {
    schemaVersion: 1;
    modelVersion: string;
    teacherModelVersion: string;
    truthBlindRuntime: boolean;
    operation: OnlineUnifiedHead;
    location: OnlineUnifiedHead;
};

const MODEL = modelData as unknown as OnlineUnifiedModel;

type CompiledTree = {
    feature: Int32Array;
    threshold: Float64Array;
    left: Int32Array;
    right: Int32Array;
    defaultLeft: Uint8Array;
    equality: Uint8Array;
    leaf: Float64Array;
};

type CompiledHead = {
    trees: CompiledTree[];
    averageOutput: boolean;
};

const COMPILED_HEADS = new WeakMap<OnlineUnifiedHead, CompiledHead>();

const compileTree = (root: ModelTreeNode): CompiledTree => {
    const features: number[] = [];
    const thresholds: number[] = [];
    const left: number[] = [];
    const right: number[] = [];
    const defaultLeft: number[] = [];
    const equality: number[] = [];
    const leaves: number[] = [];
    const append = (node: ModelTreeNode): number => {
        const index = features.length;
        features.push(-1);
        thresholds.push(0);
        left.push(-1);
        right.push(-1);
        defaultLeft.push(0);
        equality.push(0);
        leaves.push(0);
        if ("leaf_value" in node) {
            leaves[index] = node.leaf_value;
            return index;
        }
        features[index] = node.split_feature;
        thresholds[index] = typeof node.threshold === "number"
            ? node.threshold
            : Number(node.threshold);
        defaultLeft[index] = Number(node.default_left);
        equality[index] = Number(node.decision_type !== "<=");
        left[index] = append(node.left_child);
        right[index] = append(node.right_child);
        return index;
    };
    append(root);
    return {
        feature: Int32Array.from(features),
        threshold: Float64Array.from(thresholds),
        left: Int32Array.from(left),
        right: Int32Array.from(right),
        defaultLeft: Uint8Array.from(defaultLeft),
        equality: Uint8Array.from(equality),
        leaf: Float64Array.from(leaves),
    };
};

const compileHead = (head: OnlineUnifiedHead): CompiledHead => {
    const cached = COMPILED_HEADS.get(head);
    if (cached) return cached;
    const compiled = {
        trees: head.treeInfo.map((tree) => compileTree(tree.tree_structure)),
        averageOutput: head.averageOutput,
    };
    COMPILED_HEADS.set(head, compiled);
    return compiled;
};

const scoreCompiledTree = (
    tree: CompiledTree,
    features: readonly number[],
): number => {
    let node = 0;
    while (tree.feature[node]! >= 0) {
        const value = features[tree.feature[node]!]!;
        const goLeft = !Number.isFinite(value)
            ? tree.defaultLeft[node] === 1
            : tree.equality[node] === 1
                ? value === tree.threshold[node]
                : value <= tree.threshold[node]!;
        node = goLeft ? tree.left[node]! : tree.right[node]!;
    }
    return tree.leaf[node]!;
};

export const scoreOnlineUnifiedFeatureVector = (
    head: OnlineUnifiedHead,
    features: readonly number[],
): number => {
    const compiled = compileHead(head);
    const total = compiled.trees.reduce((score, tree) => (
        score + scoreCompiledTree(tree, features)
    ), 0);
    return compiled.averageOutput && compiled.trees.length > 0
        ? total / compiled.trees.length
        : total;
};

export const scoreOnlineUnifiedRawFeatures = (
    head: "operation" | "location",
    features: Readonly<Record<string, number>>,
): number => scoreFeatures(MODEL[head], features);

const scoreFeatures = (
    head: OnlineUnifiedHead,
    features: Readonly<Record<string, number>>,
): number => scoreOnlineUnifiedFeatureVector(
    head,
    onlineUnifiedFeatureVector(features, head.featureNames),
);

const numericFeature = (
    candidate: OnlineUnifiedOperationCandidate,
    name: string,
): number => {
    const value = Number(candidate.features[name]);
    return Number.isFinite(value) ? value : 0;
};

const operationPrefilterScore = (
    candidate: OnlineUnifiedOperationCandidate,
): number => numericFeature(candidate, "claim_max_stage") * 4
    + Math.log1p(numericFeature(candidate, "claim_count"))
    + numericFeature(candidate, "claim_max_confidence")
    + numericFeature(candidate, "grid_available") * 0.4
    + numericFeature(candidate, "dynamic_selected") * 3
    + numericFeature(candidate, "unit_selected") * 2
    + numericFeature(candidate, "raw_global_lag_match") * 2.5
    + numericFeature(candidate, "cofecha_global_lag_match") * 2.5
    + numericFeature(candidate, "grid_dynamic_score") * 3;

/** Mirrors the frozen training contract: rank within a compact, truth-blind package set. */
const operationShortlist = (
    candidates: OnlineUnifiedOperationCandidate[],
): OnlineUnifiedOperationCandidate[] => {
    const ordered = [...candidates].sort((left, right) => (
        operationPrefilterScore(right) - operationPrefilterScore(left)
        || left.packageId.localeCompare(right.packageId)
    ));
    const family = [
        "noEvent",
        "missingRing",
        "falseRing",
        "partialMove",
        "wholeSeriesMove",
    ].flatMap((eventType) => ordered.filter(
        (candidate) => candidate.eventType === eventType,
    ).slice(0, 6));
    return [...new Map([...family, ...ordered.slice(0, 32)].map((candidate) => (
        [candidate.packageId, candidate]
    ))).values()];
};

export const warmOnlineUnifiedModel = (): void => {
    compileHead(MODEL.operation);
    compileHead(MODEL.location);
};

const refusal = (
    reason: string,
    packageId: string | null = null,
): AuthoritativeDiagnosisDecision => ({
    schemaVersion: 1,
    modelVersion: MODEL.modelVersion,
    authority: "authoritative",
    status: "refused",
    eventType: "noEvent",
    shiftYears: 0,
    startYear: null,
    endYear: null,
    topYear: null,
    identityGroup: null,
    packageId,
    refusalReason: reason,
});

export type OnlineUnifiedInferenceResult = {
    decision: AuthoritativeDiagnosisDecision;
    selectedPackage: OnlineUnifiedExecutablePackage | null;
    operationCandidateCount: number;
    locationCandidateCount: number;
    operationElapsedMs: number;
    locationElapsedMs: number;
};

export const inferOnlineUnifiedDiagnosis = (
    bundle: OnlineUnifiedEvidenceBundle,
): OnlineUnifiedInferenceResult => {
    if (MODEL.modelVersion !== ONLINE_UNIFIED_MODEL_VERSION) {
        return {
            decision: refusal("online_model_version_mismatch"),
            selectedPackage: null,
            operationCandidateCount: 0,
            locationCandidateCount: 0,
            operationElapsedMs: 0,
            locationElapsedMs: 0,
        };
    }
    const operationStartedAt = performance.now();
    const operationCandidates = operationShortlist(
        buildOnlineUnifiedOperationCandidates(bundle),
    );
    const rankedOperations = operationCandidates.map((candidate) => ({
        candidate,
        score: scoreFeatures(MODEL.operation, candidate.features),
    })).sort((left, right) => (
        right.score - left.score
        || left.candidate.packageId.localeCompare(right.candidate.packageId)
    ));
    const selectedOperation = rankedOperations[0];
    const operationElapsedMs = performance.now() - operationStartedAt;
    if (!selectedOperation || selectedOperation.candidate.eventType === "noEvent") {
        return {
            decision: refusal(
                selectedOperation ? "online_model_selected_no_event" : "no_operation_package",
                selectedOperation?.candidate.packageId ?? null,
            ),
            selectedPackage: null,
            operationCandidateCount: operationCandidates.length,
            locationCandidateCount: 0,
            operationElapsedMs,
            locationElapsedMs: 0,
        };
    }
    const identity = selectedOperation.candidate;
    if (identity.eventType === "wholeSeriesMove") {
        const secondScore = rankedOperations[1]?.score ?? selectedOperation.score;
        const selectedPackage = buildOnlineUnifiedExecutablePackage({
            bundle,
            candidate: identity,
            score: selectedOperation.score,
            scoreMargin: selectedOperation.score - secondScore,
        });
        return {
            decision: {
                schemaVersion: 1,
                modelVersion: MODEL.modelVersion,
                authority: "authoritative",
                status: "selected",
                eventType: identity.eventType,
                shiftYears: identity.shiftYears,
                startYear: bundle.targetRange.startYear,
                endYear: bundle.targetRange.endYear,
                topYear: null,
                identityGroup: identity.identityGroup,
                packageId: identity.packageId,
                refusalReason: null,
            },
            selectedPackage,
            operationCandidateCount: operationCandidates.length,
            locationCandidateCount: 0,
            operationElapsedMs,
            locationElapsedMs: 0,
        };
    }

    const locationStartedAt = performance.now();
    const locationCandidates = buildOnlineUnifiedLocationPackages(bundle, identity);
    const rankedLocations = locationCandidates.map((candidate) => ({
        candidate,
        score: scoreFeatures(MODEL.location, candidate.features),
    })).sort((left, right) => (
        right.score - left.score
        || left.candidate.packageId.localeCompare(right.candidate.packageId)
    ));
    const selectedLocation = rankedLocations[0];
    const locationElapsedMs = performance.now() - locationStartedAt;
    if (!selectedLocation) {
        return {
            decision: refusal("no_same_identity_location_package", identity.packageId),
            selectedPackage: null,
            operationCandidateCount: operationCandidates.length,
            locationCandidateCount: 0,
            operationElapsedMs,
            locationElapsedMs,
        };
    }
    const selected = selectedLocation.candidate;
    const selectedScore = rankedLocations[0]?.score ?? selectedLocation.score;
    const secondScore = rankedLocations[1]?.score ?? selectedScore;
    const selectedPackage = buildOnlineUnifiedExecutablePackage({
        bundle,
        candidate: selected,
        score: selectedScore,
        scoreMargin: selectedScore - secondScore,
    });
    return {
        decision: {
            schemaVersion: 1,
            modelVersion: MODEL.modelVersion,
            authority: "authoritative",
            status: "selected",
            eventType: selected.eventType,
            shiftYears: selected.shiftYears,
            startYear: selected.startYear,
            endYear: selected.endYear,
            topYear: selected.topYear,
            identityGroup: selected.identityGroup,
            packageId: selected.packageId,
            refusalReason: null,
        },
        selectedPackage,
        operationCandidateCount: operationCandidates.length,
        locationCandidateCount: locationCandidates.length,
        operationElapsedMs,
        locationElapsedMs,
    };
};
