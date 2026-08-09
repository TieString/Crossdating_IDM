import { describe, expect, it } from "vitest";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    hasDecisiveNewerSideFixedEvidence,
    scoreNewerSideEndpointOperationContrast,
} from "../endpointOperationContrast";
import { prioritizeEndpointUnitAgainstWhole } from "../eventEnsemble";
import { preprocessSeries } from "../series";
import type { DiagnosisEvent, SeriesCoreDiagnosis } from "../types";

const sourceSeries = (): Map<number, number> => {
    let state = 0x7f4a7c15;
    const result = new Map<number, number>();
    for (let year = 1780; year <= 2025; year += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        result.set(year, 100 + state % 1900);
    }
    return result;
};

const event = (
    eventType: "wholeSeriesMove" | "missingRing",
    boundaryYear: number,
): DiagnosisEvent => ({
    id: `${eventType}-${boundaryYear}`,
    seriesId: "TARGET",
    eventType,
    startYear: eventType === "wholeSeriesMove" ? 1800 : boundaryYear - 6,
    endYear: eventType === "wholeSeriesMove" ? 2023 : boundaryYear + 6,
    rankedYears: eventType === "wholeSeriesMove" ? [] : [{
        year: boundaryYear,
        rank: 1,
        score: 1,
        evidenceTags: [],
    }],
    confidenceLevel: "medium",
    evidence: {
        score: 1,
        scoreMargin: 1,
        baselineCorrelation: 0,
        correctedCorrelation: 1,
        correlationGain: 1,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 100,
        algorithmSources: eventType === "wholeSeriesMove"
            ? ["cofecha_segment_lag"]
            : ["series_endpoint_review_window"],
        candidateIds: [],
        notes: eventType === "wholeSeriesMove"
            ? ["whole_baseline_source=cofecha_terminal_lag"]
            : [],
    },
    alternativeTypes: [],
    ...(eventType === "wholeSeriesMove" ? { shiftYears: -1 } : {}),
});

const fixture = (fixedNewerSide: boolean) => {
    const source = sourceSeries();
    const boundaryYear = 2015;
    const target = new Map<number, number>();
    for (let year = 1800; year <= 2023; year += 1) {
        const sourceYear = fixedNewerSide && year > boundaryYear ? year : year - 1;
        target.set(year, source.get(sourceYear)!);
    }
    const referenceIds = Array.from({ length: 10 }, (_, index) => `REF${index}A`);
    const siteData: RwlSiteData = new Map([
        ["TARGET", target],
        ...referenceIds.map((id) => [id, new Map(source)] as const),
    ]);
    const diagnosis = {
        targetTree: "TARGET",
        rawTarget: target,
        targetRange: { startYear: 1800, endYear: 2023 },
        master: {
            data: preprocessSeries(source),
            sampleDepth: new Map(),
            sourceTrees: referenceIds,
        },
    } as SeriesCoreDiagnosis;
    const whole = event("wholeSeriesMove", boundaryYear);
    const missing = event("missingRing", boundaryYear);
    const contrast = scoreNewerSideEndpointOperationContrast(
        diagnosis,
        siteData,
        whole,
        missing,
    );
    return { contrast, diagnosis, siteData, whole, missing };
};

describe("newer-side endpoint operation contrast", () => {
    it("accepts a local unit event whose newer side remains at lag zero", () => {
        const { contrast } = fixture(true);
        expect(contrast).not.toBeNull();
        expect(hasDecisiveNewerSideFixedEvidence(contrast!)).toBe(true);
        expect(contrast!.positiveReferenceFraction).toBe(1);
    });

    it("retains a real whole-series lag when the newer side is shifted too", () => {
        const { contrast } = fixture(false);
        expect(contrast).not.toBeNull();
        expect(hasDecisiveNewerSideFixedEvidence(contrast!)).toBe(false);
        expect(contrast!.positiveReferenceFraction).toBe(0);
    });

    it("removes a terminal whole alias only when the newer side stays fixed", () => {
        const local = fixture(true);
        local.missing.evidence.algorithmSources = [
            "newer_endpoint_unit_alias_of_global_lag",
        ];
        const localResult = prioritizeEndpointUnitAgainstWhole(
            [local.whole, local.missing],
            local.diagnosis,
            local.siteData,
        );
        expect(localResult).toHaveLength(1);
        expect(localResult[0].eventType).toBe("missingRing");
        expect(localResult[0].evidence.algorithmSources)
            .toContain("terminal_whole_alias_removed");

        const global = fixture(false);
        global.missing.evidence.algorithmSources = [
            "newer_endpoint_unit_alias_of_global_lag",
        ];
        expect(prioritizeEndpointUnitAgainstWhole(
            [global.whole, global.missing],
            global.diagnosis,
            global.siteData,
        )).toEqual([global.whole, global.missing]);
    });
});
