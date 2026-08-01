/**
 * Event-presence calibration over the complete six-operation counterfactual grid.
 *
 * The static forest was fitted offline on signal-independent ITRDB injections and clean
 * controls. It replaces the old single top-three-gain cutoff with a distribution-level gate.
 */
import modelData from "./jointOperationPresenceModel.json";
import type { JointCounterfactualOperationScore } from "./jointCounterfactualOperation";
import { buildJointOperationSelectorFeatures } from "./jointOperationSelector";

type PresenceTree = {
    probabilities: number[];
} | {
    featureIndex: number;
    threshold: number;
    left: PresenceTree;
    right: PresenceTree;
};

type PresenceModel = {
    schemaVersion: number;
    operationFeatureCount: number;
    vectorFeatureCount: number;
    classes: number[];
    trees: PresenceTree[];
};

export type JointOperationPresence = {
    present: boolean;
    probability: number;
    threshold: number;
};

const MODEL = modelData as unknown as PresenceModel;

const PRESENCE_THRESHOLDS = {
    missingRing: 0.28,
    falseRing: 0.31,
    partialMove: 0.39,
} as const;

const predictTree = (
    tree: PresenceTree,
    features: readonly number[],
): readonly number[] => {
    if ("probabilities" in tree) return tree.probabilities;
    return predictTree(
        (features[tree.featureIndex] ?? 0) <= tree.threshold
            ? tree.left
            : tree.right,
        features,
    );
};

export const scoreJointOperationPresence = (
    operations: readonly JointCounterfactualOperationScore[],
    selectedOperation: JointCounterfactualOperationScore,
): JointOperationPresence | null => {
    const features = buildJointOperationSelectorFeatures(operations);
    const positiveIndex = MODEL.classes.indexOf(1);
    if (
        !features
        || features.length !== MODEL.vectorFeatureCount
        || positiveIndex < 0
        || MODEL.trees.length === 0
    ) return null;
    const probability = MODEL.trees.reduce(
        (sum, tree) => sum + (predictTree(tree, features)[positiveIndex] ?? 0),
        0,
    ) / MODEL.trees.length;
    const threshold = PRESENCE_THRESHOLDS[selectedOperation.eventType];
    return {
        present: probability >= threshold,
        probability,
        threshold,
    };
};
