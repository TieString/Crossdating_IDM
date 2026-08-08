import { describe, expect, it } from "vitest";
import { deleteYearWithMode } from "@/features/rwl/edit";
import {
    createEndAnchoredFalseRingCase,
    createPiecewiseLagMixedCase,
    type RwlSeries,
} from "./rdmFixture";

const series = (): RwlSeries => ({
    id: "TEST01",
    startYear: 1900,
    endYear: 1908,
    valuesByYear: new Map([
        [1900, 80],
        [1901, 90],
        [1902, 100],
        [1903, 110],
        [1904, 120],
        [1905, 130],
        [1906, 140],
        [1907, 150],
        [1908, 160],
    ]),
    nonZeroCount: 9,
    zeroCount: 0,
    length: 9,
});

describe("RDM false-ring fixtures", () => {
    it("splits one physical ring without increasing its total width", () => {
        const source = series();
        const injected = createEndAnchoredFalseRingCase(source, 1904, "splitLike");

        expect(injected.corrupted.get(1903)).toBe(66);
        expect(injected.corrupted.get(1904)).toBe(54);
        expect(
            (injected.corrupted.get(1903) ?? 0)
            + (injected.corrupted.get(1904) ?? 0),
        ).toBe(source.valuesByYear.get(1904));
    });

    it("recovers a split-like false ring by merging it into the older segment", () => {
        const source = series();
        const injected = createEndAnchoredFalseRingCase(source, 1904, "splitLike");
        const restored = deleteYearWithMode(
            injected.corrupted,
            1904,
            "left",
            "right",
        );

        expect([...restored.entries()]).toEqual([...source.valuesByYear.entries()]);
    });

    it.each(["average", "moderate"] as const)(
        "keeps %s as a directly deletable inserted ring",
        (mode) => {
            const source = series();
            const injected = createEndAnchoredFalseRingCase(source, 1904, mode);
            const restored = deleteYearWithMode(
                injected.corrupted,
                1904,
                "direct",
                "right",
            );

            expect([...restored.entries()]).toEqual([...source.valuesByYear.entries()]);
        },
    );

    it.each([
        ["older-to-newer", [1903, 1906]],
        ["newer-to-older", [1906, 1904]],
    ] as const)(
        "round-trips two false rings in %s confirmation order",
        (_label, deletionYears) => {
            const source = series();
            let restored = createPiecewiseLagMixedCase(source, [{
                eventType: "falseRing",
                year: 1903,
                shiftYears: 1,
                falseMode: "moderate",
            }, {
                eventType: "falseRing",
                year: 1906,
                shiftYears: 1,
                falseMode: "moderate",
            }]).corrupted;

            deletionYears.forEach((year) => {
                restored = deleteYearWithMode(restored, year, "direct", "right");
            });

            expect([...restored.entries()]).toEqual([...source.valuesByYear.entries()]);
        },
    );
});
