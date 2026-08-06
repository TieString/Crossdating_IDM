import { describe, expect, it } from "vitest";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    compareBootstrapReviewQueueCandidates,
    findAbsoluteUnidentifiableTruthYears,
    selectAutomaticBootstrapApplication,
} from "../bootstrapEvaluation";
import type { DiagnosisEvent } from "../types";

const diagnosisEvent = (
    seriesId: string,
    eventType: DiagnosisEvent["eventType"],
    year: number,
    score: number,
    extra: Partial<DiagnosisEvent> = {},
): DiagnosisEvent => ({
    id: `${seriesId}-${eventType}-${year}`,
    seriesId,
    eventType,
    startYear: year - 2,
    endYear: year + 2,
    rankedYears: [{ year, rank: 1, score, evidenceTags: [] }],
    confidenceLevel: "high",
    evidence: {
        algorithmSources: ["piecewise_lag_path"],
        score,
        scoreMargin: score / 2,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.6,
        correlationGain: 0.4,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 50,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
    ...extra,
});

describe("bootstrap evaluation isolation", () => {
    it("reviews the oldest visible event before newer high-score events", () => {
        const candidates = [
            {
                seriesId: "NEW_HIGH",
                reviewQueueEnteredRound: 20,
                reviewStatus: "strict" as const,
                score: 100,
            },
            {
                seriesId: "OLD_LOW",
                reviewQueueEnteredRound: 5,
                reviewStatus: "review" as const,
                score: 1,
            },
            {
                seriesId: "OLD_STRICT",
                reviewQueueEnteredRound: 5,
                reviewStatus: "strict" as const,
                score: 0.5,
            },
        ];

        candidates.sort(compareBootstrapReviewQueueCandidates);

        expect(candidates.map((candidate) => candidate.seriesId)).toEqual([
            "OLD_STRICT",
            "OLD_LOW",
            "NEW_HIGH",
        ]);
    });

    it("selects an executable automatic action without accepting hidden truth", () => {
        const site: RwlSiteData = new Map([
            ["A", new Map(Array.from({ length: 101 }, (_, index) => [1900 + index, index + 1]))],
            ["B", new Map(Array.from({ length: 101 }, (_, index) => [1900 + index, index + 2]))],
        ]);
        const nonExecutableWholeMove = diagnosisEvent("A", "wholeSeriesMove", 1950, 100);
        const missing = diagnosisEvent("B", "missingRing", 1940, 50);

        const selected = selectAutomaticBootstrapApplication(
            [nonExecutableWholeMove, missing],
            site,
        );

        expect(selected?.event.id).toBe(missing.id);
        expect(selected?.selectedYear).toBe(1940);
        expect(selectAutomaticBootstrapApplication.length).toBe(2);
    });

    it("marks only a truth shared by every overlapping series as absolute-unidentifiable", () => {
        const site: RwlSiteData = new Map([
            ["A", new Map([[1900, 1], [1950, 2], [2000, 3]])],
            ["B", new Map([[1920, 1], [1960, 2], [2000, 3]])],
            ["C", new Map([[1925, 1], [2000, 2]])],
        ]);
        const truths = new Map<string, readonly number[]>([
            ["A", [1930, 1990]],
            ["B", [1930, 1990]],
            ["C", [1990]],
        ]);

        expect(Array.from(findAbsoluteUnidentifiableTruthYears(site, truths))).toEqual([1990]);
    });
});
