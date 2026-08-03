/**
 * Final 13-year missing-ring mode arbitration inside the coarse search region.
 *
 * The file-grouped ranker compares complete windows, preserving one-sided
 * boundary evidence that is lost when broad point probabilities are summed.
 * It is intentionally limited to cases already classified as needing 13 years;
 * narrow-window calibration remains an independent decision.
 */
import modelData from "./missingRingDirectModeModel.json";
import {
    buildUnitEventPointFeatureMatrix,
} from "./unitEventPointWindowSelector";
import type {
    UnitEventRankerWindow,
    UnitEventWindowRankerInput,
} from "./unitEventWindowRanker";

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

type MissingDirectModeModel = {
    pointFeatureNames: string[];
    featureNames: string[];
    windowWidth: number;
    model: {
        tree_info: Array<{ tree_structure: ModelTreeNode }>;
    };
};

type DirectModeBundle = {
    version: number;
    eventTypes: { missingRing?: MissingDirectModeModel };
};

export type MissingRingDirectModeContext = {
    modeWindow: UnitEventRankerWindow;
    currentWindow: UnitEventRankerWindow;
    recommendedWidth: 5 | 7 | 9 | 13;
    learnedWindowScore: number;
    learnedWindowMargin: number;
    learnedWindowRemoteMargin: number;
    nineYearSafety: number;
    nineYearSafetyThreshold: number;
};

export type MissingRingDirectModeResult = {
    window: UnitEventRankerWindow;
    score: number;
    margin: number;
    scoredWindows: Array<UnitEventRankerWindow & { score: number }>;
};

const MODEL = (modelData as unknown as DirectModeBundle)
    .eventTypes.missingRing;

const mean = (values: readonly number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

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
    return predictNode(goLeft ? node.left_child : node.right_child, features);
};

const scoreFeatures = (
    model: MissingDirectModeModel,
    features: readonly number[],
): number => model.model.tree_info.reduce((score, tree) => (
    score + predictNode(tree.tree_structure, features)
), 0);

const aggregateNames = [
    "mean",
    "maximum",
    "center",
    "older3",
    "newer3",
    "flankDelta",
    "before3",
    "after3",
    "enterDelta",
    "exitDelta",
] as const;

const anchorFeatureNames = [
    "relativeStart",
    "relativeEnd",
    "relativeCenter",
    "currentModeSigned",
    "currentModeDistance",
    "currentModeOverlap",
    "sourceCurrentMode",
    "sourceCurrentFinalCenter",
    "sourceCoarseOlderEdge",
    "sourceCoarseNewerEdge",
    "sourceCurrentCenter",
    "sourceOperationCenter",
    "sourceSideCenter",
    "currentCenterDistance",
    "operationCenterDistance",
    "sideCenterDistance",
    "oldWasNarrow",
    "learnedWindowScore",
    "learnedWindowMargin",
    "learnedWindowRemoteMargin",
    "nineYearSafety",
    "nineYearSafetyMargin",
] as const;

const expectedFeatureNames = (
    model: MissingDirectModeModel,
): string[] => [
    ...model.pointFeatureNames.flatMap((name) => aggregateNames.map(
        (aggregate) => `${aggregate}:${name}`,
    )),
    ...anchorFeatureNames,
];

const boundedStart = (
    years: readonly number[],
    centerYear: number | undefined,
    windowWidth: number,
): number | null => {
    if (centerYear === undefined) return null;
    const firstYear = years[0] ?? centerYear;
    const lastYear = years[years.length - 1] ?? centerYear;
    return Math.max(
        firstYear,
        Math.min(
            Math.round(centerYear) - Math.floor(windowWidth / 2),
            lastYear - windowWidth + 1,
        ),
    );
};

export const selectMissingRingDirectMode = (
    input: UnitEventWindowRankerInput,
    context: MissingRingDirectModeContext,
): MissingRingDirectModeResult | null => {
    if (
        input.eventType !== "missingRing"
        || context.recommendedWidth !== 13
        || !input.coarseWindow
        || !MODEL
    ) return null;
    const matrix = buildUnitEventPointFeatureMatrix(
        input,
        MODEL.pointFeatureNames,
    );
    if (!matrix || matrix.years.length < MODEL.windowWidth) return null;
    const expectedNames = expectedFeatureNames(MODEL);
    if (expectedNames.join("|") !== MODEL.featureNames.join("|")) {
        throw new Error("Missing-ring direct mode feature order mismatch");
    }

    const { years, features: pointFeatures } = matrix;
    const width = MODEL.windowWidth;
    const halfWidth = Math.floor(width / 2);
    const coarseStart = input.coarseWindow.startYear;
    const coarseEnd = input.coarseWindow.endYear;
    const coarseSpan = Math.max(1, coarseEnd - coarseStart);
    const modeStart = context.modeWindow.startYear;
    const modeEnd = context.modeWindow.endYear;
    const modeCenter = (modeStart + modeEnd) / 2;
    const currentWindowCenter = (
        context.currentWindow.startYear + context.currentWindow.endYear
    ) / 2;
    const operation = input.operationEvidence;
    const currentStart = boundedStart(years, input.currentPrimaryYear, width);
    const operationStart = boundedStart(years, operation?.bestYear, width);
    const sideStart = boundedStart(years, operation?.sideStepBestYear, width);
    const scoredWindows: Array<UnitEventRankerWindow & { score: number }> = [];

    for (let index = 0; index + width <= years.length; index += 1) {
        const startYear = years[index];
        const endYear = startYear + width - 1;
        if (years[index + width - 1] !== endYear) continue;
        const centerYear = startYear + halfWidth;
        const candidateFeatures: number[] = [];
        for (
            let column = 0;
            column < MODEL.pointFeatureNames.length;
            column += 1
        ) {
            const values = pointFeatures
                .slice(index, index + width)
                .map((row) => row[column] ?? 0);
            const older = mean(values.slice(0, 3));
            const newer = mean(values.slice(-3));
            const beforeValues = pointFeatures
                .slice(Math.max(0, index - 3), index)
                .map((row) => row[column] ?? 0);
            const afterValues = pointFeatures
                .slice(index + width, index + width + 3)
                .map((row) => row[column] ?? 0);
            const before = beforeValues.length > 0 ? mean(beforeValues) : older;
            const after = afterValues.length > 0 ? mean(afterValues) : newer;
            candidateFeatures.push(
                mean(values),
                Math.max(...values),
                values[halfWidth] ?? 0,
                older,
                newer,
                newer - older,
                before,
                after,
                older - before,
                after - newer,
            );
        }
        const overlap = Math.max(
            0,
            Math.min(endYear, modeEnd) - Math.max(startYear, modeStart) + 1,
        );
        const anchorDistance = (anchor: number | null): number => (
            anchor === null ? 1 : Math.abs(startYear - anchor) / coarseSpan
        );
        candidateFeatures.push(
            (startYear - coarseStart) / coarseSpan,
            (endYear - coarseStart) / coarseSpan,
            (centerYear - coarseStart) / coarseSpan,
            (centerYear - modeCenter) / coarseSpan,
            Math.abs(centerYear - modeCenter) / coarseSpan,
            overlap / width,
            Number(startYear === modeStart),
            Number(centerYear === Math.round(currentWindowCenter)),
            Number(startYear === coarseStart),
            Number(endYear === coarseEnd),
            Number(currentStart !== null && startYear === currentStart),
            Number(operationStart !== null && startYear === operationStart),
            Number(sideStart !== null && startYear === sideStart),
            anchorDistance(currentStart),
            anchorDistance(operationStart),
            anchorDistance(sideStart),
            0,
            context.learnedWindowScore,
            context.learnedWindowMargin,
            context.learnedWindowRemoteMargin,
            context.nineYearSafety,
            context.nineYearSafety - context.nineYearSafetyThreshold,
        );
        const rounded = candidateFeatures.map(Math.fround);
        if (rounded.length !== MODEL.featureNames.length) {
            throw new Error(
                `Missing-ring direct mode feature mismatch: ${rounded.length}`,
            );
        }
        scoredWindows.push({
            startYear,
            endYear,
            score: scoreFeatures(MODEL, rounded),
        });
    }
    scoredWindows.sort((left, right) => (
        right.score - left.score || right.startYear - left.startYear
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
