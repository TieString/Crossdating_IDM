import { describe, expect, it } from "vitest";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import { preprocessSeries } from "../series";
import { scoreUnitEventExactYearEvidence } from "../unitEventExactYearEvidence";
import type { NumericSeries, SeriesCoreDiagnosis } from "../types";

const START_YEAR = 1900;
const END_YEAR = 2000;
const EVENT_YEAR = 1950;
const CANDIDATE_YEARS = Array.from(
    { length: 9 },
    (_, index) => EVENT_YEAR - 4 + index,
);

const correctSeries = (): NumericSeries => new Map(Array.from(
    { length: END_YEAR - START_YEAR + 1 },
    (_, index) => {
        const year = START_YEAR + index;
        const value = 140
            + Math.sin(index / 2.7) * 30
            + Math.cos(index / 7.3) * 18
            + ((index * 17) % 23);
        return [year, value];
    },
));

const corrupt = (
    eventType: "missingRing" | "falseRing",
    correct: NumericSeries,
): NumericSeries => {
    const result = new Map<number, number>();
    if (eventType === "missingRing") {
        for (let year = START_YEAR + 1; year <= END_YEAR; year += 1) {
            const value = correct.get(year > EVENT_YEAR ? year : year - 1);
            if (value !== undefined) result.set(year, value);
        }
        return result;
    }
    for (let year = START_YEAR - 1; year <= END_YEAR; year += 1) {
        if (year > EVENT_YEAR) {
            const value = correct.get(year);
            if (value !== undefined) result.set(year, value);
        } else if (year === EVENT_YEAR) {
            result.set(
                year,
                ((correct.get(year - 1) ?? 0) + (correct.get(year + 1) ?? 0)) / 2,
            );
        } else {
            const value = correct.get(year + 1);
            if (value !== undefined) result.set(year, value);
        }
    }
    return result;
};

const fixture = (
    eventType: "missingRing" | "falseRing",
): { diagnosis: SeriesCoreDiagnosis; site: RwlSiteData } => {
    const correct = correctSeries();
    const sourceTrees = Array.from({ length: 8 }, (_, index) => `REF${index}`);
    const site: RwlSiteData = new Map(sourceTrees.map((tree, referenceIndex) => [
        tree,
        new Map([...correct].map(([year, value], index) => [
            year,
            value * (1 + referenceIndex * 0.015)
                + Math.sin((index + referenceIndex) / 11) * 2,
        ])) as RwlTreeData,
    ]));
    const rawTarget = corrupt(eventType, correct);
    site.set("TARGET", new Map(rawTarget) as RwlTreeData);
    return {
        site,
        diagnosis: {
            targetTree: "TARGET",
            rawTarget,
            targetRange: {
                startYear: Math.min(...rawTarget.keys()),
                endYear: Math.max(...rawTarget.keys()),
            },
            master: {
                data: preprocessSeries(correct),
                sampleDepth: new Map([...correct.keys()].map((year) => [year, 8])),
                sourceTrees,
            },
            segments: [],
            propagationPatterns: [],
            globalSlidingMatch: {} as SeriesCoreDiagnosis["globalSlidingMatch"],
            unresolvedA: 0,
            unresolvedB: 0,
        },
    };
};

describe("unit event exact-year diagnostic evidence", () => {
    it.each(["missingRing", "falseRing"] as const)(
        "keeps production scores stable while exposing %s audit profiles",
        (eventType) => {
            const { diagnosis, site } = fixture(eventType);
            const production = scoreUnitEventExactYearEvidence(
                diagnosis,
                site,
                eventType,
                CANDIDATE_YEARS,
            );
            const audited = scoreUnitEventExactYearEvidence(
                diagnosis,
                site,
                eventType,
                CANDIDATE_YEARS,
                true,
            );

            expect(audited?.scoreByYear).toEqual(production?.scoreByYear);
            expect(production?.diagnosticProfiles).toBeUndefined();
            if (eventType === "missingRing") {
                expect(production?.fixedWindowProfiles?.size).toBe(12);
                production?.fixedWindowProfiles?.forEach((scores) => {
                    expect([...scores.keys()]).toEqual(CANDIDATE_YEARS);
                    expect([...scores.values()].every(Number.isFinite)).toBe(true);
                });
            } else {
                expect(production?.fixedWindowProfiles?.size).toBe(7);
                expect(production?.fixedWindowProfiles?.has(
                    "differenceMasterHuberFixedWindowPlus12",
                )).toBe(true);
                expect(production?.fixedWindowProfiles?.has(
                    "falseMergeOlderDifferenceMasterHuberFixedWindowPlus12",
                )).toBe(true);
                production?.fixedWindowProfiles?.forEach((scores) => {
                    expect([...scores.keys()]).toEqual(CANDIDATE_YEARS);
                    expect([...scores.values()].every(Number.isFinite)).toBe(true);
                });
                const profiles = audited?.diagnosticProfiles;
                const stateScores = profiles?.get("falseStateFixedWindowWeighted");
                const stateTopYear = [...(stateScores?.entries() ?? [])].sort(
                    (left, right) => right[1] - left[1] || left[0] - right[0],
                )[0]?.[0];
                expect(stateTopYear).toBe(EVENT_YEAR);

                const lagStepScores = profiles?.get(
                    "falseLagStepMinimumSupportFixedWindowWeighted",
                );
                const lagStepTopYear = [...(lagStepScores?.entries() ?? [])].sort(
                    (left, right) => right[1] - left[1] || left[0] - right[0],
                )[0]?.[0];
                expect(lagStepTopYear).toBe(EVENT_YEAR);

                const bridgeScores = profiles?.get("falseBoundaryBridgeRadius1Median");
                expect(bridgeScores?.get(EVENT_YEAR)).toBeGreaterThan(
                    bridgeScores?.get(EVENT_YEAR - 1) ?? Number.NEGATIVE_INFINITY,
                );
                expect(bridgeScores?.get(EVENT_YEAR)).toBeGreaterThan(
                    bridgeScores?.get(EVENT_YEAR + 1) ?? Number.NEGATIVE_INFINITY,
                );
            }
            expect(audited?.diagnosticProfiles?.size).toBeGreaterThanOrEqual(20);
            audited?.diagnosticProfiles?.forEach((scores) => {
                expect([...scores.keys()]).toEqual(CANDIDATE_YEARS);
                expect([...scores.values()].every(Number.isFinite)).toBe(true);
            });
        },
    );
});
