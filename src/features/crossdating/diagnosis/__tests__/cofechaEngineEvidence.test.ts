import { describe, expect, it } from "vitest";
import { prepareCofecha606SeriesForReport } from "cofecha-js";
import { CofechaEngineEvidenceCache } from "../cofechaEngineEvidence";
import type { RwlSiteData } from "../../../rwl/types";

const fixture = (): RwlSiteData => new Map(["target", "ref-a", "ref-b"].map((id, core) => [
    id,
    new Map([
        ...Array.from({ length: 150 }, (_, index): [number, number] => [
            1850 + index,
            index === 50 ? 0 : Math.round(120 + 15 * Math.sin(index * 1.731) + 4 * Math.cos(index * (core + 1))),
        ]),
        [2000, 999],
    ]),
]));

describe("cofecha-js report-chain evidence", () => {
    it("uses the exact report testing values and excludes zero years only after preprocessing", () => {
        const site = fixture();
        const actual = new CofechaEngineEvidenceCache().build(site, "target", 999)!;
        const expected = prepareCofecha606SeriesForReport(site, {
            splineRigidityYears: 32, splineFrequencyResponse: 0.5,
            segmentLength: 50, segmentLag: 25,
            useAutoregressiveModel: true, useLogTransform: true, useFirstDifference: false,
            segmentGridStartYear: -10000, segmentGridEndYear: 10000,
            analysisStartYear: -10000, analysisEndYear: 10000,
        });
        const reference = expected.find((row) => row.segment.seriesId === "ref-a")!;
        expect(actual.referenceIds).toEqual(["ref-a", "ref-b"]);
        expect(actual.sample.references[0]!.get(1901)).toBe(reference.testingValues[51]);
        expect(actual.sample.references[0]!.has(1900)).toBe(false);
        expect(actual.sample.target.has(1900)).toBe(false);
        expect(actual.sample.target.has(1850)).toBe(true);
        expect(actual.sample.target.has(2000)).toBe(false);
        expect(actual.referenceDepth.get(1901)).toBe(2);
        expect(actual.referenceDepth.has(1900)).toBe(false);
    });

    it("reuses equal content and invalidates only the edited core", () => {
        const cache = new CofechaEngineEvidenceCache();
        const site = fixture();
        cache.build(site, "target", 999);
        expect(cache.stats).toEqual({ coreHits: 0, coreMisses: 3 });
        const equal = new Map([...site].map(([id, tree]) => [id, new Map(tree)]));
        cache.build(equal, "target", 999);
        expect(cache.stats).toEqual({ coreHits: 3, coreMisses: 3 });
        equal.get("target")!.set(1950, 77);
        cache.build(equal, "target", 999);
        expect(cache.stats).toEqual({ coreHits: 5, coreMisses: 4 });
    });

    it("retains frequently reused reference cores during many target edits", () => {
        const cache = new CofechaEngineEvidenceCache(4);
        const site = fixture();
        for (let trial = 0; trial < 12; trial += 1) {
            site.get("target")!.set(1950, 70 + trial);
            cache.build(site, "target", 999);
        }
        expect(cache.stats.coreMisses).toBe(14);
        expect(cache.stats.coreHits).toBe(22);
    });

    it("preserves precision when an edited target has no marker", () => {
        const site = fixture();
        const cache = new CofechaEngineEvidenceCache();
        const marked = cache.build(site, "target", 999)!;
        site.get("target")!.delete(2000);
        const unmarked = cache.build(site, "target", 999)!;
        expect([...unmarked.sample.target]).toEqual([...marked.sample.target]);
    });

    it("prepares a virtual target identically without rebuilding frozen references", () => {
        const site = fixture();
        const cache = new CofechaEngineEvidenceCache(512, true);
        const sample = cache.build(site, "target", 999)!;
        expect([...cache.buildTarget("target", site.get("target")!, 999)]).toEqual([...sample.sample.target]);
        expect(cache.stats).toEqual({ coreHits: 1, coreMisses: 3 });
    });

    it("whole shifts preserve all testing values exactly", () => {
        const tree = fixture().get("target")!;
        const cache = new CofechaEngineEvidenceCache(512, true);
        const base = cache.buildTarget("target", tree, 999);
        for (const shift of [-100, -37, -1, 1, 37, 100]) {
            const corrected = cache.buildTarget("target", new Map([...tree].map(([year, width]) => [year + shift, width])), 999);
            expect([...corrected]).toEqual([...base].map(([year, value]) => [year + shift, value]));
        }
    });

    it("partial magnitudes reuse an actually split preprocessing result exactly", () => {
        const tree = fixture().get("target")!;
        const cache = new CofechaEngineEvidenceCache(512, true);
        const boundary = 1940;
        const shifted = (shift: number) => new Map([...tree].map(([year, width]) => [year < boundary ? year + shift : year, width]));
        const base = cache.buildTarget("target", shifted(-2), 999);
        for (const shift of [-3, -5, -17, -50, -100]) {
            const actual = cache.buildTarget("target", shifted(shift), 999);
            const expected = [...base].map(([year, value]) => [year < boundary ? year + shift + 2 : year, value]);
            expect([...actual]).toEqual(expected);
        }
    });

    it("preserves precision independently for disjoint segments", () => {
        const site = fixture();
        site.forEach((tree) => {
            for (let year = 1901; year < 1940; year += 1) tree.delete(year);
            tree.set(1901, 999);
        });
        const cache = new CofechaEngineEvidenceCache();
        const marked = cache.build(site, "target", 999)!;
        site.forEach((tree) => {
            tree.delete(1901);
            tree.delete(2000);
        });
        const unmarked = cache.build(site, "target", 999)!;
        expect([...unmarked.sample.target]).toEqual([...marked.sample.target]);
        expect([...unmarked.sample.master]).toEqual([...marked.sample.master]);
    });
});
