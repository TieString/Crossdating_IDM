import { describe, expect, it } from "vitest";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import {
    createPairwiseBootstrapReferenceConfig,
    createPairwiseBootstrapTargetReferenceConfig,
    selectPairwiseBootstrapCluster,
} from "../pairwiseBootstrap";

const makeBase = () => {
    let state = 0x12345678;
    return Array.from({ length: 180 }, (_, index) => {
        state = (1664525 * state + 1013904223) >>> 0;
        return [1800 + index, 300 + state % 1400] as const;
    });
};

const makeSeries = (
    base: readonly (readonly [number, number])[],
    lag: number,
    noiseSeed: number,
): RwlTreeData => new Map(base.map(([year, value], index) => [
    year + lag,
    Math.max(1, value + ((index * 17 + noiseSeed * 13) % 9) - 4),
]));

const makeSite = (): RwlSiteData => {
    const base = makeBase();
    const site: RwlSiteData = new Map();
    for (let index = 0; index < 6; index += 1) {
        site.set(`anchor${index + 1}`, makeSeries(base, 0, index));
    }
    for (let index = 0; index < 3; index += 1) {
        site.set(`shifted${index + 1}`, makeSeries(base, 4, index + 10));
    }
    return site;
};

describe("pairwise bootstrap reference", () => {
    it("selects the largest mutually zero-lag component", () => {
        expect(selectPairwiseBootstrapCluster(makeSite()).sort()).toEqual([
            "anchor1",
            "anchor2",
            "anchor3",
            "anchor4",
            "anchor5",
            "anchor6",
        ]);
    });

    it("keeps original A flags while exposing the temporary anchor cluster", () => {
        const site = makeSite();
        const config = createPairwiseBootstrapReferenceConfig({
            siteData: site,
            flaggedAIds: site.keys(),
            cofechaRunId: "all-flagged-cold-start",
            rwlHash: "test-hash",
        });

        expect(config?.cofechaPassReference?.source).toBe("pairwise_bootstrap");
        expect(config?.selectedTrees).toHaveLength(6);
        expect(config?.classification?.anchorPassIds).toHaveLength(6);
        expect(config?.classification?.candidateFlaggedIds).toHaveLength(9);
        expect(config?.cofechaPassReference?.summary.includedCount).toBe(6);
        expect(config?.cofechaPassReference?.points.length).toBeGreaterThan(100);

        const targetConfig = createPairwiseBootstrapTargetReferenceConfig(
            site,
            config,
            "anchor1",
        );
        expect(targetConfig?.selectedTrees).not.toContain("anchor1");
        expect(targetConfig?.selectedTrees).toHaveLength(5);
        expect(targetConfig?.cofechaPassReference?.summary.includedCount).toBe(5);
        expect(targetConfig?.classification?.candidateFlaggedIds).toHaveLength(9);
    });
});
