import { describe, expect, it } from "vitest";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    calculateBreadthSuggestionPriority,
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

const makeSiteData = (): RwlSiteData => new Map([
    ["target", new Map(Array.from({ length: 10 }, (_, index) => [1900 + index, 100]))],
    ["reference-a", new Map(Array.from({ length: 10 }, (_, index) => [1900 + index, 200]))],
    ["reference-b", new Map(Array.from({ length: 5 }, (_, index) => [1905 + index, 300]))],
]);

describe("breadth diagnosis priority", () => {
    it("only scans COFECHA A-flagged series in stable file order", () => {
        expect(orderBreadthScanTargets(
            ["mon011", "mon052", "mtr841", "mon142"],
            ["MTR841", "mon052"],
        )).toEqual(["mon052", "mtr841"]);
    });

    it("rechecks only previously ranked frontiers that are still A-flagged", () => {
        expect(orderBreadthScanTargets(
            ["mon011", "mon052", "mtr841", "mon142"],
            ["MTR841", "mon052"],
            ["mtr841", "mon142"],
        )).toEqual(["mtr841", "mon052"]);
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

    it("ranks a later strict high-confidence event ahead of an earlier weak review event", () => {
        const strongEvent = makeEvent("AAA", 1900);
        strongEvent.confidenceLevel = "high";
        strongEvent.reviewOnly = false;
        const weakEvent = makeEvent("ZZZ", 1800);
        weakEvent.confidenceLevel = "low";
        const lateStrong = createBreadthDiagnosisSuggestion(strongEvent, undefined, 9, 9000);
        const earlyWeak = createBreadthDiagnosisSuggestion(weakEvent, undefined, 2, 2000);

        expect(sortBreadthDiagnosisSuggestions([earlyWeak, lateStrong]).map((item) => item.seriesId))
            .toEqual(["AAA", "ZZZ"]);
    });

    it("prefers the bark-side frontier when reliability is equal", () => {
        const olderEvent = makeEvent("older", 1850);
        olderEvent.seriesRange = { startYear: 1800, endYear: 2000 };
        const newerEvent = makeEvent("newer", 1980);
        newerEvent.seriesRange = { startYear: 1800, endYear: 2000 };
        const older = createBreadthDiagnosisSuggestion(olderEvent, undefined, 1, 1000);
        const newer = createBreadthDiagnosisSuggestion(newerEvent, undefined, 2, 2000);

        expect(sortBreadthDiagnosisSuggestions([older, newer]).map((item) => item.seriesId))
            .toEqual(["newer", "older"]);
    });

    it("uses FIFO only when evidence and recovery value tie", () => {
        const late = createBreadthDiagnosisSuggestion(makeEvent("AAA", 1900), undefined, 9, 9000);
        const early = createBreadthDiagnosisSuggestion(makeEvent("ZZZ", 1900), undefined, 2, 2000);

        expect(sortBreadthDiagnosisSuggestions([late, early]).map((item) => item.seriesId))
            .toEqual(["ZZZ", "AAA"]);
    });

    it("measures the affected frontier and shared-reference overlap from working data", () => {
        const event = makeEvent("target", 1907);
        event.seriesRange = { startYear: 1900, endYear: 1909 };

        expect(calculateBreadthSuggestionPriority(event, makeSiteData())).toMatchObject({
            frontierRatio: 0.8,
            sharedOverlapYears: 8,
            weightedReferenceOverlap: 11,
            newerEndDistanceYears: 2,
            windowWidth: 5,
        });
    });

    it("keeps a partial-move first-fixed year out of the affected older side", () => {
        const event = makeEvent("target", 1907, "partialMove");
        event.shiftYears = -4;
        event.seriesRange = { startYear: 1900, endYear: 1909 };

        expect(calculateBreadthSuggestionPriority(event, makeSiteData())).toMatchObject({
            frontierRatio: 0.7,
            sharedOverlapYears: 7,
            newerEndDistanceYears: 3,
        });
    });
});
