import { describe, expect, it } from "vitest";
import { rankUnitEventYears } from "../unitEventYearRanking";

const allYears = Array.from({ length: 21 }, (_, index) => 1900 + index);
const peak = (center: number): number[] => allYears.map((year) => (
    Math.max(0, 1 - Math.abs(year - center) / 5)
));

const falseCounterfactualRows = (
    preferredYear: number,
) => allYears.map((year) => {
    const score = year === preferredYear ? 10_000 : year;
    return {
        year,
        profiles: {
            differenceMasterHuber31: 0,
            whitenedMasterHuber31: 0,
            differenceReferenceWeightedHuber31: score,
            differenceMasterHuber21: 0,
            differenceReferencePeakKernel5: score,
            differenceReferencePeakKernel9: score,
            differenceReferenceRankMean31: score,
        },
    };
});

const missingFixedProfileNames = [
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

const missingFixedProfiles = (
    preferredYear: number,
    votes: number = missingFixedProfileNames.length,
): ReadonlyMap<string, ReadonlyMap<number, number>> => new Map(
    missingFixedProfileNames.map((name, index) => [
        name,
        new Map(allYears.map((year) => [
            year,
            year === (index < votes ? preferredYear : 1910) ? 10 : 0,
        ])),
    ]),
);

const falsePhysicalProfiles = (
    preferredYear: number,
    options: {
        mergeMargin?: number;
        widthMergeAdvantage?: number;
    } = {},
): ReadonlyMap<string, ReadonlyMap<number, number>> => {
    const mergeMargin = options.mergeMargin ?? 0.02;
    const runnerUpYear = preferredYear - 1;
    const profile = (
        preferredValue: number,
        runnerUpValue = 0,
    ): ReadonlyMap<number, number> => new Map(allYears.map((year) => [
        year,
        year === preferredYear
            ? preferredValue
            : year === runnerUpYear
                ? runnerUpValue
                : 0,
    ]));
    return new Map([
        ["differenceMasterRFixedWindowPlus12", profile(0.99)],
        [
            "falseMergeOlderDifferenceMasterRFixedWindowPlus12",
            profile(1, 1 - mergeMargin),
        ],
        ["differenceMasterHuberFixedWindowPlus12", profile(0.505)],
        [
            "falseMergeOlderDifferenceMasterHuberFixedWindowPlus12",
            profile(0.5),
        ],
        ["rawMasterRFixedWindowPlus12", profile(0.503)],
        ["falseMergeOlderRawMasterRFixedWindowPlus12", profile(0.5)],
        [
            "falseWidthWeightedMergeAdvantage",
            profile(options.widthMergeAdvantage ?? 0),
        ],
    ]);
};

describe("rankUnitEventYears", () => {
    it("combines reference, edit, and path evidence for missing rings", () => {
        const result = rankUnitEventYears({
            eventType: "missingRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([
                ["cumulativeReferenceVote", peak(1910)],
                ["comboFull", peak(1910)],
                ["piecewiseCombinedObjective", peak(1910)],
            ]),
        });

        expect(result?.profileNames).toEqual([
            "cumulativeReferenceVote",
            "comboFull",
            "piecewiseCombinedObjective",
        ]);
        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1],
        );
        expect(ranked[0][0]).toBe(1910);
    });

    it("uses the sharp corrected-difference profile for false rings", () => {
        const result = rankUnitEventYears({
            eventType: "falseRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([
                ["differenceFull", peak(1911)],
            ]),
        });

        expect(result?.profileNames).toEqual(["differenceFull"]);
        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1],
        );
        expect(ranked[0][0]).toBe(1911);
    });

    it("does not let unstable local correction evidence move false-ring ranking", () => {
        const result = rankUnitEventYears({
            eventType: "falseRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([
                ["differenceFull", peak(1910)],
            ]),
            localCorrectionRanking: {
                rankByYear: new Map(allYears.map((year) => [
                    year,
                    year === 1911 ? 1 : 0,
                ])),
                profileName: "whitenedOlderHuberBoundary5",
            },
        });

        expect(result?.profileNames).toEqual(["differenceFull"]);
        expect(result?.scoreByYear.get(1911)).toBeCloseTo(0.8, 10);
        expect(result?.scoreByYear.get(1910)).toBeCloseTo(1, 10);
    });

    it("uses independent missing-ring anchors only as a weak tie-breaker", () => {
        const flat = allYears.map(() => 0.5);
        const result = rankUnitEventYears({
            eventType: "missingRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([
                ["cumulativeReferenceVote", flat],
                ["comboFull", flat],
                ["piecewiseCombinedObjective", flat],
            ]),
            currentPrimaryYear: 1908,
            operationEvidence: {
                bestYear: 1910,
                sideStepBestYear: 1912,
            },
        });

        expect(result?.profileNames).toContain("missingAnchorMedian");
        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1],
        );
        expect(ranked[0][0]).toBe(1910);
        expect(ranked[0][1] - ranked[1][1]).toBeCloseTo(0.002, 10);
    });

    it("promotes only an adjacent missing-ring year when sharp evidence clears the gate", () => {
        const baselinePeak = peak(1910);
        const cumulativeDifference = allYears.map((year) => (
            year === 1912 ? 10 : year === 1911 ? -10 : 0
        ));
        const result = rankUnitEventYears({
            eventType: "missingRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([
                ["cumulativeReferenceVote", baselinePeak],
                ["comboFull", baselinePeak],
                ["piecewiseCombinedObjective", baselinePeak],
                ["cumulativeDifference", cumulativeDifference],
            ]),
            exactYearEvidence: {
                scoreByYear: new Map(allYears.map((year) => [
                    year,
                    year === 1911 ? 10 : year === 1910 ? -10 : 0,
                ])),
                profileName: "differencePredictiveMedianHuberOlder5",
            },
        });

        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1] || right[0] - left[0],
        );
        expect(ranked[0][0]).toBe(1911);
        expect(result?.profileNames).toContain("adjacentExactYearGate");
    });

    it("does not promote a remote missing-ring year", () => {
        const baselinePeak = peak(1910);
        const result = rankUnitEventYears({
            eventType: "missingRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([
                ["cumulativeReferenceVote", baselinePeak],
                ["comboFull", baselinePeak],
                ["piecewiseCombinedObjective", baselinePeak],
                ["cumulativeDifference", allYears.map((year) => (
                    year === 1914 ? 10 : 0
                ))],
            ]),
            exactYearEvidence: {
                scoreByYear: new Map(allYears.map((year) => [
                    year,
                    year === 1913 ? 10 : 0,
                ])),
                profileName: "differencePredictiveMedianHuberOlder5",
            },
        });

        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1] || right[0] - left[0],
        );
        expect(ranked[0][0]).toBe(1910);
        expect(result?.profileNames).not.toContain("adjacentExactYearGate");
    });

    it("keeps a strongly supported missing-ring baseline year", () => {
        const baselinePeak = peak(1910);
        const consensusProfiles = [
            "cumulativeReferenceVote",
            "comboFull",
            "piecewiseCombinedObjective",
            "differenceFull",
            "rawFull",
            "whitenedFull",
        ];
        const ranks = new Map(consensusProfiles.map((profileName) => [
            profileName,
            baselinePeak,
        ]));
        ranks.set("cumulativeDifference", allYears.map((year) => (
            year === 1912 ? 10 : year === 1911 ? -10 : 0
        )));
        const result = rankUnitEventYears({
            eventType: "missingRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks,
            exactYearEvidence: {
                scoreByYear: new Map(allYears.map((year) => [
                    year,
                    year === 1911 ? 10 : year === 1910 ? -10 : 0,
                ])),
                profileName: "differencePredictiveMedianHuberOlder5",
            },
        });

        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1] || right[0] - left[0],
        );
        expect(ranked[0][0]).toBe(1910);
        expect(result?.profileNames).not.toContain("adjacentExactYearGate");
    });

    it("uses fixed-calendar consensus to break a missing-ring ranking plateau", () => {
        const visibleYears = allYears.slice(6, 15);
        const baselinePeak = peak(1910).map(
            (value, index) => value + index * 0.0001,
        );
        const result = rankUnitEventYears({
            eventType: "missingRing",
            years: visibleYears,
            fixedWindowYears: visibleYears,
            allYears,
            ranks: new Map([
                ["cumulativeReferenceVote", baselinePeak],
                ["comboFull", baselinePeak],
                ["piecewiseCombinedObjective", baselinePeak],
            ]),
            exactYearEvidence: {
                scoreByYear: new Map(allYears.map((year) => [year, 0])),
                profileName: "differencePredictiveMedianHuberOlder5",
                fixedWindowProfiles: missingFixedProfiles(1912),
            },
        });

        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1] || right[0] - left[0],
        );
        expect(ranked[0][0]).toBe(1912);
        expect(result?.profileNames).toContain(
            "missingFixedWindowExactYearGate",
        );
        const baselineRanked = [
            ...result!.preEventPolicyScoreByYear!.entries(),
        ].sort((left, right) => right[1] - left[1] || right[0] - left[0]);
        expect(baselineRanked[0][0]).toBe(1910);
    });

    it("keeps the missing-ring baseline without five fixed-window votes", () => {
        const visibleYears = allYears.slice(6, 15);
        const baselinePeak = peak(1910).map(
            (value, index) => value + index * 0.0001,
        );
        const result = rankUnitEventYears({
            eventType: "missingRing",
            years: visibleYears,
            fixedWindowYears: visibleYears,
            allYears,
            ranks: new Map([
                ["cumulativeReferenceVote", baselinePeak],
                ["comboFull", baselinePeak],
                ["piecewiseCombinedObjective", baselinePeak],
            ]),
            exactYearEvidence: {
                scoreByYear: new Map(allYears.map((year) => [year, 0])),
                profileName: "differencePredictiveMedianHuberOlder5",
                fixedWindowProfiles: missingFixedProfiles(1912, 4),
            },
        });

        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1] || right[0] - left[0],
        );
        expect(ranked[0][0]).toBe(1910);
        expect(result?.profileNames).not.toContain(
            "missingFixedWindowExactYearGate",
        );
    });

    it("uses a guarded adjacent correction for false-ring exact-year ranking", () => {
        const result = rankUnitEventYears({
            eventType: "falseRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([
                ["differenceFull", peak(1910)],
                ["cumulativeReferenceVote", allYears.map((year) => (
                    year === 1911 ? 10 : year === 1910 ? -10 : 0
                ))],
            ]),
            exactYearEvidence: {
                scoreByYear: new Map(allYears.map((year) => [
                    year,
                    year === 1911 ? 10 : year === 1910 ? -10 : 0,
                ])),
                profileName: "differenceMasterR61",
            },
        });

        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1] || right[0] - left[0],
        );
        expect(ranked[0][0]).toBe(1911);
        expect(result?.profileNames).toContain("differenceMasterR61");
    });

    it("promotes false-ring counterfactual consensus over a weak baseline", () => {
        const weakBaseline = allYears.map((year) => (
            year === 1910 ? 10_000 : year
        ));
        const result = rankUnitEventYears({
            eventType: "falseRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([
                ["differenceFull", weakBaseline],
            ]),
            operationEvidence: {
                bestYear: 1912,
                sideStepBestYear: 1912,
            },
            falseCounterfactualRows: falseCounterfactualRows(1912),
        });

        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1] || right[0] - left[0],
        );
        expect(ranked[0][0]).toBe(1912);
        expect(result?.profileNames).toContain(
            "falseCounterfactualConsensusGate",
        );
        const baselineRanked = [
            ...result!.preEventPolicyScoreByYear!.entries(),
        ].sort((left, right) => right[1] - left[1] || right[0] - left[0]);
        expect(baselineRanked[0][0]).toBe(1910);
    });

    it("keeps a strongly separated false-ring baseline", () => {
        const strongBaseline = allYears.map((year) => (
            year === 1910 ? 100 : 0
        ));
        const result = rankUnitEventYears({
            eventType: "falseRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([
                ["differenceFull", strongBaseline],
            ]),
            operationEvidence: {
                bestYear: 1912,
                sideStepBestYear: 1912,
            },
            falseCounterfactualRows: falseCounterfactualRows(1912),
        });

        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1] || right[0] - left[0],
        );
        expect(ranked[0][0]).toBe(1910);
        expect(result?.profileNames).not.toContain(
            "falseCounterfactualConsensusGate",
        );
    });

    it("promotes a physically split false ring when merge evidence agrees", () => {
        const result = rankUnitEventYears({
            eventType: "falseRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([["differenceFull", peak(1910)]]),
            currentPrimaryYear: 1911,
            operationEvidence: {
                bestYear: 1912,
                sideStepBestYear: 1912,
            },
            exactYearEvidence: {
                scoreByYear: new Map(allYears.map((year) => [year, 0])),
                profileName: "differenceMasterR61",
                fixedWindowProfiles: falsePhysicalProfiles(1912),
            },
        });

        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1] || right[0] - left[0],
        );
        expect(ranked[0][0]).toBe(1912);
        expect(result?.profileNames).toContain(
            "falsePhysicalMergeConsensusGate",
        );
    });

    it("protects a different false-ring year supported by two anchors", () => {
        const result = rankUnitEventYears({
            eventType: "falseRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([["differenceFull", peak(1910)]]),
            currentPrimaryYear: 1910,
            operationEvidence: {
                bestYear: 1910,
                sideStepBestYear: 1912,
            },
            exactYearEvidence: {
                scoreByYear: new Map(allYears.map((year) => [year, 0])),
                profileName: "differenceMasterR61",
                fixedWindowProfiles: falsePhysicalProfiles(1912),
            },
        });

        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1] || right[0] - left[0],
        );
        expect(ranked[0][0]).toBe(1910);
        expect(result?.profileNames).not.toContain(
            "falsePhysicalMergeConsensusGate",
        );
    });

    it("rejects physical merge evidence with poor raw-width support", () => {
        const result = rankUnitEventYears({
            eventType: "falseRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([["differenceFull", peak(1910)]]),
            currentPrimaryYear: 1911,
            operationEvidence: {
                bestYear: 1912,
                sideStepBestYear: 1912,
            },
            exactYearEvidence: {
                scoreByYear: new Map(allYears.map((year) => [year, 0])),
                profileName: "differenceMasterR61",
                fixedWindowProfiles: falsePhysicalProfiles(1912, {
                    widthMergeAdvantage: -0.6,
                }),
            },
        });

        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1] || right[0] - left[0],
        );
        expect(ranked[0][0]).toBe(1910);
        expect(result?.profileNames).not.toContain(
            "falsePhysicalMergeConsensusGate",
        );
    });

    it("requires current-year support before promoting toward newer years", () => {
        const result = rankUnitEventYears({
            eventType: "falseRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([["differenceFull", peak(1910)]]),
            currentPrimaryYear: 1908,
            operationEvidence: {
                bestYear: 1912,
                sideStepBestYear: 1912,
            },
            exactYearEvidence: {
                scoreByYear: new Map(allYears.map((year) => [year, 0])),
                profileName: "differenceMasterR61",
                fixedWindowProfiles: falsePhysicalProfiles(1912),
            },
        });

        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1] || right[0] - left[0],
        );
        expect(ranked[0][0]).toBe(1910);
        expect(result?.profileNames).not.toContain(
            "falsePhysicalMergeConsensusGate",
        );
    });

    it("requires a clear merge peak when no anchor names the candidate", () => {
        const result = rankUnitEventYears({
            eventType: "falseRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([["differenceFull", peak(1910)]]),
            currentPrimaryYear: 1911,
            operationEvidence: {
                bestYear: 1913,
                sideStepBestYear: 1914,
            },
            exactYearEvidence: {
                scoreByYear: new Map(allYears.map((year) => [year, 0])),
                profileName: "differenceMasterR61",
                fixedWindowProfiles: falsePhysicalProfiles(1912, {
                    mergeMargin: 0.005,
                }),
            },
        });

        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1] || right[0] - left[0],
        );
        expect(ranked[0][0]).toBe(1910);
        expect(result?.profileNames).not.toContain(
            "falsePhysicalMergeConsensusGate",
        );
    });

    it("never applies false-ring physical profiles to missing rings", () => {
        const baseline = peak(1910);
        const result = rankUnitEventYears({
            eventType: "missingRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([
                ["cumulativeReferenceVote", baseline],
                ["comboFull", baseline],
                ["piecewiseCombinedObjective", baseline],
            ]),
            exactYearEvidence: {
                scoreByYear: new Map(allYears.map((year) => [year, 0])),
                profileName: "differencePredictiveMedianHuberOlder5",
                fixedWindowProfiles: falsePhysicalProfiles(1912),
            },
        });

        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1] || right[0] - left[0],
        );
        expect(ranked[0][0]).toBe(1910);
        expect(result?.profileNames).not.toContain(
            "falsePhysicalMergeConsensusGate",
        );
    });

    it("falls back when required evidence is unavailable", () => {
        expect(rankUnitEventYears({
            eventType: "missingRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map(),
        })).toBeNull();
    });

});
