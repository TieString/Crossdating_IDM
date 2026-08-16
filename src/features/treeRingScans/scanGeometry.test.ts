import { describe, expect, it } from "vitest";
import {
    buildTreeRingScanYearPositions,
    estimateTreeRingScanBandHeightPixels,
    getTreeRingScanXRatioForOriginalYear,
    resolveTreeRingScanOriginalYearAtX,
    type TreeRingScanSeriesState,
} from "./index";

const scanState: TreeRingScanSeriesState = {
    mode: "scan",
    anchors: [
        { originalYear: 2000, xRatio: 0.2, yRatio: 0.48, markerCount: 3 },
        { originalYear: 1990, xRatio: 0.6, yRatio: 0.5, markerCount: 1 },
    ],
    baselineStartYear: 1990,
    baselineEndYear: 2000,
    baselineOperationSequence: 0,
    baselineWidths: Array.from({ length: 11 }, (_, index) => [1990 + index, 1000] as [number, number]),
};

describe("tree-ring scan anchor geometry", () => {
    it("interpolates years in either image direction", () => {
        expect(getTreeRingScanXRatioForOriginalYear(scanState, 1995)).toBeCloseTo(0.4, 6);
        expect(getTreeRingScanXRatioForOriginalYear(scanState, 2000)).toBeCloseTo(0.2, 6);
    });

    it("resolves hover positions back to an original year", () => {
        const positions = buildTreeRingScanYearPositions(scanState);
        expect(resolveTreeRingScanOriginalYearAtX(positions, 0.405)).toBe(1995);
    });

    it("estimates a ten-millimetre band from anchored width distances", () => {
        // Ten 1 mm rings span 400 px, so a 10 mm band is also about 400 px.
        expect(estimateTreeRingScanBandHeightPixels(scanState, 1000, 800)).toBeCloseTo(400, 3);
    });
});
