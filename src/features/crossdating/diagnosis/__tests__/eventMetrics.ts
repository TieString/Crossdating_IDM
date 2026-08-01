import type {
    DiagnosisEvent,
    DiagnosisEventShiftSide,
    DiagnosisEventType,
} from "../types";

export type TruthEvent = {
    id: string;
    seriesId: string;
    eventType: DiagnosisEventType;
    year: number;
    shiftYears?: number;
    shiftSide?: DiagnosisEventShiftSide;
};

export type EventMatch = {
    truth: TruthEvent;
    prediction: DiagnosisEvent;
    rank: number | null;
    locationRank: number;
};

export type EventMetrics = {
    truthCount: number;
    predictionCount: number;
    matchedCount: number;
    recall: number;
    precision: number;
    completeCaseSuccess: boolean;
    widths: number[];
    ranks: number[];
    matches: EventMatch[];
    missedTruthIds: string[];
    unmatchedPredictionIds: string[];
};

type PredictedLocation = Pick<
DiagnosisEvent,
"startYear" | "endYear" | "rankedYears" | "shiftYears" | "shiftSide"
> & {
    locationRank: number;
};

const predictedLocations = (prediction: DiagnosisEvent): PredictedLocation[] => [
    {
        startYear: prediction.startYear,
        endYear: prediction.endYear,
        rankedYears: prediction.rankedYears,
        shiftYears: prediction.shiftYears,
        shiftSide: prediction.shiftSide,
        locationRank: 0,
    },
    ...(prediction.locationAlternatives ?? []).map((alternative) => ({
        startYear: alternative.startYear,
        endYear: alternative.endYear,
        rankedYears: alternative.rankedYears,
        shiftYears: alternative.shiftYears ?? prediction.shiftYears,
        shiftSide: alternative.shiftSide ?? prediction.shiftSide,
        locationRank: alternative.rank,
    })),
];

const compatibleLocation = (
    truth: TruthEvent,
    prediction: DiagnosisEvent,
): PredictedLocation | null => {
    if (truth.seriesId !== prediction.seriesId || truth.eventType !== prediction.eventType) {
        return null;
    }
    return predictedLocations(prediction).find((location) => (
        truth.year >= location.startYear
        && truth.year <= location.endYear
        && (
            truth.eventType !== "partialMove"
            || (
                truth.shiftYears === location.shiftYears
                && truth.shiftSide === location.shiftSide
            )
        )
    )) ?? null;
};

const compatible = (truth: TruthEvent, prediction: DiagnosisEvent): boolean => (
    compatibleLocation(truth, prediction) !== null
);

const locationCost = (truth: TruthEvent, location: PredictedLocation): number => {
    const rank = location.rankedYears.find((row) => row.year === truth.year)?.rank
        ?? location.rankedYears.length + 1;
    const center = (location.startYear + location.endYear) / 2;
    return location.locationRank * 10_000 + rank * 100 + Math.abs(center - truth.year);
};

const pairCost = (truth: TruthEvent, prediction: DiagnosisEvent): number => {
    const locations = predictedLocations(prediction).filter((location) => (
        truth.year >= location.startYear
        && truth.year <= location.endYear
        && (
            truth.eventType !== "partialMove"
            || (
                truth.shiftYears === location.shiftYears
                && truth.shiftSide === location.shiftSide
            )
        )
    ));
    return Math.min(...locations.map((location) => locationCost(truth, location)));
};

/** Maximum-cardinality one-to-one matching, with rank/distance used only as deterministic tie-breaks. */
export const matchDiagnosisEvents = (
    truths: TruthEvent[],
    predictions: DiagnosisEvent[],
): EventMetrics => {
    const orderedTruths = [...truths].sort((a, b) => {
        const aOptions = predictions.filter((prediction) => compatible(a, prediction)).length;
        const bOptions = predictions.filter((prediction) => compatible(b, prediction)).length;
        return aOptions - bOptions || b.year - a.year || a.id.localeCompare(b.id);
    });
    const predictionForTruth = new Map<string, number>();
    const truthForPrediction = new Map<number, string>();

    const assign = (truth: TruthEvent, visited: Set<number>): boolean => {
        const options = predictions
            .map((prediction, index) => ({ prediction, index }))
            .filter(({ prediction }) => compatible(truth, prediction))
            .sort((a, b) => pairCost(truth, a.prediction) - pairCost(truth, b.prediction));
        for (const { index } of options) {
            if (visited.has(index)) continue;
            visited.add(index);
            const displacedTruthId = truthForPrediction.get(index);
            if (!displacedTruthId) {
                truthForPrediction.set(index, truth.id);
                predictionForTruth.set(truth.id, index);
                return true;
            }
            const displacedTruth = orderedTruths.find((candidate) => candidate.id === displacedTruthId);
            if (displacedTruth && assign(displacedTruth, visited)) {
                truthForPrediction.set(index, truth.id);
                predictionForTruth.set(truth.id, index);
                return true;
            }
        }
        return false;
    };

    orderedTruths.forEach((truth) => assign(truth, new Set()));
    const matches = truths.flatMap((truth): EventMatch[] => {
        const index = predictionForTruth.get(truth.id);
        if (index === undefined) return [];
        const prediction = predictions[index];
        const location = compatibleLocation(truth, prediction);
        if (!location) return [];
        return [{
            truth,
            prediction,
            rank: location.rankedYears.find((row) => row.year === truth.year)?.rank ?? null,
            locationRank: location.locationRank,
        }];
    });
    const matchedPredictionIds = new Set(matches.map((match) => match.prediction.id));
    const matchedTruthIds = new Set(matches.map((match) => match.truth.id));
    const matchedCount = matches.length;
    return {
        truthCount: truths.length,
        predictionCount: predictions.length,
        matchedCount,
        recall: matchedCount / Math.max(1, truths.length),
        precision: matchedCount / Math.max(1, predictions.length),
        completeCaseSuccess: matchedCount === truths.length && matchedCount === predictions.length,
        widths: predictions.map((prediction) => prediction.endYear - prediction.startYear + 1),
        ranks: matches.flatMap((match) => match.rank === null ? [] : [match.rank]),
        matches,
        missedTruthIds: truths.filter((truth) => !matchedTruthIds.has(truth.id)).map((truth) => truth.id),
        unmatchedPredictionIds: predictions
            .filter((prediction) => !matchedPredictionIds.has(prediction.id))
            .map((prediction) => prediction.id),
    };
};
