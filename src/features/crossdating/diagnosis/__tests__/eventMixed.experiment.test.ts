import { describe, expect, it } from "vitest";
import { getConfig } from "../config";
import { locateDenseLagProfileEvents } from "../denseLagProfile";
import { INTERNAL_EVENT_PATH_CONFIG } from "../eventEnsemble";
import { diagnoseLagPath, locateLagPathEvents } from "../eventPath";
import { locateGlobalEditEvents } from "../globalEditAlignment";
import { locatePairedLagExcursionEvents } from "../pairedLagExcursion";
import {
    voteForAdjacentUnitPair,
    voteForAdjacentUnitPairLocalized,
} from "../eventReferenceVoting";
import { locateSegmentedLagEvents } from "../segmentedEventPath";
import { locateReturnToZeroEvents } from "../transitionScan";
import { diagnoseSeriesCore } from "../segments";
import { scoreEditYearsInRegion } from "../rangeMove";
import { scoreDiagnosisEventSets } from "../jointEventRefinement";
import type { DiagnosisEvent, DiagnosisEventType } from "../types";
import { cofechaStyleStandardize } from "../../reference";
import {
    buildSyntheticSite,
    createPiecewiseLagMixedCase,
    getEligibleSeriesForSyntheticTests,
    loadDataFolder,
    pickMixedEventCalendarAnchors,
    sampleAcross,
    type PiecewiseLagEventSpec,
    type RwlSeries,
} from "./rdmFixture";
import { matchDiagnosisEvents, type TruthEvent } from "./eventMetrics";
import {
    diagnoseTargetBundle,
    diagnoseTargetEvents as diagnoseProductionTargetEvents,
} from "./targetDiagnosis";

const TRAIN_FOLDERS = ["EBD", "EBM", "RDM", "RDU"];
const TUNE_FOLDERS = ["EBU", "ZSD"];

let lastDualComparison: {
    primary: DiagnosisEvent[];
    alternate: DiagnosisEvent[];
    primaryScore: ReturnType<typeof scoreDiagnosisEventSets>[number];
    alternateScore: ReturnType<typeof scoreDiagnosisEventSets>[number];
} | null = null;

type Scenario = {
    name: string;
    events: PiecewiseLagEventSpec[];
    wholeSeriesLag?: number;
    adjacent?: boolean;
};

type Aggregate = {
    cases: number;
    answeredCases: number;
    truths: number;
    predictions: number;
    matched: number;
    complete: number;
    widths: number[];
    ranks: number[];
    top1Exact: number;
    top1WithinOne: number;
};

type LocalizationAggregate = {
    truthCount: number;
    predictedTypeCount: number;
    signedErrors: number[];
    absoluteErrors: number[];
};

const empty = (): Aggregate => ({
    cases: 0,
    answeredCases: 0,
    truths: 0,
    predictions: 0,
    matched: 0,
    complete: 0,
    widths: [],
    ranks: [],
    top1Exact: 0,
    top1WithinOne: 0,
});

const emptyLocalization = (): LocalizationAggregate => ({
    truthCount: 0,
    predictedTypeCount: 0,
    signedErrors: [],
    absoluteErrors: [],
});

const add = (aggregate: Aggregate, truths: TruthEvent[], predictions: DiagnosisEvent[]) => {
    const result = matchDiagnosisEvents(truths, predictions);
    aggregate.cases += 1;
    aggregate.answeredCases += predictions.length > 0 ? 1 : 0;
    aggregate.truths += result.truthCount;
    aggregate.predictions += result.predictionCount;
    aggregate.matched += result.matchedCount;
    aggregate.complete += result.completeCaseSuccess ? 1 : 0;
    aggregate.widths.push(...result.widths);
    aggregate.ranks.push(...result.ranks);
    result.matches.forEach(({ truth, prediction }) => {
        const topYear = prediction.rankedYears[0]?.year;
        if (topYear === undefined) return;
        const distance = Math.abs(topYear - truth.year);
        if (distance === 0) aggregate.top1Exact += 1;
        if (distance <= 1) aggregate.top1WithinOne += 1;
    });
    return result;
};

const quantile = (values: number[], p: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};

const summary = (aggregate: Aggregate) => ({
    cases: aggregate.cases,
    responseRate: aggregate.answeredCases / Math.max(1, aggregate.cases),
    abstentionRate: 1 - aggregate.answeredCases / Math.max(1, aggregate.cases),
    truths: aggregate.truths,
    predictions: aggregate.predictions,
    recall: aggregate.matched / Math.max(1, aggregate.truths),
    precision: aggregate.matched / Math.max(1, aggregate.predictions),
    complete: aggregate.complete / Math.max(1, aggregate.cases),
    medianWidth: quantile(aggregate.widths, 0.5),
    p90Width: quantile(aggregate.widths, 0.9),
    medianRank: quantile(aggregate.ranks, 0.5),
    top1ExactCovered: aggregate.top1Exact / Math.max(1, aggregate.matched),
    top1WithinOneCovered: aggregate.top1WithinOne / Math.max(1, aggregate.matched),
});

const localizationSummary = (aggregate: LocalizationAggregate) => ({
    truthCount: aggregate.truthCount,
    predictionCoverage: aggregate.predictedTypeCount / Math.max(1, aggregate.truthCount),
    medianSignedError: quantile(aggregate.signedErrors, 0.5),
    medianAbsoluteError: quantile(aggregate.absoluteErrors, 0.5),
    p90AbsoluteError: quantile(aggregate.absoluteErrors, 0.9),
    within3: aggregate.absoluteErrors.filter((value) => value <= 3).length
        / Math.max(1, aggregate.truthCount),
    within5: aggregate.absoluteErrors.filter((value) => value <= 5).length
        / Math.max(1, aggregate.truthCount),
    signedErrorHistogram: Object.fromEntries(
        Array.from(aggregate.signedErrors.reduce((counts, value) => {
            counts.set(value, (counts.get(value) ?? 0) + 1);
            return counts;
        }, new Map<number, number>()).entries()).sort((a, b) => a[0] - b[0]),
    ),
});

const anchorsFor = (
    series: RwlSeries,
    seed: string,
) => pickMixedEventCalendarAnchors(series, seed);

const scenariosFor = (
    anchors: { old: number; middle: number; newer: number; adjacent: number },
    index: number,
): Scenario[] => {
    const partialA = index % 2 === 0 ? 2 : -2;
    const partialB = index % 3 === 0 ? 3 : -3;
    const falseMode = (["average", "moderate", "splitLike"] as const)[index % 3];
    return [
        {
            name: "multiple-missing-far",
            events: [
                { eventType: "missingRing", year: anchors.old, shiftYears: -1 },
                { eventType: "missingRing", year: anchors.newer, shiftYears: -1 },
            ],
        },
        {
            name: "multiple-false-far",
            events: [
                { eventType: "falseRing", year: anchors.old, shiftYears: 1, falseMode },
                { eventType: "falseRing", year: anchors.newer, shiftYears: 1, falseMode },
            ],
        },
        {
            name: "missing-false-far",
            events: [
                { eventType: "missingRing", year: anchors.old, shiftYears: -1 },
                { eventType: "falseRing", year: anchors.newer, shiftYears: 1, falseMode },
            ],
        },
        {
            name: "missing-partial-far",
            events: [
                { eventType: "missingRing", year: anchors.old, shiftYears: -1 },
                { eventType: "partialMove", year: anchors.newer, shiftYears: partialA },
            ],
        },
        {
            name: "false-partial-far",
            events: [
                { eventType: "falseRing", year: anchors.old, shiftYears: 1, falseMode },
                { eventType: "partialMove", year: anchors.newer, shiftYears: partialA },
            ],
        },
        {
            name: "missing-false-partial-far",
            events: [
                { eventType: "missingRing", year: anchors.old, shiftYears: -1 },
                { eventType: "falseRing", year: anchors.middle, shiftYears: 1, falseMode },
                { eventType: "partialMove", year: anchors.newer, shiftYears: partialB },
            ],
        },
        {
            name: "partial-with-whole",
            events: [
                { eventType: "partialMove", year: anchors.middle, shiftYears: partialA },
            ],
            wholeSeriesLag: 2,
        },
        {
            name: "missing-with-whole",
            events: [
                { eventType: "missingRing", year: anchors.middle, shiftYears: -1 },
            ],
            wholeSeriesLag: 2,
        },
        {
            name: "missing-partial-with-whole",
            events: [
                { eventType: "missingRing", year: anchors.old, shiftYears: -1 },
                { eventType: "partialMove", year: anchors.middle, shiftYears: partialA },
            ],
            wholeSeriesLag: 2,
        },
        {
            name: "adjacent-missing-false",
            events: [
                { eventType: "missingRing", year: anchors.middle, shiftYears: -1 },
                { eventType: "falseRing", year: anchors.adjacent, shiftYears: 1, falseMode },
            ],
            adjacent: true,
        },
    ];
};

const truthsFor = (seriesId: string, scenario: Scenario): TruthEvent[] => {
    const events = scenario.events.map((event, index): TruthEvent => ({
        id: `${seriesId}-${scenario.name}-${index}`,
        seriesId,
        eventType: event.eventType,
        year: event.year,
        ...(event.eventType === "partialMove" ? {
            shiftYears: event.shiftYears,
            shiftSide: "older" as const,
        } : {}),
    }));
    if (scenario.wholeSeriesLag) {
        events.push({
            id: `${seriesId}-${scenario.name}-whole`,
            seriesId,
            eventType: "wholeSeriesMove",
            year: scenario.events[0].year,
        });
    }
    return events;
};

const recenterEditEventWindows = (
    events: DiagnosisEvent[],
    diagnosis: NonNullable<ReturnType<typeof diagnoseSeriesCore>>,
    radius: number,
    maxCenterShift: number,
): DiagnosisEvent[] => events.map((event) => {
    if (event.eventType !== "missingRing" && event.eventType !== "falseRing") return event;
    const width = event.endYear - event.startYear + 1;
    const currentCenter = Math.round((event.startYear + event.endYear) / 2);
    const rows = scoreEditYearsInRegion(
        diagnosis,
        event.eventType === "missingRing" ? "insert" : "delete",
        event.startYear - radius,
        event.endYear + radius,
        currentCenter,
        getConfig({ referenceConfig: null }),
    );
    const top = rows[0];
    if (!top) return event;
    const proposedCenter = Math.max(
        currentCenter - maxCenterShift,
        Math.min(top.year, currentCenter + maxCenterShift),
    );
    const minStart = diagnosis.targetRange.startYear;
    const maxStart = diagnosis.targetRange.endYear - width + 1;
    const startYear = Math.max(
        minStart,
        Math.min(proposedCenter - Math.floor((width - 1) / 2), maxStart),
    );
    const endYear = startYear + width - 1;
    const scoreByYear = new Map(rows.map((row) => [row.year, row.quality]));
    const rankedYears = Array.from({ length: width }, (_, offset) => ({
        year: startYear + offset,
        score: scoreByYear.get(startYear + offset) ?? Number.NEGATIVE_INFINITY,
        evidenceTags: ["bounded_edit_year_scan"],
    }))
        .sort((a, b) => b.score - a.score || b.year - a.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...event,
        id: `${event.id}-edit-localized-${startYear}-${endYear}`,
        startYear,
        endYear,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "local_edit_alignment" as const,
            ])),
            notes: [
                ...event.evidence.notes,
                `edit_scan_top_year=${top.year}`,
                `edit_scan_center_shift=${proposedCenter - currentCenter}`,
            ],
        },
    };
});

const diagnoseTargetEvents = (
    site: NonNullable<ReturnType<typeof buildSyntheticSite>["site"]>,
    seriesId: string,
): DiagnosisEvent[] => {
    lastDualComparison = null;
    const method = process.env.MIXED_METHOD;
    if (method !== "path"
        && method !== "segmented"
        && method !== "path-segmented"
        && method !== "dense"
        && method !== "path-dense"
        && method !== "path-consensus"
        && method !== "dual-path"
        && method !== "dual-partial"
        && method !== "partial-multiview"
        && method !== "partial-pairwise"
        && method !== "partial-conditioned-unit"
        && method !== "path-edit-localize"
        && method !== "path-pulse-consensus"
        && method !== "path-pulse-candidate"
        && method !== "path-pulse-either"
        && method !== "path-pulse-both"
        && method !== "pulse-reference"
        && method !== "reference-pair"
        && method !== "reference-pair-cofecha"
        && method !== "reference-pair-localized"
        && method !== "global-edit"
        && method !== "paired"
        && method !== "transition") {
        const pulseMinGain = process.env.PRODUCTION_PULSE_MIN_GAIN;
        const pulseContextGain = process.env.PRODUCTION_PULSE_CONTEXT_GAIN;
        const robustMasterWeight = process.env.PRODUCTION_ROBUST_MASTER_WEIGHT;
        const individualMasterWeight = process.env.PRODUCTION_INDIVIDUAL_MASTER_WEIGHT;
        const transitionPenaltyUnit = process.env.PRODUCTION_PATH_UNIT_PENALTY;
        const transitionPenaltyBig = process.env.PRODUCTION_PATH_BIG_PENALTY;
        const transitionPenaltyPerYear = process.env.PRODUCTION_PATH_PENALTY_PER_YEAR;
        const minRunYears = process.env.PRODUCTION_PATH_MIN_RUN;
        const minTransitionGain = process.env.PRODUCTION_PATH_MIN_GAIN;
        const adaptiveWindow = process.env.PRODUCTION_ADAPTIVE_WINDOW;
        const multiPartialAdjustment = process.env.PRODUCTION_MULTI_PARTIAL_ADJUSTMENT;
        const multiPartialRankAdjustment = process.env.PRODUCTION_MULTI_PARTIAL_RANK_ADJUSTMENT;
        const wholeOffsetUnitRankAdjustment = process.env.PRODUCTION_WHOLE_UNIT_RANK_ADJUSTMENT;
        const jointLocalRawWeight = process.env.JOINT_LOCAL_RAW_WEIGHT;
        const jointLocalDifferenceWeight = process.env.JOINT_LOCAL_DIFFERENCE_WEIGHT;
        const jointLocalWhitenedWeight = process.env.JOINT_LOCAL_WHITENED_WEIGHT;
        const jointLocalScoreWeight = process.env.JOINT_LOCAL_SCORE_WEIGHT;
        const jointPairedReferenceWeight = process.env.JOINT_PAIRED_REFERENCE_WEIGHT;
        const jointIndependentReferenceWeight = process.env.JOINT_INDEPENDENT_REFERENCE_WEIGHT;
        const jointMaximumReferences = process.env.JOINT_MAXIMUM_REFERENCES;
        const jointIndependentReferenceCount = process.env.JOINT_INDEPENDENT_REFERENCE_COUNT;
        const hasJointOverride = [
            jointLocalRawWeight,
            jointLocalDifferenceWeight,
            jointLocalWhitenedWeight,
            jointLocalScoreWeight,
            jointPairedReferenceWeight,
            jointIndependentReferenceWeight,
            jointMaximumReferences,
            jointIndependentReferenceCount,
        ].some((value) => value !== undefined);
        const productionOptions = {
            enableCounterfactualEventLocator:
                process.env.MIXED_COUNTERFACTUAL_LOCATOR !== "0",
            enableGainGatedOperationRecovery:
                process.env.MIXED_GAIN_GATED_OPERATION_RECOVERY === "1",
            enableMixedReferenceSupplement:
                process.env.MIXED_REFERENCE_SUPPLEMENT !== "0",
            enableIncoherentPartialPruning:
                process.env.MIXED_INCOHERENT_PARTIAL_PRUNING !== "0",
            eventPathConfig: {
                ...(pulseMinGain === undefined ? {} : {
                    minPulseGain: Number(pulseMinGain),
                }),
                ...(pulseContextGain === undefined ? {} : {
                    minPulseContextGain: Number(pulseContextGain),
                }),
                ...(robustMasterWeight === undefined ? {} : {
                    robustMasterWeight: Number(robustMasterWeight),
                }),
                ...(individualMasterWeight === undefined ? {} : {
                    individualMasterWeight: Number(individualMasterWeight),
                }),
                ...(transitionPenaltyUnit === undefined ? {} : {
                    transitionPenaltyUnit: Number(transitionPenaltyUnit),
                }),
                ...(transitionPenaltyBig === undefined ? {} : {
                    transitionPenaltyBig: Number(transitionPenaltyBig),
                }),
                ...(transitionPenaltyPerYear === undefined ? {} : {
                    transitionPenaltyPerYear: Number(transitionPenaltyPerYear),
                }),
                ...(minRunYears === undefined ? {} : {
                    minRunYears: Number(minRunYears),
                }),
                ...(minTransitionGain === undefined ? {} : {
                    minTransitionGain: Number(minTransitionGain),
                }),
                ...(adaptiveWindow === undefined ? {} : {
                    adaptiveProfileWindowPlacement: adaptiveWindow === "1",
                    profileWindowTemperature: Number(
                        process.env.PRODUCTION_WINDOW_TEMPERATURE ?? "1",
                    ),
                    profileWindowMaxShift: Number(
                        process.env.PRODUCTION_WINDOW_MAX_SHIFT ?? "3",
                    ),
                    profileWindowShiftPenalty: Number(
                        process.env.PRODUCTION_WINDOW_SHIFT_PENALTY ?? "0",
                    ),
                }),
                ...(multiPartialAdjustment === undefined ? {} : {
                    multiTransitionPartialBoundaryYearAdjustment: Number(multiPartialAdjustment),
                }),
                ...(multiPartialRankAdjustment === undefined ? {} : {
                    multiTransitionPartialRankYearAdjustment: Number(multiPartialRankAdjustment),
                }),
            },
            ...(wholeOffsetUnitRankAdjustment === undefined ? {} : {
                wholeOffsetUnitRankAdjustment: Number(wholeOffsetUnitRankAdjustment),
            }),
            ...(hasJointOverride ? {
                jointEventRefinementConfig: {
                    ...(jointLocalRawWeight === undefined ? {} : {
                        localRawWeight: Number(jointLocalRawWeight),
                    }),
                    ...(jointLocalDifferenceWeight === undefined ? {} : {
                        localDifferenceWeight: Number(jointLocalDifferenceWeight),
                    }),
                    ...(jointLocalWhitenedWeight === undefined ? {} : {
                        localWhitenedWeight: Number(jointLocalWhitenedWeight),
                    }),
                    ...(jointLocalScoreWeight === undefined ? {} : {
                        localScoreWeight: Number(jointLocalScoreWeight),
                    }),
                    ...(jointPairedReferenceWeight === undefined ? {} : {
                        pairedReferenceWeight: Number(jointPairedReferenceWeight),
                    }),
                    ...(jointIndependentReferenceWeight === undefined ? {} : {
                        independentReferenceWeight: Number(jointIndependentReferenceWeight),
                    }),
                    ...(jointMaximumReferences === undefined ? {} : {
                        maximumReferences: Number(jointMaximumReferences),
                    }),
                    ...(jointIndependentReferenceCount === undefined ? {} : {
                        independentReferenceCount: Number(jointIndependentReferenceCount),
                    }),
                },
            } : {}),
        };
        const primaryBundle = method === "production-dual-score"
            ? diagnoseTargetBundle(site, seriesId, productionOptions)
            : null;
        const primary = primaryBundle?.events
            ?? diagnoseProductionTargetEvents(site, seriesId, productionOptions);
        if ((method !== "production-dual" && method !== "production-dual-score")
            || primary.length === 0) return primary;
        const alternateOptions = {
            ...productionOptions,
            enableMixedReferenceSupplement: false,
            eventPathConfig: {
                ...productionOptions.eventPathConfig,
                transitionPenaltyUnit: 8,
                transitionPenaltyBig: 9,
                minRunYears: 16,
                individualMasterWeight: 0.1,
            },
        };
        const alternateBundle = method === "production-dual-score"
            ? diagnoseTargetBundle(site, seriesId, alternateOptions)
            : null;
        const alternate = alternateBundle?.events
            ?? diagnoseProductionTargetEvents(site, seriesId, alternateOptions);
        if (method !== "production-dual-score" || !primaryBundle) return alternate;
        const [primaryScore, alternateScore] = scoreDiagnosisEventSets(
            [primary, alternate],
            primaryBundle.diagnosis,
            site,
        );
        lastDualComparison = {
            primary,
            alternate,
            primaryScore,
            alternateScore,
        };
        const threshold = Number(process.env.MIXED_DUAL_SCORE_THRESHOLD ?? "0");
        return alternateScore.score > primaryScore.score + threshold
            ? alternate
            : primary;
    }
    const config = getConfig({ referenceConfig: null });
    if (method === "reference-pair"
        || method === "reference-pair-cofecha"
        || method === "reference-pair-localized") {
        const pairDiagnosis = diagnoseSeriesCore(
            site,
            seriesId,
            config,
            method === "reference-pair-cofecha"
                || method === "reference-pair-localized"
                ? (values) => new Map(
                    cofechaStyleStandardize(values).map((point) => [point.year, point.value]),
                )
                : undefined,
        );
        if (!pairDiagnosis) return [];
        const vote = method === "reference-pair-localized"
            ? voteForAdjacentUnitPairLocalized(pairDiagnosis, site)
            : voteForAdjacentUnitPair(pairDiagnosis, site);
        return vote
            && vote.gain >= Number(process.env.REFERENCE_PAIR_MIN_GAIN ?? "0")
            && vote.remoteMargin >= Number(process.env.REFERENCE_PAIR_MIN_MARGIN ?? "-Infinity")
            ? vote.events
            : [];
    }
    const preprocess = (values: Map<number, number>) => new Map(
        cofechaStyleStandardize(values).map((point) => [point.year, point.value]),
    );
    const diagnosis = diagnoseSeriesCore(site, seriesId, config, preprocess);
    if (method === "global-edit") {
        return diagnosis ? locateGlobalEditEvents(diagnosis, {
            maximumEdits: Number(process.env.GLOBAL_MAX_EDITS ?? "5"),
            gapPenalty: Number(process.env.GLOBAL_GAP_PENALTY ?? "1.35"),
            minimumScoreGain: Number(process.env.GLOBAL_MIN_GAIN ?? "1.5"),
        }) : [];
    }
    if (method === "paired") {
        return diagnosis ? locatePairedLagExcursionEvents(diagnosis, {
            minDurationYears: Number(process.env.PAIRED_MIN_DURATION ?? "6"),
            maxDurationYears: Number(process.env.PAIRED_MAX_DURATION ?? "36"),
            contextYears: Number(process.env.PAIRED_CONTEXT ?? "18"),
            minInteriorAdvantage: Number(process.env.PAIRED_MIN_INTERIOR ?? "0.12"),
            minContextAdvantage: Number(process.env.PAIRED_MIN_CONTEXT ?? "-0.02"),
            minScore: Number(process.env.PAIRED_MIN_SCORE ?? "0.28"),
            maxEvents: Number(process.env.PAIRED_MAX_EVENTS ?? "1"),
        }) : [];
    }
    if (method === "transition") {
        return diagnosis ? locateReturnToZeroEvents(diagnosis, {
            minRunYears: Number(process.env.TRANSITION_MIN_RUN ?? "18"),
            minGain: Number(process.env.TRANSITION_MIN_GAIN ?? "3"),
        }) : [];
    }
    if (method === "segmented") {
        return diagnosis ? locateSegmentedLagEvents(diagnosis, {
            minRunYears: Number(process.env.SEGMENTED_MIN_RUN ?? "14"),
            maxSegments: Number(process.env.SEGMENTED_MAX_SEGMENTS ?? "5"),
            transitionPenalty: Number(process.env.SEGMENTED_UNIT_PENALTY ?? "7"),
            largeTransitionPenalty: Number(process.env.SEGMENTED_BIG_PENALTY ?? "8"),
            minLocalGain: Number(process.env.SEGMENTED_MIN_GAIN ?? "3"),
            missingBoundaryYearAdjustment: Number(process.env.SEGMENTED_MISSING_ADJUSTMENT ?? "0"),
            falseBoundaryYearAdjustment: Number(process.env.SEGMENTED_FALSE_ADJUSTMENT ?? "0"),
            partialBoundaryYearAdjustment: Number(process.env.SEGMENTED_PARTIAL_ADJUSTMENT ?? "0"),
        }) : [];
    }
    if (!diagnosis) return [];
    const denseEvents = () => locateDenseLagProfileEvents(diagnosis, {
        windowYears: Number(process.env.DENSE_WINDOW ?? "21"),
        stepYears: Number(process.env.DENSE_STEP ?? "2"),
        transitionPenaltyUnit: Number(process.env.DENSE_UNIT_PENALTY ?? "1.4"),
        transitionPenaltyBig: Number(process.env.DENSE_BIG_PENALTY ?? "1.8"),
        minRunYears: Number(process.env.DENSE_MIN_RUN ?? "10"),
        minSideMeanAdvantage: Number(process.env.DENSE_MIN_SIDE_ADVANTAGE ?? "0.04"),
        minBoundaryGain: Number(process.env.DENSE_MIN_BOUNDARY_GAIN ?? "0.08"),
    });
    if (method === "dense") return denseEvents();
    const pathConfig = {
            ...INTERNAL_EVENT_PATH_CONFIG,
            useCofechaStandardization: process.env.PATH_COFECHA !== "0",
            robustMasterWeight: Number(process.env.PATH_ROBUST_MASTER_WEIGHT ?? "0"),
            individualMasterWeight: Number(process.env.PATH_INDIVIDUAL_MASTER_WEIGHT ?? "0"),
            minPulseGain: Number(process.env.PULSE_MIN_GAIN ?? "4"),
            minPulseYears: Number(process.env.PULSE_MIN_YEARS ?? "6"),
            maxPulseYears: Number(process.env.PULSE_MAX_YEARS ?? "70"),
            pulseMarkerWeight: Number(process.env.PULSE_MARKER_WEIGHT ?? "0"),
            minPulseCombinedScore: Number(process.env.PULSE_MIN_COMBINED_SCORE ?? "-Infinity"),
            minPulseContextGain: Number(process.env.PULSE_CONTEXT_GAIN ?? "0.4"),
            maxPulseCount: Number(process.env.PULSE_MAX_COUNT ?? "3"),
            enablePulseScan: process.env.PULSE_ENABLED === "1",
            transitionPenaltyUnit: Number(process.env.PATH_UNIT_PENALTY ?? "9.5"),
            transitionPenaltyBig: Number(process.env.PATH_BIG_PENALTY ?? "10"),
            minRunYears: Number(process.env.PATH_MIN_RUN ?? "18"),
            maxBoundaryRefinementYears: Number(process.env.PATH_MAX_REFINEMENT ?? "14"),
            adaptiveProfileWindowPlacement: process.env.PATH_ADAPTIVE_WINDOW === "1",
            profileWindowTemperature: Number(process.env.PATH_WINDOW_TEMPERATURE ?? "1"),
            profileWindowMaxShift: Number(process.env.PATH_WINDOW_MAX_SHIFT ?? "3"),
            profileWindowShiftPenalty: Number(process.env.PATH_WINDOW_SHIFT_PENALTY ?? "0"),
            missingBoundaryYearAdjustment: Number(
                process.env.PATH_MISSING_ADJUSTMENT
                    ?? INTERNAL_EVENT_PATH_CONFIG.missingBoundaryYearAdjustment,
            ),
            falseBoundaryYearAdjustment: Number(
                process.env.PATH_FALSE_ADJUSTMENT
                    ?? INTERNAL_EVENT_PATH_CONFIG.falseBoundaryYearAdjustment,
            ),
            partialBoundaryYearAdjustment: Number(
                process.env.PATH_PARTIAL_ADJUSTMENT
                    ?? INTERNAL_EVENT_PATH_CONFIG.partialBoundaryYearAdjustment,
            ),
            multiTransitionMissingBoundaryYearAdjustment: Number(
                process.env.PATH_MULTI_MISSING_ADJUSTMENT
                    ?? INTERNAL_EVENT_PATH_CONFIG.multiTransitionMissingBoundaryYearAdjustment,
            ),
            multiTransitionFalseBoundaryYearAdjustment: Number(
                process.env.PATH_MULTI_FALSE_ADJUSTMENT
                    ?? INTERNAL_EVENT_PATH_CONFIG.multiTransitionFalseBoundaryYearAdjustment,
            ),
            multiTransitionPartialBoundaryYearAdjustment: Number(
                process.env.PATH_MULTI_PARTIAL_ADJUSTMENT
                    ?? INTERNAL_EVENT_PATH_CONFIG.multiTransitionPartialBoundaryYearAdjustment,
            ),
        };
    if (method === "pulse-reference") {
        const pulseEvents = locateLagPathEvents(diagnosis, site, {
            ...pathConfig,
            enablePulseScan: true,
            maxPulseYears: 15,
            maxPulseCount: 1,
        }).filter((event) => event.evidence.algorithmSources.includes("bounded_lag_pulse"));
        if (pulseEvents.length !== 2) return [];
        const ordered = [...pulseEvents].sort((a, b) => a.startYear - b.startYear);
        const older = ordered[0];
        const newer = ordered[1];
        if (older.eventType === newer.eventType
            || (older.eventType !== "missingRing" && older.eventType !== "falseRing")
            || (newer.eventType !== "missingRing" && newer.eventType !== "falseRing")) return [];
        const hint = {
            orientation: older.eventType === "missingRing"
                ? "missingThenFalse" as const
                : "falseThenMissing" as const,
            olderYear: Math.round((older.startYear + older.endYear) / 2),
            newerYear: Math.round((newer.startYear + newer.endYear) / 2),
            maximumDistance: Number(process.env.PULSE_REFERENCE_DISTANCE ?? "4"),
        };
        const vote = process.env.PULSE_REFERENCE_LOCALIZED === "1"
            ? voteForAdjacentUnitPairLocalized(diagnosis, site, hint)
            : voteForAdjacentUnitPair(diagnosis, site, hint);
        return vote
            && vote.gain >= Number(process.env.PULSE_REFERENCE_MIN_GAIN ?? "-Infinity")
            && vote.remoteMargin >= Number(process.env.PULSE_REFERENCE_MIN_MARGIN ?? "-Infinity")
            ? vote.events
            : [];
    }
    if (method === "path-edit-localize") {
        const pathEvents = locateLagPathEvents(diagnosis, site, pathConfig);
        const rawDiagnosis = diagnoseSeriesCore(site, seriesId, config);
        return rawDiagnosis ? recenterEditEventWindows(
            pathEvents,
            rawDiagnosis,
            Number(process.env.EDIT_LOCALIZATION_RADIUS ?? "4"),
            Number(process.env.EDIT_LOCALIZATION_MAX_SHIFT ?? "3"),
        ) : pathEvents;
    }
    if (method === "path-pulse-consensus") {
        const primary = locateLagPathEvents(diagnosis, site, pathConfig);
        const rawDiagnosis = diagnoseSeriesCore(site, seriesId, config);
        if (!rawDiagnosis) return primary.filter((event) => (
            !event.evidence.algorithmSources.includes("bounded_lag_pulse")
        ));
        const corroborating = locateLagPathEvents(rawDiagnosis, site, {
            ...pathConfig,
            useCofechaStandardization: false,
        }).filter((event) => event.evidence.algorithmSources.includes("bounded_lag_pulse"));
        const maximumCenterDistance = Number(process.env.PULSE_CONSENSUS_DISTANCE ?? "4");
        return primary.filter((event) => {
            if (!event.evidence.algorithmSources.includes("bounded_lag_pulse")) return true;
            const center = (event.startYear + event.endYear) / 2;
            return corroborating.some((other) => (
                other.eventType === event.eventType
                && (event.eventType !== "partialMove" || event.shiftYears === other.shiftYears)
                && Math.abs((other.startYear + other.endYear) / 2 - center) <= maximumCenterDistance
            ));
        });
    }
    if (method === "path-pulse-candidate"
        || method === "path-pulse-either"
        || method === "path-pulse-both") {
        const primary = locateLagPathEvents(diagnosis, site, pathConfig);
        const rawDiagnosis = diagnoseSeriesCore(site, seriesId, config);
        const corroborating = rawDiagnosis ? locateLagPathEvents(rawDiagnosis, site, {
            ...pathConfig,
            useCofechaStandardization: false,
        }).filter((event) => event.evidence.algorithmSources.includes("bounded_lag_pulse")) : [];
        const candidates = diagnoseTargetBundle(site, seriesId)?.candidates ?? [];
        const maximumCenterDistance = Number(process.env.PULSE_CONSENSUS_DISTANCE ?? "4");
        const maximumCandidateDistance = Number(process.env.PULSE_CANDIDATE_DISTANCE ?? "7");
        return primary.filter((event) => {
            if (!event.evidence.algorithmSources.includes("bounded_lag_pulse")) return true;
            const center = (event.startYear + event.endYear) / 2;
            const preprocessingSupport = corroborating.some((other) => (
                other.eventType === event.eventType
                && (event.eventType !== "partialMove" || event.shiftYears === other.shiftYears)
                && Math.abs((other.startYear + other.endYear) / 2 - center) <= maximumCenterDistance
            ));
            const expectedOperation = event.eventType === "missingRing"
                ? "INSERT_MISSING_RING"
                : event.eventType === "falseRing"
                    ? "DELETE_FALSE_RING"
                    : "SHIFT_RANGE";
            const candidateSupport = candidates.some((candidate) => (
                candidate.operationType === expectedOperation
                && candidate.evidence.candidateStrength === "strong"
                && Math.abs((candidate.targetYear ?? candidate.anchorYear) - center)
                    <= maximumCandidateDistance
                && (event.eventType !== "partialMove"
                    || candidate.deltaYears === event.shiftYears)
            ));
            if (method === "path-pulse-candidate") return candidateSupport;
            if (method === "path-pulse-both") return preprocessingSupport && candidateSupport;
            return preprocessingSupport || candidateSupport;
        });
    }
    if (method === "path-segmented") {
        const pathDiagnosis = diagnoseLagPath(diagnosis, site, pathConfig);
        const shouldSupplement = pathDiagnosis.newestLag === 0
            && pathDiagnosis.newestLagMargin >= Number(process.env.TAIL_LAG_MARGIN ?? "1")
            && diagnosis.globalSlidingMatch.bestGlobalLag !== 0;
        if (!shouldSupplement) return pathDiagnosis.events;
        const segmented = locateSegmentedLagEvents(diagnosis, {
            minRunYears: Number(process.env.SEGMENTED_MIN_RUN ?? "14"),
            maxSegments: Number(process.env.SEGMENTED_MAX_SEGMENTS ?? "5"),
            transitionPenalty: Number(process.env.SEGMENTED_UNIT_PENALTY ?? "7"),
            largeTransitionPenalty: Number(process.env.SEGMENTED_BIG_PENALTY ?? "8"),
            minLocalGain: Number(process.env.SEGMENTED_MIN_GAIN ?? "8"),
            missingBoundaryYearAdjustment: Number(process.env.SEGMENTED_MISSING_ADJUSTMENT ?? "0"),
            falseBoundaryYearAdjustment: Number(process.env.SEGMENTED_FALSE_ADJUSTMENT ?? "0"),
            partialBoundaryYearAdjustment: Number(process.env.SEGMENTED_PARTIAL_ADJUSTMENT ?? "0"),
        });
        const merged = [...pathDiagnosis.events];
        segmented
            .sort((a, b) => b.evidence.score - a.evidence.score)
            .forEach((event) => {
                const overlaps = merged.some((other) => (
                    Math.max(event.startYear, other.startYear)
                        <= Math.min(event.endYear, other.endYear)
                ));
                if (!overlaps) merged.push(event);
            });
        return merged;
    }
    if (method === "path-dense") {
        const pathDiagnosis = diagnoseLagPath(diagnosis, site, pathConfig);
        const shouldSupplement = process.env.DENSE_GATE !== "1"
            || (pathDiagnosis.newestLag === 0
                && pathDiagnosis.newestLagMargin >= Number(process.env.TAIL_LAG_MARGIN ?? "1")
                && diagnosis.globalSlidingMatch.bestGlobalLag !== 0);
        if (!shouldSupplement) return pathDiagnosis.events;
        const merged = [...pathDiagnosis.events];
        denseEvents()
            .sort((a, b) => b.evidence.score - a.evidence.score)
            .forEach((event) => {
                const overlaps = merged.some((other) => (
                    Math.max(event.startYear, other.startYear)
                        <= Math.min(event.endYear, other.endYear)
                ));
                if (!overlaps) merged.push(event);
            });
        return merged;
    }
    if (method === "path-consensus") {
        const pathDiagnosis = diagnoseLagPath(diagnosis, site, pathConfig);
        const shouldSupplement = process.env.CONSENSUS_GATE === "0"
            || (pathDiagnosis.newestLag === 0
                && pathDiagnosis.newestLagMargin >= Number(process.env.TAIL_LAG_MARGIN ?? "1")
                && diagnosis.globalSlidingMatch.bestGlobalLag !== 0);
        if (!shouldSupplement) return pathDiagnosis.events;
        const segmented = locateSegmentedLagEvents(diagnosis, {
            minRunYears: Number(process.env.SEGMENTED_MIN_RUN ?? "14"),
            maxSegments: Number(process.env.SEGMENTED_MAX_SEGMENTS ?? "5"),
            transitionPenalty: Number(process.env.SEGMENTED_UNIT_PENALTY ?? "7"),
            largeTransitionPenalty: Number(process.env.SEGMENTED_BIG_PENALTY ?? "8"),
            minLocalGain: Number(process.env.SEGMENTED_MIN_GAIN ?? "8"),
        });
        const dense = denseEvents();
        const supported = segmented.filter((event) => dense.some((other) => (
            event.eventType === other.eventType
            && (event.eventType !== "partialMove" || event.shiftYears === other.shiftYears)
            && Math.max(event.startYear, other.startYear - 4)
                <= Math.min(event.endYear, other.endYear + 4)
        )));
        const merged = [...pathDiagnosis.events];
        supported
            .sort((a, b) => b.evidence.score - a.evidence.score)
            .forEach((event) => {
                const overlaps = merged.some((other) => (
                    Math.max(event.startYear, other.startYear)
                        <= Math.min(event.endYear, other.endYear)
                ));
                if (!overlaps) merged.push(event);
            });
        return merged;
    }
    if (method === "dual-path") {
        const primary = locateLagPathEvents(diagnosis, site, pathConfig);
        const rawDiagnosis = diagnoseSeriesCore(site, seriesId, config);
        if (!rawDiagnosis) return primary;
        const supplemental = locateLagPathEvents(rawDiagnosis, site, {
            ...pathConfig,
            useCofechaStandardization: false,
        });
        const merged = [...primary];
        supplemental
            .sort((a, b) => b.evidence.score - a.evidence.score)
            .forEach((event) => {
                const overlaps = merged.some((other) => (
                    Math.max(event.startYear, other.startYear)
                        <= Math.min(event.endYear, other.endYear)
                ));
                if (!overlaps) merged.push(event);
            });
        return merged;
    }
    if (method === "dual-partial") {
        const primary = locateLagPathEvents(diagnosis, site, pathConfig);
        if (process.env.DUAL_PARTIAL_ONLY_IF_ABSENT === "1"
            && primary.some((event) => event.eventType === "partialMove")) return primary;
        const rawDiagnosis = diagnoseSeriesCore(site, seriesId, config);
        if (!rawDiagnosis) return primary;
        const minimumScore = Number(process.env.DUAL_PARTIAL_MIN_SCORE ?? "1");
        const supplemental = locateLagPathEvents(rawDiagnosis, site, {
            ...pathConfig,
            useCofechaStandardization: false,
        }).filter((event) => (
            event.eventType === "partialMove" && event.evidence.score >= minimumScore
        ));
        const merged = [...primary];
        supplemental
            .sort((a, b) => b.evidence.score - a.evidence.score)
            .forEach((event) => {
                const overlaps = merged.some((other) => (
                    Math.max(event.startYear, other.startYear)
                        <= Math.min(event.endYear, other.endYear)
                ));
                if (!overlaps) merged.push(event);
            });
        return merged;
    }
    if (method === "partial-multiview"
        || method === "partial-pairwise"
        || method === "partial-conditioned-unit") {
        const primary = locateLagPathEvents(diagnosis, site, pathConfig);
        const rawDiagnosis = diagnoseSeriesCore(site, seriesId, config);
        if (!rawDiagnosis) return primary;
        const hasLargeLagSignal = primary.some((event) => event.eventType === "partialMove")
            || rawDiagnosis.propagationPatterns.some((pattern) => (
                pattern.patternType === "possiblePartialRangeMove"
                && Math.abs(pattern.dominantLag) >= 2
            ))
            || rawDiagnosis.segments.some((segment) => (
                segment.flagged && Math.abs(segment.bestLag) >= 2
            ));
        if (process.env.MULTIVIEW_GATE === "1" && !hasLargeLagSignal) return primary;
        const rawPartial = locateLagPathEvents(rawDiagnosis, site, {
            ...pathConfig,
            useCofechaStandardization: false,
        }).filter((event) => (
            event.eventType === "partialMove"
            && event.evidence.algorithmSources.includes("piecewise_lag_path")
        ));
        const segmented = locateSegmentedLagEvents(diagnosis, {
            minRunYears: Number(process.env.SEGMENTED_MIN_RUN ?? "14"),
            maxSegments: Number(process.env.SEGMENTED_MAX_SEGMENTS ?? "5"),
            transitionPenalty: Number(process.env.SEGMENTED_UNIT_PENALTY ?? "7"),
            largeTransitionPenalty: Number(process.env.SEGMENTED_BIG_PENALTY ?? "8"),
            minLocalGain: Number(process.env.SEGMENTED_MIN_GAIN ?? "3"),
            partialBoundaryYearAdjustment: Number(
                process.env.SEGMENTED_PARTIAL_ADJUSTMENT ?? "0"
            ),
        }).filter((event) => event.eventType === "partialMove");
        const dense = denseEvents().filter((event) => event.eventType === "partialMove");
        const supportPadding = Number(process.env.MULTIVIEW_SUPPORT_PADDING ?? "4");
        const minimumViews = Number(process.env.MULTIVIEW_MIN_VIEWS ?? "1");
        const agrees = (event: DiagnosisEvent, other: DiagnosisEvent) => (
                other.shiftYears === event.shiftYears
                && Math.max(event.startYear, other.startYear - supportPadding)
                    <= Math.min(event.endYear, other.endYear + supportPadding)
        );
        const segmentedOutputAdjustment = Number(
            process.env.SEGMENTED_OUTPUT_ADJUSTMENT ?? "0"
        );
        const shiftedSegmented = (event: DiagnosisEvent): DiagnosisEvent => {
            if (segmentedOutputAdjustment === 0) return event;
            return {
                ...event,
                id: `${event.id}-output-adjusted-${segmentedOutputAdjustment}`,
                startYear: event.startYear + segmentedOutputAdjustment,
                endYear: event.endYear + segmentedOutputAdjustment,
                rankedYears: event.rankedYears.map((row) => ({
                    ...row,
                    year: row.year + segmentedOutputAdjustment,
                })),
                evidence: {
                    ...event.evidence,
                    notes: [
                        ...event.evidence.notes,
                        `output_boundary_adjustment=${segmentedOutputAdjustment}`,
                    ],
                },
            };
        };
        const supported = method === "partial-pairwise" || method === "partial-conditioned-unit"
            ? [
                ...rawPartial.filter((event) => (
                    segmented.some((other) => agrees(event, other))
                    || dense.some((other) => agrees(event, other))
                )),
                ...segmented.filter((event) => (
                    rawPartial.some((other) => agrees(event, other))
                    || dense.some((other) => agrees(event, other))
                )).map(shiftedSegmented),
                ...dense.filter((event) => (
                    rawPartial.some((other) => agrees(event, other))
                    || segmented.some((other) => agrees(event, other))
                )),
            ]
            : rawPartial.filter((event) => (
                Number(segmented.some((other) => agrees(event, other)))
                    + Number(dense.some((other) => agrees(event, other))) >= minimumViews
            ));
        const merged = [...primary];
        supported
            .sort((a, b) => (
                Number(b.evidence.algorithmSources.includes("piecewise_lag_path"))
                    - Number(a.evidence.algorithmSources.includes("piecewise_lag_path"))
                || b.evidence.score - a.evidence.score
            ))
            .forEach((event) => {
                if (!merged.some((other) => (
                    Math.max(event.startYear, other.startYear)
                        <= Math.min(event.endYear, other.endYear)
                ))) merged.push(event);
            });
        if (method === "partial-conditioned-unit"
            && merged.some((event) => event.eventType === "partialMove")) {
            const unitEvents = locateLagPathEvents(diagnosis, site, {
                ...pathConfig,
                enablePulseScan: false,
                transitionPenaltyUnit: Number(process.env.CONDITIONED_UNIT_PENALTY ?? "7"),
                minRunYears: Number(process.env.CONDITIONED_MIN_RUN ?? "18"),
                minTransitionGain: Number(process.env.CONDITIONED_MIN_GAIN ?? "1"),
            }).filter((event) => (
                (event.eventType === "missingRing" || event.eventType === "falseRing")
                && event.evidence.score >= Number(process.env.CONDITIONED_EVENT_SCORE ?? "1")
            ));
            unitEvents
                .sort((a, b) => b.evidence.score - a.evidence.score)
                .forEach((event) => {
                    if (!merged.some((other) => (
                        Math.max(event.startYear, other.startYear)
                            <= Math.min(event.endYear, other.endYear)
                    ))) merged.push({
                        ...event,
                        evidence: {
                            ...event.evidence,
                            notes: [
                                ...event.evidence.notes,
                                "partial_conditioned_unit_transition",
                            ],
                        },
                    });
                });
        }
        return merged;
    }
    return locateLagPathEvents(diagnosis, site, pathConfig);
};

describe("mixed event experiment with immutable truth coordinates", () => {
    it("reports strict one-to-one event metrics on train or tune stations", () => {
        const split = process.env.MIXED_SPLIT ?? "train";
        const folders = process.env.MIXED_FOLDERS?.split(",").filter(Boolean)
            ?? (split === "tune" ? TUNE_FOLDERS : TRAIN_FOLDERS);
        const overall = empty();
        const mixedTypes = empty();
        const adjacent = empty();
        const byType: Record<DiagnosisEventType, Aggregate> = {
            missingRing: empty(),
            falseRing: empty(),
            partialMove: empty(),
            wholeSeriesMove: empty(),
        };
        const localizationByType: Record<DiagnosisEventType, LocalizationAggregate> = {
            missingRing: emptyLocalization(),
            falseRing: emptyLocalization(),
            partialMove: emptyLocalization(),
            wholeSeriesMove: emptyLocalization(),
        };
        const byScenario = new Map<string, Aggregate>();
        const failures: unknown[] = [];
        const cases: unknown[] = [];
        const refinementChanges: unknown[] = [];
        const dualAudit: unknown[] = [];
        let cleanCases = 0;
        let cleanFalsePositives = 0;

        folders.forEach((folder, folderIndex) => {
            const loaded = loadDataFolder(folder);
            if (!loaded) return;
            const eligible = getEligibleSeriesForSyntheticTests(loaded.crossdated, {
                minLength: 150,
                minNonZero: 120,
                minSpan: 150,
            }).filter((series) => series.zeroCount === 0);
            const targets = sampleAcross(eligible, 2)
                .slice(0, Number(process.env.MIXED_TARGETS ?? "3"));
            targets.forEach((series, targetIndex) => {
                const anchors = anchorsFor(
                    series,
                    `${folder}:${series.id}:${folderIndex}:${targetIndex}`,
                );
                if (!anchors) return;
                const requestedScenarios = new Set(
                    process.env.MIXED_SCENARIOS?.split(",").filter(Boolean) ?? [],
                );
                const scenarios = scenariosFor(anchors, folderIndex * 10 + targetIndex)
                    .filter((scenario) => (
                        requestedScenarios.size === 0 || requestedScenarios.has(scenario.name)
                    ));
                scenarios.forEach((scenario) => {
                    const synthetic = createPiecewiseLagMixedCase(
                        series,
                        scenario.events,
                        scenario.wholeSeriesLag ?? 0,
                    );
                    const site = buildSyntheticSite(
                        loaded.crossdated,
                        series.id,
                        synthetic.corrupted,
                    ).site;
                    if (!site) return;
                    const predictions = diagnoseTargetEvents(site, series.id);
                    const truths = truthsFor(series.id, scenario);
                    const result = add(overall, truths, predictions);
                    if (process.env.PRINT_MIXED_DUAL_AUDIT === "1" && lastDualComparison) {
                        const compactEvent = (event: DiagnosisEvent) => ({
                            type: event.eventType,
                            range: [event.startYear, event.endYear],
                            shiftYears: event.shiftYears,
                            score: event.evidence.score,
                            scoreMargin: event.evidence.scoreMargin,
                            lagBefore: event.evidence.lagBefore,
                            lagAfter: event.evidence.lagAfter,
                            confidence: event.confidenceLevel,
                            candidateCount: event.evidence.candidateIds.length,
                        });
                        dualAudit.push({
                            folder,
                            seriesId: series.id,
                            scenario: scenario.name,
                            truthCount: truths.length,
                            primaryMatch: matchDiagnosisEvents(
                                truths,
                                lastDualComparison.primary,
                            ).matchedCount,
                            alternateMatch: matchDiagnosisEvents(
                                truths,
                                lastDualComparison.alternate,
                            ).matchedCount,
                            primaryScore: lastDualComparison.primaryScore,
                            alternateScore: lastDualComparison.alternateScore,
                            primary: lastDualComparison.primary.map(compactEvent),
                            alternate: lastDualComparison.alternate.map(compactEvent),
                        });
                    }
                    if (process.env.PRINT_REFINEMENT_CHANGES === "1") {
                        predictions.forEach((prediction) => {
                            const beforeNote = prediction.evidence.notes.find((note) => (
                                note.startsWith("window_before=")
                            ));
                            if (!beforeNote) return;
                            const [beforeStart, beforeEnd] = beforeNote
                                .slice("window_before=".length)
                                .split("-")
                                .map(Number);
                            const compatibleTruths = truths.filter((truth) => (
                                truth.eventType === prediction.eventType
                                && (truth.eventType !== "partialMove"
                                    || (truth.shiftYears === prediction.shiftYears
                                        && truth.shiftSide === prediction.shiftSide))
                            ));
                            refinementChanges.push({
                                folder,
                                seriesId: series.id,
                                scenario: scenario.name,
                                eventType: prediction.eventType,
                                before: [beforeStart, beforeEnd],
                                after: [prediction.startYear, prediction.endYear],
                                truthYears: compatibleTruths.map((truth) => truth.year),
                                beforeHits: compatibleTruths
                                    .filter((truth) => truth.year >= beforeStart && truth.year <= beforeEnd)
                                    .map((truth) => truth.year),
                                afterHits: compatibleTruths
                                    .filter((truth) => (
                                        truth.year >= prediction.startYear && truth.year <= prediction.endYear
                                    ))
                                    .map((truth) => truth.year),
                                refinement: prediction.evidence.notes.find((note) => (
                                    note.startsWith("window_refinement=")
                                )),
                            });
                        });
                    }
                    truths.forEach((truth) => {
                        const aggregate = localizationByType[truth.eventType];
                        aggregate.truthCount += 1;
                        const compatible = predictions.filter((prediction) => (
                            prediction.eventType === truth.eventType
                            && (truth.eventType !== "partialMove"
                                || (prediction.shiftYears === truth.shiftYears
                                    && prediction.shiftSide === truth.shiftSide))
                        ));
                        const nearest = compatible
                            .map((prediction) => ({
                                prediction,
                                error: (prediction.startYear + prediction.endYear) / 2 - truth.year,
                            }))
                            .sort((a, b) => Math.abs(a.error) - Math.abs(b.error))[0];
                        if (nearest) {
                            aggregate.predictedTypeCount += 1;
                            aggregate.signedErrors.push(nearest.error);
                            aggregate.absoluteErrors.push(Math.abs(nearest.error));
                        }
                    });
                    if (process.env.PRINT_MIXED_CASES === "1") {
                        cases.push({
                            folder,
                            seriesId: series.id,
                            scenario: scenario.name,
                            truths,
                            predictions: predictions.map((event) => ({
                                id: event.id,
                                type: event.eventType,
                                range: [event.startYear, event.endYear],
                                topYear: event.rankedYears[0]?.year,
                                rankedYears: event.rankedYears.map((row) => row.year),
                                shiftYears: event.shiftYears,
                                lags: [event.evidence.lagBefore, event.evidence.lagAfter],
                                score: event.evidence.score,
                                source: event.evidence.algorithmSources,
                                notes: event.evidence.notes,
                            })),
                            matched: result.matchedCount,
                        });
                    }
                    const scenarioAggregate = byScenario.get(scenario.name) ?? empty();
                    add(scenarioAggregate, truths, predictions);
                    byScenario.set(scenario.name, scenarioAggregate);
                    if (new Set(truths.map((truth) => truth.eventType)).size >= 2) {
                        add(mixedTypes, truths, predictions);
                    }
                    if (scenario.adjacent) add(adjacent, truths, predictions);
                    (Object.keys(byType) as DiagnosisEventType[]).forEach((eventType) => {
                        const typeTruths = truths.filter((truth) => truth.eventType === eventType);
                        if (typeTruths.length === 0) return;
                        const typePredictions = predictions.filter((event) => event.eventType === eventType);
                        add(byType[eventType], typeTruths, typePredictions);
                    });
                    if (!result.completeCaseSuccess && failures.length < 40) {
                        failures.push({
                            folder,
                            seriesId: series.id,
                            scenario: scenario.name,
                            truths,
                            predictions: predictions.map((event) => ({
                                type: event.eventType,
                                range: [event.startYear, event.endYear],
                                topYear: event.rankedYears[0]?.year,
                                shiftYears: event.shiftYears,
                                lags: [event.evidence.lagBefore, event.evidence.lagAfter],
                                score: event.evidence.score,
                                source: event.evidence.algorithmSources,
                            })),
                            missed: result.missedTruthIds,
                            unmatched: result.unmatchedPredictionIds,
                        });
                    }
                });

                const cleanSite = process.env.MIXED_INCLUDE_CLEAN === "0" ? null : buildSyntheticSite(
                    loaded.crossdated,
                    series.id,
                    series.valuesByYear,
                ).site;
                if (cleanSite) {
                    const predictions = diagnoseTargetEvents(cleanSite, series.id);
                    cleanCases += 1;
                    if (predictions.length > 0) {
                        cleanFalsePositives += 1;
                        if (failures.length < 40) {
                            failures.push({
                                folder,
                                seriesId: series.id,
                                scenario: "clean",
                                predictions: predictions.map((event) => ({
                                    type: event.eventType,
                                    range: [event.startYear, event.endYear],
                                    score: event.evidence.score,
                                    source: event.evidence.algorithmSources,
                                    lags: [event.evidence.lagBefore, event.evidence.lagAfter],
                                    notes: event.evidence.notes,
                                })),
                            });
                        }
                    }
                }
            });
        });

        const report = {
            split,
            folders,
            sampling: {
                method: "value-independent deterministic calendar anchors",
                endpointContextYears: 24,
                signalConditionedSelection: false,
            },
            overall: summary(overall),
            mixedTypes: summary(mixedTypes),
            adjacent: summary(adjacent),
            byType: Object.fromEntries(
                Object.entries(byType).map(([eventType, aggregate]) => [eventType, summary(aggregate)]),
            ),
            byScenario: Object.fromEntries(
                Array.from(byScenario.entries()).map(([name, aggregate]) => [name, summary(aggregate)]),
            ),
            localizationByType: Object.fromEntries(
                Object.entries(localizationByType).map(([eventType, aggregate]) => [
                    eventType,
                    localizationSummary(aggregate),
                ]),
            ),
            clean: {
                cases: cleanCases,
                falsePositiveRate: cleanFalsePositives / Math.max(1, cleanCases),
            },
        };
        // eslint-disable-next-line no-console
        console.log(`EVENT_MIXED_EXPERIMENT ${JSON.stringify(report)}`);
        if (process.env.PRINT_MIXED_FAILURES === "1") {
            // eslint-disable-next-line no-console
            console.log(`EVENT_MIXED_FAILURES ${JSON.stringify(failures)}`);
        }
        if (process.env.PRINT_MIXED_CASES === "1") {
            // eslint-disable-next-line no-console
            console.log(`EVENT_MIXED_CASES ${JSON.stringify(cases)}`);
        }
        if (process.env.PRINT_MIXED_DUAL_AUDIT === "1") {
            // eslint-disable-next-line no-console
            console.log(`EVENT_MIXED_DUAL_AUDIT ${JSON.stringify(dualAudit)}`);
        }
        if (process.env.PRINT_REFINEMENT_CHANGES === "1") {
            // eslint-disable-next-line no-console
            console.log(`EVENT_REFINEMENT_CHANGES ${JSON.stringify(refinementChanges)}`);
        }
        expect(overall.truths).toBeGreaterThan(0);
    }, 900_000);

    it("keeps whole-offset missing-ring recovery in one calibrated main window with the truth selectable in Top5", () => {
        const loaded = loadDataFolder("ZSD");
        expect(loaded).not.toBeNull();
        if (!loaded) return;
        const eligible = getEligibleSeriesForSyntheticTests(loaded.crossdated, {
            minLength: 150,
            minNonZero: 120,
            minSpan: 150,
        }).filter((series) => series.zeroCount === 0);
        const targets = sampleAcross(eligible, 2).slice(0, 3);
        let coveredCases = 0;

        targets.forEach((series, targetIndex) => {
            const anchors = anchorsFor(series, `ZSD:${series.id}:regression:${targetIndex}`);
            if (!anchors) return;
            const scenario = scenariosFor(anchors, 10 + targetIndex)
                .find((candidate) => candidate.name === "missing-with-whole");
            if (!scenario) return;
            const synthetic = createPiecewiseLagMixedCase(
                series,
                scenario.events,
                scenario.wholeSeriesLag ?? 0,
            );
            const site = buildSyntheticSite(
                loaded.crossdated,
                series.id,
                synthetic.corrupted,
            ).site;
            if (!site) return;
            const predictions = diagnoseProductionTargetEvents(site, series.id);
            const truth: TruthEvent = {
                id: `${series.id}-whole-offset-missing-regression`,
                seriesId: series.id,
                eventType: "missingRing",
                year: scenario.events[0].year,
            };
            const result = matchDiagnosisEvents(
                [truth],
                predictions.filter((event) => event.eventType === "missingRing"),
            );
            const match = result.matches[0];
            if (!match) return;
            coveredCases += 1;
            expect(match.prediction.reviewCoreRange).toBeUndefined();
            expect(match.prediction.locationAlternatives).toBeUndefined();
            expect(match.prediction.operationAlternatives).toBeUndefined();
            expect(match.prediction.endYear - match.prediction.startYear + 1)
                .toBeLessThanOrEqual(13);
            expect(match.prediction.rankedYears
                .slice(0, 5)
                .some((rankedYear) => rankedYear.year === truth.year)).toBe(true);
        });

        expect(coveredCases).toBeGreaterThanOrEqual(2);
    }, 60_000);
});
