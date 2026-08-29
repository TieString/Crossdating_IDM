import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stopMarker } from "@/shared/constants";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import {
    formatCofecha606JsReport,
    generateCofecha606JsReport,
} from "../jsReport";

const width = (index: number, seriesIndex: number) => {
    const shared = 950
        + 170 * Math.sin(index * 0.41)
        + 85 * Math.cos(index * 0.17)
        + 55 * Math.sin(index * 1.07);
    const growth = 1.65 - 0.0032 * index + 0.000004 * index ** 2;
    const individual = 1
        + 0.08 * Math.sin(index * 0.071 + seriesIndex * 0.8)
        + 0.03 * Math.cos(index * 0.23 + seriesIndex);
    const rounded = Math.max(1, Math.round(
        shared * growth * individual * (0.72 + seriesIndex * 0.11),
    ));
    return rounded === 999 || rounded === 9999 ? rounded + 2 : rounded;
};

const buildVariedSite = (): RwlSiteData => new Map(
    Array.from({ length: 6 }, (_, seriesIndex) => {
        const tree: RwlTreeData = new Map(
            Array.from({ length: 200 }, (_, index) => [
                1800 + index,
                width(index, seriesIndex),
            ]),
        );
        return [`VAR00${seriesIndex + 1}`, tree];
    }),
);

describe("COFECHA 6.06 JS report Parts 1-4", () => {
    let previousStopMarker: number;

    beforeEach(() => {
        previousStopMarker = stopMarker.value;
        stopMarker.value = -9999;
    });

    afterEach(() => {
        stopMarker.value = previousStopMarker;
    });

    it("uses real run metadata and exact Master/depth content", () => {
        const runAt = new Date("2026-08-29T12:34:56.000Z");
        const report = generateCofecha606JsReport(buildVariedSite(), {
            jobName: "FULL",
            inputFileName: "varied-six.rwl",
            title: "Parity fixture",
            runAt,
        });

        expect(report.run).toEqual({
            jobName: "FULL",
            inputFileName: "varied-six.rwl",
            title: "Parity fixture",
            runAtIso: runAt.toISOString(),
        });
        expect(report.completedParts).toEqual([2, 3, 4]);
        expect(report.pendingParts).toEqual([1, 5, 6, 7]);
        expect(report.part1.datedSeriesCount).toBe(6);
        expect(report.part1.totalRings).toBe(1200);
        expect(report.part1.totalDatedRingsChecked).toBe(1200);
        expect(report.part1.averageMeanSensitivity?.toFixed(3)).toBe("0.056");
        expect(report.part1.masterTimeSpan).toEqual({
            startYear: 1800,
            endYear: 1999,
            years: 200,
        });
        expect(report.part1.continuousTimeSpan).toEqual(
            report.part1.masterTimeSpan,
        );
        expect(report.part1.twoOrMoreSeriesSpan).toEqual(
            report.part1.masterTimeSpan,
        );
        expect(report.part2.series).toHaveLength(6);
        expect(report.part3.years).toHaveLength(200);
        expect(report.part3.years.every((row) => row.sampleDepth === 6)).toBe(true);
        expect(report.part3.years[0].value.toFixed(4)).toBe("-1.2031");
        expect(report.part3.years[199].value.toFixed(4)).toBe("0.6673");
        expect(report.part4.bars).toHaveLength(200);
        const firstStats = report.part7.series[0];
        expect(firstStats.segmentCount).toBe(7);
        expect(firstStats.unfiltered.mean.toFixed(2)).toBe("0.96");
        expect(firstStats.unfiltered.maximum.toFixed(2)).toBe("1.48");
        expect(firstStats.unfiltered.standardDeviation.toFixed(3)).toBe("0.193");
        expect(firstStats.unfiltered.lagOneAutocorrelation.toFixed(3)).toBe("0.942");
        expect(firstStats.meanSensitivity.toFixed(3)).toBe("0.056");
        expect(firstStats.filtered.maximum.toFixed(2)).toBe("2.51");
        expect(firstStats.filtered.standardDeviation.toFixed(3)).toBe("0.155");
        expect(firstStats.filtered.lagOneAutocorrelation.toFixed(3)).toBe("0.152");
        expect(firstStats.arOrder).toBe(5);
        expect(report.part7.totals.segmentCount).toBe(42);

        const text = formatCofecha606JsReport(report);
        expect(text).toContain("Run FULL");
        expect(text).toContain("2026-08-29T12:34:56.000Z");
        expect(text).toContain("File of DATED series: varied-six.rwl");
        expect(text).toContain("PART 1: OPTIONS AND SUMMARY");
        expect(text).toContain("PART 4: MASTER BAR DATA");
    });

    it("keeps repeated same-ID segments independent in Part 2", () => {
        const site: RwlSiteData = new Map([
            ["SEG001", new Map<number, number | null>([
                [1800, 100], [1801, 110], [1802, 90], [1803, 105], [1804, 999],
                [1900, 1200], [1901, 900], [1902, 1100], [1903, 1000], [1904, -9999],
            ])],
            ["REF001", new Map<number, number | null>(
                Array.from({ length: 104 }, (_, index) => [1800 + index, 800 + index]),
            )],
        ]);
        const report = generateCofecha606JsReport(site, {
            jobName: "MIXED",
            inputFileName: "mixed.rwl",
        });
        const segments = report.part2.series.filter((row) => row.seriesId === "SEG001");
        expect(segments).toEqual([
            expect.objectContaining({ segmentIndex: 1, startYear: 1800, endYear: 1803 }),
            expect.objectContaining({ segmentIndex: 2, startYear: 1900, endYear: 1903 }),
        ]);
    });
});
