import frozenModel from "./internalReferenceViewSelectorModel.json";
import type { DiagnosisEvent } from "./types";

type FrozenModelArtifact = {
    schemaVersion: number;
    modelType: "standardized-logistic";
    featureColumns: string[];
    means: number[];
    scales: number[];
    coefficients: number[];
    intercept: number;
    thresholds: {
        minimumProbability: number;
        minimumMargin: number;
        minimumSupport: number;
    };
};

const model = frozenModel as FrozenModelArtifact;

export const INTERNAL_REFERENCE_VIEW_FEATURE_NAMES = Object.freeze(
    [...model.featureColumns],
);
export const INTERNAL_REFERENCE_VIEW_SELECTOR_THRESHOLDS = Object.freeze({
    ...model.thresholds,
    minimumSafeConsensusProbability: 0.03,
});

const validateModelContract = () => {
    const length = model.featureColumns.length;
    if (model.schemaVersion !== 1
        || model.modelType !== "standardized-logistic"
        || model.means.length !== length
        || model.scales.length !== length
        || model.coefficients.length !== length) {
        throw new Error("internal reference-view model contract mismatch");
    }
};

validateModelContract();

const sigmoid = (value: number) => (
    value >= 0
        ? 1 / (1 + Math.exp(-value))
        : Math.exp(value) / (1 + Math.exp(value))
);

export const internalReferenceViewFeatureVector = (
    features: Readonly<Record<string, number>>,
): number[] => INTERNAL_REFERENCE_VIEW_FEATURE_NAMES.map((name) => {
    const value = features[name];
    if (!Number.isFinite(value)) {
        throw new Error(`missing internal reference-view feature: ${name}`);
    }
    return value;
});

export const predictInternalReferenceViewPackage = (
    features: Readonly<Record<string, number>> | readonly number[],
): number => {
    const vector = Array.isArray(features)
        ? [...features]
        : internalReferenceViewFeatureVector(features as Readonly<Record<string, number>>);
    if (vector.length !== INTERNAL_REFERENCE_VIEW_FEATURE_NAMES.length
        || vector.some((value) => !Number.isFinite(value))) {
        throw new Error("internal reference-view feature vector contract mismatch");
    }
    const linear = model.intercept + vector.reduce((sum, value, index) => (
        sum
        + ((value - model.means[index]) / Math.max(1e-12, model.scales[index]))
            * model.coefficients[index]
    ), 0);
    return sigmoid(linear);
};

export type InternalReferenceViewSelectionGate = {
    probability: number;
    baselineProbability: number;
    support: number;
    baselineSupport: number;
    baselineEventType: DiagnosisEvent["eventType"] | null;
    candidateEventType: DiagnosisEvent["eventType"] | null;
    safeConsensus: boolean;
};

/** Applies only the frozen shadow selector's package-level safety contract. */
export const canSelectInternalReferenceViewPackage = (
    input: InternalReferenceViewSelectionGate,
): boolean => {
    if (input.support < INTERNAL_REFERENCE_VIEW_SELECTOR_THRESHOLDS.minimumSupport) {
        return false;
    }
    if (input.baselineEventType === "partialMove"
        && input.candidateEventType === "falseRing"
        && input.support <= input.baselineSupport) {
        return false;
    }
    if (input.safeConsensus) {
        return input.probability
            >= INTERNAL_REFERENCE_VIEW_SELECTOR_THRESHOLDS.minimumSafeConsensusProbability;
    }
    return input.probability
            >= INTERNAL_REFERENCE_VIEW_SELECTOR_THRESHOLDS.minimumProbability
        && input.probability - input.baselineProbability
            >= INTERNAL_REFERENCE_VIEW_SELECTOR_THRESHOLDS.minimumMargin;
};
