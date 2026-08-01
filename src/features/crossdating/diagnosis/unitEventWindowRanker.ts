/**
 * Static full-interval window localization for unit missing- and false-ring events.
 *
 * Missing rings use a full-axis mode ranker. False rings first select one mode from
 * independently proposed evidence peaks, then allow a 9-year refinement only when the
 * fine locator agrees with that mode. All trees are trained offline; runtime is TypeScript.
 */
import modelData from "./unitEventWindowRankerModel.json";

export type UnitEventWindowType = "missingRing" | "falseRing";

export type UnitEventRankerWindow = {
    startYear: number;
    endYear: number;
};

export type UnitEventRankerCandidate = UnitEventRankerWindow & {
    source: string;
    aggregateScore?: number;
    overlapConsensus?: number;
};

export type UnitEventRankerOperationEvidence = {
    bestYear: number;
    bestRawGain?: number;
    bestDifferenceGain?: number;
    bestCombinedGain?: number;
    topThreeDifferenceGain?: number;
    remoteDifferenceMargin?: number;
    sideStepBestYear?: number;
    bestSideStepScore?: number;
    topThreeSideStepScore?: number;
    sideStepRemoteMargin?: number;
};

export type UnitEventWindowRankerInput = {
    eventType: UnitEventWindowType;
    years: readonly number[];
    ranks: ReadonlyMap<string, readonly number[]>;
    internalCandidates: readonly UnitEventRankerCandidate[];
    currentPrimaryYear?: number;
    operationEvidence?: UnitEventRankerOperationEvidence;
};

export type UnitEventWindowRankerResult = {
    /** The single calibrated window exposed to the diagnosis pipeline. */
    window: UnitEventRankerWindow;
    /** The selected 13-year location mode before case-level width calibration. */
    modeWindow: UnitEventRankerWindow;
    recommendedWidth: 9 | 13;
    nineYearSafety: number;
    widthThreshold: number;
    score: number;
    margin: number;
    remoteMargin: number;
    scoredWindows: Array<UnitEventRankerWindow & { score: number }>;
};

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

type ModelTree = {
    tree_structure: ModelTreeNode;
};

type ModelDump = {
    tree_info: ModelTree[];
};

type EventModel = {
    model: ModelDump;
    widthRisk: {
        threshold: number;
        model: ModelDump;
    };
    candidateModel?: ModelDump;
    refinement?: {
        maximumCenterDistance: number;
        minimumSafety: number;
        centerClampYears: number;
        wideCenterPullYears: number;
    };
};

type UnitEventWindowRankerModel = {
    windowWidth: number;
    profileNames: string[];
    sourceNames: string[];
    eventTypes: Record<UnitEventWindowType, EventModel>;
};

const MODEL = modelData as unknown as UnitEventWindowRankerModel;

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
    if (lower === upper) return ordered[lower] ?? 0;
    const weight = position - lower;
    return (ordered[lower] ?? 0) * (1 - weight)
        + (ordered[upper] ?? 0) * weight;
};

const standardDeviation = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    const average = mean(values);
    return Math.sqrt(mean(values.map((value) => (
        (value - average) ** 2
    ))));
};

const overlap = (
    left: UnitEventRankerWindow,
    right: UnitEventRankerWindow,
): number => {
    const intersection = Math.max(
        0,
        Math.min(left.endYear, right.endYear)
            - Math.max(left.startYear, right.startYear)
            + 1,
    );
    const union = Math.max(left.endYear, right.endYear)
        - Math.min(left.startYear, right.startYear)
        + 1;
    return intersection / Math.max(1, union);
};

const finite = (value: number | undefined): number => (
    Number.isFinite(value) ? value! : 0
);

type PreparedProfile = {
    values: number[];
    fullMean: number;
    peakIndex: number;
};

const prepareProfiles = (
    input: UnitEventWindowRankerInput,
): Map<string, PreparedProfile> => new Map(MODEL.profileNames.map((name) => {
    const source = input.ranks.get(name)
        ?? new Array(input.years.length).fill(0);
    const values = input.years.map((_, index) => (
        Math.fround(finite(source[index]))
    ));
    let peakIndex = 0;
    for (let index = 1; index < values.length; index += 1) {
        if (values[index] > values[peakIndex]) peakIndex = index;
    }
    return [name, {
        values,
        fullMean: mean(values),
        peakIndex,
    }];
}));

const profileFeatures = (
    profiles: ReadonlyMap<string, PreparedProfile>,
    startIndex: number,
): number[] => MODEL.profileNames.flatMap((profileName) => {
    const profile = profiles.get(profileName)!;
    const inside = Array.from(
        { length: MODEL.windowWidth },
        (_, offset) => profile.values[startIndex + offset] ?? 0,
    );
    const insideMean = mean(inside);
    return [
        insideMean,
        Math.max(0, ...inside),
        inside[Math.floor(MODEL.windowWidth / 2)] ?? 0,
        quantile(inside, 0.75),
        quantile(inside, 0.9),
        inside[0] ?? 0,
        inside[inside.length - 1] ?? 0,
        (inside[inside.length - 1] ?? 0) - (inside[0] ?? 0),
        insideMean - profile.fullMean,
        Number(
            profile.peakIndex >= startIndex
            && profile.peakIndex < startIndex + MODEL.windowWidth,
        ),
    ];
});

const candidateFeatures = (
    input: UnitEventWindowRankerInput,
    window: UnitEventRankerWindow,
): number[] => {
    const center = (window.startYear + window.endYear) / 2;
    const overlaps = input.internalCandidates.map((candidate) => (
        overlap(window, candidate)
    ));
    const containing = input.internalCandidates.filter((candidate) => (
        candidate.startYear <= center && center <= candidate.endYear
    ));
    const aggregate = containing.map((candidate) => (
        finite(candidate.aggregateScore)
    ));
    const consensus = containing.map((candidate) => (
        finite(candidate.overlapConsensus)
    ));
    const result = [
        Math.max(0, ...overlaps),
        mean(overlaps),
        overlaps.filter((value) => value >= 0.5).length,
        containing.length,
        Math.max(0, ...aggregate),
        mean(aggregate),
        Math.max(0, ...consensus),
        mean(consensus),
    ];
    MODEL.sourceNames.forEach((source) => {
        const matching = input.internalCandidates.filter((candidate) => (
            candidate.source === source
        ));
        result.push(
            Math.max(0, ...matching.map((candidate) => (
                overlap(window, candidate)
            ))),
            Number(matching.some((candidate) => (
                candidate.startYear <= center && center <= candidate.endYear
            ))),
        );
    });
    return result;
};

const anchorFeatures = (
    input: UnitEventWindowRankerInput,
    window: UnitEventRankerWindow,
): number[] => {
    const firstYear = input.years[0] ?? window.startYear;
    const lastYear = input.years[input.years.length - 1] ?? window.endYear;
    const span = Math.max(1, lastYear - firstYear);
    const center = (window.startYear + window.endYear) / 2;
    const operation = input.operationEvidence;
    const anchors = [
        input.currentPrimaryYear,
        operation?.bestYear,
        operation?.sideStepBestYear,
    ];
    const result: number[] = [];
    anchors.forEach((anchor) => {
        if (anchor === undefined) {
            result.push(1, 1, 0);
        } else {
            result.push(
                (center - anchor) / span,
                Math.abs(center - anchor) / span,
                Number(window.startYear <= anchor && anchor <= window.endYear),
            );
        }
    });
    result.push(
        finite(operation?.bestRawGain),
        finite(operation?.bestDifferenceGain),
        finite(operation?.bestCombinedGain),
        finite(operation?.topThreeDifferenceGain),
        finite(operation?.remoteDifferenceMargin),
        finite(operation?.bestSideStepScore),
        finite(operation?.topThreeSideStepScore),
        finite(operation?.sideStepRemoteMargin),
        (center - firstYear) / span,
        (window.startYear - firstYear) / span,
        (lastYear - window.endYear) / span,
    );
    return result;
};

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

const windowFeatures = (
    input: UnitEventWindowRankerInput,
    profiles: ReadonlyMap<string, PreparedProfile>,
    startIndex: number,
): number[] => {
    const startYear = input.years[startIndex];
    const window = {
        startYear,
        endYear: startYear + MODEL.windowWidth - 1,
    };
    return [
        ...profileFeatures(profiles, startIndex),
        ...candidateFeatures(input, window),
        ...anchorFeatures(input, window),
    ].map(Math.fround);
};

const scoreFeatures = (
    features: readonly number[],
    model: ModelDump,
): number => model.tree_info.reduce(
    (sum, tree) => sum + predictNode(tree.tree_structure, features),
    0,
);

const sigmoid = (value: number): number => {
    if (value >= 0) {
        const inverse = Math.exp(-value);
        return 1 / (1 + inverse);
    }
    const exponential = Math.exp(value);
    return exponential / (1 + exponential);
};

type PreparedWindow = UnitEventRankerWindow & {
    startIndex: number;
    features: number[];
};

type ScoredWindow = PreparedWindow & {
    score: number;
};

const sortByScore = (windows: readonly ScoredWindow[]): ScoredWindow[] => (
    windows.slice().sort((left, right) => (
        right.score - left.score || right.startYear - left.startYear
    ))
);

const centeredWindowStart = (
    input: UnitEventWindowRankerInput,
    centerYear: number | undefined,
): number => {
    const firstYear = input.years[0] ?? 0;
    const lastYear = input.years[input.years.length - 1] ?? firstYear;
    const center = centerYear ?? firstYear;
    return Math.max(
        firstYear,
        Math.min(
            Math.round(center) - Math.floor(MODEL.windowWidth / 2),
            lastYear - MODEL.windowWidth + 1,
        ),
    );
};

const profileMassWindowStart = (
    input: UnitEventWindowRankerInput,
    profileName: string,
): number | null => {
    const values = input.ranks.get(profileName);
    if (!values || values.length < MODEL.windowWidth) return null;
    let score = values.slice(0, MODEL.windowWidth).reduce(
        (sum, value) => sum + finite(value),
        0,
    );
    let bestScore = score;
    let bestIndex = 0;
    for (
        let index = 1;
        index <= values.length - MODEL.windowWidth;
        index += 1
    ) {
        score += finite(values[index + MODEL.windowWidth - 1])
            - finite(values[index - 1]);
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    }
    return input.years[bestIndex] ?? null;
};

const fusedMassWindowStart = (
    input: UnitEventWindowRankerInput,
    profileNames: readonly string[],
): number | null => {
    const profiles = profileNames.flatMap((name) => {
        const values = input.ranks.get(name);
        return values ? [values] : [];
    });
    if (profiles.length === 0) return null;
    const values = input.years.map((_, index) => mean(
        profiles.map((profile) => finite(profile[index])),
    ));
    let score = values.slice(0, MODEL.windowWidth).reduce(
        (sum, value) => sum + value,
        0,
    );
    let bestScore = score;
    let bestIndex = 0;
    for (
        let index = 1;
        index <= values.length - MODEL.windowWidth;
        index += 1
    ) {
        score += values[index + MODEL.windowWidth - 1]
            - values[index - 1];
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    }
    return input.years[bestIndex] ?? null;
};

const falseRingCandidateStarts = (
    input: UnitEventWindowRankerInput,
): Set<number> => {
    const starts = new Set<number>();
    MODEL.profileNames.forEach((profileName) => {
        const start = profileMassWindowStart(input, profileName);
        if (start !== null) starts.add(start);
    });
    const operation = input.operationEvidence;
    [
        input.currentPrimaryYear,
        operation?.bestYear,
        operation?.sideStepBestYear,
    ].forEach((year) => starts.add(centeredWindowStart(input, year)));
    input.internalCandidates.forEach((candidate) => starts.add(
        centeredWindowStart(
            input,
            (candidate.startYear + candidate.endYear) / 2,
        ),
    ));
    [
        [
            "differenceFull",
            "comboFull",
            "cumulativeCombined",
            "cumulativeDifference",
        ],
        [
            "differenceFull",
            "comboFull",
            "cumulativeCombined",
            "piecewiseCombinedObjective",
            "transitionSplitGain",
            "cumulativeReferenceMean",
        ],
    ].forEach((profileNames) => {
        const start = fusedMassWindowStart(input, profileNames);
        if (start !== null) starts.add(start);
    });
    return starts;
};

const scoreWindowSafety = (
    selected: ScoredWindow,
    scoredWindows: readonly ScoredWindow[],
    riskModel: ModelDump,
): number => {
    const remote = scoredWindows.find((candidate) => (
        candidate.endYear < selected.startYear
        || candidate.startYear > selected.endYear
    ));
    const chronological = scoredWindows
        .slice()
        .sort((left, right) => left.startIndex - right.startIndex);
    const selectedIndex = chronological.findIndex((candidate) => (
        candidate.startIndex === selected.startIndex
    ));
    const adjacentScores = chronological
        .slice(Math.max(0, selectedIndex - 2), selectedIndex + 3)
        .filter((candidate) => candidate.startIndex !== selected.startIndex)
        .map((candidate) => candidate.score);
    const allScores = chronological.map((candidate) => candidate.score);
    const maximumScore = Math.max(...allScores);
    const masses = allScores.map((score) => (
        Math.exp(Math.max(-30, Math.min(0, score - maximumScore)))
    ));
    const massTotal = Math.max(
        1e-12,
        masses.reduce((sum, mass) => sum + mass, 0),
    );
    const probabilities = masses.map((mass) => mass / massTotal);
    const entropy = -probabilities.reduce(
        (sum, probability) => sum + probability
            * Math.log(Math.max(probability, 1e-12)),
        0,
    ) / Math.max(1e-12, Math.log(Math.max(2, probabilities.length)));
    const adjacentMaximum = adjacentScores.length > 0
        ? Math.max(...adjacentScores)
        : selected.score;
    const q90 = quantile(allScores, 0.9);
    const riskFeatures = [
        ...selected.features,
        selected.score,
        selected.score - (scoredWindows[1]?.score ?? selected.score),
        selected.score - (remote?.score ?? selected.score),
        standardDeviation(allScores),
        q90,
        quantile(allScores, 0.75),
        selected.score - q90,
        adjacentMaximum,
        selected.score - adjacentMaximum,
        entropy,
        Math.max(...probabilities),
        selectedIndex / Math.max(1, chronological.length - 1),
    ].map(Math.fround);
    return sigmoid(scoreFeatures(riskFeatures, riskModel));
};

export const rankUnitEventWindows = (
    input: UnitEventWindowRankerInput,
): UnitEventWindowRankerResult | null => {
    if (
        input.years.length < MODEL.windowWidth
        || !MODEL.eventTypes[input.eventType]
    ) {
        return null;
    }
    const eventModel = MODEL.eventTypes[input.eventType];
    const profiles = prepareProfiles(input);
    const preparedWindows: PreparedWindow[] = input.years.flatMap((
        startYear,
        startIndex,
    ) => {
        const endYear = startYear + MODEL.windowWidth - 1;
        const lastYear = input.years[input.years.length - 1] ?? endYear;
        return startIndex + MODEL.windowWidth <= input.years.length
            && endYear <= lastYear
            ? [{
                    startYear,
                    endYear,
                    startIndex,
                    features: windowFeatures(input, profiles, startIndex),
                }]
            : [];
    });
    const fineWindows = sortByScore(preparedWindows.map((candidate) => ({
        ...candidate,
        score: scoreFeatures(candidate.features, eventModel.model),
    })));
    const fineSelected = fineWindows[0];
    if (!fineSelected) return null;
    const nineYearSafety = scoreWindowSafety(
        fineSelected,
        fineWindows,
        eventModel.widthRisk.model,
    );

    let selected = fineSelected;
    let scoredWindows = fineWindows;
    let recommendedWidth: 9 | 13 = (
        nineYearSafety >= eventModel.widthRisk.threshold ? 9 : 13
    );
    let widthThreshold = eventModel.widthRisk.threshold;
    let narrowCenter = (
        fineSelected.startYear + fineSelected.endYear
    ) / 2;
    let modeCenter = narrowCenter;

    if (
        input.eventType === "falseRing"
        && eventModel.candidateModel
        && eventModel.refinement
    ) {
        const candidateStarts = falseRingCandidateStarts(input);
        const candidateWindows = sortByScore(preparedWindows
            .filter((candidate) => candidateStarts.has(candidate.startYear))
            .map((candidate) => ({
                ...candidate,
                score: scoreFeatures(
                    candidate.features,
                    eventModel.candidateModel!,
                ),
            })));
        const candidateSelected = candidateWindows[0];
        if (candidateSelected) {
            selected = candidateSelected;
            scoredWindows = candidateWindows;
            const candidateCenter = (
                candidateSelected.startYear + candidateSelected.endYear
            ) / 2;
            const fineCenter = (
                fineSelected.startYear + fineSelected.endYear
            ) / 2;
            recommendedWidth = (
                nineYearSafety >= eventModel.refinement.minimumSafety
                && Math.abs(fineCenter - candidateCenter)
                    <= eventModel.refinement.maximumCenterDistance
            ) ? 9 : 13;
            widthThreshold = eventModel.refinement.minimumSafety;
            narrowCenter = Math.max(
                candidateCenter - eventModel.refinement.centerClampYears,
                Math.min(
                    fineCenter,
                    candidateCenter + eventModel.refinement.centerClampYears,
                ),
            );
            const deterministicStart = profileMassWindowStart(
                input,
                "differenceFull",
            );
            const deterministicCenter = deterministicStart === null
                ? candidateCenter
                : deterministicStart + Math.floor(MODEL.windowWidth / 2);
            const centerPull = Math.max(
                -eventModel.refinement.wideCenterPullYears,
                Math.min(
                    deterministicCenter - candidateCenter,
                    eventModel.refinement.wideCenterPullYears,
                ),
            );
            modeCenter = recommendedWidth === 9
                ? candidateCenter
                : candidateCenter + centerPull;
        }
    }

    const remote = scoredWindows.find((candidate) => (
        candidate.endYear < selected.startYear
        || candidate.startYear > selected.endYear
    ));
    const modeWindow = {
        startYear: modeCenter - Math.floor(MODEL.windowWidth / 2),
        endYear: modeCenter + Math.floor(MODEL.windowWidth / 2),
    };
    return {
        window: recommendedWidth === 9
            ? {
                    startYear: narrowCenter - 4,
                    endYear: narrowCenter + 4,
                }
            : modeWindow,
        modeWindow,
        recommendedWidth,
        nineYearSafety,
        widthThreshold,
        score: selected.score,
        margin: selected.score - (scoredWindows[1]?.score ?? selected.score),
        remoteMargin: selected.score - (remote?.score ?? selected.score),
        scoredWindows: scoredWindows.map((candidate) => ({
            startYear: candidate.startYear,
            endYear: candidate.endYear,
            score: candidate.score,
        })),
    };
};
