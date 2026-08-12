/** Complete-correction competition for two nearby negative partial-move events. */
import type { RwlSiteData } from "@/features/rwl/types";
import { getJointCounterfactualOperationScores } from "./jointCounterfactualOperation";
import { scoreDiagnosisEventSets } from "./jointEventRefinement";
import type { DiagnosisEvent, SeriesCoreDiagnosis } from "./types";

type PartialPairHypothesis = {
    kind: "pair" | "direct";
    olderYear: number;
    newerYear: number;
    olderShiftYears: number;
    newerShiftYears: number;
    events: DiagnosisEvent[];
};

type ScoredPartialPairHypothesis = Omit<PartialPairHypothesis, "events"> & {
    score: number;
};

export type CompletedPartialPairCompetition = {
    aggregateShiftYears: number;
    olderShiftYears: number;
    newerShiftYears: number;
    olderYear: number;
    newerYear: number;
    rawOlderYear: number;
    rawNewerYear: number;
    cofechaOlderYear: number;
    cofechaNewerYear: number;
    rawPairMargin: number;
    cofechaPairMargin: number;
    rawFamilyMargin: number;
    cofechaFamilyMargin: number;
    newerOperationDifferenceGain: number;
    amplitudeFamilyCount: number;
};

export const supportsCompletedPartialPairCompetition = (
    competition: CompletedPartialPairCompetition | null,
): competition is CompletedPartialPairCompetition => Boolean(
    competition
    && competition.amplitudeFamilyCount >= 2
    && competition.rawPairMargin >= -0.002
    && competition.cofechaPairMargin >= 0.005
    && competition.rawFamilyMargin >= 0.005
    && competition.cofechaFamilyMargin >= 0.005
    && Math.abs(competition.rawOlderYear - competition.cofechaOlderYear) <= 4
    && Math.abs(competition.rawNewerYear - competition.cofechaNewerYear) <= 4
    && competition.newerOperationDifferenceGain >= 0.02,
);

const makePartialEvent = (
    seriesId: string,
    id: string,
    year: number,
    shiftYears: number,
    lagBefore: number,
    lagAfter: number,
): DiagnosisEvent => ({
    id,
    seriesId,
    eventType: "partialMove",
    startYear: year,
    endYear: year,
    rankedYears: [{ year, rank: 1, score: 1, evidenceTags: ["completed_partial_pair"] }],
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: ["completed_partial_pair"],
        score: 1,
        scoreMargin: 1,
        baselineCorrelation: null,
        correctedCorrelation: null,
        correlationGain: null,
        lagBefore,
        lagAfter,
        samplePairs: 0,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
    shiftYears,
    shiftSide: "older",
});

const scoreHypotheses = (
    hypotheses: readonly PartialPairHypothesis[],
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
): ScoredPartialPairHypothesis[] => scoreDiagnosisEventSets(
    hypotheses.map((hypothesis) => hypothesis.events),
    diagnosis,
    siteData,
).map((result, index) => {
    const { events: _events, ...hypothesis } = hypotheses[index];
    return { ...hypothesis, score: result.score };
});

const familyKey = (hypothesis: ScoredPartialPairHypothesis): string => (
    `${hypothesis.olderShiftYears}:${hypothesis.newerShiftYears}`
);

const bestPair = (
    scores: readonly ScoredPartialPairHypothesis[],
): ScoredPartialPairHypothesis | null => scores.filter((row) => row.kind === "pair")
    .sort((left, right) => right.score - left.score)[0] ?? null;

const bestDirectScore = (
    scores: readonly ScoredPartialPairHypothesis[],
): number => Math.max(
    ...scores.filter((row) => row.kind === "direct").map((row) => row.score),
);

const competingFamilyScore = (
    scores: readonly ScoredPartialPairHypothesis[],
    selected: ScoredPartialPairHypothesis,
): number => Math.max(
    ...scores.filter((row) => (
        row.kind === "pair" && familyKey(row) !== familyKey(selected)
    )).map((row) => row.score),
);

export const compareCompletedPartialPair = (
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    aggregate: DiagnosisEvent,
    candidateEvents: readonly DiagnosisEvent[],
    maxPartialGapYears: number,
): CompletedPartialPairCompetition | null => {
    const aggregateShiftYears = aggregate.shiftYears;
    if (aggregate.eventType !== "partialMove"
        || aggregate.shiftSide !== "older"
        || aggregateShiftYears === undefined
        || aggregateShiftYears > -4
        || aggregate.evidence.lagBefore !== aggregateShiftYears
        || aggregate.evidence.lagAfter !== 0
        || !aggregate.evidence.algorithmSources.includes("decisive_joint_operation_fusion")
        || !aggregate.evidence.algorithmSources.includes("full_interval_counterfactual_scan")
        || aggregate.evidence.scoreMargin < 0.05) return null;

    const operations = getJointCounterfactualOperationScores(
        diagnosis,
        15,
        maxPartialGapYears,
        0,
    ).filter((operation) => (
        operation.eventType === "partialMove"
        && operation.shiftYears <= -2
        && operation.bestDifferenceGain >= 0.02
        && operation.topThreeDifferenceGain >= 0.015
        && operation.bestCombinedGain > 0
    ));
    const operationByShift = new Map(operations.map((operation) => (
        [operation.shiftYears, operation]
    )));
    const amplitudePairs: Array<readonly [number, number]> = [];
    operations.forEach((left, leftIndex) => {
        operations.slice(leftIndex).forEach((right) => {
            if (left.shiftYears + right.shiftYears === aggregateShiftYears) {
                amplitudePairs.push([left.shiftYears, right.shiftYears]);
            }
        });
    });
    if (amplitudePairs.length < 2) return null;

    const matchingCandidates = candidateEvents.filter((event) => (
        event.eventType === "partialMove"
        && event.shiftYears === aggregateShiftYears
        && event.evidence.candidateIds.length > 0
        && event.evidence.notes.includes("candidate_hard_gate_passed")
    ));
    if (matchingCandidates.length === 0) return null;
    const anchors = [aggregate, ...matchingCandidates];
    const searchStart = Math.max(
        diagnosis.targetRange.startYear + 12,
        Math.min(...anchors.map((event) => event.startYear)) - 4,
    );
    const searchEnd = Math.min(
        diagnosis.targetRange.endYear - 12,
        Math.max(...anchors.map((event) => event.endYear)) + 4,
    );
    if (searchEnd - searchStart < 5 || searchEnd - searchStart > 48) return null;

    const hypotheses: PartialPairHypothesis[] = [];
    for (let newerYear = searchStart + 5; newerYear <= searchEnd; newerYear += 1) {
        for (let separationYears = 5; separationYears <= 13; separationYears += 1) {
            const olderYear = newerYear - separationYears;
            if (olderYear < searchStart) continue;
            amplitudePairs.forEach(([leftShift, rightShift]) => {
                const orders = leftShift === rightShift
                    ? [[leftShift, rightShift] as const]
                    : [
                        [leftShift, rightShift] as const,
                        [rightShift, leftShift] as const,
                    ];
                orders.forEach(([olderShiftYears, newerShiftYears]) => {
                    hypotheses.push({
                        kind: "pair",
                        olderYear,
                        newerYear,
                        olderShiftYears,
                        newerShiftYears,
                        events: [
                            makePartialEvent(
                                diagnosis.targetTree,
                                `completed-newer-${newerYear}-${newerShiftYears}`,
                                newerYear,
                                newerShiftYears,
                                newerShiftYears,
                                0,
                            ),
                            makePartialEvent(
                                diagnosis.targetTree,
                                `completed-older-${olderYear}-${olderShiftYears}`,
                                olderYear,
                                olderShiftYears,
                                aggregateShiftYears,
                                newerShiftYears,
                            ),
                        ],
                    });
                });
            });
        }
    }
    for (let year = searchStart; year <= searchEnd; year += 1) {
        hypotheses.push({
            kind: "direct",
            olderYear: year,
            newerYear: year,
            olderShiftYears: aggregateShiftYears,
            newerShiftYears: 0,
            events: [makePartialEvent(
                diagnosis.targetTree,
                `completed-direct-${year}`,
                year,
                aggregateShiftYears,
                aggregateShiftYears,
                0,
            )],
        });
    }

    const rawScores = scoreHypotheses(hypotheses, diagnosis, siteData);
    const cofechaScores = scoreHypotheses(hypotheses, cofechaDiagnosis, siteData);
    const raw = bestPair(rawScores);
    const cofecha = bestPair(cofechaScores);
    if (!raw || !cofecha || familyKey(raw) !== familyKey(cofecha)) return null;
    const rawDirect = bestDirectScore(rawScores);
    const cofechaDirect = bestDirectScore(cofechaScores);
    const rawCompetingFamily = competingFamilyScore(rawScores, raw);
    const cofechaCompetingFamily = competingFamilyScore(cofechaScores, cofecha);
    if (![rawDirect, cofechaDirect, rawCompetingFamily, cofechaCompetingFamily]
        .every(Number.isFinite)) return null;

    const competition: CompletedPartialPairCompetition = {
        aggregateShiftYears,
        olderShiftYears: raw.olderShiftYears,
        newerShiftYears: raw.newerShiftYears,
        olderYear: Math.round((raw.olderYear + cofecha.olderYear) / 2),
        newerYear: Math.round((raw.newerYear + cofecha.newerYear) / 2),
        rawOlderYear: raw.olderYear,
        rawNewerYear: raw.newerYear,
        cofechaOlderYear: cofecha.olderYear,
        cofechaNewerYear: cofecha.newerYear,
        rawPairMargin: raw.score - rawDirect,
        cofechaPairMargin: cofecha.score - cofechaDirect,
        rawFamilyMargin: raw.score - rawCompetingFamily,
        cofechaFamilyMargin: cofecha.score - cofechaCompetingFamily,
        newerOperationDifferenceGain:
            operationByShift.get(raw.newerShiftYears)?.bestDifferenceGain ?? 0,
        amplitudeFamilyCount: amplitudePairs.length,
    };
    return supportsCompletedPartialPairCompetition(competition) ? competition : null;
};
