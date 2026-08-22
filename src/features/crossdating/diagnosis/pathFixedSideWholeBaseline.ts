/**
 * Recover an executable whole-series baseline from the newer fixed side of a coherent local
 * lag path. All edits in this module are in-memory counterfactuals; caller data is never mutated.
 */
import {
    deleteYearWithMode,
    insertMissingYearAtSide,
    moveSeriesTailByOffset,
} from "@/features/rwl/edit";
import type { RwlSiteData } from "@/features/rwl/types";
import { evaluateDraft } from "./evaluation";
import { isExactPartialLagTransition } from "./partialMoveSemantics";
import {
    getRepresentativeSegmentForLag,
    runSlidingMatchForRange,
} from "./rangeMove";
import { diagnoseSeriesCore } from "./segments";
import type {
    CandidateDraft,
    DiagnosisCandidateOperation,
    DiagnosisEvent,
    EffectiveDiagnosisConfig,
    SeriesCoreDiagnosis,
} from "./types";

export type RecentTailLagConsensus = {
    lag: number;
    supportCount: number;
    competingSupportCount: number;
    rows: Array<{
        width: number;
        startYear: number;
        endYear: number;
        bestLag: number;
        bestR: number | null;
        overlapYears: number;
    }>;
};

export type FixedSideLagResolution = {
    lag: number;
    source: "unanimous_recent_tail" | "recent_tail_newest_segment";
    supportCount: number;
    totalCount: number;
    competingSupportCount: number;
    medianCorrelation: number;
    newestSegmentLag: number | null;
    rows: RecentTailLagConsensus["rows"];
};

export type PathTerminalLagEvidence = {
    lag: number;
    margin: number;
    pairs: number;
};

/**
 * Rank independently validated whole-series baselines by the evidence that identifies the
 * fixed newer side. Scores from different locator families are not directly comparable.
 */
export const wholeBaselineCandidatePriority = (
    candidate: DiagnosisCandidateOperation,
): number => {
    const tags = candidate.evidence.recallSourceTags ?? [];
    const joint = candidate.evidence.evaluationDelta?.jointCompositionGatePassed === true;
    const hard = candidate.evidence.evaluationDelta?.hardGatePassed === true;
    const tagNumber = (prefix: string): number => {
        const value = Number(tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length));
        return Number.isFinite(value) ? value : Number.NaN;
    };
    const tailSupport = tagNumber("recent_tail_support_count:");
    const tailTotal = tagNumber("recent_tail_total_count:");
    const highQualityTail = tags.includes("recent_tail_whole_baseline")
        && hard
        && tailSupport >= 4
        && tailSupport === tailTotal
        && tagNumber("recent_tail_competing_support:") === 0
        && tagNumber("recent_tail_median_r:") >= 0.7;
    if (tags.includes("cofecha_terminal_whole_baseline") && (joint || hard)) return 100;
    if (joint && tags.includes("recent_tail_global_agreement")) return 90;
    if ((joint || hard) && tags.includes("recent_tail_residual_partial_baseline")) return 80;
    if (joint && tags.includes("recent_tail_path_terminal_agreement")) return 70;
    if (joint && tags.includes("path_fixed_side_event_type:partialMove")) return 60;
    if (joint && tags.includes("recent_tail_whole_baseline")) return 50;
    if (highQualityTail) return 45;
    if (joint && tags.includes("path_fixed_side_whole_baseline")) return 40;
    if (hard && tags.includes("recent_tail_whole_baseline")) return 30;
    if (hard && tags.includes("path_fixed_side_whole_baseline")) return 20;
    return 0;
};

/** Independent terminal-state view that does not assume the newest detected transition is last. */
export const measureRecentTailLagConsensus = (
    diagnosis: SeriesCoreDiagnosis,
    effectiveConfig: EffectiveDiagnosisConfig,
    widths: readonly number[] = [20, 21, 22, 23],
    recoveryLagRadius = 10,
): RecentTailLagConsensus | null => {
    const tailConfig: EffectiveDiagnosisConfig = {
        ...effectiveConfig,
        globalLagMin: Math.max(effectiveConfig.globalLagMin, -recoveryLagRadius),
        globalLagMax: Math.min(effectiveConfig.globalLagMax, recoveryLagRadius),
    };
    const rows = widths
        .map((requestedWidth) => {
            const width = Math.min(
                requestedWidth,
                diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
            );
            const endYear = diagnosis.targetRange.endYear;
            const startYear = endYear - width + 1;
            const match = runSlidingMatchForRange(
                diagnosis,
                { startYear, endYear },
                tailConfig,
            );
            return {
                width,
                startYear,
                endYear,
                bestLag: match.bestGlobalLag,
                bestR: match.bestGlobalR,
                overlapYears: match.overlapYears,
            };
        })
        .filter((row) => row.bestR !== null && row.overlapYears >= effectiveConfig.minLocalOverlap);
    if (rows.length < 2) return null;
    const support = rows.reduce((counts, row) => {
        const current = counts.get(row.bestLag) ?? { count: 0, rSum: 0 };
        current.count += 1;
        current.rSum += row.bestR ?? -1;
        counts.set(row.bestLag, current);
        return counts;
    }, new Map<number, { count: number; rSum: number }>());
    const ordered = Array.from(support.entries()).sort((left, right) => (
        right[1].count - left[1].count
        || right[1].rSum - left[1].rSum
        || Math.abs(left[0]) - Math.abs(right[0])
    ));
    const [best, second] = ordered;
    if (!best) return null;
    return {
        lag: best[0],
        supportCount: best[1].count,
        competingSupportCount: second?.[1].count ?? 0,
        rows,
    };
};

/**
 * Resolve the untouched bark-side coordinate frame without using the full-series majority lag.
 * A short tail can have an accidental best match, so a split vote only becomes authoritative
 * when the same lag is independently present in the newest ordinary diagnosis segment.
 */
export const resolveFixedSideLag = (
    diagnosis: SeriesCoreDiagnosis,
    effectiveConfig: EffectiveDiagnosisConfig,
): FixedSideLagResolution | null => {
    const measured = measureRecentTailLagConsensus(diagnosis, effectiveConfig);
    if (!measured || measured.rows.length < 3) return null;

    const newestSegment = diagnosis.segments
        .filter((segment) => segment.bestR !== null && segment.samplePairs >= 8)
        .slice()
        .sort((left, right) => (
            right.endYear - left.endYear
            || right.startYear - left.startYear
        ))[0] ?? null;
    const grouped = Array.from(measured.rows.reduce((groups, row) => {
        const current = groups.get(row.bestLag) ?? [];
        current.push(row);
        groups.set(row.bestLag, current);
        return groups;
    }, new Map<number, RecentTailLagConsensus["rows"]>()));
    const rowQuality = (rows: RecentTailLagConsensus["rows"]): {
        median: number;
        maximum: number;
    } => {
        const correlations = rows
            .map((row) => row.bestR)
            .filter((value): value is number => value !== null)
            .sort((left, right) => left - right);
        return {
            median: correlations[Math.floor(correlations.length / 2)]
                ?? Number.NEGATIVE_INFINITY,
            maximum: Math.max(...correlations, Number.NEGATIVE_INFINITY),
        };
    };
    const maximumObservedCorrelation = Math.max(
        ...measured.rows.map((row) => row.bestR ?? Number.NEGATIVE_INFINITY),
    );
    const ordered = grouped.map(([lag, rows]) => {
        const quality = rowQuality(rows);
        return { lag, rows, ...quality };
    }).sort((left, right) => (
        right.rows.length - left.rows.length
        || right.median - left.median
        || Math.abs(left.lag) - Math.abs(right.lag)
    ));
    const unanimous = ordered.find((entry) => (
        entry.rows.length === measured.rows.length
        && entry.median >= 0.45
    ));
    const segmentBacked = newestSegment
        ? ordered.find((entry) => (
            entry.lag === newestSegment.bestLag
            && entry.rows.length >= 2
            && entry.median >= 0.4
            && maximumObservedCorrelation - entry.maximum <= 0.08
        ))
        : null;
    const selected = unanimous ?? segmentBacked;
    if (!selected) return null;
    const competingSupportCount = Math.max(
        0,
        ...ordered
            .filter((entry) => entry.lag !== selected.lag)
            .map((entry) => entry.rows.length),
    );
    return {
        lag: selected.lag,
        source: unanimous
            ? "unanimous_recent_tail"
            : "recent_tail_newest_segment",
        supportCount: selected.rows.length,
        totalCount: measured.rows.length,
        competingSupportCount,
        medianCorrelation: selected.median,
        newestSegmentLag: newestSegment?.bestLag ?? null,
        rows: measured.rows,
    };
};

/**
 * Recover a short-range terminal state that mixed local events can hide from the full-series
 * optimum. This only proposes a draft; full-series counterfactual evaluation remains mandatory.
 */
export const makeRecentTailWholeDraft = (
    diagnosis: SeriesCoreDiagnosis,
    effectiveConfig: EffectiveDiagnosisConfig,
): CandidateDraft | null => {
    const resolution = resolveFixedSideLag(diagnosis, effectiveConfig);
    // Positive whole-series shifts are available to manual editing only. Automatic dating
    // suggestions use a negative correction frame; zero means no whole-series correction.
    if (!resolution || resolution.lag >= 0) return null;
    const supportingRows = resolution.rows.filter((row) => (
        row.bestLag === resolution.lag
    ));
    const sourceSegment = getRepresentativeSegmentForLag(diagnosis, resolution.lag);
    if (!sourceSegment) return null;
    return {
        targetTree: diagnosis.targetTree,
        operationType: "SHIFT_RANGE",
        candidateType: "batchMoveYears",
        mode: "wholeSeriesMove",
        anchorYear: diagnosis.targetRange.endYear,
        selectedRange: { ...diagnosis.targetRange },
        deltaYears: resolution.lag,
        sourceSegment,
        algorithmSource: ["global_sliding_match", "segmented_diagnosis"],
        recallSourceTags: [
            "recent_tail_whole_baseline",
            `recent_tail_lag:${resolution.lag}`,
            `recent_tail_resolution_source:${resolution.source}`,
            `recent_tail_newest_segment_lag:${resolution.newestSegmentLag ?? "none"}`,
            `recent_tail_support:${resolution.supportCount}/${resolution.totalCount}`,
            `recent_tail_support_count:${resolution.supportCount}`,
            `recent_tail_total_count:${resolution.totalCount}`,
            `recent_tail_competing_support:${resolution.competingSupportCount}`,
            `recent_tail_context_years:${Math.min(...supportingRows.map((row) => row.width))}`,
            `recent_tail_median_r:${resolution.medianCorrelation.toFixed(6)}`,
        ],
    };
};

const pathTransitionMatchesOperation = (event: DiagnosisEvent): boolean => {
    const lagBefore = event.evidence.lagBefore;
    const lagAfter = event.evidence.lagAfter;
    if (!Number.isInteger(lagBefore) || !Number.isInteger(lagAfter)) return false;
    if (event.eventType === "missingRing") return lagAfter! - lagBefore! === 1;
    if (event.eventType === "falseRing") return lagBefore! - lagAfter! === 1;
    return event.eventType === "partialMove"
        && isExactPartialLagTransition(event.shiftYears, lagBefore, lagAfter);
};

const isSupportedPathTransitionSource = (event: DiagnosisEvent): boolean => (
    event.evidence.algorithmSources.includes("piecewise_lag_path")
    || event.evidence.algorithmSources.includes("bounded_complete_lag_path")
);

const topRankedEventYear = (event: DiagnosisEvent): number => (
    event.rankedYears
        .slice()
        .sort((left, right) => left.rank - right.rank)[0]?.year
    ?? Math.round((event.startYear + event.endYear) / 2)
);

const coherentPathSuffixFromFixedLag = (
    pathEvents: readonly DiagnosisEvent[],
    fixedSideLag: number,
): DiagnosisEvent[] => {
    const ordered = pathEvents
        .filter((event) => (
            event.eventType !== "wholeSeriesMove"
            && isSupportedPathTransitionSource(event)
            && pathTransitionMatchesOperation(event)
        ))
        .sort((left, right) => (
            topRankedEventYear(right) - topRankedEventYear(left)
            || right.evidence.score - left.evidence.score
        ));
    const chain: DiagnosisEvent[] = [];
    let currentState = fixedSideLag;
    for (const event of ordered) {
        if (event.evidence.lagAfter !== currentState) {
            if (chain.length > 0) break;
            continue;
        }
        chain.push(event);
        currentState = event.evidence.lagBefore!;
    }
    return chain;
};

type PathFixedSideCompositionEvidence = {
    passed: boolean;
    eventCount: number;
    afterBestGlobalLag: number;
    wholeSeriesRDelta: number;
    meanSegmentRDelta: number;
    problemReduction: number;
};

const meanUsableSegmentCorrelation = (diagnosis: SeriesCoreDiagnosis): number => {
    const values = diagnosis.segments
        .map((segment) => segment.r0)
        .filter((value): value is number => value !== null);
    return values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : -1;
};

export const measurePathFixedSideComposition = (
    siteData: RwlSiteData,
    diagnosis: SeriesCoreDiagnosis,
    pathEvents: readonly DiagnosisEvent[],
    fixedSideLag: number,
    effectiveConfig: EffectiveDiagnosisConfig,
): PathFixedSideCompositionEvidence | null => {
    const originalTree = siteData.get(diagnosis.targetTree);
    if (!originalTree) return null;
    const chain = coherentPathSuffixFromFixedLag(pathEvents, fixedSideLag);
    if (chain.length === 0) return null;

    let workingTree = new Map(originalTree);
    let olderCoordinateOffset = 0;
    const generousOlderBound = diagnosis.targetRange.startYear
        - effectiveConfig.maxPartialGapYears
        - chain.length
        - Math.abs(fixedSideLag);
    chain.forEach((event) => {
        const adjustedYear = topRankedEventYear(event) + olderCoordinateOffset;
        const correctionYears = event.evidence.lagBefore! - event.evidence.lagAfter!;
        if (event.eventType === "missingRing") {
            workingTree = insertMissingYearAtSide(workingTree, adjustedYear, "right");
        } else if (event.eventType === "falseRing") {
            workingTree = deleteYearWithMode(workingTree, adjustedYear, "direct", "right");
        } else if (event.eventType === "partialMove") {
            workingTree = moveSeriesTailByOffset(
                workingTree,
                generousOlderBound,
                adjustedYear - 1,
                correctionYears,
            );
        }
        olderCoordinateOffset += correctionYears;
    });
    workingTree = moveSeriesTailByOffset(
        workingTree,
        generousOlderBound - effectiveConfig.maxPartialGapYears,
        diagnosis.targetRange.endYear + effectiveConfig.maxPartialGapYears,
        fixedSideLag,
    );
    const correctedSite = new Map(siteData);
    correctedSite.set(diagnosis.targetTree, workingTree);
    const after = diagnoseSeriesCore(
        correctedSite,
        diagnosis.targetTree,
        effectiveConfig,
    );
    if (!after) return null;

    const wholeSeriesRDelta = (after.globalSlidingMatch.currentR ?? -1)
        - (diagnosis.globalSlidingMatch.currentR ?? -1);
    const meanSegmentRDelta = meanUsableSegmentCorrelation(after)
        - meanUsableSegmentCorrelation(diagnosis);
    const problemReduction = diagnosis.unresolvedA + diagnosis.unresolvedB
        - after.unresolvedA - after.unresolvedB;
    return {
        passed: after.globalSlidingMatch.bestGlobalLag === 0
            && problemReduction >= 0
            && (
                wholeSeriesRDelta >= 0.02
                || meanSegmentRDelta >= 0.02
                || problemReduction >= 1
            ),
        eventCount: chain.length,
        afterBestGlobalLag: after.globalSlidingMatch.bestGlobalLag,
        wholeSeriesRDelta,
        meanSegmentRDelta,
        problemReduction,
    };
};

/** Return a hypothesis only; it must still pass ordinary or joint counterfactual evaluation. */
export const makePathFixedSideWholeDraft = (
    diagnosis: SeriesCoreDiagnosis,
    pathEvents: readonly DiagnosisEvent[],
    effectiveConfig: EffectiveDiagnosisConfig,
    minimumNewerContextYears = 18,
): CandidateDraft | null => {
    const eligible = pathEvents
        .filter((event) => (
            event.eventType !== "wholeSeriesMove"
            && isSupportedPathTransitionSource(event)
            && pathTransitionMatchesOperation(event)
            && event.evidence.score >= 1
            && event.evidence.samplePairs >= effectiveConfig.minPairsForCorrelation
            && Number.isInteger(event.evidence.lagAfter)
            && event.evidence.lagAfter !== 0
            && event.evidence.lagAfter! >= effectiveConfig.globalLagMin
            && event.evidence.lagAfter! <= effectiveConfig.globalLagMax
            && diagnosis.targetRange.endYear - topRankedEventYear(event)
                >= minimumNewerContextYears
        ))
        .sort((left, right) => (
            topRankedEventYear(right) - topRankedEventYear(left)
            || right.evidence.score - left.evidence.score
        ));
    const transition = eligible[0];
    if (!transition) return null;

    const fixedSideLag = transition.evidence.lagAfter!;
    const boundaryYear = topRankedEventYear(transition);
    const sourceSegment = diagnosis.segments
        .slice()
        .sort((left, right) => (
            Number(right.bestLag === fixedSideLag) - Number(left.bestLag === fixedSideLag)
            || Number(right.startYear > boundaryYear) - Number(left.startYear > boundaryYear)
            || Math.abs((left.startYear + left.endYear) / 2 - boundaryYear)
                - Math.abs((right.startYear + right.endYear) / 2 - boundaryYear)
            || right.samplePairs - left.samplePairs
        ))[0];
    if (!sourceSegment) return null;

    return {
        targetTree: diagnosis.targetTree,
        operationType: "SHIFT_RANGE",
        candidateType: "batchMoveYears",
        mode: "wholeSeriesMove",
        anchorYear: diagnosis.targetRange.endYear,
        selectedRange: { ...diagnosis.targetRange },
        deltaYears: fixedSideLag,
        sourceSegment,
        algorithmSource: ["piecewise_lag_path", "segmented_diagnosis"],
        recallSourceTags: [
            "path_fixed_side_whole_baseline",
            ...(transition.evidence.algorithmSources.includes(
                "bounded_complete_lag_path",
            ) ? ["bounded_fixed_side_whole_baseline"] : []),
            `path_fixed_side_lag:${fixedSideLag}`,
            `path_fixed_side_event_type:${transition.eventType}`,
            `path_fixed_side_transition:${transition.evidence.lagBefore}->${fixedSideLag}`,
            `path_fixed_side_event_score:${transition.evidence.score.toFixed(6)}`,
            `path_fixed_side_newer_context_years:${
                diagnosis.targetRange.endYear - boundaryYear
            }`,
        ],
    };
};

export const evaluatePathFixedSideWholeCandidate = (
    siteData: RwlSiteData,
    diagnosis: SeriesCoreDiagnosis,
    pathEvents: readonly DiagnosisEvent[],
    effectiveConfig: EffectiveDiagnosisConfig,
    pathTerminal?: PathTerminalLagEvidence,
    additionalRecallSourceTags: readonly string[] = [],
): DiagnosisCandidateOperation | null => {
    const measuredTailDraft = makeRecentTailWholeDraft(diagnosis, effectiveConfig);
    const rawTailDraft = measuredTailDraft
        && diagnosis.globalSlidingMatch.bestGlobalLag === measuredTailDraft.deltaYears
        ? {
            ...measuredTailDraft,
            recallSourceTags: [
                ...(measuredTailDraft.recallSourceTags ?? []),
                "recent_tail_global_agreement",
                `recent_tail_global_lag:${diagnosis.globalSlidingMatch.bestGlobalLag}`,
            ],
        }
        : measuredTailDraft;
    const basePathDraft = makePathFixedSideWholeDraft(
        diagnosis,
        pathEvents,
        effectiveConfig,
    );
    const pathDraft = basePathDraft ? {
        ...basePathDraft,
        recallSourceTags: Array.from(new Set([
            ...(basePathDraft.recallSourceTags ?? []),
            ...additionalRecallSourceTags,
        ])),
    } : null;
    const pathComposition = pathDraft ? measurePathFixedSideComposition(
        siteData,
        diagnosis,
        pathEvents,
        pathDraft.deltaYears!,
        effectiveConfig,
    ) : null;
    const residualPartialShift = rawTailDraft && pathDraft
        ? pathDraft.deltaYears! - rawTailDraft.deltaYears!
        : 0;
    const tailDraft = rawTailDraft
        && pathDraft
        && pathComposition?.passed
        && residualPartialShift <= -2
        && residualPartialShift >= -effectiveConfig.maxPartialGapYears
        ? {
            ...rawTailDraft,
            recallSourceTags: [
                ...(rawTailDraft.recallSourceTags ?? []),
                "recent_tail_residual_partial_baseline",
                `recent_tail_residual_path_lag:${pathDraft.deltaYears}`,
                `recent_tail_residual_partial_shift:${residualPartialShift}`,
                `recent_tail_residual_path_event_count:${pathComposition.eventCount}`,
                `recent_tail_residual_path_after_global_lag:${
                    pathComposition.afterBestGlobalLag
                }`,
                `recent_tail_residual_path_whole_r_delta:${
                    pathComposition.wholeSeriesRDelta.toFixed(6)
                }`,
                `recent_tail_residual_path_mean_segment_r_delta:${
                    pathComposition.meanSegmentRDelta.toFixed(6)
                }`,
                `recent_tail_residual_path_problem_reduction:${
                    pathComposition.problemReduction
                }`,
            ],
        }
        : rawTailDraft;
    const drafts = [
        tailDraft,
        pathDraft,
    ].filter((draft): draft is CandidateDraft => draft !== null)
        .filter((draft, index, rows) => rows.findIndex((row) => (
            row.deltaYears === draft.deltaYears
        )) === index);
    const accepted: DiagnosisCandidateOperation[] = [];
    for (const draft of drafts) {
        const terminalAgreement = draft.recallSourceTags?.includes(
            "recent_tail_whole_baseline",
        ) === true
            && pathTerminal
            && pathTerminal.lag === draft.deltaYears;
        const terminalDraft: CandidateDraft = terminalAgreement
            ? {
                ...draft,
                recallSourceTags: [
                    ...(draft.recallSourceTags ?? []),
                    "recent_tail_path_terminal_agreement",
                    `recent_tail_path_lag:${pathTerminal.lag}`,
                    `recent_tail_path_margin:${pathTerminal.margin.toFixed(6)}`,
                    `recent_tail_path_pairs:${pathTerminal.pairs}`,
                ],
            }
            : draft;
        const composition = measurePathFixedSideComposition(
            siteData,
            diagnosis,
            pathEvents,
            draft.deltaYears!,
            effectiveConfig,
        );
        const compositionTags = composition ? [
            `path_fixed_side_joint_event_count:${composition.eventCount}`,
            `path_fixed_side_joint_after_global_lag:${composition.afterBestGlobalLag}`,
            `path_fixed_side_joint_whole_r_delta:${
                composition.wholeSeriesRDelta.toFixed(6)
            }`,
            `path_fixed_side_joint_mean_segment_r_delta:${
                composition.meanSegmentRDelta.toFixed(6)
            }`,
            `path_fixed_side_joint_problem_reduction:${composition.problemReduction}`,
        ] : [];
        const evaluatedDraft: CandidateDraft = composition
            ? {
                ...terminalDraft,
                recallSourceTags: [
                    ...(terminalDraft.recallSourceTags ?? []),
                    ...(terminalDraft.recallSourceTags?.includes(
                        "recent_tail_whole_baseline",
                    ) === true ? ["recent_tail_joint_chain_measured"] : []),
                    ...(composition.passed ? [
                    "path_fixed_side_joint_composition",
                    ] : []),
                    ...compositionTags,
                ],
            }
            : terminalDraft;
        const candidate = evaluateDraft(
            siteData,
            diagnosis,
            evaluatedDraft,
            effectiveConfig,
            null,
        );
        if (candidate?.candidateStrength === "strong"
            && (candidate.evidence.evaluationDelta?.hardGatePassed === true
                || candidate.evidence.evaluationDelta?.jointCompositionGatePassed === true)) {
            accepted.push(candidate);
        }
    }
    return accepted.sort((left, right) => (
        wholeBaselineCandidatePriority(right) - wholeBaselineCandidatePriority(left)
        || right.score - left.score
    ))[0] ?? null;
};
