/**
 * Recover an executable whole-series baseline from the newer fixed side of a coherent local
 * lag path. All edits in this module are in-memory counterfactuals; caller data is never mutated.
 */
import {
    deleteYearWithMode,
    insertMissingYearAtSide,
    moveSeriesTailByOffset,
} from "@/features/rwl/edit";
import type { RwlSiteData } from "@/features/rwl/types";
import { evaluateDraft } from "./evaluation";
import { isExactPartialLagTransition } from "./partialMoveSemantics";
import { diagnoseSeriesCore } from "./segments";
import type {
    CandidateDraft,
    DiagnosisCandidateOperation,
    DiagnosisEvent,
    EffectiveDiagnosisConfig,
    SeriesCoreDiagnosis,
} from "./types";

const pathTransitionMatchesOperation = (event: DiagnosisEvent): boolean => {
    const lagBefore = event.evidence.lagBefore;
    const lagAfter = event.evidence.lagAfter;
    if (!Number.isInteger(lagBefore) || !Number.isInteger(lagAfter)) return false;
    if (event.eventType === "missingRing") return lagAfter! - lagBefore! === 1;
    if (event.eventType === "falseRing") return lagBefore! - lagAfter! === 1;
    return event.eventType === "partialMove"
        && isExactPartialLagTransition(event.shiftYears, lagBefore, lagAfter);
};

const topRankedEventYear = (event: DiagnosisEvent): number => (
    event.rankedYears
        .slice()
        .sort((left, right) => left.rank - right.rank)[0]?.year
    ?? Math.round((event.startYear + event.endYear) / 2)
);

const coherentPathSuffixFromFixedLag = (
    pathEvents: readonly DiagnosisEvent[],
    fixedSideLag: number,
): DiagnosisEvent[] => {
    const ordered = pathEvents
        .filter((event) => (
            event.eventType !== "wholeSeriesMove"
            && event.evidence.algorithmSources.includes("piecewise_lag_path")
            && pathTransitionMatchesOperation(event)
        ))
        .sort((left, right) => (
            topRankedEventYear(right) - topRankedEventYear(left)
            || right.evidence.score - left.evidence.score
        ));
    const chain: DiagnosisEvent[] = [];
    let currentState = fixedSideLag;
    for (const event of ordered) {
        if (event.evidence.lagAfter !== currentState) {
            if (chain.length > 0) break;
            continue;
        }
        chain.push(event);
        currentState = event.evidence.lagBefore!;
    }
    return chain;
};

type PathFixedSideCompositionEvidence = {
    passed: boolean;
    eventCount: number;
    afterBestGlobalLag: number;
    wholeSeriesRDelta: number;
    meanSegmentRDelta: number;
    problemReduction: number;
};

const meanUsableSegmentCorrelation = (diagnosis: SeriesCoreDiagnosis): number => {
    const values = diagnosis.segments
        .map((segment) => segment.r0)
        .filter((value): value is number => value !== null);
    return values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : -1;
};

const evaluatePathFixedSideComposition = (
    siteData: RwlSiteData,
    diagnosis: SeriesCoreDiagnosis,
    pathEvents: readonly DiagnosisEvent[],
    fixedSideLag: number,
    effectiveConfig: EffectiveDiagnosisConfig,
): PathFixedSideCompositionEvidence | null => {
    const originalTree = siteData.get(diagnosis.targetTree);
    if (!originalTree) return null;
    const chain = coherentPathSuffixFromFixedLag(pathEvents, fixedSideLag);
    if (chain.length === 0) return null;

    let workingTree = new Map(originalTree);
    let olderCoordinateOffset = 0;
    const generousOlderBound = diagnosis.targetRange.startYear
        - effectiveConfig.maxPartialGapYears
        - chain.length
        - Math.abs(fixedSideLag);
    chain.forEach((event) => {
        const adjustedYear = topRankedEventYear(event) + olderCoordinateOffset;
        const correctionYears = event.evidence.lagBefore! - event.evidence.lagAfter!;
        if (event.eventType === "missingRing") {
            workingTree = insertMissingYearAtSide(workingTree, adjustedYear, "right");
        } else if (event.eventType === "falseRing") {
            workingTree = deleteYearWithMode(workingTree, adjustedYear, "direct", "right");
        } else if (event.eventType === "partialMove") {
            workingTree = moveSeriesTailByOffset(
                workingTree,
                generousOlderBound,
                adjustedYear - 1,
                correctionYears,
            );
        }
        olderCoordinateOffset += correctionYears;
    });
    workingTree = moveSeriesTailByOffset(
        workingTree,
        generousOlderBound - effectiveConfig.maxPartialGapYears,
        diagnosis.targetRange.endYear + effectiveConfig.maxPartialGapYears,
        fixedSideLag,
    );
    const correctedSite = new Map(siteData);
    correctedSite.set(diagnosis.targetTree, workingTree);
    const after = diagnoseSeriesCore(
        correctedSite,
        diagnosis.targetTree,
        effectiveConfig,
    );
    if (!after) return null;

    const wholeSeriesRDelta = (after.globalSlidingMatch.currentR ?? -1)
        - (diagnosis.globalSlidingMatch.currentR ?? -1);
    const meanSegmentRDelta = meanUsableSegmentCorrelation(after)
        - meanUsableSegmentCorrelation(diagnosis);
    const problemReduction = diagnosis.unresolvedA + diagnosis.unresolvedB
        - after.unresolvedA - after.unresolvedB;
    return {
        passed: after.globalSlidingMatch.bestGlobalLag === 0
            && problemReduction >= 0
            && (
                wholeSeriesRDelta >= 0.02
                || meanSegmentRDelta >= 0.02
                || problemReduction >= 1
            ),
        eventCount: chain.length,
        afterBestGlobalLag: after.globalSlidingMatch.bestGlobalLag,
        wholeSeriesRDelta,
        meanSegmentRDelta,
        problemReduction,
    };
};

/** Return a hypothesis only; it must still pass ordinary or joint counterfactual evaluation. */
export const makePathFixedSideWholeDraft = (
    diagnosis: SeriesCoreDiagnosis,
    pathEvents: readonly DiagnosisEvent[],
    effectiveConfig: EffectiveDiagnosisConfig,
    minimumNewerContextYears = 18,
): CandidateDraft | null => {
    const eligible = pathEvents
        .filter((event) => (
            event.eventType !== "wholeSeriesMove"
            && event.evidence.algorithmSources.includes("piecewise_lag_path")
            && pathTransitionMatchesOperation(event)
            && event.evidence.score >= 1
            && event.evidence.samplePairs >= effectiveConfig.minPairsForCorrelation
            && Number.isInteger(event.evidence.lagAfter)
            && event.evidence.lagAfter !== 0
            && event.evidence.lagAfter! >= effectiveConfig.globalLagMin
            && event.evidence.lagAfter! <= effectiveConfig.globalLagMax
            && diagnosis.targetRange.endYear - topRankedEventYear(event)
                >= minimumNewerContextYears
        ))
        .sort((left, right) => (
            topRankedEventYear(right) - topRankedEventYear(left)
            || right.evidence.score - left.evidence.score
        ));
    const transition = eligible[0];
    if (!transition) return null;

    const fixedSideLag = transition.evidence.lagAfter!;
    const boundaryYear = topRankedEventYear(transition);
    const sourceSegment = diagnosis.segments
        .slice()
        .sort((left, right) => (
            Number(right.bestLag === fixedSideLag) - Number(left.bestLag === fixedSideLag)
            || Number(right.startYear > boundaryYear) - Number(left.startYear > boundaryYear)
            || Math.abs((left.startYear + left.endYear) / 2 - boundaryYear)
                - Math.abs((right.startYear + right.endYear) / 2 - boundaryYear)
            || right.samplePairs - left.samplePairs
        ))[0];
    if (!sourceSegment) return null;

    return {
        targetTree: diagnosis.targetTree,
        operationType: "SHIFT_RANGE",
        candidateType: "batchMoveYears",
        mode: "wholeSeriesMove",
        anchorYear: diagnosis.targetRange.endYear,
        selectedRange: { ...diagnosis.targetRange },
        deltaYears: fixedSideLag,
        sourceSegment,
        algorithmSource: ["piecewise_lag_path", "segmented_diagnosis"],
        recallSourceTags: [
            "path_fixed_side_whole_baseline",
            `path_fixed_side_lag:${fixedSideLag}`,
            `path_fixed_side_event_type:${transition.eventType}`,
            `path_fixed_side_transition:${transition.evidence.lagBefore}->${fixedSideLag}`,
            `path_fixed_side_event_score:${transition.evidence.score.toFixed(6)}`,
            `path_fixed_side_newer_context_years:${
                diagnosis.targetRange.endYear - boundaryYear
            }`,
        ],
    };
};

export const evaluatePathFixedSideWholeCandidate = (
    siteData: RwlSiteData,
    diagnosis: SeriesCoreDiagnosis,
    pathEvents: readonly DiagnosisEvent[],
    effectiveConfig: EffectiveDiagnosisConfig,
): DiagnosisCandidateOperation | null => {
    const draft = makePathFixedSideWholeDraft(
        diagnosis,
        pathEvents,
        effectiveConfig,
    );
    if (!draft) return null;
    const composition = evaluatePathFixedSideComposition(
        siteData,
        diagnosis,
        pathEvents,
        draft.deltaYears!,
        effectiveConfig,
    );
    const evaluatedDraft: CandidateDraft = composition?.passed
        ? {
            ...draft,
            recallSourceTags: [
                ...(draft.recallSourceTags ?? []),
                "path_fixed_side_joint_composition",
                `path_fixed_side_joint_event_count:${composition.eventCount}`,
                `path_fixed_side_joint_after_global_lag:${composition.afterBestGlobalLag}`,
                `path_fixed_side_joint_whole_r_delta:${
                    composition.wholeSeriesRDelta.toFixed(6)
                }`,
                `path_fixed_side_joint_mean_segment_r_delta:${
                    composition.meanSegmentRDelta.toFixed(6)
                }`,
                `path_fixed_side_joint_problem_reduction:${composition.problemReduction}`,
            ],
        }
        : draft;
    const candidate = evaluateDraft(
        siteData,
        diagnosis,
        evaluatedDraft,
        effectiveConfig,
        null,
    );
    return candidate?.candidateStrength === "strong"
        && (candidate.evidence.evaluationDelta?.hardGatePassed === true
            || candidate.evidence.evaluationDelta?.jointCompositionGatePassed === true)
        ? candidate
        : null;
};
