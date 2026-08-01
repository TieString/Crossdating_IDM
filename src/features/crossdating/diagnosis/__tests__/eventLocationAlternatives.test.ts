import { describe, expect, it } from "vitest";
import {
    buildCumulativeLocationAlternatives,
    eventAtLocationAlternative,
} from "../eventLocationAlternatives";
import { planDiagnosisEventEdit } from "../eventApply";
import type { CumulativeLagChangePointScore } from "../cumulativeLagChangePoint";
import type { DiagnosisEvent, SeriesCoreDiagnosis } from "../types";

const event = (
    eventType: Exclude<DiagnosisEvent["eventType"], "wholeSeriesMove">,
    extra: Omit<Partial<DiagnosisEvent>, "eventType"> = {},
): DiagnosisEvent & {
    eventType: Exclude<DiagnosisEvent["eventType"], "wholeSeriesMove">;
} => ({
    id: `event-${eventType}`,
    seriesId: "ABC01A",
    eventType,
    startYear: 1900,
    endYear: eventType === "partialMove" ? 1908 : 1906,
    rankedYears: [{
        year: 1903,
        rank: 1,
        score: 10,
        evidenceTags: ["piecewise_lag_path"],
    }],
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: ["piecewise_lag_path"],
        score: 10,
        scoreMargin: 2,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.6,
        correlationGain: 0.4,
        lagBefore: eventType === "falseRing" ? 1 : -1,
        lagAfter: 0,
        samplePairs: 40,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
    ...extra,
});

const score = (
    year: number,
    olderLag: number,
    value: number,
): CumulativeLagChangePointScore => ({
    year,
    olderLag,
    combinedCumulative: value,
    combinedCusum: value,
    combinedContrast: 0,
    combinedLocal31: 0,
    combinedLocal61: 0,
    rawCumulative: value,
    rawCusum: value,
    rawContrast: 0,
    differenceCumulative: value,
    differenceCusum: value,
    differenceContrast: 0,
    whitenedCumulative: value,
    whitenedCusum: value,
    whitenedContrast: 0,
    cofechaCumulative: value,
    cofechaCusum: value,
    cofechaContrast: 0,
    referenceMedianCumulative: value,
    referenceMedianCusum: value,
    referenceMedianContrast: 0,
    referenceMeanCumulative: value,
    referenceMeanCusum: value,
    referenceMeanContrast: 0,
    referenceVoteCumulative: value,
    referenceVoteCusum: value,
    referenceVoteContrast: 0,
});

const diagnosis = {
    targetRange: { startYear: 1800, endYear: 2000 },
} as SeriesCoreDiagnosis;

describe("cumulative event location alternatives", () => {
    it("keeps unit-event alternatives as separate seven-year windows", () => {
        const scores = [];
        for (let year = 1800; year <= 2000; year += 1) {
            const value = year === 1903 ? 30 : year === 1930 ? 20 : year === 1850 ? 15 : 0;
            scores.push(score(year, -1, value));
        }
        const alternatives = buildCumulativeLocationAlternatives(
            event("missingRing"),
            scores,
            diagnosis,
        );

        expect(alternatives).toHaveLength(2);
        expect(alternatives.map((row) => row.endYear - row.startYear + 1))
            .toEqual([7, 7]);
        expect(alternatives.map((row) => row.rankedYears[0].year))
            .toEqual([1930, 1850]);
    });

    it("uses the selected partial alternative's own boundary shift when applying", () => {
        const scores = [];
        for (let year = 1800; year <= 2000; year += 1) {
            for (const lag of [-5, -4, -3, -2]) {
                const value = year === 1940 && lag === -4
                    ? 30
                    : year === 1860 && lag === -2 ? 20 : 0;
                scores.push(score(year, lag, value));
            }
        }
        const partial = event("partialMove", {
            shiftYears: -2,
            shiftSide: "older",
        });
        const alternatives = buildCumulativeLocationAlternatives(
            partial,
            scores,
            diagnosis,
        );
        const selected = eventAtLocationAlternative(partial, alternatives[0]);
        const selectedYear = selected.rankedYears[0].year;
        const plan = planDiagnosisEventEdit(selected, selectedYear, 1800, 2000);

        expect(alternatives[0].shiftYears).toBe(-2);
        expect(alternatives[0].endYear - alternatives[0].startYear + 1).toBe(9);
        expect(plan).toMatchObject({
            operationType: "SHIFT_RANGE",
            endYear: selectedYear - 1,
            shiftYears: -2,
        });
    });
});
