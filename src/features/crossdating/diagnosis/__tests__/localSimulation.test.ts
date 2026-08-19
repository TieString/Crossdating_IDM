import { describe, expect, it } from "vitest";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl";
import {
    applyLocalCrossdatingOption,
    simulateDiagnosisEventPreview,
    tryApplyLocalCrossdatingOption,
} from "../engine";
import type { DiagnosisEvent, LocalSimulationOption } from "../types";

const option = (
    operationType: LocalSimulationOption["operationType"],
    extra: Pick<LocalSimulationOption, "side" | "shift"> = {},
): LocalSimulationOption => ({
    operationType,
    label: operationType,
    currentCorrelation: 0.2,
    simulatedCorrelation: 0.6,
    delta: 0.4,
    confidence: "high",
    reason: "test",
    ...extra,
});

const shortSeries: RwlTreeData = new Map([
    [1899, 10],
    [1900, 20],
    [1901, 30],
    [1902, 40],
    [1903, 50],
]);

describe("local chart simulation", () => {
    it("uses the same explicitly recorded older-side range for preview and apply", () => {
        const simulation = {
            year: 1902,
            selectedStartYear: 1899,
            selectedEndYear: 1902,
        };
        const shifted = applyLocalCrossdatingOption(
            shortSeries,
            simulation,
            option("SHIFT_RANGE", { shift: -1 }),
        );

        expect(Array.from(shifted.entries())).toEqual([
            [1898, 10],
            [1899, 20],
            [1900, 30],
            [1901, 40],
            [1903, 50],
        ]);
    });

    it("keeps insert/delete semantics on the clicked boundary and older side", () => {
        const simulation = {
            year: 1902,
            selectedStartYear: 1899,
            selectedEndYear: 1902,
        };
        const inserted = applyLocalCrossdatingOption(
            shortSeries,
            simulation,
            option("INSERT_MISSING_RING", { side: "right" }),
        );
        expect(inserted.get(1902)).toBe(0);
        expect(inserted.get(1901)).toBe(40);
        expect(inserted.get(1903)).toBe(50);

        const deleted = applyLocalCrossdatingOption(
            shortSeries,
            simulation,
            option("DELETE_FALSE_RING", { side: "right" }),
        );
        expect(deleted.get(1902)).toBe(30);
        expect(deleted.get(1903)).toBe(50);
    });

    it("drops a stale range preview after the same move has already changed working data", () => {
        const simulation = {
            year: 1903,
            selectedStartYear: 1899,
            selectedEndYear: 1902,
        };
        const shiftOption = option("SHIFT_RANGE", { shift: -1 });
        const moved = applyLocalCrossdatingOption(shortSeries, simulation, shiftOption);

        expect(tryApplyLocalCrossdatingOption(moved, simulation, shiftOption)).toBeNull();
    });

    it("previews the final partial move at either the primary or an explicit review year", () => {
        const site: RwlSiteData = new Map();
        for (let seriesIndex = 0; seriesIndex < 7; seriesIndex += 1) {
            const tree: RwlTreeData = new Map();
            for (let year = 1800; year <= 1920; year += 1) {
                const signal = 500
                    + Math.sin(year / 4.3) * 120
                    + Math.cos(year / 9.7) * 60;
                tree.set(year, Math.round(signal + seriesIndex * 3));
            }
            site.set(seriesIndex === 0 ? "TARGET" : `REF${seriesIndex}`, tree);
        }

        const event: DiagnosisEvent = {
            id: "partial-final",
            seriesId: "TARGET",
            eventType: "partialMove",
            startYear: 1856,
            endYear: 1864,
            rankedYears: [{
                year: 1860,
                rank: 1,
                score: 1,
                evidenceTags: ["joint_year_operation_evidence"],
            }],
            confidenceLevel: "high",
            evidence: {
                algorithmSources: ["joint_year_operation_evidence"],
                score: 1,
                scoreMargin: 0.2,
                baselineCorrelation: 0.2,
                correctedCorrelation: 0.8,
                correlationGain: 0.6,
                lagBefore: -4,
                lagAfter: 0,
                samplePairs: 30,
                candidateIds: [],
                notes: [],
            },
            alternativeTypes: [],
            shiftYears: -4,
            shiftSide: "older",
        };
        const simulation = simulateDiagnosisEventPreview(site, event);
        expect(simulation).not.toBeNull();
        expect(simulation?.sourceEventId).toBe(event.id);
        expect(simulation?.selectedStartYear).toBe(1800);
        expect(simulation?.selectedEndYear).toBe(1859);
        expect(simulation?.displayYear).toBe(1860);
        expect(simulation?.options).toHaveLength(1);
        expect(simulation?.bestOption.operationType).toBe("SHIFT_RANGE");
        expect(simulation?.bestOption.shift).toBe(-4);

        const selectedYearSimulation = simulateDiagnosisEventPreview(site, event, {
            previewYear: 1858,
        });
        expect(selectedYearSimulation).not.toBeNull();
        expect(selectedYearSimulation?.year).toBe(1858);
        expect(selectedYearSimulation?.displayYear).toBe(1858);
        expect(selectedYearSimulation?.selectedEndYear).toBe(1857);
        expect(selectedYearSimulation?.bestOption.label).toContain("断点 1858");
        expect(event.rankedYears[0]?.year).toBe(1860);

        expect(simulateDiagnosisEventPreview(site, event, {
            previewYear: 1855,
        })).toBeNull();
    });
});
