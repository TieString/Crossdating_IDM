import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    pickCalendarYearIndependentOfSignal,
    pickMixedEventCalendarAnchors,
    pickStratifiedCalendarYear,
    type RwlSeries,
} from "./rdmFixture";

const buildSeries = (valueForYear: (year: number) => number): RwlSeries => {
    const valuesByYear = new Map<number, number>();
    for (let year = 1800; year <= 1999; year += 1) {
        valuesByYear.set(year, valueForYear(year));
    }
    return {
        id: "TEST",
        valuesByYear,
        startYear: 1800,
        endYear: 1999,
        length: valuesByYear.size,
        zeroCount: 0,
        nonZeroCount: valuesByYear.size,
    };
};

describe("value-independent benchmark year sampling", () => {
    it("does not change when every ring width changes", () => {
        const first = buildSeries((year) => year - 1700);
        const second = buildSeries((year) => 10_000 - (year - 1800) ** 2);

        for (let index = 0; index < 15; index += 1) {
            expect(pickStratifiedCalendarYear(first, index, `case-${index}`))
                .toEqual(pickStratifiedCalendarYear(second, index, `case-${index}`));
        }
        expect(pickCalendarYearIndependentOfSignal(first, "bounded", {
            lo: 1860,
            hi: 1880,
        })).toBe(pickCalendarYearIndependentOfSignal(second, "bounded", {
            lo: 1860,
            hi: 1880,
        }));
    });

    it("balances all five position strata with observable context on both sides", () => {
        const series = buildSeries((year) => year);
        const selections = Array.from({ length: 25 }, (_, index) => (
            pickStratifiedCalendarYear(series, index, `case-${index}`, 18)
        ));

        expect(selections.every((selection) => selection !== null)).toBe(true);
        const selected = selections.filter((selection) => selection !== null);
        expect(new Set(selected.map((selection) => selection.positionStratum))).toEqual(new Set([
            "olderEdge",
            "olderInterior",
            "middle",
            "newerInterior",
            "newerEdge",
        ]));
        selected.forEach((selection) => {
            expect(selection.olderContextYears).toBeGreaterThanOrEqual(18);
            expect(selection.newerContextYears).toBeGreaterThanOrEqual(18);
        });
    });

    it("keeps mixed-event anchors unchanged when ring widths and local signal change", () => {
        const first = buildSeries((year) => (
            500 + Math.sin(year / 3) * 200
        ));
        const second = buildSeries((year) => (
            year % 17 === 0 ? 1 : (year - 1899) ** 2 + 10
        ));

        for (let index = 0; index < 12; index += 1) {
            const seed = `mixed-case-${index}`;
            expect(pickMixedEventCalendarAnchors(first, seed))
                .toEqual(pickMixedEventCalendarAnchors(second, seed));
        }
    });

    it("keeps the exploratory oracle out of every formal event benchmark", () => {
        [
            "./itrdbBenchmark.test.ts",
            "./eventBaseline.test.ts",
            "./eventMixed.experiment.test.ts",
        ].forEach((relativePath) => {
            const source = readFileSync(
                fileURLToPath(new URL(relativePath, import.meta.url)),
                "utf8",
            );
            expect(source).not.toMatch(/\bpickExploratoryStrongSignalYear\b/);
        });
    });

    it("keeps every consumed blind offset out of collection and model analysis", () => {
        [
            "../../../../../scripts/collect-unbiased-window-ranker.mjs",
            "../../../../../scripts/analyze-unbiased-window-ranker.mjs",
            "../../../../../scripts/train-unbiased-window-ranker.mjs",
            "../../../../../scripts/train-unbiased-exact-year-forest.mjs",
        ].forEach((relativePath) => {
            const source = readFileSync(
                fileURLToPath(new URL(relativePath, import.meta.url)),
                "utf8",
            );
            expect(source).toContain("[13, 14, 15, 16, 17, 18, 19, 20]");
            expect(source).toContain("Offsets 13-20 are consumed blind evaluations");
        });
    });
});
