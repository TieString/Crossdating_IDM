/**
 * Selects one 13-year missing-ring mode from existing locator evidence.
 *
 * The selector is deliberately cheap: it scores a small set of mass, peak,
 * change-point, reference, and coarse-window anchors with an offline-trained
 * linear model. It does not rerun counterfactual corrections.
 */
import modelData from "./missingRingModeSelectorModel.json";

export type MissingRingModeWindow = {
    startYear: number;
    endYear: number;
};

export type MissingRingModeOperationEvidence = {
    bestYear: number;
    bestRawGain?: number;
    bestDifferenceGain?: number;
    bestCombinedGain?: number;
    topThreeDifferenceGain?: number;
    remoteDifferenceMargin?: number;
    sideStepBestYear?: number;
    bestSideStepScore?: number;
    topThreeSideStepScore?: number;
    bestSideMinimumAdvantage?: number;
    bestCorrectedSideSupport?: number;
    sideStepRemoteMargin?: number;
};

export type MissingRingModeSelectorInput = {
    years: readonly number[];
    ranks: ReadonlyMap<string, readonly number[]>;
    currentModeWindow: MissingRingModeWindow;
    coarseWindow: MissingRingModeWindow;
    operationEvidence?: MissingRingModeOperationEvidence;
};

export type MissingRingModeSelectorResult = {
    window: MissingRingModeWindow;
    score: number;
    margin: number;
    scoredWindows: Array<MissingRingModeWindow & { score: number }>;
};

type SelectorModel = {
    windowWidth: number;
    profileNames: string[];
    modeNames: string[];
    featureCount: number;
    mean: number[];
    scale: number[];
    coefficients: number[];
    intercept: number;
};

const MODEL = modelData as SelectorModel;

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

const median = (values: readonly number[]): number => {
    const ordered = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2
        ? ordered[middle] ?? 0
        : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
};

const validStarts = (input: MissingRingModeSelectorInput): number[] => (
    input.years
        .slice(0, input.years.length - MODEL.windowWidth + 1)
        .map(Number)
);

const roundHalfToEven = (value: number): number => {
    const lower = Math.floor(value);
    const fraction = value - lower;
    if (Math.abs(fraction - 0.5) > 1e-12) return Math.round(value);
    return lower % 2 === 0 ? lower : lower + 1;
};

const centeredWindow = (
    input: MissingRingModeSelectorInput,
    centerYear: number | undefined,
): MissingRingModeWindow => {
    const starts = validStarts(input);
    const fallback = input.years[0] ?? 0;
    const preferred = roundHalfToEven(centerYear ?? fallback)
        - Math.floor(MODEL.windowWidth / 2);
    const startYear = starts.reduce((best, candidate) => {
        const distance = Math.abs(candidate - preferred);
        const bestDistance = Math.abs(best - preferred);
        return distance < bestDistance
            || (distance === bestDistance && candidate > best)
            ? candidate
            : best;
    }, starts[0] ?? fallback);
    return {
        startYear,
        endYear: startYear + MODEL.windowWidth - 1,
    };
};

const profileValues = (
    input: MissingRingModeSelectorInput,
    profileName: string,
): number[] => input.years.map((_, index) => (
    finite(input.ranks.get(profileName)?.[index])
));

const movingMasses = (
    values: readonly number[],
    width = MODEL.windowWidth,
): number[] => {
    if (values.length < width) return [];
    return Array.from(
        { length: values.length - width + 1 },
        (_, index) => values.slice(index, index + width).reduce(
            (sum, value) => sum + value,
            0,
        ),
    );
};

const maximumIndex = (values: readonly number[]): number => {
    let selected = 0;
    for (let index = 1; index < values.length; index += 1) {
        if (values[index] > values[selected]) selected = index;
    }
    return selected;
};

const massWindow = (
    input: MissingRingModeSelectorInput,
    profileNames: readonly string[],
): MissingRingModeWindow => {
    const profiles = profileNames.flatMap((profileName) => (
        input.ranks.has(profileName)
            ? [profileValues(input, profileName)]
            : []
    ));
    if (profiles.length === 0) {
        return input.currentModeWindow;
    }
    const values = input.years.map((_, index) => mean(
        profiles.map((profile) => profile[index] ?? 0),
    ));
    const index = maximumIndex(movingMasses(values));
    const startYear = input.years[index] ?? input.currentModeWindow.startYear;
    return {
        startYear,
        endYear: startYear + MODEL.windowWidth - 1,
    };
};

const peakWindow = (
    input: MissingRingModeSelectorInput,
    profileName: string,
): MissingRingModeWindow => {
    const values = input.ranks.get(profileName);
    if (!values || values.length === 0) return input.currentModeWindow;
    return centeredWindow(
        input,
        input.years[maximumIndex(values.map(finite))],
    );
};

const consensusWindow = (
    input: MissingRingModeSelectorInput,
): MissingRingModeWindow => {
    const profiles = [
        "differenceFull",
        "comboFull",
        "cumulativeCombined",
        "transitionSplitGain",
        "cumulativeReferenceMean",
        "cumulativeReferenceVote",
        "piecewiseCombinedObjective",
    ];
    const centers = profiles.map((profileName) => {
        const window = massWindow(input, [profileName]);
        return (window.startYear + window.endYear) / 2;
    });
    const difference = massWindow(input, ["differenceFull"]);
    const preferred = (difference.startYear + difference.endYear) / 2;
    const selected = centers.reduce((best, center) => {
        const score = centers.reduce(
            (sum, other) => sum + Math.exp(-Math.abs(center - other) / 5),
            0,
        );
        const distance = Math.abs(center - preferred);
        return score > best.score
            || (score === best.score && distance < best.distance)
            ? { center, score, distance }
            : best;
    }, {
        center: centers[0] ?? preferred,
        score: Number.NEGATIVE_INFINITY,
        distance: Number.POSITIVE_INFINITY,
    });
    return centeredWindow(input, selected.center);
};

const proposedModes = (
    input: MissingRingModeSelectorInput,
    snapToValidStarts = false,
): Map<string, MissingRingModeWindow> => {
    const operation = input.operationEvidence;
    const coarse = input.coarseWindow;
    const modes = new Map<string, MissingRingModeWindow>([
        ["current", input.currentModeWindow],
        ["difference", massWindow(input, ["differenceFull"])],
        ["combo", massWindow(input, ["comboFull"])],
        ["cumulative", massWindow(input, ["cumulativeCombined"])],
        ["transition", massWindow(input, ["transitionSplitGain"])],
        ["referenceVote", massWindow(input, ["cumulativeReferenceVote"])],
        ["referenceMean", massWindow(input, ["cumulativeReferenceMean"])],
        ["piecewise", massWindow(input, ["piecewiseCombinedObjective"])],
        ["localFusion", massWindow(input, [
            "rawFull",
            "differenceFull",
            "whitenedFull",
            "comboFull",
        ])],
        ["transitionFusion", massWindow(input, [
            "differenceFull",
            "comboFull",
            "cumulativeCombined",
            "piecewiseCombinedObjective",
            "transitionSplitGain",
            "cumulativeReferenceMean",
        ])],
        ["robustConsensus", consensusWindow(input)],
        ["peakDifference", peakWindow(input, "differenceFull")],
        ["peakCombo", peakWindow(input, "comboFull")],
        ["peakCumulative", peakWindow(input, "cumulativeCombined")],
        ["peakTransition", peakWindow(input, "transitionSplitGain")],
        ["peakReferenceMean", peakWindow(input, "cumulativeReferenceMean")],
        ["peakReferenceVote", peakWindow(input, "cumulativeReferenceVote")],
        ["operation", centeredWindow(input, operation?.bestYear)],
        ["sideStep", centeredWindow(input, operation?.sideStepBestYear)],
        ["coarseOlder", centeredWindow(
            input,
            coarse.startYear + Math.floor(MODEL.windowWidth / 2),
        )],
        ["coarseCenter", centeredWindow(
            input,
            (coarse.startYear + coarse.endYear) / 2,
        )],
        ["coarseNewer", centeredWindow(
            input,
            coarse.endYear - Math.floor(MODEL.windowWidth / 2),
        )],
    ]);
    if (!snapToValidStarts) return modes;
    return new Map([...modes].map(([name, window]) => [
        name,
        centeredWindow(input, (window.startYear + window.endYear) / 2),
    ]));
};

type ProfileStats = {
    values: number[];
    masses: number[];
    average: number;
    deviation: number;
    maximum: number;
    peakStart: number;
};

const prepareProfileStats = (
    input: MissingRingModeSelectorInput,
): Map<string, ProfileStats> => new Map(MODEL.profileNames.map((profileName) => {
    const values = profileValues(input, profileName);
    const masses = movingMasses(values);
    const peakIndex = maximumIndex(masses);
    return [profileName, {
        values,
        masses,
        average: mean(masses),
        deviation: Math.max(1e-8, standardDeviation(masses)),
        maximum: Math.max(...masses),
        peakStart: input.years[peakIndex] ?? input.currentModeWindow.startYear,
    }];
}));

const candidateFeatures = (
    input: MissingRingModeSelectorInput,
    modes: ReadonlyMap<string, MissingRingModeWindow>,
    stats: ReadonlyMap<string, ProfileStats>,
    startYear: number,
    includeBoundaryFeatures: boolean,
): number[] => {
    const starts = validStarts(input);
    const startIndex = starts.indexOf(startYear);
    const center = startYear + Math.floor(MODEL.windowWidth / 2);
    const features = MODEL.profileNames.flatMap((profileName) => {
        const profile = stats.get(profileName)!;
        const mass = profile.masses[startIndex] ?? 0;
        const base = [
            (mass - profile.average) / profile.deviation,
            (mass - profile.maximum) / profile.deviation,
            (startYear - profile.peakStart) / MODEL.windowWidth,
            Math.abs(startYear - profile.peakStart) / MODEL.windowWidth,
        ];
        if (!includeBoundaryFeatures) return base;
        const inside = profile.values.slice(
            startIndex,
            startIndex + MODEL.windowWidth,
        );
        const centerIndex = Math.floor(MODEL.windowWidth / 2);
        const centerValue = inside[centerIndex] ?? 0;
        const insideMean = mean(inside);
        const leftMean = mean(inside.slice(0, centerIndex));
        const rightMean = mean(inside.slice(centerIndex + 1));
        const local = inside.slice(centerIndex - 2, centerIndex + 3);
        return [
            ...base,
            centerValue,
            Math.max(...inside),
            centerValue - insideMean,
            rightMean - leftMean,
            Math.max(...local) - insideMean,
        ];
    });
    const modeStarts = MODEL.modeNames.map((name) => (
        modes.get(name)?.startYear ?? input.currentModeWindow.startYear
    ));
    const distances = modeStarts.map((modeStart) => (
        Math.abs(startYear - modeStart)
    ));
    const operation = input.operationEvidence;
    const operationDistance = operation
        ? (center - operation.bestYear) / MODEL.windowWidth
        : 0;
    const sideDistance = operation?.sideStepBestYear !== undefined
        ? (center - operation.sideStepBestYear) / MODEL.windowWidth
        : 0;
    features.push(
        distances.filter((distance) => distance === 0).length / distances.length,
        distances.filter((distance) => distance <= 2).length / distances.length,
        distances.filter((distance) => distance <= 4).length / distances.length,
        mean(distances.map((distance) => Math.exp(-distance / 2))),
        mean(distances.map((distance) => Math.exp(-distance / 5))),
        mean(distances) / MODEL.windowWidth,
        median(distances) / MODEL.windowWidth,
        (startYear - input.currentModeWindow.startYear) / MODEL.windowWidth,
        Math.abs(startYear - input.currentModeWindow.startYear) / MODEL.windowWidth,
        operationDistance,
        Math.abs(operationDistance),
        sideDistance,
        Math.abs(sideDistance),
    );
    const operationProximity = operation
        ? Math.exp(-Math.abs(center - operation.bestYear) / MODEL.windowWidth)
        : 0;
    const sideProximity = operation?.sideStepBestYear !== undefined
        ? Math.exp(
                -Math.abs(center - operation.sideStepBestYear)
                    / MODEL.windowWidth,
            )
        : 0;
    features.push(...[
        operation?.bestRawGain,
        operation?.bestDifferenceGain,
        operation?.bestCombinedGain,
        operation?.topThreeDifferenceGain,
        operation?.remoteDifferenceMargin,
    ].map((value) => operationProximity * finite(value)));
    features.push(...[
        operation?.bestSideStepScore,
        operation?.topThreeSideStepScore,
        operation?.bestSideMinimumAdvantage,
        operation?.bestCorrectedSideSupport,
        operation?.sideStepRemoteMargin,
    ].map((value) => sideProximity * finite(value)));
    const coarse = input.coarseWindow;
    const overlap = Math.max(
        0,
        Math.min(startYear + MODEL.windowWidth - 1, coarse.endYear)
            - Math.max(startYear, coarse.startYear)
            + 1,
    );
    features.push(
        Number(startYear <= coarse.startYear
            && coarse.startYear <= startYear + MODEL.windowWidth - 1),
        Number(startYear <= coarse.endYear
            && coarse.endYear <= startYear + MODEL.windowWidth - 1),
        overlap / MODEL.windowWidth,
    );
    features.push(...MODEL.modeNames.map((name) => Number(
        modes.get(name)?.startYear === startYear,
    )));
    return features;
};

export type UnitEventModeCandidate = MissingRingModeWindow & {
    features: number[];
};

/** Builds the shared physical mode candidates used by both unit-event selectors. */
export const buildUnitEventModeCandidates = (
    input: MissingRingModeSelectorInput,
    snapModesToValidStarts = false,
    includeBoundaryFeatures = false,
): UnitEventModeCandidate[] => {
    const modes = proposedModes(input, snapModesToValidStarts);
    const stats = prepareProfileStats(input);
    const starts = [...new Set([...modes.values()].map((mode) => (
        mode.startYear
    )))].sort((left, right) => left - right);
    return starts.map((startYear) => {
        const features = candidateFeatures(
            input,
            modes,
            stats,
            startYear,
            includeBoundaryFeatures,
        );
        if (!includeBoundaryFeatures && features.length !== MODEL.featureCount) {
            throw new Error(
                `Unit-event mode feature mismatch: ${features.length}`,
            );
        }
        return {
            startYear,
            endYear: startYear + MODEL.windowWidth - 1,
            features,
        };
    });
};

const scoreFeatures = (features: readonly number[]): number => (
    MODEL.intercept + features.reduce((score, value, index) => (
        score + (
            (value - (MODEL.mean[index] ?? 0))
            / Math.max(1e-12, MODEL.scale[index] ?? 1)
        ) * (MODEL.coefficients[index] ?? 0)
    ), 0)
);

export const selectMissingRingMode = (
    input: MissingRingModeSelectorInput,
): MissingRingModeSelectorResult | null => {
    if (input.years.length < MODEL.windowWidth) return null;
    const scoredWindows = buildUnitEventModeCandidates(input).map((candidate) => {
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
