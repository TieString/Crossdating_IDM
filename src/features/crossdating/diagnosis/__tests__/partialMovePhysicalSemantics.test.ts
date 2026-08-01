import { describe, expect, it } from "vitest";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import {
    getAutomaticPartialShiftCandidates,
    getEffectiveMaxPartialGapYears,
} from "../partialMoveSemantics";
import { getJointCounterfactualOperationScores } from "../jointCounterfactualOperation";
import {
    buildJointOperationSelectorFeatures,
    selectJointCounterfactualOperation,
} from "../jointOperationSelector";
import { scoreBoundaryLocalCounterfactual } from "../boundaryLocalCounterfactual";
import { diagnoseTargetBundle, diagnoseTargetEvents } from "./targetDiagnosis";

const TARGET_ID = "TARGET";

const hashSignalAt = (year: number): number => {
    let value = Math.imul(year ^ 0x45d9f3b, 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value ^= value >>> 16;
    return (value >>> 0) / 0xffffffff * 2 - 1;
};

const signalAt = (year: number): number => (
    hashSignalAt(year) * 1.2
    + 0.28 * Math.sin(year * 0.173 + 1.2)
    + 0.18 * Math.cos(year * 0.071 - 0.4)
);

const widthAt = (year: number, referenceIndex = -1): number => (
    1000
    + signalAt(year) * 220
    + (referenceIndex >= 0
        ? Math.sin(year * (0.037 + referenceIndex * 0.006)) * 8
        : 0)
);

const buildPhysicalGapSite = (
    firstFixedYear: number,
    gapYears: number,
    wholeSeriesLag = 0,
): RwlSiteData => {
    const site: RwlSiteData = new Map();
    for (let referenceIndex = 0; referenceIndex < 5; referenceIndex += 1) {
        const reference: RwlTreeData = new Map();
        for (let year = 1680; year <= 2034; year += 1) {
            reference.set(year, widthAt(year, referenceIndex));
        }
        site.set(`REF-${referenceIndex + 1}`, reference);
    }

    const target: RwlTreeData = new Map();
    for (let year = 1800; year <= 2024; year += 1) {
        target.set(
            year,
            widthAt(
                year
                + wholeSeriesLag
                - (year < firstFixedYear ? gapYears : 0),
            ),
        );
    }
    site.set(TARGET_ID, target);
    return site;
};

describe("physical partial-move diagnosis semantics", () => {
    it("generates -2 through -100 and clips only for physical context", () => {
        const shifts = getAutomaticPartialShiftCandidates({
            maxPartialGapYears: 100,
            lagMin: -100,
            seriesLength: 225,
            minimumSideYears: 20,
        });

        expect(shifts).toHaveLength(99);
        expect(shifts[0]).toBe(-2);
        expect(shifts[shifts.length - 1]).toBe(-100);
        expect(shifts.every((shiftYears) => shiftYears < 0)).toBe(true);
        expect(getEffectiveMaxPartialGapYears({
            maxPartialGapYears: 100,
            lagMin: -100,
            seriesLength: 70,
            minimumSideYears: 20,
        })).toBe(30);
    });

    it("automatically returns -4 at firstFixedYear 1904", () => {
        const bundle = diagnoseTargetBundle(
            buildPhysicalGapSite(1904, 4),
            TARGET_ID,
        );
        expect(bundle).not.toBeNull();
        const events = bundle!.events;
        const partial = events.find((event) => event.eventType === "partialMove");
        const operationGrid = getJointCounterfactualOperationScores(bundle!.diagnosis);
        const partialOperations = operationGrid.filter(
            (operation) => operation.eventType === "partialMove",
        );

        expect(partial).toBeDefined();
        expect(partial!.shiftYears).toBe(-4);
        expect(partial!.shiftYears).not.toBe(-3);
        expect(partial!.shiftSide).toBe("older");
        expect(partial!.startYear).toBeLessThanOrEqual(1904);
        expect(partial!.endYear).toBeGreaterThanOrEqual(1904);
        expect(partial!.rankedYears[0]?.year).toBe(1904);
        expect(partialOperations.map((operation) => operation.shiftYears)).toEqual(
            getAutomaticPartialShiftCandidates({
                maxPartialGapYears: 100,
                lagMin: -100,
                seriesLength: 225,
                minimumSideYears: 15,
            }),
        );
        expect(partialOperations.every((operation) => (
            operation.rows.some((row) => row.year === 1904)
        ))).toBe(true);
        expect(buildJointOperationSelectorFeatures(operationGrid)).toBeNull();
        expect(selectJointCounterfactualOperation(operationGrid)?.correctionYears)
            .toBe(-4);
        const localBoundary = scoreBoundaryLocalCounterfactual(
            bundle!.diagnosis,
            -4,
        ).slice().sort((left, right) => (
            right.stepMinimum5 - left.stepMinimum5
        ))[0];
        expect(Math.abs((localBoundary?.year ?? 0) - 1904))
            .toBeLessThanOrEqual(2);
        expect(
            Math.abs((
                partialOperations.find(
                (operation) => operation.shiftYears === -4,
                )?.sideStepBestYear ?? 0
            ) - 1904),
        ).toBeLessThanOrEqual(1);
    });

    it.each([
        [1864, 2],
        [1887, 3],
        [1941, 5],
        [1980, 8],
        [1895, 10],
        [1920, 30],
        [1950, 50],
        [1950, 100],
    ] as const)(
        "returns the exact physical gap at firstFixedYear %i with gap %i",
        (firstFixedYear, gapYears) => {
            const events = diagnoseTargetEvents(
                buildPhysicalGapSite(firstFixedYear, gapYears),
                TARGET_ID,
            );
            const partial = events.find(
                (event) => event.eventType === "partialMove",
            );

            expect(events.filter((event) => event.eventType === "partialMove"))
                .toHaveLength(1);
            expect(
                partial?.shiftYears,
                JSON.stringify(events.map((event) => ({
                    type: event.eventType,
                    shiftYears: event.shiftYears,
                    range: [event.startYear, event.endYear],
                    topYear: event.rankedYears[0]?.year,
                    sources: event.evidence.algorithmSources,
                    notes: event.evidence.notes,
                }))),
            ).toBe(-gapYears);
            expect(partial?.startYear).toBeLessThanOrEqual(firstFixedYear);
            expect(partial?.endYear).toBeGreaterThanOrEqual(firstFixedYear);
            expect(partial?.rankedYears[0]?.year).toBe(firstFixedYear);
            expect(events.every((event) => (
                event.eventType !== "partialMove"
                || (event.shiftYears ?? 0) < 0
            ))).toBe(true);
        },
    );

    it("keeps a whole-series baseline separate from a local -4 event", () => {
        const bundle = diagnoseTargetBundle(
            buildPhysicalGapSite(1904, 4, 2),
            TARGET_ID,
        );
        expect(bundle).not.toBeNull();
        const events = bundle!.events;
        const partial = events.find((event) => event.eventType === "partialMove");
        const whole = events.find((event) => event.eventType === "wholeSeriesMove");
        const joint = getJointCounterfactualOperationScores(bundle!.diagnosis)
            .find((operation) => operation.shiftYears === -4);

        expect(whole).toBeDefined();
        expect(
            joint?.bestYear,
            JSON.stringify(events.map((event) => ({
                type: event.eventType,
                shift: event.shiftYears,
                range: [event.startYear, event.endYear],
                top: event.rankedYears[0]?.year,
                lag: [event.evidence.lagBefore, event.evidence.lagAfter],
                sources: event.evidence.algorithmSources,
            }))),
        ).toBe(1904);
        expect(Math.abs((joint?.sideStepBestYear ?? 0) - 1904))
            .toBeLessThanOrEqual(1);
        expect(partial?.shiftYears).toBe(-4);
        expect(partial?.startYear).toBeLessThanOrEqual(1904);
        expect(partial?.endYear).toBeGreaterThanOrEqual(1904);
        expect(partial?.rankedYears[0]?.year).toBe(1904);
    });

    it("does not invent a local gap for a pure whole-series move", () => {
        const events = diagnoseTargetEvents(
            buildPhysicalGapSite(1904, 0, 2),
            TARGET_ID,
        );

        expect(events.some((event) => event.eventType === "wholeSeriesMove"))
            .toBe(true);
        expect(events.some((event) => event.eventType === "partialMove"))
            .toBe(false);
    });
});
