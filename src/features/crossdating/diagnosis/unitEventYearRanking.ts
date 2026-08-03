import type { DiagnosisEventType } from "./types";

type UnitEventType = Extract<
    DiagnosisEventType,
    "missingRing" | "falseRing"
>;

export type UnitEventYearRankingInput = {
    eventType: UnitEventType;
    years: readonly number[];
    allYears: readonly number[];
    ranks: ReadonlyMap<string, readonly number[]>;
    currentPrimaryYear?: number;
    operationEvidence?: {
        bestYear: number;
        sideStepBestYear: number;
    };
    localCorrectionRanking?: {
        rankByYear: ReadonlyMap<number, number>;
        profileName: string;
    };
    exactYearEvidence?: {
        scoreByYear: ReadonlyMap<number, number>;
        profileName: string;
    };
};

export type UnitEventYearRankingResult = {
    scoreByYear: ReadonlyMap<number, number>;
    profileNames: string[];
};

const MISSING_RING_PROFILES = [
    "cumulativeReferenceVote",
    "comboFull",
    "piecewiseCombinedObjective",
] as const;

const MISSING_RING_BASELINE_CONSENSUS_PROFILES = [
    "cumulativeReferenceVote",
    "comboFull",
    "piecewiseCombinedObjective",
    "cumulativeDifference",
    "differenceFull",
    "rawFull",
    "whitenedFull",
    "transitionSplitGain",
    "cumulativeReferenceMean",
    "cumulativeReferenceMedian",
] as const;

const mean = (values: readonly number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

const median = (values: readonly number[]): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

const percentileRanks = (values: readonly number[]): number[] => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const result = Array<number>(values.length).fill(0);
    let start = 0;
    while (start < ordered.length) {
        let end = start + 1;
        while (end < ordered.length
            && ordered[end].value === ordered[start].value) {
            end += 1;
        }
        const rank = values.length <= 1
            ? 0.5
            : (start + end - 1) / (2 * (values.length - 1));
        for (let offset = start; offset < end; offset += 1) {
            result[ordered[offset].index] = rank;
        }
        start = end;
    }
    return result;
};

const shiftedRanks = (
    values: readonly number[],
    shift: number,
): number[] => {
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const floor = minimum - Math.max(1, Math.abs(maximum - minimum));
    return percentileRanks(values.map((_, index) => {
        const sourceIndex = index - shift;
        return sourceIndex >= 0 && sourceIndex < values.length
            ? values[sourceIndex]
            : floor;
    }));
};

const rankedIndices = (
    years: readonly number[],
    scores: readonly number[],
): number[] => years
    .map((_, index) => index)
    .sort((left, right) => scores[right] - scores[left] || years[right] - years[left]);

const countProfilePeaksAtYear = (
    profileNames: readonly string[],
    ranks: ReadonlyMap<string, readonly number[]>,
    years: readonly number[],
    sourceIndices: readonly number[],
    targetYear: number,
): number => profileNames.reduce((count, profileName) => {
    const profile = ranks.get(profileName);
    if (!profile) return count;
    const peakIndex = rankedIndices(
        years,
        sourceIndices.map((index) => profile[index] ?? Number.NEGATIVE_INFINITY),
    )[0];
    return count + (years[peakIndex] === targetYear ? 1 : 0);
}, 0);

const applyExactYearPolicy = (
    eventType: UnitEventType,
    years: readonly number[],
    baselineScoreByYear: ReadonlyMap<number, number>,
    evidenceScoreByYear: ReadonlyMap<number, number>,
    supportingValues: readonly number[],
    baselineConsensusSupport: number,
): ReadonlyMap<number, number> | null => {
    const baselineValues = years.map((year) => baselineScoreByYear.get(year) ?? 0);
    const evidenceValues = years.map((year) => evidenceScoreByYear.get(year));
    if (evidenceValues.some((value) => value === undefined)) return null;
    const baselineRanks = percentileRanks(baselineValues);
    const evidenceRanks = percentileRanks(evidenceValues as number[]);
    const supportingRanks = shiftedRanks(
        supportingValues,
        eventType === "missingRing" ? -1 : 0,
    );
    const policyScores = years.map((_, index) => eventType === "missingRing"
        ? baselineRanks[index] * 0.5
            + evidenceRanks[index] * 0.3
            + supportingRanks[index] * 0.2
        : baselineRanks[index] * 0.3
            + evidenceRanks[index] * 0.5
            + supportingRanks[index] * 0.2);
    const baselineOrder = rankedIndices(years, baselineRanks);
    const policyOrder = rankedIndices(years, policyScores);
    const baselineTop = baselineOrder[0];
    const policyTop = policyOrder[0];
    if (baselineTop === policyTop) return null;
    if (eventType === "missingRing" && baselineConsensusSupport >= 6) {
        return null;
    }
    const baselineMargin = baselineRanks[baselineTop]
        - baselineRanks[baselineOrder[1] ?? baselineTop];
    const policyMargin = policyScores[policyTop]
        - policyScores[policyOrder[1] ?? policyTop];
    const topAdvantage = policyScores[policyTop] - policyScores[baselineTop];
    const epsilon = 1e-12;
    const passes = Math.abs(years[policyTop] - years[baselineTop]) <= 1
        && policyMargin + epsilon >= (eventType === "missingRing" ? 0.05 : 0.025)
        && baselineMargin <= (eventType === "missingRing" ? 0.15 : 1) + epsilon
        && topAdvantage + epsilon >= (eventType === "missingRing" ? 0.05 : 0.025);
    return passes
        ? new Map(years.map((year, index) => [year, policyScores[index]]))
        : null;
};

export const rankUnitEventYears = (
    input: UnitEventYearRankingInput,
): UnitEventYearRankingResult | null => {
    if (input.years.length === 0) return null;
    const sourceIndices = input.years.map(
        (year) => input.allYears.indexOf(year),
    );
    if (sourceIndices.some((index) => index < 0)) return null;

    let baseline: UnitEventYearRankingResult;
    if (input.eventType === "missingRing") {
        if (!MISSING_RING_PROFILES.every((profile) => input.ranks.has(profile))) {
            return null;
        }
        const anchorMedian = median([
            input.currentPrimaryYear,
            input.operationEvidence?.bestYear,
            input.operationEvidence?.sideStepBestYear,
        ].filter((value): value is number => value !== undefined));
        const anchorScale = Math.max(1, input.years.length - 1);
        baseline = {
            scoreByYear: new Map(input.years.map((year, index) => {
                const baseline = mean(MISSING_RING_PROFILES.map((profile) => (
                    input.ranks.get(profile)?.[sourceIndices[index]] ?? 0
                )));
                const anchorPrior = anchorMedian === null
                    ? 0
                    : -Math.abs(year - anchorMedian) / anchorScale;
                const localCorrection = input.localCorrectionRanking
                    ?.rankByYear.get(year) ?? 0;
                return [
                    year,
                    baseline + anchorPrior * 0.02 + localCorrection * 0.02,
                ];
            })),
            profileNames: [
                ...MISSING_RING_PROFILES,
                ...(anchorMedian === null ? [] : ["missingAnchorMedian"]),
                ...(input.localCorrectionRanking
                    ? [input.localCorrectionRanking.profileName]
                    : []),
            ],
        };
    } else {
        const difference = input.ranks.get("differenceFull");
        if (!difference) return null;
        baseline = {
            scoreByYear: new Map(input.years.map((year, index) => [
                year,
                difference[sourceIndices[index]] ?? 0,
            ])),
            profileNames: ["differenceFull"],
        };
    }

    const supportingProfile = input.eventType === "missingRing"
        ? "cumulativeDifference"
        : "cumulativeReferenceVote";
    const supporting = input.ranks.get(supportingProfile);
    if (!input.exactYearEvidence || !supporting) return baseline;
    const baselineTopYear = [...baseline.scoreByYear.entries()].sort(
        (left, right) => right[1] - left[1] || right[0] - left[0],
    )[0][0];
    const baselineConsensusSupport = input.eventType === "missingRing"
        ? countProfilePeaksAtYear(
            MISSING_RING_BASELINE_CONSENSUS_PROFILES,
            input.ranks,
            input.years,
            sourceIndices,
            baselineTopYear,
        )
        : 0;
    const policyScores = applyExactYearPolicy(
        input.eventType,
        input.years,
        baseline.scoreByYear,
        input.exactYearEvidence.scoreByYear,
        sourceIndices.map((index) => supporting[index] ?? 0),
        baselineConsensusSupport,
    );
    return policyScores ? {
        scoreByYear: policyScores,
        profileNames: [
            ...baseline.profileNames,
            input.exactYearEvidence.profileName,
            `${supportingProfile}:exactYearSupport`,
            "adjacentExactYearGate",
        ],
    } : baseline;
};
