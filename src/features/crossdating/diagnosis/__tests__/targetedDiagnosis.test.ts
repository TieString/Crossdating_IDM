import { describe, expect, it } from "vitest";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import { diagnoseCrossdating } from "../engine";

const baseValue = (year: number) => (
    180
    + 42 * Math.sin(year * 0.31)
    + 27 * Math.cos(year * 0.13)
    + 13 * Math.sin(year * 0.071)
);

const makeSeries = (
    offset: number,
    valueForYear: (year: number) => number = baseValue,
): RwlTreeData => new Map(
    Array.from({ length: 180 }, (_, index) => {
        const year = 1820 + index;
        return [year, Math.max(1, valueForYear(year) + offset * Math.sin(year * 0.17 + offset))];
    }),
);

const makeSite = (): RwlSiteData => new Map([
    ["TARGET", makeSeries(1, (year) => baseValue(year <= 1900 ? year + 1 : year))],
    ["REF01", makeSeries(2)],
    ["REF02", makeSeries(3)],
    ["REF03", makeSeries(4)],
    ["REF04", makeSeries(5)],
]);

describe("targeted crossdating diagnosis", () => {
    it("matches the target slice of a full-site diagnosis exactly", () => {
        const site = makeSite();
        const full = diagnoseCrossdating(site, { referenceConfig: null });
        const targeted = diagnoseCrossdating(site, {
            referenceConfig: null,
            targetTrees: ["TARGET"],
        });

        expect(targeted.seriesCount).toBe(1);
        expect(targeted.summaries).toEqual(
            full.summaries.filter((summary) => summary.tree === "TARGET"),
        );
        expect(targeted.segments).toEqual(
            full.segments.filter((segment) => segment.targetTree === "TARGET"),
        );
        expect(targeted.propagationPatterns).toEqual(
            full.propagationPatterns.filter((pattern) => pattern.targetTree === "TARGET"),
        );
        expect(targeted.globalSlidingMatches).toEqual(
            full.globalSlidingMatches.filter((match) => match.seriesId === "TARGET"),
        );
        expect(targeted.candidates).toEqual(
            full.candidates.filter((candidate) => candidate.targetTree === "TARGET"),
        );
        expect(targeted.events).toEqual(
            full.events.filter((event) => event.seriesId === "TARGET"),
        );
        expect(targeted.masterNarrowYears).toEqual([]);
    });
});
