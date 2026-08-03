/**
 * Selects one unit-event window from a calibrated year-level score mass.
 *
 * The model sees only evidence already computed by the locator. Missing-ring
 * localization combines the four frozen virtual-insertion profiles with the
 * existing lag/change-point curves. The point model chooses a 13-year physical
 * mode; an independently calibrated safety gate may narrow the single displayed
 * window to 9 years. Internal year hypotheses are never exposed.
 */
import modelData from "./unitEventPointWindowModel.json";
import type { UnitEventWindowRankerInput } from "./unitEventWindowRanker";

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

type PointModel = {
    featureNames: string[];
    temperature: number;
    windowWidth: number;
    model: {
        tree_info: Array<{ tree_structure: ModelTreeNode }>;
    };
    widthCalibration?: {
        featureNames: string[];
        classifiers: Partial<Record<"5" | "9", {
            threshold: number;
            calibrationCases: number;
            model: {
                tree_info: Array<{ tree_structure: ModelTreeNode }>;
            };
        }>>;
        fallbackWidth: 13;
    };
    refinements?: {
        wideMode?: PointModel;
        narrowMode?: PointModel;
        narrowSafety?: {
            featureNames: string[];
            existingNarrowThreshold: number;
            existingWideThreshold: number;
            model: {
                tree_info: Array<{ tree_structure: ModelTreeNode }>;
            };
        };
    };
};

type PointModelBundle = {
    version: number;
    eventTypes: Partial<Record<"missingRing" | "falseRing", PointModel>>;
};

export type UnitEventPointWindow = {
    startYear: number;
    endYear: number;
    score: number;
};

export type UnitEventPointWindowResult = {
    window: UnitEventPointWindow;
    centerYear: number;
    peakYear: number;
    score: number;
    margin: number;
    recommendedWidth: 5 | 9 | 13;
    widthProbability: number;
    widthThreshold: number;
    yearScores: ReadonlyMap<number, number>;
    scoredWindows: UnitEventPointWindow[];
    safetyProbability?: number;
    existingNarrowThreshold?: number;
    existingWideThreshold?: number;
};

export type UnitEventNarrowSafetyContext = {
    modeWindow: { startYear: number; endYear: number };
    recommendedWidth: 5 | 7 | 9 | 13;
    nineYearSafety: number;
    widthThreshold: number;
};

export type UnitEventPointFeatureMatrix = {
    years: number[];
    features: number[][];
};

const MODEL = modelData as unknown as PointModelBundle;

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
    model: PointModel,
    features: readonly number[],
): number => model.model.tree_info.reduce((score, tree) => (
    score + predictNode(tree.tree_structure, features)
), 0);

const scoreTrees = (
    trees: readonly { tree_structure: ModelTreeNode }[],
    features: readonly number[],
): number => trees.reduce((score, tree) => (
    score + predictNode(tree.tree_structure, features)
), 0);

const sigmoid = (value: number): number => (
    value >= 0
        ? 1 / (1 + Math.exp(-value))
        : Math.exp(value) / (1 + Math.exp(value))
);

const mean = (values: readonly number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

const quantile = (values: readonly number[], fraction: number): number => {
    if (values.length === 0) return 0;
    const ordered = values.slice().sort((left, right) => left - right);
    const position = (ordered.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const weight = position - lower;
    return (ordered[lower] ?? 0) * (1 - weight)
        + (ordered[upper] ?? 0) * weight;
};

const percentileRanks = (values: readonly number[]): number[] => {
    if (values.length <= 1) return values.map(() => 0.5);
    const order = values.map((_, index) => index).sort((left, right) => (
        values[left] - values[right] || left - right
    ));
    const result = new Array<number>(values.length).fill(0);
    for (let start = 0; start < order.length;) {
        let end = start + 1;
        while (
            end < order.length
            && values[order[end]] === values[order[start]]
        ) {
            end += 1;
        }
        const rank = (start + end - 1) / (2 * (order.length - 1));
        for (let index = start; index < end; index += 1) {
            result[order[index]] = rank;
        }
        start = end;
    }
    return result;
};

const movingMean5 = (values: readonly number[]): number[] => values.map((_, index) => {
    const start = Math.max(0, index - 2);
    const end = Math.min(values.length, index + 3);
    let sum = 0;
    for (let selected = start; selected < end; selected += 1) {
        sum += values[selected] ?? 0;
    }
    return sum / Math.max(1, end - start);
});

const boundaryColumns = (
    values: readonly number[],
): Record<"olderDelta" | "newerDelta" | "step3" | "curvature", number[]> => {
    const result = {
        olderDelta: [] as number[],
        newerDelta: [] as number[],
        step3: [] as number[],
        curvature: [] as number[],
    };
    values.forEach((value, index) => {
        const previous = values[Math.max(0, index - 1)] ?? value;
        const following = values[Math.min(values.length - 1, index + 1)] ?? value;
        const older = values.slice(Math.max(0, index - 3), index);
        const newer = values.slice(index + 1, Math.min(values.length, index + 4));
        result.olderDelta.push(value - previous);
        result.newerDelta.push(following - value);
        result.step3.push(mean(newer) - mean(older));
        result.curvature.push(value - (previous + following) / 2);
    });
    return result;
};

const maximumIndex = (values: readonly number[]): number => {
    let selected = 0;
    for (let index = 1; index < values.length; index += 1) {
        if (values[index] > values[selected]) selected = index;
    }
    return selected;
};

const featureColumns = (
    input: UnitEventWindowRankerInput,
    featureNames: readonly string[],
    years: readonly number[],
    profiles: readonly Readonly<Record<string, number>>[],
): Map<string, number[]> => {
    const columns = new Map<string, number[]>();
    const requestedFeatures = new Set(featureNames);
    const addRequestedBoundaryColumns = (
        prefix: string,
        values: readonly number[],
    ) => {
        const requestedStatistics = (
            ["olderDelta", "newerDelta", "step3", "curvature"] as const
        ).filter((statistic) => requestedFeatures.has(`${prefix}:${statistic}`));
        if (requestedStatistics.length === 0) return;
        const boundaries = boundaryColumns(values);
        requestedStatistics.forEach((statistic) => {
            columns.set(`${prefix}:${statistic}`, boundaries[statistic]);
        });
    };
    const counterfactualProfiles = Array.from(new Set(featureNames
        .filter((name) => name.startsWith("cf:"))
        .map((name) => name.split(":")[1])));
    counterfactualProfiles.forEach((profile) => {
        const values = profiles.map((row) => row[profile] ?? -10);
        const ranks = percentileRanks(values);
        columns.set(`cf:${profile}:rank`, ranks);
        columns.set(`cf:${profile}:mean5`, movingMean5(ranks));
        addRequestedBoundaryColumns(`cf:${profile}`, ranks);
    });

    const yearIndexes = new Map(input.years.map((year, index) => [year, index]));
    const locatorProfiles = Array.from(new Set(featureNames
        .filter((name) => name.startsWith("loc:"))
        .map((name) => name.slice(4, name.lastIndexOf(":")))));
    locatorProfiles.forEach((profile) => {
        const source = input.ranks.get(profile);
        const values = years.map((year) => {
            const index = yearIndexes.get(year);
            const value = index === undefined ? undefined : source?.[index];
            return Number.isFinite(value) ? value! : 0;
        });
        columns.set(`loc:${profile}:value`, values);
        columns.set(`loc:${profile}:mean5`, movingMean5(values));
        addRequestedBoundaryColumns(`loc:${profile}`, values);
    });

    const coarseStart = input.coarseWindow?.startYear ?? years[0] ?? 0;
    const coarseEnd = input.coarseWindow?.endYear
        ?? years[years.length - 1]
        ?? coarseStart;
    const span = Math.max(1, coarseEnd - coarseStart);
    const signedDistance = (anchor: number | undefined): number[] => years.map(
        (year) => anchor === undefined ? 0 : (year - anchor) / span,
    );
    const absoluteDistance = (anchor: number | undefined): number[] => years.map(
        (year) => anchor === undefined ? 1 : Math.abs(year - anchor) / span,
    );
    columns.set("relativeOlder", years.map((year) => (year - coarseStart) / span));
    columns.set("relativeNewer", years.map((year) => (coarseEnd - year) / span));
    columns.set("currentSigned", signedDistance(input.currentPrimaryYear));
    columns.set("currentDistance", absoluteDistance(input.currentPrimaryYear));
    columns.set("operationSigned", signedDistance(input.operationEvidence?.bestYear));
    columns.set("operationDistance", absoluteDistance(input.operationEvidence?.bestYear));
    columns.set("sideSigned", signedDistance(input.operationEvidence?.sideStepBestYear));
    columns.set("sideDistance", absoluteDistance(input.operationEvidence?.sideStepBestYear));
    return columns;
};

/** Builds the ordered point-level evidence consumed by offline-trained selectors. */
export const buildUnitEventPointFeatureMatrix = (
    input: UnitEventWindowRankerInput,
    featureNames: readonly string[],
): UnitEventPointFeatureMatrix | null => {
    const rows = input.eventType === "missingRing"
        ? input.missingCounterfactualRows
        : input.falseCounterfactualRows;
    if (!rows || rows.length === 0) return null;
    const ordered = rows.slice().sort((left, right) => left.year - right.year);
    const years = ordered.map((row) => row.year);
    const profiles = ordered.map((row) => (
        row.profiles as unknown as Readonly<Record<string, number>>
    ));
    const columns = featureColumns(input, featureNames, years, profiles);
    const features = years.map((_, yearIndex) => featureNames.map((name) => {
        const value = columns.get(name)?.[yearIndex];
        if (value === undefined) {
            throw new Error(`Unit-event point feature is unavailable: ${name}`);
        }
        return Math.fround(value);
    }));
    return { years, features };
};

const boundedWindow = (
    input: UnitEventWindowRankerInput,
    centerYear: number,
    width: number,
): { startYear: number; endYear: number } => {
    const firstYear = input.years[0] ?? centerYear;
    const lastYear = input.years[input.years.length - 1] ?? centerYear;
    const startYear = Math.max(
        firstYear,
        Math.min(centerYear - Math.floor(width / 2), lastYear - width + 1),
    );
    return { startYear, endYear: startYear + width - 1 };
};

const scoreNarrowSafety = (
    input: UnitEventWindowRankerInput,
    model: PointModel,
    safetyContext: UnitEventNarrowSafetyContext,
    years: readonly number[],
    features: readonly (readonly number[])[],
    rawScores: readonly number[],
    probabilities: readonly number[],
    peakYear: number,
    centerYear: number,
    scoredCenters: readonly { centerYear: number; score: number }[],
): {
    probability: number;
    existingNarrowThreshold: number;
    existingWideThreshold: number;
} | null => {
    const safety = MODEL.eventTypes[input.eventType]?.refinements?.narrowSafety;
    if (!safety) return null;
    const adjacent = scoredCenters.find((candidate, index) => (
        index > 0 && Math.abs(candidate.centerYear - centerYear) <= 2
    )) ?? scoredCenters[0];
    const remote = scoredCenters.find((candidate) => (
        Math.abs(candidate.centerYear - centerYear) > 8
    )) ?? scoredCenters[scoredCenters.length - 1];
    const rawMean = mean(rawScores);
    const rawDeviation = Math.sqrt(mean(rawScores.map((score) => (
        (score - rawMean) ** 2
    ))));
    const entropy = -probabilities.reduce((sum, probability) => (
        sum + probability * Math.log(Math.max(probability, 1e-12))
    ), 0) / Math.max(1e-12, Math.log(Math.max(2, probabilities.length)));
    const coarseStart = input.coarseWindow?.startYear ?? years[0] ?? centerYear;
    const coarseEnd = input.coarseWindow?.endYear
        ?? years[years.length - 1]
        ?? centerYear;
    const span = Math.max(1, coarseEnd - coarseStart);
    const modeCenter = (
        safetyContext.modeWindow.startYear + safetyContext.modeWindow.endYear
    ) / 2;
    const distance = (anchor: number | undefined): number => (
        anchor === undefined ? 1 : Math.abs(centerYear - anchor) / span
    );
    const centerIndex = years.reduce((selected, year, index) => (
        Math.abs(year - centerYear) < Math.abs((years[selected] ?? year) - centerYear)
            ? index
            : selected
    ), 0);
    const pointFeatures = features[centerIndex] ?? [];
    const values: Record<string, number> = {
        mass9: scoredCenters[0]?.score ?? 0,
        adjacentMassMargin: (scoredCenters[0]?.score ?? 0)
            - (adjacent?.score ?? scoredCenters[0]?.score ?? 0),
        remoteMassMargin: (scoredCenters[0]?.score ?? 0)
            - (remote?.score ?? scoredCenters[0]?.score ?? 0),
        entropy,
        maximumYearProbability: Math.max(...probabilities),
        rawScoreDeviation: rawDeviation,
        rawScoreQ90Margin: Math.max(...rawScores) - quantile(rawScores, 0.9),
        peakCenterDistance: Math.abs(peakYear - centerYear) / span,
        modeCenterDistance: Math.abs(modeCenter - centerYear) / span,
        currentDistance: distance(input.currentPrimaryYear),
        operationDistance: distance(input.operationEvidence?.bestYear),
        sideDistance: distance(input.operationEvidence?.sideStepBestYear),
        coarseRelative: (centerYear - coarseStart) / span,
        oldNineYearSafety: safetyContext.nineYearSafety,
        oldSafetyMargin:
            safetyContext.nineYearSafety - safetyContext.widthThreshold,
        oldWasNarrow: safetyContext.recommendedWidth === 9 ? 1 : 0,
    };
    model.featureNames.forEach((name, index) => {
        values[`point:${name}`] = pointFeatures[index] ?? 0;
    });
    const safetyFeatures = safety.featureNames.map((name) => {
        const value = values[name];
        if (value === undefined) {
            throw new Error(`Unit-event safety feature is unavailable: ${name}`);
        }
        return Math.fround(value);
    });
    return {
        probability: sigmoid(scoreTrees(safety.model.tree_info, safetyFeatures)),
        existingNarrowThreshold: safety.existingNarrowThreshold,
        existingWideThreshold: safety.existingWideThreshold,
    };
};

const selectCalibratedWidth = (
    input: UnitEventWindowRankerInput,
    model: PointModel,
    years: readonly number[],
    rawScores: readonly number[],
    probabilities: readonly number[],
    centerYear: number,
    scoredCenters: readonly { centerYear: number; score: number }[],
): {
    recommendedWidth: 5 | 9 | 13;
    probability: number;
    threshold: number;
} => {
    const calibration = model.widthCalibration;
    if (!calibration) {
        return { recommendedWidth: 13, probability: 0, threshold: 1 };
    }
    const distances = years.map((year) => Math.abs(year - centerYear));
    const mass = (radius: number): number => probabilities.reduce(
        (sum, probability, index) => (
            (distances[index] ?? Number.POSITIVE_INFINITY) <= radius
                ? sum + probability
                : sum
        ),
        0,
    );
    const masses = [mass(2), mass(3), mass(4), mass(6)];
    const remote = scoredCenters.find((candidate) => (
        Math.abs(candidate.centerYear - centerYear) > 12
    )) ?? scoredCenters[scoredCenters.length - 1];
    const rawMean = mean(rawScores);
    const rawDeviation = Math.sqrt(mean(rawScores.map((score) => (
        (score - rawMean) ** 2
    ))));
    const anchorSigned = (anchor: number | undefined): number => (
        anchor === undefined ? 0 : (centerYear - anchor) / Math.max(1, years.length)
    );
    const anchorDistance = (anchor: number | undefined): number => (
        anchor === undefined
            ? 1
            : Math.abs(centerYear - anchor) / Math.max(1, years.length)
    );
    const operation = input.operationEvidence;
    const entropy = -probabilities.reduce((sum, probability) => (
        sum + probability * Math.log(Math.max(probability, 1e-12))
    ), 0) / Math.max(1e-12, Math.log(Math.max(2, probabilities.length)));
    const values: Record<string, number> = {
        mass5: masses[0],
        mass7: masses[1],
        mass9: masses[2],
        mass13: masses[3],
        mass5Over13: masses[0] / Math.max(1e-12, masses[3]),
        mass7Over13: masses[1] / Math.max(1e-12, masses[3]),
        mass9Over13: masses[2] / Math.max(1e-12, masses[3]),
        adjacentMassMargin: (scoredCenters[0]?.score ?? 0)
            - (scoredCenters[1]?.score ?? scoredCenters[0]?.score ?? 0),
        remoteMassMargin: (scoredCenters[0]?.score ?? 0) - (remote?.score ?? 0),
        entropy,
        maximumYearProbability: Math.max(...probabilities),
        rawScoreDeviation: rawDeviation,
        rawScoreQ90Margin: Math.max(...rawScores) - quantile(rawScores, 0.9),
        currentSigned: anchorSigned(input.currentPrimaryYear),
        operationSigned: anchorSigned(operation?.bestYear),
        sideSigned: anchorSigned(operation?.sideStepBestYear),
        currentDistance: anchorDistance(input.currentPrimaryYear),
        operationDistance: anchorDistance(operation?.bestYear),
        sideDistance: anchorDistance(operation?.sideStepBestYear),
        bestRawGain: operation?.bestRawGain ?? 0,
        bestDifferenceGain: operation?.bestDifferenceGain ?? 0,
        bestCombinedGain: operation?.bestCombinedGain ?? 0,
        topThreeDifferenceGain: operation?.topThreeDifferenceGain ?? 0,
        remoteDifferenceMargin: operation?.remoteDifferenceMargin ?? 0,
        bestSideStepScore: operation?.bestSideStepScore ?? 0,
        topThreeSideStepScore: operation?.topThreeSideStepScore ?? 0,
        bestSideMinimumAdvantage: operation?.bestSideMinimumAdvantage ?? 0,
        bestCorrectedSideSupport: operation?.bestCorrectedSideSupport ?? 0,
        sideStepRemoteMargin: operation?.sideStepRemoteMargin ?? 0,
    };
    const features = calibration.featureNames.map((name) => {
        const value = values[name];
        if (value === undefined) {
            throw new Error(`Unit-event width feature is unavailable: ${name}`);
        }
        return Math.fround(value);
    });
    for (const width of [5, 9] as const) {
        const classifier = calibration.classifiers[String(width) as "5" | "9"];
        if (!classifier) continue;
        const probability = sigmoid(scoreTrees(
            classifier.model.tree_info,
            features,
        ));
        if (probability >= classifier.threshold) {
            return {
                recommendedWidth: width,
                probability,
                threshold: classifier.threshold,
            };
        }
    }
    return { recommendedWidth: 13, probability: 0, threshold: 1 };
};

export const selectUnitEventPointWindow = (
    input: UnitEventWindowRankerInput,
    widthCenterYear?: number,
    refinement?: "wideMode" | "narrowMode",
    narrowSafetyContext?: UnitEventNarrowSafetyContext,
): UnitEventPointWindowResult | null => {
    const primaryModel = MODEL.eventTypes[input.eventType];
    const model = refinement
        ? primaryModel?.refinements?.[refinement]
        : primaryModel;
    if (!model) return null;
    const matrix = buildUnitEventPointFeatureMatrix(input, model.featureNames);
    if (!matrix || matrix.years.length < model.windowWidth) return null;
    const { years, features } = matrix;
    const rawScores = features.map((row) => scoreFeatures(model, row));
    const peakIndex = maximumIndex(rawScores);
    const peakYear = years[peakIndex] ?? years[0];
    const maximum = Math.max(...rawScores);
    const unscaled = rawScores.map((score) => Math.exp(Math.max(
        -30,
        Math.min(0, (score - maximum) / model.temperature),
    )));
    const total = Math.max(1e-12, unscaled.reduce((sum, value) => sum + value, 0));
    const probabilities = unscaled.map((value) => value / total);
    const halfWidth = Math.floor(model.windowWidth / 2);
    const scoredCenters = Array.from(
        { length: years[years.length - 1] - years[0] + 1 },
        (_, offset) => {
            const centerYear = years[0] + offset;
            const score = probabilities.reduce((sum, probability, index) => (
                Math.abs((years[index] ?? centerYear) - centerYear) <= halfWidth
                    ? sum + probability
                    : sum
            ), 0);
            return { centerYear, score };
        },
    ).sort((left, right) => (
        right.score - left.score
        || Math.abs(left.centerYear - peakYear) - Math.abs(right.centerYear - peakYear)
        || right.centerYear - left.centerYear
    ));
    const selected = scoredCenters[0];
    if (!selected) return null;
    const scoredWindows = scoredCenters.map(({ centerYear, score }) => ({
        ...boundedWindow(input, centerYear, model.windowWidth),
        score,
    }));
    const widthSelection = selectCalibratedWidth(
        input,
        model,
        years,
        rawScores,
        probabilities,
        widthCenterYear ?? selected.centerYear,
        scoredCenters,
    );
    const safety = refinement === "narrowMode" && narrowSafetyContext
        ? scoreNarrowSafety(
                input,
                model,
                narrowSafetyContext,
                years,
                features,
                rawScores,
                probabilities,
                peakYear,
                selected.centerYear,
                scoredCenters,
            )
        : null;
    return {
        window: scoredWindows[0],
        centerYear: selected.centerYear,
        peakYear,
        score: selected.score,
        margin: selected.score - (scoredCenters[1]?.score ?? selected.score),
        recommendedWidth: widthSelection.recommendedWidth,
        widthProbability: widthSelection.probability,
        widthThreshold: widthSelection.threshold,
        yearScores: new Map(years.map((year, index) => [
            year,
            rawScores[index] ?? Number.NEGATIVE_INFINITY,
        ])),
        scoredWindows,
        ...(safety ? {
            safetyProbability: safety.probability,
            existingNarrowThreshold: safety.existingNarrowThreshold,
            existingWideThreshold: safety.existingWideThreshold,
        } : {}),
    };
};
