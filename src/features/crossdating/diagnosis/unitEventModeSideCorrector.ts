/** Conservative final-side correction for an already selected 13-year mode. */
import modelData from "./unitEventModeSideCorrectorModel.json";
import { buildUnitEventPointFeatureMatrix } from "./unitEventPointWindowSelector";
import type {
    UnitEventRankerWindow,
    UnitEventWindowRankerInput,
    UnitEventWindowRankerResult,
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

type SideCorrectorModel = {
    pointFeatureNames: string[];
    featureNames: string[];
    windowWidth: number;
    gate: {
        minimumSideProbability: number;
        minimumCoveredMargin: number;
        minimumDirectionMargin: number;
        shiftYears: number;
    };
    model: {
        tree_info: Array<{ tree_structure: ModelTreeNode }>;
    };
};

type SideCorrectorBundle = {
    version: number;
    eventTypes: Partial<Record<"missingRing" | "falseRing", SideCorrectorModel>>;
};

export type UnitEventModeSideContext = {
    modeWindow: UnitEventRankerWindow;
    finalWindow: UnitEventRankerWindow;
    recommendedWidth: 5 | 7 | 9 | 13;
    learnedWindowScore: number;
    learnedWindowMargin: number;
    learnedWindowRemoteMargin: number;
    nineYearSafety: number;
    nineYearSafetyThreshold: number;
    centeringRule: UnitEventWindowRankerResult["windowCenteringRule"];
};

export type UnitEventModeSideCorrection = {
    window: UnitEventRankerWindow;
    probabilities: {
        covered: number;
        older: number;
        newer: number;
    };
};

const MODEL = modelData as unknown as SideCorrectorBundle;

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

const expectedFeatureNames = (model: SideCorrectorModel): string[] => [
    ...model.pointFeatureNames.flatMap((name) => aggregateNames.map(
        (aggregate) => `${aggregate}:${name}`,
    )),
    ...anchorFeatureNames,
];

const boundedStart = (
    years: readonly number[],
    centerYear: number | undefined,
    width: number,
): number | null => {
    if (centerYear === undefined) return null;
    const firstYear = years[0] ?? centerYear;
    const lastYear = years[years.length - 1] ?? centerYear;
    return Math.max(
        firstYear,
        Math.min(
            Math.round(centerYear) - Math.floor(width / 2),
            lastYear - width + 1,
        ),
    );
};

const buildModeFeatures = (
    input: UnitEventWindowRankerInput,
    context: UnitEventModeSideContext,
    model: SideCorrectorModel,
): number[] | null => {
    const matrix = buildUnitEventPointFeatureMatrix(
        input,
        model.pointFeatureNames,
    );
    if (!matrix || matrix.years.length < model.windowWidth || !input.coarseWindow) {
        return null;
    }
    const expected = expectedFeatureNames(model);
    if (expected.join("|") !== model.featureNames.join("|")) {
        throw new Error("Unit-event side-corrector feature order mismatch");
    }

    const { years, features } = matrix;
    const width = model.windowWidth;
    const halfWidth = Math.floor(width / 2);
    const candidateIndexes = years.flatMap((startYear, index) => (
        index + width <= years.length
        && years[index + width - 1] === startYear + width - 1
            ? [index]
            : []
    ));
    const startIndex = candidateIndexes.reduce((selected, index) => (
        Math.abs((years[index] ?? 0) - context.modeWindow.startYear)
            < Math.abs((years[selected] ?? 0) - context.modeWindow.startYear)
            ? index
            : selected
    ), candidateIndexes[0] ?? -1);
    if (startIndex < 0) return null;

    const startYear = years[startIndex] ?? context.modeWindow.startYear;
    const endYear = startYear + width - 1;
    const centerYear = startYear + halfWidth;
    const candidateFeatures: number[] = [];
    for (let column = 0; column < model.pointFeatureNames.length; column += 1) {
        const values = features
            .slice(startIndex, startIndex + width)
            .map((row) => row[column] ?? 0);
        const older = mean(values.slice(0, 3));
        const newer = mean(values.slice(-3));
        const beforeValues = features
            .slice(Math.max(0, startIndex - 3), startIndex)
            .map((row) => row[column] ?? 0);
        const afterValues = features
            .slice(startIndex + width, startIndex + width + 3)
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

    const coarseStart = input.coarseWindow.startYear;
    const coarseEnd = input.coarseWindow.endYear;
    const coarseSpan = Math.max(1, coarseEnd - coarseStart);
    const modeCenter = (
        context.modeWindow.startYear + context.modeWindow.endYear
    ) / 2;
    const finalCenter = (
        context.finalWindow.startYear + context.finalWindow.endYear
    ) / 2;
    const overlap = Math.max(
        0,
        Math.min(endYear, context.modeWindow.endYear)
            - Math.max(startYear, context.modeWindow.startYear)
            + 1,
    );
    const currentStart = boundedStart(
        years,
        input.currentPrimaryYear,
        width,
    );
    const operationStart = boundedStart(
        years,
        input.operationEvidence?.bestYear,
        width,
    );
    const sideStart = boundedStart(
        years,
        input.operationEvidence?.sideStepBestYear,
        width,
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
        Number(startYear === context.modeWindow.startYear),
        Number(centerYear === Math.round(finalCenter)),
        Number(startYear === coarseStart),
        Number(endYear === coarseEnd),
        Number(currentStart !== null && startYear === currentStart),
        Number(operationStart !== null && startYear === operationStart),
        Number(sideStart !== null && startYear === sideStart),
        anchorDistance(currentStart),
        anchorDistance(operationStart),
        anchorDistance(sideStart),
        Number(context.recommendedWidth === 9),
        context.learnedWindowScore,
        context.learnedWindowMargin,
        context.learnedWindowRemoteMargin,
        context.nineYearSafety,
        context.nineYearSafety - context.nineYearSafetyThreshold,
    );
    const rounded = candidateFeatures.map(Math.fround);
    if (rounded.length !== model.featureNames.length) {
        throw new Error(
            `Unit-event side-corrector feature mismatch: ${rounded.length}`,
        );
    }
    return rounded;
};

const classProbabilities = (
    model: SideCorrectorModel,
    features: readonly number[],
): [number, number, number] => {
    const scores: [number, number, number] = [0, 0, 0];
    model.model.tree_info.forEach((tree, index) => {
        const selectedClass = index % 3;
        scores[selectedClass] = (scores[selectedClass] ?? 0)
            + predictNode(tree.tree_structure, features);
    });
    const maximum = Math.max(...scores);
    const exponentials = scores.map((score) => Math.exp(score - maximum));
    const total = exponentials.reduce((sum, value) => sum + value, 0);
    return exponentials.map((value) => value / Math.max(1e-12, total)) as [
        number,
        number,
        number,
    ];
};

export const shouldKeepDirectModeAgainstSideCorrection = (input: {
    eventType: UnitEventWindowRankerInput["eventType"];
    centeringRule: UnitEventWindowRankerResult["windowCenteringRule"];
    modeWindow: UnitEventRankerWindow;
    currentPrimaryYear?: number;
    operationBestYear?: number;
    direction: -1 | 1;
}): boolean => {
    if (
        input.eventType !== "missingRing"
        || input.centeringRule !== "missing_direct_mode_ranker"
        || input.currentPrimaryYear === undefined
        || input.operationBestYear === undefined
    ) return false;
    const anchors = [input.currentPrimaryYear, input.operationBestYear];
    return input.direction < 0
        ? anchors.every((year) => year < input.modeWindow.startYear)
        : anchors.every((year) => year > input.modeWindow.endYear);
};

export const correctUnitEventModeSide = (
    input: UnitEventWindowRankerInput,
    context: UnitEventModeSideContext,
): UnitEventModeSideCorrection | null => {
    const model = MODEL.eventTypes[input.eventType];
    if (!model || !input.coarseWindow) return null;
    const features = buildModeFeatures(input, context, model);
    if (!features) return null;
    const [covered, older, newer] = classProbabilities(model, features);
    const side = Math.max(older, newer);
    if (
        side < model.gate.minimumSideProbability
        || side - covered < model.gate.minimumCoveredMargin
        || Math.abs(older - newer) < model.gate.minimumDirectionMargin
    ) return null;

    const direction = older > newer ? -1 : 1;
    if (shouldKeepDirectModeAgainstSideCorrection({
        eventType: input.eventType,
        centeringRule: context.centeringRule,
        modeWindow: context.modeWindow,
        currentPrimaryYear: input.currentPrimaryYear,
        operationBestYear: input.operationEvidence?.bestYear,
        direction,
    })) return null;
    const maximumStart = input.coarseWindow.endYear - model.windowWidth + 1;
    const startYear = Math.max(
        input.coarseWindow.startYear,
        Math.min(
            context.modeWindow.startYear
                + direction * model.gate.shiftYears,
            maximumStart,
        ),
    );
    if (startYear === context.modeWindow.startYear) return null;
    return {
        window: {
            startYear,
            endYear: startYear + model.windowWidth - 1,
        },
        probabilities: { covered, older, newer },
    };
};
