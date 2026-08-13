/** Joint breakpoint ranking for two or three interacting local chronology events. */
import type { RwlSiteData } from "@/features/rwl/types";
import {
    ar1WhitenSeries,
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import type {
    DiagnosisEvent,
    DiagnosisRankedYear,
    NumericSeries,
    SeriesCoreDiagnosis,
} from "./types";

type LocalEvent = DiagnosisEvent & {
    eventType: "missingRing" | "falseRing" | "partialMove";
};

type CandidateAssignment = {
    years: number[];
    score: number;
};

type PreparedReference = {
    raw: NumericSeries;
    difference: NumericSeries;
    whitened: NumericSeries;
    pairedCore: boolean;
};

export type JointEventRefinementConfig = {
    localRawWeight: number;
    localDifferenceWeight: number;
    localWhitenedWeight: number;
    localScoreWeight: number;
    pairedReferenceWeight: number;
    independentReferenceWeight: number;
    maximumReferences: number;
    independentReferenceCount: number;
    candidateRadiusYears: number;
    refinePartialLocations: boolean;
};

export type DiagnosisEventSetScore = {
    score: number;
    localEventCount: number;
    consistentLagChain: boolean;
    selectedYears: number[];
};

const DEFAULT_CONFIG: JointEventRefinementConfig = {
    localRawWeight: 1,
    localDifferenceWeight: 0,
    localWhitenedWeight: 0,
    localScoreWeight: 0.65,
    pairedReferenceWeight: 0.4,
    independentReferenceWeight: 0.2,
    maximumReferences: 10,
    independentReferenceCount: 7,
    candidateRadiusYears: 1,
    refinePartialLocations: false,
};

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return preprocessSeries(result);
};

const fullCorrelation = (
    target: NumericSeries,
    master: NumericSeries,
    diagnosis: SeriesCoreDiagnosis,
): number => correlationForSegment(
    target,
    master,
    diagnosis.targetRange.startYear,
    diagnosis.targetRange.endYear,
    0,
    30,
).correlation ?? -1;

const combinedCorrelation = (
    raw: NumericSeries,
    difference: NumericSeries,
    whitened: NumericSeries,
    reference: PreparedReference,
    diagnosis: SeriesCoreDiagnosis,
): number => (
    fullCorrelation(raw, reference.raw, diagnosis) * 0.25
    + fullCorrelation(difference, reference.difference, diagnosis) * 0.55
    + fullCorrelation(whitened, reference.whitened, diagnosis) * 0.2
);

const localCorrelation = (
    target: NumericSeries,
    master: NumericSeries,
    centerYear: number,
): number => correlationForSegment(
    target,
    master,
    centerYear - 15,
    centerYear + 15,
    0,
    15,
).correlation ?? -1;

const combinedLocalCorrelation = (
    raw: NumericSeries,
    difference: NumericSeries,
    whitened: NumericSeries,
    reference: PreparedReference,
    centerYear: number,
    config: JointEventRefinementConfig,
): number => (
    localCorrelation(raw, reference.raw, centerYear) * config.localRawWeight
    + localCorrelation(difference, reference.difference, centerYear)
        * config.localDifferenceWeight
    + localCorrelation(whitened, reference.whitened, centerYear)
        * config.localWhitenedWeight
);

const mean = (values: number[]): number => (
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : -1
);

const preparedReferences = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    maximumReferences: number,
): PreparedReference[] => {
    const target = preprocessSeries(diagnosis.rawTarget);
    const targetStem = diagnosis.targetTree.slice(0, -1).toLowerCase();
    return diagnosis.master.sourceTrees
        .map((tree) => {
            const raw = preprocessSeries(toNumericSeries(siteData.get(tree)));
            return {
                raw,
                difference: firstDifferences(raw),
                whitened: ar1WhitenSeries(raw),
                pairedCore: tree.slice(0, -1).toLowerCase() === targetStem,
                baseline: fullCorrelation(target, raw, diagnosis),
            };
        })
        .filter((reference) => reference.baseline > -0.25)
        .sort((a, b) => Number(b.pairedCore) - Number(a.pairedCore) || b.baseline - a.baseline)
        .slice(0, Math.max(1, Math.round(maximumReferences)))
        .map(({ baseline: _baseline, ...reference }) => reference);
};

const orderedLocalEvents = (events: DiagnosisEvent[]): LocalEvent[] => events
    .filter((event): event is LocalEvent => event.eventType !== "wholeSeriesMove")
    .sort((a, b) => b.endYear - a.endYear || b.startYear - a.startYear);

const hasConsistentLagChain = (events: LocalEvent[]): boolean => events.every((event, index) => {
    const olderEvent = events[index + 1];
    return event.evidence.lagBefore !== null
        && event.evidence.lagAfter !== null
        && (!olderEvent || event.evidence.lagBefore === olderEvent.evidence.lagAfter);
});

const candidateYears = (
    event: LocalEvent,
    diagnosis: SeriesCoreDiagnosis,
    radiusYears: number,
): number[] => {
    const radius = Math.max(0, Math.floor(radiusYears));
    const start = Math.max(
        diagnosis.targetRange.startYear + 1,
        event.startYear - radius,
    );
    const end = Math.min(
        diagnosis.targetRange.endYear - 1,
        event.endYear + radius,
    );
    return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
};

const assignmentsFor = (
    events: LocalEvent[],
    candidates: number[][],
): number[][] => {
    const assignments: number[][] = [];
    const visit = (index: number, years: number[]): void => {
        if (index === events.length) {
            assignments.push(years);
            return;
        }
        candidates[index].forEach((year) => {
            const newerYear = years[index - 1];
            if (index > 0 && year >= newerYear) return;
            visit(index + 1, [...years, year]);
        });
    };
    visit(0, []);
    return assignments;
};

const restoreCalendar = (
    source: NumericSeries,
    events: LocalEvent[],
    years: number[],
): NumericSeries => {
    const restored = new Map<number, number>();
    source.forEach((value, sourceYear) => {
        let lag = events[0].evidence.lagAfter ?? 0;
        let excluded = false;
        events.forEach((event, index) => {
            const boundaryYear = years[index];
            if (event.eventType === "falseRing" && sourceYear === boundaryYear) {
                excluded = true;
            }
            const belongsToOlderSide = event.eventType === "partialMove"
                ? sourceYear < boundaryYear
                : sourceYear <= boundaryYear;
            if (belongsToOlderSide) lag = event.evidence.lagBefore ?? lag;
        });
        if (!excluded) restored.set(sourceYear + lag, value);
    });
    return restored;
};

const scoreAssignments = (
    diagnosis: SeriesCoreDiagnosis,
    events: LocalEvent[],
    assignments: number[][],
    references: PreparedReference[],
    config: JointEventRefinementConfig,
): CandidateAssignment[] => {
    const requestedIndependentWeight = events.every((event) => (
        event.eventType === "missingRing" || event.eventType === "falseRing"
    ))
        ? config.independentReferenceWeight
        : 0;
    const master: PreparedReference = {
        raw: diagnosis.master.data,
        difference: firstDifferences(diagnosis.master.data),
        whitened: ar1WhitenSeries(diagnosis.master.data),
        pairedCore: false,
    };
    return assignments.map((years) => {
        const restored = preprocessSeries(restoreCalendar(diagnosis.rawTarget, events, years));
        const difference = firstDifferences(restored);
        const whitened = ar1WhitenSeries(restored);
        const masterScore = combinedCorrelation(
            restored,
            difference,
            whitened,
            master,
            diagnosis,
        );
        const referenceScores = references.map((reference) => ({
            score: combinedCorrelation(
                restored,
                difference,
                whitened,
                reference,
                diagnosis,
            ),
            pairedCore: reference.pairedCore,
        }));
        const pairedScores = referenceScores
            .filter((reference) => reference.pairedCore)
            .map((reference) => reference.score);
        const independentScores = referenceScores
            .filter((reference) => !reference.pairedCore)
            .map((reference) => reference.score)
            .sort((a, b) => b - a)
            .slice(0, Math.max(1, Math.round(config.independentReferenceCount)));
        const independentWeight = independentScores.length > 0
            ? Math.max(
                0,
                Math.min(1 - config.pairedReferenceWeight, requestedIndependentWeight),
            )
            : 0;
        const globalScore = pairedScores.length > 0
            ? masterScore * (1 - config.pairedReferenceWeight - independentWeight)
                + mean(pairedScores) * config.pairedReferenceWeight
                + mean(independentScores) * independentWeight
            : masterScore * 0.7 + mean(independentScores) * 0.3;
        const localScores = years.map((year) => {
            const masterLocal = combinedLocalCorrelation(
            restored,
            difference,
            whitened,
            master,
            year,
            config,
        );
            const localReferenceScores = references.map((reference) => ({
                score: combinedLocalCorrelation(
                    restored,
                    difference,
                    whitened,
                    reference,
                    year,
                    config,
                ),
                pairedCore: reference.pairedCore,
            }));
            const pairedLocal = localReferenceScores
                .filter((reference) => reference.pairedCore)
                .map((reference) => reference.score);
            const independentLocal = localReferenceScores
                .filter((reference) => !reference.pairedCore)
                .map((reference) => reference.score)
                .sort((a, b) => b - a)
                .slice(0, Math.max(1, Math.round(config.independentReferenceCount)));
            return pairedLocal.length > 0
                ? masterLocal * (1 - config.pairedReferenceWeight - independentWeight)
                    + mean(pairedLocal) * config.pairedReferenceWeight
                    + mean(independentLocal) * independentWeight
                : masterLocal * 0.7 + mean(independentLocal) * 0.3;
        });
        return {
            years,
            score: mean(localScores) * config.localScoreWeight
                + globalScore * (1 - config.localScoreWeight),
        };
    }).sort((a, b) => b.score - a.score);
};

export const scoreDiagnosisEventSets = (
    eventSets: DiagnosisEvent[][],
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    overrides: Partial<JointEventRefinementConfig> = {},
): DiagnosisEventSetScore[] => {
    const config = { ...DEFAULT_CONFIG, ...overrides };
    const references = preparedReferences(diagnosis, siteData, config.maximumReferences);
    return eventSets.map((events) => {
        const localEvents = orderedLocalEvents(events);
        const consistentLagChain = localEvents.length > 0
            && hasConsistentLagChain(localEvents);
        const selectedYears = localEvents.map((event) => (
            event.rankedYears[0]?.year
            ?? Math.round((event.startYear + event.endYear) / 2)
        ));
        if (!consistentLagChain) {
            return {
                score: Number.NEGATIVE_INFINITY,
                localEventCount: localEvents.length,
                consistentLagChain,
                selectedYears,
            };
        }
        const assignment = scoreAssignments(
            diagnosis,
            localEvents,
            [selectedYears],
            references,
            config,
        )[0];
        return {
            score: assignment?.score ?? Number.NEGATIVE_INFINITY,
            localEventCount: localEvents.length,
            consistentLagChain,
            selectedYears,
        };
    });
};

const boundedWindow = (
    event: DiagnosisEvent,
    selectedYear: number,
    diagnosis: SeriesCoreDiagnosis,
): { startYear: number; endYear: number } => {
    const width = event.endYear - event.startYear + 1;
    const previousTopYear = event.rankedYears[0]?.year
        ?? Math.floor((event.startYear + event.endYear) / 2);
    const requestedStart = event.startYear + selectedYear - previousTopYear;
    const startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(requestedStart, diagnosis.targetRange.endYear - width + 1),
    );
    return { startYear, endYear: startYear + width - 1 };
};

const rankedYears = (
    event: DiagnosisEvent,
    eventIndex: number,
    window: { startYear: number; endYear: number },
    assignments: CandidateAssignment[],
): DiagnosisRankedYear[] => {
    const priorByYear = new Map(event.rankedYears.map((row) => [row.year, row]));
    const bestByYear = new Map<number, number>();
    assignments.forEach((assignment) => {
        const year = assignment.years[eventIndex];
        bestByYear.set(year, Math.max(bestByYear.get(year) ?? -Infinity, assignment.score));
    });
    return Array.from({ length: window.endYear - window.startYear + 1 }, (_, index) => {
        const year = window.startYear + index;
        const prior = priorByYear.get(year);
        return {
            year,
            score: bestByYear.get(year) ?? -Infinity,
            evidenceTags: Array.from(new Set([
                "joint_event_counterfactual",
                ...(prior?.evidenceTags ?? []),
            ])).sort(),
        };
    })
        .sort((a, b) => b.score - a.score || b.year - a.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
};

/**
 * Scores all detected local events in one immutable calendar frame. The search extends each
 * accepted window by one year, but the returned review window keeps its original width.
 */
export const refineEventYearsJointly = (
    events: DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    overrides: Partial<JointEventRefinementConfig> = {},
): DiagnosisEvent[] => {
    const config = { ...DEFAULT_CONFIG, ...overrides };
    const localEvents = orderedLocalEvents(events);
    if (localEvents.length < 2 || localEvents.length > 3 || !hasConsistentLagChain(localEvents)) {
        return events;
    }
    const candidates = localEvents.map((event) => candidateYears(
        event,
        diagnosis,
        config.candidateRadiusYears,
    ));
    if (candidates.some((years) => years.length === 0)) return events;
    const assignments = scoreAssignments(
        diagnosis,
        localEvents,
        assignmentsFor(localEvents, candidates),
        preparedReferences(diagnosis, siteData, config.maximumReferences),
        config,
    );
    const best = assignments[0];
    if (!best) return events;

    const refinedById = new Map(localEvents.map((event, eventIndex) => {
        if (event.eventType === "partialMove" && !config.refinePartialLocations) {
            return [event.id, event] as const;
        }
        const selectedYear = best.years[eventIndex];
        const window = boundedWindow(event, selectedYear, diagnosis);
        const previousTopYear = event.rankedYears[0]?.year
            ?? Math.floor((event.startYear + event.endYear) / 2);
        return [event.id, {
            ...event,
            id: `${event.id}-joint-${window.startYear}-${window.endYear}`,
            ...window,
            rankedYears: rankedYears(event, eventIndex, window, assignments),
            evidence: {
                ...event.evidence,
                algorithmSources: Array.from(new Set([
                    ...event.evidence.algorithmSources,
                    "joint_event_counterfactual",
                ])).sort(),
                notes: [
                    ...event.evidence.notes,
                    "year_ranking=joint_event_counterfactual",
                    `joint_selected_year=${selectedYear}`,
                    `joint_previous_top_year=${previousTopYear}`,
                    `joint_best_score=${best.score.toFixed(6)}`,
                    `joint_assignment_count=${assignments.length}`,
                    ...(window.startYear !== event.startYear
                        ? [
                            "window_refinement=joint_event_edge_nudge",
                            `window_before=${event.startYear}-${event.endYear}`,
                        ]
                        : []),
                ],
            },
        } satisfies DiagnosisEvent] as const;
    }));
    return events.map((event) => refinedById.get(event.id) ?? event);
};
