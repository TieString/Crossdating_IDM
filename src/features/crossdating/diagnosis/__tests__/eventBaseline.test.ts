/** Small value-independent RDM regression baseline for the deployed event projection. */
import { describe, expect, it } from "vitest";
import type { DiagnosisEvent, DiagnosisEventType } from "../types";
import {
    buildSyntheticSite,
    createEndAnchoredFalseRingCase,
    createEndAnchoredMissingRingCase,
    createPartialRangeMoveCase,
    createWholeSeriesMoveCase,
    getEligibleSeriesForSyntheticTests,
    groupEligibleSeries,
    loadRdmFixture,
    pickStratifiedCalendarYear,
    sampleAcross,
    type RwlSeries,
} from "./rdmFixture";
import { matchDiagnosisEvents, type TruthEvent } from "./eventMetrics";
import { diagnoseTargetEvents } from "./targetDiagnosis";

const fixture = loadRdmFixture();
const d = fixture.available ? describe : describe.skip;
const eligible = fixture.available ? getEligibleSeriesForSyntheticTests(fixture.series) : [];
const groups = groupEligibleSeries(eligible);
const longSeries = groups.eligibleLongSeries.length >= 5 ? groups.eligibleLongSeries : eligible;

const markerYearFor = (
    series: RwlSeries,
    caseIndex: number,
    seed: string,
    minimumContextYears = 18,
): number | null => pickStratifiedCalendarYear(
    series,
    caseIndex,
    seed,
    minimumContextYears,
)?.year ?? null;

type Aggregate = {
    truth: number;
    predictions: number;
    matched: number;
    complete: number;
    cases: number;
    widths: number[];
    ranks: number[];
};

const emptyAggregate = (): Aggregate => ({
    truth: 0,
    predictions: 0,
    matched: 0,
    complete: 0,
    cases: 0,
    widths: [],
    ranks: [],
});

const addCase = (aggregate: Aggregate, truth: TruthEvent[], predictions: DiagnosisEvent[]) => {
    const result = matchDiagnosisEvents(truth, predictions);
    aggregate.truth += result.truthCount;
    aggregate.predictions += result.predictionCount;
    aggregate.matched += result.matchedCount;
    aggregate.complete += result.completeCaseSuccess ? 1 : 0;
    aggregate.cases += 1;
    aggregate.widths.push(...result.widths);
    aggregate.ranks.push(...result.ranks);
};

const summarize = (aggregate: Aggregate) => ({
    cases: aggregate.cases,
    truth: aggregate.truth,
    predictions: aggregate.predictions,
    recall: aggregate.matched / Math.max(1, aggregate.truth),
    precision: aggregate.matched / Math.max(1, aggregate.predictions),
    completeCaseRate: aggregate.complete / Math.max(1, aggregate.cases),
    meanWidth: aggregate.widths.reduce((sum, width) => sum + width, 0) / Math.max(1, aggregate.widths.length),
    meanRank: aggregate.ranks.reduce((sum, rank) => sum + rank, 0) / Math.max(1, aggregate.ranks.length),
});

const ownEvents = (site: Parameters<typeof diagnoseTargetEvents>[0], seriesId: string) => (
    diagnoseTargetEvents(site, seriesId)
);

d("deployed JS DiagnosisEvent value-independent RDM baseline", () => {
    it("reports single-event and clean metrics without conditional denominators", () => {
        const metrics: Record<DiagnosisEventType, Aggregate> = {
            missingRing: emptyAggregate(),
            falseRing: emptyAggregate(),
            partialMove: emptyAggregate(),
            wholeSeriesMove: emptyAggregate(),
        };
        let cleanCases = 0;
        let cleanFalsePositive = 0;
        const cleanExamples: unknown[] = [];
        const partialExamples: unknown[] = [];
        const targets = sampleAcross(longSeries, 5).slice(0, 12);

        targets.forEach((series, index) => {
            const markerYear = markerYearFor(
                series,
                index,
                `rdm-baseline:${series.id}:unit`,
            );
            if (markerYear === null) return;

            const missing = createEndAnchoredMissingRingCase(series, markerYear);
            const missingSite = buildSyntheticSite(fixture.series, series.id, missing.corrupted).site;
            if (missingSite) {
                addCase(metrics.missingRing, [{
                    id: `${series.id}-missing`, seriesId: series.id, eventType: "missingRing", year: markerYear,
                }], ownEvents(missingSite, series.id));
            }

            const falseRing = createEndAnchoredFalseRingCase(
                series,
                markerYear,
                (["average", "moderate", "splitLike"] as const)[index % 3],
            );
            const falseSite = buildSyntheticSite(fixture.series, series.id, falseRing.corrupted).site;
            if (falseSite) {
                addCase(metrics.falseRing, [{
                    id: `${series.id}-false`, seriesId: series.id, eventType: "falseRing", year: markerYear,
                }], ownEvents(falseSite, series.id));
            }

            const boundary = markerYearFor(
                series,
                index + 2,
                `rdm-baseline:${series.id}:partial`,
                50,
            );
            if (boundary !== null) {
                const gapYears = ([2, 3, 4, 5, 6, 8] as const)[index % 6];
                const partial = createPartialRangeMoveCase(series, boundary, gapYears);
                const partialSite = buildSyntheticSite(fixture.series, series.id, partial.corrupted).site;
                if (partialSite) {
                    const predictions = ownEvents(partialSite, series.id);
                    if (partialExamples.length < 4) {
                        partialExamples.push({
                            seriesId: series.id,
                            truth: { firstFixedYear: boundary, shiftYears: -gapYears },
                            predictions: predictions.map((event) => ({
                                type: event.eventType,
                                range: [event.startYear, event.endYear],
                                shiftYears: event.shiftYears,
                                shiftSide: event.shiftSide,
                            })),
                        });
                    }
                    addCase(metrics.partialMove, [{
                        id: `${series.id}-partial`,
                        seriesId: series.id,
                        eventType: "partialMove",
                        year: boundary,
                        shiftYears: -gapYears,
                        shiftSide: "older",
                    }], predictions);
                }
            }

            if (index < 8) {
                const injectedShift = index % 2 === 0 ? 1 : -1;
                const whole = createWholeSeriesMoveCase(series, injectedShift);
                const wholeSite = buildSyntheticSite(fixture.series, series.id, whole.corrupted).site;
                if (wholeSite) {
                    addCase(metrics.wholeSeriesMove, [{
                        id: `${series.id}-whole`,
                        seriesId: series.id,
                        eventType: "wholeSeriesMove",
                        year: series.endYear + injectedShift,
                    }], ownEvents(wholeSite, series.id));
                }
            }

            const cleanSite = buildSyntheticSite(fixture.series, series.id, series.valuesByYear).site;
            if (cleanSite) {
                cleanCases += 1;
                const predictions = ownEvents(cleanSite, series.id);
                if (predictions.length > 0) {
                    cleanFalsePositive += 1;
                    cleanExamples.push({
                        seriesId: series.id,
                        predictions: predictions.map((event) => ({
                            type: event.eventType,
                            range: [event.startYear, event.endYear],
                            score: event.evidence.score,
                            source: event.evidence.algorithmSources,
                            notes: event.evidence.notes,
                        })),
                    });
                }
            }
        });

        const report = {
            sampling: {
                method: "value-independent deterministic five-stratum calendar sampling",
                signalConditionedSelection: false,
            },
            missingRing: summarize(metrics.missingRing),
            falseRing: summarize(metrics.falseRing),
            partialMove: summarize(metrics.partialMove),
            wholeSeriesMove: summarize(metrics.wholeSeriesMove),
            clean: { cases: cleanCases, falsePositiveRate: cleanFalsePositive / Math.max(1, cleanCases) },
        };
        // eslint-disable-next-line no-console
        console.log(`EVENT_BASELINE ${JSON.stringify(report)}`);
        // eslint-disable-next-line no-console
        console.log(`EVENT_PARTIAL_EXAMPLES ${JSON.stringify(partialExamples)}`);
        // eslint-disable-next-line no-console
        console.log(`EVENT_CLEAN_EXAMPLES ${JSON.stringify(cleanExamples)}`);
        expect(metrics.missingRing.truth).toBeGreaterThanOrEqual(5);
        expect(metrics.falseRing.truth).toBeGreaterThanOrEqual(5);
        expect(metrics.partialMove.truth).toBeGreaterThanOrEqual(5);
        expect(metrics.wholeSeriesMove.truth).toBeGreaterThanOrEqual(5);
    });
});
