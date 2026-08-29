import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stopMarker } from "@/shared/constants";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import {
    COFECHA_REFERENCE_DEFAULT_OPTIONS,
    buildCofecha606MasterSeries,
    cofecha606AutoregressiveResidual,
    cofechaStyleStandardize,
    formatCofecha606MasterSeries,
} from "../reference";

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

describe("COFECHA 6.06 exact master builder", () => {
    let previousStopMarker: number;

    beforeEach(() => {
        previousStopMarker = stopMarker.value;
        stopMarker.value = -9999;
    });

    afterEach(() => {
        stopMarker.value = previousStopMarker;
    });

    it("matches captured FULLCOF.MAS values, depth, and text formatting", () => {
        const master = buildCofecha606MasterSeries(buildVariedSite());
        expect(master).not.toBeNull();
        expect(master!.data.size).toBe(200);
        expect(master!.sampleDepth.size).toBe(200);
        expect([...master!.sampleDepth.values()].every((depth) => depth === 6)).toBe(true);
        const expected = new Map([
            [1800, "-1.2031"],
            [1801, "0.3172"],
            [1850, "1.1780"],
            [1899, "-0.0498"],
            [1900, "-0.1252"],
            [1950, "-1.2261"],
            [1999, "0.6673"],
        ]);
        expected.forEach((value, year) => {
            expect(master!.data.get(year)?.toFixed(4)).toBe(value);
        });
        const text = formatCofecha606MasterSeries(master!);
        expect(text.split("\r\n")[0]).toBe("  1800   -1.2031");
        expect(text.split("\r\n").filter(Boolean)).toHaveLength(200);
    });

    it("keeps AR modeling out of the saved chronology", () => {
        const site = buildVariedSite();
        const withAr = buildCofecha606MasterSeries(site, {
            ...COFECHA_REFERENCE_DEFAULT_OPTIONS,
            useAutoregressiveModel: true,
        });
        const withoutAr = buildCofecha606MasterSeries(site, {
            ...COFECHA_REFERENCE_DEFAULT_OPTIONS,
            useAutoregressiveModel: false,
        });
        expect(withAr?.data).toEqual(withoutAr?.data);
    });

    it("selects the captured first local AIC minimum for Burg AR", () => {
        const firstTree = buildVariedSite().get("VAR001")!;
        const filtered = cofechaStyleStandardize(firstTree, {
            ...COFECHA_REFERENCE_DEFAULT_OPTIONS,
            useAutoregressiveModel: false,
            useLogTransform: false,
            omitAbsentRingsFromMaster: false,
        }, "ltrr-cook-holmes", "none", 1, "ratio", "post-ar", "legacy-float32");
        const model = cofecha606AutoregressiveResidual(
            filtered.map((point) => point.value),
        );
        expect(model.order).toBe(5);
        const expected = [
            3.260730743408203,
            -5.093754768371582,
            4.665992259979248,
            -2.4585533142089844,
            0.5429986119270325,
        ];
        model.coefficients.forEach((coefficient, index) => {
            expect(coefficient).toBeCloseTo(expected[index], 5);
        });
        expect(model.residuals).toHaveLength(200);
    });
});
