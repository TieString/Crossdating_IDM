import type {
    AuthoritativeDiagnosisDecision,
    CrossdatingDiagnosis,
    DiagnosisCandidateOperation,
    DiagnosisEvent,
    DiagnosisEventType,
} from "./types";

const effectiveShift = (event: DiagnosisEvent): number => {
    if (event.eventType === "missingRing") return -1;
    if (event.eventType === "falseRing") return 1;
    return event.shiftYears ?? 0;
};

const collectEvents = (diagnosis: CrossdatingDiagnosis): DiagnosisEvent[] => {
    const output: DiagnosisEvent[] = [];
    const seen = new Set<string>();
    const visit = (event: DiagnosisEvent | undefined): void => {
        if (!event || seen.has(event.id)) return;
        seen.add(event.id);
        output.push(event);
        event.operationAlternatives?.forEach(visit);
        visit(event.interpretationAmbiguity?.alternative);
    };
    diagnosis.reviewEvents?.forEach(visit);
    diagnosis.events.forEach(visit);
    return output;
};

const candidateMatches = (
    candidate: DiagnosisCandidateOperation,
    eventType: DiagnosisEventType,
    shiftYears: number,
): boolean => {
    if (eventType === "missingRing") {
        return candidate.operationType === "INSERT_MISSING_RING";
    }
    if (eventType === "falseRing") {
        return candidate.operationType === "DELETE_FALSE_RING";
    }
    if (candidate.operationType !== "SHIFT_RANGE") return false;
    if (eventType === "wholeSeriesMove" && candidate.mode !== "wholeSeriesMove") return false;
    if (eventType === "partialMove" && candidate.mode !== "partialRangeMove") return false;
    return (candidate.deltaYears ?? candidate.shift ?? 0) === shiftYears;
};

const chooseTemplate = (
    diagnosis: CrossdatingDiagnosis,
    decision: AuthoritativeDiagnosisDecision,
): DiagnosisEvent | undefined => {
    const candidates = collectEvents(diagnosis).filter((event) => (
        event.eventType === decision.eventType
        && effectiveShift(event) === decision.shiftYears
    ));
    if (candidates.length === 0) return undefined;
    if (decision.topYear === null) return candidates[0];
    return [...candidates].sort((left, right) => {
        const leftTop = left.rankedYears[0]?.year
            ?? Math.round((left.startYear + left.endYear) / 2);
        const rightTop = right.rankedYears[0]?.year
            ?? Math.round((right.startYear + right.endYear) / 2);
        return Math.abs(leftTop - decision.topYear!)
            - Math.abs(rightTop - decision.topYear!);
    })[0];
};

const projectSelectedEvent = (
    diagnosis: CrossdatingDiagnosis,
    decision: AuthoritativeDiagnosisDecision,
    seriesId: string,
): DiagnosisEvent | null => {
    if (decision.status !== "selected" || decision.eventType === "noEvent") return null;
    const eventType = decision.eventType;
    const template = chooseTemplate(diagnosis, decision);
    const matchingCandidates = diagnosis.candidates.filter((candidate) => (
        candidate.targetTree === seriesId
        && candidateMatches(candidate, eventType, decision.shiftYears)
    ));
    const startYear = decision.startYear
        ?? template?.startYear
        ?? matchingCandidates[0]?.selectedRange?.startYear
        ?? matchingCandidates[0]?.segmentStartYear;
    const endYear = decision.endYear
        ?? template?.endYear
        ?? matchingCandidates[0]?.selectedRange?.endYear
        ?? matchingCandidates[0]?.segmentEndYear;
    if (startYear === undefined || endYear === undefined) return null;
    const topYear = decision.topYear
        ?? template?.rankedYears[0]?.year
        ?? Math.round((startYear + endYear) / 2);
    const templateEvidence = template?.evidence;
    const candidateIds = [...new Set([
        ...(templateEvidence?.candidateIds ?? []),
        ...matchingCandidates.map((candidate) => candidate.id),
    ])];
    return {
        ...(template ?? {
            id: "",
            seriesId,
            confidenceLevel: "medium" as const,
            evidence: {
                algorithmSources: [],
                score: 0,
                scoreMargin: 0,
                baselineCorrelation: null,
                correctedCorrelation: null,
                correlationGain: null,
                lagBefore: null,
                lagAfter: null,
                samplePairs: 0,
                candidateIds: [],
                notes: [],
            },
            alternativeTypes: [],
        }),
        id: `authoritative:${seriesId}:${eventType}:${decision.shiftYears}:${startYear}:${endYear}`,
        seriesId,
        eventType,
        startYear,
        endYear,
        reviewCoreRange: undefined,
        rankedYears: [{
            year: topYear,
            rank: 1,
            score: template?.rankedYears.find((ranked) => ranked.year === topYear)?.score
                ?? templateEvidence?.score
                ?? 0,
            evidenceTags: ["authoritative_unified_model_v12"],
        }],
        evidence: {
            ...(templateEvidence ?? {
                algorithmSources: [],
                score: 0,
                scoreMargin: 0,
                baselineCorrelation: null,
                correctedCorrelation: null,
                correlationGain: null,
                lagBefore: null,
                lagAfter: null,
                samplePairs: 0,
                candidateIds: [],
                notes: [],
            }),
            algorithmSources: [
                ...(templateEvidence?.algorithmSources ?? []),
                "authoritative_unified_model_v12",
            ],
            candidateIds,
            notes: [
                ...(templateEvidence?.notes ?? []),
                `authoritative_model=${decision.modelVersion}`,
                `authoritative_identity=${decision.identityGroup ?? "unknown"}`,
            ],
        },
        alternativeTypes: template?.alternativeTypes ?? [],
        locationAlternatives: undefined,
        operationAlternatives: undefined,
        shiftYears: eventType === "missingRing" || eventType === "falseRing"
            ? undefined
            : decision.shiftYears,
        shiftSide: eventType === "partialMove"
            ? "older"
            : template?.shiftSide,
        reviewOnly: false,
        stale: false,
    };
};

export const applyAuthoritativeModelDecision = (
    diagnosis: CrossdatingDiagnosis,
    decision: AuthoritativeDiagnosisDecision,
    seriesId: string,
): CrossdatingDiagnosis => {
    const selected = projectSelectedEvent(diagnosis, decision, seriesId);
    const events = selected ? [selected] : [];
    return {
        ...diagnosis,
        eventCount: events.length,
        events,
        reviewEvents: events,
        reviewWindowDecisions: [],
        authoritativeModelDecision: selected
            ? decision
            : {
                ...decision,
                status: decision.status === "selected" ? "error" : decision.status,
                refusalReason: decision.status === "selected"
                    ? "selected model package could not be projected to an executable event"
                    : decision.refusalReason,
            },
    };
};
