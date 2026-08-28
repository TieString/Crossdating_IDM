import { describe, expect, it } from "vitest";
import { buildCapabilityCases } from "../itrdb-operation-capability/scenarios";
import type {
    CapabilityConfig,
    CapabilityManifest,
    CapabilityTarget,
} from "../itrdb-operation-capability/types";

const target = (
    targetId: string,
    seriesYears: number,
): CapabilityTarget => ({
    targetId,
    startYear: 1000,
    endYear: 1000 + seriesYears - 1,
    seriesYears,
    zeroCount: 0,
    masterCorrelation: 0.75,
    problemSegments: 0,
});

const config: CapabilityConfig = {
    schemaVersion: 1,
    protocolVersion: "itrdb-frozen-external-v1",
    scenarioGeneratorVersion: 6,
    frozenDate: "2026-08-28",
    seed: "external-scenario-test",
    itrdbRoot: "D:/fixture",
    fileIds: Array.from({ length: 50 }, (_, index) => `f${index}`),
    selection: {
        minimumSeriesYears: 100,
        minimumMasterCorrelation: 0.6,
        maximumProblemSegments: 0,
        minimumFileIntercorrelation: 0.5,
        maximumFileProblemSegments: 0,
        minimumOlderContextYears: 45,
        minimumNewerContextYears: 15,
        maximumTargetsPerFile: 10,
        usesSignalStrength: false,
        usesDiagnosisOutput: false,
    },
    injection: {
        falseRingMode: "moderate",
        partialShiftYears: [-6, -20],
        wholeShiftYears: [-4, -11, -20, -50],
        distantSpacingYears: 30,
        nearSpacingYears: [2, 5, 9, 13],
        distantEventCounts: [2, 3, 4],
        nearUnitEventCounts: [2, 3, 4],
        includeAdjacentOptionalSuccess: false,
        allowedWindowWidths: [5, 7, 9, 13],
    },
    families: {
        Clean: "clean",
        A: "single",
        B: "distant same type",
        C: "near same direction",
        D: "distant mixed",
    },
    design: {
        scenarioSampling: "balancedOnePerFamily",
        splitId: "external-test",
        datasetRole: "externalFrozenTest",
        casesPerTargetPerFamily: 1,
        eventPositionWeights: { middle: 0.4, newer: 0.35, barkNear: 0.25 },
        lengthAwareEventCounts: true,
    },
    statistics: {
        clusterUnit: "file",
        bootstrapReplicates: 20_000,
        confidenceLevel: 0.95,
        targetCoverage: 0.9,
        seed: "external-bootstrap",
    },
    runtime: { workers: 12, cofechaTimeoutSeconds: 60 },
    evaluationProtocol: {
        version: "frontier-workflow-suggestion-v1",
        mainMetric: "workflowSuggestionAccuracy",
        denominator: "actualFrontierDiagnosisAttempts",
        unreachedEvents: "serialRecoveryOnly",
        wholeSeriesMoveSuccess: "negativeExactShiftNoWindow",
    },
};

const manifest: CapabilityManifest = {
    schemaVersion: 1,
    protocolVersion: config.protocolVersion,
    scenarioGeneratorVersion: 6,
    createdAt: "2026-08-28T00:00:00.000Z",
    gitCommit: "fixture",
    configPath: "fixture",
    configSha256: "fixture",
    itrdbRoot: config.itrdbRoot,
    cofechaSha256: "fixture",
    files: Array.from({ length: 50 }, (_, fileIndex) => ({
        fileId: `f${fileIndex}`,
        relativePath: `f${fileIndex}.rwl`,
        sourceSha256: `source-${fileIndex}`,
        cleanCofechaSha256: `cofecha-${fileIndex}`,
        seriesIntercorrelation: 0.75,
        possibleProblemSegments: 0,
        totalSeries: 12,
        eligibleTargetsBeforeLimit: 12,
        eligibleTargets: Array.from({ length: 10 }, (_, targetIndex) => target(
            `s${targetIndex}`,
            [150, 240, 360][(fileIndex + targetIndex) % 3],
        )),
    })),
    excludedFiles: [],
    counts: {
        requestedFiles: 50,
        includedFiles: 50,
        excludedFiles: 0,
        totalSeries: 600,
        eligibleTargetsBeforeLimit: 600,
        eligibleTargets: 500,
    },
};

describe("frozen external scenario generator", () => {
    const cases = buildCapabilityCases(config, manifest);

    it("creates exactly 500 cases per family", () => {
        expect(cases).toHaveLength(2500);
        for (const family of ["Clean", "A", "B", "C", "D"] as const) {
            expect(cases.filter((item) => item.family === family)).toHaveLength(500);
        }
    });

    it("keeps local frontiers inside the frozen context bands", () => {
        for (const item of cases.filter((candidate) => (
            candidate.family !== "Clean" && candidate.frontierPositionBand !== null
        ))) {
            const local = item.truths.filter((truth) => truth.year !== null);
            const newest = Math.max(...local.map((truth) => truth.year!));
            const oldest = Math.min(...local.map((truth) => truth.year!));
            const distance = item.targetEndYear - newest;
            expect(distance).toBe(item.frontierDistanceFromNewest);
            expect(oldest - item.targetStartYear).toBeGreaterThanOrEqual(45);
            if (item.frontierPositionBand === "barkNear") {
                expect(distance).toBeGreaterThanOrEqual(15);
                expect(distance).toBeLessThanOrEqual(34);
            } else if (item.frontierPositionBand === "newer") {
                expect(distance).toBeGreaterThanOrEqual(35);
                expect(distance).toBeLessThanOrEqual(69);
            } else {
                expect(distance).toBeGreaterThanOrEqual(70);
            }
        }
    });

    it("uses length-aware event counts and negative whole shifts", () => {
        for (const item of cases.filter((candidate) => (
            candidate.family === "B" || candidate.family === "C" || candidate.family === "D"
        ))) {
            if (item.seriesYears < 200) expect(item.eventCount).toBe(2);
            else if (item.seriesYears < 300) expect([2, 3]).toContain(item.eventCount);
            else expect([3, 4]).toContain(item.eventCount);
            expect(item.truths).toHaveLength(item.eventCount!);
        }
        for (const truth of cases.flatMap((item) => item.truths)) {
            if (truth.eventType === "wholeSeriesMove") expect(truth.shiftYears).toBeLessThan(0);
        }
    });

    it("keeps the requested marginal position mix when feasible", () => {
        for (const family of ["B", "C", "D"] as const) {
            const familyCases = cases.filter((item) => item.family === family);
            const counts = Object.groupBy(
                familyCases,
                (item) => item.frontierPositionBand!,
            );
            expect(counts.middle?.length).toBeGreaterThanOrEqual(190);
            expect(counts.newer?.length).toBeGreaterThanOrEqual(165);
            expect(counts.barkNear?.length).toBeGreaterThanOrEqual(115);
        }
    });
});
