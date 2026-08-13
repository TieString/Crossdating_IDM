import { describe, expect, it } from "vitest";
import { selectManifestTargets } from "../manifestSelection";
import type { CapabilityConfig, CapabilityTarget } from "../types";

const config = {
    seed: "scenario-seed",
    selection: {
        maximumTargetsPerFile: 1,
        targetSelectionSeed: "target-seed",
    },
} as CapabilityConfig;

const target = (targetId: string): CapabilityTarget => ({
    targetId,
    startYear: 1700,
    endYear: 2000,
    seriesYears: 301,
    zeroCount: 0,
    masterCorrelation: 0.85,
    problemSegments: 0,
});

describe("ITRDB capability manifest target selection", () => {
    it("selects a deterministic target independently of input order", () => {
        const forward = [target("A"), target("B"), target("C")];
        const reverse = [...forward].reverse();
        expect(selectManifestTargets(config, "site", forward)).toEqual(
            selectManifestTargets(config, "site", reverse),
        );
        expect(selectManifestTargets(config, "site", forward)).toHaveLength(1);
    });

    it("preserves all eligible targets when no limit is configured", () => {
        const unlimited = {
            ...config,
            selection: {},
        } as CapabilityConfig;
        expect(selectManifestTargets(unlimited, "site", [target("B"), target("A")])
            .map((item) => item.targetId)).toEqual(["A", "B"]);
    });
});
