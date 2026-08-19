import { describe, expect, it } from "vitest";
import { buildTreeRingGeometry } from "./treeRingArtwork";
import {
    resolveFullTreeRingViewerFeature,
    resolveStripTreeRingViewerFeature,
} from "./treeRingViewerLink";

const geometry = buildTreeRingGeometry(new Map([
    [1900, 1000],
    [1901, 1000],
    [1902, 1000],
]), -9999)!;

describe("floating tree-ring viewer width linkage", () => {
    it("resolves a clicked ring in the full cross-section", () => {
        expect(resolveFullTreeRingViewerFeature(
            geometry,
            { zoom: 1, startX: 0, startY: 0 },
            275,
            150,
            300,
            300,
        )).toMatchObject({ kind: "ring", startYear: 1902 });
    });

    it("resolves the same ring in the radial 1 cm window", () => {
        expect(resolveStripTreeRingViewerFeature(
            geometry,
            { zoom: 1, startX: geometry.radiusMm },
            250,
            300,
        )).toMatchObject({ kind: "ring", startYear: 1902 });
    });
});
