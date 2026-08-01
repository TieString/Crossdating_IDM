/** Independent paired-core breakpoint support for a single unit event. */
import { cofechaStyleStandardize } from "../reference";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    ar1WhitenSeries,
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import type { DiagnosisEvent, NumericSeries, SeriesCoreDiagnosis } from "./types";

type UnitEventType = "missingRing" | "falseRing";

type PreparedSeries = {
    raw: NumericSeries;
    difference: NumericSeries;
    whitened: NumericSeries;
    standardized: NumericSeries;
};

type PreparedReference = PreparedSeries & { baselineCorrelation: number };

export type PairedCoreBreakpoint = {
    year: number;
    score: number;
    remoteMargin: number;
    referenceCount: number;
};

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return preprocessSeries(result);
};

const prepare = (series: NumericSeries): PreparedSeries => ({
    raw: preprocessSeries(series),
    difference: firstDifferences(series),
    whitened: ar1WhitenSeries(series),
    standardized: new Map(cofechaStyleStandardize(series).map((point) => [
        point.year,
        point.value,
    ])),
});

const simulateCorrection = (
    series: NumericSeries,
    eventType: UnitEventType,
    year: number,
): NumericSeries => {
    const result = new Map<number, number>();
    series.forEach((value, sourceYear) => {
        if (eventType === "missingRing") {
            result.set(sourceYear <= year ? sourceYear - 1 : sourceYear, value);
        } else if (sourceYear !== year) {
            result.set(sourceYear < year ? sourceYear + 1 : sourceYear, value);
        }
    });
    return result;
};

const median = (values: number[]): number => {
    if (values.length === 0) return -1;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

const aggregateCorrelation = (
    target: NumericSeries,
    references: PreparedReference[],
    key: keyof PreparedSeries,
    startYear: number,
    endYear: number,
    minPairs: number,
): number => median(references
    .map((reference) => correlationForSegment(
        target,
        reference[key],
        startYear,
        endYear,
        0,
        minPairs,
    ).correlation)
    .filter((value): value is number => value !== null));

const huberLoss = (residual: number, transition = 1.5): number => {
    const absolute = Math.abs(residual);
    return absolute <= transition
        ? 0.5 * absolute * absolute
        : transition * (absolute - transition * 0.5);
};

const standardizedHuberSimilarity = (
    target: NumericSeries,
    reference: NumericSeries,
    startYear: number,
    endYear: number,
): number | null => {
    let pairs = 0;
    let loss = 0;
    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const referenceValue = reference.get(year);
        if (targetValue === undefined || referenceValue === undefined) continue;
        loss += huberLoss(targetValue - referenceValue);
        pairs += 1;
    }
    return pairs >= 30 ? -loss / pairs : null;
};

const pairedReferences = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    baseline: PreparedSeries,
): PreparedReference[] => {
    const targetStem = diagnosis.targetTree.slice(0, -1).toLowerCase();
    return diagnosis.master.sourceTrees
        .filter((tree) => tree.slice(0, -1).toLowerCase() === targetStem)
        .map((tree) => {
            const prepared = prepare(toNumericSeries(siteData.get(tree)));
            const baselineCorrelation = correlationForSegment(
                baseline.raw,
                prepared.raw,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
                0,
                30,
            ).correlation ?? -1;
            return { ...prepared, baselineCorrelation };
        })
        .filter((reference) => reference.baselineCorrelation > -0.25)
        .sort((a, b) => b.baselineCorrelation - a.baselineCorrelation)
        .slice(0, 4);
};

const scoreMissing = (
    corrected: PreparedSeries,
    references: PreparedReference[],
    diagnosis: SeriesCoreDiagnosis,
): number => median(references
    .map((reference) => standardizedHuberSimilarity(
        corrected.standardized,
        reference.standardized,
        diagnosis.targetRange.startYear,
        diagnosis.targetRange.endYear,
    ))
    .filter((value): value is number => value !== null));

const scoreFalse = (
    corrected: PreparedSeries,
    references: PreparedReference[],
    year: number,
): number => {
    const startYear = year - 15;
    const endYear = year + 15;
    const raw = aggregateCorrelation(corrected.raw, references, "raw", startYear, endYear, 16);
    const difference = aggregateCorrelation(
        corrected.difference,
        references,
        "difference",
        startYear,
        endYear,
        16,
    );
    const whitened = aggregateCorrelation(
        corrected.whitened,
        references,
        "whitened",
        startYear,
        endYear,
        16,
    );
    const standardized = aggregateCorrelation(
        corrected.standardized,
        references,
        "standardized",
        startYear,
        endYear,
        16,
    );
    return raw * 0.2 + difference * 0.35 + whitened * 0.2 + standardized * 0.25;
};

export const locatePairedCoreBreakpoint = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    eventType: UnitEventType,
): PairedCoreBreakpoint | null => {
    const baseline = prepare(diagnosis.rawTarget);
    const references = pairedReferences(diagnosis, siteData, baseline);
    if (references.length === 0) return null;
    const scores: Array<{ year: number; score: number }> = [];
    for (
        let year = diagnosis.targetRange.startYear + 30;
        year <= diagnosis.targetRange.endYear - 30;
        year += 1
    ) {
        const corrected = prepare(simulateCorrection(diagnosis.rawTarget, eventType, year));
        scores.push({
            year,
            score: eventType === "missingRing"
                ? scoreMissing(corrected, references, diagnosis)
                : scoreFalse(corrected, references, year),
        });
    }
    const ranked = scores.sort((a, b) => b.score - a.score || b.year - a.year);
    const top = ranked[0];
    if (!top) return null;
    const remote = ranked.find((row) => Math.abs(row.year - top.year) > 7);
    return {
        year: top.year,
        score: top.score,
        remoteMargin: top.score - (remote?.score ?? top.score),
        referenceCount: references.length,
    };
};

const boundedWindow = (
    centerYear: number,
    width: number,
    minimumYear: number,
    maximumYear: number,
) => {
    const actualWidth = Math.max(1, Math.min(width, maximumYear - minimumYear + 1));
    let startYear = centerYear - Math.floor((actualWidth - 1) / 2);
    startYear = Math.max(minimumYear, Math.min(startYear, maximumYear - actualWidth + 1));
    return { startYear, endYear: startYear + actualWidth - 1 };
};

const minimallyShiftedConsensusWindow = (
    event: DiagnosisEvent,
    pairedYear: number,
    directYear: number,
    minimumYear: number,
    maximumYear: number,
) => {
    const width = event.endYear - event.startYear + 1;
    const lowerStart = Math.max(pairedYear, directYear) - width + 1;
    const upperStart = Math.min(pairedYear, directYear);
    const requestedStart = Math.max(lowerStart, Math.min(event.startYear, upperStart));
    const startYear = Math.max(
        minimumYear,
        Math.min(requestedStart, maximumYear - width + 1),
    );
    return { startYear, endYear: startYear + width - 1 };
};

const withAdjacentIndependentGuard = (
    event: DiagnosisEvent,
    evidenceYears: number[],
): DiagnosisEvent => {
    const availableGuard = Math.max(0, 9 - (event.endYear - event.startYear + 1));
    if (availableGuard === 0) return event;
    const adjacent = evidenceYears
        .map((year) => ({
            year,
            distance: year < event.startYear
                ? event.startYear - year
                : year > event.endYear
                    ? year - event.endYear
                    : 0,
        }))
        .filter((row) => row.distance >= 1 && row.distance <= Math.min(2, availableGuard))
        .sort((a, b) => a.distance - b.distance || a.year - b.year)[0];
    if (!adjacent) return event;
    const window = {
        startYear: Math.min(event.startYear, adjacent.year),
        endYear: Math.max(event.endYear, adjacent.year),
    };
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const minimumScore = event.rankedYears.length > 0
        ? Math.min(...event.rankedYears.map((row) => row.score))
        : 0;
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return prior.get(year) ?? {
                year,
                rank: 0,
                score: minimumScore - 1,
                evidenceTags: ["adjacent_independent_guard"],
            };
        },
    )
        .sort((a, b) => b.score - a.score || a.year - b.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...event,
        id: `${event.id}-independent-guard-${window.startYear}-${window.endYear}`,
        ...window,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "adjacent_independent_guard",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                "window_refinement=adjacent_independent_guard",
                `window_before=${event.startYear}-${event.endYear}`,
                `independent_guard_core=${event.startYear}-${event.endYear}`,
                `independent_guard_year=${adjacent.year}`,
            ],
        },
    };
};

const evidenceYear = (event: DiagnosisEvent, prefix: string): number | null => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    if (!note) return null;
    const year = Number(note.slice(prefix.length));
    return Number.isFinite(year) ? year : null;
};

const withPairedCandidateConsensus = (
    event: DiagnosisEvent,
    paired: PairedCoreBreakpoint,
    directYear: number,
    diagnosis: SeriesCoreDiagnosis,
): DiagnosisEvent | null => {
    if (event.eventType !== "falseRing"
        || paired.remoteMargin < 0.05
        || (directYear >= event.startYear && directYear <= event.endYear)) {
        return null;
    }
    const candidateYear = evidenceYear(event, "candidate_top_year=");
    const candidateScore = evidenceYear(event, "candidate_top_score=");
    if (candidateYear === null
        || candidateScore === null
        || candidateScore < 15
        || Math.abs(candidateYear - paired.year) > 2) {
        return null;
    }
    const bothOlder = candidateYear < event.startYear && paired.year < event.startYear;
    const bothNewer = candidateYear > event.endYear && paired.year > event.endYear;
    if (!bothOlder && !bothNewer) return null;
    const centerYear = Math.round((candidateYear + paired.year) / 2);
    const window = boundedWindow(
        centerYear,
        Math.min(9, event.endYear - event.startYear + 1),
        diagnosis.targetRange.startYear,
        diagnosis.targetRange.endYear,
    );
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const minimumScore = event.rankedYears.length > 0
        ? Math.min(...event.rankedYears.map((row) => row.score))
        : 0;
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return prior.get(year) ?? {
                year,
                rank: 0,
                score: year === candidateYear ? 2 : minimumScore - 1,
                evidenceTags: ["paired_candidate_breakpoint_consensus"],
            };
        },
    )
        .sort((a, b) => b.score - a.score || a.year - b.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...event,
        id: `${event.id}-paired-candidate-${window.startYear}-${window.endYear}`,
        ...window,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "paired_candidate_breakpoint_consensus",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                "window_refinement=paired_candidate_breakpoint_consensus",
                `window_before=${event.startYear}-${event.endYear}`,
                `paired_candidate_center_year=${centerYear}`,
            ],
        },
    };
};

const withCandidateDirectConsensus = (
    event: DiagnosisEvent,
    directYear: number,
    diagnosis: SeriesCoreDiagnosis,
): DiagnosisEvent | null => {
    if (event.eventType !== "falseRing") return null;
    const candidateYear = evidenceYear(event, "candidate_top_year=");
    const candidateScore = evidenceYear(event, "candidate_top_score=");
    const candidateMargin = evidenceYear(event, "candidate_top_margin=");
    if (candidateYear === null
        || candidateScore === null
        || candidateMargin === null
        || candidateScore < 10
        || candidateMargin < 0.1
        || Math.abs(candidateYear - directYear) > 5) {
        return null;
    }
    const bothOlder = candidateYear < event.startYear && directYear < event.startYear;
    const bothNewer = candidateYear > event.endYear && directYear > event.endYear;
    if (!bothOlder && !bothNewer) return null;
    const window = boundedWindow(
        candidateYear,
        Math.min(9, event.endYear - event.startYear + 1),
        diagnosis.targetRange.startYear,
        diagnosis.targetRange.endYear,
    );
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const minimumScore = event.rankedYears.length > 0
        ? Math.min(...event.rankedYears.map((row) => row.score))
        : 0;
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return prior.get(year) ?? {
                year,
                rank: 0,
                score: year === candidateYear ? 2 : minimumScore - 1,
                evidenceTags: ["candidate_direct_breakpoint_consensus"],
            };
        },
    )
        .sort((a, b) => b.score - a.score || a.year - b.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...event,
        id: `${event.id}-candidate-direct-${window.startYear}-${window.endYear}`,
        ...window,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "candidate_direct_breakpoint_consensus",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                "window_refinement=candidate_direct_breakpoint_consensus",
                `window_before=${event.startYear}-${event.endYear}`,
                `candidate_direct_center_year=${candidateYear}`,
            ],
        },
    };
};

const withDirectionalFalseRingGuard = (
    event: DiagnosisEvent,
    directYear: number,
    pairedYear: number | null,
): DiagnosisEvent => {
    if (event.eventType !== "falseRing") return event;
    const scanYear = evidenceYear(event, "scan_top_year=");
    if (scanYear === null) return event;
    const scanOutsideDistance = scanYear < event.startYear
        ? event.startYear - scanYear
        : scanYear > event.endYear
            ? scanYear - event.endYear
            : 0;
    if (scanOutsideDistance > 6
        || (pairedYear !== null && Math.abs(pairedYear - directYear) <= 1)) {
        return event;
    }
    const candidateYear = evidenceYear(event, "candidate_top_year=");
    const pairs = [candidateYear, directYear]
        .filter((year): year is number => year !== null)
        .filter((year) => Math.abs(year - scanYear) <= 3)
        .map((year) => [scanYear, year] as const);
    const pair = pairs.find(([left, right]) => (
        (left <= event.startYear && right <= event.startYear + 1)
        || (left >= event.endYear && right >= event.endYear - 1)
    ));
    if (!pair) return event;
    const direction = pair[0] <= event.startYear ? -1 : 1;
    const nearerYear = direction < 0 ? Math.max(...pair) : Math.min(...pair);
    const fartherYear = direction < 0 ? Math.min(...pair) : Math.max(...pair);
    const targetYear = nearerYear + direction;
    let cappedTarget = nearerYear === fartherYear
        ? targetYear
        : direction < 0
            ? Math.max(fartherYear, targetYear)
            : Math.min(fartherYear, targetYear);
    if (direction < 0 && cappedTarget >= event.startYear) {
        cappedTarget = event.startYear - 1;
    }
    if (direction > 0 && cappedTarget <= event.endYear) {
        cappedTarget = event.endYear + 1;
    }
    const expanded = {
        startYear: Math.min(event.startYear, cappedTarget),
        endYear: Math.max(event.endYear, cappedTarget),
    };
    const width = expanded.endYear - expanded.startYear + 1;
    const window = width <= 9
        ? expanded
        : direction < 0
            ? { startYear: cappedTarget, endYear: cappedTarget + 8 }
            : { startYear: cappedTarget - 8, endYear: cappedTarget };
    if (window.startYear === event.startYear && window.endYear === event.endYear) return event;
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const minimumScore = event.rankedYears.length > 0
        ? Math.min(...event.rankedYears.map((row) => row.score))
        : 0;
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return prior.get(year) ?? {
                year,
                rank: 0,
                score: minimumScore - 1,
                evidenceTags: ["directional_false_ring_guard"],
            };
        },
    )
        .sort((a, b) => b.score - a.score || a.year - b.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...event,
        id: `${event.id}-false-directional-guard-${window.startYear}-${window.endYear}`,
        ...window,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "directional_false_ring_guard",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                "window_refinement=directional_false_ring_guard",
                `window_before=${event.startYear}-${event.endYear}`,
                `independent_guard_core=${event.startYear}-${event.endYear}`,
                `directional_guard_scan_year=${scanYear}`,
                `directional_guard_support_year=${pair[1]}`,
                `directional_guard_target_year=${cappedTarget}`,
            ],
        },
    };
};

export const refineUnitEventWithIndependentBreakpoints = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    directEvent: DiagnosisEvent | null,
): DiagnosisEvent => {
    if (event.eventType !== "missingRing" && event.eventType !== "falseRing") return event;
    const directYear = directEvent?.rankedYears[0]?.year;
    if (directYear === undefined) return event;
    const paired = locatePairedCoreBreakpoint(diagnosis, siteData, event.eventType);
    if (!paired) {
        const audited = {
            ...event,
            evidence: {
                ...event.evidence,
                notes: [
                    ...event.evidence.notes,
                    `direct_transition_year=${directYear}`,
                ],
            },
        } satisfies DiagnosisEvent;
        const candidateDirect = withCandidateDirectConsensus(
            audited,
            directYear,
            diagnosis,
        );
        if (candidateDirect) return candidateDirect;
        return withAdjacentIndependentGuard(
            withDirectionalFalseRingGuard(audited, directYear, null),
            [directYear],
        );
    }
    const auditedEvent = {
        ...event,
        evidence: {
            ...event.evidence,
            notes: [
                ...event.evidence.notes,
                `paired_breakpoint_year=${paired.year}`,
                `paired_breakpoint_score=${paired.score.toFixed(6)}`,
                `paired_breakpoint_margin=${paired.remoteMargin.toFixed(6)}`,
                `paired_breakpoint_reference_count=${paired.referenceCount}`,
                `direct_transition_year=${directYear}`,
            ],
        },
    } satisfies DiagnosisEvent;
    const currentCenter = Math.round((event.startYear + event.endYear) / 2);
    const pairDirectDistance = Math.abs(paired.year - directYear);
    const pairCurrentDistance = Math.abs(paired.year - currentCenter);
    const accepted = event.eventType === "missingRing"
        ? pairDirectDistance <= 5 && pairCurrentDistance >= 4
        : pairDirectDistance <= 1
            && pairCurrentDistance >= 2
            && pairCurrentDistance <= 25;
    if (!accepted) {
        const pairedCandidate = withPairedCandidateConsensus(
            auditedEvent,
            paired,
            directYear,
            diagnosis,
        );
        if (pairedCandidate) return pairedCandidate;
        const candidateDirect = withCandidateDirectConsensus(
            auditedEvent,
            directYear,
            diagnosis,
        );
        if (candidateDirect) return candidateDirect;
        return withAdjacentIndependentGuard(
            withDirectionalFalseRingGuard(auditedEvent, directYear, paired.year),
            [directYear, paired.year],
        );
    }
    const width = event.endYear - event.startYear + 1;
    const window = event.eventType === "missingRing"
        ? minimallyShiftedConsensusWindow(
            event,
            paired.year,
            directYear,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
        )
        : boundedWindow(
            paired.year,
            width,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
        );
    return {
        ...auditedEvent,
        id: `${event.id}-paired-direct-${window.startYear}-${window.endYear}`,
        ...window,
        rankedYears: Array.from({ length: width }, (_, index) => {
            const year = window.startYear + index;
            return {
                year,
                rank: index + 1,
                score: 1 / (1 + Math.abs(year - paired.year)),
                evidenceTags: ["paired_direct_breakpoint_consensus"],
            };
        }).sort((a, b) => b.score - a.score || b.year - a.year)
            .map((row, index) => ({ ...row, rank: index + 1 })),
        evidence: {
            ...auditedEvent.evidence,
            algorithmSources: Array.from(new Set([
                ...auditedEvent.evidence.algorithmSources,
                "paired_direct_breakpoint_consensus",
            ])).sort(),
            notes: [
                ...auditedEvent.evidence.notes,
                "window_refinement=paired_direct_breakpoint_consensus",
                `window_before=${event.startYear}-${event.endYear}`,
            ],
        },
    };
};
