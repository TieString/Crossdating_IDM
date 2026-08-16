import { afterEach, describe, expect, it } from "vitest";
import {
    buildTreeRingGeometry,
    clearTreeRingArtworkCache,
    getTreeRingFeature,
    getTreeRingFeatureAtRadius,
    renderTreeRingSvg,
    rwlWidthToMillimetres,
} from "./treeRingArtwork";

describe("tree-ring artwork geometry", () => {
    afterEach(() => clearTreeRingArtworkCache());

    it("uses the Python source conversion of one RWL unit to 0.001 mm", () => {
        expect(rwlWidthToMillimetres(2572)).toBeCloseTo(2.572, 12);
        expect(rwlWidthToMillimetres(3113)).toBeCloseTo(3.113, 12);
    });

    it("sorts years, skips null/stop values, and keeps zero-width missing rings", () => {
        const geometry = buildTreeRingGeometry(new Map([
            [2004, 0],
            [2002, 500],
            [2000, 1000],
            [2001, null],
            [2003, -9999],
        ]));

        expect(geometry).not.toBeNull();
        expect(geometry?.rings).toEqual([
            { year: 2000, widthMm: 1, outerRadiusMm: 1 },
            { year: 2002, widthMm: 0.5, outerRadiusMm: 1.5 },
            { year: 2004, widthMm: 0, outerRadiusMm: 1.5 },
        ]);
        expect(geometry?.diameterMm).toBe(3);
        expect(geometry?.windowHeightMm).toBe(3);
        expect(geometry?.gaps).toEqual([
            { startYear: 2001, endYear: 2001, yearCount: 1, radiusMm: 1 },
            { startYear: 2003, endYear: 2003, yearCount: 1, radiusMm: 1.5 },
        ]);
    });

    it("represents a bounded middle-year gap without inventing physical radius", () => {
        const geometry = buildTreeRingGeometry(new Map([
            [1900, 1000],
            [1901, null],
            [1904, 500],
            [1905, 0],
        ]));
        expect(geometry).not.toBeNull();
        if (!geometry) return;

        expect(geometry.gaps).toEqual([
            { startYear: 1901, endYear: 1903, yearCount: 3, radiusMm: 1 },
        ]);
        expect(geometry.radiusMm).toBe(1.5);
        expect(getTreeRingFeature(geometry, 1902)).toMatchObject({
            kind: "gap",
            startYear: 1901,
            endYear: 1903,
            centreRadiusMm: 1,
        });
        expect(getTreeRingFeatureAtRadius(geometry, 1, 0.01)).toMatchObject({ kind: "gap" });
        expect(getTreeRingFeatureAtRadius(geometry, 1.25)).toMatchObject({
            kind: "ring",
            startYear: 1904,
        });
        expect(getTreeRingFeatureAtRadius(geometry, 1.5, 0.01)).toMatchObject({
            kind: "ring",
            startYear: 1905,
            innerRadiusMm: 1.5,
            outerRadiusMm: 1.5,
        });
    });

    it("reproduces the cumulative physical radius from the supplied Python sample", () => {
        const geometry = buildTreeRingGeometry(new Map([
            [1870, 2572],
            [1871, 3113],
            [1872, 2819],
        ]));

        expect(geometry?.radiusMm).toBeCloseTo(8.504, 12);
        expect(geometry?.diameterMm).toBeCloseTo(17.008, 12);
        expect(geometry?.windowLeftMm).toBeCloseTo(8.504, 12);
        expect(geometry?.windowTopMm).toBeCloseTo(3.504, 12);
        expect(geometry?.windowHeightMm).toBe(10);
    });

    it("renders all six nested latewood patterns and the 0.18 mm ring boundary", () => {
        const geometry = buildTreeRingGeometry(new Map([[1900, 2000]]));
        expect(geometry).not.toBeNull();
        if (!geometry) return;

        const previewSvg = renderTreeRingSvg(geometry, "preview");
        const fullSvg = renderTreeRingSvg(geometry, "full");

        for (let level = 1; level <= 6; level += 1) {
            expect(previewSvg).toContain(`id="latewood_dots_${level}"`);
            expect(previewSvg).toContain(`stroke="url(#latewood_dots_${level})"`);
        }
        expect(previewSvg).toContain('stroke-width="0.180000"');
        expect(previewSvg).toContain('preserveAspectRatio="xMidYMid meet"');
        expect(previewSvg).toContain('aria-label="One-centimetre-high tree-ring window from pith to 3 o\'clock"');
        expect(fullSvg).toContain('viewBox="0 0 4.000000 4.000000"');
        expect(fullSvg).toContain('width="4.000mm" height="4.000mm"');
    });

    it("reuses the geometry signature after a whole-series calendar shift", () => {
        const before = buildTreeRingGeometry(new Map([[1000, 800], [1001, 1200]]));
        const after = buildTreeRingGeometry(new Map([[1010, 800], [1011, 1200]]));

        expect(before?.cacheKey).toBe(after?.cacheKey);
    });
});
