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
    wholeSeriesStateConsistencyNotes,
} from "./wholeSeriesStateConsistency";

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
            notes: ["candidate_hard_gate_passed", "scores_are_relative_not_probabilities"],
        },
        alternativeTypes: [],
        ...(cluster.eventType === "partialMove" ? {
            shiftYears: top.deltaYears ?? top.shift ?? 0,
            shiftSide: "older" as const,
        } : {}),
    };
};

const wholeEventFromCandidate = (
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
): DiagnosisCandidateOperation | undefined => {
    const whole = candidates.filter((candidate) => (
        eventTypeForCandidate(candidate) === "wholeSeriesMove"
    ));
    const validatedTerminal = whole.filter(isValidatedTerminalWholeCandidate);
    const eligible = validatedTerminal.length > 0
        ? validatedTerminal
        : whole.filter((candidate) => !candidate.evidence.recallSourceTags?.includes(
            "cofecha_terminal_whole_baseline",
        ));
    return eligible
        .sort((left, right) => right.score - left.score)[0];
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
    const whole = selectWholeSeriesCandidate(own);
    if (whole) events.push(wholeEventFromCandidate(diagnosis, whole));
    return events.sort((a, b) => b.endYear - a.endYear || b.evidence.score - a.evidence.score);
});
