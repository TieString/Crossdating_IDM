/** File-grouped coarse-window selector for unit missing- and false-ring events. */
import modelData from "./unitEventCoarseWindowModel.json";

export type UnitEventCoarseType = "missingRing" | "falseRing";

export type UnitEventCoarseCandidate = {
    startYear: number;
    endYear: number;
    source: string;
    score?: number;
    aggregateScore: number;
    overlapConsensus: number;
};

export type UnitEventCoarseOperationEvidence = {
    bestYear: number;
    sideStepBestYear?: number;
};

export type UnitEventCoarseSelectorInput = {
    eventType: UnitEventCoarseType;
    years: readonly number[];
    ranks: ReadonlyMap<string, readonly number[]>;
    candidates: readonly UnitEventCoarseCandidate[];
    currentPrimaryYear?: number;
    operationEvidence?: UnitEventCoarseOperationEvidence;
};

export type UnitEventCoarseSelectorResult = {
    index: number;
    score: number;
    margin: number;
    scoredCandidates: Array<{ index: number; score: number }>;
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

type EventModel = {
    featureNames: string[];
    profiles: string[];
    expansionYears: number;
    model: { tree_info: Array<{ tree_structure: ModelTreeNode }> };
};

type ModelBundle = {
    eventTypes: Record<UnitEventCoarseType, EventModel>;
};

const MODEL = modelData as unknown as ModelBundle;

const SOURCE_NAMES = [
    "current_event",
    "joint_counterfactual_operation",
    "lag_transition",
    "profile:cumulativeCombined",
    "profile:differenceFull",
    "reference_transition:rankMean",
    "reference_transition:rankMedian",
    "reference_transition:weightedRankMean",
    "reference_transition:peakKernel5",
    "reference_transition:peakKernel9",
    "reference_transition:peakKernel13",
    "reference_transition:windowVote25",
    "reference_transition:weightedWindowVote25",
] as const;

const FAMILIES = [
    "current",
    "operation",
    "lag",
    "profile",
    "reference",
    "other",
] as const;

const finite = (value: number | undefined): number => (
    Number.isFinite(value) ? value! : 0
);

const mean = (values: readonly number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

const standardDeviation = (values: readonly number[]): number => {
    const average = mean(values);
    return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
};

const median = (values: readonly number[]): number => {
    const ordered = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2
        ? ordered[middle] ?? 0
        : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
};

const percentileRanks = (values: readonly number[]): number[] => {
    if (values.length <= 1) return values.map(() => 0.5);
    const order = values.map((_, index) => index).sort((left, right) => (
        (values[left] ?? 0) - (values[right] ?? 0) || left - right
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

const maximumIndex = (values: readonly number[]): number => {
    let selected = 0;
    for (let index = 1; index < values.length; index += 1) {
        if ((values[index] ?? 0) > (values[selected] ?? 0)) selected = index;
    }
    return selected;
};

const sourceFamily = (source: string): typeof FAMILIES[number] => {
    if (source === "current_event") return "current";
    if (source === "joint_counterfactual_operation") return "operation";
    if (source === "lag_transition") return "lag";
    if (source.startsWith("profile:")) return "profile";
    if (source.startsWith("reference_transition:")) return "reference";
    return "other";
};

const windowOverlap = (
    left: Pick<UnitEventCoarseCandidate, "startYear" | "endYear">,
    right: Pick<UnitEventCoarseCandidate, "startYear" | "endYear">,
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
    model: EventModel,
    features: readonly number[],
): number => model.model.tree_info.reduce((score, tree) => (
    score + predictNode(tree.tree_structure, features)
), 0);

export const buildUnitEventCoarseCandidateFeatures = (
    input: UnitEventCoarseSelectorInput,
): number[][] => {
    const model = MODEL.eventTypes[input.eventType];
    const candidates = input.candidates;
    if (!model || candidates.length === 0) return [];
    const centers = candidates.map((candidate) => (
        (candidate.startYear + candidate.endYear) / 2
    ));
    const orderedCenters = centers.slice().sort((left, right) => left - right);
    const centerMedian = median(centers);
    const centerMean = mean(centers);
    const scale = Math.max(
        1,
        Math.max(...centers) - Math.min(...centers),
    );
    const aggregate = candidates.map((candidate) => finite(
        candidate.aggregateScore,
    ));
    const overlap = candidates.map((candidate) => finite(
        candidate.overlapConsensus,
    ));
    const rawPresent = candidates.map((candidate) => Number.isFinite(
        candidate.score,
    ));
    const raw = candidates.map((candidate) => finite(candidate.score));
    const rawMinimum = Math.min(...raw);
    const rawRankSource = raw.map((value, index) => (
        rawPresent[index] ? value : rawMinimum
    ));
    const aggregateRanks = percentileRanks(aggregate);
    const overlapRanks = percentileRanks(overlap);
    const rawRanks = percentileRanks(rawRankSource);
    const presentRaw = raw.filter((_, index) => rawPresent[index]);
    const rawMean = mean(presentRaw);
    const rawDeviation = Math.max(1e-8, standardDeviation(presentRaw));
    const yearIndexes = new Map(input.years.map((year, index) => [year, index]));
    const profileValues = new Map(model.profiles.map((profile) => [
        profile,
        (input.ranks.get(profile) ?? []).map(finite),
    ]));
    const profilePeakYears = new Map(model.profiles.map((profile) => {
        const values = profileValues.get(profile) ?? [];
        return [
            profile,
            input.years[maximumIndex(values)] ?? input.years[0] ?? 0,
        ];
    }));
    const anchors = {
        current: input.currentPrimaryYear,
        operation: input.operationEvidence?.bestYear,
        side: input.operationEvidence?.sideStepBestYear,
    } as const;

    return candidates.map((candidate, candidateIndex) => {
        const center = centers[candidateIndex] ?? 0;
        const values: Record<string, number> = {
            aggregateScore: aggregate[candidateIndex] ?? 0,
            aggregateRank: aggregateRanks[candidateIndex] ?? 0,
            overlapConsensus: overlap[candidateIndex] ?? 0,
            overlapRank: overlapRanks[candidateIndex] ?? 0,
            rawScorePresent: Number(rawPresent[candidateIndex]),
            rawScoreRank: rawRanks[candidateIndex] ?? 0,
            rawScoreZ: rawPresent[candidateIndex]
                ? ((raw[candidateIndex] ?? 0) - rawMean) / rawDeviation
                : 0,
            centerMedianSigned: (center - centerMedian) / scale,
            centerMedianDistance: Math.abs(center - centerMedian) / scale,
            centerMeanSigned: (center - centerMean) / scale,
            agreement2: mean(centers.map((other) => Number(
                Math.abs(center - other) <= 2,
            ))),
            agreement4: mean(centers.map((other) => Number(
                Math.abs(center - other) <= 4,
            ))),
            agreement8: mean(centers.map((other) => Number(
                Math.abs(center - other) <= 8,
            ))),
            agreement12: mean(centers.map((other) => Number(
                Math.abs(center - other) <= 12,
            ))),
            meanWindowOverlap: mean(candidates.map((other) => (
                windowOverlap(candidate, other)
            ))),
            maximumWindowOverlap: Math.max(...candidates.map((other) => (
                windowOverlap(candidate, other)
            ))),
            chronologicalPosition: orderedCenters.indexOf(center)
                / Math.max(1, orderedCenters.length - 1),
        };
        Object.entries(anchors).forEach(([name, anchor]) => {
            values[`${name}Signed`] = anchor === undefined
                ? 0
                : (center - anchor) / scale;
            values[`${name}Distance`] = anchor === undefined
                ? 1
                : Math.abs(center - anchor) / scale;
            values[`contains${name[0].toUpperCase()}${name.slice(1)}`] = Number(
                anchor !== undefined
                && candidate.startYear <= anchor
                && anchor <= candidate.endYear,
            );
        });
        SOURCE_NAMES.forEach((source) => {
            values[`source:${source}`] = Number(candidate.source === source);
        });
        const family = sourceFamily(candidate.source);
        FAMILIES.forEach((name) => {
            values[`family:${name}`] = Number(family === name);
        });
        model.profiles.forEach((profile) => {
            const source = profileValues.get(profile) ?? [];
            const inside: number[] = [];
            for (
                let year = candidate.startYear;
                year <= candidate.endYear;
                year += 1
            ) {
                const index = yearIndexes.get(year);
                if (index !== undefined && index < source.length) {
                    inside.push(source[index] ?? 0);
                }
            }
            const centerIndex = yearIndexes.get(Math.round(center));
            values[`profile:${profile}:mean`] = mean(inside);
            values[`profile:${profile}:maximum`] = Math.max(0, ...inside);
            values[`profile:${profile}:center`] = centerIndex === undefined
                ? 0
                : source[centerIndex] ?? 0;
            values[`profile:${profile}:peakDistance`] = Math.abs(
                center - (profilePeakYears.get(profile) ?? center),
            ) / scale;
        });
        const unavailable = model.featureNames.filter((name) => (
            values[name] === undefined
        ));
        if (unavailable.length > 0) {
            throw new Error(
                `Unit-event coarse features unavailable: ${unavailable.join(",")}`,
            );
        }
        return model.featureNames.map((name) => Math.fround(values[name] ?? 0));
    });
};

export const selectUnitEventCoarseWindow = (
    input: UnitEventCoarseSelectorInput,
): UnitEventCoarseSelectorResult | null => {
    const model = MODEL.eventTypes[input.eventType];
    if (!model || input.candidates.length === 0) return null;
    const features = buildUnitEventCoarseCandidateFeatures(input);
    const scoredCandidates = features.map((row, index) => ({
        index,
        score: scoreFeatures(model, row),
    })).sort((left, right) => right.score - left.score || left.index - right.index);
    const selected = scoredCandidates[0];
    if (!selected) return null;
    return {
        index: selected.index,
        score: selected.score,
        margin: selected.score - (scoredCandidates[1]?.score ?? selected.score),
        scoredCandidates,
    };
};
