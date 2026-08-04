import type { DiagnosisEventType } from "./types";
import type { FalseRingCoarseCounterfactualRow } from "./falseRingCoarseCounterfactual";

type UnitEventType = Extract<
    DiagnosisEventType,
    "missingRing" | "falseRing"
>;

export type UnitEventYearRankingInput = {
    eventType: UnitEventType;
    years: readonly number[];
    fixedWindowYears?: readonly number[];
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
        fixedWindowProfiles?: ReadonlyMap<
            string,
            ReadonlyMap<number, number>
        >;
    };
    falseCounterfactualRows?: readonly FalseRingCoarseCounterfactualRow[];
};

export type UnitEventYearRankingResult = {
    scoreByYear: ReadonlyMap<number, number>;
    profileNames: string[];
    preEventPolicyScoreByYear?: ReadonlyMap<number, number>;
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

const FALSE_RING_EXACT_PROFILES = [
    "differenceReferenceWeightedHuber31",
    "differenceReferencePeakKernel5",
    "differenceReferencePeakKernel9",
    "differenceReferenceRankMean31",
] as const;

const MISSING_FIXED_WINDOW_PROFILES = [
    "rawMasterRFixedWindow",
    "rawMasterRFixedWindowPlus4",
    "rawMasterRFixedWindowPlus12",
    "differenceMasterRFixedWindow",
    "differenceMasterRFixedWindowPlus4",
    "differenceMasterRFixedWindowPlus12",
    "differenceMasterHuberFixedWindow",
    "differenceMasterHuberFixedWindowPlus4",
    "differenceMasterHuberFixedWindowPlus12",
    "differencePredictiveWeightedHuberFixedWindow",
    "differencePredictiveWeightedHuberFixedWindowPlus4",
    "differencePredictiveWeightedHuberFixedWindowPlus12",
] as const;

const FALSE_PHYSICAL_PROFILE_NAMES = {
    directDifferenceR: "differenceMasterRFixedWindowPlus12",
    mergeDifferenceR: "falseMergeOlderDifferenceMasterRFixedWindowPlus12",
    directDifferenceHuber: "differenceMasterHuberFixedWindowPlus12",
    mergeDifferenceHuber:
        "falseMergeOlderDifferenceMasterHuberFixedWindowPlus12",
    directRawR: "rawMasterRFixedWindowPlus12",
    mergeRawR: "falseMergeOlderRawMasterRFixedWindowPlus12",
    widthMergeAdvantage: "falseWidthWeightedMergeAdvantage",
} as const;

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

const normalizedTopMargin = (
    years: readonly number[],
    scoreByYear: ReadonlyMap<number, number>,
): number => {
    const ranks = percentileRanks(years.map(
        (year) => scoreByYear.get(year) ?? 0,
    ));
    const order = rankedIndices(years, ranks);
    const topIndex = order[0];
    const runnerUpIndex = order[1] ?? topIndex;
    return ranks[topIndex] - ranks[runnerUpIndex];
};

const applyMissingFixedWindowPolicy = (
    years: readonly number[],
    baselineScoreByYear: ReadonlyMap<number, number>,
    profiles: ReadonlyMap<string, ReadonlyMap<number, number>> | undefined,
): UnitEventYearRankingResult | null => {
    if (!profiles || years.length === 0) return null;
    const primary = profiles.get("rawMasterRFixedWindow");
    if (!primary) return null;
    const baselineValues = years.map((year) => baselineScoreByYear.get(year));
    const evidenceValues = years.map((year) => primary.get(year));
    if (baselineValues.some((value) => value === undefined)
        || evidenceValues.some((value) => value === undefined)) {
        return null;
    }
    const baselineRanks = percentileRanks(baselineValues as number[]);
    const evidenceRanks = percentileRanks(evidenceValues as number[]);
    const policyScores = years.map((_, index) => (
        baselineRanks[index] * 0.25 + evidenceRanks[index] * 0.75
    ));
    const baselineOrder = rankedIndices(years, baselineRanks);
    const policyOrder = rankedIndices(years, policyScores);
    const baselineTop = baselineOrder[0];
    const policyTop = policyOrder[0];
    if (baselineTop === policyTop) return null;
    const candidateYear = years[policyTop];
    const fixedProfileVotes = MISSING_FIXED_WINDOW_PROFILES.reduce(
        (votes, profileName) => {
            const values = profiles.get(profileName);
            if (!values) return votes;
            const scores = years.map(
                (year) => values.get(year) ?? Number.NEGATIVE_INFINITY,
            );
            const topIndex = rankedIndices(years, scores)[0];
            return votes + (years[topIndex] === candidateYear ? 1 : 0);
        },
        0,
    );
    const baselineRunnerUp = baselineOrder[1] ?? baselineTop;
    const baselineMargin = baselineRanks[baselineTop]
        - baselineRanks[baselineRunnerUp];
    const passes = Math.abs(candidateYear - years[baselineTop]) <= 3
        && baselineMargin <= 0.125 + 1e-12
        && fixedProfileVotes >= 5;
    if (!passes) return null;
    const scoreByYear = new Map(baselineScoreByYear);
    years.forEach((year, index) => scoreByYear.set(year, policyScores[index]));
    return {
        scoreByYear,
        profileNames: [
            "rawMasterRFixedWindow",
            "missingFixedWindowConsensusVote",
            "missingFixedWindowExactYearGate",
        ],
    };
};

const applyFalseCounterfactualConsensusPolicy = (
    years: readonly number[],
    baselineScoreByYear: ReadonlyMap<number, number>,
    rows: readonly FalseRingCoarseCounterfactualRow[] | undefined,
    operationYear: number | undefined,
): UnitEventYearRankingResult | null => {
    if (!rows) return null;
    const rowByYear = new Map(rows.map((row) => [row.year, row]));
    const profileRanks = FALSE_RING_EXACT_PROFILES.map((profileName) => {
        const values = years.map(
            (year) => rowByYear.get(year)?.profiles[profileName],
        );
        return values.some((value) => value === undefined)
            ? null
            : percentileRanks(values as number[]);
    });
    if (profileRanks.some((ranks) => ranks === null)) return null;

    const operationExact = years.map(
        (year) => operationYear === year ? 1 : 0,
    );
    const policyScores = years.map((_, index) => mean([
        ...profileRanks.map((ranks) => ranks![index]),
        operationExact[index],
    ]));
    const baselineValues = years.map(
        (year) => baselineScoreByYear.get(year) ?? 0,
    );
    const baselineTopIndex = rankedIndices(years, baselineValues)[0];
    const policyTopIndex = rankedIndices(years, policyScores)[0];
    const epsilon = 1e-12;
    const passes = policyTopIndex !== baselineTopIndex
        && normalizedTopMargin(years, baselineScoreByYear)
            <= 0.1 + epsilon;
    return passes ? {
        scoreByYear: new Map(years.map((year, index) => [
            year,
            policyScores[index],
        ])),
        profileNames: [
            ...FALSE_RING_EXACT_PROFILES,
            "falseOperationExactAnchor",
            "falseCounterfactualConsensusGate",
        ],
    } : null;
};

const applyFalsePhysicalMergePolicy = (
    years: readonly number[],
    baselineScoreByYear: ReadonlyMap<number, number>,
    profiles: ReadonlyMap<string, ReadonlyMap<number, number>> | undefined,
    anchors: readonly (number | undefined)[],
): UnitEventYearRankingResult | null => {
    if (!profiles || years.length < 2) return null;
    const profile = (name: string) => profiles.get(name);
    const mergeDifferenceR = profile(
        FALSE_PHYSICAL_PROFILE_NAMES.mergeDifferenceR,
    );
    if (!mergeDifferenceR) return null;
    const mergeValues = years.map((year) => mergeDifferenceR.get(year));
    if (mergeValues.some((value) => value === undefined)) return null;
    const mergeOrder = rankedIndices(years, mergeValues as number[]);
    const candidateIndex = mergeOrder[0];
    const runnerUpIndex = mergeOrder[1] ?? candidateIndex;
    const candidateYear = years[candidateIndex];
    const baselineValues = years.map(
        (year) => baselineScoreByYear.get(year) ?? Number.NEGATIVE_INFINITY,
    );
    const baselineTopIndex = rankedIndices(years, baselineValues)[0];
    if (candidateYear === years[baselineTopIndex]) return null;

    const definedAnchors = anchors.filter(
        (year): year is number => year !== undefined,
    );
    if (definedAnchors.length === 0) return null;
    const anchorCounts = new Map<number, number>();
    definedAnchors.forEach((year) => anchorCounts.set(
        year,
        (anchorCounts.get(year) ?? 0) + 1,
    ));
    if ([...anchorCounts].some(
        ([year, count]) => year !== candidateYear && count >= 2,
    )) {
        return null;
    }
    const hasExactAnchor = anchorCounts.has(candidateYear);
    const mergeMargin = (mergeValues[candidateIndex] as number)
        - (mergeValues[runnerUpIndex] as number);
    if (!hasExactAnchor && mergeMargin < 0.01 - 1e-12) return null;
    if (Math.abs(candidateYear - years[baselineTopIndex]) > 5) return null;
    const currentPrimaryYear = anchors[0];
    if (candidateYear > years[baselineTopIndex]
        && (currentPrimaryYear === undefined
            || Math.abs(candidateYear - currentPrimaryYear) > 1)) {
        return null;
    }
    const nearestAnchorDistance = Math.min(...definedAnchors.map(
        (year) => Math.abs(year - candidateYear),
    ));
    if (nearestAnchorDistance > 1) return null;

    const candidateValue = (name: string): number | undefined => (
        profile(name)?.get(candidateYear)
    );
    const directDifferenceR = candidateValue(
        FALSE_PHYSICAL_PROFILE_NAMES.directDifferenceR,
    );
    const directDifferenceHuber = candidateValue(
        FALSE_PHYSICAL_PROFILE_NAMES.directDifferenceHuber,
    );
    const mergeDifferenceHuber = candidateValue(
        FALSE_PHYSICAL_PROFILE_NAMES.mergeDifferenceHuber,
    );
    const directRawR = candidateValue(
        FALSE_PHYSICAL_PROFILE_NAMES.directRawR,
    );
    const mergeRawR = candidateValue(
        FALSE_PHYSICAL_PROFILE_NAMES.mergeRawR,
    );
    const widthMergeAdvantage = candidateValue(
        FALSE_PHYSICAL_PROFILE_NAMES.widthMergeAdvantage,
    );
    const requiredValues = [
        directDifferenceR,
        mergeDifferenceHuber,
        directDifferenceHuber,
        mergeRawR,
        directRawR,
        widthMergeAdvantage,
    ];
    if (requiredValues.some(
        (value) => value === undefined || !Number.isFinite(value),
    )) {
        return null;
    }
    const passes = (mergeValues[candidateIndex] as number)
            - directDifferenceR! >= -1e-12
        && mergeDifferenceHuber! - directDifferenceHuber! >= -0.015 - 1e-12
        && mergeRawR! - directRawR! >= -0.005 - 1e-12
        && widthMergeAdvantage! >= -0.5 - 1e-12;
    if (!passes) return null;

    const scoreByYear = new Map(baselineScoreByYear);
    const maximum = Math.max(...baselineValues.filter(Number.isFinite));
    scoreByYear.set(candidateYear, maximum + 1);
    return {
        scoreByYear,
        profileNames: [
            ...Object.values(FALSE_PHYSICAL_PROFILE_NAMES),
            "falsePhysicalMergeConsensusGate",
        ],
    };
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

    let ranked = baseline;
    const supportingProfile = input.eventType === "missingRing"
        ? "cumulativeDifference"
        : "cumulativeReferenceVote";
    const supporting = input.ranks.get(supportingProfile);
    if (input.exactYearEvidence && supporting) {
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
        if (policyScores) {
            ranked = {
                scoreByYear: policyScores,
                profileNames: [
                    ...baseline.profileNames,
                    input.exactYearEvidence.profileName,
                    `${supportingProfile}:exactYearSupport`,
                    "adjacentExactYearGate",
                ],
            };
        }
    }

    const preFixedWindowRanking = ranked;
    const missingFixedWindowPolicy = input.eventType === "missingRing"
        ? applyMissingFixedWindowPolicy(
            input.fixedWindowYears ?? input.years,
            ranked.scoreByYear,
            input.exactYearEvidence?.fixedWindowProfiles,
        )
        : null;
    if (missingFixedWindowPolicy) {
        ranked = {
            scoreByYear: missingFixedWindowPolicy.scoreByYear,
            profileNames: [
                ...ranked.profileNames,
                ...missingFixedWindowPolicy.profileNames,
            ],
        };
    }

    const preEventPolicyScoreByYear = ranked.scoreByYear;
    const eventSpecificPolicy = input.eventType === "falseRing"
        ? applyFalseCounterfactualConsensusPolicy(
            input.years,
            ranked.scoreByYear,
            input.falseCounterfactualRows,
            input.operationEvidence?.bestYear,
        )
        : null;
    if (eventSpecificPolicy) {
        ranked = {
            scoreByYear: eventSpecificPolicy.scoreByYear,
            profileNames: [
                ...ranked.profileNames,
                ...eventSpecificPolicy.profileNames,
            ],
        };
    }
    const falsePhysicalPolicy = input.eventType === "falseRing"
        ? applyFalsePhysicalMergePolicy(
            input.years,
            ranked.scoreByYear,
            input.exactYearEvidence?.fixedWindowProfiles,
            [
                input.currentPrimaryYear,
                input.operationEvidence?.bestYear,
                input.operationEvidence?.sideStepBestYear,
            ],
        )
        : null;
    if (falsePhysicalPolicy) {
        ranked = {
            scoreByYear: falsePhysicalPolicy.scoreByYear,
            profileNames: [
                ...ranked.profileNames,
                ...falsePhysicalPolicy.profileNames,
            ],
        };
    }
    return {
        ...ranked,
        preEventPolicyScoreByYear: input.eventType === "falseRing"
            ? preEventPolicyScoreByYear
            : missingFixedWindowPolicy
                ? preFixedWindowRanking.scoreByYear
                : ranked.scoreByYear,
    };
};
