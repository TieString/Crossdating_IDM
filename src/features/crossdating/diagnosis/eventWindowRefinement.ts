/**
 * Refines an accepted unit-transition event without changing event count or edit eligibility.
 * The fixed-width window may move only when independent boundary views satisfy conservative gates.
 */
import { scoreEditYearsInRegion, type EditYearScanEvidence } from "./rangeMove";
import type {
    DiagnosisCandidateOperation,
    DiagnosisEvent,
    DiagnosisRankedYear,
    EffectiveDiagnosisConfig,
    SeriesCoreDiagnosis,
} from "./types";

const SEARCH_RADIUS = 14;
const MAX_EDGE_DISTANCE = 4;
const RAW_CANDIDATE_MAX_DISTANCE = 6;
const PRECISE_CORROBORATION_DISTANCE = 2;
const BOUNDARY_SCAN_DISTANCE = 2;
const BOUNDARY_CORROBORATION_DISTANCE = 2;
const CONSENSUS_MIN_DISPLACEMENT = 5;
const CONSENSUS_MIN_CANDIDATE_SCORE = 20;

type Window = { startYear: number; endYear: number };

type WindowRefinement = {
    window: Window;
    reason: string;
    rankAnchorYear?: number;
};

type UnitEventType = "missingRing" | "falseRing";

export type UnitWindowRefinementConfig = {
    genericEdgeMaximumShift: number;
    corroboratedEdgeMaximumShift: number;
    missingExtremeConsensusMaximumShift: number;
};

const DEFAULT_WINDOW_REFINEMENT_CONFIG: UnitWindowRefinementConfig = {
    genericEdgeMaximumShift: 1,
    corroboratedEdgeMaximumShift: 3,
    missingExtremeConsensusMaximumShift: 5,
};

const centerYear = (event: DiagnosisEvent): number => (
    event.rankedYears[0]?.year
    ?? Math.floor((event.startYear + event.endYear) / 2)
);

const boundedWindow = (
    center: number,
    width: number,
    minYear: number,
    maxYear: number,
): Window => {
    const safeWidth = Math.max(1, Math.min(width, maxYear - minYear + 1));
    let startYear = center - Math.floor((safeWidth - 1) / 2);
    startYear = Math.max(minYear, Math.min(startYear, maxYear - safeWidth + 1));
    return { startYear, endYear: startYear + safeWidth - 1 };
};

const sameWindow = (a: Window, b: Window): boolean => (
    a.startYear === b.startYear && a.endYear === b.endYear
);

const overlap = (a: Window, b: Window): boolean => (
    Math.max(a.startYear, b.startYear) <= Math.min(a.endYear, b.endYear)
);

const candidateYear = (candidate: DiagnosisCandidateOperation): number => (
    candidate.targetYear
    ?? candidate.selectedRange?.endYear
    ?? candidate.anchorYear
);

const candidatesForType = (
    candidates: DiagnosisCandidateOperation[],
    eventType: UnitEventType,
): DiagnosisCandidateOperation[] => candidates
    .filter((candidate) => (
        eventType === "missingRing"
            ? candidate.operationType === "INSERT_MISSING_RING"
            : candidate.operationType === "DELETE_FALSE_RING"
    ))
    .sort((a, b) => b.score - a.score);

const rawEventFor = (
    event: DiagnosisEvent,
    rawEvents: DiagnosisEvent[],
    sameTypeEventCount: number,
): DiagnosisEvent | null => {
    const matching = rawEvents
        .filter((candidate) => candidate.eventType === event.eventType)
        .sort((a, b) => b.evidence.score - a.evidence.score);
    if (matching.length === 0) return null;
    if (sameTypeEventCount === 1) return matching[0];
    return matching
        .sort((a, b) => (
            Math.abs(centerYear(a) - centerYear(event))
                - Math.abs(centerYear(b) - centerYear(event))
        ))[0] ?? null;
};

const normalizedScore = (value: number, values: number[]): number => {
    const finite = values.filter(Number.isFinite);
    if (!Number.isFinite(value) || finite.length === 0) return 0;
    const min = Math.min(...finite);
    const max = Math.max(...finite);
    return max > min ? (value - min) / (max - min) : 0.5;
};

const rerankWindow = (
    event: DiagnosisEvent,
    window: Window,
    scanRows: EditYearScanEvidence[],
    candidates: DiagnosisCandidateOperation[],
    rankAnchorYear: number | null,
): DiagnosisRankedYear[] => {
    const scanByYear = new Map(scanRows.map((row) => [row.year, row]));
    const scanValues = scanRows.map((row) => row.quality);
    const candidateRows = candidates.map((candidate) => ({
        year: candidateYear(candidate),
        score: candidate.score,
        tags: candidate.algorithmSource,
    }));
    const candidateValues = candidateRows.map((row) => row.score);
    const originalByYear = new Map(event.rankedYears.map((row) => [row.year, row]));
    const originalValues = event.rankedYears.map((row) => row.score);

    return Array.from({ length: window.endYear - window.startYear + 1 }, (_, index) => {
        const year = window.startYear + index;
        const scan = scanByYear.get(year);
        const nearestCandidate = candidateRows
            .map((row) => ({ ...row, distance: Math.abs(row.year - year) }))
            .sort((a, b) => a.distance - b.distance || b.score - a.score)[0];
        const original = originalByYear.get(year);
        const scanComponent = scan ? normalizedScore(scan.quality, scanValues) : 0;
        const candidateComponent = nearestCandidate
            ? normalizedScore(nearestCandidate.score, candidateValues)
                - nearestCandidate.distance * 0.12
            : 0;
        const originalComponent = original
            ? normalizedScore(original.score, originalValues)
            : 0;
        return {
            year,
            score: scanComponent * 0.5
                + candidateComponent * 0.35
                + originalComponent * 0.15
                + (year === rankAnchorYear ? 1 : 0),
            evidenceTags: Array.from(new Set([
                "counterfactual_window_refinement",
                ...(year === rankAnchorYear ? ["directional_boundary_rank_anchor"] : []),
                ...(scan ? ["local_edit_alignment"] : []),
                ...(nearestCandidate?.tags ?? []),
                ...(original?.evidenceTags ?? []),
            ])).sort(),
        };
    })
        .sort((a, b) => b.score - a.score || a.year - b.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
};

const edgeWindow = (
    event: DiagnosisEvent,
    scanTopYear: number,
    diagnosis: SeriesCoreDiagnosis,
    maximumShift = 1,
    maximumOutsideDistance = MAX_EDGE_DISTANCE,
): Window | null => {
    const outsideDistance = scanTopYear < event.startYear
        ? event.startYear - scanTopYear
        : scanTopYear > event.endYear
            ? scanTopYear - event.endYear
            : 0;
    if (outsideDistance < 1 || outsideDistance > maximumOutsideDistance) return null;
    const width = event.endYear - event.startYear + 1;
    const shift = Math.min(outsideDistance, Math.max(1, maximumShift));
    const requestedStart = event.startYear + (scanTopYear < event.startYear ? -shift : shift);
    const startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(requestedStart, diagnosis.targetRange.endYear - width + 1),
    );
    return { startYear, endYear: startYear + width - 1 };
};

const corroboratedBoundaryWindow = (
    event: DiagnosisEvent,
    scanTopYear: number,
    corroboratingYears: Array<number | null>,
    diagnosis: SeriesCoreDiagnosis,
): Window | null => {
    const scanInsideWindow = scanTopYear >= event.startYear && scanTopYear <= event.endYear;
    const direction = scanInsideWindow
        && scanTopYear - event.startYear <= BOUNDARY_SCAN_DISTANCE
        && corroboratingYears.some((year) => (
            year !== null
            && year < event.startYear
            && event.startYear - year <= BOUNDARY_CORROBORATION_DISTANCE
        ))
        ? -1
        : scanInsideWindow
            && event.endYear - scanTopYear <= BOUNDARY_SCAN_DISTANCE
            && corroboratingYears.some((year) => (
                year !== null
                && year > event.endYear
                && year - event.endYear <= BOUNDARY_CORROBORATION_DISTANCE
            ))
            ? 1
            : 0;
    if (direction === 0) return null;
    const width = event.endYear - event.startYear + 1;
    const requestedStart = event.startYear + direction;
    const startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(requestedStart, diagnosis.targetRange.endYear - width + 1),
    );
    const window = { startYear, endYear: startYear + width - 1 };
    return sameWindow(event, window) ? null : window;
};

const falseRingWindow = (
    event: DiagnosisEvent,
    scanTopYear: number,
    rawEvent: DiagnosisEvent | null,
    candidates: DiagnosisCandidateOperation[],
    diagnosis: SeriesCoreDiagnosis,
    sameTypeEventCount: number,
    refinementConfig: UnitWindowRefinementConfig,
): WindowRefinement | null => {
    const topCandidate = candidates[0];
    const topCandidateYear = topCandidate ? candidateYear(topCandidate) : null;
    const rawTopYear = rawEvent ? centerYear(rawEvent) : null;
    const currentCenter = Math.floor((event.startYear + event.endYear) / 2);
    const preciseCorroboration = [topCandidateYear, rawTopYear].some((year) => (
        year !== null
        && Math.abs(year - scanTopYear) <= PRECISE_CORROBORATION_DISTANCE
        && (scanTopYear < event.startYear
            ? year <= event.startYear
            : year >= event.endYear)
    ));

    if (sameTypeEventCount === 1
        && topCandidate
        && topCandidateYear !== null
        && rawTopYear !== null
        && Math.abs(topCandidateYear - rawTopYear) <= RAW_CANDIDATE_MAX_DISTANCE) {
        const consensusCenter = Math.floor((topCandidateYear + rawTopYear) / 2);
        if (topCandidate.score >= CONSENSUS_MIN_CANDIDATE_SCORE
            && Math.abs(consensusCenter - currentCenter) >= CONSENSUS_MIN_DISPLACEMENT) {
            return {
                window: boundedWindow(
                    consensusCenter,
                    event.endYear - event.startYear + 1,
                    diagnosis.targetRange.startYear,
                    diagnosis.targetRange.endYear,
                ),
                reason: "raw_path_candidate_consensus",
            };
        }
    }

    const boundary = corroboratedBoundaryWindow(
        event,
        scanTopYear,
        [topCandidateYear, rawTopYear],
        diagnosis,
    );
    if (boundary) {
        const rankAnchorYear = [rawTopYear, topCandidateYear].find((year) => (
            year !== null
            && (year < event.startYear || year > event.endYear)
            && year >= boundary.startYear
            && year <= boundary.endYear
        ));
        return {
            window: boundary,
            reason: "directional_boundary_consensus",
            ...(rankAnchorYear === null || rankAnchorYear === undefined
                ? {}
                : { rankAnchorYear }),
        };
    }

    const edge = edgeWindow(
        event,
        scanTopYear,
        diagnosis,
        preciseCorroboration
            ? refinementConfig.corroboratedEdgeMaximumShift
            : refinementConfig.genericEdgeMaximumShift,
    );
    if (!edge) return null;
    const corroborated = scanTopYear > event.endYear
        ? (topCandidateYear !== null && topCandidateYear > event.endYear)
            || (rawTopYear !== null && rawTopYear > event.endYear)
        : (topCandidateYear !== null && topCandidateYear < event.startYear)
            || (rawTopYear !== null && rawTopYear < event.startYear);
    return corroborated ? { window: edge, reason: "directional_edge_consensus" } : null;
};

const refineEvent = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
    rawEvents: DiagnosisEvent[],
    ownCandidates: DiagnosisCandidateOperation[],
    effectiveConfig: EffectiveDiagnosisConfig,
    sameTypeEventCount: number,
    allowMissingRefinement: boolean,
    preferBoundaryRankAnchor: boolean,
    refinementConfig: UnitWindowRefinementConfig,
): DiagnosisEvent => {
    if (event.eventType !== "missingRing" && event.eventType !== "falseRing") return event;
    const typeCandidates = candidatesForType(ownCandidates, event.eventType);
    const rawEvent = rawEventFor(event, rawEvents, sameTypeEventCount);
    const scanRows = scoreEditYearsInRegion(
        diagnosis,
        event.eventType === "missingRing" ? "insert" : "delete",
        event.startYear - SEARCH_RADIUS,
        event.endYear + SEARCH_RADIUS,
        centerYear(event),
        effectiveConfig,
    );
    const scanTop = scanRows[0];
    if (!scanTop) return event;

    const refinement = event.eventType === "missingRing"
        ? (() => {
            if (!allowMissingRefinement) return null;
            const topCandidate = typeCandidates[0];
            const topCandidateYear = topCandidate ? candidateYear(topCandidate) : null;
            const rawTopYear = rawEvent ? centerYear(rawEvent) : null;
            const preciseCorroboration = [topCandidateYear, rawTopYear].some((year) => (
                year !== null
                && Math.abs(year - scanTop.year) <= PRECISE_CORROBORATION_DISTANCE
                && (scanTop.year < event.startYear
                    ? year <= event.startYear
                    : year >= event.endYear)
            ));
            const boundaryWindow = corroboratedBoundaryWindow(
                event,
                scanTop.year,
                [topCandidateYear, rawTopYear],
                diagnosis,
            );
            if (boundaryWindow) {
                const rankAnchorYear = [rawTopYear, topCandidateYear].find((year) => (
                    year !== null
                    && (year < event.startYear || year > event.endYear)
                    && year >= boundaryWindow.startYear
                    && year <= boundaryWindow.endYear
                ));
                return {
                    window: boundaryWindow,
                    reason: "directional_boundary_consensus",
                    ...(rankAnchorYear === null || rankAnchorYear === undefined
                        ? {}
                        : { rankAnchorYear }),
                };
            }
            const candidateExtendsScan = topCandidateYear !== null
                && Math.abs(topCandidateYear - scanTop.year) <= PRECISE_CORROBORATION_DISTANCE
                && ((scanTop.year < event.startYear && topCandidateYear < scanTop.year)
                    || (scanTop.year > event.endYear && topCandidateYear > scanTop.year));
            const edgeTargetYear = candidateExtendsScan ? topCandidateYear : scanTop.year;
            const window = edgeWindow(
                event,
                edgeTargetYear,
                diagnosis,
                candidateExtendsScan
                    ? refinementConfig.missingExtremeConsensusMaximumShift
                    : preciseCorroboration
                    ? refinementConfig.corroboratedEdgeMaximumShift
                    : refinementConfig.genericEdgeMaximumShift,
                candidateExtendsScan
                    ? refinementConfig.missingExtremeConsensusMaximumShift
                    : MAX_EDGE_DISTANCE,
            );
            if (!window) return null;
            if (topCandidateYear !== null
                && Math.abs(topCandidateYear - scanTop.year) <= RAW_CANDIDATE_MAX_DISTANCE) {
                return {
                    window,
                    reason: candidateExtendsScan
                        ? "candidate_extreme_edge_consensus"
                        : "candidate_corroborated_edge",
                };
            }
            const outsideDistance = scanTop.year < event.startYear
                ? event.startYear - scanTop.year
                : scanTop.year - event.endYear;
            return topCandidateYear === null && outsideDistance === MAX_EDGE_DISTANCE
                ? null
                : { window, reason: "bounded_counterfactual_edge" };
        })()
        : falseRingWindow(
            event,
            scanTop.year,
            rawEvent,
            typeCandidates,
            diagnosis,
            sameTypeEventCount,
            refinementConfig,
        );
    const shouldRerankInPlace = allowMissingRefinement;
    if (!refinement && !shouldRerankInPlace) return event;
    const nextWindow = refinement?.window ?? {
        startYear: event.startYear,
        endYear: event.endYear,
    };
    const windowMoved = !sameWindow(event, nextWindow);

    return {
        ...event,
        id: windowMoved
            ? `${event.id}-refined-${nextWindow.startYear}-${nextWindow.endYear}`
            : `${event.id}-counterfactual-ranked`,
        ...nextWindow,
        rankedYears: rerankWindow(
            event,
            nextWindow,
            scanRows,
            typeCandidates,
            preferBoundaryRankAnchor ? refinement?.rankAnchorYear ?? null : null,
        ),
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "counterfactual_window_refinement",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                ...(refinement ? [
                    `window_refinement=${refinement.reason}`,
                    `window_before=${event.startYear}-${event.endYear}`,
                ] : ["year_ranking=counterfactual_fusion"]),
                `scan_top_year=${scanTop.year}`,
                ...(rawEvent ? [`raw_path_top_year=${centerYear(rawEvent)}`] : []),
                ...(typeCandidates[0]
                    ? [
                        `candidate_top_year=${candidateYear(typeCandidates[0])}`,
                        `candidate_top_score=${typeCandidates[0].score.toFixed(6)}`,
                        `candidate_top_probability=${typeCandidates[0].probabilityLike.toFixed(6)}`,
                        `candidate_top_confidence=${typeCandidates[0].confidenceLevel}`,
                        `candidate_top_margin=${(
                            typeCandidates[0].score - (typeCandidates[1]?.score ?? 0)
                        ).toFixed(6)}`,
                    ]
                    : []),
            ],
        },
    };
};

export const refineUnitEventWindows = (
    events: DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    rawEvents: DiagnosisEvent[],
    ownCandidates: DiagnosisCandidateOperation[],
    effectiveConfig: EffectiveDiagnosisConfig,
    allowMissingRefinement = true,
    preferBoundaryRankAnchor = false,
    overrides: Partial<UnitWindowRefinementConfig> = {},
): DiagnosisEvent[] => {
    const refinementConfig = { ...DEFAULT_WINDOW_REFINEMENT_CONFIG, ...overrides };
    const counts = new Map<UnitEventType, number>([
        ["missingRing", events.filter((event) => event.eventType === "missingRing").length],
        ["falseRing", events.filter((event) => event.eventType === "falseRing").length],
    ]);
    const refined: DiagnosisEvent[] = [];
    events.forEach((event) => {
        const next = refineEvent(
            event,
            diagnosis,
            rawEvents,
            ownCandidates,
            effectiveConfig,
            event.eventType === "missingRing" || event.eventType === "falseRing"
                ? counts.get(event.eventType) ?? 0
                : 0,
            allowMissingRefinement,
            preferBoundaryRankAnchor,
            refinementConfig,
        );
        const collides = !sameWindow(event, next)
            && refined.some((other) => other.eventType === next.eventType && overlap(other, next));
        refined.push(collides ? event : next);
    });
    return refined;
};
