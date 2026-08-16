import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCapabilityCases } from "../scenarios";
import type { CapabilityConfig, CapabilityFamily, CapabilityManifest } from "../types";

const readFrozen = (version: "v2" | "v3", role: "development" | "holdout") => {
    const prefix = resolve(
        `docs/benchmarks/itrdb-operation-capability-paper-${version}-${role}`,
    );
    const configBytes = readFileSync(`${prefix}-config.json`);
    return {
        config: JSON.parse(configBytes.toString("utf8")) as CapabilityConfig,
        manifest: JSON.parse(
            readFileSync(`${prefix}-manifest.json`, "utf8"),
        ) as CapabilityManifest,
        configSha256: createHash("sha256").update(configBytes).digest("hex"),
    };
};

const spread = (values: readonly number[]): number => Math.max(...values) - Math.min(...values);

describe("paper-scale ITRDB capability protocol v3", () => {
    const priorHoldout = readFrozen("v2", "holdout");
    const development = readFrozen("v3", "development");
    const holdout = readFrozen("v3", "holdout");

    it("keeps the same 25-file holdout and re-freezes 500 cases per family", () => {
        const priorFiles = priorHoldout.manifest.files.map((file) => file.fileId);
        const holdoutFiles = holdout.manifest.files.map((file) => file.fileId);
        const developmentFiles = new Set(development.manifest.files.map((file) => file.fileId));
        const cases = buildCapabilityCases(holdout.config, holdout.manifest);

        expect(holdoutFiles).toEqual(priorFiles);
        expect(holdoutFiles).toHaveLength(25);
        expect(holdoutFiles.some((fileId) => developmentFiles.has(fileId))).toBe(false);
        expect(holdout.manifest.counts.eligibleTargets).toBe(500);
        (["Clean", "A", "B", "C", "D"] as CapabilityFamily[]).forEach((family) => {
            expect(cases.filter((item) => item.family === family)).toHaveLength(500);
        });
        expect(cases.every((item) => item.scenarioId.endsWith("-v5"))).toBe(true);
    });

    it("binds the manifest to the frontier-attempt workflow metric protocol", () => {
        expect(development.manifest.configSha256).toBe(development.configSha256);
        expect(holdout.manifest.configSha256).toBe(holdout.configSha256);
        expect(holdout.config).toMatchObject({
            protocolVersion: "itrdb-operation-capability-v3",
            scenarioGeneratorVersion: 5,
            evaluationProtocol: {
                mainMetric: "workflowSuggestionAccuracy",
                denominator: "actualFrontierDiagnosisAttempts",
                unreachedEvents: "serialRecoveryOnly",
                wholeSeriesMoveSuccess: "negativeExactShiftNoWindow",
            },
        });
    });

    it("generates only balanced negative whole shifts in A and D", () => {
        const cases = buildCapabilityCases(holdout.config, holdout.manifest);
        const configured = holdout.config.injection.wholeShiftYears;

        expect(configured).toEqual([-4, -11, -20, -50]);
        expect(cases.filter((item) => item.family === "B" || item.family === "C")
            .flatMap((item) => item.truths)
            .some((truth) => truth.eventType === "wholeSeriesMove")).toBe(false);
        (["A", "D"] as const).forEach((family) => {
            const shifts = cases.filter((item) => item.family === family)
                .flatMap((item) => item.truths)
                .filter((truth) => truth.eventType === "wholeSeriesMove")
                .map((truth) => truth.shiftYears);
            expect(new Set(shifts)).toEqual(new Set(configured));
            expect(shifts.every((shift) => shift < 0)).toBe(true);
            const counts = configured.map((shift) => shifts.filter((item) => item === shift).length);
            expect(spread(counts)).toBeLessThanOrEqual(1);
        });
    });
});
