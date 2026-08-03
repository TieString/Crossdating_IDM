import { describe, expect, it } from "vitest";
import { rankUnitEventYears } from "../unitEventYearRanking";

const allYears = Array.from({ length: 21 }, (_, index) => 1900 + index);
const peak = (center: number): number[] => allYears.map((year) => (
    Math.max(0, 1 - Math.abs(year - center) / 5)
));

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

    it("falls back when required evidence is unavailable", () => {
        expect(rankUnitEventYears({
            eventType: "missingRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map(),
        })).toBeNull();
    });

});
