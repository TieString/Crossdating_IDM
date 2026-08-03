import { describe, expect, it } from "vitest";
import {
    FALSE_RING_COUNTERFACTUAL_PROFILES,
    FALSE_RING_REFERENCE_COUNTERFACTUAL_PROFILES,
    scoreFalseRingCoarseCounterfactual,
} from "../falseRingCoarseCounterfactual";
import { getConfig } from "../config";
import { diagnoseSeriesCore } from "../segments";
import {
    buildFixedWindowCounterfactualContext,
    scoreFixedWindowCounterfactual,
} from "./fixedWindowCounterfactual.experiment";
import {
    buildSyntheticSite,
    createEndAnchoredFalseRingCase,
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

suite("false-ring coarse counterfactual", () => {
    it("matches the frozen experiment profiles at every coarse-window year", () => {
        expect(series).not.toBeNull();
        const selected = series!;
        const truthYear = pickStratifiedCalendarYear(
            selected,
            2,
            "false-coarse-counterfactual",
            45,
        )?.year;
        expect(truthYear).toBeDefined();
        const synthetic = createEndAnchoredFalseRingCase(selected, truthYear!);
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
        const coarseWindow = {
            startYear: truthYear! - 12,
            endYear: truthYear! + 12,
        };
        const production = scoreFalseRingCoarseCounterfactual(
            diagnosis!,
            built.site!,
            coarseWindow,
        );
        const experiment = scoreFixedWindowCounterfactual(
            buildFixedWindowCounterfactualContext(diagnosis!, built.site!),
            "falseRing",
            1,
            coarseWindow,
        );

        expect(production.map((row) => row.year)).toEqual(
            experiment.map((row) => row.year),
        );
        production.forEach((row, index) => {
            FALSE_RING_COUNTERFACTUAL_PROFILES.forEach((profile) => {
                expect(row.profiles[profile]).toBeCloseTo(
                    experiment[index]?.features[profile] ?? Number.NaN,
                    10,
                );
            });
            FALSE_RING_REFERENCE_COUNTERFACTUAL_PROFILES.forEach((profile) => {
                const value = row.profiles[profile];
                expect(value).toBeDefined();
                expect(Number.isFinite(value)).toBe(true);
                expect(value!).toBeGreaterThanOrEqual(0);
                expect(value!).toBeLessThanOrEqual(1);
            });
        });
        FALSE_RING_REFERENCE_COUNTERFACTUAL_PROFILES.forEach((profile) => {
            const values = production.map((row) => row.profiles[profile] ?? 0);
            expect(Math.max(...values)).toBeGreaterThan(Math.min(...values));
        });
    });
});
