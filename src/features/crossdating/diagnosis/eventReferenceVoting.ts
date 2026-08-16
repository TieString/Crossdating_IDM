/**
 * Reference-core voting for single-event localization and short cancelling event pairs.
 *
 * Each possible integer edit is scored against several well-correlated reference cores before
 * their evidence is aggregated. Pair voting is accepted only when a bounded lag pulse supplies
 * its orientation and approximate boundaries. Recovered events remain manual-review-only.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import {
    ar1WhitenSeriesUnscaled,
    correlationForSegment,
    toNumericSeries,
} from "./series";
import {
    DEFAULT_MAX_PARTIAL_GAP_YEARS,
    firstFixedYearFromLastMovedYear,
    getAutomaticPartialShiftCandidates,
} from "./partialMoveSemantics";
import {
    createFullIntervalShiftEvidenceContext,
    scoreFullIntervalShiftDifferenceEvidence,
    scoreFullIntervalShiftEvidence,
} from "./fullIntervalUnitEditEvidence";
import type {
    DiagnosisConfidence,
    DiagnosisEvent,
    DiagnosisRankedYear,
    NumericSeries,
    SeriesCoreDiagnosis,
} from "./types";

type VoteKind = "missingRing" | "falseRing" | "partialMove";

type VoteScore = {
    eventType: VoteKind;
    year: number;
    shiftYears?: number;
    score: number;
    gain: number;
};

type VotePeak = VoteScore & { remoteMargin: number };

export type ReferenceRecoveryPeakSummary = Pick<
    VotePeak,
    "eventType" | "gain" | "remoteMargin"
>;

export type AdjacentPairOrientation = "missingThenFalse" | "falseThenMissing";

export type AdjacentUnitPairHint = {
    orientation: AdjacentPairOrientation;
    olderYear: number;
    newerYear: number;
    maximumDistance: number;
};

type AdjacentPairScore = {
    olderYear: number;
    newerYear: number;
    orientation: AdjacentPairOrientation;
    score: number;
    gain: number;
    referenceCount: number;
    positiveReferenceFraction: number;
    medianReferenceGain: number;
    lowerQuartileReferenceGain: number;
};

type AdjacentPairScoreMode = "global" | "localized";

export type AdjacentUnitPairVote = {
    events: DiagnosisEvent[];
    orientation: AdjacentPairOrientation;
    olderYear: number;
    newerYear: number;
    gain: number;
    remoteMargin: number;
    referenceCount: number;
    positiveReferenceFraction: number;
    medianReferenceGain: number;
    lowerQuartileReferenceGain: number;
    masterRemoteMargin: number;
    olderSingleGain: number;
    newerSingleGain: number;
    jointExcessGain: number;
};

type ReferenceSet = {
    references: NumericSeries[];
    rawReferences: NumericSeries[];
    baselineMean: number;
    baselineMedian: number;
    baselineTrimmed: number;
};

type VotingContext = {
    difference: ReferenceSet;
    whitened: ReferenceSet;
};

const MAX_REFERENCES = 16;
const MISSING_GAIN_GATE = 0.01;
const FALSE_GAIN_GATE = 0.05;
const PARTIAL_GAIN_GATE = 0.019;
const PARTIAL_RECOVERY_MINIMUM_GAIN = 0.1;
const PARTIAL_RECOVERY_MINIMUM_REMOTE_MARGIN = 0.004;
const FALSE_OVER_PARTIAL_MAXIMUM_GAIN_DEFICIT = 0.03;
const FALSE_OVER_PARTIAL_MAXIMUM_PARTIAL_MARGIN = 0.003;
const FALSE_OVER_PARTIAL_MINIMUM_FALSE_GAIN = 0.02;
const MIN_UNHINTED_UNIT_PAIR_YEARS = 8;
const MAX_UNHINTED_UNIT_PAIR_YEARS = 14;
const MAX_HINTED_UNIT_PAIR_YEARS = 70;

export const unitPairDurationBounds = (
    hint?: AdjacentUnitPairHint,
): { minimum: number; maximum: number } => {
    if (!hint) return {
        minimum: MIN_UNHINTED_UNIT_PAIR_YEARS,
        maximum: MAX_UNHINTED_UNIT_PAIR_YEARS,
    };
    const hintedDuration = hint.newerYear - hint.olderYear;
    if (!Number.isFinite(hintedDuration)
        || hintedDuration <= MAX_UNHINTED_UNIT_PAIR_YEARS) return {
        minimum: MIN_UNHINTED_UNIT_PAIR_YEARS,
        maximum: MAX_UNHINTED_UNIT_PAIR_YEARS,
    };
    const boundaryUncertainty = Math.max(0, hint.maximumDistance) * 2;
    return {
        minimum: Math.min(
            MAX_HINTED_UNIT_PAIR_YEARS,
            Math.max(2, Math.floor(hintedDuration - boundaryUncertainty)),
        ),
        maximum: Math.min(
            MAX_HINTED_UNIT_PAIR_YEARS,
            Math.ceil(hintedDuration + boundaryUncertainty),
        ),
    };
};

/**
 * A low-separation partial hypothesis must not erase a plausible unit deletion. This changes
 * the type of an answer that would already be emitted, so it does not increase clean response.
 */
export const selectReferenceRecoveryEventType = (
    accepted: readonly ReferenceRecoveryPeakSummary[],
    audited: readonly ReferenceRecoveryPeakSummary[],
): VoteKind | null => {
    const selected = accepted[0];
    if (!selected || selected.eventType !== "partialMove") {
        return selected?.eventType ?? null;
    }
    const falseRing = audited.find((peak) => peak.eventType === "falseRing");
    if (
        falseRing
        && selected.gain - falseRing.gain
            <= FALSE_OVER_PARTIAL_MAXIMUM_GAIN_DEFICIT
        && selected.remoteMargin
            <= FALSE_OVER_PARTIAL_MAXIMUM_PARTIAL_MARGIN
        && falseRing.gain >= FALSE_OVER_PARTIAL_MINIMUM_FALSE_GAIN
    ) {
        return "falseRing";
    }
    return selected.eventType;
};


const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    // Pearson correlation is invariant to affine scaling, so global z-scoring here only repeats
    // O(years) work for every virtual edit without changing any vote.
    return result;
};

const mean = (values: number[]): number => (
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : -1
);

const median = (values: number[]): number => {
    if (values.length === 0) return -1;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

const lowerQuartile = (values: number[]): number => {
    if (values.length === 0) return -1;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * 0.25)];
};

const trimmedMean = (values: number[]): number => {
    if (values.length === 0) return -1;
    const sorted = [...values].sort((a, b) => a - b);
    const trim = Math.floor(sorted.length * 0.2);
    return mean(sorted.slice(trim, Math.max(trim + 1, sorted.length - trim)));
};

const correlations = (
    target: NumericSeries,
    references: NumericSeries[],
    diagnosis: SeriesCoreDiagnosis,
): number[] => references
    .map((reference) => correlationForSegment(
        target,
        reference,
        diagnosis.targetRange.startYear,
        diagnosis.targetRange.endYear,
        0,
        30,
    ).correlation)
    .filter((value): value is number => value !== null);

const correlationRowsForRange = (
    target: NumericSeries,
    references: NumericSeries[],
    startYear: number,
    endYear: number,
): Array<number | null> => references.map((reference) => correlationForSegment(
    target,
    reference,
    startYear,
    endYear,
    0,
    24,
).correlation);

const makeReferenceSet = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    transform: (series: NumericSeries) => NumericSeries,
): ReferenceSet => {
    const baseline = transform(diagnosis.rawTarget);
    const selectedReferences = diagnosis.master.sourceTrees
        .map((tree) => {
            const raw = toNumericSeries(siteData.get(tree));
            const data = transform(raw);
            const baselineR = correlationForSegment(
                baseline,
                data,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
                0,
                30,
            ).correlation;
            return { data, raw, baselineR: baselineR ?? -1 };
        })
        .filter((reference) => reference.baselineR > -0.25)
        .sort((a, b) => b.baselineR - a.baselineR)
        .slice(0, MAX_REFERENCES);
    const references = selectedReferences.map((reference) => reference.data);
    const baselineValues = correlations(baseline, references, diagnosis);
    return {
        references,
        rawReferences: selectedReferences.map((reference) => reference.raw),
        baselineMean: mean(baselineValues),
        baselineMedian: median(baselineValues),
        baselineTrimmed: trimmedMean(baselineValues),
    };
};

const votingContextCache = new WeakMap<
    SeriesCoreDiagnosis,
    WeakMap<RwlSiteData, VotingContext>
>();

const buildContext = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
): VotingContext => {
    let bySite = votingContextCache.get(diagnosis);
    if (!bySite) {
        bySite = new WeakMap();
        votingContextCache.set(diagnosis, bySite);
    }
    const cached = bySite.get(siteData);
    if (cached) return cached;
    const context = {
        difference: makeReferenceSet(diagnosis, siteData, firstDifferences),
        whitened: makeReferenceSet(diagnosis, siteData, ar1WhitenSeriesUnscaled),
    };
    bySite.set(siteData, context);
    return context;
};

const simulateInsert = (series: NumericSeries, year: number): NumericSeries => {
    const result = new Map<number, number>();
    series.forEach((value, sourceYear) => {
        result.set(sourceYear <= year ? sourceYear - 1 : sourceYear, value);
    });
    return result;
};

const simulateDelete = (series: NumericSeries, year: number): NumericSeries => {
    const result = new Map<number, number>();
    series.forEach((value, sourceYear) => {
        if (sourceYear !== year) result.set(sourceYear < year ? sourceYear + 1 : sourceYear, value);
    });
    return result;
};

const candidateYears = (diagnosis: SeriesCoreDiagnosis, edgeYears: number): number[] => (
    Array.from(diagnosis.rawTarget.keys())
        .filter((year) => (
            year >= diagnosis.targetRange.startYear + edgeYears
            && year <= diagnosis.targetRange.endYear - edgeYears
        ))
        .sort((a, b) => a - b)
);

const scoreAgainstReferences = (
    corrected: NumericSeries,
    diagnosis: SeriesCoreDiagnosis,
    referenceSet: ReferenceSet,
    transform: (series: NumericSeries) => NumericSeries,
    aggregate: (values: number[]) => number,
    baseline: number,
): { score: number; gain: number } => {
    const score = aggregate(correlations(transform(corrected), referenceSet.references, diagnosis));
    return { score, gain: score - baseline };
};

const scanMissing = (
    diagnosis: SeriesCoreDiagnosis,
    context: VotingContext,
): VoteScore[] => candidateYears(diagnosis, 15).map((year) => ({
    eventType: "missingRing",
    year,
    ...scoreAgainstReferences(
        simulateInsert(diagnosis.rawTarget, year),
        diagnosis,
        context.difference,
        firstDifferences,
        mean,
        context.difference.baselineMean,
    ),
}));

const scanFalse = (
    diagnosis: SeriesCoreDiagnosis,
    context: VotingContext,
): VoteScore[] => candidateYears(diagnosis, 15).map((year) => ({
    eventType: "falseRing",
    year,
    ...scoreAgainstReferences(
        simulateDelete(diagnosis.rawTarget, year),
        diagnosis,
        context.whitened,
        ar1WhitenSeriesUnscaled,
        median,
        context.whitened.baselineMedian,
    ),
}));

const scanPartial = (
    diagnosis: SeriesCoreDiagnosis,
    context: VotingContext,
    maxPartialGapYears = DEFAULT_MAX_PARTIAL_GAP_YEARS,
): VoteScore[] => {
    const shifts = getAutomaticPartialShiftCandidates({
        maxPartialGapYears,
        lagMin: -maxPartialGapYears,
        seriesLength:
            diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
        minimumSideYears: 20,
    });
    const referenceContexts = context.difference.rawReferences.map((reference) => ({
        reference,
        evidence: createFullIntervalShiftEvidenceContext(diagnosis, reference),
    }));
    return shifts.flatMap((shiftYears) => {
        const byReference = referenceContexts.map(({ reference, evidence }) => (
            new Map(scoreFullIntervalShiftDifferenceEvidence(
                diagnosis,
                shiftYears,
                20,
                reference,
                0,
                evidence,
            ).map((row) => [row.year, row.differenceCorrelation]))
        ));
        return candidateYears(diagnosis, 20).map((lastMovedYear) => {
            const score = trimmedMean(byReference.flatMap((reference) => {
                const value = reference.get(lastMovedYear);
                return value === undefined ? [] : [value];
            }));
            return {
                eventType: "partialMove" as const,
                year: firstFixedYearFromLastMovedYear(lastMovedYear),
                shiftYears,
                score,
                gain: score - context.difference.baselineTrimmed,
            };
        });
    });
};

const scanAdjacentUnitPairs = (
    diagnosis: SeriesCoreDiagnosis,
    context: VotingContext,
    scoreMode: AdjacentPairScoreMode = "global",
    hint?: AdjacentUnitPairHint,
): AdjacentPairScore[] => {
    const yearSet = new Set(candidateYears(diagnosis, 20));
    const scores: AdjacentPairScore[] = [];
    const hintedScanRadius = hint ? hint.maximumDistance + 8 : null;
    const durationBounds = unitPairDurationBounds(hint);
    const baselineDifference = scoreMode === "localized"
        ? firstDifferences(diagnosis.rawTarget)
        : null;
    yearSet.forEach((olderYear) => {
        if (hint && hintedScanRadius !== null
            && Math.abs(olderYear - hint.olderYear) > hintedScanRadius) return;
        for (
            let duration = durationBounds.minimum;
            duration <= durationBounds.maximum;
            duration += 1
        ) {
            const newerYear = olderYear + duration;
            if (!yearSet.has(newerYear)) continue;
            if (hint && hintedScanRadius !== null
                && Math.abs(newerYear - hint.newerYear) > hintedScanRadius) continue;
            const missingThenFalse = simulateDelete(
                simulateInsert(diagnosis.rawTarget, olderYear),
                newerYear,
            );
            const falseThenMissing = simulateInsert(
                simulateDelete(diagnosis.rawTarget, olderYear),
                newerYear,
            );
            const localRange = {
                startYear: olderYear - 16,
                endYear: newerYear + 16,
            };
            const localBaselineRows = baselineDifference
                ? correlationRowsForRange(
                    baselineDifference,
                    context.difference.references,
                    localRange.startYear,
                    localRange.endYear,
                )
                : null;
            const localBaseline = localBaselineRows
                ? mean(localBaselineRows.filter((value): value is number => value !== null))
                : null;
            ([
                ["missingThenFalse", missingThenFalse],
                ["falseThenMissing", falseThenMissing],
            ] as const).forEach(([orientation, corrected]) => {
                if (hint && orientation !== hint.orientation) return;
                const correctedDifference = baselineDifference ? firstDifferences(corrected) : null;
                const localCorrectedRows = correctedDifference
                    ? correlationRowsForRange(
                        correctedDifference,
                        context.difference.references,
                        localRange.startYear,
                        localRange.endYear,
                    )
                    : null;
                const localScore = localCorrectedRows
                    ? mean(localCorrectedRows.filter((value): value is number => value !== null))
                    : null;
                const referenceGains = localBaselineRows && localCorrectedRows
                    ? localCorrectedRows.flatMap((value, index) => {
                        const baseline = localBaselineRows[index];
                        return value === null || baseline === null ? [] : [value - baseline];
                    })
                    : [];
                const support = {
                    referenceCount: referenceGains.length,
                    positiveReferenceFraction: referenceGains.length > 0
                        ? referenceGains.filter((gain) => gain > 0).length / referenceGains.length
                        : 0,
                    medianReferenceGain: median(referenceGains),
                    lowerQuartileReferenceGain: lowerQuartile(referenceGains),
                };
                scores.push({
                    olderYear,
                    newerYear,
                    orientation,
                    ...support,
                    ...(localBaseline !== null && localScore !== null
                        ? { score: localScore, gain: localScore - localBaseline }
                        : scoreAgainstReferences(
                            corrected,
                            diagnosis,
                            context.difference,
                            firstDifferences,
                            mean,
                            context.difference.baselineMean,
                        )),
                });
            });
        }
    });
    return scores;
};

const adjacentPairCorrection = (
    diagnosis: SeriesCoreDiagnosis,
    olderYear: number,
    newerYear: number,
    orientation: AdjacentPairOrientation,
): NumericSeries => (
    orientation === "missingThenFalse"
        ? simulateDelete(
            simulateInsert(diagnosis.rawTarget, olderYear),
            newerYear,
        )
        : simulateInsert(
            simulateDelete(diagnosis.rawTarget, olderYear),
            newerYear,
        )
);

const adjacentPairSingleCorrections = (
    diagnosis: SeriesCoreDiagnosis,
    best: AdjacentPairScore,
): [NumericSeries, NumericSeries] => (
    best.orientation === "missingThenFalse"
        ? [
            simulateInsert(diagnosis.rawTarget, best.olderYear),
            simulateDelete(diagnosis.rawTarget, best.newerYear),
        ]
        : [
            simulateDelete(diagnosis.rawTarget, best.olderYear),
            simulateInsert(diagnosis.rawTarget, best.newerYear),
        ]
);

const adjacentPairSingleGains = (
    diagnosis: SeriesCoreDiagnosis,
    context: VotingContext,
    best: AdjacentPairScore,
    scoreMode: AdjacentPairScoreMode,
): {
    olderSingleGain: number;
    newerSingleGain: number;
    jointExcessGain: number;
} => {
    const [olderCorrection, newerCorrection] = adjacentPairSingleCorrections(
        diagnosis,
        best,
    );
    const gainFor = (corrected: NumericSeries): number => {
        if (scoreMode === "global") {
            return scoreAgainstReferences(
                corrected,
                diagnosis,
                context.difference,
                firstDifferences,
                mean,
                context.difference.baselineMean,
            ).gain;
        }
        const localRange = {
            startYear: best.olderYear - 16,
            endYear: best.newerYear + 16,
        };
        const baselineRows = correlationRowsForRange(
            firstDifferences(diagnosis.rawTarget),
            context.difference.references,
            localRange.startYear,
            localRange.endYear,
        );
        const correctedRows = correlationRowsForRange(
            firstDifferences(corrected),
            context.difference.references,
            localRange.startYear,
            localRange.endYear,
        );
        const gains = correctedRows.flatMap((value, index) => {
            const baseline = baselineRows[index];
            return value === null || baseline === null ? [] : [value - baseline];
        });
        return mean(gains);
    };
    const olderSingleGain = gainFor(olderCorrection);
    const newerSingleGain = gainFor(newerCorrection);
    return {
        olderSingleGain,
        newerSingleGain,
        jointExcessGain: best.gain - Math.max(olderSingleGain, newerSingleGain),
    };
};

const masterRemoteMarginForPair = (
    diagnosis: SeriesCoreDiagnosis,
    best: AdjacentPairScore,
): number => {
    const masterDifference = firstDifferences(diagnosis.master.data);
    const score = (olderYear: number, newerYear: number): number => (
        correlationForSegment(
            firstDifferences(adjacentPairCorrection(
                diagnosis,
                olderYear,
                newerYear,
                best.orientation,
            )),
            masterDifference,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
            0,
            30,
        ).correlation ?? -1
    );
    const bestScore = score(best.olderYear, best.newerYear);
    const years = candidateYears(diagnosis, 20);
    const durationBounds = unitPairDurationBounds({
        orientation: best.orientation,
        olderYear: best.olderYear,
        newerYear: best.newerYear,
        maximumDistance: 4,
    });
    let remoteScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < years.length; index += 2) {
        const olderYear = years[index];
        for (
            let duration = durationBounds.minimum;
            duration <= durationBounds.maximum;
            duration += 2
        ) {
            const newerYear = olderYear + duration;
            if (Math.abs(olderYear - best.olderYear) <= 7
                && Math.abs(newerYear - best.newerYear) <= 7) continue;
            if (!diagnosis.rawTarget.has(newerYear)) continue;
            remoteScore = Math.max(remoteScore, score(olderYear, newerYear));
        }
    }
    return bestScore - (
        Number.isFinite(remoteScore) ? remoteScore : bestScore
    );
};

const peakFor = (
    scores: VoteScore[],
    exclusionYears: number,
): VotePeak | null => {
    const best = [...scores].sort((a, b) => b.score - a.score || b.year - a.year)[0];
    if (!best) return null;
    const remote = scores
        .filter((score) => (
            Math.abs(score.year - best.year) > exclusionYears
            || score.shiftYears !== best.shiftYears
        ))
        .sort((a, b) => b.score - a.score)[0];
    return {
        ...best,
        remoteMargin: best.score - (remote?.score ?? best.score),
    };
};

const exhaustivePartialPeak = (
    diagnosis: SeriesCoreDiagnosis,
    maxPartialGapYears = DEFAULT_MAX_PARTIAL_GAP_YEARS,
): VotePeak | null => {
    const baseline = correlationForSegment(
        firstDifferences(diagnosis.rawTarget),
        firstDifferences(diagnosis.master.data),
        diagnosis.targetRange.startYear,
        diagnosis.targetRange.endYear,
        0,
        30,
    ).correlation ?? -1;
    const shifts = getAutomaticPartialShiftCandidates({
        maxPartialGapYears,
        lagMin: -maxPartialGapYears,
        seriesLength:
            diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
        minimumSideYears: 20,
    });
    const scores: VoteScore[] = shifts.flatMap((shiftYears) => (
        scoreFullIntervalShiftEvidence(
            diagnosis,
            shiftYears,
            20,
        ).map((row) => {
            const score = row.differenceCorrelation;
            return {
                eventType: "partialMove" as const,
                year: firstFixedYearFromLastMovedYear(row.year),
                shiftYears,
                score,
                gain: score - baseline,
            };
        })
    ));
    return peakFor(scores, 9);
};

const boundedWindow = (
    centerYear: number,
    width: number,
    diagnosis: SeriesCoreDiagnosis,
): { startYear: number; endYear: number } => {
    const maximumWidth = diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1;
    const actualWidth = Math.max(1, Math.min(width, maximumWidth));
    let startYear = centerYear - Math.floor((actualWidth - 1) / 2);
    startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(startYear, diagnosis.targetRange.endYear - actualWidth + 1),
    );
    return { startYear, endYear: startYear + actualWidth - 1 };
};

const nudgeExistingWindow = (
    event: DiagnosisEvent,
    targetYear: number,
    diagnosis: SeriesCoreDiagnosis,
): { startYear: number; endYear: number } => {
    const width = event.endYear - event.startYear + 1;
    const direction = targetYear < event.startYear
        ? -1
        : targetYear > event.endYear ? 1 : 0;
    const maximumStart = diagnosis.targetRange.endYear - width + 1;
    const startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(event.startYear + direction, maximumStart),
    );
    return { startYear, endYear: startYear + width - 1 };
};

const rankedYears = (
    window: { startYear: number; endYear: number },
    scores: VoteScore[],
): DiagnosisRankedYear[] => {
    const scoreByYear = new Map<number, number>();
    scores.forEach((row) => {
        const previous = scoreByYear.get(row.year) ?? Number.NEGATIVE_INFINITY;
        scoreByYear.set(row.year, Math.max(previous, row.score));
    });
    return Array.from({ length: window.endYear - window.startYear + 1 }, (_, index) => {
        const year = window.startYear + index;
        return {
            year,
            score: scoreByYear.get(year) ?? Number.NEGATIVE_INFINITY,
            evidenceTags: ["reference_core_voting"],
        };
    })
        .sort((a, b) => b.score - a.score || b.year - a.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
};

const fusedRankedYears = (
    event: DiagnosisEvent,
    window: { startYear: number; endYear: number },
    scores: VoteScore[],
): DiagnosisRankedYear[] => {
    const voteRows = rankedYears(window, scores);
    const voteRankByYear = new Map(voteRows.map((row) => [row.year, row.rank]));
    const priorRankByYear = new Map(event.rankedYears.map((row) => [row.year, row.rank]));
    const width = window.endYear - window.startYear + 1;
    const rankStrength = (rank: number | undefined): number => (
        rank === undefined || width <= 1 ? 0 : Math.max(0, (width - rank) / (width - 1))
    );
    return Array.from({ length: width }, (_, index) => {
        const year = window.startYear + index;
        const vote = voteRows.find((row) => row.year === year);
        const prior = event.rankedYears.find((row) => row.year === year);
        return {
            year,
            score: rankStrength(voteRankByYear.get(year)) * 0.7
                + rankStrength(priorRankByYear.get(year)) * 0.3,
            evidenceTags: Array.from(new Set([
                "reference_counterfactual_rank_fusion",
                ...(vote?.evidenceTags ?? []),
                ...(prior?.evidenceTags ?? []),
            ])).sort(),
        };
    })
        .sort((a, b) => b.score - a.score || b.year - a.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
};

const confidenceForGain = (gain: number): DiagnosisConfidence => (
    gain >= 0.15 ? "high" : gain >= 0.07 ? "medium" : "low"
);

const gainGate = (eventType: VoteKind): number => (
    eventType === "missingRing"
        ? MISSING_GAIN_GATE
        : eventType === "falseRing" ? FALSE_GAIN_GATE : PARTIAL_GAIN_GATE
);

export const passesReferenceRecoveryGate = (
    peak: ReferenceRecoveryPeakSummary,
): boolean => {
    if (peak.eventType === "missingRing") {
        return peak.gain >= MISSING_GAIN_GATE
            && (peak.gain >= 0.1 || peak.remoteMargin <= 0.01);
    }
    if (peak.eventType === "falseRing") return peak.gain >= 0.1;
    // A large year-by-shift grid produces attractive peaks even on clean series. Require the
    // winning gap to separate from all remote years and alternative shifts before recovering
    // an otherwise empty result. This gate is magnitude-neutral: -2 and -100 use the same rule.
    return peak.gain >= PARTIAL_RECOVERY_MINIMUM_GAIN
        && peak.remoteMargin >= PARTIAL_RECOVERY_MINIMUM_REMOTE_MARGIN;
};

const replaceWindow = (
    event: DiagnosisEvent,
    peak: VotePeak,
    scores: VoteScore[],
    diagnosis: SeriesCoreDiagnosis,
    centerYear = peak.year,
    reason = "reference_core_vote",
): DiagnosisEvent => {
    const window = nudgeExistingWindow(event, centerYear, diagnosis);
    const windowShift = window.startYear - event.startYear;
    return {
        ...event,
        id: `${event.id}-reference-vote-${window.startYear}-${window.endYear}`,
        ...window,
        rankedYears: fusedRankedYears(event, window, scores),
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "reference_core_voting",
                "reference_counterfactual_rank_fusion",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                `window_refinement=${reason}`,
                `window_before=${event.startYear}-${event.endYear}`,
                `reference_vote_year=${peak.year}`,
                `reference_vote_window_shift=${windowShift}`,
                `reference_vote_gain=${peak.gain.toFixed(6)}`,
                `reference_vote_remote_margin=${peak.remoteMargin.toFixed(6)}`,
                "reference_vote_score_is_not_probability",
            ],
        },
    };
};

const withPartialVoteAudit = (
    event: DiagnosisEvent,
    peak: VotePeak | null,
    exhaustive: VotePeak | null,
): DiagnosisEvent => ({
    ...event,
    evidence: {
        ...event.evidence,
        notes: [
            ...event.evidence.notes,
            ...(peak ? [
                `partial_reference_vote_year=${peak.year}`,
                `partial_reference_vote_shift=${peak.shiftYears ?? 0}`,
                `partial_reference_vote_gain=${peak.gain.toFixed(6)}`,
                `partial_reference_vote_margin=${peak.remoteMargin.toFixed(6)}`,
            ] : ["partial_reference_vote_unavailable"]),
            ...(exhaustive ? [
                `partial_exhaustive_vote_year=${exhaustive.year}`,
                `partial_exhaustive_vote_shift=${exhaustive.shiftYears ?? 0}`,
                `partial_exhaustive_vote_gain=${exhaustive.gain.toFixed(6)}`,
                `partial_exhaustive_vote_margin=${exhaustive.remoteMargin.toFixed(6)}`,
            ] : ["partial_exhaustive_vote_unavailable"]),
        ],
    },
});

const makeRecoveredEvent = (
    peak: VotePeak,
    scores: VoteScore[],
    alternatives: VotePeak[],
    diagnosis: SeriesCoreDiagnosis,
    auditedPeaks: VotePeak[],
): DiagnosisEvent => {
    const width = peak.eventType === "partialMove" ? 9 : 7;
    const window = boundedWindow(peak.year, width, diagnosis);
    const lagBefore = peak.eventType === "missingRing"
        ? -1
        : peak.eventType === "falseRing" ? 1 : peak.shiftYears ?? null;
    return {
        id: `diagnosis-event-${diagnosis.targetTree}-reference-vote-${peak.eventType}-${window.startYear}-${window.endYear}`,
        seriesId: diagnosis.targetTree,
        eventType: peak.eventType,
        ...window,
        rankedYears: rankedYears(window, scores),
        confidenceLevel: confidenceForGain(peak.gain),
        evidence: {
            algorithmSources: ["reference_core_voting"],
            score: peak.gain,
            scoreMargin: peak.remoteMargin,
            baselineCorrelation: diagnosis.globalSlidingMatch.currentR,
            correctedCorrelation: null,
            correlationGain: peak.gain,
            lagBefore,
            lagAfter: 0,
            samplePairs: diagnosis.globalSlidingMatch.currentOverlapYears,
            candidateIds: [],
            notes: [
                `reference_vote_year=${peak.year}`,
                `reference_vote_gain=${peak.gain.toFixed(6)}`,
                `reference_vote_remote_margin=${peak.remoteMargin.toFixed(6)}`,
                ...auditedPeaks.flatMap((candidate) => [
                    `reference_${candidate.eventType}_peak_year=${candidate.year}`,
                    `reference_${candidate.eventType}_peak_gain=${candidate.gain.toFixed(6)}`,
                    `reference_${candidate.eventType}_peak_margin=${candidate.remoteMargin.toFixed(6)}`,
                ]),
                "manual_review_only_no_executable_candidate",
                "reference_vote_score_is_not_probability",
            ],
        },
        alternativeTypes: alternatives.map((alternative) => alternative.eventType),
        ...(peak.eventType === "partialMove" ? {
            shiftYears: peak.shiftYears,
            shiftSide: "older" as const,
        } : {}),
    };
};

/** Paired counterfactual used only after a bounded lag pulse identifies orientation and bounds. */
const voteForAdjacentUnitPairWithMode = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    hint?: AdjacentUnitPairHint,
    scoreMode: AdjacentPairScoreMode = "global",
): AdjacentUnitPairVote | null => {
    const context = buildContext(diagnosis, siteData);
    if (context.difference.references.length === 0) return null;
    const scores = scanAdjacentUnitPairs(diagnosis, context, scoreMode, hint);
    const eligibleScores = hint
        ? scores.filter((row) => (
            row.orientation === hint.orientation
            && Math.abs(row.olderYear - hint.olderYear) <= hint.maximumDistance
            && Math.abs(row.newerYear - hint.newerYear) <= hint.maximumDistance
        ))
        : scores;
    const scoreValue = (row: AdjacentPairScore) => (
        scoreMode === "localized" ? row.gain : row.score
    );
    const best = [...eligibleScores].sort((a, b) => scoreValue(b) - scoreValue(a))[0];
    if (!best) return null;
    const remote = scores
        .filter((row) => (
            row.orientation !== best.orientation
            || Math.abs(row.olderYear - best.olderYear) > 7
            || Math.abs(row.newerYear - best.newerYear) > 7
        ))
        .sort((a, b) => scoreValue(b) - scoreValue(a))[0];
    const remoteMargin = scoreValue(best) - (remote ? scoreValue(remote) : scoreValue(best));
    const masterRemoteMargin = hint
        ? masterRemoteMarginForPair(diagnosis, best)
        : 0;
    const singleGains = adjacentPairSingleGains(
        diagnosis,
        context,
        best,
        scoreMode,
    );
    const boundaries = best.orientation === "missingThenFalse"
        ? [
            { eventType: "missingRing" as const, year: best.olderYear, lags: [0, 1] as const },
            { eventType: "falseRing" as const, year: best.newerYear, lags: [1, 0] as const },
        ]
        : [
            { eventType: "falseRing" as const, year: best.olderYear, lags: [0, -1] as const },
            { eventType: "missingRing" as const, year: best.newerYear, lags: [-1, 0] as const },
        ];
    const events = boundaries.map(({ eventType, year, lags }) => {
        const centerYear = eventType === "missingRing" ? year + 1 : year;
        const window = boundedWindow(centerYear, 9, diagnosis);
        const boundaryScores: VoteScore[] = scores
            .filter((row) => row.orientation === best.orientation)
            .map((row) => ({
                eventType,
                year: eventType === (best.orientation === "missingThenFalse"
                    ? "missingRing"
                    : "falseRing")
                    ? row.olderYear
                    : row.newerYear,
                score: scoreValue(row),
                gain: row.gain,
            }));
        return {
            id: `diagnosis-event-${diagnosis.targetTree}-reference-pair-${eventType}-${window.startYear}-${window.endYear}`,
            seriesId: diagnosis.targetTree,
            eventType,
            ...window,
            rankedYears: rankedYears(window, boundaryScores),
            confidenceLevel: confidenceForGain(best.gain),
            evidence: {
                algorithmSources: ["reference_core_pair_voting"],
                score: best.gain,
                scoreMargin: remoteMargin,
                baselineCorrelation: context.difference.baselineMean,
                correctedCorrelation: best.score,
                correlationGain: best.gain,
                lagBefore: lags[0],
                lagAfter: lags[1],
                samplePairs: diagnosis.globalSlidingMatch.currentOverlapYears,
                candidateIds: [],
                notes: [
                    `reference_pair_orientation=${best.orientation}`,
                    `reference_pair_years=${best.olderYear}-${best.newerYear}`,
                    `reference_pair_gain=${best.gain.toFixed(6)}`,
                    `reference_pair_remote_margin=${remoteMargin.toFixed(6)}`,
                    `reference_pair_score_mode=${scoreMode}`,
                    `reference_pair_reference_count=${best.referenceCount}`,
                    `reference_pair_positive_fraction=${best.positiveReferenceFraction.toFixed(6)}`,
                    `reference_pair_median_reference_gain=${best.medianReferenceGain.toFixed(6)}`,
                    `reference_pair_lower_quartile_gain=${best.lowerQuartileReferenceGain.toFixed(6)}`,
                    `reference_pair_master_remote_margin=${masterRemoteMargin.toFixed(6)}`,
                    `reference_pair_older_single_gain=${singleGains.olderSingleGain.toFixed(6)}`,
                    `reference_pair_newer_single_gain=${singleGains.newerSingleGain.toFixed(6)}`,
                    `reference_pair_joint_excess_gain=${singleGains.jointExcessGain.toFixed(6)}`,
                    "manual_review_only_no_executable_candidate",
                    "reference_vote_score_is_not_probability",
                ],
            },
            alternativeTypes: [],
        } satisfies DiagnosisEvent;
    });
    return {
        events,
        orientation: best.orientation,
        olderYear: best.olderYear,
        newerYear: best.newerYear,
        gain: best.gain,
        remoteMargin,
        referenceCount: best.referenceCount,
        positiveReferenceFraction: best.positiveReferenceFraction,
        medianReferenceGain: best.medianReferenceGain,
        lowerQuartileReferenceGain: best.lowerQuartileReferenceGain,
        masterRemoteMargin,
        ...singleGains,
    };
};

export const voteForAdjacentUnitPair = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    hint?: AdjacentUnitPairHint,
): AdjacentUnitPairVote | null => voteForAdjacentUnitPairWithMode(
    diagnosis,
    siteData,
    hint,
    "global",
);

export const voteForAdjacentUnitPairLocalized = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    hint?: AdjacentUnitPairHint,
): AdjacentUnitPairVote | null => voteForAdjacentUnitPairWithMode(
    diagnosis,
    siteData,
    hint,
    "localized",
);

const collapseRepeatedPartialViews = (events: DiagnosisEvent[]): DiagnosisEvent[] => {
    const otherEvents = events.filter((event) => event.eventType !== "partialMove");
    const groups: DiagnosisEvent[][] = [];
    events
        .filter((event) => event.eventType === "partialMove")
        .forEach((event) => {
            const signature = [
                event.shiftSide,
                event.shiftYears,
                event.evidence.lagBefore,
                event.evidence.lagAfter,
            ].join(":");
            const group = groups.find((candidate) => {
                const representative = candidate[0];
                const candidateSignature = [
                    representative.shiftSide,
                    representative.shiftYears,
                    representative.evidence.lagBefore,
                    representative.evidence.lagAfter,
                ].join(":");
                return candidateSignature === signature
                    && candidate.some((member) => (
                        Math.max(member.startYear, event.startYear)
                            <= Math.min(member.endYear, event.endYear)
                    ));
            });
            if (group) group.push(event);
            else groups.push([event]);
        });
    const partialEvents = groups.map((group) => {
        if (group.length === 1) return group[0];
        const selected = [...group].sort((a, b) => (
            b.evidence.score - a.evidence.score || b.endYear - a.endYear
        ))[0];
        return {
            ...selected,
            evidence: {
                ...selected.evidence,
                algorithmSources: Array.from(new Set(
                    group.flatMap((event) => event.evidence.algorithmSources),
                )).sort(),
                candidateIds: Array.from(new Set(
                    group.flatMap((event) => event.evidence.candidateIds),
                )),
                notes: Array.from(new Set([
                    ...selected.evidence.notes,
                    `collapsed_repeated_partial_views=${group.length}`,
                    `collapsed_partial_ranges=${group
                        .map((event) => `${event.startYear}-${event.endYear}`)
                        .join(",")}`,
                ])),
            },
        };
    });
    const completeTransitions = partialEvents.filter((event) => (
        event.evidence.lagAfter === 0
    ));
    const filteredPartialEvents = partialEvents.filter((event) => (
        event.evidence.lagAfter === 0
        || !completeTransitions.some((complete) => (
            complete.evidence.lagBefore === event.evidence.lagBefore
            && complete.shiftSide === event.shiftSide
        ))
    ));
    return [...otherEvents, ...filteredPartialEvents].sort((a, b) => (
        b.endYear - a.endYear || b.evidence.score - a.evidence.score
    ));
};

/**
 * Refines at most one local event. Multi-event output is left untouched because one-edit
 * counterfactual scans cannot safely explain multiple interacting chronology changes.
 */
export const refineEventsWithReferenceVoting = (
    events: DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    maxPartialGapYears = DEFAULT_MAX_PARTIAL_GAP_YEARS,
): DiagnosisEvent[] => {
    const collapsedEvents = collapseRepeatedPartialViews(events);
    const wholeEvents = collapsedEvents.filter((event) => event.eventType === "wholeSeriesMove");
    const localEvents = collapsedEvents.filter((event) => event.eventType !== "wholeSeriesMove");
    if (wholeEvents.length > 0 || localEvents.length > 1) return collapsedEvents;

    const structuralPartial = localEvents[0];
    if (structuralPartial?.eventType === "partialMove"
        && structuralPartial.evidence.algorithmSources.includes(
            "unique_repeated_block_boundary",
        )) {
        return collapsedEvents;
    }

    const current = localEvents[0];
    if (current) {
        if (current.evidence.algorithmSources.includes("local_counterfactual_raw_year")
            || current.evidence.algorithmSources.includes("paired_core_counterfactual_year")) {
            return collapsedEvents;
        }
    }

    const context = buildContext(diagnosis, siteData);
    if (context.difference.references.length === 0 || context.whitened.references.length === 0) {
        return collapsedEvents;
    }

    if (current) {
        if (current.eventType === "missingRing") {
            const scores = scanMissing(diagnosis, context);
            const peak = peakFor(scores, 7);
            return peak
                && peak.gain >= MISSING_GAIN_GATE
                && peak.remoteMargin >= 0.01
                ? [replaceWindow(current, peak, scores, diagnosis)]
                : collapsedEvents;
        }
        if (current.eventType === "falseRing") {
            const scores = scanFalse(diagnosis, context);
            const peak = peakFor(scores, 7);
            const marginGate = current.confidenceLevel === "low" ? 0.002 : 0.005;
            return peak
                && peak.gain >= FALSE_GAIN_GATE
                && current.confidenceLevel !== "high"
                && peak.remoteMargin >= marginGate
                ? [replaceWindow(current, peak, scores, diagnosis)]
                : collapsedEvents;
        }
        if (current.eventType === "partialMove") {
            const scores = scanPartial(
                diagnosis,
                context,
                maxPartialGapYears,
            );
            const peak = peakFor(scores, 9);
            const exhaustive = exhaustivePartialPeak(
                diagnosis,
                maxPartialGapYears,
            );
            const audited = withPartialVoteAudit(current, peak, exhaustive);
            if (!peak || peak.shiftYears !== current.shiftYears) return [audited];
            const selectVote = peak.gain >= PARTIAL_GAIN_GATE
                && ((current.confidenceLevel === "high" && peak.remoteMargin >= 0.022)
                    || (current.confidenceLevel === "low" && peak.remoteMargin <= 0.002));
            if (selectVote) return [replaceWindow(audited, peak, scores, diagnosis)];

            const currentTop = current.rankedYears[0]?.year
                ?? Math.floor((current.startYear + current.endYear) / 2);
            const useFusion = current.confidenceLevel === "high"
                && peak.shiftYears === current.shiftYears
                && Math.abs(peak.year - currentTop) <= 2
                && exhaustive !== null
                && exhaustive.shiftYears === current.shiftYears
                && exhaustive.year - currentTop >= 8
                && exhaustive.year - currentTop <= 12
                && exhaustive.gain >= peak.gain + 0.05;
            return useFusion
                ? [replaceWindow(
                    audited,
                    peak,
                    scores,
                    diagnosis,
                    Math.round((currentTop + exhaustive.year) / 2),
                    "reference_vote_global_fusion",
                )]
                : [audited];
        }
        return collapsedEvents;
    }

    const auditedPeaks = [
        { scores: scanMissing(diagnosis, context), width: 7 },
        { scores: scanFalse(diagnosis, context), width: 7 },
        {
            scores: scanPartial(diagnosis, context, maxPartialGapYears),
            width: 9,
        },
    ].map(({ scores, width }) => ({ scores, peak: peakFor(scores, width) }))
        .filter((row): row is { scores: VoteScore[]; peak: VotePeak } => row.peak !== null);
    const scored = auditedPeaks
        .filter((row): row is { scores: VoteScore[]; peak: VotePeak } => (
            row.peak.gain >= gainGate(row.peak.eventType)
            && passesReferenceRecoveryGate(row.peak)
        ))
        .sort((a, b) => b.peak.gain - a.peak.gain);
    const selectedType = selectReferenceRecoveryEventType(
        scored.map((row) => row.peak),
        auditedPeaks.map((row) => row.peak),
    );
    const selected = selectedType === null
        ? undefined
        : auditedPeaks.find((row) => row.peak.eventType === selectedType);
    if (!selected) return collapsedEvents;
    return [makeRecoveredEvent(
        selected.peak,
        selected.scores,
        scored
            .filter((row) => row !== selected)
            .map((row) => row.peak),
        diagnosis,
        auditedPeaks.map((row) => row.peak),
    )];
};
