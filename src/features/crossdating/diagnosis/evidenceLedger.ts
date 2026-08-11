/**
 * Typed, append-only evidence boundary for event adjudication. Legacy notes are interpreted
 * here once during migration; downstream decision layers consume semantic claims and records.
 */
import type {
    DiagnosisEvidenceClaim,
    DiagnosisEvidenceLedger,
    DiagnosisEvidenceLedgerEntry,
    DiagnosisEvent,
    DiagnosisLocationEvidenceEntry,
    DiagnosisOperationEvidenceEntry,
} from "./types";

const numberFromNotes = (
    event: DiagnosisEvent,
    prefixes: readonly string[],
): number | null => {
    for (const prefix of prefixes) {
        const note = [...event.evidence.notes].reverse().find((value) => (
            value.startsWith(prefix)
        ));
        const value = Number(note?.slice(prefix.length));
        if (Number.isFinite(value)) return value;
    }
    return null;
};

const evidenceTokens = (event: DiagnosisEvent): Set<string> => new Set([
    ...event.evidence.algorithmSources,
    ...event.evidence.notes,
]);

const hasToken = (tokens: ReadonlySet<string>, token: string): boolean => (
    tokens.has(token)
    || [...tokens].some((value) => value.startsWith(`${token}=`))
);

const operationClaims = (event: DiagnosisEvent): DiagnosisEvidenceClaim[] => {
    const tokens = evidenceTokens(event);
    const claims: DiagnosisEvidenceClaim[] = [];
    if (event.eventType === "missingRing" && (
        hasToken(tokens, "explicit_partial_vs_missing_staircase")
        || hasToken(tokens, "sequential_missing_staircase_head")
    )) {
        claims.push("explicit_missing_staircase");
    }
    if (event.eventType === "missingRing"
        && hasToken(tokens, "sequential_missing_exhausts_whole_baseline")) {
        claims.push("whole_baseline_exhausted_by_missing_staircase");
    }
    if (event.eventType === "missingRing" && (
        hasToken(tokens, "robust_per_reference_missing_staircase")
        || hasToken(tokens, "per_reference_intermediate_lag_consensus")
    )) {
        claims.push("independent_reference_staircase");
    }
    if (event.eventType === "missingRing"
        && hasToken(tokens, "newer_fixed_side_lag_contrast")
        && hasToken(tokens, "terminal_whole_alias_removed")) {
        claims.push("fixed_side_resolution");
    }
    if ((event.eventType === "missingRing" || event.eventType === "falseRing")
        && hasToken(tokens, "decisive_joint_operation_fusion")
        && hasToken(tokens, "joint_year_operation_evidence")) {
        claims.push("joint_operation");
    }
    if (event.eventType === "partialMove" && (
        hasToken(tokens, "negative_partial_multiview_consensus")
        || hasToken(tokens, "candidate_grid_reference_partial_consensus")
        || hasToken(tokens,
            "completed_partial_preferred_over_discrete_missing_staircase")
    )) {
        claims.push("continuous_gap_consensus");
    }
    if (event.eventType === "wholeSeriesMove"
        && hasToken(tokens, "whole_state_global_lag_matches_shift")
        && tokens.has("whole_state_global_lag_matches_shift=true")) {
        claims.push("whole_global_lag");
    }
    if (event.eventType === "wholeSeriesMove"
        && tokens.has("whole_baseline_source=cofecha_terminal_lag")
        && (numberFromNotes(event, ["cofecha_terminal_segments="]) ?? 0) >= 2
        && (numberFromNotes(event, ["cofecha_terminal_consistency="]) ?? 0) >= 0.9
        && (event.shiftYears ?? 0) !== 0) {
        claims.push("whole_terminal_baseline");
    }
    return claims;
};

const referenceCount = (event: DiagnosisEvent): number => Math.max(
    0,
    ...[
        "counterfactual_pair_reference_count=",
        "paired_breakpoint_reference_count=",
        "reference_vote_reference_count=",
        "partial_reference_vote_reference_count=",
        "completed_family_partial_reference_count=",
        "candidate_grid_partial_reference_count=",
    ].map((prefix) => numberFromNotes(event, [prefix]) ?? 0),
);

const entryKey = (entry: DiagnosisEvidenceLedgerEntry): string => {
    if (entry.kind === "presence") {
        return [entry.kind, entry.source, entry.score, entry.scoreMargin,
            entry.samplePairs].join(":");
    }
    if (entry.kind === "operation") {
        return [entry.kind, entry.source, entry.operationType, entry.shiftYears,
            entry.lagBefore, entry.lagAfter, entry.normalizedGain,
            ...entry.claims].join(":");
    }
    if (entry.kind === "reference") {
        return [entry.kind, entry.source, entry.referenceCount,
            entry.samplePairs].join(":");
    }
    return [entry.kind, entry.source, entry.startYear, entry.endYear,
        entry.topYear, entry.referenceCount, entry.concentration,
        entry.remoteMargin, entry.calibrated].join(":");
};

const deduplicate = (
    entries: readonly DiagnosisEvidenceLedgerEntry[],
): DiagnosisEvidenceLedgerEntry[] => {
    const selected = new Map<string, DiagnosisEvidenceLedgerEntry>();
    entries.forEach((entry) => selected.set(entryKey(entry), entry));
    return [...selected.values()];
};

const adaptedEntries = (event: DiagnosisEvent): DiagnosisEvidenceLedgerEntry[] => {
    const operation: DiagnosisOperationEvidenceEntry = {
        kind: "operation",
        source: "event_contract_adapter",
        operationType: event.eventType,
        shiftYears: event.shiftYears ?? null,
        lagBefore: event.evidence.lagBefore,
        lagAfter: event.evidence.lagAfter,
        normalizedGain: event.evidence.correlationGain,
        claims: operationClaims(event),
    };
    const locations: DiagnosisLocationEvidenceEntry[] = (
        event.evidence.locationEvidence ?? []
    ).map((entry) => ({ kind: "location", ...entry }));
    return [
        {
            kind: "presence",
            source: "event_contract_adapter",
            score: event.evidence.score,
            scoreMargin: event.evidence.scoreMargin,
            samplePairs: event.evidence.samplePairs,
        },
        operation,
        ...locations,
        {
            kind: "reference",
            source: "event_contract_adapter",
            referenceCount: referenceCount(event),
            samplePairs: event.evidence.samplePairs,
        },
    ];
};

export const evidenceLedgerFor = (event: DiagnosisEvent): DiagnosisEvidenceLedger => ({
    version: 1,
    entries: deduplicate([
        ...(event.evidence.ledger?.entries ?? []),
        ...adaptedEntries(event),
    ]),
});

export const withEvidenceLedger = (event: DiagnosisEvent): DiagnosisEvent => ({
    ...event,
    evidence: {
        ...event.evidence,
        ledger: evidenceLedgerFor(event),
    },
});

export const locationEvidenceFor = (
    event: DiagnosisEvent,
): DiagnosisLocationEvidenceEntry[] => evidenceLedgerFor(event).entries.filter(
    (entry): entry is DiagnosisLocationEvidenceEntry => entry.kind === "location",
);

export const operationEvidenceFor = (
    event: DiagnosisEvent,
): DiagnosisOperationEvidenceEntry[] => evidenceLedgerFor(event).entries.filter(
    (entry): entry is DiagnosisOperationEvidenceEntry => entry.kind === "operation",
);

export const evidenceClaimsFor = (event: DiagnosisEvent): Set<DiagnosisEvidenceClaim> => (
    new Set(operationEvidenceFor(event)
        .filter((entry) => entry.operationType === event.eventType)
        .flatMap((entry) => entry.claims))
);
