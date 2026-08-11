/**
 * Single immutable event-hypothesis adjudicator. Evidence extractors submit complete events;
 * this module selects one operation x shift x location hypothesis without rebuilding fields.
 */
import {
    evidenceClaimsFor,
    locationEvidenceFor,
    withEvidenceLedger,
} from "./evidenceLedger";
import { attachEndpointWholeMissingInterpretation } from "./endpointWholeMissingInterpretation";
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

const eventHasIndependentLocationAuthority = (event: DiagnosisEvent): boolean => {
    const claims = evidenceClaimsFor(event);
    if (claims.has("independent_reference_staircase")
        || claims.has("fixed_side_resolution")
        || claims.has("endpoint_unit_resolution")) {
        return true;
    }
    return matchingLocationEvidence(event).some((entry) => (
        entry.calibrated
        || (
            entry.referenceCount >= 3
            && (entry.concentration ?? 0) >= 0.2
            && (entry.remoteMargin ?? 0) >= 0.04
        )
    ));
};

const claimWeight: Record<DiagnosisEvidenceClaim, number> = {
    explicit_missing_staircase: 1,
    whole_baseline_exhausted_by_missing_staircase: 1,
    independent_reference_staircase: 0.9,
    fixed_side_resolution: 1,
    endpoint_unit_resolution: 1,
    joint_operation: 0.8,
    continuous_gap_consensus: 0.9,
    whole_global_lag: 0.6,
    whole_terminal_baseline: 0.9,
};

const claimStrength = (events: readonly DiagnosisEvent[]): number => Math.max(
    0,
    ...events.flatMap((event) => [...evidenceClaimsFor(event)].map((claim) => (
        claimWeight[claim]
    ))),
);

const samePersistedLocation = (left: DiagnosisEvent, right: DiagnosisEvent): boolean => {
    if (!sameOperation(left, right)) return false;
    if (left.eventType === "wholeSeriesMove") return true;
    const leftTop = topYear(left);
    const rightTop = topYear(right);
    return windowsOverlap(left, right)
        && leftTop !== null
        && rightTop !== null
        && Math.abs(leftTop - rightTop) <= 2;
};

const persistedStageCount = (
    cluster: HypothesisCluster,
    checkpoint: DiagnosisReviewEventCheckpoint,
): number => new Set(cluster.checkpoints.filter((candidate) => (
    samePersistedLocation(checkpoint.event, candidate.event)
)).map(({ stage }) => stage)).size;

const representativeQuality = (
    cluster: HypothesisCluster,
    checkpoint: DiagnosisReviewEventCheckpoint,
): number => (
    stagePriority[checkpoint.stage] / 6 * 0.4
    + persistedStageCount(cluster, checkpoint) / 6 * 0.3
    + confidenceScore(checkpoint.event) * 0.1
    + eventLocationQuality(checkpoint.event) * 0.2
);

const eventWidth = (event: DiagnosisEvent): number => (
    event.endYear - event.startYear + 1
);

const preferredSequentialSupport = (
    cluster: HypothesisCluster,
    selected: DiagnosisReviewEventCheckpoint,
): DiagnosisReviewEventCheckpoint | null => {
    const event = selected.event;
    if (selected.stage !== "final"
        || (event.eventType !== "missingRing" && event.eventType !== "falseRing")
        || eventWidth(event) !== 5
        || !event.evidence.algorithmSources.includes("sequential_missing_staircase_head")
        || eventHasIndependentLocationAuthority(event)) return null;
    return cluster.checkpoints.filter((checkpoint) => {
        const support = checkpoint.event;
        const width = eventWidth(support);
        const supportTop = topYear(support);
        const selectedTop = topYear(event);
        return stagePriority[checkpoint.stage] >= stagePriority.detected
            && checkpoint.stage !== "final"
            && sameOperation(support, event)
            && width > 5
            && width <= 9
            && support.startYear <= event.startYear
            && support.endYear >= event.endYear
            && supportTop !== null
            && selectedTop !== null
            && Math.abs(supportTop - selectedTop) <= 2;
    }).sort((left, right) => (
        eventWidth(left.event) - eventWidth(right.event)
        || stagePriority[right.stage] - stagePriority[left.stage]
    ))[0] ?? null;
};

const preferredEndpointCandidate = (
    cluster: HypothesisCluster,
    selected: DiagnosisReviewEventCheckpoint,
): DiagnosisReviewEventCheckpoint | null => {
    const event = selected.event;
    if (selected.stage !== "final"
        || event.eventType !== "missingRing"
        || !event.evidence.algorithmSources.includes(
            "newer_endpoint_unit_alias_of_global_lag",
        )) return null;
    return cluster.checkpoints.filter((checkpoint) => {
        const candidate = checkpoint.event;
        const candidateTop = topYear(candidate);
        const selectedTop = topYear(event);
        return checkpoint.stage === "candidate"
            && candidate.eventType === "missingRing"
            && candidate.evidence.notes.includes("candidate_hard_gate_passed")
            && candidate.evidence.algorithmSources.includes("candidate_ranking")
            && candidate.endYear > event.endYear
            && windowsOverlap(candidate, event)
            && candidateTop !== null
            && selectedTop !== null
            && candidateTop > selectedTop
            && candidateTop - selectedTop <= 4;
    }).sort((left, right) => (
        (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
        || right.event.endYear - left.event.endYear
    ))[0] ?? null;
};

const representative = (
    cluster: HypothesisCluster,
): DiagnosisReviewEventCheckpoint => {
    const selected = [...cluster.checkpoints].sort((left, right) => (
        representativeQuality(cluster, right) - representativeQuality(cluster, left)
        || persistedStageCount(cluster, right) - persistedStageCount(cluster, left)
        || stagePriority[right.stage] - stagePriority[left.stage]
        || (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
    ))[0];
    return preferredEndpointCandidate(cluster, selected)
        ?? preferredSequentialSupport(cluster, selected)
        ?? selected;
};

const hasIndependentLocationAuthority = (cluster: HypothesisCluster): boolean => (
    cluster.checkpoints.some(({ event }) => eventHasIndependentLocationAuthority(event))
);

const locationScore = (cluster: HypothesisCluster): number => {
    const selected = representative(cluster);
    const supportStages = new Set(cluster.checkpoints.map(({ stage }) => stage));
    const maxStage = Math.max(...[...supportStages].map((stage) => stagePriority[stage]));
    return maxStage / 6 * 0.35
        + supportStages.size / 6 * 0.35
        + (hasIndependentLocationAuthority(cluster) ? 0.2 : 0)
        + eventLocationQuality(selected.event) * 0.07
        + confidenceScore(selected.event) * 0.03;
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

const isHardGatedUnitLocationCheckpoint = (event: DiagnosisEvent): boolean => (
    (event.eventType === "missingRing" || event.eventType === "falseRing")
    && event.evidence.notes.includes("candidate_hard_gate_passed")
    && event.evidence.algorithmSources.some((source) => (
        source === "candidate_ranking"
        || source === "candidate_frontier_checkpoint"
        || source === "cofecha_boundary_checkpoint"
    ))
);

const hasPersistedDisplayedUnitLocation = (
    checkpoint: DiagnosisReviewEventCheckpoint,
    submitted: readonly DiagnosisReviewEventCheckpoint[],
): boolean => {
    if (!isHardGatedUnitLocationCheckpoint(checkpoint.event)) return false;
    const matches = (candidate: DiagnosisReviewEventCheckpoint): boolean => (
        isHardGatedUnitLocationCheckpoint(candidate.event)
        && samePersistedLocation(checkpoint.event, candidate.event)
    );
    return submitted.some((candidate) => candidate.stage === "candidate" && matches(candidate))
        && submitted.some((candidate) => candidate.stage === "displayed" && matches(candidate));
};

const operationContractValid = (
    checkpoint: DiagnosisReviewEventCheckpoint,
    submitted: readonly DiagnosisReviewEventCheckpoint[],
): boolean => {
    const { event } = checkpoint;
    if (event.eventType !== "missingRing" && event.eventType !== "falseRing") {
        return true;
    }
    const { lagBefore, lagAfter } = event.evidence;
    if (lagBefore === null || lagAfter === null) return false;
    const transition = lagAfter - lagBefore;
    if (event.eventType === "missingRing" ? transition > 0 : transition < 0) {
        return true;
    }
    const claims = evidenceClaimsFor(event);
    if (event.eventType === "missingRing"
        && (
            claims.has("fixed_side_resolution")
            || claims.has("endpoint_unit_resolution")
        )) {
        return true;
    }
    const protectedCandidateCheckpoint = event.evidence.notes.includes(
        "candidate_hard_gate_passed",
    ) && event.evidence.algorithmSources.some((source) => (
        source === "candidate_frontier_checkpoint"
        || source === "cofecha_boundary_checkpoint"
    ));
    return (
        protectedCandidateCheckpoint
        && lagBefore === lagAfter
        && (event.eventType === "missingRing" ? lagBefore < 0 : lagBefore > 0)
    )
        || hasPersistedDisplayedUnitLocation(checkpoint, submitted);
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

const hasFinalCheckpoint = (cluster: HypothesisCluster): boolean => (
    cluster.checkpoints.some(({ stage }) => stage === "final")
);

const checkpointsWithFinalClaim = (
    cluster: HypothesisCluster,
    claims: ReadonlySet<DiagnosisEvidenceClaim>,
): DiagnosisReviewEventCheckpoint[] => cluster.checkpoints.filter((checkpoint) => (
    checkpoint.stage === "final"
    && [...evidenceClaimsFor(checkpoint.event)].some((claim) => claims.has(claim))
));

const retainFinalClaimAuthority = (
    cluster: HypothesisCluster,
    claims: ReadonlySet<DiagnosisEvidenceClaim>,
): HypothesisCluster | null => {
    const checkpoints = checkpointsWithFinalClaim(cluster, claims);
    if (checkpoints.length === 0) return null;
    const endpointAuthority = checkpoints.some(({ event }) => (
        evidenceClaimsFor(event).has("endpoint_unit_resolution")
    ));
    if (!endpointAuthority) return { checkpoints };
    const endpointLocationCheckpoints = cluster.checkpoints.filter((checkpoint) => (
        checkpoint.stage === "candidate"
        && checkpoint.event.eventType === "missingRing"
        && checkpoint.event.evidence.notes.includes("candidate_hard_gate_passed")
        && checkpoint.event.evidence.algorithmSources.includes("candidate_ranking")
        && checkpoints.some((authority) => (
            sameOperation(authority.event, checkpoint.event)
            && sameLocationMode(authority.event, checkpoint.event)
        ))
    ));
    return {
        checkpoints: [...checkpoints, ...endpointLocationCheckpoints],
    };
};

const ENDPOINT_REVIEW_WIDTHS = new Set([5, 7, 9, 13]);
const ENDPOINT_MISSING_CLAIMS = new Set<DiagnosisEvidenceClaim>([
    "endpoint_unit_resolution",
    "fixed_side_resolution",
    "explicit_missing_staircase",
    "independent_reference_staircase",
    "whole_baseline_exhausted_by_missing_staircase",
]);

const endpointMissingAuthority = (event: DiagnosisEvent): number => {
    const claims = evidenceClaimsFor(event);
    if (claims.has("whole_baseline_exhausted_by_missing_staircase")) return 5;
    if (claims.has("endpoint_unit_resolution")) return 4;
    if (claims.has("fixed_side_resolution")) return 3;
    if (claims.has("independent_reference_staircase")) return 2;
    if (claims.has("explicit_missing_staircase")) return 1;
    const independentlyReviewedUnit = event.evidence.algorithmSources.includes(
        "sequential_missing_staircase_head",
    ) || event.evidence.notes.includes("candidate_hard_gate_passed");
    return independentlyReviewedUnit
        && event.evidence.lagBefore === -1
        && event.evidence.lagAfter === 0
        ? 0
        : -1;
};

const selectEndpointMissingInterpretation = (
    clusters: readonly HypothesisCluster[],
    whole: DiagnosisEvent,
): DiagnosisEvent | null => {
    if (whole.eventType !== "wholeSeriesMove" || whole.shiftYears !== -1) return null;
    return clusters.flatMap((cluster) => cluster.checkpoints)
        .filter((checkpoint) => checkpoint.stage === "final")
        .map(({ event }) => event)
        .filter((event) => {
            if (event.eventType !== "missingRing") return false;
            const width = event.endYear - event.startYear + 1;
            const endpointDistance = whole.endYear - event.endYear;
            return ENDPOINT_REVIEW_WIDTHS.has(width)
                && endpointDistance >= 0
                && endpointDistance <= 29
                && endpointMissingAuthority(event) >= 0;
        })
        .sort((left, right) => (
            endpointMissingAuthority(right) - endpointMissingAuthority(left)
            || confidenceScore(right) - confidenceScore(left)
            || right.endYear - left.endYear
            || (topYear(right) ?? Number.NEGATIVE_INFINITY)
                - (topYear(left) ?? Number.NEGATIVE_INFINITY)
        ))[0] ?? null;
};

const isProtectedCandidateFrontier = (cluster: HypothesisCluster): boolean => (
    cluster.checkpoints.some(({ event }) => (
        (event.eventType === "missingRing" || event.eventType === "falseRing")
        && event.evidence.notes.includes("candidate_hard_gate_passed")
        && event.evidence.algorithmSources.some((source) => (
            source === "candidate_frontier_checkpoint"
            || source === "cofecha_boundary_checkpoint"
        ))
    ))
);

const finalFrontierClusters = (
    clusters: readonly HypothesisCluster[],
    config: JointEventAdjudicationConfig,
): HypothesisCluster[] | null => {
    const finalClusters = clusters.filter(hasFinalCheckpoint);
    if (finalClusters.length === 0) return null;
    const protectedWholeClusters = clusters.filter((cluster) => {
        const event = representative(cluster).event;
        return event.eventType === "wholeSeriesMove"
            && evidenceClaimsFor(event).has("whole_terminal_baseline");
    });
    const wholeClusters = finalClusters.filter((cluster) => (
        representative(cluster).event.eventType === "wholeSeriesMove"
    ));
    const localClusters = finalClusters.filter((cluster) => (
        representative(cluster).event.eventType !== "wholeSeriesMove"
    ));
    if (protectedWholeClusters.length > 0) {
        const decisiveClaims = new Set<DiagnosisEvidenceClaim>([
            "fixed_side_resolution",
            "endpoint_unit_resolution",
            "independent_reference_staircase",
            "whole_baseline_exhausted_by_missing_staircase",
        ]);
        const decisiveLocal = localClusters.flatMap((cluster) => {
            const authoritative = retainFinalClaimAuthority(cluster, decisiveClaims);
            return authoritative ? [authoritative] : [];
        });
        return decisiveLocal.length > 0
            ? decisiveLocal
            : protectedWholeClusters;
    }
    if (wholeClusters.length > 0) {
        const decisiveClaims = new Set<DiagnosisEvidenceClaim>([
            "fixed_side_resolution",
            "endpoint_unit_resolution",
            "explicit_missing_staircase",
            "independent_reference_staircase",
        ]);
        const decisiveLocal = localClusters.flatMap((cluster) => {
            const authoritative = retainFinalClaimAuthority(cluster, decisiveClaims);
            return authoritative ? [authoritative] : [];
        });
        return decisiveLocal.length > 0 ? decisiveLocal : wholeClusters;
    }
    const protectedCandidate = clusters
        .filter((cluster) => !hasFinalCheckpoint(cluster))
        .filter(isProtectedCandidateFrontier)
        .filter((cluster) => localClusters.some((finalCluster) => {
            if (hasIndependentLocationAuthority(finalCluster)) return false;
            const candidate = representative(cluster).event;
            const finalEvent = representative(finalCluster).event;
            const candidateTop = topYear(candidate);
            const finalTop = topYear(finalEvent);
            return sameOperation(candidate, finalEvent)
                && candidateTop !== null
                && finalTop !== null
                && candidateTop - finalTop > config.remoteModeDistanceYears;
        }))
        .sort((left, right) => (
            stagePriority[representative(right).stage]
                - stagePriority[representative(left).stage]
            || locationScore(right) - locationScore(left)
            || (topYear(representative(right).event) ?? Number.NEGATIVE_INFINITY)
                - (topYear(representative(left).event) ?? Number.NEGATIVE_INFINITY)
        ))[0];
    if (protectedCandidate) return [protectedCandidate];
    if (localClusters.length <= 1) return localClusters;
    const newestYear = Math.max(...localClusters.map((cluster) => (
        topYear(representative(cluster).event) ?? Number.NEGATIVE_INFINITY
    )));
    return localClusters.filter((cluster) => {
        const year = topYear(representative(cluster).event);
        return year !== null
            && newestYear - year <= config.remoteModeDistanceYears;
    });
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
    const clusters = clusterCheckpoints(submitted.filter((checkpoint) => (
        operationContractValid(checkpoint, submitted)
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

    // Final output may contain several serial events. Only the newest local mode is the current
    // user-facing frontier; older modes stay immutable and are reconsidered after one edit.
    const frontierClusters = finalFrontierClusters(clusters, config) ?? clusters;
    const operationGroups = groupOperations(frontierClusters).sort((left, right) => (
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
    const baseSelectedEvent = reason === "selected" ? winnerEvent : null;
    const endpointMissing = baseSelectedEvent
        ? selectEndpointMissingInterpretation(clusters, baseSelectedEvent)
        : null;
    const selectedEvent = baseSelectedEvent && endpointMissing
        ? attachEndpointWholeMissingInterpretation(
            baseSelectedEvent,
            endpointMissing,
            {
                wholeShiftYears: -1,
                endpointDistanceYears: baseSelectedEvent.endYear - endpointMissing.endYear,
                missingWindowWidth: (
                    endpointMissing.endYear - endpointMissing.startYear + 1
                ) as 5 | 7 | 9 | 13,
                operationScoreMargin: operationMargin,
                finalEvidenceClaims: [...evidenceClaimsFor(endpointMissing)]
                    .filter((claim) => ENDPOINT_MISSING_CLAIMS.has(claim))
                    .sort(),
            },
        )
        : baseSelectedEvent;
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
