/**
 * Calibrates whether the selected false-ring mode can be narrowed to 9 years.
 *
 * The narrow candidate reuses the previous fine locator when it was already
 * confident; otherwise it is centered on the primary event year. A shallow
 * offline-trained forest decides whether to expose that candidate or retain
 * the full 13-year mode.
 */
import modelData from "./falseRingWindowCalibratorModel.json";
import {
    buildUnitEventModeCandidates,
    type MissingRingModeOperationEvidence,
    type MissingRingModeWindow,
} from "./missingRingModeSelector";

type CalibratorTree = {
    value: number;
} | {
    feature: number;
    threshold: number;
    left: CalibratorTree;
    right: CalibratorTree;
};

type CalibratorModel = {
    featureCount: number;
    threshold: number;
    trees: CalibratorTree[];
};

const MODEL = modelData as unknown as CalibratorModel;
const MODE_WIDTH = 13;
const NARROW_WIDTH = 9;
const PROFILE_NAMES = [
    "rawFull",
    "differenceFull",
    "whitenedFull",
    "comboFull",
    "cumulativeCombined",
    "cumulativeDifference",
    "transitionSplitGain",
    "piecewiseCombinedObjective",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
    "reference:weightedRankMean",
] as const;
const MAXIMUM_NARROW_TRANSITION_DISAGREEMENT = 0;

export type FalseRingWindowCalibratorInput = {
    years: readonly number[];
    ranks: ReadonlyMap<string, readonly number[]>;
    selectedModeWindow: MissingRingModeWindow;
    learnedModeWindow: MissingRingModeWindow;
    previousModeWindow: MissingRingModeWindow;
    previousWindow: MissingRingModeWindow;
    coarseWindow: MissingRingModeWindow;
    currentPrimaryYear?: number;
    nineYearSafety: number;
    nineYearSafetyThreshold: number;
    operationEvidence?: MissingRingModeOperationEvidence;
    learnedWindowScore: number;
    learnedWindowMargin: number;
    learnedWindowRemoteMargin: number;
};

export type FalseRingWindowCalibratorResult = {
    window: MissingRingModeWindow;
    recommendedWidth: 9 | 13;
    probability: number;
    threshold: number;
};

export const isFalseRingNarrowWindowConsistent = (input: {
    selectedModeWindow: MissingRingModeWindow;
    narrowWindow: MissingRingModeWindow;
    transitionNarrowStart: number;
}): boolean => {
    const narrowOffset = input.narrowWindow.startYear
        - input.selectedModeWindow.startYear;
    const narrowTouchesModeEdge = narrowOffset === 0
        || narrowOffset === MODE_WIDTH - NARROW_WIDTH;
    return Math.abs(
        input.narrowWindow.startYear - input.transitionNarrowStart,
    ) <= MAXIMUM_NARROW_TRANSITION_DISAGREEMENT
        && !narrowTouchesModeEdge;
};

const finite = (value: number | undefined): number => (
    Number.isFinite(value) ? value! : 0
);

const mean = (values: readonly number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

const standardDeviation = (values: readonly number[]): number => {
    const average = mean(values);
    return Math.sqrt(mean(values.map((value) => (
        (value - average) ** 2
    ))));
};

const maximumIndex = (values: readonly number[]): number => {
    let selected = 0;
    for (let index = 1; index < values.length; index += 1) {
        if (values[index] > values[selected]) selected = index;
    }
    return selected;
};

const predictTree = (
    tree: CalibratorTree,
    features: readonly number[],
): number => {
    if ("value" in tree) return tree.value;
    return predictTree(
        finite(features[tree.feature]) <= tree.threshold
            ? tree.left
            : tree.right,
        features,
    );
};

const buildFeatures = (
    input: FalseRingWindowCalibratorInput,
): {
    features: number[];
    narrowWindow: MissingRingModeWindow;
    transitionNarrowStart: number;
} | null => {
    const years = input.years.map(Number);
    const yearIndexes = new Map(years.map((year, index) => [year, index]));
    const selectedStart = input.selectedModeWindow.startYear;
    const selectedIndex = yearIndexes.get(selectedStart);
    if (selectedIndex === undefined) return null;
    const previousWidth = input.previousWindow.endYear
        - input.previousWindow.startYear
        + 1;
    const previousCenter = (
        input.previousWindow.startYear + input.previousWindow.endYear
    ) / 2;
    const primary = previousWidth <= NARROW_WIDTH
        ? previousCenter
        : input.currentPrimaryYear ?? (
                input.selectedModeWindow.startYear
                + input.selectedModeWindow.endYear
            ) / 2;
    const narrowStart = Math.max(
        selectedStart,
        Math.min(
            Math.round(primary) - Math.floor(NARROW_WIDTH / 2),
            input.selectedModeWindow.endYear - NARROW_WIDTH + 1,
        ),
    );
    const narrowIndex = yearIndexes.get(narrowStart);
    if (narrowIndex === undefined) return null;

    const profileFeatures: number[] = [];
    const profileVotes: number[] = [];
    for (const profileName of PROFILE_NAMES) {
        const source = input.ranks.get(profileName);
        const values = years.map((_, index) => finite(source?.[index]));
        const masses = Array.from({ length: 5 }, (_, offset) => {
            const startIndex = yearIndexes.get(selectedStart + offset);
            if (startIndex === undefined) return Number.NEGATIVE_INFINITY;
            return values.slice(startIndex, startIndex + NARROW_WIDTH).reduce(
                (sum, value) => sum + value,
                0,
            );
        });
        const voteOffset = maximumIndex(masses);
        profileVotes.push(voteOffset);
        const selectedValues = values.slice(
            selectedIndex,
            selectedIndex + MODE_WIDTH,
        );
        const narrowValues = values.slice(
            narrowIndex,
            narrowIndex + NARROW_WIDTH,
        );
        const narrowOffset = narrowStart - selectedStart;
        const totalMass = Math.max(
            1e-8,
            selectedValues.reduce((sum, value) => sum + Math.abs(value), 0),
        );
        const deviation = Math.max(1e-8, standardDeviation(masses));
        profileFeatures.push(
            narrowValues.reduce((sum, value) => sum + value, 0) / totalMass,
            selectedValues.slice(0, narrowOffset).reduce(
                (sum, value) => sum + value,
                0,
            ) / totalMass,
            selectedValues.slice(narrowOffset + NARROW_WIDTH).reduce(
                (sum, value) => sum + value,
                0,
            ) / totalMass,
            ((masses[narrowOffset] ?? 0) - mean(masses)) / deviation,
            ((masses[narrowOffset] ?? 0) - Math.max(...masses)) / deviation,
            (narrowOffset - voteOffset) / 4,
            Math.abs(narrowOffset - voteOffset) / 4,
            (narrowValues[narrowValues.length - 1] ?? 0)
                - (narrowValues[0] ?? 0),
        );
    }

    const modeCandidate = buildUnitEventModeCandidates({
        years: input.years,
        ranks: input.ranks,
        currentModeWindow: input.previousModeWindow,
        coarseWindow: input.coarseWindow,
        operationEvidence: input.operationEvidence,
    }, true).find((candidate) => (
        candidate.startYear === input.learnedModeWindow.startYear
    ));
    if (!modeCandidate) return null;
    const operation = input.operationEvidence;
    const narrowCenter = narrowStart + Math.floor(NARROW_WIDTH / 2);
    const voteCounts = Array.from({ length: 5 }, (_, offset) => (
        profileVotes.filter((vote) => vote === offset).length
    ));
    const narrowOffset = narrowStart - selectedStart;
    const features = [
        ...modeCandidate.features,
        ...profileFeatures,
        narrowOffset,
        Math.max(...voteCounts) / PROFILE_NAMES.length,
        (voteCounts[narrowOffset] ?? 0) / PROFILE_NAMES.length,
        standardDeviation(profileVotes),
        input.nineYearSafety,
        input.nineYearSafetyThreshold,
        Number(previousWidth <= NARROW_WIDTH),
        previousWidth / MODE_WIDTH,
        (selectedStart - input.previousModeWindow.startYear) / MODE_WIDTH,
        Math.abs(selectedStart - input.previousModeWindow.startYear)
            / MODE_WIDTH,
        (selectedStart - input.learnedModeWindow.startYear) / MODE_WIDTH,
        Math.abs(selectedStart - input.learnedModeWindow.startYear)
            / MODE_WIDTH,
        (narrowCenter - finite(operation?.bestYear ?? narrowCenter))
            / MODE_WIDTH,
        Math.abs(narrowCenter - finite(operation?.bestYear ?? narrowCenter))
            / MODE_WIDTH,
        (narrowCenter - finite(operation?.sideStepBestYear ?? narrowCenter))
            / MODE_WIDTH,
        Math.abs(
            narrowCenter - finite(operation?.sideStepBestYear ?? narrowCenter),
        ) / MODE_WIDTH,
        finite(operation?.bestDifferenceGain),
        finite(operation?.remoteDifferenceMargin),
        finite(operation?.bestSideStepScore),
        finite(operation?.bestSideMinimumAdvantage),
        finite(operation?.bestCorrectedSideSupport),
        finite(operation?.sideStepRemoteMargin),
        input.learnedWindowScore,
        input.learnedWindowMargin,
        input.learnedWindowRemoteMargin,
    ];
    return {
        features,
        narrowWindow: {
            startYear: narrowStart,
            endYear: narrowStart + NARROW_WIDTH - 1,
        },
        transitionNarrowStart: selectedStart + (
            profileVotes[PROFILE_NAMES.indexOf("transitionSplitGain")] ?? 0
        ),
    };
};

export const calibrateFalseRingWindow = (
    input: FalseRingWindowCalibratorInput,
): FalseRingWindowCalibratorResult => {
    const prepared = buildFeatures(input);
    if (!prepared || prepared.features.length !== MODEL.featureCount) {
        return {
            window: input.selectedModeWindow,
            recommendedWidth: 13,
            probability: 0,
            threshold: MODEL.threshold,
        };
    }
    const probability = MODEL.trees.reduce(
        (sum, tree) => sum + predictTree(tree, prepared.features),
        0,
    ) / Math.max(1, MODEL.trees.length);
    const useNarrow = probability + 1e-12 >= MODEL.threshold
        && isFalseRingNarrowWindowConsistent({
            selectedModeWindow: input.selectedModeWindow,
            narrowWindow: prepared.narrowWindow,
            transitionNarrowStart: prepared.transitionNarrowStart,
        });
    return {
        window: useNarrow ? prepared.narrowWindow : input.selectedModeWindow,
        recommendedWidth: useNarrow ? 9 : 13,
        probability,
        threshold: MODEL.threshold,
    };
};
