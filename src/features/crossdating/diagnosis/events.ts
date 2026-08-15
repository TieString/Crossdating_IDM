/**
 * Candidate-to-event projection.
 *
 * Candidates remain the only executable objects. Events merge nearby evidence into one bounded
 * review window and never apply an edit by themselves.
 */
import type {
    DiagnosisCandidateOperation,
    DiagnosisConfidence,
    DiagnosisEvent,
    DiagnosisEventType,
    DiagnosisRankedYear,
    SeriesCoreDiagnosis,
} from "./types";
import {
    firstFixedYearFromLastMovedYear,
    isNegativePartialShift,
} from "./partialMoveSemantics";
import {
    measureWholeSeriesStateConsistency,
    supportsDominantWholeSeriesBaseline,
    supportsNonTerminalWholeSeriesCandidate,
    wholeSeriesStateConsistencyNotes,
} from "./wholeSeriesStateConsistency";
import { wholeBaselineCandidatePriority } from "./pathFixedSideWholeBaseline";

const WINDOW_WIDTH: Record<Exclude<DiagnosisEventType, "wholeSeriesMove">, number> = {
    missingRing: 7,
    falseRing: 7,
    partialMove: 9,
};

const eventTypeForCandidate = (candidate: DiagnosisCandidateOperation): DiagnosisEventType | null => {
    if (candidate.operationType === "INSERT_MISSING_RING") return "missingRing";
    if (candidate.operationType === "DELETE_FALSE_RING") return "falseRing";
    if (candidate.operationType === "SHIFT_RANGE"
        && candidate.mode === "partialRangeMove"
        && isNegativePartialShift(candidate.deltaYears ?? candidate.shift)) {
        return "partialMove";
    }
    if (candidate.operationType === "SHIFT_RANGE" && candidate.mode === "wholeSeriesMove") return "wholeSeriesMove";
    return null;
};

const anchorYearForCandidate = (candidate: DiagnosisCandidateOperation): number => (
    candidate.operationType === "SHIFT_RANGE"
        && candidate.mode === "partialRangeMove"
        && candidate.selectedRange
        ? firstFixedYearFromLastMovedYear(candidate.selectedRange.endYear)
        : candidate.targetYear
            ?? candidate.anchorYear
            ?? candidate.selectedRange?.endYear
);

const confidenceRank: Record<DiagnosisConfidence, number> = { low: 0, medium: 1, high: 2 };

const candidateConfidence = (candidate: DiagnosisCandidateOperation): DiagnosisConfidence => (
    candidate.confidenceLevel === "ambiguous" ? "medium" : candidate.confidence
);

const makeWindow = (
    centerYear: number,
    width: number,
    minYear: number,
    maxYear: number,
): { startYear: number; endYear: number } => {
    const safeWidth = Math.max(1, Math.min(width, maxYear - minYear + 1));
    let startYear = centerYear - Math.floor((safeWidth - 1) / 2);
    startYear = Math.max(minYear, Math.min(startYear, maxYear - safeWidth + 1));
    return { startYear, endYear: startYear + safeWidth - 1 };
};

const rankWindowYears = (
    startYear: number,
    endYear: number,
    candidates: DiagnosisCandidateOperation[],
): DiagnosisRankedYear[] => {
    const scoreByYear = new Map<number, { score: number; tags: Set<string> }>();
    candidates.forEach((candidate) => {
        const year = anchorYearForCandidate(candidate);
        const current = scoreByYear.get(year) ?? { score: -Infinity, tags: new Set<string>() };
        current.score = Math.max(current.score, candidate.score);
        candidate.algorithmSource.forEach((source) => current.tags.add(source));
        scoreByYear.set(year, current);
    });

    const rows: Array<Omit<DiagnosisRankedYear, "rank">> = [];
    for (let year = startYear; year <= endYear; year += 1) {
        const direct = scoreByYear.get(year);
        if (direct) {
            rows.push({ year, score: direct.score, evidenceTags: Array.from(direct.tags).sort() });
            continue;
        }
        let nearestDistance = Infinity;
        let nearestScore = -Infinity;
        scoreByYear.forEach((value, candidateYear) => {
            const distance = Math.abs(candidateYear - year);
            if (distance < nearestDistance || (distance === nearestDistance && value.score > nearestScore)) {
                nearestDistance = distance;
                nearestScore = value.score;
            }
        });
        rows.push({
            year,
            score: Number.isFinite(nearestScore) ? nearestScore - nearestDistance * 0.25 : -Infinity,
            evidenceTags: ["within_event_window"],
        });
    }

    return rows
        .sort((a, b) => b.score - a.score || a.year - b.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
};

type CandidateCluster = {
    eventType: Exclude<DiagnosisEventType, "wholeSeriesMove">;
    candidates: DiagnosisCandidateOperation[];
};

const clusterCandidates = (
    eventType: CandidateCluster["eventType"],
    candidates: DiagnosisCandidateOperation[],
): CandidateCluster[] => {
    const width = WINDOW_WIDTH[eventType];
    const sorted = [...candidates].sort((a, b) => anchorYearForCandidate(a) - anchorYearForCandidate(b));
    const clusters: CandidateCluster[] = [];
    sorted.forEach((candidate) => {
        const year = anchorYearForCandidate(candidate);
        const current = clusters[clusters.length - 1];
        const firstYear = current ? anchorYearForCandidate(current.candidates[0]) : year;
        const compatibleShift = eventType !== "partialMove"
            || current?.candidates[0].deltaYears === candidate.deltaYears;
        if (current && compatibleShift && year - firstYear < width) {
            current.candidates.push(candidate);
        } else {
            clusters.push({ eventType, candidates: [candidate] });
        }
    });
    return clusters;
};

const eventFromCluster = (
    diagnosis: SeriesCoreDiagnosis,
    cluster: CandidateCluster,
): DiagnosisEvent => {
    const candidates = [...cluster.candidates].sort((a, b) => b.score - a.score);
    const top = candidates[0];
    const width = WINDOW_WIDTH[cluster.eventType];
    const centerYear = anchorYearForCandidate(top);
    const window = makeWindow(
        centerYear,
        width,
        diagnosis.targetRange.startYear,
        diagnosis.targetRange.endYear,
    );
    const secondScore = candidates[1]?.score ?? top.score;
    const evaluation = top.evidence.evaluationDelta;
    return {
        id: `diagnosis-event-${diagnosis.targetTree}-${cluster.eventType}-${window.startYear}-${window.endYear}`,
        seriesId: diagnosis.targetTree,
        eventType: cluster.eventType,
        ...window,
        rankedYears: rankWindowYears(window.startYear, window.endYear, candidates),
        confidenceLevel: candidates.reduce((best, candidate) => {
            const confidence = candidateConfidence(candidate);
            return confidenceRank[confidence] > confidenceRank[best] ? confidence : best;
        }, "low" as DiagnosisConfidence),
        evidence: {
            algorithmSources: Array.from(new Set(candidates.flatMap((candidate) => candidate.algorithmSource))).sort(),
            score: top.score,
            scoreMargin: top.score - secondScore,
            baselineCorrelation: evaluation?.wholeSeriesRBefore ?? top.currentCorrelation,
            correctedCorrelation: evaluation?.wholeSeriesRAfter ?? top.expectedCorrelation,
            correlationGain: evaluation?.wholeSeriesRDelta ?? top.delta ?? null,
            lagBefore: evaluation?.dominantLagBefore ?? top.evidence.before.bestLag,
            lagAfter: evaluation?.dominantLagAfter ?? top.evidence.after.bestLag,
            samplePairs: top.evidence.localEditAlignment
                ? top.evidence.localEditAlignment.windowEndYear - top.evidence.localEditAlignment.windowStartYear + 1
                : 0,
            candidateIds: candidates.map((candidate) => candidate.id),
            notes: [
                "candidate_hard_gate_passed",
                "scores_are_relative_not_probabilities",
                `candidate_source_segment_start=${top.segmentStartYear}`,
                `candidate_source_segment_end=${top.segmentEndYear}`,
            ],
        },
        alternativeTypes: [],
        ...(cluster.eventType === "partialMove" ? {
            shiftYears: top.deltaYears ?? top.shift ?? 0,
            shiftSide: "older" as const,
        } : {}),
    };
};

export const wholeEventFromCandidate = (
    diagnosis: SeriesCoreDiagnosis,
    candidate: DiagnosisCandidateOperation,
): DiagnosisEvent => {
    const evaluation = candidate.evidence.evaluationDelta;
    const shiftYears = candidate.deltaYears ?? candidate.suggestedLag;
    const stateConsistency = measureWholeSeriesStateConsistency(
        diagnosis,
        shiftYears,
    );
    return {
        id: `diagnosis-event-${diagnosis.targetTree}-whole-${shiftYears}`,
        seriesId: diagnosis.targetTree,
        eventType: "wholeSeriesMove",
        shiftYears,
        startYear: diagnosis.targetRange.startYear,
        endYear: diagnosis.targetRange.endYear,
        rankedYears: [],
        confidenceLevel: candidateConfidence(candidate),
        evidence: {
            algorithmSources: [...candidate.algorithmSource],
            score: candidate.score,
            scoreMargin: candidate.score,
            baselineCorrelation: evaluation?.wholeSeriesRBefore ?? candidate.currentCorrelation,
            correctedCorrelation: evaluation?.wholeSeriesRAfter ?? candidate.expectedCorrelation,
            correlationGain: evaluation?.wholeSeriesRDelta ?? candidate.delta ?? null,
            lagBefore: evaluation?.dominantLagBefore ?? candidate.evidence.before.bestLag,
            lagAfter: evaluation?.dominantLagAfter ?? candidate.evidence.after.bestLag,
            samplePairs: candidate.evidence.globalSliding?.overlapYears ?? 0,
            candidateIds: [candidate.id],
            notes: [
                ...(evaluation?.hardGatePassed
                    ? ["candidate_hard_gate_passed"]
                    : evaluation?.jointCompositionGatePassed
                        ? ["candidate_joint_composition_gate_passed"]
                        : ["candidate_protected_weak_evidence"]),
                ...(candidate.evidence.recallSourceTags?.includes(
                    "cofecha_terminal_whole_baseline",
                ) ? [
                    "whole_baseline_source=cofecha_terminal_lag",
                    ...(candidate.evidence.recallSourceTags
                        .filter((tag) => (
                            tag.startsWith("cofecha_terminal_mode:")
                            || tag.startsWith("cofecha_terminal_segments:")
                            || tag.startsWith("cofecha_terminal_consistency:")
                            || tag.startsWith("cofecha_terminal_residual_lag:")
                            || tag.startsWith("cofecha_terminal_matching_pattern_support:")
                            || tag.startsWith("cofecha_terminal_opposing_pattern_support:")
                        ))
                        .map((tag) => tag.replace(":", "="))),
                ] : []),
                ...(candidate.evidence.recallSourceTags?.includes(
                    "path_fixed_side_whole_baseline",
                ) ? [
                    "whole_baseline_source=path_fixed_side_lag",
                    ...(candidate.evidence.recallSourceTags
                        .filter((tag) => (
                            tag.startsWith("path_fixed_side_lag:")
                            || tag.startsWith("path_fixed_side_event_type:")
                            || tag.startsWith("path_fixed_side_transition:")
                            || tag.startsWith("path_fixed_side_newer_context_years:")
                        ))
                        .map((tag) => tag.replace(":", "="))),
                ] : []),
                ...(candidate.evidence.recallSourceTags?.includes(
                    "recent_tail_whole_baseline",
                ) ? [
                    "whole_baseline_source=recent_tail_lag",
                    ...(candidate.evidence.recallSourceTags
                        .filter((tag) => (
                            tag.startsWith("recent_tail_lag:")
                            || tag.startsWith("recent_tail_support:")
                            || tag.startsWith("recent_tail_support_count:")
                            || tag.startsWith("recent_tail_total_count:")
                            || tag.startsWith("recent_tail_competing_support:")
                            || tag.startsWith("recent_tail_context_years:")
                            || tag.startsWith("recent_tail_median_r:")
                            || tag.startsWith("recent_tail_path_lag:")
                            || tag.startsWith("recent_tail_path_margin:")
                            || tag.startsWith("recent_tail_path_pairs:")
                            || tag.startsWith("recent_tail_global_lag:")
                            || tag.startsWith("recent_tail_residual_path_lag:")
                            || tag.startsWith("recent_tail_residual_partial_shift:")
                            || tag.startsWith("recent_tail_residual_path_event_count:")
                            || tag.startsWith("recent_tail_residual_path_after_global_lag:")
                            || tag.startsWith("recent_tail_residual_path_whole_r_delta:")
                            || tag.startsWith(
                                "recent_tail_residual_path_mean_segment_r_delta:",
                            )
                            || tag.startsWith(
                                "recent_tail_residual_path_problem_reduction:",
                            )
                        ))
                        .map((tag) => tag.replace(":", "="))),
                ] : []),
                `whole_operation_shift=${shiftYears}`,
                `whole_observed_dominant_lag=${
                    evaluation?.dominantLagBefore ?? candidate.evidence.before.bestLag
                }`,
                ...wholeSeriesStateConsistencyNotes(stateConsistency),
                "scores_are_relative_not_probabilities",
            ],
        },
        alternativeTypes: [],
    };
};

export const selectWholeSeriesCandidate = (
    candidates: DiagnosisCandidateOperation[],
    diagnosis?: SeriesCoreDiagnosis,
): DiagnosisCandidateOperation | undefined => {
    const whole = candidates.filter((candidate) => (
        eventTypeForCandidate(candidate) === "wholeSeriesMove"
    ));
    const validatedBaselines = whole.filter((candidate) => (
        isValidatedTerminalWholeCandidate(candidate)
        || isValidatedPathFixedSideWholeCandidate(candidate)
        || isValidatedRecentTailWholeCandidate(candidate)
    ));
    const dominantWholeBaselines = diagnosis
        ? whole.filter((candidate) => {
            const evaluation = candidate.evidence.evaluationDelta;
            const shiftYears = candidate.deltaYears ?? candidate.suggestedLag;
            return candidate.candidateStrength === "strong"
                && (evaluation?.hardGatePassed === true
                    || evaluation?.jointCompositionGatePassed === true)
                && supportsDominantWholeSeriesBaseline(
                    measureWholeSeriesStateConsistency(diagnosis, shiftYears),
                );
        })
        : [];
    const eligible = dominantWholeBaselines.length > 0
        ? dominantWholeBaselines
        : validatedBaselines.length > 0
        ? validatedBaselines
        : whole.filter((candidate) => !candidate.evidence.recallSourceTags?.includes(
            "cofecha_terminal_whole_baseline",
        )).filter((candidate) => {
            if (!diagnosis) return true;
            const shiftYears = candidate.deltaYears ?? candidate.suggestedLag;
            return supportsNonTerminalWholeSeriesCandidate(
                measureWholeSeriesStateConsistency(diagnosis, shiftYears),
            );
        });
    return eligible
        .sort((left, right) => (
            wholeBaselineCandidatePriority(right) - wholeBaselineCandidatePriority(left)
            || right.score - left.score
        ))[0];
};

export const isValidatedPathFixedSideWholeCandidate = (
    candidate: DiagnosisCandidateOperation,
): boolean => {
    const evaluation = candidate.evidence.evaluationDelta;
    return eventTypeForCandidate(candidate) === "wholeSeriesMove"
        && candidate.evidence.recallSourceTags?.includes(
            "path_fixed_side_whole_baseline",
        ) === true
        && candidate.candidateStrength === "strong"
        && evaluation?.jointCompositionGatePassed === true;
};

export const isValidatedRecentTailWholeCandidate = (
    candidate: DiagnosisCandidateOperation,
): boolean => {
    const evaluation = candidate.evidence.evaluationDelta;
    return eventTypeForCandidate(candidate) === "wholeSeriesMove"
        && candidate.evidence.recallSourceTags?.includes(
            "recent_tail_whole_baseline",
        ) === true
        && candidate.candidateStrength === "strong"
        && (evaluation?.hardGatePassed === true
            || evaluation?.jointCompositionGatePassed === true);
};

export const isValidatedTerminalWholeCandidate = (
    candidate: DiagnosisCandidateOperation,
): boolean => {
    const evaluation = candidate.evidence.evaluationDelta;
    return eventTypeForCandidate(candidate) === "wholeSeriesMove"
        && candidate.evidence.recallSourceTags?.includes(
            "cofecha_terminal_whole_baseline",
        ) === true
        && candidate.candidateStrength === "strong"
        && (evaluation?.hardGatePassed === true
            || evaluation?.jointCompositionGatePassed === true);
};

export const makeDiagnosisEventsFromCandidates = (
    diagnoses: SeriesCoreDiagnosis[],
    candidates: DiagnosisCandidateOperation[],
): DiagnosisEvent[] => diagnoses.flatMap((diagnosis) => {
    const own = candidates.filter((candidate) => candidate.targetTree === diagnosis.targetTree);
    const events: DiagnosisEvent[] = [];
    (["missingRing", "falseRing", "partialMove"] as const).forEach((eventType) => {
        const matching = own.filter((candidate) => eventTypeForCandidate(candidate) === eventType);
        clusterCandidates(eventType, matching).forEach((cluster) => events.push(eventFromCluster(diagnosis, cluster)));
    });
    const whole = selectWholeSeriesCandidate(own, diagnosis);
    if (whole) events.push(wholeEventFromCandidate(diagnosis, whole));
    return events.sort((a, b) => b.endYear - a.endYear || b.evidence.score - a.evidence.score);
});
