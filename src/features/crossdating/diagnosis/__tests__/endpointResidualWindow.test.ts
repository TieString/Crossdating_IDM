import { describe, expect, it } from "vitest";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import {
    refineUnitEventWithEndpointResidualWindow,
    shouldPromoteFalseRingPosteriorYear,
    shouldTrimFalseRingNewerEdge,
} from "../endpointResidualWindow";
import type {
    DiagnosisEvent,
    SeriesCoreDiagnosis,
} from "../types";

const START_YEAR = 1800;
const END_YEAR = 1999;
const TRUTH_YEAR = 1900;

const signalValue = (index: number): number => {
    const seasonal = Math.sin(index * 0.43) * 110 + Math.cos(index * 0.17) * 65;
    const pulse = ((index * 73 + 19) % 97) - 48;
    return Math.max(20, Math.round(620 + index * 0.7 + seasonal + pulse * 2.2));
};

const correctSeries = (): RwlTreeData => new Map(
    Array.from({ length: END_YEAR - START_YEAR + 1 }, (_, index) => [
        START_YEAR + index,
        signalValue(index),
    ]),
);

const missingRingSeries = (correct: RwlTreeData): RwlTreeData => {
    const corrupted: RwlTreeData = new Map();
    for (let year = START_YEAR + 1; year <= END_YEAR; year += 1) {
        const sourceYear = year > TRUTH_YEAR ? year : year - 1;
        const value = correct.get(sourceYear);
        if (typeof value === "number") corrupted.set(year, value);
    }
    return corrupted;
};

const event = (): DiagnosisEvent => ({
    id: "event",
    seriesId: "TGT01a",
    eventType: "missingRing",
    startYear: 1860,
    endYear: 1868,
    rankedYears: Array.from({ length: 9 }, (_, index) => ({
        year: 1860 + index,
        rank: index + 1,
        score: 9 - index,
        evidenceTags: ["fixture"],
    })),
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: ["fixture"],
        score: 1,
        scoreMargin: 0.2,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.6,
        correlationGain: 0.4,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 100,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
});

const fixture = (referenceCount = 8) => {
    const correct = correctSeries();
    const target = missingRingSeries(correct);
    const site: RwlSiteData = new Map([["TGT01a", target]]);
    const sourceTrees: string[] = [];
    for (let referenceIndex = 0; referenceIndex < referenceCount; referenceIndex += 1) {
        const id = `REF${referenceIndex.toString().padStart(2, "0")}a`;
        sourceTrees.push(id);
        site.set(id, new Map(Array.from(correct.entries()).map(([year, value]) => [
            year,
            typeof value === "number"
                ? Math.max(1, value + ((year + referenceIndex * 11) % 9) - 4)
                : value,
        ])));
    }
    const diagnosis = {
        targetTree: "TGT01a",
        rawTarget: new Map(Array.from(target.entries()).flatMap(([year, value]) => (
            typeof value === "number" && value > 0 ? [[year, value] as const] : []
        ))),
        targetRange: {
            startYear: START_YEAR + 1,
            endYear: END_YEAR,
        },
        master: {
            data: new Map(),
            sampleDepth: new Map(),
            sourceTrees,
        },
        segments: [],
        propagationPatterns: [],
        globalSlidingMatch: {
            seriesId: "TGT01a",
            lagResults: [],
            bestGlobalLag: 0,
            bestGlobalR: null,
            bestGlobalTLike: null,
            overlapYears: 0,
            currentR: null,
            currentTLike: null,
            currentOverlapYears: 0,
        },
        unresolvedA: 1,
        unresolvedB: 0,
    } as SeriesCoreDiagnosis;
    return { site, diagnosis };
};

describe("endpoint residual single-main-window refinement", () => {
    it("moves one strong missing-ring event to one compact window containing the truth", () => {
        const { site, diagnosis } = fixture();
        const refined = refineUnitEventWithEndpointResidualWindow(
            event(),
            diagnosis,
            site,
        );

        expect(refined.endYear - refined.startYear + 1).toBe(7);
        expect(TRUTH_YEAR).toBeGreaterThanOrEqual(refined.startYear);
        expect(TRUTH_YEAR).toBeLessThanOrEqual(refined.endYear);
        expect(refined.evidence.algorithmSources).toContain("endpoint_residual_posterior");
        expect(refined.rankedYears).toHaveLength(
            refined.endYear - refined.startYear + 1,
        );
        expect(refined.locationAlternatives ?? []).toHaveLength(0);
    });

    it("keeps the original window when fewer than five references are available", () => {
        const { site, diagnosis } = fixture(4);
        const original = event();
        const refined = refineUnitEventWithEndpointResidualWindow(
            original,
            diagnosis,
            site,
        );

        expect(refined).toBe(original);
    });

    it("keeps the existing evidence order among years retained by the narrow window", () => {
        const { site, diagnosis } = fixture();
        const original = event();
        original.startYear = TRUTH_YEAR - 3;
        original.endYear = TRUTH_YEAR + 3;
        original.rankedYears = [
            TRUTH_YEAR + 2,
            TRUTH_YEAR,
            TRUTH_YEAR + 1,
            TRUTH_YEAR - 1,
            TRUTH_YEAR + 3,
            TRUTH_YEAR - 2,
            TRUTH_YEAR - 3,
        ].map((year, index) => ({
            year,
            rank: index + 1,
            score: 7 - index,
            evidenceTags: ["fixture"],
        }));

        const refined = refineUnitEventWithEndpointResidualWindow(
            original,
            diagnosis,
            site,
        );

        expect(refined.rankedYears[0]?.year).toBe(TRUTH_YEAR + 2);
    });

    it("trims only a false-ring newer edge rejected by independent evidence", () => {
        const original = event();
        original.eventType = "falseRing";
        original.evidence.notes = [
            "unit_local_raw31_year=1900",
            "unit_local_difference31_year=1900",
            "unit_local_whitened31_year=1900",
            "unit_local_combo31_year=1900",
            "unit_local_combo41_year=1900",
            "unit_local_combo61_year=1900",
            "unit_local_multiScale_year=1900",
        ];

        expect(shouldTrimFalseRingNewerEdge(
            original,
            { startYear: 1897, endYear: 1903 },
            1900,
            1900,
        )).toBe(true);
        expect(shouldTrimFalseRingNewerEdge(
            original,
            { startYear: 1897, endYear: 1903 },
            1900,
            1902,
        )).toBe(false);
    });

    it("promotes the posterior year only under strong false-ring consensus", () => {
        const original = event();
        original.eventType = "falseRing";
        original.evidence.notes = [
            "scan_top_year=1900",
            "raw_path_top_year=1900",
            "direct_transition_year=1900",
            "unit_local_raw31_year=1900",
            "unit_local_difference31_year=1900",
        ];

        expect(shouldPromoteFalseRingPosteriorYear(
            original,
            { startYear: 1897, endYear: 1903 },
            1897,
            1900,
        )).toBe(true);
        expect(shouldPromoteFalseRingPosteriorYear(
            original,
            { startYear: 1897, endYear: 1903 },
            1897,
            1901,
        )).toBe(false);
    });

    it("does not override a window that already contains an explicit zero", () => {
        const { site, diagnosis } = fixture();
        const target = site.get("TGT01a");
        target?.set(1864, 0);
        const original = event();
        const refined = refineUnitEventWithEndpointResidualWindow(
            original,
            diagnosis,
            site,
        );

        expect(refined).toBe(original);
    });
});
