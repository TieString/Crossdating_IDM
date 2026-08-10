/**
 * Single immutable event-hypothesis adjudicator. Evidence extractors submit complete events;
 * this module selects one operation x shift x location hypothesis without rebuilding fields.
 */
import {
    evidenceClaimsFor,
    locationEvidenceFor,
    withEvidenceLedger,
} from "./evidenceLedger";
import type {
    DiagnosisEvidenceClaim,
    DiagnosisEvent,
    DiagnosisJointEventDecision,
    DiagnosisJointHypothesisSummary,
    DiagnosisJointProductionAgreement,
    DiagnosisReviewEventCheckpoint,
    DiagnosisReviewSourceStage,
} from "./types";

type HypothesisCluster = {
    checkpoints: DiagnosisReviewEventCheckpoint[];
};

type OperationGroup = {
    clusters: HypothesisCluster[];
};

export type JointEventAdjudicationConfig = {
    minimumOperationMargin: number;
    minimumRemoteModeMargin: number;
    remoteModeDistanceYears: number;
};

export const DEFAULT_JOINT_EVENT_ADJUDICATION_CONFIG: JointEventAdjudicationConfig = {
    minimumOperationMargin: 0.04,
    minimumRemoteModeMargin: 0.04,
    remoteModeDistanceYears: 13,
};

const stagePriority: Record<DiagnosisReviewSourceStage, number> = {
    candidate: 1,
    detected: 2,
    fused: 3,
    retained: 4,
    displayed: 5,
    final: 6,
};

const topYear = (event: DiagnosisEvent): number | null => (
    [...event.rankedYears].sort((left, right) => (
        left.rank - right.rank || right.score - left.score || right.year - left.year
    ))[0]?.year ?? null
);

const sameOperation = (left: DiagnosisEvent, right: DiagnosisEvent): boolean => (
    left.eventType === right.eventType
    && (
        left.eventType === "missingRing"
        || left.eventType === "falseRing"
        || (left.shiftYears ?? null) === (right.shiftYears ?? null)
    )
);

const windowsOverlap = (left: DiagnosisEvent, right: DiagnosisEvent): boolean => (
    Math.max(left.startYear, right.startYear)
        <= Math.min(left.endYear, right.endYear)
);

const sameLocationMode = (left: DiagnosisEvent, right: DiagnosisEvent): boolean => {
    if (left.eventType === "wholeSeriesMove"
        || right.eventType === "wholeSeriesMove") {
        return left.eventType === right.eventType;
    }
    if (windowsOverlap(left, right)) return true;
    const leftTop = topYear(left);
    const rightTop = topYear(right);
    return leftTop !== null && rightTop !== null
        && Math.abs(leftTop - rightTop) <= 4;
};

const confidenceScore = (event: DiagnosisEvent): number => (
    event.confidenceLevel === "high" ? 1 : event.confidenceLevel === "medium" ? 0.6 : 0.2
);

const matchingLocationEvidence = (event: DiagnosisEvent) => locationEvidenceFor(event)
    .filter((entry) => (
        entry.startYear === event.startYear && entry.endYear === event.endYear
    ));

const boundedQuality = (value: number | null, scale: number): number => (
    value === null || !Number.isFinite(value)
        ? 0
        : Math.max(0, Math.min(1, value / scale))
);

const eventLocationQuality = (event: DiagnosisEvent): number => {
    const entries = matchingLocationEvidence(event);
    if (entries.length === 0) return 0;
    return Math.max(...entries.map((entry) => (
        0.35 * boundedQuality(entry.concentration, 0.7)
        + 0.3 * boundedQuality(entry.remoteMargin, 0.1)
        + 0.25 * boundedQuality(entry.referenceCount, 8)
        + (entry.calibrated ? 0.1 : 0)
    )));
};

const claimWeight: Record<DiagnosisEvidenceClaim, number> = {
    explicit_missing_staircase: 1,
    independent_reference_staircase: 0.9,
    fixed_side_resolution: 1,
    joint_operation: 0.8,
    continuous_gap_consensus: 0.9,
    whole_global_lag: 0.6,
};

const claimStrength = (events: readonly DiagnosisEvent[]): number => Math.max(
    0,
    ...events.flatMap((event) => [...evidenceClaimsFor(event)].map((claim) => (
        claimWeight[claim]
    ))),
);

const representativeQuality = (
    checkpoint: DiagnosisReviewEventCheckpoint,
): number => (
    stagePriority[checkpoint.stage] / 6 * 0.55
    + confidenceScore(checkpoint.event) * 0.2
    + eventLocationQuality(checkpoint.event) * 0.25
);

const representative = (
    cluster: HypothesisCluster,
): DiagnosisReviewEventCheckpoint => [...cluster.checkpoints].sort((left, right) => (
    representativeQuality(right) - representativeQuality(left)
    || stagePriority[right.stage] - stagePriority[left.stage]
    || (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
        - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
))[0];

const locationScore = (cluster: HypothesisCluster): number => {
    const selected = representative(cluster);
    const supportStages = new Set(cluster.checkpoints.map(({ stage }) => stage));
    const maxStage = Math.max(...[...supportStages].map((stage) => stagePriority[stage]));
    return maxStage / 6 * 0.55
        + supportStages.size / 6 * 0.1
        + claimStrength(cluster.checkpoints.map(({ event }) => event)) * 0.15
        + eventLocationQuality(selected.event) * 0.15
        + confidenceScore(selected.event) * 0.05;
};

const clusterId = (cluster: HypothesisCluster): string => {
    const selected = representative(cluster).event;
    return [selected.seriesId, selected.eventType, selected.shiftYears ?? "unit",
        selected.startYear, selected.endYear, topYear(selected) ?? "none"].join(":");
};

const summary = (cluster: HypothesisCluster): DiagnosisJointHypothesisSummary => {
    const selected = representative(cluster);
    const event = selected.event;
    return {
        id: clusterId(cluster),
        eventType: event.eventType,
        shiftYears: event.shiftYears ?? null,
        startYear: event.startYear,
        endYear: event.endYear,
        topYear: topYear(event),
        sourceStage: selected.stage,
        supportStages: [...new Set(cluster.checkpoints.map(({ stage }) => stage))]
            .sort((left, right) => stagePriority[right] - stagePriority[left]),
        claimCount: new Set(cluster.checkpoints.flatMap(({ event: candidate }) => (
            [...evidenceClaimsFor(candidate)]
        ))).size,
        locationEvidenceCount: matchingLocationEvidence(event).length,
        score: locationScore(cluster),
    };
};

const deduplicateCheckpoints = (
    checkpoints: readonly DiagnosisReviewEventCheckpoint[],
): DiagnosisReviewEventCheckpoint[] => {
    const selected = new Map<string, DiagnosisReviewEventCheckpoint>();
    checkpoints.forEach((checkpoint) => {
        const event = checkpoint.event;
        const key = [checkpoint.stage, event.eventType, event.shiftYears ?? "unit",
            event.startYear, event.endYear, topYear(event) ?? "none"].join(":");
        if (!selected.has(key)) {
            selected.set(key, {
                stage: checkpoint.stage,
                event: withEvidenceLedger(event),
            });
        }
    });
    return [...selected.values()];
};

const clusterCheckpoints = (
    checkpoints: readonly DiagnosisReviewEventCheckpoint[],
): HypothesisCluster[] => {
    const clusters: HypothesisCluster[] = [];
    deduplicateCheckpoints(checkpoints)
        .sort((left, right) => stagePriority[right.stage] - stagePriority[left.stage])
        .forEach((checkpoint) => {
            const cluster = clusters.find((candidate) => {
                const current = representative(candidate).event;
                return sameOperation(current, checkpoint.event)
                    && sameLocationMode(current, checkpoint.event);
            });
            if (cluster) cluster.checkpoints.push(checkpoint);
            else clusters.push({ checkpoints: [checkpoint] });
        });
    return clusters;
};

const operationKey = (event: DiagnosisEvent): string => [
    event.eventType,
    event.eventType === "missingRing" || event.eventType === "falseRing"
        ? "unit"
        : event.shiftYears ?? "none",
].join(":");

const operationContractValid = (event: DiagnosisEvent): boolean => {
    if (event.eventType !== "missingRing" && event.eventType !== "falseRing") {
        return true;
    }
    const { lagBefore, lagAfter } = event.evidence;
    if (lagBefore === null || lagAfter === null) return false;
    const transition = lagAfter - lagBefore;
    return event.eventType === "missingRing" ? transition > 0 : transition < 0;
};

const groupOperations = (clusters: readonly HypothesisCluster[]): OperationGroup[] => {
    const groups = new Map<string, OperationGroup>();
    clusters.forEach((cluster) => {
        const key = operationKey(representative(cluster).event);
        const group = groups.get(key) ?? { clusters: [] };
        group.clusters.push(cluster);
        groups.set(key, group);
    });
    return [...groups.values()];
};

const operationScore = (group: OperationGroup): number => {
    const checkpoints = group.clusters.flatMap((cluster) => cluster.checkpoints);
    const supportStages = new Set(checkpoints.map(({ stage }) => stage));
    const maxStage = Math.max(...[...supportStages].map((stage) => stagePriority[stage]));
    const confidence = Math.max(...checkpoints.map(({ event }) => confidenceScore(event)));
    return maxStage / 6 * 0.5
        + supportStages.size / 6 * 0.1
        + claimStrength(checkpoints.map(({ event }) => event)) * 0.35
        + confidence * 0.05;
};

const productionAgreement = (
    selected: DiagnosisEvent | null,
    production: DiagnosisEvent | null,
): DiagnosisJointProductionAgreement => {
    if (!selected || !production) return selected === production
        ? "same"
        : "presence_mismatch";
    if (!sameOperation(selected, production)) return "operation_mismatch";
    return sameLocationMode(selected, production) ? "same" : "location_mismatch";
};

const productionExactMatch = (
    selected: DiagnosisEvent | null,
    production: DiagnosisEvent | null,
): boolean => {
    if (!selected || !production) return selected === production;
    return sameOperation(selected, production)
        && selected.startYear === production.startYear
        && selected.endYear === production.endYear
        && topYear(selected) === topYear(production);
};

export const adjudicateJointEventHypotheses = (
    seriesId: string,
    checkpoints: readonly DiagnosisReviewEventCheckpoint[],
    productionEvent: DiagnosisEvent | null = null,
    overrides: Partial<JointEventAdjudicationConfig> = {},
): DiagnosisJointEventDecision => {
    const config = { ...DEFAULT_JOINT_EVENT_ADJUDICATION_CONFIG, ...overrides };
    const submitted = checkpoints.filter(({ event }) => (
        event.seriesId === seriesId
    ));
    const submittedClusters = clusterCheckpoints(submitted);
    const hypotheses = submittedClusters.map(summary);
    const clusters = clusterCheckpoints(submitted.filter(({ event }) => (
        operationContractValid(event)
    ))).sort((left, right) => (
        locationScore(right) - locationScore(left)
        || stagePriority[representative(right).stage]
            - stagePriority[representative(left).stage]
        || clusterId(left).localeCompare(clusterId(right))
    ));
    if (clusters.length === 0) {
        return {
            seriesId,
            status: "refused",
            reason: submittedClusters.length > 0
                ? "operation_contract_conflict"
                : "no_complete_hypothesis",
            sourceStage: null,
            event: null,
            hypotheses,
            operationMargin: null,
            remoteModeMargin: null,
            productionAgreement: productionAgreement(null, productionEvent),
            productionExactMatch: productionExactMatch(null, productionEvent),
        };
    }

    const operationGroups = groupOperations(clusters).sort((left, right) => (
        operationScore(right) - operationScore(left)
        || operationKey(representative(left.clusters[0]).event).localeCompare(
            operationKey(representative(right.clusters[0]).event),
        )
    ));
    const winningOperation = operationGroups[0];
    const operationCompetitor = operationGroups[1] ?? null;
    const operationMargin = operationCompetitor
        ? operationScore(winningOperation) - operationScore(operationCompetitor)
        : null;
    if (operationMargin !== null
        && operationMargin < config.minimumOperationMargin) {
        return {
            seriesId,
            status: "refused",
            reason: "operation_conflict",
            sourceStage: null,
            event: null,
            hypotheses,
            operationMargin,
            remoteModeMargin: null,
            productionAgreement: productionAgreement(null, productionEvent),
            productionExactMatch: productionExactMatch(null, productionEvent),
        };
    }

    const operationClusters = [...winningOperation.clusters].sort((left, right) => (
        locationScore(right) - locationScore(left)
        || stagePriority[representative(right).stage]
            - stagePriority[representative(left).stage]
        || clusterId(left).localeCompare(clusterId(right))
    ));
    const winner = operationClusters[0];
    const winnerCheckpoint = representative(winner);
    const winnerEvent = winnerCheckpoint.event;
    const winnerScore = locationScore(winner);
    const remoteCompetitor = operationClusters.find((cluster) => {
        if (cluster === winner) return false;
        const event = representative(cluster).event;
        const winnerTop = topYear(winnerEvent);
        const candidateTop = topYear(event);
        return sameOperation(winnerEvent, event)
            && winnerTop !== null
            && candidateTop !== null
            && Math.abs(winnerTop - candidateTop) > config.remoteModeDistanceYears;
    });
    const remoteModeMargin = remoteCompetitor
        ? winnerScore - locationScore(remoteCompetitor)
        : null;
    const reason = remoteModeMargin !== null
        && remoteModeMargin < config.minimumRemoteModeMargin
        ? "remote_mode_conflict"
        : "selected";
    const selectedEvent = reason === "selected" ? winnerEvent : null;
    return {
        seriesId,
        status: selectedEvent ? "selected" : "refused",
        reason,
        sourceStage: selectedEvent ? winnerCheckpoint.stage : null,
        event: selectedEvent,
        hypotheses,
        operationMargin,
        remoteModeMargin,
        productionAgreement: productionAgreement(selectedEvent, productionEvent),
        productionExactMatch: productionExactMatch(selectedEvent, productionEvent),
    };
};

/** Adds an audit-only comparison without changing the selected hypothesis. */
export const compareJointDecisionToProduction = (
    decision: DiagnosisJointEventDecision,
    productionEvent: DiagnosisEvent | null,
): DiagnosisJointEventDecision => ({
    ...decision,
    productionAgreement: productionAgreement(decision.event, productionEvent),
    productionExactMatch: productionExactMatch(decision.event, productionEvent),
});
