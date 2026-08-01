/**
 * Operation selectors over the complete counterfactual grid.
 *
 * The exported forest remains available only for its original closed six-operation grid.
 * Dynamic physical gaps use breakpoint-local evidence and never collapse -4..-100 into one
 * of those legacy classes.
 */
import modelData from "./jointOperationSelectorModel.json";
import type { JointCounterfactualOperationScore } from "./jointCounterfactualOperation";

type SelectorTree = {
    probabilities: number[];
} | {
    featureIndex: number;
    threshold: number;
    left: SelectorTree;
    right: SelectorTree;
};

type SelectorModel = {
    schemaVersion: number;
    operationFeatureCount: number;
    vectorFeatureCount: number;
    corrections: number[];
    trees: SelectorTree[];
};

export type JointOperationSelection = {
    operation: JointCounterfactualOperationScore;
    correctionYears: number;
    probability: number;
    probabilityMargin: number;
    probabilities: ReadonlyMap<number, number>;
};

export type JointOperationRegionalEvidence = {
    startYear: number;
    endYear: number;
    rowCount: number;
    bestYear: number | null;
    bestRawGain: number;
    bestDifferenceGain: number;
    topThreeDifferenceGain: number;
    meanDifferenceGain: number;
    bestCombinedGain: number;
    topThreeCombinedGain: number;
    bestSideStepYear: number | null;
    bestSideStepScore: number;
    topThreeSideStepScore: number;
    bestSideMinimumAdvantage: number;
    bestCorrectedSideSupport: number;
    differenceOutsideMargin: number;
    sideStepOutsideMargin: number;
    anchorYear: number;
    anchorDifferenceGain: number;
    anchorCombinedGain: number;
    anchorSideStepScore: number;
    anchorSideMinimumAdvantage: number;
    anchorCorrectedSideSupport: number;
    anchorThreeDifferenceGain: number;
    anchorFiveDifferenceGain: number;
    anchorThreeCombinedGain: number;
    anchorFiveCombinedGain: number;
    anchorThreeSideStepScore: number;
    anchorFiveSideStepScore: number;
};

export type DynamicPartialOperationSelection = {
    operation: JointCounterfactualOperationScore;
    regionalEvidence: JointOperationRegionalEvidence;
    score: number;
    scoreMargin: number;
    probabilityLike: number;
};

const MODEL = modelData as unknown as SelectorModel;
const EXPECTED_CORRECTIONS = [-3, -2, -1, 1, 2, 3] as const;

const finite = (value: number, fallback = 0): number => (
    Number.isFinite(value) ? value : fallback
);

const mean = (values: readonly number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

const maximumFinite = (
    values: readonly number[],
    fallback = Number.NEGATIVE_INFINITY,
): number => values.reduce(
    (best, value) => Number.isFinite(value) ? Math.max(best, value) : best,
    fallback,
);

const quantile = (values: readonly number[], fraction: number): number => {
    if (values.length === 0) return 0;
    const ordered = values
        .map((value) => finite(value))
        .sort((left, right) => left - right);
    return ordered[Math.round((ordered.length - 1) * fraction)] ?? 0;
};

const summarize = (values: readonly number[]): number[] => {
    const finiteValues = values.map((value) => finite(value));
    const descending = finiteValues.slice().sort((left, right) => right - left);
    const center = mean(finiteValues);
    return [
        descending[0] ?? 0,
        mean(descending.slice(0, 3)),
        mean(descending.slice(0, 7)),
        quantile(finiteValues, 0.5),
        quantile(finiteValues, 0.75),
        quantile(finiteValues, 0.9),
        center,
        Math.sqrt(mean(finiteValues.map((value) => (value - center) ** 2))),
    ];
};

const operationFeatures = (
    operation: JointCounterfactualOperationScore,
): number[] => [
    operation.bestRawGain,
    operation.bestDifferenceGain,
    operation.bestCombinedGain,
    operation.topThreeDifferenceGain,
    operation.remoteDifferenceMargin,
    operation.remoteDifferenceMargin,
    // The selector deliberately excludes upstream event choices to avoid circular inference.
    0,
    0,
    0,
    0,
    0,
    Math.abs(operation.shiftYears),
    Math.sign(operation.shiftYears),
    Number(Math.abs(operation.shiftYears) === 1),
    ...summarize(operation.rows.map((row) => row.rawGain)),
    ...summarize(operation.rows.map((row) => row.differenceGain)),
    ...summarize(operation.rows.map((row) => row.combinedGain)),
].map((value) => finite(value));

const dynamicOperationBaseScore = (
    operation: JointCounterfactualOperationScore,
): number => (
    operation.topThreeDifferenceGain * 0.4
    + operation.bestDifferenceGain * 0.25
    + operation.bestCombinedGain * 0.2
    + operation.remoteDifferenceMargin * 0.15
);

/**
 * Corrects the look-elsewhere effect by requiring an operation to beat nearby shifts.
 * Every magnitude receives the same comparison; this is not a small-gap prior.
 */
export const scoreDynamicJointOperation = (
    operation: JointCounterfactualOperationScore,
    operations: readonly JointCounterfactualOperationScore[],
): number => {
    const base = dynamicOperationBaseScore(operation);
    const neighbors = operations.filter((candidate) => (
        candidate !== operation
        && Math.sign(candidate.shiftYears) === Math.sign(operation.shiftYears)
        && Math.abs(candidate.shiftYears - operation.shiftYears) <= 2
    ));
    if (neighbors.length === 0) return base;
    const neighborMean = mean(neighbors.map(dynamicOperationBaseScore));
    return base + (base - neighborMean) * 0.2;
};

export type DynamicJointOperationSelection = {
    operation: JointCounterfactualOperationScore;
    score: number;
    scoreMargin: number;
    shiftScoreMargin: number | null;
    probabilityLike: number;
};

/**
 * Selects one operation without assuming a fixed class count. Each event family first keeps
 * its strongest operation, so the 99 physical gap hypotheses do not overwhelm the unit edits
 * merely by being more numerous.
 */
const selectDynamicJointOperationFamilies = (
    operations: readonly JointCounterfactualOperationScore[],
    eventTypes: readonly JointCounterfactualOperationScore["eventType"][],
): DynamicJointOperationSelection | null => {
    const familyWinners = eventTypes.flatMap((eventType) => {
        const family = operations
            .filter((operation) => operation.eventType === eventType)
            .map((operation) => ({
                operation,
                score: scoreDynamicJointOperation(operation, operations),
            }))
            .sort((left, right) => (
                right.score - left.score
                || right.operation.bestDifferenceGain
                    - left.operation.bestDifferenceGain
                || right.operation.remoteDifferenceMargin
                    - left.operation.remoteDifferenceMargin
                || right.operation.shiftYears - left.operation.shiftYears
            ));
        const selected = family[0];
        if (!selected) return [];
        return [{
            ...selected,
            shiftScoreMargin: eventType === "partialMove"
                ? selected.score - (family[1]?.score ?? selected.score)
                : null,
        }];
    }).sort((left, right) => (
        right.score - left.score
        || right.operation.bestDifferenceGain - left.operation.bestDifferenceGain
        || right.operation.remoteDifferenceMargin
            - left.operation.remoteDifferenceMargin
    ));
    const selected = familyWinners[0];
    if (!selected) return null;
    const runnerUp = familyWinners[1];
    const maximum = selected.score;
    const temperature = 0.04;
    const weights = familyWinners.map((candidate) => Math.exp(
        Math.max(-30, Math.min(30, (candidate.score - maximum) / temperature)),
    ));
    const total = weights.reduce((sum, value) => sum + value, 0) || 1;
    return {
        ...selected,
        scoreMargin: selected.score - (runnerUp?.score ?? selected.score),
        probabilityLike: weights[0] / total,
    };
};

export const selectDynamicJointOperation = (
    operations: readonly JointCounterfactualOperationScore[],
): DynamicJointOperationSelection | null => selectDynamicJointOperationFamilies(
    operations,
    ["missingRing", "falseRing", "partialMove"],
);

/**
 * Selects between the two one-year edits while retaining the full negative-shift grid as
 * look-elsewhere context for the missing-ring score.
 */
export const selectDynamicUnitOperation = (
    operations: readonly JointCounterfactualOperationScore[],
): DynamicJointOperationSelection | null => selectDynamicJointOperationFamilies(
    operations,
    ["missingRing", "falseRing"],
);

/**
 * Summarizes every operation over the same breakpoint region. This removes the unfair
 * year-by-operation look-elsewhere advantage caused by letting each shift choose an unrelated
 * peak anywhere in the series.
 */
export const summarizeJointOperationRegion = (
    operation: JointCounterfactualOperationScore,
    startYear: number,
    endYear: number,
    anchorYear = Math.round((startYear + endYear) / 2),
): JointOperationRegionalEvidence => {
    const inside = operation.rows.filter(
        (row) => row.year >= startYear && row.year <= endYear,
    );
    const outside = operation.rows.filter(
        (row) => row.year < startYear || row.year > endYear,
    );
    const differenceRanked = inside.slice().sort((left, right) => (
        right.differenceGain - left.differenceGain
        || right.combinedGain - left.combinedGain
        || right.year - left.year
    ));
    const combinedRanked = inside.slice().sort((left, right) => (
        right.combinedGain - left.combinedGain
        || right.differenceGain - left.differenceGain
        || right.year - left.year
    ));
    const sideRanked = inside
        .filter((row) => Number.isFinite(row.sideStepScore))
        .sort((left, right) => (
            right.sideStepScore - left.sideStepScore
            || right.sideMinimumAdvantage - left.sideMinimumAdvantage
            || right.correctedSideSupport - left.correctedSideSupport
            || right.year - left.year
        ));
    const bestDifference = differenceRanked[0];
    const bestSide = sideRanked[0];
    const bestOutsideDifference = maximumFinite(
        outside.map((row) => row.differenceGain),
        bestDifference?.differenceGain ?? Number.NEGATIVE_INFINITY,
    );
    const bestOutsideSide = maximumFinite(
        outside.map((row) => row.sideStepScore),
        bestSide?.sideStepScore ?? Number.NEGATIVE_INFINITY,
    );
    const anchor = inside.reduce<typeof inside[number] | null>((best, row) => (
        best === null
        || Math.abs(row.year - anchorYear) < Math.abs(best.year - anchorYear)
            ? row
            : best
    ), null);
    const nearAnchor = (radius: number) => inside.filter(
        (row) => Math.abs(row.year - anchorYear) <= radius,
    );
    const anchorThree = nearAnchor(1);
    const anchorFive = nearAnchor(2);
    return {
        startYear,
        endYear,
        rowCount: inside.length,
        bestYear: bestDifference?.year ?? null,
        bestRawGain: maximumFinite(inside.map((row) => row.rawGain)),
        bestDifferenceGain:
            bestDifference?.differenceGain ?? Number.NEGATIVE_INFINITY,
        topThreeDifferenceGain: mean(
            differenceRanked.slice(0, 3).map((row) => row.differenceGain),
        ),
        meanDifferenceGain: mean(inside.map((row) => row.differenceGain)),
        bestCombinedGain:
            combinedRanked[0]?.combinedGain ?? Number.NEGATIVE_INFINITY,
        topThreeCombinedGain: mean(
            combinedRanked.slice(0, 3).map((row) => row.combinedGain),
        ),
        bestSideStepYear: bestSide?.year ?? null,
        bestSideStepScore:
            bestSide?.sideStepScore ?? Number.NEGATIVE_INFINITY,
        topThreeSideStepScore: mean(
            sideRanked.slice(0, 3).map((row) => row.sideStepScore),
        ),
        bestSideMinimumAdvantage:
            bestSide?.sideMinimumAdvantage ?? Number.NEGATIVE_INFINITY,
        bestCorrectedSideSupport:
            bestSide?.correctedSideSupport ?? Number.NEGATIVE_INFINITY,
        differenceOutsideMargin: bestDifference
            ? bestDifference.differenceGain - bestOutsideDifference
            : Number.NEGATIVE_INFINITY,
        sideStepOutsideMargin: bestSide
            ? bestSide.sideStepScore - bestOutsideSide
            : Number.NEGATIVE_INFINITY,
        anchorYear,
        anchorDifferenceGain:
            anchor?.differenceGain ?? Number.NEGATIVE_INFINITY,
        anchorCombinedGain:
            anchor?.combinedGain ?? Number.NEGATIVE_INFINITY,
        anchorSideStepScore:
            anchor?.sideStepScore ?? Number.NEGATIVE_INFINITY,
        anchorSideMinimumAdvantage:
            anchor?.sideMinimumAdvantage ?? Number.NEGATIVE_INFINITY,
        anchorCorrectedSideSupport:
            anchor?.correctedSideSupport ?? Number.NEGATIVE_INFINITY,
        anchorThreeDifferenceGain: mean(
            anchorThree.map((row) => row.differenceGain),
        ),
        anchorFiveDifferenceGain: mean(
            anchorFive.map((row) => row.differenceGain),
        ),
        anchorThreeCombinedGain: mean(
            anchorThree.map((row) => row.combinedGain),
        ),
        anchorFiveCombinedGain: mean(
            anchorFive.map((row) => row.combinedGain),
        ),
        anchorThreeSideStepScore: mean(
            anchorThree.map((row) => row.sideStepScore),
        ),
        anchorFiveSideStepScore: mean(
            anchorFive.map((row) => row.sideStepScore),
        ),
    };
};

/**
 * Selects one physical gap at an already detected breakpoint. Event presence is deliberately
 * handled upstream; this comparison answers only "how many older years are missing?".
 *
 * Every negative shift receives exactly the same five-year boundary statistic. There is no
 * magnitude penalty or preferred list of gaps, so -50 and -100 can win without being snapped
 * to a smaller legacy class.
 */
export const selectDynamicPartialOperationAtBreakpoint = (
    operations: readonly JointCounterfactualOperationScore[],
    firstFixedYear: number,
): DynamicPartialOperationSelection | null => {
    const candidates = operations
        .filter((operation) => (
            operation.eventType === "partialMove"
            && operation.shiftYears < -1
            && operation.rows.some(
                (row) => Math.abs(row.year - firstFixedYear) <= 2,
            )
        ))
        .map((operation) => {
            const regionalEvidence = summarizeJointOperationRegion(
                operation,
                firstFixedYear - 6,
                firstFixedYear + 6,
                firstFixedYear,
            );
            return {
                operation,
                regionalEvidence,
                score: regionalEvidence.anchorFiveCombinedGain,
            };
        })
        .filter((candidate) => Number.isFinite(candidate.score))
        .sort((left, right) => (
            right.score - left.score
            || right.regionalEvidence.anchorFiveDifferenceGain
                - left.regionalEvidence.anchorFiveDifferenceGain
            || right.regionalEvidence.anchorFiveSideStepScore
                - left.regionalEvidence.anchorFiveSideStepScore
            || scoreDynamicJointOperation(right.operation, operations)
                - scoreDynamicJointOperation(left.operation, operations)
            || right.operation.shiftYears - left.operation.shiftYears
        ));
    const selected = candidates[0];
    if (!selected) return null;
    const runnerUp = candidates[1];
    const maximum = selected.score;
    const temperature = 0.04;
    const weights = candidates.map((candidate) => Math.exp(
        Math.max(-30, Math.min(30, (candidate.score - maximum) / temperature)),
    ));
    const total = weights.reduce((sum, value) => sum + value, 0) || 1;
    return {
        ...selected,
        scoreMargin: selected.score - (runnerUp?.score ?? selected.score),
        probabilityLike: weights[0] / total,
    };
};

export const buildJointOperationSelectorFeatures = (
    operations: readonly JointCounterfactualOperationScore[],
): number[] | null => {
    // The exported forest is a closed six-class model. Never let it ignore extra dynamic
    // negative shifts or silently force a large physical gap into one of its old classes.
    if (operations.length !== EXPECTED_CORRECTIONS.length
        || operations.some((operation) => (
            !EXPECTED_CORRECTIONS.includes(
                operation.shiftYears as typeof EXPECTED_CORRECTIONS[number],
            )
        ))) {
        return null;
    }
    const ordered = EXPECTED_CORRECTIONS.map((correction) => (
        operations.find((operation) => operation.shiftYears === correction)
    ));
    if (ordered.some((operation) => operation === undefined)) return null;
    const matrix = ordered.map((operation) => operationFeatures(operation!));
    if (matrix.some((row) => row.length !== MODEL.operationFeatureCount)) {
        return null;
    }

    const means = Array.from(
        { length: MODEL.operationFeatureCount },
        (_, featureIndex) => mean(matrix.map((row) => row[featureIndex])),
    );
    const standardDeviations = means.map((center, featureIndex) => Math.sqrt(
        mean(matrix.map((row) => (row[featureIndex] - center) ** 2)),
    ));
    const maxima = means.map((_, featureIndex) => Math.max(
        ...matrix.map((row) => row[featureIndex]),
    ));
    const minima = means.map((_, featureIndex) => Math.min(
        ...matrix.map((row) => row[featureIndex]),
    ));
    const topMargins = means.map((_, featureIndex) => {
        const orderedValues = matrix
            .map((row) => row[featureIndex])
            .sort((left, right) => left - right);
        return (
            (orderedValues[orderedValues.length - 1] ?? 0)
            - (orderedValues[orderedValues.length - 2] ?? 0)
        );
    });
    const features = [
        ...matrix.flat(),
        ...matrix.flatMap((row) => row.map(
            (value, featureIndex) => value - means[featureIndex],
        )),
        ...matrix.flatMap((row) => row.map(
            (value, featureIndex) => value - maxima[featureIndex],
        )),
        ...matrix.flatMap((row) => row.map(
            (value, featureIndex) => value - minima[featureIndex],
        )),
        ...means,
        ...standardDeviations,
        ...topMargins,
        ...maxima.map((value, featureIndex) => value - minima[featureIndex]),
        0,
        0,
        0,
        0,
        0,
    ];
    return features.length === MODEL.vectorFeatureCount ? features : null;
};

const predictTree = (
    tree: SelectorTree,
    features: readonly number[],
): number[] => {
    if ("probabilities" in tree) return tree.probabilities;
    return predictTree(
        (features[tree.featureIndex] ?? 0) <= tree.threshold
            ? tree.left
            : tree.right,
        features,
    );
};

export const selectJointCounterfactualOperation = (
    operations: readonly JointCounterfactualOperationScore[],
): JointOperationSelection | null => {
    const features = buildJointOperationSelectorFeatures(operations);
    if (!features || MODEL.trees.length === 0) {
        if (operations.length === 0) return null;
        const scores = operations.map((operation) => (
            scoreDynamicJointOperation(operation, operations)
        ));
        const maximum = Math.max(...scores);
        const temperature = 0.04;
        const weights = scores.map((score) => Math.exp(
            Math.max(-30, Math.min(30, (score - maximum) / temperature)),
        ));
        const total = weights.reduce((sum, value) => sum + value, 0) || 1;
        const probabilities = new Map(operations.map((operation, index) => [
            operation.shiftYears,
            weights[index] / total,
        ]));
        const order = operations
            .map((operation, index) => ({
                operation,
                probability: weights[index] / total,
                score: scores[index],
            }))
            .sort((left, right) => (
                right.score - left.score
                || right.operation.bestDifferenceGain
                    - left.operation.bestDifferenceGain
                || right.operation.remoteDifferenceMargin
                    - left.operation.remoteDifferenceMargin
            ));
        const selected = order[0];
        return {
            operation: selected.operation,
            correctionYears: selected.operation.shiftYears,
            probability: selected.probability,
            probabilityMargin:
                selected.probability - (order[1]?.probability ?? selected.probability),
            probabilities,
        };
    }
    const totals = new Array(MODEL.corrections.length).fill(0);
    MODEL.trees.forEach((tree) => {
        predictTree(tree, features).forEach((probability, index) => {
            totals[index] += probability;
        });
    });
    const probabilities = totals.map((total) => total / MODEL.trees.length);
    const order = probabilities
        .map((probability, index) => ({ probability, index }))
        .sort((left, right) => (
            right.probability - left.probability || left.index - right.index
        ));
    const selected = order[0];
    if (!selected) return null;
    const correctionYears = MODEL.corrections[selected.index];
    const operation = operations.find(
        (candidate) => candidate.shiftYears === correctionYears,
    );
    if (!operation) return null;
    return {
        operation,
        correctionYears,
        probability: selected.probability,
        probabilityMargin:
            selected.probability - (order[1]?.probability ?? selected.probability),
        probabilities: new Map(MODEL.corrections.map((correction, index) => [
            correction,
            probabilities[index] ?? 0,
        ])),
    };
};
