import { describe, expect, it } from "vitest";
import { getConfig } from "../config";
import {
    MISSING_RING_COUNTERFACTUAL_PROFILES,
    MISSING_RING_LOCAL_RECENTER_PROFILES,
    scoreMissingRingCoarseCounterfactual,
} from "../missingRingCoarseCounterfactual";
import { diagnoseSeriesCore } from "../segments";
import {
    buildFixedWindowCounterfactualContext,
    scoreFixedWindowCounterfactual,
} from "./fixedWindowCounterfactual.experiment";
import {
    buildSyntheticSite,
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

suite("missing-ring coarse counterfactual", () => {
    it("matches the frozen experiment profiles at every coarse-window year", () => {
        expect(series).not.toBeNull();
        const selected = series!;
        const truthYear = pickStratifiedCalendarYear(
            selected,
            2,
            "missing-coarse-counterfactual",
            45,
        )?.year;
        expect(truthYear).toBeDefined();
        const synthetic = createEndAnchoredMissingRingCase(selected, truthYear!);
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
        const coarseWindow = {
            startYear: truthYear! - 12,
            endYear: truthYear! + 12,
        };
        const production = scoreMissingRingCoarseCounterfactual(
            diagnosis!,
            built.site!,
            coarseWindow,
        );
        const experiment = scoreFixedWindowCounterfactual(
            buildFixedWindowCounterfactualContext(diagnosis!, built.site!),
            "missingRing",
            -1,
            coarseWindow,
            { includeBoundaryLocal: true },
        );

        expect(production.map((row) => row.year)).toEqual(
            experiment.map((row) => row.year),
        );
        production.forEach((row, index) => {
            MISSING_RING_COUNTERFACTUAL_PROFILES.forEach((profile) => {
                expect(row.profiles[profile]).toBeCloseTo(
                    experiment[index]?.features[profile] ?? Number.NaN,
                    10,
                );
            });
            MISSING_RING_LOCAL_RECENTER_PROFILES.forEach((profile) => {
                expect(row.profiles[profile]).toBeCloseTo(
                    experiment[index]?.features[profile] ?? Number.NaN,
                    10,
                );
            });
        });
    });

    it("reuses the cached score table for the same diagnosis and window", () => {
        expect(series).not.toBeNull();
        const selected = series!;
        const truthYear = pickStratifiedCalendarYear(
            selected,
            2,
            "missing-coarse-cache",
            45,
        )?.year;
        expect(truthYear).toBeDefined();
        const synthetic = createEndAnchoredMissingRingCase(selected, truthYear!);
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
        const coarseWindow = {
            startYear: truthYear! - 12,
            endYear: truthYear! + 12,
        };
        const first = scoreMissingRingCoarseCounterfactual(
            diagnosis!,
            built.site!,
            coarseWindow,
        );
        const second = scoreMissingRingCoarseCounterfactual(
            diagnosis!,
            built.site!,
            coarseWindow,
        );
        expect(second).toBe(first);
    });
});
