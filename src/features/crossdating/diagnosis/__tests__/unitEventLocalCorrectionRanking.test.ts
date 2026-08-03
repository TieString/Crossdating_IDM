import { describe, expect, it } from "vitest";
import { getConfig } from "../config";
import { diagnoseSeriesCore } from "../segments";
import { scoreUnitEventLocalCorrectionRanks } from "../unitEventLocalCorrectionRanking";
import {
    buildFixedWindowCounterfactualContext,
    scoreFixedWindowCounterfactual,
} from "./fixedWindowCounterfactual.experiment";
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

const percentileRanks = (values: readonly number[]): number[] => values.map(
    (selected) => (
        values.filter((value) => value < selected).length
        + values.filter((value) => value === selected).length * 0.5
    ) / Math.max(1, values.length),
);

suite("unit-event local correction ranking", () => {
    it.each([
        [
            "missingRing",
            createEndAnchoredMissingRingCase,
            "whitenedMasterHuberBoundary13",
        ] as const,
        [
            "falseRing",
            createEndAnchoredFalseRingCase,
            "whitenedOlderHuberBoundary5",
        ] as const,
    ])("matches the fixed-window experiment for %s", (
        eventType,
        corrupt,
        profileName,
    ) => {
        expect(series).not.toBeNull();
        const selected = series!;
        const truthYear = pickStratifiedCalendarYear(
            selected,
            2,
            `local-correction-${eventType}`,
            30,
        )?.year;
        expect(truthYear).toBeDefined();
        const synthetic = corrupt(selected, truthYear!);
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
        const years = Array.from(
            { length: 9 },
            (_, index) => truthYear! - 4 + index,
        );
        const production = scoreUnitEventLocalCorrectionRanks(
            diagnosis!,
            eventType,
            years,
        );
        const experiment = scoreFixedWindowCounterfactual(
            buildFixedWindowCounterfactualContext(diagnosis!, built.site!),
            eventType,
            eventType === "missingRing" ? -1 : 1,
            { startYear: years[0], endYear: years[years.length - 1] },
            { includeBoundaryLocal: true },
        );
        const expectedRanks = percentileRanks(experiment.map(
            (row) => row.features[profileName],
        ));

        experiment.forEach((row) => {
            [
                "rawPredictiveEnsembleHuberEdge3",
                "rawPredictiveEnsembleHuberEdge3Gain",
                "differencePredictiveMedianHuberSideMinimum5",
                "whitenedPredictiveWeightedHuberSideMean7",
            ].forEach((name) => {
                expect(
                    Number.isFinite(row.features[name]),
                    `${name} at ${row.year}`,
                ).toBe(true);
            });
        });

        expect(production?.profileName).toBe(profileName);
        years.forEach((year, index) => {
            expect(production?.rankByYear.get(year)).toBeCloseTo(
                expectedRanks[index],
                10,
            );
        });
    });
});
