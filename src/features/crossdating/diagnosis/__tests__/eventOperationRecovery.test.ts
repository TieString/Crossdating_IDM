import { describe, expect, it } from "vitest";
import {
    addTransitionLocationAlternatives,
    buildDualSignalLocationChoices,
    DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG,
    fuseDecisiveJointOperationScores,
    partitionVerifiedRecoveryHypotheses,
    recoverSubtleFalseRingEmptySuggestion,
    rerankEventYearsByAnchorConsensus,
    rerankMissingRingByAnchorConsensus,
    selectDecisiveJointOperationFusion,
    selectSubtleFalseRingEmptyRecovery,
} from "../eventOperationRecovery";
import type { JointCounterfactualOperationScore } from "../jointCounterfactualOperation";
import type {
    GainGatedRecoveryAnalysis,
    GainGatedRecoveryHypothesis,
} from "../gainGatedEventRecovery";
import { verificationLocationCountForHypothesis } from "../gainGatedEventRecovery";
import type { CumulativeLagChangePointScore } from "../cumulativeLagChangePoint";
import type { PiecewiseChangePointScore } from "../piecewiseChangePoint";
import type {
    DiagnosisEvent,
    DiagnosisEventLocationAlternative,
    SeriesCoreDiagnosis,
} from "../types";

const cumulative = (
    year: number,
    olderLag: number,
    values: Partial<CumulativeLagChangePointScore>,
): CumulativeLagChangePointScore => ({
    year,
    olderLag,
    combinedCumulative: 0,
    combinedCusum: 0,
    combinedContrast: 0,
    combinedLocal31: 0,
    combinedLocal61: 0,
    rawCumulative: 0,
    rawCusum: 0,
    rawContrast: 0,
    differenceCumulative: 0,
    differenceCusum: 0,
    differenceContrast: 0,
    whitenedCumulative: 0,
    whitenedCusum: 0,
    whitenedContrast: 0,
    cofechaCumulative: 0,
    cofechaCusum: 0,
    cofechaContrast: 0,
    referenceMedianCumulative: 0,
    referenceMedianCusum: 0,
    referenceMedianContrast: 0,
    referenceMeanCumulative: 0,
    referenceMeanCusum: 0,
    referenceMeanContrast: 0,
    referenceVoteCumulative: 0,
    referenceVoteCusum: 0,
    referenceVoteContrast: 0,
    ...values,
});

const piecewise = (
    year: number,
    olderLag: number,
    values: Partial<PiecewiseChangePointScore>,
): PiecewiseChangePointScore => ({
    year,
    olderLag,
    combinedObjective: 0,
    combinedGain: 0,
    rawObjective: 0,
    cofechaObjective: 0,
    whitenedObjective: 0,
    differenceObjective: 0,
    rawGain: 0,
    cofechaGain: 0,
    whitenedGain: 0,
    differenceGain: 0,
    olderPairs: 40,
    newerPairs: 40,
    ...values,
});

const diagnosis = {
    targetRange: { startYear: 1800, endYear: 2000 },
} as SeriesCoreDiagnosis;

const analysis = (
    cumulativeScores: CumulativeLagChangePointScore[],
    piecewiseScores: PiecewiseChangePointScore[],
): GainGatedRecoveryAnalysis => ({
    hypotheses: [],
    cumulativeScores,
    piecewiseScores,
});

const ranked = (startYear: number, endYear: number) => Array.from(
    { length: endYear - startYear + 1 },
    (_, index) => ({
        year: startYear + index,
        rank: index + 1,
        score: endYear - index,
        evidenceTags: ["test"],
    }),
);

const location = (
    rank: number,
    startYear: number,
    endYear: number,
): DiagnosisEventLocationAlternative => ({
    rank,
    startYear,
    endYear,
    rankedYears: ranked(startYear, endYear),
    evidenceScore: 1,
    scoreMargin: 0.1,
    algorithmSource: "test_location",
});

const event = (
    startYear: number,
    endYear: number,
    locations: DiagnosisEventLocationAlternative[] = [],
    notes: string[] = [],
    sources: string[] = [],
): DiagnosisEvent => ({
    id: "test-missing",
    seriesId: "TEST",
    eventType: "missingRing",
    startYear,
    endYear,
    rankedYears: ranked(startYear, endYear),
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: sources,
        score: 1,
        scoreMargin: 0.1,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.4,
        correlationGain: 0.2,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 100,
        candidateIds: [],
        notes,
    },
    alternativeTypes: [],
    locationAlternatives: locations,
});

const missingHypothesis: GainGatedRecoveryHypothesis = {
    eventType: "missingRing",
    shiftYears: -1,
    gateYear: 1900,
    combinedGain: 1,
    rawGain: 1,
    cofechaGain: 1,
    whitenedGain: 1,
    differenceGain: 1,
    combinedObjective: 1,
    locations: [],
};

const jointOperation = (
    shiftYears: number,
    score: number,
    bestYear = 1904,
    overrides: Partial<JointCounterfactualOperationScore> = {},
): JointCounterfactualOperationScore => ({
    eventType: shiftYears === -1
        ? "missingRing"
        : shiftYears === 1
            ? "falseRing"
            : "partialMove",
    shiftYears,
    bestYear,
    bestRawGain: score,
    bestDifferenceGain: score,
    bestCombinedGain: score,
    topThreeDifferenceGain: score,
    remoteDifferenceMargin: score / 10,
    sideStepBestYear: bestYear,
    bestSideStepScore: score,
    topThreeSideStepScore: score,
    bestSideMinimumAdvantage: score,
    bestCorrectedSideSupport: score,
    sideStepRemoteMargin: score / 10,
    baselineLag: 0,
    rows: [{
        year: bestYear,
        sideStepScore: score,
        differenceGain: score,
        combinedGain: score,
    }] as JointCounterfactualOperationScore["rows"],
    ...overrides,
});

const partialEvent = (
    shiftYears: number,
    startYear = 1900,
    endYear = 1908,
): DiagnosisEvent => ({
    ...event(startYear, endYear),
    id: `test-partial-${shiftYears}`,
    eventType: "partialMove",
    shiftYears,
    shiftSide: "older",
});

describe("dual-signal event locations", () => {
    it("spends the full location budget only on the two decision hypotheses", () => {
        const config = DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG;
        expect(config.emptyEventFallbackMinimumGain).toBe(0.03);
        const options = {
            fullVerificationHypothesisCount: config.primaryDecisionHypothesisCount,
            verificationLocationCount: config.verificationLocationCount,
            supplementalVerificationLocationCount:
                config.supplementalVerificationLocationCount,
        };

        expect([0, 1, 2].map((index) => (
            verificationLocationCountForHypothesis(index, options)
        ))).toEqual([2, 2, 1]);
    });

    it("keeps a third verified hypothesis supplemental even when it scores highest", () => {
        const verified = (
            eventType: GainGatedRecoveryHypothesis["eventType"],
            shiftYears: number,
            combinedGain: number,
            verificationGain: number,
        ): GainGatedRecoveryHypothesis => ({
            ...missingHypothesis,
            eventType,
            shiftYears,
            combinedGain,
            locationVerification: [{
                year: 1900,
                rawGain: verificationGain,
                differenceGain: verificationGain,
                whitenedGain: verificationGain,
                combinedGain: verificationGain,
            }],
        });
        const result = partitionVerifiedRecoveryHypotheses([
            verified("missingRing", -1, 0.3, 0.2),
            verified("falseRing", 1, 0.2, 0.3),
            verified("partialMove", -2, 0.9, 0.9),
        ], 2);

        expect(result.decisionPool.map(({ hypothesis }) => hypothesis.eventType)).toEqual([
            "falseRing",
            "missingRing",
        ]);
        expect(result.supplementalPool.map(({ hypothesis }) => hypothesis.eventType)).toEqual([
            "partialMove",
        ]);
    });

    it("uses cumulative difference and piecewise gain for missing-ring backups", () => {
        const result = buildDualSignalLocationChoices(
            "missingRing",
            -1,
            analysis(
                [
                    cumulative(1903, -1, { differenceCumulative: 30 }),
                    cumulative(1930, -1, { differenceCumulative: 20 }),
                ],
                [
                    piecewise(1904, -1, { combinedGain: 40 }),
                    piecewise(1850, -1, { combinedGain: 25 }),
                ],
            ),
            diagnosis,
            [{ startYear: 1900, endYear: 1906 }],
        );

        expect(result).toHaveLength(2);
        expect(result.map((choice) => choice.algorithmSource)).toEqual([
            "cumulative_difference_location",
            "piecewise_gain_location",
        ]);
        expect(result.map((choice) => choice.rankedYears[0].year)).toEqual([
            1930,
            1850,
        ]);
        expect(result.every((choice) => choice.endYear - choice.startYear + 1 === 7))
            .toBe(true);
    });

    it("caps dual-signal peaks while retaining the primary signal's second peak", () => {
        const result = buildDualSignalLocationChoices(
            "missingRing",
            -1,
            analysis(
                [
                    cumulative(1840, -1, { differenceCumulative: 30 }),
                    cumulative(1880, -1, { differenceCumulative: 25 }),
                ],
                [
                    piecewise(1920, -1, { combinedGain: 20 }),
                    piecewise(1960, -1, { combinedGain: 15 }),
                ],
            ),
            diagnosis,
        );

        expect(result.map((choice) => choice.algorithmSource)).toEqual([
            "cumulative_difference_location",
            "cumulative_difference_location",
            "piecewise_gain_location",
        ]);
        expect(result.map((choice) => choice.rankedYears[0].year)).toEqual([
            1840,
            1880,
            1920,
        ]);
    });

    it("uses independent reference and whitened peaks for false rings", () => {
        const result = buildDualSignalLocationChoices(
            "falseRing",
            1,
            analysis(
                [
                    cumulative(1920, 1, { referenceMeanCumulative: 30 }),
                    cumulative(1960, 1, { whitenedCumulative: 25 }),
                ],
                [],
            ),
            diagnosis,
        );

        expect(result.map((choice) => choice.rankedYears[0].year)).toEqual([
            1920,
            1960,
        ]);
    });

    it("keeps partial-move alternatives nine years wide and shift-specific", () => {
        const result = buildDualSignalLocationChoices(
            "partialMove",
            -3,
            analysis(
                [],
                [
                    piecewise(1880, -3, { whitenedObjective: 30 }),
                    piecewise(1940, -3, { combinedObjective: 25 }),
                    piecewise(1970, 2, {
                        whitenedObjective: 100,
                        combinedObjective: 100,
                    }),
                ],
            ),
            diagnosis,
        );

        expect(result.map((choice) => choice.rankedYears[0].year)).toEqual([
            1881,
            1941,
        ]);
        expect(result.every((choice) => choice.endYear - choice.startYear + 1 === 9))
            .toBe(true);
        expect(result.every((choice) => choice.shiftYears === -3)).toBe(true);
    });

    it("bridges a small uncovered gap between two narrow location peaks", () => {
        const result = addTransitionLocationAlternatives(
            event(1903, 1909, [location(1, 1913, 1919)]),
            missingHypothesis,
            analysis([
                cumulative(1911, -1, { differenceCumulative: 10 }),
            ], []),
            diagnosis,
        );

        expect(result.locationAlternatives).toHaveLength(2);
        expect(result.locationAlternatives?.[1]).toMatchObject({
            startYear: 1908,
            endYear: 1914,
            algorithmSource: "bracketed_peak_bridge_location",
        });
    });

    it("bridges next to the primary window before a smaller remote gap", () => {
        const result = addTransitionLocationAlternatives(
            event(1900, 1906, [
                location(1, 1888, 1894),
                location(2, 1909, 1915),
                location(3, 1920, 1926),
                location(4, 1929, 1935),
            ]),
            missingHypothesis,
            analysis([], []),
            diagnosis,
        );

        expect(result.locationAlternatives).toHaveLength(4);
        expect(result.locationAlternatives?.[3]).toMatchObject({
            startYear: 1894,
            endYear: 1900,
            algorithmSource: "bracketed_peak_bridge_location",
        });
    });

    it("uses agreeing scan and direct-transition evidence just outside an edge", () => {
        const result = addTransitionLocationAlternatives(
            event(1899, 1907, [], [
                "scan_top_year=1898",
                "direct_transition_year=1895",
            ]),
            missingHypothesis,
            analysis([
                cumulative(1897, -1, { differenceCumulative: 10 }),
            ], []),
            diagnosis,
        );

        expect(result.locationAlternatives?.[0]).toMatchObject({
            startYear: 1894,
            endYear: 1900,
            algorithmSource: "independent_edge_consensus_location",
        });
    });

    it("continues a one-sided edge guard without widening the next option", () => {
        const result = addTransitionLocationAlternatives(
            event(1951, 1959, [], [
                "window_refinement=edge_rank_guard",
                "window_before=1953-1959",
            ], ["edge_rank_guard"]),
            missingHypothesis,
            analysis([
                cumulative(1952, -1, { differenceCumulative: 10 }),
            ], []),
            diagnosis,
        );

        expect(result.locationAlternatives?.[0]).toMatchObject({
            startYear: 1949,
            endYear: 1955,
            algorithmSource: "continued_edge_guard_location",
        });
        expect(
            (result.locationAlternatives?.[0].endYear ?? 0)
                - (result.locationAlternatives?.[0].startYear ?? 0) + 1,
        ).toBe(7);
    });

    it("uses a contrast peak to fill an otherwise unused narrow location option", () => {
        const result = addTransitionLocationAlternatives(
            event(1900, 1906),
            missingHypothesis,
            analysis([
                cumulative(1940, -1, { whitenedContrast: 12 }),
                cumulative(1960, -1, { whitenedContrast: 8 }),
            ], []),
            diagnosis,
        );

        expect(result.locationAlternatives?.[0]).toMatchObject({
            startYear: 1937,
            endYear: 1943,
            algorithmSource: "cumulative_whitened_contrast_location",
        });
    });

    it("keeps transition consensus ahead of a remote contrast peak at capacity", () => {
        const result = addTransitionLocationAlternatives(
            event(1899, 1907, [
                location(1, 1920, 1926),
                location(2, 1930, 1936),
            ], [
                "scan_top_year=1898",
                "direct_transition_year=1895",
            ]),
            missingHypothesis,
            analysis([
                cumulative(1950, -1, { whitenedContrast: 50 }),
            ], []),
            diagnosis,
            {
                ...DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG,
                maximumLocationAlternatives: 3,
            },
        );

        expect(result.locationAlternatives).toHaveLength(3);
        expect(result.locationAlternatives?.[2]).toMatchObject({
            startYear: 1894,
            endYear: 1900,
            algorithmSource: "independent_edge_consensus_location",
        });
        expect(result.locationAlternatives?.some((candidate) => (
            candidate.algorithmSource === "cumulative_whitened_contrast_location"
        ))).toBe(false);
    });

    it("reserves one location for protected boundary evidence at capacity", () => {
        const result = addTransitionLocationAlternatives(
            event(1899, 1907, [
                location(1, 1920, 1926),
                location(2, 1930, 1936),
                location(3, 1940, 1946),
                location(4, 1950, 1956),
            ], [
                "scan_top_year=1898",
                "direct_transition_year=1895",
            ]),
            missingHypothesis,
            analysis([], []),
            diagnosis,
        );

        expect(result.locationAlternatives).toHaveLength(4);
        expect(result.locationAlternatives?.[3]).toMatchObject({
            startYear: 1894,
            endYear: 1900,
            algorithmSource: "independent_edge_consensus_location",
        });
        expect(result.locationAlternatives?.some((candidate) => (
            candidate.startYear === 1950 && candidate.endYear === 1956
        ))).toBe(false);
    });

    it("removes a location whose visible years are already covered by earlier choices", () => {
        const result = addTransitionLocationAlternatives(
            event(1899, 1907, [
                location(1, 1935, 1941),
                location(2, 1942, 1948),
            ]),
            missingHypothesis,
            analysis([
                cumulative(1940, -1, { whitenedContrast: 12 }),
            ], []),
            diagnosis,
        );

        expect(result.locationAlternatives).toHaveLength(2);
        expect(result.locationAlternatives?.map((candidate) => [
            candidate.startYear,
            candidate.endYear,
        ])).toEqual([
            [1935, 1941],
            [1942, 1948],
        ]);
    });

    it("promotes an adjacent missing-ring year only with four-family consensus", () => {
        const candidate = event(1900, 1906, [], [
            "scan_top_year=1902",
            "candidate_top_year=1902",
            "unit_local_combo31_year=1902",
            "unit_local_multiScale_year=1902",
        ]);
        candidate.rankedYears = ranked(1900, 1906)
            .map((row) => ({
                ...row,
                score: row.year === 1903 ? 10 : row.year === 1902 ? 9 : 0,
            }))
            .sort((left, right) => right.score - left.score || right.year - left.year)
            .map((row, index) => ({ ...row, rank: index + 1 }));

        const result = rerankMissingRingByAnchorConsensus(candidate);
        expect(result.rankedYears[0].year).toBe(1902);
        expect(result.evidence.algorithmSources).toContain(
            "missing_year_anchor_consensus",
        );
    });

    it("keeps a strong current Top1 when adjacent anchors are insufficient", () => {
        const candidate = event(1900, 1906, [], [
            "scan_top_year=1902",
            "candidate_top_year=1902",
            "unit_local_combo31_year=1902",
        ]);
        candidate.rankedYears = ranked(1900, 1906)
            .map((row) => ({
                ...row,
                score: row.year === 1903 ? 10 : row.year === 1902 ? 1 : 0,
            }))
            .sort((left, right) => right.score - left.score || right.year - left.year)
            .map((row, index) => ({ ...row, rank: index + 1 }));

        expect(rerankMissingRingByAnchorConsensus(candidate).rankedYears[0].year)
            .toBe(1903);
    });

    it("promotes only a weak false-ring Top2 with independent-family agreement", () => {
        const candidate: DiagnosisEvent = {
            ...event(1900, 1906, [], [
                "scan_top_year=1902",
                "raw_path_top_year=1901",
                "candidate_top_year=1902",
                "unit_local_difference31_year=1902",
                "unit_local_whitened31_year=1902",
                "unit_local_combo31_year=1902",
                "unit_local_multiScale_year=1902",
            ]),
            eventType: "falseRing",
        };
        candidate.rankedYears = ranked(1900, 1906)
            .map((row) => ({
                ...row,
                score: row.year === 1903 ? 10 : row.year === 1902 ? 9.95 : 0,
            }))
            .sort((left, right) => right.score - left.score || right.year - left.year)
            .map((row, index) => ({ ...row, rank: index + 1 }));

        const result = rerankEventYearsByAnchorConsensus(candidate);
        expect(result.rankedYears[0].year).toBe(1902);
        expect(result.evidence.algorithmSources).toContain(
            "false_year_anchor_consensus",
        );
    });

    it("uses partial-move consensus only when the supported year is already Top2", () => {
        const candidate: DiagnosisEvent = {
            ...event(1900, 1908, [], [
                "profile_boundary_year=1902",
                "partial_reference_vote_year=1902",
            ]),
            eventType: "partialMove",
            shiftYears: -2,
            shiftSide: "older",
        };
        candidate.rankedYears = ranked(1900, 1908)
            .map((row) => ({
                ...row,
                score: row.year === 1906 ? 10 : row.year === 1902 ? 9.9 : 0,
            }))
            .sort((left, right) => right.score - left.score || right.year - left.year)
            .map((row, index) => ({ ...row, rank: index + 1 }));

        const result = rerankEventYearsByAnchorConsensus(candidate);
        expect(result.rankedYears[0].year).toBe(1902);
        expect(result.evidence.algorithmSources).toContain(
            "partial_year_anchor_consensus",
        );
    });
});

describe("decisive dynamic operation fusion", () => {
    const fusionDiagnosis = {
        targetTree: "TEST",
        targetRange: { startYear: 1800, endYear: 2024 },
        rawTarget: new Map(Array.from(
            { length: 225 },
            (_, index) => [1800 + index, index + 1],
        )),
    } as SeriesCoreDiagnosis;

    it("never compresses an upstream -100 partial move to -2", () => {
        const existing = partialEvent(-100);
        const decision = selectDecisiveJointOperationFusion(
            [existing],
            [
                jointOperation(-2, 1),
                jointOperation(-100, 0.1),
            ],
        );

        expect(decision).toBeNull();
        expect(fuseDecisiveJointOperationScores(
            [existing],
            fusionDiagnosis,
            [
                jointOperation(-2, 1),
                jointOperation(-100, 0.1),
            ],
        )).toEqual([existing]);
    });

    it("recovers one exact -50 operation from an empty upstream result", () => {
        const result = fuseDecisiveJointOperationScores(
            [],
            fusionDiagnosis,
            [
                jointOperation(-2, 0.05),
                jointOperation(-50, 0.9, 1950),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            eventType: "partialMove",
            shiftYears: -50,
            shiftSide: "older",
        });
        expect(result[0].evidence.algorithmSources).toContain(
            "decisive_joint_operation_fusion",
        );
    });

    it("selects one breakpoint-local negative gap without moving the review window", () => {
        const result = fuseDecisiveJointOperationScores(
            [partialEvent(-3)],
            fusionDiagnosis,
            [
                jointOperation(1, 0.05, 1900),
                jointOperation(-2, 0.2, 1900),
                jointOperation(-50, 0.9, 1900),
                jointOperation(-100, 0.1, 1900),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            eventType: "partialMove",
            shiftYears: -50,
            shiftSide: "older",
            startYear: 1900,
            endYear: 1908,
        });
        expect(result[0].evidence.notes).toContain(
            "operation_fusion=dynamic_partial_breakpoint_override",
        );
    });

    it("does not amplify a local large-gap spike without global shift agreement", () => {
        const existing = partialEvent(-3);
        const result = fuseDecisiveJointOperationScores(
            [existing],
            fusionDiagnosis,
            [
                jointOperation(1, 0.05, 1900),
                jointOperation(-2, 0.2, 1900),
                jointOperation(-50, 0.01, 1900, {
                    rows: [{
                        year: 1900,
                        sideStepScore: 0.9,
                        differenceGain: 0.9,
                        combinedGain: 0.9,
                    }] as JointCounterfactualOperationScore["rows"],
                }),
            ],
        );

        expect(result).toEqual([existing]);
    });

    it("does not let a local breakpoint rewrite a globally stable current gap", () => {
        const existing = partialEvent(-50);
        const result = fuseDecisiveJointOperationScores(
            [existing],
            fusionDiagnosis,
            [
                jointOperation(-49, 0.1, 1950),
                jointOperation(-50, 0.9, 1950),
                jointOperation(-51, 0.1, 1950),
                jointOperation(-98, 0.5, 1900),
            ],
        );

        expect(result).toEqual([existing]);
    });

    it("uses decisive dynamic type evidence to replace a wrong partial event", () => {
        const result = fuseDecisiveJointOperationScores(
            [partialEvent(-76)],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.1),
                jointOperation(1, 0.6),
                jointOperation(-75, 0.2),
                jointOperation(-76, 0.22),
                jointOperation(-77, 0.2),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0].eventType).toBe("falseRing");
        expect(result[0].evidence.notes).toContain(
            "operation_fusion=dynamic_joint_grid_override",
        );
    });

    it("trusts a well-separated unit direction when it narrowly beats a partial", () => {
        const result = fuseDecisiveJointOperationScores(
            [partialEvent(-76)],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.32),
                jointOperation(1, 0.1),
                jointOperation(-75, 0.28),
                jointOperation(-76, 0.3),
                jointOperation(-77, 0.28),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0].eventType).toBe("missingRing");
        expect(result[0].evidence.notes).toContain(
            "operation_fusion=dynamic_joint_grid_override",
        );
    });

    it("recovers a unit event at the calibrated large-partial direction margin", () => {
        const result = fuseDecisiveJointOperationScores(
            [partialEvent(-63)],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.155),
                jointOperation(1, 0.2),
                jointOperation(-62, 0.17),
                jointOperation(-63, 0.19),
                jointOperation(-64, 0.17),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0].eventType).toBe("falseRing");
        expect(result[0].evidence.notes).toContain(
            "operation_fusion=dynamic_joint_grid_override",
        );
    });

    it("keeps a partial when the two unit directions remain ambiguous", () => {
        const existing = partialEvent(-76);
        const result = fuseDecisiveJointOperationScores(
            [existing],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.32),
                jointOperation(1, 0.28),
                jointOperation(-75, 0.28),
                jointOperation(-76, 0.3),
                jointOperation(-77, 0.28),
            ],
        );

        expect(result).toEqual([existing]);
    });

    it("keeps a unit event when a large-gap family wins by only a weak margin", () => {
        const existing = event(1900, 1908);
        const result = fuseDecisiveJointOperationScores(
            [existing],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.32),
                jointOperation(1, 0.05),
                jointOperation(-62, 0.1),
                jointOperation(-63, 0.34),
                jointOperation(-64, 0.1),
            ],
        );

        expect(result).toEqual([existing]);
    });

    it("rejects an empty partial result when adjacent shifts are indistinguishable", () => {
        const result = fuseDecisiveJointOperationScores(
            [],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.05),
                jointOperation(1, 0.05),
                jointOperation(-53, 0.399),
                jointOperation(-54, 0.4),
                jointOperation(-55, 0.399),
            ],
        );

        expect(result).toEqual([]);
    });

    it("recovers a unit event hidden by an unstable large-gap family", () => {
        const result = fuseDecisiveJointOperationScores(
            [],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.12),
                jointOperation(1, 0.05),
                jointOperation(-52, 0.139),
                jointOperation(-53, 0.14),
                jointOperation(-54, 0.139),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0].eventType).toBe("missingRing");
    });

    it("keeps a decisive partial step over its co-located unit approximation", () => {
        const result = fuseDecisiveJointOperationScores(
            [],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.01, 1851),
                jointOperation(1, 0.04, 1851),
                jointOperation(-3, 0.02, 1851),
                jointOperation(-4, 0.2, 1851),
                jointOperation(-5, 0.03, 1851),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            eventType: "partialMove",
            shiftYears: -4,
        });
    });

    it("keeps the unit fallback when the partial peak belongs to a remote mode", () => {
        const result = fuseDecisiveJointOperationScores(
            [],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.01, 1851),
                jointOperation(1, 0.04, 1851),
                jointOperation(-3, 0.02, 1900),
                jointOperation(-4, 0.2, 1900),
                jointOperation(-5, 0.03, 1900),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0].eventType).toBe("falseRing");
    });

    it("does not recover a unit fallback outside the calibrated score gate", () => {
        const result = fuseDecisiveJointOperationScores(
            [],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.019),
                jointOperation(1, 0.01),
                jointOperation(-52, 0.139),
                jointOperation(-53, 0.14),
                jointOperation(-54, 0.139),
            ],
        );

        expect(result).toEqual([]);
    });

    it("replaces an implausibly large partial with a separated unit fallback", () => {
        const result = fuseDecisiveJointOperationScores(
            [partialEvent(-90)],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.12),
                jointOperation(1, 0.05),
                jointOperation(-52, 0.139),
                jointOperation(-53, 0.14),
                jointOperation(-54, 0.139),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0].eventType).toBe("missingRing");
    });

    it("lets a calibrated unit fallback replace a stable large partial winner", () => {
        const result = fuseDecisiveJointOperationScores(
            [partialEvent(-90)],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.12),
                jointOperation(1, 0.05),
                jointOperation(-89, 0.29),
                jointOperation(-90, 0.3),
                jointOperation(-91, 0.29),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0].eventType).toBe("missingRing");
        expect(result[0].evidence.notes).toContain(
            "operation_fusion=dynamic_unit_fallback_override",
        );
    });

    it("does not demote an exact physical partial lag step to a unit fallback", () => {
        const exact = {
            ...partialEvent(-20),
            evidence: {
                ...partialEvent(-20).evidence,
                lagBefore: -20,
                lagAfter: 0,
            },
        };
        const result = fuseDecisiveJointOperationScores(
            [exact],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.213),
                jointOperation(1, 0.12),
                jointOperation(-19, 0.19),
                jointOperation(-20, 0.226),
                jointOperation(-21, 0.18),
            ],
        );

        expect(result).toEqual([exact]);
    });

    it("lets an independently detected unit event compete with an exact partial alias", () => {
        const missing = event(1665, 1671);
        const exactAlias = {
            ...partialEvent(-2, 1610, 1618),
            evidence: {
                ...partialEvent(-2, 1610, 1618).evidence,
                lagBefore: -2,
                lagAfter: 0,
            },
        };
        const result = fuseDecisiveJointOperationScores(
            [missing, exactAlias],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.3, 1668),
                jointOperation(1, 0.05, 1668),
                jointOperation(-2, 0.12, 1614),
                jointOperation(-3, 0.08, 1614),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0].eventType).toBe("missingRing");
    });

    it("does not replace a plausible small physical gap with the unit fallback", () => {
        const existing = partialEvent(-4);
        const result = fuseDecisiveJointOperationScores(
            [existing],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.12),
                jointOperation(1, 0.05),
                jointOperation(-52, 0.139),
                jointOperation(-53, 0.14),
                jointOperation(-54, 0.139),
            ],
        );

        expect(result).toEqual([existing]);
    });

    it("keeps a whole-series move while replacing one wrong local partial", () => {
        const whole: DiagnosisEvent = {
            ...event(1800, 2000),
            id: "whole",
            eventType: "wholeSeriesMove",
            shiftYears: 3,
        };
        const result = fuseDecisiveJointOperationScores(
            [whole, partialEvent(-2)],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.05),
                jointOperation(1, 0.6),
                jointOperation(-2, 0.2),
                jointOperation(-3, 0.15),
            ],
        );

        expect(result).toHaveLength(2);
        expect(result[0]).toBe(whole);
        expect(result[1].eventType).toBe("falseRing");
    });

    it("does not manufacture a same-shift local gap from a whole-only event", () => {
        const whole: DiagnosisEvent = {
            ...event(1800, 2000),
            id: "whole-only-negative-nine",
            eventType: "wholeSeriesMove",
            evidence: {
                ...event(1800, 2000).evidence,
                lagBefore: -9,
            },
        };
        const result = fuseDecisiveJointOperationScores(
            [whole],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.02, 2010),
                jointOperation(1, 0.01, 2010),
                jointOperation(-8, 0.4, 2010),
                jointOperation(-9, 0.8, 2010),
                jointOperation(-10, 0.4, 2010),
            ],
        );

        expect(result).toEqual([whole]);
    });

    it("recovers an interior exact gap when the alleged whole lag is its older state", () => {
        const whole: DiagnosisEvent = {
            ...event(1800, 2024),
            id: "whole-partial-alias-negative-thirty",
            eventType: "wholeSeriesMove",
            evidence: {
                ...event(1800, 2024).evidence,
                lagBefore: -30,
                lagAfter: -65,
            },
        };
        const fragment: DiagnosisEvent = {
            ...partialEvent(-2, 1848, 1856),
            evidence: {
                ...partialEvent(-2, 1848, 1856).evidence,
                lagBefore: -30,
                lagAfter: -28,
            },
        };
        const result = fuseDecisiveJointOperationScores(
            [whole, fragment],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.05, 1850),
                jointOperation(1, 0.04, 1850),
                jointOperation(-29, 0.2, 1850),
                jointOperation(-30, 0.9, 1850),
                jointOperation(-31, 0.2, 1850),
            ],
        );

        expect(result).toHaveLength(2);
        expect(result[0]).toBe(whole);
        expect(result[1]).toMatchObject({
            eventType: "partialMove",
            shiftYears: -30,
        });
        expect(result[1].evidence).toMatchObject({
            lagBefore: -30,
            lagAfter: 0,
        });
    });

    it("keeps a real whole baseline when the local move terminates at that lag", () => {
        const whole: DiagnosisEvent = {
            ...event(1800, 2024),
            id: "whole-with-independent-partial",
            eventType: "wholeSeriesMove",
            evidence: {
                ...event(1800, 2024).evidence,
                lagBefore: -9,
                lagAfter: -4,
            },
        };
        const local: DiagnosisEvent = {
            ...partialEvent(-4, 1866, 1874),
            evidence: {
                ...partialEvent(-4, 1866, 1874).evidence,
                lagBefore: -13,
                lagAfter: -9,
            },
        };

        expect(fuseDecisiveJointOperationScores(
            [whole, local],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.05, 1870),
                jointOperation(1, 0.04, 1870),
                jointOperation(-8, 0.2, 1870),
                jointOperation(-9, 0.9, 1870),
                jointOperation(-10, 0.2, 1870),
            ],
        )).toEqual([whole, local]);
    });

    it("keeps a whole-series move while correcting a decisive unit direction", () => {
        const whole: DiagnosisEvent = {
            ...event(1800, 2000),
            id: "whole-unit-correction",
            eventType: "wholeSeriesMove",
            shiftYears: 3,
        };
        const wrongUnit = event(1900, 1908);
        const result = fuseDecisiveJointOperationScores(
            [whole, wrongUnit],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.05),
                jointOperation(1, 0.3),
                jointOperation(-20, 0.35),
                jointOperation(-21, 0.4),
                jointOperation(-22, 0.35),
            ],
        );

        expect(result).toHaveLength(2);
        expect(result[0]).toBe(whole);
        expect(result[1].eventType).toBe("falseRing");
        expect(result[1].evidence.notes).toContain(
            "operation_fusion=dynamic_unit_type_correction",
        );
    });

    it("preserves a whole-series unit event when its opposite is weak", () => {
        const whole: DiagnosisEvent = {
            ...event(1800, 2000),
            id: "whole-weak-unit",
            eventType: "wholeSeriesMove",
            shiftYears: 3,
        };
        const existing = event(1900, 1908);
        const result = fuseDecisiveJointOperationScores(
            [whole, existing],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.05),
                jointOperation(1, 0.12),
                jointOperation(-20, 0.35),
                jointOperation(-21, 0.4),
                jointOperation(-22, 0.35),
            ],
        );

        expect(result).toEqual([whole, existing]);
    });

    it("corrects one existing unit type without a whole-series event", () => {
        const wrongUnit = event(1900, 1908);
        const result = fuseDecisiveJointOperationScores(
            [wrongUnit],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.05),
                jointOperation(1, 0.2),
                jointOperation(-20, 0.23),
                jointOperation(-21, 0.25),
                jointOperation(-22, 0.23),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0].eventType).toBe("falseRing");
        expect(result[0].evidence.notes).toContain(
            "operation_fusion=dynamic_unit_type_correction",
        );
    });

    it("corrects a moderate existing unit type when both directions separate", () => {
        const wrongUnit = event(1900, 1908);
        const result = fuseDecisiveJointOperationScores(
            [wrongUnit],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.06),
                jointOperation(1, 0.08),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0].eventType).toBe("falseRing");
        expect(result[0].evidence.notes).toContain(
            "operation_fusion=dynamic_unit_type_correction",
        );
    });

    it("preserves an existing unit when the opposite direction is ambiguous", () => {
        const existing = event(1900, 1908);
        const result = fuseDecisiveJointOperationScores(
            [existing],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.08),
                jointOperation(1, 0.085),
            ],
        );

        expect(result).toEqual([existing]);
    });

    it("merges incoherent saturated-edge fragments into the larger exact gap", () => {
        const falseFragment: DiagnosisEvent = {
            ...event(1880, 1886),
            id: "false-fragment",
            eventType: "falseRing",
            evidence: {
                ...event(1880, 1886).evidence,
                lagBefore: -100,
                lagAfter: -101,
            },
        };
        const partialFragment = {
            ...partialEvent(-2, 1900, 1908),
            evidence: {
                ...partialEvent(-2, 1900, 1908).evidence,
                lagBefore: -100,
                lagAfter: -98,
            },
        };
        const result = fuseDecisiveJointOperationScores(
            [falseFragment, partialFragment],
            fusionDiagnosis,
            [
                jointOperation(-2, 0.05),
                jointOperation(-100, 0.9, 1950),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            eventType: "partialMove",
            shiftYears: -100,
        });
    });

    it("collapses a unit-only lag staircase when one physical gap is decisive", () => {
        const older = {
            ...event(1820, 1826),
            evidence: {
                ...event(1820, 1826).evidence,
                lagBefore: -2,
                lagAfter: -1,
            },
        };
        const newer = {
            ...event(1880, 1886),
            id: "newer-missing",
            evidence: {
                ...event(1880, 1886).evidence,
                lagBefore: -1,
                lagAfter: 0,
            },
        };
        const result = fuseDecisiveJointOperationScores(
            [older, newer],
            fusionDiagnosis,
            [
                jointOperation(-1, 0.1),
                jointOperation(1, 0.05),
                jointOperation(-2, 0.9, 1904),
                jointOperation(-3, 0.1),
            ],
        );

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            eventType: "partialMove",
            shiftYears: -2,
        });
    });

    it("does not dismantle a coherent mixed lag path", () => {
        const first = {
            ...event(1880, 1886),
            evidence: {
                ...event(1880, 1886).evidence,
                lagBefore: 0,
                lagAfter: -1,
            },
        };
        const second = {
            ...partialEvent(-3, 1920, 1928),
            evidence: {
                ...partialEvent(-3, 1920, 1928).evidence,
                lagBefore: -1,
                lagAfter: -4,
            },
        };
        const events = [first, second];

        expect(fuseDecisiveJointOperationScores(
            events,
            fusionDiagnosis,
            [
                jointOperation(-2, 0.05),
                jointOperation(-100, 0.9, 1950),
            ],
        )).toBe(events);
    });
});

describe("subtle false-ring empty recovery", () => {
    const recoveryDiagnosis = {
        targetTree: "TEST",
        targetRange: { startYear: 1800, endYear: 2024 },
        rawTarget: new Map(Array.from(
            { length: 225 },
            (_, index) => [1800 + index, index + 1],
        )),
    } as SeriesCoreDiagnosis;
    const subtleOperations = (
        overrides: Partial<JointCounterfactualOperationScore> = {},
    ): JointCounterfactualOperationScore[] => [
        jointOperation(-1, 0.01, 1872, {
            bestCorrectedSideSupport: -0.18,
        }),
        jointOperation(1, 0.0221, 1870, {
            bestDifferenceGain: 0.0284,
            sideStepBestYear: 1880,
            bestSideMinimumAdvantage: -0.0375,
            bestCorrectedSideSupport: 0.2096,
            sideStepRemoteMargin: 0.1803,
            rows: Array.from({ length: 25 }, (_, index) => {
                const year = 1868 + index;
                return {
                    year,
                    sideStepScore: year === 1880 ? 0.2 : 0,
                    differenceGain: year === 1870 ? 0.0284 : 0,
                    combinedGain: year === 1870 ? 0.02 : 0,
                };
            }) as JointCounterfactualOperationScore["rows"],
            ...overrides,
        }),
    ];

    it("selects the calibrated false-ring boundary only when all signs agree", () => {
        expect(selectSubtleFalseRingEmptyRecovery(subtleOperations()))
            .toMatchObject({ eventType: "falseRing", shiftYears: 1 });
        expect(selectSubtleFalseRingEmptyRecovery(subtleOperations({
            bestSideMinimumAdvantage: 0.001,
        }))).toBeNull();
        const oppositeSupported = subtleOperations();
        oppositeSupported[0] = {
            ...oppositeSupported[0],
            bestCorrectedSideSupport: 0,
        };
        expect(selectSubtleFalseRingEmptyRecovery(oppositeSupported)).toBeNull();
    });

    it("emits one 13-year window centered on the side-step year", () => {
        const result = recoverSubtleFalseRingEmptySuggestion(
            [],
            recoveryDiagnosis,
            subtleOperations(),
        );

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            eventType: "falseRing",
            startYear: 1874,
            endYear: 1886,
        });
        expect(result[0].rankedYears[0].year).toBe(1880);
        expect(result[0].evidence.algorithmSources).toContain(
            "subtle_false_ring_empty_recovery",
        );
    });

    it("never replaces an existing suggestion", () => {
        const existing = event(1874, 1886);
        expect(recoverSubtleFalseRingEmptySuggestion(
            [existing],
            recoveryDiagnosis,
            subtleOperations(),
        )).toEqual([existing]);
    });
});
