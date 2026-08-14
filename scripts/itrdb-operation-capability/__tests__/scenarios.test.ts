import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCapabilityCases } from "../scenarios";
import type { CapabilityConfig, CapabilityManifest, CapabilityTruth } from "../types";

const config: CapabilityConfig = {
    schemaVersion: 1,
    protocolVersion: "itrdb-operation-capability-v1",
    scenarioGeneratorVersion: 3,
    frozenDate: "2026-08-15",
    seed: "fixture",
    itrdbRoot: "D:/fixture",
    fileIds: ["fixture"],
    selection: {
        minimumSeriesYears: 200,
        minimumMasterCorrelation: 0.8,
        maximumProblemSegments: 0,
        minimumOlderContextYears: 45,
        minimumNewerContextYears: 35,
        usesSignalStrength: false,
        usesDiagnosisOutput: false,
    },
    injection: {
        falseRingMode: "moderate",
        partialShiftYears: [-6, -20],
        wholeShiftYears: [-4, 4],
        distantSpacingYears: 30,
        distantEventCounts: [2, 3, 4],
        nearSpacingYears: [2, 5, 9, 13],
        nearUnitEventCounts: [2, 3, 4],
        includeAdjacentOptionalSuccess: true,
        allowedWindowWidths: [5, 7, 9, 13],
    },
    families: { Clean: "", A: "", B: "", C: "", D: "" },
    runtime: { workers: 4, cofechaTimeoutSeconds: 60 },
};

const manifest: CapabilityManifest = {
    schemaVersion: 1,
    protocolVersion: "itrdb-operation-capability-v1",
    scenarioGeneratorVersion: 3,
    createdAt: "2026-08-15T00:00:00.000Z",
    gitCommit: "fixture",
    configPath: "fixture.json",
    configSha256: "fixture",
    itrdbRoot: "D:/fixture",
    cofechaSha256: "fixture",
    files: [{
        fileId: "fixture",
        relativePath: "fixture.rwl",
        sourceSha256: "fixture",
        cleanCofechaSha256: "fixture",
        seriesIntercorrelation: 0.9,
        possibleProblemSegments: 0,
        totalSeries: 10,
        eligibleTargets: [{
            targetId: "A",
            startYear: 1500,
            endYear: 2000,
            seriesYears: 501,
            zeroCount: 0,
            masterCorrelation: 0.85,
            problemSegments: 0,
        }],
    }],
    excludedFiles: [],
    counts: {
        requestedFiles: 1,
        includedFiles: 1,
        excludedFiles: 0,
        totalSeries: 10,
        eligibleTargets: 1,
    },
};

const localYears = (truths: readonly CapabilityTruth[]): number[] => truths
    .flatMap((truth) => truth.year === null ? [] : [truth.year])
    .sort((left, right) => left - right);

describe("ITRDB operation capability scenario matrix v3", () => {
    it("uses one sequential-frontier product semantics for every family", () => {
        const cases = buildCapabilityCases(config, manifest);

        expect(cases).toHaveLength(33);
        expect(cases.filter((item) => item.family === "Clean")).toHaveLength(1);
        expect(cases.filter((item) => item.family === "A")).toHaveLength(4);
        expect(cases.filter((item) => item.family === "B")).toHaveLength(9);
        expect(cases.filter((item) => item.family === "C")).toHaveLength(8);
        expect(cases.filter((item) => item.family === "D")).toHaveLength(11);
        expect(cases.every((item) => item.evaluationMode === "sequentialFrontier"))
            .toBe(true);
        expect(cases.every((item) => item.truths.every((truth) => (
            truth.eventType !== "partialMove" || truth.shiftYears < -1
        )))).toBe(true);
        expect(cases.some((item) => "truthCluster" in item)).toBe(false);
    });

    it("keeps B as distant same-type local chains", () => {
        const cases = buildCapabilityCases(config, manifest)
            .filter((item) => item.family === "B");

        cases.forEach((item) => {
            expect(new Set(item.truths.map((truth) => truth.eventType)).size).toBe(1);
            expect(item.truths.some((truth) => truth.eventType === "wholeSeriesMove"))
                .toBe(false);
            const years = localYears(item.truths);
            years.slice(1).forEach((year, index) => {
                expect(year - years[index]).toBeGreaterThanOrEqual(14);
            });
        });
    });

    it("keeps C to same-direction unit events and isolates adjacent optional success", () => {
        const cases = buildCapabilityCases(config, manifest)
            .filter((item) => item.family === "C");
        const blocking = cases.filter((item) => item.acceptanceTier === "blocking");
        const adjacent = cases.filter((item) => item.acceptanceTier === "optionalSuccess");

        expect(blocking).toHaveLength(6);
        blocking.forEach((item) => {
            expect(item.truths.every((truth) => (
                truth.eventType === "missingRing" || truth.eventType === "falseRing"
            ))).toBe(true);
            expect(new Set(item.truths.map((truth) => truth.eventType)).size).toBe(1);
            expect(item.spacingYears).toBeGreaterThanOrEqual(2);
            expect(item.spacingYears).toBeLessThanOrEqual(13);
        });
        expect(adjacent).toHaveLength(2);
        expect(adjacent.every((item) => item.spacingYears === 1)).toBe(true);
    });

    it("covers all D type combinations without counting whole as a breakpoint", () => {
        const cases = buildCapabilityCases(config, manifest)
            .filter((item) => item.family === "D");
        const byTypeCount = (count: number) => cases.filter((item) => (
            new Set(item.truths.map((truth) => truth.eventType)).size === count
        ));

        expect(byTypeCount(2)).toHaveLength(6);
        expect(byTypeCount(3)).toHaveLength(4);
        expect(byTypeCount(4)).toHaveLength(1);
        cases.forEach((item) => {
            const years = localYears(item.truths);
            years.slice(1).forEach((year, index) => {
                expect(year - years[index]).toBeGreaterThanOrEqual(14);
            });
            if (years.length < 2) expect(item.spacingYears).toBeNull();
        });
    });

    it("is deterministic and does not use signal strength or diagnosis output", () => {
        expect(buildCapabilityCases(config, manifest)).toEqual(
            buildCapabilityCases(config, manifest),
        );
        expect(config.selection.usesSignalStrength).toBe(false);
        expect(config.selection.usesDiagnosisOutput).toBe(false);
    });

    it("keeps the checked-in v3 config and manifest frozen together", () => {
        const configPath = resolve("docs/benchmarks/itrdb-operation-capability-config-v1.json");
        const manifestPath = resolve("docs/benchmarks/itrdb-operation-capability-manifest-v1.json");
        const configBytes = readFileSync(configPath);
        const frozenConfig = JSON.parse(configBytes.toString("utf8")) as CapabilityConfig;
        const frozenManifest = JSON.parse(
            readFileSync(manifestPath, "utf8"),
        ) as CapabilityManifest;
        const configSha256 = createHash("sha256").update(configBytes).digest("hex");

        expect(frozenConfig.scenarioGeneratorVersion).toBe(3);
        expect(frozenManifest.scenarioGeneratorVersion).toBe(3);
        expect(frozenManifest.configSha256).toBe(configSha256);
        const targetCount = frozenManifest.files.reduce((sum, file) => (
            sum + file.eligibleTargets.length
        ), 0);
        expect(buildCapabilityCases(frozenConfig, frozenManifest)).toHaveLength(
            targetCount * 33,
        );
    });
});

describe("ITRDB operation capability balanced paper matrix v4", () => {
    const paperConfig: CapabilityConfig = {
        ...config,
        scenarioGeneratorVersion: 4,
        design: {
            scenarioSampling: "balancedOnePerFamily",
            splitId: "fixture-split",
            datasetRole: "finalHoldout",
            casesPerTargetPerFamily: 1,
        },
        statistics: {
            clusterUnit: "file",
            bootstrapReplicates: 1000,
            confidenceLevel: 0.95,
            targetCoverage: 0.9,
            seed: "fixture-bootstrap",
        },
    };
    const targets = Array.from({ length: 24 }, (_, index) => ({
        ...manifest.files[0].eligibleTargets[0],
        targetId: `T${String(index + 1).padStart(2, "0")}`,
    }));
    const paperManifest: CapabilityManifest = {
        ...manifest,
        scenarioGeneratorVersion: 4,
        files: [{
            ...manifest.files[0],
            eligibleTargets: targets,
        }],
        counts: {
            ...manifest.counts,
            eligibleTargets: targets.length,
        },
    };

    it("freezes exactly one case per target and major family", () => {
        const cases = buildCapabilityCases(paperConfig, paperManifest);

        expect(cases).toHaveLength(targets.length * 5);
        (["Clean", "A", "B", "C", "D"] as const).forEach((family) => {
            const selected = cases.filter((item) => item.family === family);
            expect(selected).toHaveLength(targets.length);
            expect(new Set(selected.map((item) => item.targetId)).size).toBe(targets.length);
        });
    });

    it("balances operation subtypes without using target signal strength", () => {
        const cases = buildCapabilityCases(paperConfig, paperManifest);
        const aTypes = cases.filter((item) => item.family === "A")
            .map((item) => item.truths[0].eventType);
        expect(new Set(aTypes)).toEqual(new Set([
            "missingRing",
            "falseRing",
            "partialMove",
            "wholeSeriesMove",
        ]));
        const bCases = cases.filter((item) => item.family === "B");
        expect(new Set(bCases.map((item) => item.scenarioId)).size).toBe(9);
        expect(bCases.every((item) => item.truths.length >= 2)).toBe(true);
        expect(bCases.every((item) => (
            new Set(item.truths.map((truth) => truth.eventType)).size === 1
        ))).toBe(true);
        const cCases = cases.filter((item) => item.family === "C");
        expect(new Set(cCases.map((item) => item.scenarioId)).size).toBe(24);
        expect(cCases.every((item) => item.spacingYears !== null
            && item.spacingYears >= 2
            && item.spacingYears <= 13)).toBe(true);
        const dCases = cases.filter((item) => item.family === "D");
        expect(new Set(dCases.map((item) => item.scenarioId)).size).toBe(11);
        expect(paperConfig.selection.usesSignalStrength).toBe(false);
        expect(paperConfig.selection.usesDiagnosisOutput).toBe(false);
    });

    it("is deterministic and keeps all local windows in the requested context", () => {
        const first = buildCapabilityCases(paperConfig, paperManifest);
        const second = buildCapabilityCases(paperConfig, paperManifest);
        expect(first).toEqual(second);
        first.forEach((item) => item.truths.forEach((truth) => {
            if (truth.year === null) return;
            expect(truth.year - item.targetStartYear).toBeGreaterThanOrEqual(
                paperConfig.selection.minimumOlderContextYears,
            );
            expect(item.targetEndYear - truth.year).toBeGreaterThanOrEqual(
                paperConfig.selection.minimumNewerContextYears,
            );
        }));
    });
});
