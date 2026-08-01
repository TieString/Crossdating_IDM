/** Counterfactual verification for a bounded path event. */
import type { RwlSiteData } from "@/features/rwl/types";
import { compareDiagnosisCandidates, rankDiagnosisCandidates } from "./candidateUtils";
import { evaluateDraft } from "./evaluation";
import { getSegmentNearYear, makePartialRangeEvidence, missingRangeForMove } from "./rangeMove";
import {
    isNegativePartialShift,
    lastMovedYearFromFirstFixedYear,
} from "./partialMoveSemantics";
import type {
    CandidateDraft,
    DiagnosisCandidateOperation,
    DiagnosisEvent,
    EffectiveDiagnosisConfig,
    SeriesCoreDiagnosis,
} from "./types";

export type EventVerificationConfig = {
    maximumYearsToEvaluate: number;
    maximumCandidates: number;
};

export const DEFAULT_EVENT_VERIFICATION_CONFIG: EventVerificationConfig = {
    maximumYearsToEvaluate: 9,
    maximumCandidates: 3,
};

const draftFor = (
    diagnosis: SeriesCoreDiagnosis,
    event: DiagnosisEvent,
    year: number,
): CandidateDraft | null => {
    const sourceSegment = getSegmentNearYear(diagnosis.segments, year);
    if (!sourceSegment) return null;
    if (event.eventType === "missingRing" || event.eventType === "falseRing") {
        const missing = event.eventType === "missingRing";
        return {
            targetTree: diagnosis.targetTree,
            operationType: missing ? "INSERT_MISSING_RING" : "DELETE_FALSE_RING",
            candidateType: missing ? "insertMissingYear" : "deleteFalseYear",
            anchorYear: year,
            targetYear: year,
            selectedRange: {
                startYear: diagnosis.targetRange.startYear,
                endYear: year,
            },
            missingRange: missing ? { startYear: year, endYear: year } : undefined,
            side: "right",
            sourceSegment,
            algorithmSource: ["piecewise_lag_path", "local_edit_alignment"],
            recallSourceTags: ["bounded_path_event_verification"],
        };
    }
    if (event.eventType !== "partialMove"
        || !isNegativePartialShift(event.shiftYears)) return null;
    const lastMovedYear = lastMovedYearFromFirstFixedYear(year);
    const selectedRange = {
        startYear: diagnosis.targetRange.startYear,
        endYear: lastMovedYear,
    };
    return {
        targetTree: diagnosis.targetTree,
        operationType: "SHIFT_RANGE",
        candidateType: "batchMoveYears",
        mode: "partialRangeMove",
        anchorYear: year,
        selectedRange,
        missingRange: missingRangeForMove(selectedRange, event.shiftYears),
        deltaYears: event.shiftYears,
        sourceSegment,
        algorithmSource: ["piecewise_lag_path", "segmented_diagnosis"],
        recallSourceTags: ["bounded_path_event_verification"],
        partialRangeMoveEvidence: makePartialRangeEvidence(
            diagnosis,
            selectedRange,
            event.shiftYears,
        ),
    };
};

export const verifyDiagnosisEvent = (
    siteData: RwlSiteData,
    diagnosis: SeriesCoreDiagnosis,
    event: DiagnosisEvent,
    effectiveConfig: EffectiveDiagnosisConfig,
    overrides: Partial<EventVerificationConfig> = {},
): DiagnosisCandidateOperation[] => {
    if (event.eventType === "wholeSeriesMove") return [];
    const config = { ...DEFAULT_EVENT_VERIFICATION_CONFIG, ...overrides };
    const years = event.rankedYears
        .slice(0, config.maximumYearsToEvaluate)
        .map((row) => row.year);
    const candidates = years.flatMap((year): DiagnosisCandidateOperation[] => {
        const draft = draftFor(diagnosis, event, year);
        if (!draft) return [];
        const candidate = evaluateDraft(siteData, diagnosis, draft, effectiveConfig, null);
        return candidate?.candidateStrength === "strong" ? [candidate] : [];
    });
    return rankDiagnosisCandidates(candidates)
        .sort(compareDiagnosisCandidates)
        .slice(0, config.maximumCandidates);
};
