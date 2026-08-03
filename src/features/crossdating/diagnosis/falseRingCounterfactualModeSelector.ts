/** Selects one false-ring mode from physical evidence plus virtual deletions. */
import modelData from "./falseRingCounterfactualModeModel.json";
import {
    FALSE_RING_COUNTERFACTUAL_PROFILES,
    type FalseRingCoarseCounterfactualRow,
    type FalseRingCounterfactualProfile,
} from "./falseRingCoarseCounterfactual";
import {
    buildUnitEventModeCandidates,
    type MissingRingModeSelectorInput,
    type MissingRingModeSelectorResult,
    type UnitEventModeCandidate,
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
    temperature: number;
    baseFeatureCount: number;
    featureCount: number;
    counterfactualProfiles: FalseRingCounterfactualProfile[];
    model: { tree_info: Array<{ tree_structure: ModelTreeNode }> };
};

const MODEL = modelData as unknown as SelectorModel;

const predictNode = (node: ModelTreeNode, features: readonly number[]): number => {
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
    return predictNode(goLeft ? node.left_child : node.right_child, features);
};

const percentileRanks = (values: readonly number[]): number[] => values.map(
    (selected) => (
        values.filter((value) => value < selected).length
        + values.filter((value) => value === selected).length * 0.5
    ) / Math.max(1, values.length),
);

const maximumIndex = (values: readonly number[]): number => {
    let selected = 0;
    for (let index = 1; index < values.length; index += 1) {
        if (values[index] > values[selected]) selected = index;
    }
    return selected;
};

const correctionFeatures = (
    rows: readonly FalseRingCoarseCounterfactualRow[],
    candidate: Pick<UnitEventModeCandidate, "startYear" | "endYear">,
): number[] => MODEL.counterfactualProfiles.flatMap((profile) => {
    const values = rows.map((row) => row.profiles[profile] ?? -10);
    const ranks = percentileRanks(values);
    const inside = rows.flatMap((row, index) => (
        candidate.startYear <= row.year && row.year <= candidate.endYear
            ? [ranks[index] ?? 0]
            : []
    ));
    const peakYear = rows[maximumIndex(ranks)]?.year ?? candidate.startYear;
    const center = (candidate.startYear + candidate.endYear) / 2;
    const centerRank = rows.reduce<number | null>((selected, row, index) => (
        selected === null && row.year === Math.round(center)
            ? ranks[index] ?? 0
            : selected
    ), null) ?? 0;
    return [
        inside.reduce((sum, value) => sum + value, 0) / MODEL.windowWidth,
        inside.length > 0
            ? inside.reduce((sum, value) => sum + value, 0) / inside.length
            : 0,
        Math.max(0, ...inside),
        centerRank,
        Math.abs(center - peakYear) / MODEL.windowWidth,
        inside.length / MODEL.windowWidth,
    ];
});

const scoreFeatures = (features: readonly number[]): number => (
    MODEL.model.tree_info.reduce((score, tree) => (
        score + predictNode(tree.tree_structure, features)
    ), 0)
);

export const selectFalseRingCounterfactualMode = (
    input: MissingRingModeSelectorInput,
    rows: readonly FalseRingCoarseCounterfactualRow[],
): MissingRingModeSelectorResult | null => {
    if (input.years.length < MODEL.windowWidth || rows.length === 0) return null;
    if (
        MODEL.counterfactualProfiles.join("|")
        !== FALSE_RING_COUNTERFACTUAL_PROFILES.join("|")
    ) {
        throw new Error("False-ring counterfactual profile order mismatch");
    }
    const candidates = buildUnitEventModeCandidates(input).map((candidate) => {
        if (candidate.features.length !== MODEL.baseFeatureCount) {
            throw new Error(
                `False-ring base mode feature mismatch: ${candidate.features.length}`,
            );
        }
        const features = [
            ...candidate.features,
            ...correctionFeatures(rows, candidate),
        ].map(Math.fround);
        if (features.length !== MODEL.featureCount) {
            throw new Error(
                `False-ring counterfactual feature mismatch: ${features.length}`,
            );
        }
        return { ...candidate, score: scoreFeatures(features) };
    });
    if (candidates.length === 0) return null;
    const maximum = Math.max(...candidates.map((candidate) => candidate.score));
    const exponentials = candidates.map((candidate) => (
        Math.exp((candidate.score - maximum) / MODEL.temperature)
    ));
    const total = exponentials.reduce((sum, value) => sum + value, 0);
    const weights = exponentials.map((value) => value / Math.max(1e-12, total));
    const topStart = candidates[maximumIndex(candidates.map((candidate) => (
        candidate.score
    )))].startYear;
    const minimumStart = Math.min(...candidates.map((candidate) => candidate.startYear));
    const maximumStart = Math.max(...candidates.map((candidate) => candidate.startYear));
    const scoredWindows = Array.from(
        { length: maximumStart - minimumStart + 1 },
        (_, offset) => {
            const startYear = minimumStart + offset;
            return {
                startYear,
                endYear: startYear + MODEL.windowWidth - 1,
                score: candidates.reduce((sum, candidate, index) => (
                    sum + (weights[index] ?? 0) * Math.max(
                        0,
                        MODEL.windowWidth - Math.abs(startYear - candidate.startYear),
                    )
                ), 0),
                topDistance: Math.abs(startYear - topStart),
            };
        },
    ).sort((left, right) => (
        right.score - left.score
        || left.topDistance - right.topDistance
        || left.startYear - right.startYear
    ));
    const selected = scoredWindows[0];
    if (!selected) return null;
    return {
        window: { startYear: selected.startYear, endYear: selected.endYear },
        score: selected.score,
        margin: selected.score - (scoredWindows[1]?.score ?? selected.score),
        scoredWindows: scoredWindows.map(({ topDistance: _ignored, ...window }) => (
            window
        )),
    };
};
