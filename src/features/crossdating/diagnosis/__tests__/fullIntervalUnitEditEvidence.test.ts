import { describe, expect, it } from "vitest";
import { getConfig } from "../config";
import {
    scoreFullIntervalShiftDifferenceEvidence,
    scoreFullIntervalShiftEvidence,
    scoreFullIntervalUnitEditEvidence,
} from "../fullIntervalUnitEditEvidence";
import { getJointCounterfactualOperationScores } from "../jointCounterfactualOperation";
import {
    buildJointOperationSelectorFeatures,
    selectJointCounterfactualOperation,
} from "../jointOperationSelector";
import { diagnoseSeriesCore } from "../segments";
import {
    scanExhaustivePartialMove,
    scanExhaustiveUnitEdit,
} from "./exhaustiveEditScan.experiment";
import {
    buildSyntheticSite,
    createEndAnchoredFalseRingCase,
    createEndAnchoredMissingRingCase,
    getEligibleSeriesForSyntheticTests,
    groupEligibleSeries,
    loadRdmFixture,
    pickStratifiedCalendarYear,
} from "./rdmFixture";

const fixture = loadRdmFixture();
const suite = fixture.available ? describe : describe.skip;
const eligible = fixture.available
    ? getEligibleSeriesForSyntheticTests(fixture.series)
    : [];
const groups = groupEligibleSeries(eligible);
const series = (groups.eligibleLongSeries.length >= 5
    ? groups.eligibleLongSeries
    : eligible)[0] ?? null;

suite("full-interval unit-edit prefix evidence", () => {
    it.each([
        ["insert", createEndAnchoredMissingRingCase] as const,
        ["delete", createEndAnchoredFalseRingCase] as const,
    ])("matches exhaustive virtual %s scoring", (editType, corrupt) => {
        expect(series).not.toBeNull();
        const selected = series!;
        const year = pickStratifiedCalendarYear(
            selected,
            2,
            `prefix-${editType}`,
            30,
        )?.year;
        expect(year).toBeDefined();
        const synthetic = corrupt(selected, year!);
        const built = buildSyntheticSite(
            fixture.series,
            selected.id,
            synthetic.corrupted,
        );
        expect(built.site).not.toBeNull();
        const diagnosis = diagnoseSeriesCore(
            built.site!,
            selected.id,
            getConfig({ referenceConfig: null }),
        );
        expect(diagnosis).not.toBeNull();
        const exhaustive = scanExhaustiveUnitEdit(diagnosis!, editType);
        const prefix = scoreFullIntervalUnitEditEvidence(diagnosis!, editType);
        expect(prefix).toHaveLength(exhaustive.length);
        prefix.forEach((row, index) => {
            expect(row.year).toBe(exhaustive[index].year);
            expect(row.rawCorrelation).toBeCloseTo(exhaustive[index].raw, 8);
            expect(row.differenceCorrelation).toBeCloseTo(
                exhaustive[index].difference,
                8,
            );
        });
    });

    it.each([-2, -3, -4, -8])(
        "matches exhaustive virtual partial shift %i scoring",
        (shiftYears) => {
            expect(series).not.toBeNull();
            const selected = series!;
            const year = pickStratifiedCalendarYear(
                selected,
                2,
                `prefix-partial-${shiftYears}`,
                30,
            )?.year;
            expect(year).toBeDefined();
            const built = buildSyntheticSite(
                fixture.series,
                selected.id,
                selected.valuesByYear,
            );
            expect(built.site).not.toBeNull();
            const diagnosis = diagnoseSeriesCore(
                built.site!,
                selected.id,
                getConfig({ referenceConfig: null }),
            );
            expect(diagnosis).not.toBeNull();
            const exhaustive = scanExhaustivePartialMove(
                diagnosis!,
                [shiftYears],
            );
            const prefix = scoreFullIntervalShiftEvidence(
                diagnosis!,
                shiftYears,
                20,
            );
            const differenceOnly = scoreFullIntervalShiftDifferenceEvidence(
                diagnosis!,
                shiftYears,
                20,
            );
            expect(prefix).toHaveLength(exhaustive.length);
            expect(differenceOnly).toEqual(prefix.map((row) => ({
                year: row.year,
                differenceCorrelation: row.differenceCorrelation,
                differencePairs: row.differencePairs,
            })));
            prefix.forEach((row, index) => {
                // Prefix evidence stays on the internal lastMovedYear axis.
                expect(row.year + 1).toBe(exhaustive[index].year);
                expect(row.rawCorrelation).toBeCloseTo(exhaustive[index].raw, 8);
                expect(row.differenceCorrelation).toBeCloseTo(
                    exhaustive[index].difference,
                    8,
                );
            });
        },
    );

    it("caches one complete dynamic negative year-by-operation grid", () => {
        expect(series).not.toBeNull();
        const selected = series!;
        const built = buildSyntheticSite(
            fixture.series,
            selected.id,
            selected.valuesByYear,
        );
        expect(built.site).not.toBeNull();
        const diagnosis = diagnoseSeriesCore(
            built.site!,
            selected.id,
            getConfig({ referenceConfig: null }),
        );
        expect(diagnosis).not.toBeNull();

        const first = getJointCounterfactualOperationScores(diagnosis!, 15);
        const second = getJointCounterfactualOperationScores(diagnosis!, 15);

        expect(second).toBe(first);
        expect(first).toHaveLength(101);
        expect(first.slice(0, 4).map((operation) => operation.shiftYears))
            .toEqual([-1, 1, -2, -3]);
        expect(first[first.length - 1]?.shiftYears).toBe(-100);
        expect(first.every((operation) => operation.rows.length > 0)).toBe(true);
        expect(first.every((operation) => (
            new Set(operation.rows.map((row) => row.year)).size
                === operation.rows.length
        ))).toBe(true);
    });

    it("bypasses the fixed six-way model for the dynamic negative grid", () => {
        expect(series).not.toBeNull();
        const selected = series!;
        const year = pickStratifiedCalendarYear(
            selected,
            2,
            "joint-selector",
            30,
        )?.year;
        expect(year).toBeDefined();
        const synthetic = createEndAnchoredMissingRingCase(selected, year!);
        const built = buildSyntheticSite(
            fixture.series,
            selected.id,
            synthetic.corrupted,
        );
        const diagnosis = diagnoseSeriesCore(
            built.site!,
            selected.id,
            getConfig({ referenceConfig: null }),
        );
        expect(diagnosis).not.toBeNull();
        const operations = getJointCounterfactualOperationScores(diagnosis!, 15);
        const features = buildJointOperationSelectorFeatures(operations);
        const selection = selectJointCounterfactualOperation(operations);

        expect(features).toBeNull();
        expect(selection).not.toBeNull();
        expect(operations).toContain(selection!.operation);
        expect(selection!.probabilities.size).toBe(101);
        expect(operations.some((operation) => operation.shiftYears === -4)).toBe(true);
        expect(operations.every((operation) => (
            operation.shiftYears === -1
            || operation.shiftYears === 1
            || operation.shiftYears <= -2
        ))).toBe(true);
        expect([...selection!.probabilities.values()].reduce(
            (sum, probability) => sum + probability,
            0,
        )).toBeCloseTo(1, 8);
    });
});
