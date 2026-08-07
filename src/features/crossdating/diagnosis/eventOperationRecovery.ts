/**
 * Converts verified signal-only operation hypotheses into reviewable events.
 *
 * The production path requests one main window and verifies only the hypotheses needed
 * for that decision. Generic callers may still opt into the legacy multi-choice output
 * for offline experiments.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import {
    analyzeGainGatedRecovery,
    verifyGainGatedRecoveryYears,
    type GainGatedRecoveryAnalysis,
    type GainGatedRecoveryHypothesis,
} from "./gainGatedEventRecovery";
import {
    getJointCounterfactualOperationScores,
    type JointCounterfactualOperationScore,
} from "./jointCounterfactualOperation";
import { scoreJointOperationPresence } from "./jointOperationPresence";
import {
    selectDynamicJointOperation,
    selectDynamicPartialOperationAtBreakpoint,
    selectDynamicUnitOperation,
    selectJointCounterfactualOperation,
} from "./jointOperationSelector";
import { scoreFalseRingReferenceConsensusRecovery } from "./unitReferenceConsensusRecovery";
import {
    DEFAULT_MAX_PARTIAL_GAP_YEARS,
    firstFixedYearFromLastMovedYear,
} from "./partialMoveSemantics";
import type {
    DiagnosisEvent,
    DiagnosisEventLocationAlternative,
    DiagnosisEventType,
    DiagnosisRankedYear,
    SeriesCoreDiagnosis,
} from "./types";
import { wholeSeriesMoveShiftYears } from "./wholeSeriesMoveSemantics";

type RecoverableEventType = Exclude<DiagnosisEventType, "wholeSeriesMove">;

type LocationSignal = {
    algorithmSource: string;
    rows: Array<{ year: number; score: number }>;
};

type LocationChoice = Omit<DiagnosisEventLocationAlternative, "rank">;

export type EventOperationRecoveryConfig = {
    outputSingleMainWindow: boolean;
    existingEventMinimumGain: number;
    emptyEventMinimumGain: number;
    emptyEventFallbackMinimumGain: number;
    emptyEventFallbackMinimumMargin: number;
    verificationHypothesisCount: number;
    primaryDecisionHypothesisCount: number;
    verificationLocationCount: number;
    supplementalVerificationLocationCount: number;
    maximumOperationAlternatives: number;
    unitWindowYears: number;
    partialWindowYears: number;
    locationsPerSignal: number;
    maximumSignalLocationChoices: number;
    maximumLocationAlternatives: number;
    minimumSideYears: number;
    maxPartialGapYears: number;
    jointCounterfactualMinimumGain: number;
    dynamicJointMinimumScore: number;
    dynamicJointPartialShiftMinimumMargin: number;
    dynamicJointPartialOverUnitMinimumMargin: number;
    dynamicJointPartialUnitMinimumScore: number;
    dynamicJointPartialUnitMinimumMargin: number;
    dynamicJointPartialUnitMaximumDeficit: number;
    dynamicJointPartialUnitMinimumExistingMagnitude: number;
    dynamicJointUnitChainPartialMinimumMargin: number;
    dynamicJointUnitOverPartialMinimumMargin: number;
    dynamicJointUnitTypeMinimumMargin: number;
    dynamicJointUnitTypeCorrectionMinimumScore: number;
    dynamicJointUnitTypeCorrectionMinimumMargin: number;
    dynamicJointWholeOnlyMinimumScore: number;
};

export const DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG:
EventOperationRecoveryConfig = {
    outputSingleMainWindow: false,
    existingEventMinimumGain: 0.02,
    emptyEventMinimumGain: 0.1,
    emptyEventFallbackMinimumGain: 0.03,
    emptyEventFallbackMinimumMargin: 0.018,
    verificationHypothesisCount: 3,
    primaryDecisionHypothesisCount: 2,
    verificationLocationCount: 2,
    supplementalVerificationLocationCount: 1,
    maximumOperationAlternatives: 2,
    unitWindowYears: 7,
    partialWindowYears: 9,
    locationsPerSignal: 2,
    maximumSignalLocationChoices: 3,
    maximumLocationAlternatives: 4,
    minimumSideYears: 18,
    maxPartialGapYears: DEFAULT_MAX_PARTIAL_GAP_YEARS,
    jointCounterfactualMinimumGain: 0.042793139568471805,
    // Calibrated on offset 13 and checked on offset 14 baseline-clean ITRDB cases.
    dynamicJointMinimumScore: 0.08,
    dynamicJointPartialShiftMinimumMargin: 0.035,
    dynamicJointPartialOverUnitMinimumMargin: 0.075,
    // Independent arbitrary-year offsets 18 and 19 calibrate this hierarchy gate.
    dynamicJointPartialUnitMinimumScore: 0.02,
    dynamicJointPartialUnitMinimumMargin: 0,
    dynamicJointPartialUnitMaximumDeficit: 0.2,
    dynamicJointPartialUnitMinimumExistingMagnitude: 10,
    dynamicJointUnitChainPartialMinimumMargin: 0.2,
    dynamicJointUnitOverPartialMinimumMargin: 0,
    // Unit winners separated by this margin were correct in all eight large-partial
    // overrides across arbitrary-year offsets 20..32; lower margins remain ambiguous.
    dynamicJointUnitTypeMinimumMargin: 0.035,
    // Existing unit events need less absolute gain than whole-baseline overrides, but the
    // opposite unit direction must still be separated. Offsets 20..38 yielded 3/3 corrections.
    dynamicJointUnitTypeCorrectionMinimumScore: 0.06,
    dynamicJointUnitTypeCorrectionMinimumMargin: 0.015,
    dynamicJointWholeOnlyMinimumScore: 0.15,
};

const eventShiftYears = (event: DiagnosisEvent): number | null => {
    if (event.eventType === "missingRing") return -1;
    if (event.eventType === "falseRing") return 1;
    return event.eventType === "partialMove" ? event.shiftYears ?? null : null;
};

const sameOperation = (
    event: DiagnosisEvent,
    hypothesis: GainGatedRecoveryHypothesis,
): boolean => (
    event.eventType === hypothesis.eventType
    && eventShiftYears(event) === hypothesis.shiftYears
);

const jointEventFromOperation = (
    operation: JointCounterfactualOperationScore,
    matchingEvent: DiagnosisEvent | null,
    diagnosis: SeriesCoreDiagnosis,
    scoreMargin: number,
    selectorProbability: number | null,
    config: EventOperationRecoveryConfig,
): DiagnosisEvent => {
    const width = operation.eventType === "partialMove"
        ? config.partialWindowYears
        : config.unitWindowYears;
    const window = matchingEvent
        ? {
            startYear: matchingEvent.startYear,
            endYear: matchingEvent.endYear,
        }
        : boundedWindow(
            operation.bestYear,
            width,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
        );
    const rows = operation.rows.map((row) => ({
        year: row.year,
        score: row.differenceGain * 0.75 + row.combinedGain * 0.25,
    }));
    const score = operation.topThreeDifferenceGain;
    const baselineCorrelation = matchingEvent?.evidence.baselineCorrelation ?? null;
    return {
        id: [
            diagnosis.targetTree,
            "joint-counterfactual",
            operation.eventType,
            operation.shiftYears,
            window.startYear,
            window.endYear,
        ].join("-"),
        seriesId: diagnosis.targetTree,
        eventType: operation.eventType,
        ...window,
        rankedYears: rankedYears(
            window,
            rows,
            "joint_year_operation_evidence",
        ),
        confidenceLevel: confidenceFor(score, scoreMargin, false),
        evidence: {
            algorithmSources: Array.from(new Set([
                ...(matchingEvent?.evidence.algorithmSources ?? []),
                "joint_year_operation_evidence",
                "full_interval_counterfactual_scan",
            ])).sort(),
            score,
            scoreMargin,
            baselineCorrelation,
            correctedCorrelation: baselineCorrelation === null
                ? matchingEvent?.evidence.correctedCorrelation ?? null
                : baselineCorrelation + operation.bestRawGain,
            correlationGain: operation.bestCombinedGain,
            lagBefore: operation.shiftYears,
            lagAfter: 0,
            samplePairs: matchingEvent?.evidence.samplePairs
                ?? diagnosis.rawTarget.size,
            candidateIds: matchingEvent?.evidence.candidateIds ?? [],
            notes: Array.from(new Set([
                ...(matchingEvent?.evidence.notes ?? []),
                "operation_recovery=joint_year_operation_distribution",
                `joint_operation_correction=${operation.shiftYears}`,
                `joint_operation_top3_difference_gain=${
                    operation.topThreeDifferenceGain.toFixed(6)
                }`,
                `joint_operation_best_difference_gain=${
                    operation.bestDifferenceGain.toFixed(6)
                }`,
                `joint_operation_remote_margin=${
                    operation.remoteDifferenceMargin.toFixed(6)
                }`,
                ...(selectorProbability === null ? [] : [
                    `joint_operation_selector_probability=${
                        selectorProbability.toFixed(6)
                    }`,
                    `joint_operation_selector_margin=${scoreMargin.toFixed(6)}`,
                ]),
            ])),
        },
        alternativeTypes: matchingEvent?.alternativeTypes ?? [],
        ...(operation.eventType === "partialMove" ? {
            shiftYears: operation.shiftYears,
            shiftSide: "older" as const,
        } : {}),
    };
};

export type DecisiveJointOperationFusionResult = {
    action: "override" | "recover";
    selectionSource:
        | "dynamic_joint_grid"
        | "dynamic_unit_fallback"
        | "dynamic_unit_type_correction"
        | "dynamic_partial_breakpoint"
        | "legacy_joint_selector";
    operation: JointCounterfactualOperationScore;
    selectorProbability: number;
    selectorMargin: number;
    presenceProbability: number | null;
    presenceThreshold: number | null;
};

/**
 * The dynamic -2..-max gap grid is deliberately fused only once, after reference-pass
 * selection. A very strong winner may correct one upstream operation or recover an empty
 * result; ordinary upstream events and coherent mixed paths remain untouched.
 */
export const selectDecisiveJointOperationFusion = (
    events: readonly DiagnosisEvent[],
    operations: readonly JointCounterfactualOperationScore[],
    overrides: Partial<EventOperationRecoveryConfig> = {},
): DecisiveJointOperationFusionResult | null => {
    const config = {
        ...DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG,
        ...overrides,
    };
    const wholeEvents = events.filter((event) => event.eventType === "wholeSeriesMove");
    const localEvents = events.filter((event) => event.eventType !== "wholeSeriesMove");
    const eventCenter = (event: DiagnosisEvent): number => (
        event.rankedYears.slice().sort((left, right) => left.rank - right.rank)[0]?.year
        ?? (event.startYear + event.endYear) / 2
    );
    const orderedLocalEvents = localEvents.slice().sort((left, right) => (
        eventCenter(left) - eventCenter(right)
        || left.startYear - right.startYear
    ));
    const coherentLocalChain = orderedLocalEvents.length > 1
        && orderedLocalEvents.every((event) => (
            event.evidence.lagBefore !== null
            && event.evidence.lagAfter !== null
            && event.evidence.lagBefore !== event.evidence.lagAfter
        ))
        && orderedLocalEvents.slice(1).every((event, index) => (
            orderedLocalEvents[index].evidence.lagAfter
                === event.evidence.lagBefore
        ));

    const strongestExisting = localEvents.slice().sort((left, right) => (
        right.evidence.score - left.evidence.score
        || right.evidence.scoreMargin - left.evidence.scoreMargin
    ))[0] ?? null;
    const existingPartialMagnitude = Math.max(
        0,
        ...localEvents.flatMap((event) => (
            event.eventType === "partialMove" && event.shiftYears !== undefined
                ? [Math.abs(event.shiftYears)]
                : []
        )),
    );
    const initialGridSelection = selectDynamicJointOperation(operations);
    const unitSelection = selectDynamicUnitOperation(operations);
    const unitFallbackSelection =
        initialGridSelection?.operation.eventType === "partialMove"
        ? unitSelection
        : null;
    const unitTypeCorrection = localEvents.length === 1
        && (
            localEvents[0].eventType === "missingRing"
            || localEvents[0].eventType === "falseRing"
        )
        && unitSelection !== null
        && unitSelection.operation.eventType !== localEvents[0].eventType
        && unitSelection.score
            >= config.dynamicJointUnitTypeCorrectionMinimumScore
        && unitSelection.scoreMargin
            >= config.dynamicJointUnitTypeCorrectionMinimumMargin
        && (
            initialGridSelection?.operation.eventType !== "partialMove"
            || initialGridSelection.score - unitSelection.score
                <= config.dynamicJointPartialUnitMaximumDeficit
        );
    const partialUnitContextPasses = strongestExisting === null
        || (
            localEvents.length === 1
            && strongestExisting?.eventType === "partialMove"
            && existingPartialMagnitude
                >= config.dynamicJointPartialUnitMinimumExistingMagnitude
        );
    const usePartialUnitFallback = (
        unitFallbackSelection !== null
        && initialGridSelection !== null
        && partialUnitContextPasses
        && unitFallbackSelection.score
            >= config.dynamicJointPartialUnitMinimumScore
        && unitFallbackSelection.scoreMargin
            >= config.dynamicJointPartialUnitMinimumMargin
        && initialGridSelection.score - unitFallbackSelection.score
            <= config.dynamicJointPartialUnitMaximumDeficit
    );
    const gridSelection = unitTypeCorrection
        ? unitSelection
        : usePartialUnitFallback
            ? unitFallbackSelection
            : initialGridSelection;
    const gridOperation = gridSelection?.operation ?? null;
    const gridMatchesExisting = gridOperation !== null
        && localEvents.some((event) => (
            event.eventType === gridOperation.eventType
            && eventShiftYears(event) === gridOperation.shiftYears
        ));
    const stablePartialShift = gridSelection !== null
        && gridOperation?.eventType === "partialMove"
        && (gridSelection.shiftScoreMargin ?? 0)
            >= config.dynamicJointPartialShiftMinimumMargin;
    const coherentUnitChainOverride = coherentLocalChain
        && localEvents.every((event) => (
            event.eventType === "missingRing" || event.eventType === "falseRing"
        ))
        && gridOperation?.eventType === "partialMove"
        && stablePartialShift
        && (gridSelection?.scoreMargin ?? 0)
            >= config.dynamicJointUnitChainPartialMinimumMargin;
    const wholePartialUnitCorrection = wholeEvents.length > 0
        && localEvents.length === 1
        && localEvents[0].eventType === "partialMove"
        && gridOperation !== null
        && gridOperation.eventType !== "partialMove";
    const wholeLag = wholeEvents.length === 1
        ? wholeSeriesMoveShiftYears(wholeEvents[0])
        : null;
    const wholeBaselineIsOlderPartialState = wholeLag !== null
        && wholeLag <= -2
        && gridOperation?.eventType === "partialMove"
        && gridOperation.shiftYears === wholeLag
        && stablePartialShift
        && (gridSelection?.scoreMargin ?? 0)
            >= config.dynamicJointPartialOverUnitMinimumMargin
        && gridOperation.bestYear - wholeEvents[0].startYear
            >= config.minimumSideYears
        && wholeEvents[0].endYear - gridOperation.bestYear + 1
            >= config.minimumSideYears
        && localEvents.some((event) => (
            event.evidence.lagBefore === wholeLag
            && event.evidence.lagAfter !== null
            && Math.abs(event.evidence.lagAfter) < Math.abs(wholeLag)
        ));
    // Preserve mixed lag paths. A whole-series baseline may retain one corrected local unit
    // event. The exception is an interior exact-gap winner whose local path starts at the
    // alleged whole lag and moves toward zero: that topology makes the whole lag the older
    // partial state, not the newer fixed-side baseline.
    if (
        (
            wholeEvents.length > 0
            && localEvents.length > 0
            && !wholePartialUnitCorrection
            && !unitTypeCorrection
            && !wholeBaselineIsOlderPartialState
        )
        || (coherentLocalChain && !coherentUnitChainOverride)
    ) {
        return null;
    }
    const gridScoreThreshold = usePartialUnitFallback
        ? config.dynamicJointPartialUnitMinimumScore
        : unitTypeCorrection
            ? config.dynamicJointUnitTypeCorrectionMinimumScore
        : wholeEvents.length > 0
            ? config.dynamicJointWholeOnlyMinimumScore
            : config.dynamicJointMinimumScore;
    const gridPresencePasses = gridSelection !== null
        && gridSelection.score >= gridScoreThreshold
        && (
            gridOperation?.eventType !== "partialMove"
            || stablePartialShift
        );
    const gridTypeChangePasses = gridSelection !== null
        && strongestExisting !== null
        && (
            strongestExisting.eventType === gridOperation?.eventType
            || (
                gridOperation?.eventType === "partialMove"
                && gridSelection.scoreMargin
                    >= config.dynamicJointPartialOverUnitMinimumMargin
            )
            || (
                unitTypeCorrection
                && gridOperation?.eventType !== "partialMove"
            )
            || (
                gridOperation?.eventType !== "partialMove"
                && gridSelection.scoreMargin
                    >= config.dynamicJointUnitOverPartialMinimumMargin
                && (unitSelection?.scoreMargin ?? 0)
                    >= config.dynamicJointUnitTypeMinimumMargin
            )
            || (
                usePartialUnitFallback
                && strongestExisting.eventType === "partialMove"
                && gridSelection.scoreMargin
                    >= config.dynamicJointPartialUnitMinimumMargin
            )
        );
    const doesNotCompressExistingPartial = gridOperation?.eventType !== "partialMove"
        || existingPartialMagnitude === 0
        || Math.abs(gridOperation.shiftYears) > existingPartialMagnitude
        || gridMatchesExisting;

    if (
        gridPresencePasses
        && gridSelection
        && gridOperation
        && (strongestExisting === null || gridTypeChangePasses)
        && doesNotCompressExistingPartial
        && (!gridMatchesExisting || localEvents.length > 1)
        && !(
            localEvents.length === 1
            && localEvents[0].eventType === "partialMove"
            && gridOperation.eventType === "partialMove"
        )
    ) {
        return {
            action: strongestExisting === null ? "recover" : "override",
            selectionSource: unitTypeCorrection
                ? "dynamic_unit_type_correction"
                : usePartialUnitFallback
                    ? "dynamic_unit_fallback"
                    : "dynamic_joint_grid",
            operation: gridOperation,
            selectorProbability: gridSelection.probabilityLike,
            selectorMargin: gridSelection.scoreMargin,
            presenceProbability: null,
            presenceThreshold: gridScoreThreshold,
        };
    }

    if (
        localEvents.length === 1
        && localEvents[0].eventType === "partialMove"
        && gridMatchesExisting
        && stablePartialShift
    ) {
        // The global grid has already separated the current gap from all 98 alternatives.
        // Breakpoint-local evidence may still move the year later, but must not rewrite the gap.
        return null;
    }

    if (
        localEvents.length === 1
        && localEvents[0].eventType === "partialMove"
    ) {
        const currentEvent = localEvents[0];
        const firstFixedYear = currentEvent.rankedYears
            .slice()
            .sort((left, right) => left.rank - right.rank)[0]?.year
            ?? Math.round((currentEvent.startYear + currentEvent.endYear) / 2);
        const dynamicSelection = selectDynamicPartialOperationAtBreakpoint(
            operations,
            firstFixedYear,
        );
        const globallyConfirmedDynamicShift = dynamicSelection !== null
            && initialGridSelection !== null
            && initialGridSelection.operation.eventType === "partialMove"
            && initialGridSelection.operation.shiftYears
                === dynamicSelection.operation.shiftYears
            && initialGridSelection.score >= config.dynamicJointMinimumScore
            && (initialGridSelection.shiftScoreMargin ?? 0)
                >= config.dynamicJointPartialShiftMinimumMargin
            && initialGridSelection.scoreMargin
                >= config.dynamicJointPartialOverUnitMinimumMargin
            && dynamicSelection.scoreMargin
                >= config.dynamicJointPartialShiftMinimumMargin;
        if (
            dynamicSelection
            && globallyConfirmedDynamicShift
            && dynamicSelection.operation.shiftYears !== currentEvent.shiftYears
            && Math.abs(dynamicSelection.operation.shiftYears)
                > Math.abs(currentEvent.shiftYears ?? 0)
        ) {
            return {
                action: "override",
                selectionSource: "dynamic_partial_breakpoint",
                operation: dynamicSelection.operation,
                selectorProbability: dynamicSelection.probabilityLike,
                selectorMargin: dynamicSelection.scoreMargin,
                presenceProbability: null,
                presenceThreshold: config.dynamicJointMinimumScore,
            };
        }
        return null;
    }

    const selection = selectJointCounterfactualOperation(operations);
    const selectedOperation = selection?.operation;
    if (!selection || !selectedOperation) return null;
    if (localEvents.some((event) => (
        event.eventType === selectedOperation.eventType
        && eventShiftYears(event) === selectedOperation.shiftYears
    ))) {
        return null;
    }
    const existingPartialShifts = localEvents.flatMap((event) => (
        event.eventType === "partialMove" && event.shiftYears !== undefined
            ? [event.shiftYears]
            : []
    ));
    if (existingPartialShifts.length > 0 && (
        selectedOperation.eventType !== "partialMove"
        || Math.abs(selectedOperation.shiftYears)
            <= Math.max(...existingPartialShifts.map(Math.abs))
    )) {
        // The dynamic selector has no calibrated 99-class override model. Never compress an
        // upstream -20/-50/-100 diagnosis into a smaller gap or reinterpret it as a unit edit.
        return null;
    }

    const presence = scoreJointOperationPresence(operations, selectedOperation);
    const operationIsPresent = presence
        ? presence.present
        : selectedOperation.topThreeDifferenceGain
            >= config.jointCounterfactualMinimumGain;
    if (!operationIsPresent) return null;

    const hasExisting = localEvents.length > 0;
    const isDecisive = hasExisting
        ? selection.probability >= 0.995
            && selection.probabilityMargin >= 0.99
            && selectedOperation.topThreeDifferenceGain >= 0.62
            && selectedOperation.remoteDifferenceMargin >= 0.04
        : selection.probability >= 0.95
            && selection.probabilityMargin >= 0.9
            && selectedOperation.topThreeDifferenceGain >= 0.4
            && selectedOperation.remoteDifferenceMargin >= 0.025;
    if (!isDecisive) return null;

    return {
        action: hasExisting ? "override" : "recover",
        selectionSource: "legacy_joint_selector",
        operation: selectedOperation,
        selectorProbability: selection.probability,
        selectorMargin: selection.probabilityMargin,
        presenceProbability: presence?.probability ?? null,
        presenceThreshold: presence?.threshold ?? null,
    };
};

export const fuseDecisiveJointOperationScores = (
    events: DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    operations: readonly JointCounterfactualOperationScore[],
    overrides: Partial<EventOperationRecoveryConfig> = {},
): DiagnosisEvent[] => {
    const config = {
        ...DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG,
        ...overrides,
    };
    const fusion = selectDecisiveJointOperationFusion(
        events,
        operations,
        config,
    );
    if (!fusion) return events;

    const wholeEvents = events.filter((event) => event.eventType === "wholeSeriesMove");
    const localEvents = events.filter((event) => event.eventType !== "wholeSeriesMove");
    const wholeOnlyPartialAlias = wholeEvents.length === 1
        && localEvents.length === 0
        && fusion.operation.eventType === "partialMove"
        && fusion.operation.shiftYears === wholeSeriesMoveShiftYears(wholeEvents[0])
        && diagnosis.targetRange.endYear - fusion.operation.bestYear + 1
            < config.minimumSideYears;
    // The local grid has no whole-series hypothesis. Near the newer endpoint it can imitate a
    // pure global offset by moving almost the entire core and sacrificing only the short tail.
    // Preserve the upstream global decision until an independently detected boundary exists.
    if (wholeOnlyPartialAlias) return events;
    const matchingEvent = fusion.action === "override"
        ? events.find((event) => (
            event.eventType === fusion.operation.eventType
            && eventShiftYears(event) === fusion.operation.shiftYears
        )) ?? (
            fusion.selectionSource === "dynamic_partial_breakpoint"
                ? events.find((event) => event.eventType !== "wholeSeriesMove") ?? null
                : null
        )
        : null;
    const recovered = jointEventFromOperation(
        fusion.operation,
        matchingEvent,
        diagnosis,
        fusion.selectorMargin,
        fusion.selectorProbability,
        config,
    );
    return [
        ...wholeEvents,
        {
            ...recovered,
            evidence: {
                ...recovered.evidence,
                algorithmSources: Array.from(new Set([
                    ...recovered.evidence.algorithmSources,
                    "decisive_joint_operation_fusion",
                ])).sort(),
                notes: [
                    ...recovered.evidence.notes,
                    fusion.action === "override"
                        ? fusion.selectionSource === "dynamic_partial_breakpoint"
                            ? "operation_fusion=dynamic_partial_breakpoint_override"
                            : fusion.selectionSource === "dynamic_joint_grid"
                                ? "operation_fusion=dynamic_joint_grid_override"
                                : fusion.selectionSource
                                    === "dynamic_unit_type_correction"
                                    ? "operation_fusion=dynamic_unit_type_correction"
                                : fusion.selectionSource === "dynamic_unit_fallback"
                                    ? "operation_fusion=dynamic_unit_fallback_override"
                                : "operation_fusion=decisive_joint_override"
                        : "operation_fusion=decisive_empty_recovery",
                    ...(fusion.presenceProbability === null ? [] : [
                        `joint_operation_presence_probability=${
                            fusion.presenceProbability.toFixed(6)
                        }`,
                        `joint_operation_presence_threshold=${
                            fusion.presenceThreshold?.toFixed(6)
                        }`,
                    ]),
                ],
            },
        },
    ];
};

export const selectSubtleFalseRingEmptyRecovery = (
    operations: readonly JointCounterfactualOperationScore[],
): JointCounterfactualOperationScore | null => {
    const falseRing = operations.find((operation) => (
        operation.eventType === "falseRing" && operation.shiftYears === 1
    ));
    const missingRing = operations.find((operation) => (
        operation.eventType === "missingRing" && operation.shiftYears === -1
    ));
    if (!falseRing || !missingRing || falseRing.baselineLag !== 0) return null;

    const hasLocalizedBoundary = (
        falseRing.topThreeDifferenceGain >= 0.02
        && falseRing.bestDifferenceGain >= 0.025
        && falseRing.sideStepRemoteMargin >= 0.15
        && falseRing.bestCorrectedSideSupport >= 0.2
        && falseRing.bestSideMinimumAdvantage <= 0
        && missingRing.bestCorrectedSideSupport < 0
        && Math.abs(falseRing.sideStepBestYear - falseRing.bestYear) <= 12
    );
    return hasLocalizedBoundary ? falseRing : null;
};

export const recoverSubtleFalseRingEmptySuggestion = (
    events: DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    operations: readonly JointCounterfactualOperationScore[],
    overrides: Partial<EventOperationRecoveryConfig> = {},
): DiagnosisEvent[] => {
    if (events.length > 0) return events;
    const operation = selectSubtleFalseRingEmptyRecovery(operations);
    if (!operation) return events;

    const config = {
        ...DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG,
        ...overrides,
        unitWindowYears: 13,
    };
    const centeredOperation = {
        ...operation,
        bestYear: operation.sideStepBestYear,
    };
    const recovered = jointEventFromOperation(
        centeredOperation,
        null,
        diagnosis,
        operation.sideStepRemoteMargin,
        null,
        config,
    );
    const window = {
        startYear: recovered.startYear,
        endYear: recovered.endYear,
    };
    return [{
        ...recovered,
        rankedYears: rankedYears(
            window,
            operation.rows.map((row) => ({
                year: row.year,
                score: row.sideStepScore,
            })),
            "subtle_false_ring_boundary_evidence",
        ),
        evidence: {
            ...recovered.evidence,
            algorithmSources: Array.from(new Set([
                ...recovered.evidence.algorithmSources,
                "subtle_false_ring_empty_recovery",
                "subtle_false_ring_boundary_evidence",
            ])).sort(),
            notes: [
                ...recovered.evidence.notes,
                "operation_fusion=subtle_false_ring_empty_recovery",
                `subtle_false_ring_center_year=${operation.sideStepBestYear}`,
                `subtle_false_ring_best_year=${operation.bestYear}`,
                `subtle_false_ring_best_side_minimum_advantage=${
                    operation.bestSideMinimumAdvantage.toFixed(6)
                }`,
                `subtle_false_ring_corrected_side_support=${
                    operation.bestCorrectedSideSupport.toFixed(6)
                }`,
                `subtle_false_ring_opposite_corrected_side_support=${
                    operations.find((candidate) => (
                        candidate.eventType === "missingRing"
                        && candidate.shiftYears === -1
                    ))?.bestCorrectedSideSupport.toFixed(6)
                }`,
                `subtle_false_ring_side_step_remote_margin=${
                    operation.sideStepRemoteMargin.toFixed(6)
                }`,
            ],
        },
    }];
};

export const applyDecisiveJointOperationFusion = (
    events: DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    overrides: Partial<EventOperationRecoveryConfig> = {},
    siteData?: RwlSiteData,
): DiagnosisEvent[] => {
    const config = {
        ...DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG,
        ...overrides,
    };
    const wholeSeriesBaseline = events.some(
        (event) => event.eventType === "wholeSeriesMove",
    );
    const localUnitEvents = events.filter((event) => (
        event.eventType === "missingRing" || event.eventType === "falseRing"
    ));
    // Unit corrections are relative to the newer fixed side. With a whole-series offset that
    // side is not lag zero in the observed calendar, so a zero baseline reverses the operation.
    // Partial gaps keep their separate zero-relative search until that pipeline is revised.
    const baselineLag = wholeSeriesBaseline && localUnitEvents.length === 1
        ? localUnitEvents[0].evidence.lagAfter ?? 0
        : 0;
    const operations = getJointCounterfactualOperationScores(
        diagnosis,
        15,
        config.maxPartialGapYears,
        baselineLag,
    );
    const fused = fuseDecisiveJointOperationScores(
        events,
        diagnosis,
        operations,
        config,
    );
    if (events.length === 0 && fused.length === 0) {
        if (siteData) {
            const consensus = scoreFalseRingReferenceConsensusRecovery(
                diagnosis,
                siteData,
                operations,
            );
            if (consensus) {
                const operation = {
                    ...consensus.operation,
                    bestYear: consensus.centerYear,
                };
                const recovered = jointEventFromOperation(
                    operation,
                    null,
                    diagnosis,
                    consensus.referenceSummary.remoteCombinedMargin,
                    null,
                    config,
                );
                return [{
                    ...recovered,
                    evidence: {
                        ...recovered.evidence,
                        algorithmSources: Array.from(new Set([
                            ...recovered.evidence.algorithmSources,
                            "per_reference_counterfactual_evidence",
                            "reference_consensus_unit_recovery",
                            "decisive_joint_operation_fusion",
                        ])).sort(),
                        notes: [
                            ...recovered.evidence.notes,
                            "operation_fusion=reference_consensus_false_ring_recovery",
                            `reference_consensus_center_source=${consensus.centerSource}`,
                            `reference_consensus_center_year=${consensus.centerYear}`,
                            `reference_consensus_master_score=${consensus.masterScore.toFixed(6)}`,
                            `reference_consensus_count=${
                                consensus.referenceSummary.referenceCount
                            }`,
                            `reference_consensus_combined_gain=${
                                consensus.referenceSummary.bestCombinedGain.toFixed(6)
                            }`,
                            `reference_consensus_type_margin=${(
                                consensus.referenceSummary.bestCombinedGain
                                - consensus.oppositeReferenceSummary.bestCombinedGain
                            ).toFixed(6)}`,
                            `reference_consensus_positive_difference_fraction=${
                                consensus.referenceSummary
                                    .positiveDifferenceGainFraction.toFixed(6)
                            }`,
                            `reference_consensus_positive_whitened_fraction=${
                                consensus.referenceSummary
                                    .positiveWhitenedGainFraction.toFixed(6)
                            }`,
                            `reference_consensus_remote_margin=${
                                consensus.referenceSummary.remoteCombinedMargin.toFixed(6)
                            }`,
                        ],
                    },
                }];
            }
        }
        return recoverSubtleFalseRingEmptySuggestion(
            fused,
            diagnosis,
            operations,
            config,
        );
    }
    return fused;
};

const boundedWindow = (
    centerYear: number,
    width: number,
    minimumYear: number,
    maximumYear: number,
): { startYear: number; endYear: number } => {
    const safeWidth = Math.max(1, Math.min(width, maximumYear - minimumYear + 1));
    let startYear = centerYear - Math.floor((safeWidth - 1) / 2);
    startYear = Math.max(
        minimumYear,
        Math.min(startYear, maximumYear - safeWidth + 1),
    );
    return { startYear, endYear: startYear + safeWidth - 1 };
};

const windowsOverlap = (
    left: { startYear: number; endYear: number },
    right: { startYear: number; endYear: number },
): boolean => (
    Math.max(left.startYear, right.startYear)
    <= Math.min(left.endYear, right.endYear)
);

const rankedYears = (
    window: { startYear: number; endYear: number },
    rows: Array<{ year: number; score: number }>,
    algorithmSource: string,
): DiagnosisRankedYear[] => {
    const byYear = new Map(rows.map((row) => [row.year, row.score]));
    const minimumScore = rows.length > 0
        ? Math.min(...rows.map((row) => row.score))
        : 0;
    return Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return {
                year,
                rank: 0,
                score: byYear.get(year) ?? minimumScore - 1,
                evidenceTags: [algorithmSource],
            };
        },
    )
        .sort((left, right) => right.score - left.score || right.year - left.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
};

const cumulativeRows = (
    analysis: GainGatedRecoveryAnalysis,
    shiftYears: number,
    score: (
        row: GainGatedRecoveryAnalysis["cumulativeScores"][number],
    ) => number,
): Array<{ year: number; score: number }> => analysis.cumulativeScores
    .filter((row) => row.olderLag === shiftYears)
    .map((row) => ({
        year: shiftYears <= -2
            ? firstFixedYearFromLastMovedYear(row.year)
            : row.year,
        score: score(row),
    }))
    .sort((left, right) => right.score - left.score || right.year - left.year);

const piecewiseRows = (
    analysis: GainGatedRecoveryAnalysis,
    shiftYears: number,
    score: (
        row: GainGatedRecoveryAnalysis["piecewiseScores"][number],
    ) => number,
): Array<{ year: number; score: number }> => analysis.piecewiseScores
    .filter((row) => row.olderLag === shiftYears)
    .map((row) => ({
        year: shiftYears <= -2
            ? firstFixedYearFromLastMovedYear(row.year)
            : row.year,
        score: score(row),
    }))
    .sort((left, right) => right.score - left.score || right.year - left.year);

const locationSignals = (
    eventType: RecoverableEventType,
    shiftYears: number,
    analysis: GainGatedRecoveryAnalysis,
): LocationSignal[] => {
    if (eventType === "missingRing") {
        return [
            {
                algorithmSource: "cumulative_difference_location",
                rows: cumulativeRows(
                    analysis,
                    shiftYears,
                    (row) => row.differenceCumulative,
                ),
            },
            {
                algorithmSource: "piecewise_gain_location",
                rows: piecewiseRows(
                    analysis,
                    shiftYears,
                    (row) => row.combinedGain,
                ),
            },
        ];
    }
    if (eventType === "falseRing") {
        return [
            {
                algorithmSource: "reference_mean_location",
                rows: cumulativeRows(
                    analysis,
                    shiftYears,
                    (row) => row.referenceMeanCumulative,
                ),
            },
            {
                algorithmSource: "cumulative_whitened_location",
                rows: cumulativeRows(
                    analysis,
                    shiftYears,
                    (row) => row.whitenedCumulative,
                ),
            },
        ];
    }
    return [
        {
            algorithmSource: "piecewise_whitened_location",
            rows: piecewiseRows(
                analysis,
                shiftYears,
                (row) => row.whitenedObjective,
            ),
        },
        {
            algorithmSource: "piecewise_combined_location",
            rows: piecewiseRows(
                analysis,
                shiftYears,
                (row) => row.combinedObjective,
            ),
        },
    ];
};

export const buildDualSignalLocationChoices = (
    eventType: RecoverableEventType,
    shiftYears: number,
    analysis: GainGatedRecoveryAnalysis,
    diagnosis: SeriesCoreDiagnosis,
    occupied: Array<{ startYear: number; endYear: number }> = [],
    config: EventOperationRecoveryConfig =
    DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG,
): LocationChoice[] => {
    const width = eventType === "partialMove"
        ? config.partialWindowYears
        : config.unitWindowYears;
    const used = [...occupied];
    const signals = locationSignals(eventType, shiftYears, analysis);
    const choices = signals.flatMap((signal) => {
        const choices: LocationChoice[] = [];
        for (const selected of signal.rows) {
            if (choices.length >= Math.max(1, config.locationsPerSignal)) break;
            const window = boundedWindow(
                selected.year,
                width,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
            );
            if (used.some((other) => windowsOverlap(window, other))) continue;
            used.push(window);
            const remote = signal.rows.find((row) => {
                const candidate = boundedWindow(
                    row.year,
                    width,
                    diagnosis.targetRange.startYear,
                    diagnosis.targetRange.endYear,
                );
                return !windowsOverlap(candidate, window);
            });
            choices.push({
                ...window,
                rankedYears: rankedYears(window, signal.rows, signal.algorithmSource),
                evidenceScore: selected.score,
                scoreMargin: selected.score - (remote?.score ?? selected.score),
                algorithmSource: signal.algorithmSource,
                ...(eventType === "partialMove" ? {
                    shiftYears,
                    shiftSide: "older" as const,
                } : {}),
            });
        }
        return choices;
    });
    return choices.slice(0, Math.max(1, config.maximumSignalLocationChoices));
};

const verificationScore = (
    hypothesis: GainGatedRecoveryHypothesis,
): number => hypothesis.locationVerification?.[0]?.combinedGain
    ?? Number.NEGATIVE_INFINITY;

type RankedVerifiedHypothesis = {
    hypothesis: GainGatedRecoveryHypothesis;
    piecewiseRank: number;
};

export const partitionVerifiedRecoveryHypotheses = (
    hypotheses: GainGatedRecoveryHypothesis[],
    primaryDecisionHypothesisCount: number,
): {
    decisionPool: RankedVerifiedHypothesis[];
    supplementalPool: RankedVerifiedHypothesis[];
} => {
    const verified = hypotheses
        .map((hypothesis, piecewiseRank) => ({ hypothesis, piecewiseRank }))
        .filter(({ hypothesis }) => hypothesis.locationVerification?.length);
    const sortByVerification = (
        left: RankedVerifiedHypothesis,
        right: RankedVerifiedHypothesis,
    ): number => (
        verificationScore(right.hypothesis) - verificationScore(left.hypothesis)
        || right.hypothesis.combinedGain - left.hypothesis.combinedGain
    );
    const decisionLimit = Math.max(1, primaryDecisionHypothesisCount);
    return {
        decisionPool: verified
            .filter(({ piecewiseRank }) => piecewiseRank < decisionLimit)
            .sort(sortByVerification),
        supplementalPool: verified
            .filter(({ piecewiseRank }) => piecewiseRank >= decisionLimit)
            .sort(sortByVerification),
    };
};

const confidenceFor = (
    score: number,
    scoreMargin: number,
    alternative: boolean,
): DiagnosisEvent["confidenceLevel"] => {
    if (alternative) return "low";
    if (score >= 0.15 && scoreMargin >= 0.03) return "high";
    return "medium";
};

const counterfactualRankedYears = (
    ranked: DiagnosisRankedYear[],
    hypothesis: GainGatedRecoveryHypothesis,
    analysis: GainGatedRecoveryAnalysis,
    diagnosis: SeriesCoreDiagnosis,
): DiagnosisRankedYear[] => {
    if (hypothesis.eventType === "partialMove" || !analysis.verificationContext) {
        return ranked;
    }
    const verification = verifyGainGatedRecoveryYears(
        diagnosis,
        analysis.verificationContext,
        hypothesis.eventType,
        hypothesis.shiftYears,
        ranked.map((row) => row.year),
    );
    const scoreByYear = new Map(
        verification.map((row) => [row.year, row.combinedGain]),
    );
    return ranked
        .map((row) => ({
            ...row,
            score: scoreByYear.get(row.year) ?? row.score,
            evidenceTags: Array.from(new Set([
                ...row.evidenceTags,
                "counterfactual_year_ranking",
            ])),
        }))
        .sort((left, right) => right.score - left.score || right.year - left.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
};

const noteNumber = (event: DiagnosisEvent, prefix: string): number | null => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const value = Number(note?.slice(prefix.length));
    return Number.isFinite(value) ? value : null;
};

const noteWindow = (
    event: DiagnosisEvent,
    prefix: string,
): { startYear: number; endYear: number } | null => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const match = note?.slice(prefix.length).match(/^(-?\d+)-(-?\d+)$/);
    if (!match) return null;
    return { startYear: Number(match[1]), endYear: Number(match[2]) };
};

const sameWindow = (
    left: { startYear: number; endYear: number },
    right: { startYear: number; endYear: number },
): boolean => left.startYear === right.startYear && left.endYear === right.endYear;

const protectedLocationSource = (algorithmSource: string): boolean => (
    algorithmSource === "independent_edge_consensus_location"
    || algorithmSource === "bracketed_peak_bridge_location"
);

const compactLocationAlternatives = (
    primary: { startYear: number; endYear: number },
    alternatives: DiagnosisEventLocationAlternative[],
    maximumAlternatives: number,
): DiagnosisEventLocationAlternative[] => {
    const limit = Math.max(0, maximumAlternatives);
    if (limit === 0) return [];

    const selected = alternatives.slice(0, limit);
    for (const candidate of alternatives.slice(limit)) {
        if (!protectedLocationSource(candidate.algorithmSource)) continue;
        let replacement = -1;
        for (let index = selected.length - 1; index >= 0; index -= 1) {
            if (!protectedLocationSource(selected[index].algorithmSource)) {
                replacement = index;
                break;
            }
        }
        if (replacement >= 0) selected.splice(replacement, 1, candidate);
    }
    selected.sort((left, right) => left.rank - right.rank);

    const coveredYears = new Set<number>();
    for (let year = primary.startYear; year <= primary.endYear; year += 1) {
        coveredYears.add(year);
    }
    const compacted: DiagnosisEventLocationAlternative[] = [];
    for (const alternative of selected) {
        let addsVisibleYear = false;
        for (
            let year = alternative.startYear;
            year <= alternative.endYear;
            year += 1
        ) {
            if (!coveredYears.has(year)) addsVisibleYear = true;
        }
        if (!addsVisibleYear) continue;
        for (
            let year = alternative.startYear;
            year <= alternative.endYear;
            year += 1
        ) {
            coveredYears.add(year);
        }
        compacted.push({
            ...alternative,
            rank: compacted.length + 1,
        });
    }
    return compacted;
};

const outsideDistance = (
    window: { startYear: number; endYear: number },
    year: number,
): number => year < window.startYear
    ? window.startYear - year
    : year > window.endYear
        ? year - window.endYear
        : 0;

const outsideSide = (
    window: { startYear: number; endYear: number },
    year: number,
): -1 | 0 | 1 => year < window.startYear ? -1 : year > window.endYear ? 1 : 0;

type SupplementalLocation = {
    centerYear: number;
    algorithmSource: string;
    rows?: Array<{ year: number; score: number }>;
};

const contrastLocationSignal = (
    eventType: RecoverableEventType,
    shiftYears: number,
    analysis: GainGatedRecoveryAnalysis,
): LocationSignal => {
    if (eventType === "missingRing") {
        return {
            algorithmSource: "cumulative_whitened_contrast_location",
            rows: cumulativeRows(
                analysis,
                shiftYears,
                (row) => row.whitenedContrast,
            ),
        };
    }
    if (eventType === "falseRing") {
        return {
            algorithmSource: "reference_mean_contrast_location",
            rows: cumulativeRows(
                analysis,
                shiftYears,
                (row) => row.referenceMeanContrast,
            ),
        };
    }
    return {
        algorithmSource: "cumulative_difference_contrast_location",
        rows: cumulativeRows(
            analysis,
            shiftYears,
            (row) => row.differenceContrast,
        ),
    };
};

/**
 * Keep every review window narrow while covering three common boundary-uncertainty shapes:
 * a small gap between two peaks, two independent edge signals, or a one-sided edge guard.
 */
export const addTransitionLocationAlternatives = (
    event: DiagnosisEvent,
    hypothesis: GainGatedRecoveryHypothesis,
    analysis: GainGatedRecoveryAnalysis,
    diagnosis: SeriesCoreDiagnosis,
    config: EventOperationRecoveryConfig = DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG,
): DiagnosisEvent => {
    if (event.eventType === "wholeSeriesMove") return event;
    const width = event.eventType === "partialMove"
        ? config.partialWindowYears
        : config.unitWindowYears;
    const primary = { startYear: event.startYear, endYear: event.endYear };
    const existing = event.locationAlternatives ?? [];
    const windows = [
        { ...primary, rank: 0 },
        ...existing.map((location) => ({
            startYear: location.startYear,
            endYear: location.endYear,
            rank: location.rank,
        })),
    ];
    const proposals: SupplementalLocation[] = [];

    const scanYear = noteNumber(event, "scan_top_year=");
    const directYear = noteNumber(event, "direct_transition_year=");
    if (scanYear !== null && directYear !== null) {
        const scanSide = outsideSide(primary, scanYear);
        if (scanSide !== 0
            && scanSide === outsideSide(primary, directYear)
            && outsideDistance(primary, scanYear) <= 4
            && outsideDistance(primary, directYear) <= 4
            && Math.abs(scanYear - directYear) <= 4) {
            proposals.push({
                centerYear: Math.round((scanYear + directYear) / 2),
                algorithmSource: "independent_edge_consensus_location",
            });
        }
    }

    const ordered = [...windows].sort((left, right) => (
        left.startYear - right.startYear || left.endYear - right.endYear
    ));
    const bridge = ordered
        .slice(0, -1)
        .map((left, index) => {
            const right = ordered[index + 1];
            const gapStart = left.endYear + 1;
            const gapEnd = right.startYear - 1;
            return {
                gapStart,
                gapEnd,
                gapYears: gapEnd - gapStart + 1,
                touchesPrimary: (
                    sameWindow(left, primary)
                    || sameWindow(right, primary)
                ),
                adjacentRank: sameWindow(left, primary)
                    ? right.rank
                    : sameWindow(right, primary)
                        ? left.rank
                        : Number.POSITIVE_INFINITY,
            };
        })
        .filter((gap) => gap.gapYears >= 1 && gap.gapYears <= width)
        .sort((left, right) => (
            Number(right.touchesPrimary) - Number(left.touchesPrimary)
            || left.adjacentRank - right.adjacentRank
            || left.gapYears - right.gapYears
        ))[0] ?? null;
    if (bridge) {
        proposals.push({
            centerYear: Math.round((bridge.gapStart + bridge.gapEnd) / 2),
            algorithmSource: "bracketed_peak_bridge_location",
        });
    }

    if (proposals.length === 0
        && event.evidence.algorithmSources.includes("edge_rank_guard")) {
        const before = noteWindow(event, "window_before=");
        if (before) {
            const olderExpansion = before.startYear - primary.startYear;
            const newerExpansion = primary.endYear - before.endYear;
            const displacement = olderExpansion > 0 && newerExpansion === 0
                ? -Math.min(3, olderExpansion)
                : newerExpansion > 0 && olderExpansion === 0
                    ? Math.min(3, newerExpansion)
                    : 0;
            if (displacement !== 0) {
                const centerYear = displacement < 0
                    ? primary.startYear + displacement + Math.floor((width - 1) / 2)
                    : primary.endYear + displacement - Math.floor(width / 2);
                proposals.push({
                    centerYear,
                    algorithmSource: "continued_edge_guard_location",
                });
            }
        }
    }

    const contrastSignal = contrastLocationSignal(
        event.eventType,
        hypothesis.shiftYears,
        analysis,
    );
    const contrastPeak = contrastSignal.rows[0];
    if (contrastPeak) {
        proposals.push({
            centerYear: contrastPeak.year,
            algorithmSource: contrastSignal.algorithmSource,
            rows: contrastSignal.rows,
        });
    }

    const sourceRows = locationSignals(
        event.eventType,
        hypothesis.shiftYears,
        analysis,
    )[0]?.rows ?? [];
    const additions: DiagnosisEventLocationAlternative[] = [];
    for (const proposal of proposals) {
        const protectedBoundaryEvidence = protectedLocationSource(
            proposal.algorithmSource,
        );
        const locationLimit = config.maximumLocationAlternatives
            + (
                protectedBoundaryEvidence
                && existing.length >= config.maximumLocationAlternatives
                    ? 1
                    : 0
            );
        if (existing.length + additions.length >= locationLimit) continue;
        const window = boundedWindow(
            proposal.centerYear,
            width,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
        );
        if ([...windows, ...additions].some((candidate) => sameWindow(candidate, window))) {
            continue;
        }
        const candidateRanking = counterfactualRankedYears(
            rankedYears(
                window,
                proposal.rows ?? sourceRows,
                proposal.algorithmSource,
            ),
            hypothesis,
            analysis,
            diagnosis,
        );
        additions.push({
            rank: existing.length + additions.length + 1,
            ...window,
            rankedYears: candidateRanking,
            evidenceScore: candidateRanking[0]?.score ?? 0,
            scoreMargin: (candidateRanking[0]?.score ?? 0)
                - (candidateRanking[1]?.score ?? candidateRanking[0]?.score ?? 0),
            algorithmSource: proposal.algorithmSource,
            ...(event.eventType === "partialMove" ? {
                shiftYears: hypothesis.shiftYears,
                shiftSide: "older" as const,
            } : {}),
        });
    }
    if (additions.length === 0) return event;
    const locationAlternatives = compactLocationAlternatives(
        primary,
        [...existing, ...additions],
        config.maximumLocationAlternatives,
    );
    const unchanged = (
        locationAlternatives.length === existing.length
        && locationAlternatives.every((location, index) => (
            sameWindow(location, existing[index])
            && location.algorithmSource === existing[index].algorithmSource
        ))
    );
    if (unchanged) return event;
    return {
        ...event,
        ...(locationAlternatives.length > 0 ? { locationAlternatives } : {
            locationAlternatives: undefined,
        }),
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                ...locationAlternatives.map((location) => location.algorithmSource),
            ])).sort(),
            notes: [
                ...event.evidence.notes.filter((note) => (
                    !/^location_option_\d+=/.test(note)
                )),
                ...locationAlternatives.map((location) => (
                    `location_option_${location.rank}=${location.startYear}-${location.endYear}`
                )),
            ],
        },
    };
};

const missingConsensusFamilies = [
    ["nominal_boundary_year=", "profile_boundary_year="],
    ["scan_top_year="],
    ["raw_path_top_year="],
    ["candidate_top_year="],
    ["paired_breakpoint_year="],
    ["direct_transition_year="],
    ["unit_local_raw31_year=", "unit_window_raw31_year=", "unit_local_raw_boundary_year="],
    ["unit_local_difference31_year=", "unit_window_difference31_year="],
    ["unit_local_whitened31_year=", "unit_window_whitened31_year="],
    ["unit_local_combo31_year=", "unit_window_combo31_year="],
    ["unit_local_multiScale_year=", "unit_window_multiScale_year="],
    ["unit_local_pairMedian31_year=", "unit_window_pairMedian31_year="],
    ["unit_local_bestReference31_year=", "unit_window_bestReference31_year="],
    [
        "unit_local_pairedCore31_year=",
        "unit_window_pairedCore31_year=",
        "paired_core_selected_year=",
    ],
] as const;

const partialConsensusFamilies = [
    ["repeated_block_boundary_year="],
    ["profile_boundary_year="],
    ["nominal_boundary_year="],
    ["partial_reference_vote_year="],
    ["partial_exhaustive_vote_year="],
    ["partial_gap_raw31_year="],
    ["partial_gap_difference31_year="],
    ["partial_gap_whitened31_year="],
    ["partial_gap_combo31_year="],
    ["partial_gap_combo41_year="],
    ["partial_gap_combo61_year="],
    ["partial_gap_multiScale_year="],
] as const;

type YearConsensusPolicy = {
    families: readonly (readonly string[])[];
    minimumExactVotes: number;
    minimumExactLead: number;
    minimumNearLead: number;
    maximumDistance: number;
    maximumNormalizedMargin: number;
    maximumOriginalRank: number;
    algorithmSource: string;
};

const yearConsensusPolicy = (
    eventType: RecoverableEventType,
): YearConsensusPolicy => {
    if (eventType === "missingRing") {
        return {
            families: missingConsensusFamilies,
            minimumExactVotes: 4,
            minimumExactLead: 2,
            minimumNearLead: 0,
            maximumDistance: 1,
            maximumNormalizedMargin: 0.4,
            maximumOriginalRank: Number.POSITIVE_INFINITY,
            algorithmSource: "missing_year_anchor_consensus",
        };
    }
    if (eventType === "falseRing") {
        return {
            families: missingConsensusFamilies,
            minimumExactVotes: 4,
            minimumExactLead: 2,
            minimumNearLead: 1,
            maximumDistance: 3,
            maximumNormalizedMargin: 0.1,
            maximumOriginalRank: 2,
            algorithmSource: "false_year_anchor_consensus",
        };
    }
    return {
        families: partialConsensusFamilies,
        minimumExactVotes: 2,
        minimumExactLead: 1,
        minimumNearLead: 1,
        maximumDistance: 4,
        maximumNormalizedMargin: 0.2,
        maximumOriginalRank: 2,
        algorithmSource: "partial_year_anchor_consensus",
    };
};

const compactFamilyYear = (
    event: DiagnosisEvent,
    prefixes: readonly string[],
): number | null => prefixes.reduce<number | null>((selected, prefix) => (
    noteNumber(event, prefix) ?? selected
), null);

const consensusRankedYears = (
    event: DiagnosisEvent,
    rows: DiagnosisRankedYear[],
    policy: YearConsensusPolicy,
): { rows: DiagnosisRankedYear[]; selectedYear: number | null; previousYear: number | null } => {
    const ordered = [...rows].sort((left, right) => left.rank - right.rank);
    const current = ordered[0];
    if (!current || ordered.length < 2) {
        return { rows: ordered, selectedYear: null, previousYear: null };
    }
    const minimumYear = Math.min(...ordered.map((row) => row.year));
    const maximumYear = Math.max(...ordered.map((row) => row.year));
    const votes = policy.families
        .map((prefixes) => compactFamilyYear(event, prefixes))
        .filter((year): year is number => (
            year !== null && year >= minimumYear && year <= maximumYear
        ));
    const support = ordered.map((row) => ({
        row,
        exact: votes.filter((year) => year === row.year).length,
        near: votes.filter((year) => Math.abs(year - row.year) <= 1).length,
    })).sort((left, right) => (
        right.exact - left.exact
        || right.near - left.near
        || Math.abs(left.row.year - current.year) - Math.abs(right.row.year - current.year)
        || right.row.year - left.row.year
    ));
    const selected = support[0];
    const currentSupport = support.find((candidate) => candidate.row.year === current.year);
    const scores = ordered.map((row) => row.score).filter(Number.isFinite);
    const scale = scores.length > 0 ? Math.max(...scores) - Math.min(...scores) : 0;
    const normalizedMargin = scale > 1e-12
        ? (current.score - ordered[1].score) / scale
        : 0;
    const shouldSwitch = selected.row.year !== current.year
        && selected.exact >= policy.minimumExactVotes
        && selected.exact - (currentSupport?.exact ?? 0) >= policy.minimumExactLead
        && selected.near - (currentSupport?.near ?? 0) >= policy.minimumNearLead
        && Math.abs(selected.row.year - current.year) <= policy.maximumDistance
        && selected.row.rank <= policy.maximumOriginalRank
        && normalizedMargin <= policy.maximumNormalizedMargin;
    if (!shouldSwitch) {
        return { rows: ordered, selectedYear: null, previousYear: null };
    }
    return {
        rows: [
            {
                ...selected.row,
                evidenceTags: Array.from(new Set([
                    ...selected.row.evidenceTags,
                    policy.algorithmSource,
                ])).sort(),
            },
            ...ordered.filter((row) => row.year !== selected.row.year),
        ].map((row, index) => ({ ...row, rank: index + 1 })),
        selectedYear: selected.row.year,
        previousYear: current.year,
    };
};

/** Reorders only weak Top1 years when several independent evidence families agree. */
export const rerankEventYearsByAnchorConsensus = (
    event: DiagnosisEvent,
): DiagnosisEvent => {
    const operationAlternatives = event.operationAlternatives?.map(
        rerankEventYearsByAnchorConsensus,
    );
    if (event.eventType === "wholeSeriesMove") {
        return operationAlternatives
            ? { ...event, operationAlternatives }
            : event;
    }
    const policy = yearConsensusPolicy(event.eventType);
    const primary = consensusRankedYears(event, event.rankedYears, policy);
    let changed = primary.selectedYear !== null;
    const locationAlternatives = event.locationAlternatives?.map((location) => {
        const result = consensusRankedYears(event, location.rankedYears, policy);
        changed ||= result.selectedYear !== null;
        return { ...location, rankedYears: result.rows };
    });
    if (!changed && !operationAlternatives) return event;
    const selectionNotes = primary.selectedYear !== null ? [
        `year_ranking=${policy.algorithmSource}`,
        `${event.eventType}_consensus_selected_year=${primary.selectedYear}`,
        `${event.eventType}_consensus_previous_top_year=${primary.previousYear}`,
    ] : [];
    return {
        ...event,
        rankedYears: primary.rows,
        ...(locationAlternatives ? { locationAlternatives } : {}),
        ...(operationAlternatives ? { operationAlternatives } : {}),
        ...(changed ? {
            evidence: {
                ...event.evidence,
                algorithmSources: Array.from(new Set([
                    ...event.evidence.algorithmSources,
                    policy.algorithmSource,
                ])).sort(),
                notes: [...event.evidence.notes, ...selectionNotes],
            },
        } : {}),
    };
};

export const rerankMissingRingByAnchorConsensus =
rerankEventYearsByAnchorConsensus;

const eventFromHypothesis = (
    hypothesis: GainGatedRecoveryHypothesis,
    matchingEvent: DiagnosisEvent | null,
    analysis: GainGatedRecoveryAnalysis,
    diagnosis: SeriesCoreDiagnosis,
    scoreMargin: number,
    alternative: boolean,
    config: EventOperationRecoveryConfig,
): DiagnosisEvent | null => {
    const occupied = matchingEvent
        ? [{
            startYear: matchingEvent.startYear,
            endYear: matchingEvent.endYear,
        }]
        : [];
    const choices = matchingEvent && config.outputSingleMainWindow
        ? []
        : buildDualSignalLocationChoices(
            hypothesis.eventType,
            hypothesis.shiftYears,
            analysis,
            diagnosis,
            occupied,
            config.outputSingleMainWindow
                ? {
                    ...config,
                    locationsPerSignal: 1,
                    maximumSignalLocationChoices: 1,
                    maximumLocationAlternatives: 0,
                }
                : config,
        );
    const primaryChoice = matchingEvent ? null : choices.shift() ?? null;
    if (!matchingEvent && !primaryChoice) return null;
    const startYear = matchingEvent?.startYear ?? primaryChoice?.startYear;
    const endYear = matchingEvent?.endYear ?? primaryChoice?.endYear;
    const rawEventRankedYears = matchingEvent?.rankedYears
        ?? primaryChoice?.rankedYears;
    if (startYear === undefined || endYear === undefined || !rawEventRankedYears) {
        return null;
    }
    const eventRankedYears = counterfactualRankedYears(
        rawEventRankedYears,
        hypothesis,
        analysis,
        diagnosis,
    );

    const verification = hypothesis.locationVerification?.[0] ?? null;
    const score = verificationScore(hypothesis);
    const baselineCorrelation = matchingEvent?.evidence.baselineCorrelation ?? null;
    const correctedCorrelation = baselineCorrelation !== null && verification
        ? baselineCorrelation + verification.rawGain
        : matchingEvent?.evidence.correctedCorrelation ?? null;
    const locationAlternatives = config.outputSingleMainWindow
        ? []
        : choices.map((
            choice,
            index,
        ): DiagnosisEventLocationAlternative => ({
            rank: index + 1,
            ...choice,
            rankedYears: counterfactualRankedYears(
                choice.rankedYears,
                hypothesis,
                analysis,
                diagnosis,
            ),
        }));
    const algorithmSources = Array.from(new Set([
        ...(matchingEvent?.evidence.algorithmSources ?? []),
        "gain_gated_event_recovery",
        "counterfactual_operation_verification",
        ...(hypothesis.eventType === "partialMove"
            ? []
            : ["counterfactual_year_ranking"]),
        ...(primaryChoice ? [primaryChoice.algorithmSource] : []),
    ])).sort();
    const recoveredEvent: DiagnosisEvent = {
        id: [
            diagnosis.targetTree,
            "gain-recovery",
            hypothesis.eventType,
            hypothesis.shiftYears,
            startYear,
            endYear,
        ].join("-"),
        seriesId: diagnosis.targetTree,
        eventType: hypothesis.eventType,
        startYear,
        endYear,
        rankedYears: eventRankedYears,
        confidenceLevel: confidenceFor(score, scoreMargin, alternative),
        evidence: {
            algorithmSources,
            score,
            scoreMargin,
            baselineCorrelation,
            correctedCorrelation,
            correlationGain: Number.isFinite(score) ? score : null,
            lagBefore: hypothesis.shiftYears,
            lagAfter: 0,
            samplePairs: matchingEvent?.evidence.samplePairs
                ?? diagnosis.rawTarget.size,
            candidateIds: matchingEvent?.evidence.candidateIds ?? [],
            notes: Array.from(new Set([
                ...(matchingEvent?.evidence.notes ?? []),
                "operation_recovery=counterfactual_top2",
                `operation_verification_gain=${score.toFixed(6)}`,
                `operation_piecewise_gain=${hypothesis.combinedGain.toFixed(6)}`,
                ...locationAlternatives.map((choice) => (
                    `location_option_${choice.rank}=${choice.startYear}-${choice.endYear}`
                )),
            ])),
        },
        alternativeTypes: matchingEvent?.alternativeTypes ?? [],
        ...(locationAlternatives.length > 0 ? { locationAlternatives } : {}),
        ...(hypothesis.eventType === "partialMove" ? {
            shiftYears: hypothesis.shiftYears,
            shiftSide: "older" as const,
        } : {}),
    };
    return config.outputSingleMainWindow
        ? recoveredEvent
        : addTransitionLocationAlternatives(
            recoveredEvent,
            hypothesis,
            analysis,
            diagnosis,
            config,
        );
};

export const addDualSignalLocationChoices = (
    event: DiagnosisEvent,
    analysis: GainGatedRecoveryAnalysis,
    diagnosis: SeriesCoreDiagnosis,
    config: EventOperationRecoveryConfig =
    DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG,
): DiagnosisEvent => {
    if (event.eventType === "wholeSeriesMove") return event;
    const shiftYears = eventShiftYears(event);
    if (shiftYears === null) return event;
    const existing = event.locationAlternatives ?? [];
    const occupied = [
        { startYear: event.startYear, endYear: event.endYear },
        ...existing.map((choice) => ({
            startYear: choice.startYear,
            endYear: choice.endYear,
        })),
    ];
    const available = Math.max(
        0,
        config.maximumLocationAlternatives - existing.length,
    );
    const additions = buildDualSignalLocationChoices(
        event.eventType,
        shiftYears,
        analysis,
        diagnosis,
        occupied,
        config,
    )
        .slice(0, available)
        .map((choice, index): DiagnosisEventLocationAlternative => ({
            ...choice,
            rank: existing.length + index + 1,
        }));
    if (additions.length === 0) return event;
    return {
        ...event,
        locationAlternatives: [...existing, ...additions],
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "dual_signal_location_recovery",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                ...additions.map((choice) => (
                    `location_option_${choice.rank}=${choice.startYear}-${choice.endYear}`
                )),
            ],
        },
    };
};

export const recoverSingleEventOperationSuggestions = (
    events: DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis | null,
    siteData: RwlSiteData,
    overrides: Partial<EventOperationRecoveryConfig> = {},
): DiagnosisEvent[] => {
    const wholeEvents = events.filter((event) => event.eventType === "wholeSeriesMove");
    const localEvents = events.filter((event) => event.eventType !== "wholeSeriesMove");
    const config = {
        ...DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG,
        ...overrides,
    };
    const eventCenter = (event: DiagnosisEvent): number => (
        event.rankedYears.slice().sort((left, right) => left.rank - right.rank)[0]?.year
        ?? (event.startYear + event.endYear) / 2
    );
    const orderedLocalEvents = localEvents.slice().sort((left, right) => (
        eventCenter(left) - eventCenter(right)
        || left.startYear - right.startYear
    ));
    const transitions = orderedLocalEvents.map((event) => (
        (event.evidence.lagBefore ?? 0) - (event.evidence.lagAfter ?? 0)
    ));
    const spatiallySeparated = orderedLocalEvents.slice(1).every(
        (event, index) => orderedLocalEvents[index].endYear < event.startYear,
    );
    const hasOppositeTransitions = transitions.some((value) => value < 0)
        && transitions.some((value) => value > 0);
    const coherentLocalChain = orderedLocalEvents.length > 1
        && orderedLocalEvents.every((event) => (
            event.evidence.lagBefore !== null
            && event.evidence.lagAfter !== null
            && event.evidence.lagBefore !== event.evidence.lagAfter
        ))
        && orderedLocalEvents.slice(1).every((event, index) => (
            orderedLocalEvents[index].evidence.lagAfter
                === event.evidence.lagBefore
        ))
        && (spatiallySeparated || hasOppositeTransitions);
    const preserveJointEvents = coherentLocalChain
        || (wholeEvents.length > 0 && localEvents.length === 1);
    const hasMultipleKinds = localEvents.length > 1
        || (wholeEvents.length > 0 && localEvents.length > 0);
    if (config.outputSingleMainWindow) {
        if (preserveJointEvents) return events;
        const strongestExisting = localEvents.slice().sort((left, right) => (
            right.evidence.score - left.evidence.score
            || right.evidence.scoreMargin - left.evidence.scoreMargin
            || right.evidence.samplePairs - left.evidence.samplePairs
            || right.endYear - left.endYear
        ))[0] ?? null;
        const preserveExisting = (): DiagnosisEvent[] => [
            ...wholeEvents,
            ...localEvents.map((event) => ({
                ...event,
                evidence: {
                    ...event.evidence,
                    notes: Array.from(new Set([
                        ...event.evidence.notes,
                        "operation_recovery=upstream_operation_preserved",
                    ])),
                },
            })),
        ];
        const operations = getJointCounterfactualOperationScores(
            diagnosis,
            15,
            config.maxPartialGapYears,
        );
        const rankedOperations = operations.slice().sort((left, right) => (
            right.topThreeDifferenceGain - left.topThreeDifferenceGain
            || right.bestDifferenceGain - left.bestDifferenceGain
            || right.remoteDifferenceMargin - left.remoteDifferenceMargin
        ));
        const selected = rankedOperations[0];
        const calibratedSelection = selectJointCounterfactualOperation(operations);
        const selectedOperation = calibratedSelection?.operation ?? selected;
        if (!selectedOperation) return preserveExisting();
        const matchingExisting = localEvents.some((event) => (
            event.eventType === selectedOperation.eventType
            && eventShiftYears(event) === selectedOperation.shiftYears
        ));
        if (matchingExisting) return preserveExisting();
        const presence = scoreJointOperationPresence(
            operations,
            selectedOperation,
        );
        const operationIsPresent = presence
            ? presence.present
            : selectedOperation.topThreeDifferenceGain
                >= config.jointCounterfactualMinimumGain;
        if (!operationIsPresent) return preserveExisting();

        const selectorProbability = calibratedSelection?.probability ?? 0;
        const selectorMargin = calibratedSelection?.probabilityMargin ?? 0;
        const mayOverrideExisting = strongestExisting !== null
            && selectorProbability >= 0.995
            && selectorMargin >= 0.99
            && selectedOperation.topThreeDifferenceGain >= 0.62
            && selectedOperation.remoteDifferenceMargin >= 0.04;
        const mayRecoverEmpty = strongestExisting === null
            && selectorProbability >= 0.95
            && selectorMargin >= 0.9
            && selectedOperation.topThreeDifferenceGain >= 0.4
            && selectedOperation.remoteDifferenceMargin >= 0.025;
        if (!mayOverrideExisting && !mayRecoverEmpty) {
            return preserveExisting();
        }

        const scoreMargin = calibratedSelection?.probabilityMargin
            ?? (
                selectedOperation.topThreeDifferenceGain
                - (
                    rankedOperations.find(
                        (operation) => operation !== selectedOperation,
                    )?.topThreeDifferenceGain
                    ?? selectedOperation.topThreeDifferenceGain
                )
            );
        const matchingEvent = localEvents.find((event) => (
            event.eventType === selectedOperation.eventType
            && eventShiftYears(event) === selectedOperation.shiftYears
        )) ?? null;
        const recovered = jointEventFromOperation(
            selectedOperation,
            matchingEvent,
            diagnosis,
            scoreMargin,
            calibratedSelection?.probability ?? null,
            config,
        );
        return [
            ...wholeEvents,
            ...localEvents.filter(
                (event) => event.eventType !== selectedOperation.eventType,
            ),
            {
                ...recovered,
                evidence: {
                    ...recovered.evidence,
                    algorithmSources: Array.from(new Set([
                        ...recovered.evidence.algorithmSources,
                        "joint_operation_presence_calibration",
                    ])).sort(),
                    notes: [
                        ...recovered.evidence.notes,
                        strongestExisting
                            ? "operation_recovery=decisive_joint_override"
                            : "operation_recovery=decisive_empty_recovery",
                        ...(presence ? [
                            `joint_operation_presence_probability=${
                                presence.probability.toFixed(6)
                            }`,
                            `joint_operation_presence_threshold=${
                                presence.threshold.toFixed(6)
                            }`,
                        ] : []),
                    ],
                },
            },
        ];
    }
    if (hasMultipleKinds) {
        const locationAnalysis = analyzeGainGatedRecovery(
            diagnosis,
            cofechaDiagnosis,
            siteData,
            {
                verifyLocationCorrections: false,
                minSideYears: config.minimumSideYears,
                maxPartialGapYears: config.maxPartialGapYears,
            },
        );
        return events.map((event) => addDualSignalLocationChoices(
            event,
            locationAnalysis,
            diagnosis,
            config,
        ));
    }
    const analysis = analyzeGainGatedRecovery(
        diagnosis,
        cofechaDiagnosis,
        siteData,
        {
            verifyLocationCorrections: true,
            verificationHypothesisCount: config.outputSingleMainWindow
                ? Math.min(
                    config.verificationHypothesisCount,
                    config.primaryDecisionHypothesisCount,
                )
                : config.verificationHypothesisCount,
            fullVerificationHypothesisCount: config.primaryDecisionHypothesisCount,
            verificationLocationCount: config.verificationLocationCount,
            supplementalVerificationLocationCount:
                config.outputSingleMainWindow
                    ? 0
                    : config.supplementalVerificationLocationCount,
            minSideYears: config.minimumSideYears,
            maxPartialGapYears: config.maxPartialGapYears,
        },
    );
    const {
        decisionPool,
        supplementalPool,
    } = partitionVerifiedRecoveryHypotheses(
        analysis.hypotheses,
        config.primaryDecisionHypothesisCount,
    );
    const primaryHypothesis = decisionPool[0]?.hypothesis;
    if (!primaryHypothesis) return events;
    const primaryScore = verificationScore(primaryHypothesis);
    const secondaryHypothesis = decisionPool[1]?.hypothesis ?? null;
    const scoreMargin = primaryScore
        - (secondaryHypothesis ? verificationScore(secondaryHypothesis) : primaryScore);
    const hasExistingSignal = localEvents.length > 0 || wholeEvents.length > 0;
    const passesPresenceGate = hasExistingSignal
        ? primaryScore >= config.existingEventMinimumGain
        : primaryScore >= config.emptyEventMinimumGain
            || (
                primaryScore >= config.emptyEventFallbackMinimumGain
                && scoreMargin >= config.emptyEventFallbackMinimumMargin
            );
    if (!passesPresenceGate) return wholeEvents.length > 0 ? events : [];

    const primary = eventFromHypothesis(
        primaryHypothesis,
        localEvents.find((event) => sameOperation(event, primaryHypothesis)) ?? null,
        analysis,
        diagnosis,
        scoreMargin,
        false,
        config,
    );
    if (!primary) return events;

    const operationAlternatives = config.outputSingleMainWindow
        ? []
        : [
            ...decisionPool.slice(1),
            ...supplementalPool,
        ]
            .slice(0, Math.max(0, config.maximumOperationAlternatives))
        .flatMap((hypothesis) => {
            const alternative = eventFromHypothesis(
                hypothesis.hypothesis,
                localEvents.find((event) => sameOperation(event, hypothesis.hypothesis))
                    ?? null,
                analysis,
                diagnosis,
                scoreMargin,
                true,
                config,
            );
            return alternative ? [alternative] : [];
        });
    const alternativeTypes = Array.from(new Set([
        ...primary.alternativeTypes,
        ...operationAlternatives
            .filter((alternative) => alternative.eventType !== primary.eventType)
            .map((alternative) => alternative.eventType),
    ]));
    return [
        ...wholeEvents,
        {
            ...primary,
            alternativeTypes,
            ...(operationAlternatives.length > 0 ? { operationAlternatives } : {}),
        },
    ];
};
