import { describe, expect, it } from "vitest";
import {
    addDiagnosisReviewWindowPadding,
    REVIEW_EDGE_YEAR_TAG,
    restoreUnlocalizedFalseRingReviewWindow,
} from "../eventReviewWindow";
import type { DiagnosisEvent } from "../types";

const event = (
    eventType: DiagnosisEvent["eventType"],
    startYear: number,
    endYear: number,
): DiagnosisEvent => ({
    id: `${eventType}-${startYear}`,
    seriesId: "T",
    eventType,
    startYear,
    endYear,
    rankedYears: Array.from(
        { length: endYear - startYear + 1 },
        (_, index) => ({
            year: startYear + index,
            rank: index + 1,
            score: endYear - index,
            evidenceTags: ["core"],
        }),
    ),
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: ["test"],
        score: 1,
        scoreMargin: 0.1,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.3,
        correlationGain: 0.1,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 30,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
});

describe("diagnosis review-window edge padding", () => {
    it("pads primary, location, and operation windows without changing Top1", () => {
        const primary = {
            ...event("missingRing", 1900, 1906),
            locationAlternatives: [{
                rank: 1,
                startYear: 1920,
                endYear: 1926,
                rankedYears: event("missingRing", 1920, 1926).rankedYears,
                evidenceScore: 0.8,
                scoreMargin: 0.1,
                algorithmSource: "test-location",
            }],
            operationAlternatives: [event("falseRing", 1950, 1956)],
        };

        const [padded] = addDiagnosisReviewWindowPadding(
            [primary],
            { startYear: 1800, endYear: 2000 },
            1,
            1,
        );

        expect([padded.startYear, padded.endYear]).toEqual([1898, 1907]);
        expect(padded.reviewCoreRange).toEqual({ startYear: 1900, endYear: 1906 });
        expect(padded.rankedYears[0].year).toBe(1900);
        expect(padded.rankedYears.slice(-3).map((row) => row.year).sort())
            .toEqual([1898, 1899, 1907]);
        expect(padded.rankedYears.slice(-3).every((row) => (
            row.evidenceTags.includes(REVIEW_EDGE_YEAR_TAG)
        ))).toBe(true);
        expect(padded.evidence.notes).toContain("review_window_directional_extra=older");
        expect(padded.locationAlternatives?.[0]).toMatchObject({
            startYear: 1918,
            endYear: 1927,
            reviewCoreRange: { startYear: 1920, endYear: 1926 },
        });
        expect(padded.operationAlternatives?.[0]).toMatchObject({
            startYear: 1948,
            endYear: 1957,
            reviewCoreRange: { startYear: 1950, endYear: 1956 },
        });

        const [symmetricOnly] = addDiagnosisReviewWindowPadding(
            [primary],
            { startYear: 1800, endYear: 2000 },
            1,
            0,
        );
        expect([symmetricOnly.startYear, symmetricOnly.endYear])
            .toEqual([1899, 1907]);
        expect(symmetricOnly.rankedYears[0].year).toBe(1900);
        expect(symmetricOnly.evidence.notes.some((note) => (
            note.startsWith("review_window_directional_extra=")
        ))).toBe(false);
    });

    it("clamps at target boundaries and is idempotent", () => {
        const once = addDiagnosisReviewWindowPadding(
            [event("partialMove", 1800, 1808)],
            { startYear: 1800, endYear: 2000 },
        );
        const twice = addDiagnosisReviewWindowPadding(
            once,
            { startYear: 1800, endYear: 2000 },
        );

        expect([once[0].startYear, once[0].endYear]).toEqual([1800, 1809]);
        expect(twice).toEqual(once);
    });

    it("removes location options made redundant by final review padding", () => {
        const primary = {
            ...event("missingRing", 1862, 1868),
            locationAlternatives: [
                [1870, 1876],
                [1882, 1888],
                [1855, 1861],
                [1859, 1865],
            ].map(([startYear, endYear], index) => ({
                rank: index + 1,
                startYear,
                endYear,
                rankedYears: event("missingRing", startYear, endYear).rankedYears,
                evidenceScore: 1 - index / 10,
                scoreMargin: 0.1,
                algorithmSource: `location-${index + 1}`,
            })),
        };

        const [padded] = addDiagnosisReviewWindowPadding(
            [primary],
            { startYear: 1800, endYear: 2000 },
            1,
            0,
        );

        expect(padded.locationAlternatives).toHaveLength(3);
        expect(padded.locationAlternatives?.map((location) => [
            location.startYear,
            location.endYear,
        ])).toEqual([
            [1869, 1877],
            [1881, 1889],
            [1854, 1862],
        ]);
        expect(padded.evidence.notes).toContain("location_option_3=1854-1862");
        expect(padded.evidence.notes.some((note) => note.startsWith(
            "location_option_4=",
        ))).toBe(false);
    });

    it("leaves whole-series events and disabled padding unchanged", () => {
        const whole = event("wholeSeriesMove", 1800, 2000);
        expect(addDiagnosisReviewWindowPadding(
            [whole],
            { startYear: 1800, endYear: 2000 },
        )[0]).toEqual(whole);
        const local = event("missingRing", 1900, 1906);
        expect(addDiagnosisReviewWindowPadding(
            [local],
            { startYear: 1800, endYear: 2000 },
            0,
        )[0]).toBe(local);
        expect(addDiagnosisReviewWindowPadding(
            [local],
            { startYear: 1800, endYear: 2000 },
            Number.NaN,
        )[0]).toBe(local);
    });

    it("restores only an unlocalized 7-year false-ring fallback to 13 years", () => {
        const fallback = event("falseRing", 1903, 1909);
        const restored = restoreUnlocalizedFalseRingReviewWindow(
            fallback,
            { startYear: 1800, endYear: 2000 },
        );
        expect([restored.startYear, restored.endYear]).toEqual([1900, 1912]);
        expect(restored.reviewCoreRange).toEqual({
            startYear: 1903,
            endYear: 1909,
        });
        expect(restored.rankedYears[0]?.year).toBe(1903);
        expect(restored.evidence.algorithmSources).toContain(
            "unlocalized_false_ring_width_safety",
        );
        expect(restored.evidence.notes).toContain(
            "unlocalized_false_ring_window_restored_to_13",
        );
        expect(restoreUnlocalizedFalseRingReviewWindow(
            event("missingRing", 1903, 1909),
            { startYear: 1800, endYear: 2000 },
        ).endYear).toBe(1909);
    });
});
