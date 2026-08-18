import { describe, expect, it } from "vitest";
import { deleteYearWithMode, insertMissingYearAtSide } from "@/features/rwl/edit";
import type { RwlTreeData } from "@/features/rwl/types";
import { analyzePairwiseMismatch } from "./pairwiseMismatch";

const makeSeries = (
    startYear = 1800,
    endYear = 2020,
    seed = 0x12345678,
): RwlTreeData => {
    let state = seed;
    const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
    return new Map(Array.from(
        { length: endYear - startYear + 1 },
        (_, index) => {
            const year = startYear + index;
            const climate = (random() - 0.5) * 520;
            const lowFrequency = Math.sin(index / 11) * 90 + Math.cos(index / 23) * 55;
            return [year, Math.max(80, Math.round(1050 + climate + lowFrequency))] as const;
        },
    ));
};

const analyze = (targetData: RwlTreeData, comparatorData: RwlTreeData) => (
    analyzePairwiseMismatch({
        targetTree: "target",
        targetData,
        comparatorId: "reference",
        comparatorLabel: "reference",
        comparatorData,
        comparatorKind: "series",
        comparatorDepth: 1,
    })
);

describe("pairwise mismatch analysis", () => {
    it("keeps two aligned lines free of dating suggestions", () => {
        const reference = makeSeries();
        const result = analyze(new Map(reference), reference);

        expect(result.status).toBe("aligned");
        expect(result.event).toBeNull();
        expect(result.currentCorrelation).toBeGreaterThan(0.95);
    });

    it("locates a missing-ring mismatch and emits the existing event contract", () => {
        const reference = makeSeries();
        const corrupted = deleteYearWithMode(reference, 1994, "direct", "right");
        const result = analyze(corrupted, reference);

        expect(result.status, JSON.stringify(result, null, 2)).toBe("mismatch");
        expect(result.event, JSON.stringify(result, null, 2)).toMatchObject({
            seriesId: "target",
            eventType: "missingRing",
            evidence: {
                lagBefore: -1,
                lagAfter: 0,
            },
        });
        expect(result.event!.startYear).toBeLessThanOrEqual(1994);
        expect(result.event!.endYear).toBeGreaterThanOrEqual(1994);
        expect(result.event!.confidenceLevel).not.toBe("high");
        expect(result.event!.evidence.algorithmSources).toContain("pairwise_mismatch");
    });

    it("projects the opposite unit transition as a false-ring suggestion", () => {
        const reference = makeSeries();
        const corrupted = insertMissingYearAtSide(reference, 1994, "right");
        const result = analyze(corrupted, reference);

        expect(result.status, JSON.stringify(result, null, 2)).toBe("mismatch");
        expect(result.event, JSON.stringify(result, null, 2)).toMatchObject({
            eventType: "falseRing",
            evidence: { lagBefore: 1, lagAfter: 0 },
        });
        expect(result.event!.startYear).toBeLessThanOrEqual(1994);
        expect(result.event!.endYear).toBeGreaterThanOrEqual(1994);
    });

    it("reuses the partial-move event for a multi-year older-side mismatch", () => {
        const reference = makeSeries();
        const corrupted: RwlTreeData = new Map();
        reference.forEach((value, year) => {
            corrupted.set(year < 1994 ? year + 3 : year, value);
        });
        const result = analyze(corrupted, reference);

        expect(result.status, JSON.stringify(result, null, 2)).toBe("mismatch");
        expect(result.event, JSON.stringify(result, null, 2)).toMatchObject({
            eventType: "partialMove",
            shiftYears: -3,
            shiftSide: "older",
            evidence: { lagBefore: -3, lagAfter: 0 },
        });
        expect(result.event!.startYear).toBeLessThanOrEqual(1994);
        expect(result.event!.endYear).toBeGreaterThanOrEqual(1994);
    });

    it("reports a whole shift without inventing a mismatch boundary", () => {
        const reference = makeSeries();
        const shifted = new Map(Array.from(reference, ([year, value]) => [year + 2, value]));
        const result = analyze(shifted, reference);

        expect(result.status).toBe("whole-shift");
        expect(result.globalLag).toBe(-2);
        expect(result.event).toBeNull();
    });

    it("does not turn unrelated growth noise into an edit suggestion", () => {
        const target = makeSeries();
        const unrelated = makeSeries(1800, 2020, 0x87654321);
        const result = analyze(target, unrelated);

        expect(result.event).toBeNull();
        expect(result.status).toBe("ambiguous");
    });

    it("preserves the depth of a derived reference for confidence", () => {
        const reference = makeSeries();
        const corrupted = deleteYearWithMode(reference, 1994, "direct", "right");
        const result = analyzePairwiseMismatch({
            targetTree: "target",
            targetData: corrupted,
            comparatorId: "reference",
            comparatorLabel: "reference",
            comparatorData: reference,
            comparatorKind: "reference",
            comparatorDepth: 5,
        });

        expect(result.event?.confidenceLevel).toBe("high");
        expect(result.comparatorDepth).toBe(5);
    });

    it("refuses short overlaps", () => {
        const reference = makeSeries(1980, 2020);
        const result = analyze(new Map(reference), reference);

        expect(result.status).toBe("insufficient-overlap");
        expect(result.event).toBeNull();
    });
});
