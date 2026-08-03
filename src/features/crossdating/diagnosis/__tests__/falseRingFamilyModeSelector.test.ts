import { describe, expect, it } from "vitest";
import { selectFalseRingFamilyMode } from "../falseRingFamilyModeSelector";

const years = Array.from({ length: 41 }, (_, index) => 1900 + index);
const modeProfile = years.map((year) => (
    year >= 1910 && year <= 1922 ? 1 : 0
));
const ranks = new Map<string, readonly number[]>([
    ["cumulativeCombined", modeProfile],
    ["transitionSplitGain", modeProfile],
    ["pairDifferenceWeighted", modeProfile],
    ["reference:rankMean", modeProfile],
]);

describe("false-ring family mode selector", () => {
    it("moves to a mode supported by independent profile families and the current anchor", () => {
        const selected = selectFalseRingFamilyMode({
            eventType: "falseRing",
            years,
            ranks,
            internalCandidates: [],
            coarseWindow: { startYear: 1904, endYear: 1928 },
            currentPrimaryYear: 1918,
        }, { startYear: 1908, endYear: 1920 });

        expect(selected?.window).toEqual({
            startYear: 1910,
            endYear: 1922,
        });
        expect(selected?.votes).toBe(4);
        expect(selected?.currentAnchorImprovement).toBe(2);
    });

    it("does not move away from the independent current anchor", () => {
        expect(selectFalseRingFamilyMode({
            eventType: "falseRing",
            years,
            ranks,
            internalCandidates: [],
            coarseWindow: { startYear: 1904, endYear: 1928 },
            currentPrimaryYear: 1913,
        }, { startYear: 1908, endYear: 1920 })).toBeNull();
    });

    it("accepts a remote mode only when every evidence family agrees", () => {
        expect(selectFalseRingFamilyMode({
            eventType: "falseRing",
            years,
            ranks,
            internalCandidates: [],
            coarseWindow: { startYear: 1904, endYear: 1928 },
            currentPrimaryYear: 1906,
        }, {
            startYear: 1904,
            endYear: 1916,
        }, "unanimousRemote")?.window).toEqual({
            startYear: 1910,
            endYear: 1922,
        });
    });

    it("accepts a tightly bounded family consensus after anchor arbitration", () => {
        expect(selectFalseRingFamilyMode({
            eventType: "falseRing",
            years,
            ranks,
            internalCandidates: [],
            coarseWindow: { startYear: 1904, endYear: 1928 },
            currentPrimaryYear: 1913,
        }, {
            startYear: 1908,
            endYear: 1920,
        }, "boundedConsensus")?.window).toEqual({
            startYear: 1910,
            endYear: 1922,
        });
    });

    it.each(["missingRing", "falseRing"] as const)(
        "accepts the cross-split validated remote mode for %s",
        (eventType) => {
            const remoteProfile = years.map((year) => (
                year >= 1920 && year <= 1932 ? 1 : 0
            ));
            const remoteRanks = new Map<string, readonly number[]>([
                ["cumulativeCombined", remoteProfile],
                ["transitionSplitGain", remoteProfile],
                ["pairDifferenceWeighted", remoteProfile],
                ["reference:rankMean", remoteProfile],
            ]);
            expect(selectFalseRingFamilyMode({
                eventType,
                years,
                ranks: remoteRanks,
                internalCandidates: [],
                coarseWindow: { startYear: 1900, endYear: 1940 },
                currentPrimaryYear: 1926,
            }, {
                startYear: 1900,
                endYear: 1912,
            }, "validatedRemote")?.window).toEqual({
                startYear: 1920,
                endYear: 1932,
            });
        },
    );
});
