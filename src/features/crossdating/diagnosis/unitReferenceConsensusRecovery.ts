/**
 * Selective false-ring recovery for an otherwise empty diagnosis.
 *
 * The master chronology is used as a cheap pre-filter. A suggestion is exposed only when
 * several independently weighted reference cores agree that deleting one year improves both
 * differenced and pre-whitened agreement. This selector never considers partial moves.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import type { JointCounterfactualOperationScore } from "./jointCounterfactualOperation";
import {
    scorePerReferenceCounterfactualEvidence,
    summarizePerReferenceCounterfactualRows,
    type PerReferenceCounterfactualSummary,
} from "./perReferenceCounterfactualEvidence";
import { scoreDynamicJointOperation } from "./jointOperationSelector";
import type { SeriesCoreDiagnosis } from "./types";

const MINIMUM_MASTER_SCORE = 0.045;
const MINIMUM_MASTER_DIFFERENCE_GAIN = 0.05;
const MINIMUM_REFERENCE_COUNT = 6;
const MINIMUM_REFERENCE_COMBINED_GAIN = 0.02;
const MINIMUM_REFERENCE_TYPE_MARGIN = 0.02;
const MINIMUM_POSITIVE_DIFFERENCE_FRACTION = 0.58;
const MINIMUM_POSITIVE_WHITENED_FRACTION = 0.5;
const MINIMUM_REFERENCE_REMOTE_MARGIN = 0.0045;

export type UnitReferenceConsensusRecovery = {
    operation: JointCounterfactualOperationScore;
    centerYear: number;
    centerSource: "master_operation" | "per_reference_consensus";
    masterScore: number;
    referenceSummary: PerReferenceCounterfactualSummary;
    oppositeReferenceSummary: PerReferenceCounterfactualSummary;
};

const operationFor = (
    operations: readonly JointCounterfactualOperationScore[],
    eventType: "missingRing" | "falseRing",
): JointCounterfactualOperationScore | null => operations.find((operation) => (
    operation.eventType === eventType
    && operation.shiftYears === (eventType === "missingRing" ? -1 : 1)
)) ?? null;

export const shouldScoreFalseRingReferenceConsensus = (
    operations: readonly JointCounterfactualOperationScore[],
): boolean => {
    const operation = operationFor(operations, "falseRing");
    return operation !== null
        && scoreDynamicJointOperation(operation, operations)
            >= MINIMUM_MASTER_SCORE
        && operation.bestDifferenceGain >= MINIMUM_MASTER_DIFFERENCE_GAIN;
};

/**
 * Pure calibrated gate, exported separately so the clean-control behavior is regression tested.
 */
export const selectFalseRingReferenceConsensusRecovery = (
    operations: readonly JointCounterfactualOperationScore[],
    referenceSummary: PerReferenceCounterfactualSummary | null,
    oppositeReferenceSummary: PerReferenceCounterfactualSummary | null,
): UnitReferenceConsensusRecovery | null => {
    const operation = operationFor(operations, "falseRing");
    if (
        !operation
        || !referenceSummary
        || !oppositeReferenceSummary
        || !shouldScoreFalseRingReferenceConsensus(operations)
        || referenceSummary.referenceCount < MINIMUM_REFERENCE_COUNT
        || referenceSummary.bestCombinedGain
            < MINIMUM_REFERENCE_COMBINED_GAIN
        || referenceSummary.bestCombinedGain
            - oppositeReferenceSummary.bestCombinedGain
                < MINIMUM_REFERENCE_TYPE_MARGIN
        || referenceSummary.positiveDifferenceGainFraction
            < MINIMUM_POSITIVE_DIFFERENCE_FRACTION
        || referenceSummary.positiveWhitenedGainFraction
            < MINIMUM_POSITIVE_WHITENED_FRACTION
        || referenceSummary.remoteCombinedMargin
            < MINIMUM_REFERENCE_REMOTE_MARGIN
    ) return null;

    const masterPeakIsReliable = (
        Math.abs(operation.bestYear - operation.sideStepBestYear) <= 4
        && operation.bestCorrectedSideSupport >= 0.25
        && operation.remoteDifferenceMargin >= 0.02
    );
    const peaksAgree = Math.abs(
        operation.bestYear - referenceSummary.bestYear,
    ) <= 6;
    const centerSource = peaksAgree || masterPeakIsReliable
        ? "master_operation" as const
        : "per_reference_consensus" as const;

    return {
        operation,
        centerYear: centerSource === "master_operation"
            ? operation.bestYear
            : referenceSummary.bestYear,
        centerSource,
        masterScore: scoreDynamicJointOperation(operation, operations),
        referenceSummary,
        oppositeReferenceSummary,
    };
};

export const scoreFalseRingReferenceConsensusRecovery = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    operations: readonly JointCounterfactualOperationScore[],
): UnitReferenceConsensusRecovery | null => {
    if (!shouldScoreFalseRingReferenceConsensus(operations)) return null;
    const falseOperation = operationFor(operations, "falseRing");
    const missingOperation = operationFor(operations, "missingRing");
    if (!falseOperation || !missingOperation) return null;
    const options = {
        edgeYears: 15,
        maximumReferences: 12,
    };
    const referenceSummary = summarizePerReferenceCounterfactualRows(
        scorePerReferenceCounterfactualEvidence(
            diagnosis,
            siteData,
            falseOperation.shiftYears,
            {
                ...options,
                baselineLagCenter: falseOperation.baselineLag,
            },
        ),
    );
    const oppositeReferenceSummary = summarizePerReferenceCounterfactualRows(
        scorePerReferenceCounterfactualEvidence(
            diagnosis,
            siteData,
            missingOperation.shiftYears,
            {
                ...options,
                baselineLagCenter: missingOperation.baselineLag,
            },
        ),
    );
    return selectFalseRingReferenceConsensusRecovery(
        operations,
        referenceSummary,
        oppositeReferenceSummary,
    );
};
