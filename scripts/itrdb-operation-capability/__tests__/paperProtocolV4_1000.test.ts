import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCapabilityCases } from "../scenarios";
import type { CapabilityConfig, CapabilityFamily, CapabilityManifest } from "../types";

const readFrozen = (suffix: string) => {
    const prefix = resolve(`docs/benchmarks/${suffix}`);
    const configBytes = readFileSync(`${prefix}-config.json`);
    return {
        config: JSON.parse(configBytes.toString("utf8")) as CapabilityConfig,
        manifest: JSON.parse(
            readFileSync(`${prefix}-manifest.json`, "utf8"),
        ) as CapabilityManifest,
        configSha256: createHash("sha256").update(configBytes).digest("hex"),
    };
};

const targetKeys = (manifest: CapabilityManifest): Set<string> => new Set(
    manifest.files.flatMap((file) => file.eligibleTargets.map(
        (target) => `${file.fileId}\u0000${target.targetId}`,
    )),
);
const spread = (values: readonly number[]): number => Math.max(...values) - Math.min(...values);

describe("expanded paper-scale ITRDB capability protocol v4-1000", () => {
    const prior = readFrozen("itrdb-operation-capability-paper-v3-holdout");
    const expanded = readFrozen("itrdb-operation-capability-paper-v4-1000-holdout");
    const cases = buildCapabilityCases(expanded.config, expanded.manifest);

    it("keeps the same files and expands every family to exactly one thousand cases", () => {
        expect(expanded.manifest.files.map((file) => file.fileId)).toEqual(
            prior.manifest.files.map((file) => file.fileId),
        );
        expect(expanded.manifest.files).toHaveLength(25);
        expect(expanded.manifest.counts.eligibleTargets).toBe(1000);
        (['Clean', 'A', 'B', 'C', 'D'] as CapabilityFamily[]).forEach((family) => {
            expect(cases.filter((item) => item.family === family)).toHaveLength(1000);
        });
    });

    it("retains all prior targets and adds five hundred truth-blind targets", () => {
        const priorTargets = targetKeys(prior.manifest);
        const expandedTargets = targetKeys(expanded.manifest);

        expect(priorTargets.size).toBe(500);
        expect([...priorTargets].every((target) => expandedTargets.has(target))).toBe(true);
        expect(expandedTargets.size - priorTargets.size).toBe(500);
        expect(expanded.manifest.configSha256).toBe(expanded.configSha256);
        expect(expanded.config.design).toMatchObject({
            datasetRole: "expandedFrozenHoldoutReuse",
            targetExpansion: "retainPrior500PlusDeterministic500",
        });
    });

    it("keeps negative whole shifts balanced and excludes whole moves from B and C", () => {
        const configured = expanded.config.injection.wholeShiftYears;
        expect(configured).toEqual([-4, -11, -20, -50]);
        expect(cases.filter((item) => item.family === "B" || item.family === "C")
            .flatMap((item) => item.truths)
            .some((truth) => truth.eventType === "wholeSeriesMove")).toBe(false);
        (['A', 'D'] as const).forEach((family) => {
            const shifts = cases.filter((item) => item.family === family)
                .flatMap((item) => item.truths)
                .filter((truth) => truth.eventType === "wholeSeriesMove")
                .map((truth) => truth.shiftYears);
            const counts = configured.map((shift) => shifts.filter((item) => item === shift).length);
            expect(new Set(shifts)).toEqual(new Set(configured));
            expect(shifts.every((shift) => shift < 0)).toBe(true);
            expect(spread(counts)).toBeLessThanOrEqual(1);
        });
    });
});
