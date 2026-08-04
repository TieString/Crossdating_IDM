import { describe, expect, it } from "vitest";
import type { RwlSiteData } from "@/features/rwl/types";
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
        const experimentProfiles = [
            ...FALSE_RING_COUNTERFACTUAL_PROFILES,
            "rawMasterR31",
            "differenceMasterR21",
            "differenceMasterR31",
            "whitenedMasterR31",
            "differenceReferenceWeightedR21",
            "differenceReferenceWeightedR31",
        ] as const;
        production.forEach((row, index) => {
            experimentProfiles.forEach((profile) => {
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

    it("makes merge-older evidence peak at the physical split year", () => {
        expect(series).not.toBeNull();
        const selected = series!;
        const truthYear = pickStratifiedCalendarYear(
            selected,
            3,
            "false-coarse-merge-older",
            45,
        )?.year;
        expect(truthYear).toBeDefined();
        const synthetic = createEndAnchoredFalseRingCase(
            selected,
            truthYear!,
            "splitLike",
        );
        const site: RwlSiteData = new Map();
        for (let index = 0; index < 5; index += 1) {
            site.set(`exact-reference-${index}`, new Map(selected.valuesByYear));
        }
        site.set(selected.id, new Map(synthetic.corrupted));
        const diagnosis = diagnoseSeriesCore(
            site,
            selected.id,
            getConfig({ referenceConfig: null }),
        );
        expect(diagnosis).not.toBeNull();
        const rows = scoreFalseRingCoarseCounterfactual(
            diagnosis!,
            site,
            { startYear: truthYear! - 12, endYear: truthYear! + 12 },
        );
        const best = [...rows].sort((left, right) => (
            (right.profiles.falseMergeOlderRawMasterR31 ?? -1)
                - (left.profiles.falseMergeOlderRawMasterR31 ?? -1)
            || left.year - right.year
        ))[0];

        expect(best?.year).toBe(truthYear);
        expect(
            rows.find((row) => row.year === truthYear)?.profiles
                .falseMergeOlderRawMasterR31Advantage,
        ).toBeGreaterThan(0);
    });

});
