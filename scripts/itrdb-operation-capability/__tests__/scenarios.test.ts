import { describe, expect, it } from "vitest";
import { buildCapabilityCases } from "../scenarios";
import type { CapabilityConfig, CapabilityManifest } from "../types";

const config: CapabilityConfig = {
    schemaVersion: 1,
    protocolVersion: "itrdb-operation-capability-v1",
    frozenDate: "2026-08-12",
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
        nearSpacingYears: 7,
        allowedWindowWidths: [5, 7, 9, 13],
    },
    families: { A: "", B: "", C: "", D: "" },
    runtime: { workers: 4, cofechaTimeoutSeconds: 60 },
};

const manifest: CapabilityManifest = {
    schemaVersion: 1,
    protocolVersion: "itrdb-operation-capability-v1",
    scenarioGeneratorVersion: 1,
    createdAt: "2026-08-12T00:00:00.000Z",
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
            startYear: 1700,
            endYear: 2000,
            seriesYears: 301,
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

describe("ITRDB operation capability scenario matrix", () => {
    it("freezes the requested A/B/C/D case counts and physical shift semantics", () => {
        const cases = buildCapabilityCases(config, manifest);
        expect(cases).toHaveLength(30);
        expect(cases.filter((item) => item.family === "A")).toHaveLength(5);
        expect(cases.filter((item) => item.family === "B")).toHaveLength(12);
        expect(cases.filter((item) => item.family === "C")).toHaveLength(9);
        expect(cases.filter((item) => item.family === "D")).toHaveLength(4);
        expect(cases.flatMap((item) => item.truths)
            .filter((truth) => truth.eventType === "partialMove")
            .every((truth) => truth.shiftYears < -1)).toBe(true);
        expect(cases.filter((item) => item.family === "C")
            .every((item) => item.spacingYears === 7)).toBe(true);
        expect(cases.filter((item) => item.family === "D")
            .every((item) => item.truths.length === 3)).toBe(true);
    });

    it("is deterministic and keeps distant local truths at the frozen separation", () => {
        const first = buildCapabilityCases(config, manifest);
        const second = buildCapabilityCases(config, manifest);
        expect(second).toEqual(first);
        first.filter((item) => item.family === "B" && item.truths.every(
            (truth) => truth.eventType !== "wholeSeriesMove",
        )).forEach((item) => {
            const years = item.truths.map((truth) => truth.year!).sort((a, b) => a - b);
            expect(years[1] - years[0]).toBe(30);
        });
    });
});
