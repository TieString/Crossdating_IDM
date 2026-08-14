import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCapabilityCases } from "../scenarios";
import type { CapabilityConfig, CapabilityFamily, CapabilityManifest } from "../types";

const readFrozen = (role: "development" | "holdout") => {
    const configPath = resolve(
        `docs/benchmarks/itrdb-operation-capability-paper-v1-${role}-config.json`,
    );
    const manifestPath = resolve(
        `docs/benchmarks/itrdb-operation-capability-paper-v1-${role}-manifest.json`,
    );
    const configBytes = readFileSync(configPath);
    const config = JSON.parse(configBytes.toString("utf8")) as CapabilityConfig;
    const manifest = JSON.parse(
        readFileSync(manifestPath, "utf8"),
    ) as CapabilityManifest;
    return {
        config,
        manifest,
        configSha256: createHash("sha256").update(configBytes).digest("hex"),
    };
};

describe("paper-scale ITRDB capability protocol", () => {
    const development = readFrozen("development");
    const holdout = readFrozen("holdout");

    it("separates development and final holdout at the whole-file level", () => {
        const developmentFiles = new Set(development.manifest.files.map((file) => file.fileId));
        const holdoutFiles = new Set(holdout.manifest.files.map((file) => file.fileId));

        expect(development.manifest.files).toHaveLength(9);
        expect(holdout.manifest.files).toHaveLength(25);
        expect([...developmentFiles].filter((fileId) => holdoutFiles.has(fileId))).toEqual([]);
        expect(developmentFiles.has("co612")).toBe(true);
        expect(holdoutFiles.has("co612")).toBe(false);
    });

    it("keeps each generated manifest bound to its exact configuration", () => {
        expect(development.manifest.configSha256).toBe(development.configSha256);
        expect(holdout.manifest.configSha256).toBe(holdout.configSha256);
        expect(development.config.design?.datasetRole).toBe("development");
        expect(holdout.config.design?.datasetRole).toBe("finalHoldout");
        expect(development.config.design?.splitId).toBe(holdout.config.design?.splitId);
    });

    it("freezes 500 holdout cases per family with one target case per family", () => {
        const cases = buildCapabilityCases(holdout.config, holdout.manifest);
        const families: CapabilityFamily[] = ["Clean", "A", "B", "C", "D"];

        expect(holdout.manifest.counts.eligibleTargets).toBe(500);
        families.forEach((family) => {
            const selected = cases.filter((item) => item.family === family);
            expect(selected).toHaveLength(500);
            expect(new Set(selected.map((item) => (
                `${item.fileId}:${item.targetId}`
            ))).size).toBe(500);
        });
        expect(cases).toHaveLength(2500);
    });

    it("uses every frozen development target without leaking a holdout target", () => {
        const cases = buildCapabilityCases(development.config, development.manifest);
        const developmentFiles = new Set(development.manifest.files.map((file) => file.fileId));
        expect(development.manifest.counts.eligibleTargets).toBe(128);
        expect(cases).toHaveLength(128 * 5);
        expect(cases.every((item) => developmentFiles.has(item.fileId))).toBe(true);
    });
});
