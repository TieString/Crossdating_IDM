import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCapabilityCases } from "../scenarios";
import type { CapabilityConfig, CapabilityFamily, CapabilityManifest } from "../types";

const readFrozen = (role: "development" | "holdout") => {
    const configPath = resolve(
        `docs/benchmarks/itrdb-operation-capability-paper-v2-${role}-config.json`,
    );
    const manifestPath = resolve(
        `docs/benchmarks/itrdb-operation-capability-paper-v2-${role}-manifest.json`,
    );
    const configBytes = readFileSync(configPath);
    return {
        config: JSON.parse(configBytes.toString("utf8")) as CapabilityConfig,
        manifest: JSON.parse(readFileSync(manifestPath, "utf8")) as CapabilityManifest,
        configSha256: createHash("sha256").update(configBytes).digest("hex"),
    };
};

describe("paper-scale ITRDB capability protocol v2", () => {
    const development = readFrozen("development");
    const holdout = readFrozen("holdout");

    it("retains the whole-file split and exact 500-case holdout", () => {
        const developmentFiles = new Set(development.manifest.files.map((file) => file.fileId));
        const holdoutFiles = new Set(holdout.manifest.files.map((file) => file.fileId));
        const cases = buildCapabilityCases(holdout.config, holdout.manifest);
        const families: CapabilityFamily[] = ["Clean", "A", "B", "C", "D"];

        expect([...developmentFiles].filter((fileId) => holdoutFiles.has(fileId))).toEqual([]);
        expect(developmentFiles.has("co612")).toBe(true);
        expect(holdout.manifest.counts.eligibleTargets).toBe(500);
        families.forEach((family) => {
            expect(cases.filter((item) => item.family === family)).toHaveLength(500);
        });
    });

    it("binds each manifest to the new long-whole configuration", () => {
        expect(development.manifest.configSha256).toBe(development.configSha256);
        expect(holdout.manifest.configSha256).toBe(holdout.configSha256);
        expect(development.config.protocolVersion).toBe("itrdb-operation-capability-v2");
        expect(holdout.config.injection.wholeShiftYears).toEqual([
            -4, 4, -11, 11, -20, 20, -50, 50,
        ]);
    });

    it("covers both directions and every configured long whole shift", () => {
        const cases = buildCapabilityCases(holdout.config, holdout.manifest);
        const wholeTruths = cases
            .filter((item) => item.family === "A" || item.family === "D")
            .flatMap((item) => item.truths)
            .filter((truth) => truth.eventType === "wholeSeriesMove");
        const shifts = new Set(wholeTruths.map((truth) => truth.shiftYears));

        holdout.config.injection.wholeShiftYears.forEach((shiftYears) => {
            expect(shifts.has(shiftYears)).toBe(true);
        });
        expect(wholeTruths.some((truth) => truth.shiftYears < -10)).toBe(true);
        expect(wholeTruths.some((truth) => truth.shiftYears > 10)).toBe(true);
    });
});
