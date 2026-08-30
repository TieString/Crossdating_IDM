import { describe, expect, it } from "vitest";

import {
    buildOnlineUnifiedLocationPackages,
    type OnlineUnifiedEvidenceBundle,
} from "../onlineUnifiedEvidence";

const bundle = (): OnlineUnifiedEvidenceBundle => ({
    schemaVersion: 1,
    evidenceVersion: "online-unified-evidence-v1",
    seriesId: "TARGET",
    targetRange: { startYear: 1800, endYear: 1900 },
    cofechaFlagged: true,
    referenceSourceCount: 8,
    minimumReferenceDepth: 4,
    medianReferenceDepth: 7,
    candidateCount: 3,
    candidateModeCount: 2,
    finalReason: "event_selected",
    pass: {},
    claims: [
        {
            claimId: "one",
            stage: "final",
            eventType: "missingRing",
            shiftYears: -1,
            startYear: 1848,
            endYear: 1854,
            topYear: 1851,
            confidence: "high",
            score: 2,
            scoreMargin: 0.4,
            lagBefore: -1,
            lagAfter: 0,
            samplePairs: 80,
            baselineCorrelation: 0.2,
            correctedCorrelation: 0.5,
            correlationGain: 0.3,
            algorithmSources: ["counterfactual"],
            notes: [],
            candidateIds: [],
        },
        {
            claimId: "two",
            stage: "locator",
            eventType: "missingRing",
            shiftYears: -1,
            startYear: 1850,
            endYear: 1862,
            topYear: 1857,
            confidence: "medium",
            score: 1.4,
            scoreMargin: 0.2,
            lagBefore: -1,
            lagAfter: 0,
            samplePairs: 64,
            baselineCorrelation: 0.25,
            correctedCorrelation: 0.43,
            correlationGain: 0.18,
            algorithmSources: ["locator"],
            notes: [],
            candidateIds: [],
        },
    ],
    operations: [{
        eventType: "missingRing",
        shiftYears: -1,
        bestYear: 1851,
        dynamicScore: 2,
        bestRawGain: 0.2,
        bestDifferenceGain: 0.3,
        bestCombinedGain: 0.4,
        topThreeDifferenceGain: 0.25,
        remoteDifferenceMargin: 0.1,
        baselineLag: 0,
    }],
    dynamicSelection: null,
    unitSelection: null,
    rawGlobalLag: 0,
    cofechaGlobalLag: 0,
});

describe("online unified location packages", () => {
    it("selects the same compact window as the exhaustive package path", () => {
        const evidence = bundle();
        const identity = { eventType: "missingRing" as const, shiftYears: -1 };
        const exhaustive = buildOnlineUnifiedLocationPackages(evidence, identity, {
            compactWindowPerYear: false,
        });
        const expected = [...new Set(exhaustive.map((row) => row.topYear))].map((year) => (
            exhaustive.filter((row) => row.topYear === year).sort((left, right) => (
                Number(right.features.claim_window_top_exact_count)
                    - Number(left.features.claim_window_top_exact_count)
                || Number(right.features.claim_window_exact_count)
                    - Number(left.features.claim_window_exact_count)
                || Number(right.features.claim_window_max_overlap_ratio)
                    - Number(left.features.claim_window_max_overlap_ratio)
                || right.width - left.width
                || Math.abs(Number(left.features.window_center_delta_top))
                    - Math.abs(Number(right.features.window_center_delta_top))
                || left.startYear - right.startYear
            ))[0]!.packageId
        ));
        const compact = buildOnlineUnifiedLocationPackages(evidence, identity)
            .map((row) => row.packageId);
        expect(compact).toEqual(expected);
    });
});
