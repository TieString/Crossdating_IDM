/**
 * Selects one 13-year false-ring mode from shared physical locator evidence.
 *
 * The grouped ranker compares independently proposed modes for the same case,
 * including local center, peak, side-contrast, and boundary-shape evidence. It
 * never exposes alternative windows to the diagnosis UI.
 */
import modelData from "./falseRingModeSelectorModel.json";
import {
    buildUnitEventModeCandidates,
    type MissingRingModeSelectorInput,
    type MissingRingModeSelectorResult,
} from "./missingRingModeSelector";

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

type SelectorModel = {
    windowWidth: number;
    featureCount: number;
    model: {
        tree_info: Array<{
            tree_structure: ModelTreeNode;
        }>;
    };
};

const MODEL = modelData as unknown as SelectorModel;

const predictNode = (
    node: ModelTreeNode,
    features: readonly number[],
): number => {
    if ("leaf_value" in node) return node.leaf_value;
    const value = features[node.split_feature];
    if (!Number.isFinite(value)) {
        return predictNode(
            node.default_left ? node.left_child : node.right_child,
            features,
        );
    }
    const threshold = typeof node.threshold === "number"
        ? node.threshold
        : Number(node.threshold);
    const goLeft = node.decision_type === "<="
        ? value! <= threshold
        : value! === threshold;
    return predictNode(
        goLeft ? node.left_child : node.right_child,
        features,
    );
};

const scoreFeatures = (features: readonly number[]): number => (
    MODEL.model.tree_info.reduce((score, tree) => (
        score + predictNode(tree.tree_structure, features)
    ), 0)
);

export const selectFalseRingMode = (
    input: MissingRingModeSelectorInput,
): MissingRingModeSelectorResult | null => {
    if (input.years.length < MODEL.windowWidth) return null;
    const candidates = buildUnitEventModeCandidates(input, true, true);
    const scoredWindows = candidates.map((candidate) => {
        if (candidate.features.length !== MODEL.featureCount) {
            throw new Error(
                `False-ring mode feature mismatch: ${candidate.features.length}`,
            );
        }
        return {
            startYear: candidate.startYear,
            endYear: candidate.endYear,
            score: scoreFeatures(candidate.features),
        };
    }).sort((left, right) => (
        right.score - left.score || left.startYear - right.startYear
    ));
    const selected = scoredWindows[0];
    if (!selected) return null;
    return {
        window: {
            startYear: selected.startYear,
            endYear: selected.endYear,
        },
        score: selected.score,
        margin: selected.score - (scoredWindows[1]?.score ?? selected.score),
        scoredWindows,
    };
};
