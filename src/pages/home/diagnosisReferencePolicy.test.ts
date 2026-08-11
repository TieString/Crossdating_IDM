import { describe, expect, it } from "vitest";

import type { ReferenceSeriesConfig } from "@/features/crossdating/reference";
import { selectAutomaticDiagnosisReferenceConfig } from "./diagnosisReferencePolicy";

const makeReference = (mode: "manual" | "dynamic"): ReferenceSeriesConfig => ({
    selectedTrees: ["series-a", "series-b"],
    minSampleDepth: 2,
    method: "mean",
    updatedAt: "2026-08-11T00:00:00.000Z",
    mode,
});

describe("selectAutomaticDiagnosisReferenceConfig", () => {
    it("excludes a manual chart reference from automatic diagnosis", () => {
        expect(selectAutomaticDiagnosisReferenceConfig(makeReference("manual"))).toBeNull();
    });

    it("keeps an automatically generated dynamic reference", () => {
        const dynamicReference = makeReference("dynamic");

        expect(selectAutomaticDiagnosisReferenceConfig(dynamicReference)).toBe(dynamicReference);
    });

    it("keeps the automatic leave-one-out path when no dynamic reference exists", () => {
        expect(selectAutomaticDiagnosisReferenceConfig(null)).toBeNull();
    });
});
