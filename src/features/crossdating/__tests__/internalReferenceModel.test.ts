import { describe, expect, it } from "vitest";
import {
    buildInternalReferenceModel,
    scoreInternalTargetIncompatibility,
    setInternalTargetCandidate,
} from "../internalReferenceModel";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";

const signal = (year: number, phase = 0) => (
    900
    + 180 * Math.sin((year + phase) * 0.43)
    + 95 * Math.cos((year + phase) * 0.17)
    + 40 * Math.sin((year + phase) * 1.13)
);

const series = (shift = 0, phase = 0): RwlTreeData => new Map(
    Array.from({ length: 180 }, (_, index) => {
        const year = 1800 + index;
        return [year, Math.round(signal(year + shift, phase))] as const;
    }),
);

const cleanSite = (): RwlSiteData => new Map([
    ["REF001", series(0, 0)],
    ["REF002", series(0, 0.2)],
    ["REF003", series(0, -0.3)],
    ["REF004", series(0, 0.5)],
    ["REF005", series(0, -0.6)],
    ["SHIFT1", series(6, 0.1)],
    ["TARGET", series(0, 0.15)],
]);

describe("internal reference model", () => {
    it("excludes the target and downweights a shifted source", () => {
        const model = buildInternalReferenceModel({
            siteData: cleanSite(),
            targetId: "TARGET",
            runId: "test",
            rwlHash: "hash",
        });

        expect(model).not.toBeNull();
        expect(model?.referenceConfig.selectedTrees).not.toContain("TARGET");
        expect(model?.referenceConfig.selectedTrees).toHaveLength(6);
        const shifted = model?.sourceCompatibility.find((row) => row.seriesId === "SHIFT1");
        const clean = model?.sourceCompatibility.find((row) => row.seriesId === "REF001");
        expect(shifted?.bestLag).not.toBe(0);
        expect(shifted?.referenceWeight ?? 1).toBeLessThan(clean?.referenceWeight ?? 0);
    });

    it("separates a clean target from a nonzero-lag target", () => {
        const clean = buildInternalReferenceModel({
            siteData: cleanSite(),
            targetId: "TARGET",
            runId: "clean",
            rwlHash: "hash",
        });
        const shiftedSite = cleanSite();
        shiftedSite.set("TARGET", series(4, 0.15));
        const shifted = buildInternalReferenceModel({
            siteData: shiftedSite,
            targetId: "TARGET",
            runId: "shifted",
            rwlHash: "hash",
            candidateTarget: true,
        });

        expect(clean?.targetCompatibility.bestLag).toBe(0);
        expect(shifted?.targetCompatibility.bestLag).not.toBe(0);
        expect(shifted?.targetCompatibility.zeroLagDeficit ?? 0).toBeGreaterThan(0.2);
        expect(scoreInternalTargetIncompatibility(shifted!.targetCompatibility))
            .toBeGreaterThan(scoreInternalTargetIncompatibility(clean!.targetCompatibility));
        const candidate = setInternalTargetCandidate(shifted!, "TARGET", true);
        expect(candidate.referenceConfig.classification?.candidateFlaggedIds)
            .toContain("TARGET");
        expect(candidate.referenceConfig.classification?.anchorPassIds)
            .not.toContain("TARGET");
    });
});
