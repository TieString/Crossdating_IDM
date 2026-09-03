import { describe, expect, it } from "vitest";
import { prepareCofecha606SeriesForReport } from "cofecha-js";
import { normalizeCofechaInputUnits, normalizeCofechaRuntimeUnits } from "../cofechaInputUnits";
import { CofechaEngineEvidenceCache } from "../cofechaEngineEvidence";
import type { RwlSiteData } from "../../../rwl/types";

describe("mixed-precision physical RWL input", () => {
    it("carries known precision through an unterminated edited target without rescaling its widths", () => {
        const raw: RwlSiteData = new Map([["target", new Map([[1900, 121], [1901, 999], [1910, 137]])]]);
        const prepared = normalizeCofechaRuntimeUnits(raw, -9999).get("target")!;
        expect([...prepared]).toEqual([[1900, 121], [1901, 999], [1902, -9999], [1910, 137], [1911, -9999]]);
        expect([...raw.get("target")!]).toEqual([[1900, 121], [1901, 999], [1910, 137]]);
        const lowerPrecision = normalizeCofechaRuntimeUnits(new Map([["target", new Map([[1900, 121]])]]), 999);
        expect(lowerPrecision.get("target")!.get(1900)).toBe(1210);
        const endpoint = normalizeCofechaRuntimeUnits(new Map([["target", new Map([[1900, 121], [1901, 999]])]]), -9999);
        expect([...endpoint.get("target")!]).toEqual([[1900, 121], [1901, 999], [1902, -9999]]);
    });
    const source = (): RwlSiteData => new Map([999, -9999].map((marker, index) => [
        `s${index}`, new Map([
            ...Array.from({ length: 150 }, (_, i): [number, number] => [1900 + i, 100 + (i * 13) % 70]),
            [2050, marker],
        ]),
    ]));

    it("preserves physical values within float32 rounding and strips neither precision incorrectly", () => {
        const options = {
            splineRigidityYears: 32, splineFrequencyResponse: 0.5, segmentLength: 50,
            segmentLag: 25, useAutoregressiveModel: true, useLogTransform: true,
            useFirstDifference: false, segmentGridStartYear: -10000, segmentGridEndYear: 10000,
            analysisStartYear: -10000, analysisEndYear: 10000,
        };
        const raw = source();
        const normalized = normalizeCofechaInputUnits(raw);
        const before = prepareCofecha606SeriesForReport(raw, options);
        const after = prepareCofecha606SeriesForReport(normalized, options);
        expect(after.map((part) => part.years)).toEqual(before.map((part) => part.years));
        after.forEach((part, i) => {
            const rawError = Math.max(...part.rawValues.map((value, j) => Math.abs(value - before[i]!.rawValues[j]!)));
            const testingError = Math.max(...part.testingValues.map((value, j) => Math.abs(value - before[i]!.testingValues[j]!)));
            expect(rawError).toBeLessThan(2e-7);
            // Legacy float32 parsing rounds F6.2 and F6.3 differently; spline/AR
            // propagate those ulps. This is not a bit-identity assertion.
            expect(testingError).toBeLessThan(1e-4);
        });
        expect(raw.get("s0")!.get(2050)).toBe(999);
        expect(normalized.get("s0")!.get(2050)).toBe(-9999);
    });

    it("keeps a real 999 width at an edited endpoint or segment edge", () => {
        const site = normalizeCofechaInputUnits(source());
        const target = site.get("s0")!;
        target.set(2049, 999);
        target.set(1969, 999);
        for (let y = 1970; y < 1980; y += 1) target.delete(y);
        const cache = new CofechaEngineEvidenceCache(512, true);
        const marked = cache.build(site, "s0", -9999)!;
        target.delete(2050);
        const unmarked = cache.build(site, "s0", -9999)!;
        expect(unmarked.sample.target.has(2049)).toBe(true);
        expect(unmarked.sample.target.has(1969)).toBe(true);
        expect([...unmarked.sample.target]).toEqual([...marked.sample.target]);
    });
});
