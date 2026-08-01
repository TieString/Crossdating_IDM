import { describe, expect, it } from "vitest";
import { selectAdaptiveCounterfactualWindow } from "../adaptiveWindowRisk";

const years = Array.from({ length: 35 }, (_, index) => 1800 + index);

const peakProfile = (peakYear: number, radius: number): number[] => years.map(
    (year) => Math.max(0, 1 - Math.abs(year - peakYear) / radius),
);

describe("adaptive counterfactual review window", () => {
    it.each([
        {
            eventType: "missingRing" as const,
            profileNames: [
                "cumulativeCombined",
                "cumulativeReferenceVote",
                "differenceFull",
            ],
        },
        {
            eventType: "falseRing" as const,
            profileNames: [
                "cumulativeLocal31",
                "transitionSplitGain",
                "cumulativeLocal61",
            ],
        },
        {
            eventType: "partialMove" as const,
            profileNames: [
                "cumulativeDifference",
                "cumulativeReferenceMean",
                "cumulativeReferenceVote",
            ],
        },
    ])("returns one bounded calibrated window for $eventType", ({
        eventType,
        profileNames,
    }) => {
        const ranks = new Map(profileNames.map((profile, index) => [
            profile,
            peakProfile(1816 + index, 8 + index),
        ]));
        const input = {
            eventType,
            years,
            profileNames,
            ranks,
            coarseWindow: { startYear: 1804, endYear: 1828 },
            coarseSource: "lag_transition",
            internalCandidates: [
                { startYear: 1804, endYear: 1828, source: "lag_transition" },
                {
                    startYear: 1806,
                    endYear: 1830,
                    source: "reference_transition:rankMean",
                },
                { startYear: 1805, endYear: 1829, source: "current_event" },
            ],
            currentPrimaryYear: 1817,
            currentWindow: { startYear: 1814, endYear: 1820 },
        };
        const first = selectAdaptiveCounterfactualWindow(input);
        const second = selectAdaptiveCounterfactualWindow(input);

        expect(first).toEqual(second);
        expect(first).not.toBeNull();
        if (!first) throw new Error("expected an adaptive review window");
        expect([9, 13, 17, 25]).toContain(first.width);
        expect(first.window.endYear - first.window.startYear + 1).toBe(first.width);
        expect(first.window.startYear).toBeGreaterThanOrEqual(
            input.coarseWindow.startYear,
        );
        expect(first.window.endYear).toBeLessThanOrEqual(
            input.coarseWindow.endYear,
        );
        expect(first.risk).toBeGreaterThanOrEqual(0);
        expect(first.risk).toBeLessThanOrEqual(1);
    });

    it("declines a coarse region that cannot contain the wide calibrated window", () => {
        expect(selectAdaptiveCounterfactualWindow({
            eventType: "missingRing",
            years,
            profileNames: ["cumulativeCombined"],
            ranks: new Map([["cumulativeCombined", peakProfile(1816, 8)]]),
            coarseWindow: { startYear: 1810, endYear: 1820 },
            coarseSource: "lag_transition",
            internalCandidates: [],
            currentWindow: { startYear: 1812, endYear: 1818 },
        })).toBeNull();
    });
});
