/** Selects one lower-threshold manual-review window without changing strict event output. */
import type {
    DiagnosisEvent,
    DiagnosisEventAuditSnapshot,
    DiagnosisEventDecisionAudit,
    DiagnosisReviewWindowDecision,
} from "./types";

type ReviewSourceStage = Exclude<
    DiagnosisReviewWindowDecision["sourceStage"],
    "final" | null
>;

type StagedEvent = {
    event: DiagnosisEventAuditSnapshot;
    stage: ReviewSourceStage;
    stagePriority: number;
};

export type ReviewWindowDisplayConfig = {
    minimumReferenceSources: number;
    minimumMedianReferenceDepth: number;
    remoteModeDistanceYears: number;
    minimumRemoteModeStrengthMargin: number;
    minimumOperationStrengthMargin: number;
    allowedWindowWidths: readonly number[];
};

export const DEFAULT_REVIEW_WINDOW_DISPLAY_CONFIG: ReviewWindowDisplayConfig = {
    minimumReferenceSources: 3,
    minimumMedianReferenceDepth: 3,
    remoteModeDistanceYears: 13,
    minimumRemoteModeStrengthMargin: 0.05,
    minimumOperationStrengthMargin: 0.05,
    allowedWindowWidths: [5, 7, 9, 13],
};

const confidenceStrength = (
    confidence: DiagnosisEventAuditSnapshot["confidenceLevel"],
): number => confidence === "high" ? 0.2 : confidence === "medium" ? 0.1 : 0;

const eventStrength = (candidate: StagedEvent): number => (
    candidate.event.score
    + candidate.event.scoreMargin
    + confidenceStrength(candidate.event.confidenceLevel)
    + candidate.stagePriority * 0.01
);

const centerYear = (event: DiagnosisEventAuditSnapshot): number => (
    event.topYear ?? Math.round((event.startYear + event.endYear) / 2)
);

const isUnitEvent = (event: DiagnosisEventAuditSnapshot): boolean => (
    event.eventType === "missingRing" || event.eventType === "falseRing"
);

const hasConsistentUnitDirection = (event: DiagnosisEventAuditSnapshot): boolean => {
    if (!isUnitEvent(event) || event.lagBefore === null || event.lagAfter === null) {
        return false;
    }
    const transition = event.lagAfter - event.lagBefore;
    return event.eventType === "missingRing" ? transition === 1 : transition === -1;
};

const stagedEvents = (audit: DiagnosisEventDecisionAudit): StagedEvent[] => {
    const stages: Array<{
        stage: ReviewSourceStage;
        priority: number;
        events: DiagnosisEventAuditSnapshot[];
    }> = [
        { stage: "displayed", priority: 5, events: audit.displayedBeforeLocator },
        { stage: "retained", priority: 4, events: audit.retainedAfterEndpointGuard },
        { stage: "fused", priority: 3, events: audit.detectedAfterFusion },
        { stage: "detected", priority: 2, events: audit.detectedBeforeFusion },
        { stage: "candidate", priority: 1, events: audit.candidateProjectedEvents },
    ];
    const deduplicated = new Map<string, StagedEvent>();
    stages.forEach(({ stage, priority, events }) => events.forEach((event) => {
        const key = [
            event.eventType,
            event.startYear,
            event.endYear,
            event.topYear,
            event.shiftYears,
        ].join(":");
        if (!deduplicated.has(key)) {
            deduplicated.set(key, { event, stage, stagePriority: priority });
        }
    }));
    return [...deduplicated.values()];
};

const safeWindowWidth = (
    requestedWidth: number,
    availableWidth: number,
    allowedWidths: readonly number[],
): number | null => allowedWidths
    .slice()
    .sort((left, right) => left - right)
    .find((width) => width >= requestedWidth && width <= availableWidth)
    ?? null;

const centeredWindow = (
    topYear: number,
    width: number,
    minimumYear: number,
    maximumYear: number,
): { startYear: number; endYear: number } => {
    let startYear = topYear - Math.floor((width - 1) / 2);
    startYear = Math.max(minimumYear, Math.min(startYear, maximumYear - width + 1));
    return { startYear, endYear: startYear + width - 1 };
};

const recoveredEvent = (
    audit: DiagnosisEventDecisionAudit,
    selected: StagedEvent,
    config: ReviewWindowDisplayConfig,
): DiagnosisEvent | null => {
    const range = audit.targetRange;
    const topYear = selected.event.topYear;
    if (!range || topYear === null) return null;
    const availableWidth = range.endYear - range.startYear + 1;
    const sourceWidth = selected.event.endYear - selected.event.startYear + 1;
    const width = safeWindowWidth(
        sourceWidth,
        availableWidth,
        config.allowedWindowWidths,
    );
    if (width === null) return null;
    const window = centeredWindow(topYear, width, range.startYear, range.endYear);
    const years = Array.from(
        { length: width },
        (_, index) => window.startYear + index,
    ).sort((left, right) => (
        Math.abs(left - topYear) - Math.abs(right - topYear)
        || right - left
    ));
    return {
        id: [
            "diagnosis-review",
            audit.seriesId,
            selected.event.eventType,
            window.startYear,
            window.endYear,
        ].join("-"),
        seriesId: audit.seriesId,
        eventType: selected.event.eventType,
        ...window,
        rankedYears: years.map((year, index) => ({
            year,
            rank: index + 1,
            score: selected.event.score - Math.abs(year - topYear) * 0.01,
            evidenceTags: [
                "review_window_display_recovery",
                ...(year === topYear ? ["review_window_top_year"] : []),
            ],
        })),
        confidenceLevel: "low",
        evidence: {
            algorithmSources: Array.from(new Set([
                ...selected.event.algorithmSources,
                "review_window_display_recovery",
            ])).sort(),
            score: selected.event.score,
            scoreMargin: selected.event.scoreMargin,
            baselineCorrelation: selected.event.baselineCorrelation,
            correctedCorrelation: selected.event.correctedCorrelation,
            correlationGain: selected.event.correlationGain,
            lagBefore: selected.event.lagBefore,
            lagAfter: selected.event.lagAfter,
            samplePairs: selected.event.samplePairs,
            candidateIds: [],
            notes: Array.from(new Set([
                ...selected.event.notes,
                "review_only=true",
                `review_recovery_stage=${selected.stage}`,
                `strict_refusal_reason=${audit.finalReason}`,
            ])),
        },
        alternativeTypes: [],
        seriesRange: { ...range },
        reviewOnly: true,
    };
};

const refused = (
    audit: DiagnosisEventDecisionAudit,
    reason: DiagnosisReviewWindowDecision["reason"],
): DiagnosisReviewWindowDecision => ({
    seriesId: audit.seriesId,
    status: "refused",
    reason,
    strictReason: audit.finalReason,
    sourceStage: null,
    event: null,
});

export const selectReviewWindowDisplay = (
    audit: DiagnosisEventDecisionAudit,
    strictEvents: readonly DiagnosisEvent[],
    overrides: Partial<ReviewWindowDisplayConfig> = {},
): DiagnosisReviewWindowDecision => {
    const config = { ...DEFAULT_REVIEW_WINDOW_DISPLAY_CONFIG, ...overrides };
    const strict = strictEvents[0] ?? null;
    if (strict) {
        return {
            seriesId: audit.seriesId,
            status: "strict",
            reason: "strict_event",
            strictReason: audit.finalReason,
            sourceStage: "final",
            event: strict,
        };
    }
    if (audit.finalReason === "older_endpoint_context") {
        return refused(audit, "endpoint_context_insufficient");
    }
    if (!audit.cofechaFlagged) {
        return refused(audit, "cofecha_target_unflagged");
    }
    if (audit.referenceSourceCount < config.minimumReferenceSources
        || audit.medianReferenceDepth < config.minimumMedianReferenceDepth) {
        return refused(audit, "insufficient_reference_support");
    }

    const allUnitEvents = stagedEvents(audit).filter(({ event }) => isUnitEvent(event));
    if (allUnitEvents.length === 0) return refused(audit, "no_unit_hypothesis");
    const directed = allUnitEvents.filter(({ event }) => hasConsistentUnitDirection(event));
    if (directed.length === 0) return refused(audit, "lag_direction_conflict");
    directed.sort((left, right) => (
        eventStrength(right) - eventStrength(left)
        || centerYear(right.event) - centerYear(left.event)
    ));
    const selected = directed[0];
    const selectedStrength = eventStrength(selected);
    const operationCompetitor = directed.find(({ event }) => (
        event.eventType !== selected.event.eventType
    ));
    if (operationCompetitor
        && selectedStrength - eventStrength(operationCompetitor)
            < config.minimumOperationStrengthMargin) {
        return refused(audit, "operation_type_conflict");
    }
    const remoteCompetitor = directed.find(({ event }) => (
        event.eventType === selected.event.eventType
        && Math.abs(centerYear(event) - centerYear(selected.event))
            > config.remoteModeDistanceYears
    ));
    if (remoteCompetitor
        && selectedStrength - eventStrength(remoteCompetitor)
            < config.minimumRemoteModeStrengthMargin) {
        return refused(audit, "competing_remote_modes");
    }
    const event = recoveredEvent(audit, selected, config);
    if (!event) return refused(audit, "window_width_unsafe");
    return {
        seriesId: audit.seriesId,
        status: "review",
        reason: "lower_display_gate_passed",
        strictReason: audit.finalReason,
        sourceStage: selected.stage,
        event,
    };
};

export const buildReviewWindowDisplays = (
    audits: readonly DiagnosisEventDecisionAudit[],
    strictEvents: readonly DiagnosisEvent[],
    overrides: Partial<ReviewWindowDisplayConfig> = {},
): {
    decisions: DiagnosisReviewWindowDecision[];
    events: DiagnosisEvent[];
} => {
    const strictBySeries = new Map<string, DiagnosisEvent[]>();
    strictEvents.forEach((event) => {
        const group = strictBySeries.get(event.seriesId) ?? [];
        group.push(event);
        strictBySeries.set(event.seriesId, group);
    });
    const decisions = audits.map((audit) => selectReviewWindowDisplay(
        audit,
        strictBySeries.get(audit.seriesId) ?? [],
        overrides,
    ));
    return {
        decisions,
        events: decisions.flatMap((decision) => decision.event ? [decision.event] : []),
    };
};
