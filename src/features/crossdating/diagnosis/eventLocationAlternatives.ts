import type { RwlSiteData } from "@/features/rwl/types";
import {
    scoreCumulativeLagChangePoints,
    type CumulativeLagChangePointScore,
} from "./cumulativeLagChangePoint";
import {
    firstFixedYearFromLastMovedYear,
    isNegativePartialShift,
} from "./partialMoveSemantics";
import type {
    DiagnosisEvent,
    DiagnosisEventLocationAlternative,
    DiagnosisRankedYear,
    SeriesCoreDiagnosis,
} from "./types";

type LocalEvent = DiagnosisEvent & {
    eventType: "missingRing" | "falseRing" | "partialMove";
};

type ScoreKey =
    | "whitenedCumulative"
    | "combinedCumulative"
    | "differenceCumulative";

export type CumulativeLocationAlternativeConfig = {
    maximumAlternatives: number;
    unitWindowYears: number;
    partialWindowYears: number;
};

export const DEFAULT_CUMULATIVE_LOCATION_ALTERNATIVE_CONFIG:
CumulativeLocationAlternativeConfig = {
    maximumAlternatives: 2,
    unitWindowYears: 7,
    partialWindowYears: 9,
};

const isLocalEvent = (event: DiagnosisEvent): event is LocalEvent => (
    event.eventType === "missingRing"
    || event.eventType === "falseRing"
    || event.eventType === "partialMove"
);

const lagForUnitEvent = (event: LocalEvent): number[] => {
    if (event.eventType === "missingRing") return [-1];
    if (event.eventType === "falseRing") return [1];
    return isNegativePartialShift(event.shiftYears) ? [event.shiftYears] : [];
};

const scoreKeyFor = (event: LocalEvent): ScoreKey => {
    if (event.eventType === "missingRing") return "whitenedCumulative";
    if (event.eventType === "falseRing") return "combinedCumulative";
    return "differenceCumulative";
};

const boundedWindow = (
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

const rowsForEvent = (
    event: LocalEvent,
    scores: CumulativeLagChangePointScore[],
): CumulativeLagChangePointScore[] => {
    const lags = new Set(lagForUnitEvent(event));
    return scores.filter((row) => lags.has(row.olderLag));
};

const rankedYearsFor = (
    window: { startYear: number; endYear: number },
    shiftYears: number,
    rows: CumulativeLagChangePointScore[],
    scoreKey: ScoreKey,
): DiagnosisRankedYear[] => {
    const byYear = new Map(
        rows
            .filter((row) => row.olderLag === shiftYears)
            .map((row) => [row.year, row]),
    );
    const availableScores = [...byYear.values()].map((row) => row[scoreKey]);
    const minimumScore = availableScores.length > 0 ? Math.min(...availableScores) : 0;
    return Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return {
                year,
                score: byYear.get(year)?.[scoreKey] ?? minimumScore - 1,
                evidenceTags: ["cumulative_lag_change_point"],
            };
        },
    )
        .sort((a, b) => b.score - a.score || b.year - a.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
};

const sameLocation = (
    event: LocalEvent,
    alternative: DiagnosisEventLocationAlternative,
): boolean => (
    event.startYear === alternative.startYear
    && event.endYear === alternative.endYear
    && (
        event.eventType !== "partialMove"
        || event.shiftYears === alternative.shiftYears
    )
);

export const buildCumulativeLocationAlternatives = (
    event: LocalEvent,
    scores: CumulativeLagChangePointScore[],
    diagnosis: SeriesCoreDiagnosis,
    overrides: Partial<CumulativeLocationAlternativeConfig> = {},
): DiagnosisEventLocationAlternative[] => {
    const config = {
        ...DEFAULT_CUMULATIVE_LOCATION_ALTERNATIVE_CONFIG,
        ...overrides,
    };
    const scoreKey = scoreKeyFor(event);
    const width = event.eventType === "partialMove"
        ? config.partialWindowYears
        : config.unitWindowYears;
    const ordered = rowsForEvent(event, scores)
        .map((row) => event.eventType === "partialMove"
            ? {
                ...row,
                year: firstFixedYearFromLastMovedYear(row.year),
            }
            : row)
        .sort((a, b) => b[scoreKey] - a[scoreKey] || b.year - a.year);
    const peakRows: CumulativeLagChangePointScore[] = [];
    for (const row of ordered) {
        if (peakRows.every((peak) => (
            peak.olderLag !== row.olderLag
            || Math.abs(peak.year - row.year) > width
        ))) {
            peakRows.push(row);
            if (peakRows.length >= config.maximumAlternatives + 1) break;
        }
    }

    const alternatives: DiagnosisEventLocationAlternative[] = [];
    for (let index = 0; index < peakRows.length; index += 1) {
        const row = peakRows[index];
        const window = boundedWindow(
            row.year,
            width,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
        );
        const nextScore = peakRows[index + 1]?.[scoreKey] ?? row[scoreKey];
        const alternative: DiagnosisEventLocationAlternative = {
            rank: alternatives.length + 1,
            ...window,
            rankedYears: rankedYearsFor(window, row.olderLag, ordered, scoreKey),
            evidenceScore: row[scoreKey],
            scoreMargin: row[scoreKey] - nextScore,
            algorithmSource: "cumulative_lag_change_point",
            ...(event.eventType === "partialMove" ? {
                shiftYears: row.olderLag,
                shiftSide: "older" as const,
            } : {}),
        };
        if (sameLocation(event, alternative)) continue;
        alternatives.push(alternative);
        if (alternatives.length >= config.maximumAlternatives) break;
    }
    return alternatives.map((alternative, index) => ({
        ...alternative,
        rank: index + 1,
    }));
};

export const addCumulativeLocationAlternatives = (
    events: DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis | null,
    siteData: RwlSiteData,
    overrides: Partial<CumulativeLocationAlternativeConfig> = {},
): DiagnosisEvent[] => {
    const localEvents = events.filter(isLocalEvent);
    if (localEvents.length !== 1
        || events.some((event) => event.eventType === "wholeSeriesMove")) {
        return events;
    }
    const event = localEvents[0];
    const scores = scoreCumulativeLagChangePoints(
        diagnosis,
        cofechaDiagnosis,
        {
            lags: lagForUnitEvent(event),
            siteData,
        },
    );
    const locationAlternatives = buildCumulativeLocationAlternatives(
        event,
        scores,
        diagnosis,
        overrides,
    );
    if (locationAlternatives.length === 0) return events;
    return events.map((candidate) => candidate.id === event.id
        ? { ...candidate, locationAlternatives }
        : candidate);
};

export const eventAtLocationAlternative = (
    event: DiagnosisEvent,
    alternative: DiagnosisEventLocationAlternative,
): DiagnosisEvent => ({
    ...event,
    id: `${event.id}-location-alternative-${alternative.rank}`,
    startYear: alternative.startYear,
    endYear: alternative.endYear,
    reviewCoreRange: alternative.reviewCoreRange,
    rankedYears: alternative.rankedYears,
    shiftYears: alternative.shiftYears ?? event.shiftYears,
    shiftSide: alternative.shiftSide ?? event.shiftSide,
    evidence: {
        ...event.evidence,
        score: alternative.evidenceScore,
        scoreMargin: alternative.scoreMargin,
        algorithmSources: Array.from(new Set([
            ...event.evidence.algorithmSources,
            alternative.algorithmSource,
        ])).sort(),
        notes: Array.from(new Set([
            ...event.evidence.notes,
            `selected_location_alternative=${alternative.rank}`,
        ])),
    },
});
