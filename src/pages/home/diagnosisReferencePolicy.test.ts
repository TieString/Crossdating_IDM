import { describe, expect, it } from "vitest";

import type { ReferenceSeriesConfig } from "@/features/crossdating/reference";
import { selectAutomaticDiagnosisReferenceConfig } from "./diagnosisReferencePolicy";

const makeReference = (mode: "manual" | "dynamic"): ReferenceSeriesConfig => ({
    selectedTrees: ["series-a", "series-b"],
    minSampleDepth: 2,
    method: "mean",
    updatedAt: "2026-08-11T00:00:00.000Z",
    mode,
    cofechaPassReference: mode === "dynamic" ? {
        id: "automatic-reference",
        source: "cofecha_master_series",
        cofechaRunId: "cofecha-test",
        includedSeriesIds: ["series-a", "series-b"],
        candidateSeriesIds: [],
        options: {
            splineRigidityYears: 32,
            splineFrequencyResponse: 0.5,
            useAutoregressiveModel: true,
            useLogTransform: true,
            useFirstDifference: false,
            omitAbsentRingsFromMaster: true,
            minReplication: 2,
            targetReplication: 10,
        },
        points: [{
            year: 1900,
            value: 0.25,
            replication: 2,
            sd: 0,
            se: 0,
            weight: 0.2,
        }],
        summary: {
            includedCount: 2,
            candidateCount: 0,
            startYear: 1900,
            endYear: 1900,
            meanReplication: 2,
            minReplication: 2,
            maxReplication: 2,
        },
    } : null,
});

describe("selectAutomaticDiagnosisReferenceConfig", () => {
    it("excludes a manual chart reference from automatic diagnosis", () => {
        expect(selectAutomaticDiagnosisReferenceConfig(makeReference("manual"))).toBeNull();
    });

    it("keeps an automatically generated dynamic reference", () => {
        const dynamicReference = makeReference("dynamic");

        expect(selectAutomaticDiagnosisReferenceConfig(dynamicReference)).toBe(dynamicReference);
    });

    it("rejects a dynamic config without generated chronology points", () => {
        const unavailable = makeReference("dynamic");
        unavailable.cofechaPassReference = null;

        expect(selectAutomaticDiagnosisReferenceConfig(unavailable)).toBeNull();
    });

    it("waits for an automatic reference instead of selecting leave-one-out", () => {
        expect(selectAutomaticDiagnosisReferenceConfig(null)).toBeNull();
    });
});
