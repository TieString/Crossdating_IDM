/**
 * 诊断候选草案生成。
 * 这里把整体滑动、传播模式和分段异常翻译成可模拟的插入、删除或移动候选。
 */
import { CrossdateConfig } from "./config";
import { runLocalEditAlignment } from "./localEditAlignment";
import { preprocessSeries } from "./series";
import { uniqueAlgorithmSources } from "./candidateUtils";
import {
    extendPartialBoundaryByPointFit,
    getLagSupportingSegments,
    getRepresentativeSegmentForLag,
    getSegmentNearYear,
    makePartialRangeEvidence,
    missingRangeForMove,
    nearestExistingYear,
    pickSingleYearAnchor,
    refinePartialSelectedRange,
    runSlidingMatchForRange,
} from "./rangeMove";
import type {
    CandidateDraft,
    EffectiveDiagnosisConfig,
    LocalEditAlignmentEdit,
    LocalEditAlignmentResult,
    LocalEditType,
    PropagationPattern,
    SegmentDiagnosis,
    SeriesCoreDiagnosis,
} from "./types";

const localEditTypeForLag = (lag: number): LocalEditType | null => {
    if (lag < 0) return "insertMissingYear";
    if (lag > 0) return "deleteFalseYear";
    return null;
};

const operationForLocalEdit = (
    editType: LocalEditType,
): Pick<CandidateDraft, "operationType" | "candidateType"> => (
    editType === "insertMissingYear"
        ? { operationType: "INSERT_MISSING_RING", candidateType: "insertMissingYear" }
        : { operationType: "DELETE_FALSE_RING", candidateType: "deleteFalseYear" }
);

const createFallbackLocalEditAlignment = (
    diagnosis: SeriesCoreDiagnosis,
    segment: SegmentDiagnosis,
    editType: LocalEditType,
    anchorYear: number,
): LocalEditAlignmentResult => ({
    seriesId: diagnosis.targetTree,
    windowStartYear: segment.startYear,
    windowEndYear: segment.endYear,
    method: "fallback_single_edit_scan",
    pathScore: 0,
    edits: [{
        type: editType,
        anchorYear,
        scoreContribution: 0,
        reason: "single-edit scan fallback from segmented lag",
    }],
});

const getLocalEditAlignmentForSegment = (
    diagnosis: SeriesCoreDiagnosis,
    segment: SegmentDiagnosis,
    editType: LocalEditType,
    fallbackYear: number,
    config: EffectiveDiagnosisConfig,
): { alignment: LocalEditAlignmentResult; edit: LocalEditAlignmentEdit } => {
    const target = preprocessSeries(diagnosis.rawTarget);
    const alignment = runLocalEditAlignment(
        diagnosis.targetTree,
        target,
        diagnosis.master.data,
        { startYear: segment.startYear, endYear: segment.endYear },
        {
            maxGaps: config.localEditMaxGaps,
            diagonalBand: config.localEditDiagonalBand,
            minLocalOverlap: config.minLocalOverlap,
            narrowYearThreshold: config.narrowYearThreshold,
            strongNarrowYearThreshold: config.strongNarrowYearThreshold,
        },
    );
    const edit = alignment?.edits
        .filter((candidate) => candidate.type === editType)
        .sort((a, b) => (
            b.scoreContribution - a.scoreContribution
            || Math.abs(a.anchorYear - fallbackYear) - Math.abs(b.anchorYear - fallbackYear)
        ))[0];

    if (alignment && edit) {
        return { alignment, edit };
    }

    const fallback = createFallbackLocalEditAlignment(diagnosis, segment, editType, fallbackYear);
    return { alignment: fallback, edit: fallback.edits[0] };
};

const createLocalEditDraft = (
    diagnosis: SeriesCoreDiagnosis,
    segment: SegmentDiagnosis,
    editType: LocalEditType,
    anchorYear: number,
    alignment: LocalEditAlignmentResult,
    sourcePattern?: PropagationPattern,
): CandidateDraft => {
    const operation = operationForLocalEdit(editType);
    return {
        targetTree: diagnosis.targetTree,
        ...operation,
        anchorYear,
        targetYear: anchorYear,
        selectedRange: { startYear: diagnosis.targetRange.startYear, endYear: anchorYear },
        missingRange: editType === "insertMissingYear"
            ? { startYear: anchorYear, endYear: anchorYear }
            : undefined,
        side: "right",
        sourceSegment: segment,
        sourcePattern,
        localEditAlignment: alignment,
        algorithmSource: uniqueAlgorithmSources([
            "segmented_diagnosis",
            sourcePattern ? "propagation_pattern" : undefined,
            "local_edit_alignment",
        ]),
    };
};

export const makeGlobalSlidingDrafts = (
    diagnosis: SeriesCoreDiagnosis,
): CandidateDraft[] => {
    const match = diagnosis.globalSlidingMatch;
    if (match.bestGlobalLag === 0 || match.bestGlobalR === null) return [];

    const currentR = match.currentR ?? -1;
    const globalImprovement = match.bestGlobalR - currentR;
    const supportingSegments = getLagSupportingSegments(diagnosis.segments, match.bestGlobalLag);
    const supportRatio = supportingSegments.length / Math.max(1, diagnosis.segments.length);
    const strongGlobalT = (match.bestGlobalTLike ?? 0) >= CrossdateConfig.globalMinTLike;
    const clearImprovement = globalImprovement >= CrossdateConfig.globalRImprovementThreshold;
    const enoughSupport = supportRatio >= CrossdateConfig.globalSupportRatio
        || supportingSegments.length >= CrossdateConfig.minPropagationSegments;

    if (
        match.overlapYears < CrossdateConfig.minGlobalOverlap
        || (!clearImprovement && !enoughSupport)
        || (!strongGlobalT && !clearImprovement)
    ) {
        return [];
    }

    const sourceSegment = getRepresentativeSegmentForLag(diagnosis, match.bestGlobalLag);
    if (!sourceSegment) return [];

    return [{
        targetTree: diagnosis.targetTree,
        operationType: "SHIFT_RANGE",
        candidateType: "batchMoveYears",
        mode: "wholeSeriesMove",
        anchorYear: diagnosis.targetRange.endYear,
        selectedRange: { ...diagnosis.targetRange },
        deltaYears: match.bestGlobalLag,
        sourceSegment,
        globalSlidingMatch: match,
        algorithmSource: ["global_sliding_match", "segmented_diagnosis"],
    }];
};

export const makePatternDrafts = (
    diagnosis: SeriesCoreDiagnosis,
    config: EffectiveDiagnosisConfig,
): CandidateDraft[] => {
    const drafts: CandidateDraft[] = [];
    const years = Array.from(diagnosis.rawTarget.keys()).sort((a, b) => a - b);

    diagnosis.propagationPatterns.forEach((pattern) => {
        const sourceSegment = getSegmentNearYear(diagnosis.segments, pattern.newerBoundaryYear);
        if (!sourceSegment) return;

        const fallbackAnchorYear = nearestExistingYear(
            years,
            pattern.newerBoundaryYear,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
        );
        if (fallbackAnchorYear === null) return;
        const anchorYear = pattern.patternType === "possibleMissingYear" || pattern.patternType === "possibleFalseYear"
            ? pickSingleYearAnchor(diagnosis, pattern, fallbackAnchorYear, config)
            : fallbackAnchorYear;

        if (pattern.patternType === "possibleMissingYear" && pattern.lag < 0) {
            const { alignment, edit } = getLocalEditAlignmentForSegment(
                diagnosis,
                sourceSegment,
                "insertMissingYear",
                anchorYear,
                config,
            );
            drafts.push(createLocalEditDraft(diagnosis, sourceSegment, "insertMissingYear", edit.anchorYear, alignment, pattern));
            return;
        }

        if (pattern.patternType === "possibleFalseYear" && pattern.lag > 0) {
            const { alignment, edit } = getLocalEditAlignmentForSegment(
                diagnosis,
                sourceSegment,
                "deleteFalseYear",
                anchorYear,
                config,
            );
            drafts.push(createLocalEditDraft(diagnosis, sourceSegment, "deleteFalseYear", edit.anchorYear, alignment, pattern));
            return;
        }

        const initialSelectedRange = pattern.patternType === "possibleWholeSeriesMove"
            ? { ...diagnosis.targetRange }
            : { startYear: diagnosis.targetRange.startYear, endYear: anchorYear };
        const localSliding = pattern.patternType === "possiblePartialRangeMove"
            ? runSlidingMatchForRange(diagnosis, initialSelectedRange, config)
            : null;
        const localImprovement = localSliding?.bestGlobalR === null
            ? 0
            : (localSliding?.bestGlobalR ?? -1) - (localSliding?.currentR ?? -1);
        const deltaYears = localSliding
            && localSliding.bestGlobalLag !== 0
            && Math.sign(localSliding.bestGlobalLag) === Math.sign(pattern.lag)
            && (
                localImprovement >= CrossdateConfig.globalRImprovementThreshold
                || (localSliding.bestGlobalTLike ?? 0) >= CrossdateConfig.globalMinTLike
            )
            ? localSliding.bestGlobalLag
            : pattern.lag;
        const selectedRange = pattern.patternType === "possiblePartialRangeMove"
            ? extendPartialBoundaryByPointFit(
                diagnosis,
                refinePartialSelectedRange(diagnosis, initialSelectedRange, deltaYears, config),
                deltaYears,
            )
            : initialSelectedRange;

        drafts.push({
            targetTree: diagnosis.targetTree,
            operationType: "SHIFT_RANGE",
            candidateType: "batchMoveYears",
            mode: pattern.patternType === "possibleWholeSeriesMove" ? "wholeSeriesMove" : "partialRangeMove",
            anchorYear,
            selectedRange,
            missingRange: pattern.patternType === "possiblePartialRangeMove"
                ? missingRangeForMove(selectedRange, deltaYears)
                : undefined,
            deltaYears,
            sourceSegment,
            sourcePattern: pattern,
            algorithmSource: uniqueAlgorithmSources([
                "segmented_diagnosis",
                "propagation_pattern",
                pattern.patternType === "possiblePartialRangeMove" ? "global_sliding_match" : undefined,
            ]),
            partialRangeMoveEvidence: pattern.patternType === "possiblePartialRangeMove"
                ? makePartialRangeEvidence(diagnosis, selectedRange, deltaYears)
                : undefined,
        });
    });

    return drafts;
};

export const makeSegmentDrafts = (
    diagnosis: SeriesCoreDiagnosis,
    config: EffectiveDiagnosisConfig,
): CandidateDraft[] => {
    const drafts: CandidateDraft[] = [];
    const patternCoveredSegments = new Set<string>();
    const years = Array.from(diagnosis.rawTarget.keys()).sort((a, b) => a - b);

    diagnosis.propagationPatterns.forEach((pattern) => {
        pattern.affectedSegments.forEach((segment) => {
            patternCoveredSegments.add(`${segment.startYear}:${segment.endYear}`);
        });
    });

    diagnosis.segments.forEach((segment) => {
        if (!segment.flagged || patternCoveredSegments.has(`${segment.startYear}:${segment.endYear}`)) return;
        if (segment.flag !== "B_like" || segment.bestLag === 0) return;

        const midpoint = Math.round((segment.startYear + segment.endYear) / 2);
        const anchorYear = nearestExistingYear(years, midpoint, segment.startYear, segment.endYear);
        if (anchorYear === null) return;

        const editType = Math.abs(segment.bestLag) === 1 ? localEditTypeForLag(segment.bestLag) : null;
        if (editType) {
            const { alignment, edit } = getLocalEditAlignmentForSegment(
                diagnosis,
                segment,
                editType,
                anchorYear,
                config,
            );
            drafts.push(createLocalEditDraft(diagnosis, segment, editType, edit.anchorYear, alignment));
            return;
        }

        const initialSelectedRange = {
            startYear: diagnosis.targetRange.startYear,
            endYear: Math.min(diagnosis.targetRange.endYear, segment.endYear),
        };
        const selectedRange = extendPartialBoundaryByPointFit(
            diagnosis,
            refinePartialSelectedRange(diagnosis, initialSelectedRange, segment.bestLag, config),
            segment.bestLag,
        );
        drafts.push({
            targetTree: diagnosis.targetTree,
            operationType: "SHIFT_RANGE",
            candidateType: "batchMoveYears",
            mode: "partialRangeMove",
            anchorYear,
            selectedRange,
            missingRange: missingRangeForMove(selectedRange, segment.bestLag),
            deltaYears: segment.bestLag,
            sourceSegment: segment,
            algorithmSource: ["segmented_diagnosis"],
            partialRangeMoveEvidence: makePartialRangeEvidence(diagnosis, selectedRange, segment.bestLag),
        });
    });

    return drafts;
};
