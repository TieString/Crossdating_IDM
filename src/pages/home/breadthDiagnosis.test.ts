import { describe, expect, it } from "vitest";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis";
import {
    createBreadthDiagnosisSuggestion,
    orderBreadthScanTargets,
    sortBreadthDiagnosisSuggestions,
} from "./breadthDiagnosis";

const makeEvent = (
    seriesId: string,
    topYear: number,
    eventType: DiagnosisEvent["eventType"] = "missingRing",
): DiagnosisEvent => ({
    id: `${seriesId}-${topYear}`,
    seriesId,
    eventType,
    startYear: topYear - 2,
    endYear: topYear + 2,
    rankedYears: [{ year: topYear, rank: 1, score: 2, evidenceTags: [] }],
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: ["test"],
        score: 2,
        scoreMargin: 0.4,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.6,
        correlationGain: 0.4,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 40,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
    reviewOnly: true,
});

describe("breadth diagnosis FIFO", () => {
    it("scans COFECHA-flagged series first without disturbing stable group order", () => {
        expect(orderBreadthScanTargets(
            ["mon011", "mon052", "mtr841", "mon142"],
            ["MTR841", "mon052"],
        )).toEqual(["mon052", "mtr841", "mon011", "mon142"]);
    });

    it("preserves queue age for the same frontier but queues a distant next event last", () => {
        const original = createBreadthDiagnosisSuggestion(makeEvent("mon052", 1977), undefined, 4, 1000);
        const nearby = createBreadthDiagnosisSuggestion(makeEvent("mon052", 1978), original, 20, 2000);
        const nextEvent = createBreadthDiagnosisSuggestion(makeEvent("mon052", 1861), nearby, 21, 3000);

        expect(nearby.firstSeenOrder).toBe(4);
        expect(nearby.firstSeenAt).toBe(1000);
        expect(nextEvent.firstSeenOrder).toBe(21);
        expect(nextEvent.firstSeenAt).toBe(3000);
    });

    it("ranks visible rows by first-seen FIFO order rather than score or series name", () => {
        const late = createBreadthDiagnosisSuggestion(makeEvent("AAA", 1900), undefined, 9, 9000);
        const early = createBreadthDiagnosisSuggestion(makeEvent("ZZZ", 1800), undefined, 2, 2000);

        expect(sortBreadthDiagnosisSuggestions([late, early]).map((item) => item.seriesId))
            .toEqual(["ZZZ", "AAA"]);
    });
});
