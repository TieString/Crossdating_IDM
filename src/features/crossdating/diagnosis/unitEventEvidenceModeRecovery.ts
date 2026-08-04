/**
 * Final evidence-mode recovery for unit missing- and false-ring events.
 *
 * The locator already computes all profiles over the full usable interval. This
 * layer reuses those arrays to compare complete 13-year modes, so recovery does
 * not rerun virtual edits or allocate a copy of the chronology per candidate.
 */
import type {
    UnitEventRankerWindow,
    UnitEventWindowRankerInput,
    UnitEventWindowRankerResult,
} from "./unitEventWindowRanker";

const MODE_WIDTH = 13;
const LOCAL_REMOTE_START_GAP = 7;
const DISTINCT_REMOTE_START_GAP = 11;
const DISJOINT_REMOTE_START_GAP = 13;
const SCORE_EPSILON = 1e-12;

const MISSING_CORE_CONTRAST_PROFILES = [
    "cumulativeCombinedContrast",
    "cumulativeDifferenceContrast",
    "cumulativeWhitenedContrast",
] as const;

const FALSE_CONTRAST_PROFILES = [
    "cumulativeCombinedContrast",
    "cumulativeDifferenceContrast",
    "cumulativeWhitenedContrast",
    "cumulativeCofechaContrast",
    "cumulativeReferenceMedianContrast",
    "cumulativeReferenceMeanContrast",
    "cumulativeReferenceVoteContrast",
] as const;

const MISSING_CUMULATIVE_FAMILY_PROFILES = [
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeReferenceMean",
    "cumulativeReferenceMedian",
    "cumulativeReferenceVote",
] as const;

const MISSING_TRANSITION_FAMILY_PROFILES = [
    "piecewiseCombinedObjective",
    "transitionSplitGain",
] as const;

const MISSING_PAIR_FAMILY_PROFILES = [
    "pairDifferenceWeighted",
    "pairWhitenedMean",
    "pairPeakKernel5",
    "pairPeakKernel9",
] as const;

export type UnitEventEvidenceModeRecovery = {
    window: UnitEventRankerWindow;
    finalWindow?: UnitEventRankerWindow;
    recommendedWidth?: 9 | 13;
    rule:
        | "missing_evidence_profile_mode"
        | "missing_family_profile_mode"
        | "missing_operation_evidence_reversion"
        | "missing_coarse_remote_side_mode"
        | "false_evidence_profile_mode"
        | "false_reference_median_mode"
        | "false_boundary_evidence_mode"
        | "false_operation_evidence_reversion";
    evidence:
        | "missing_reference_peak"
        | "missing_remote_core_contrast"
        | "missing_local_core_contrast"
        | "missing_cumulative_step"
        | "missing_cumulative_family"
        | "missing_full_interval_cumulative_family"
        | "missing_transition_family"
        | "missing_pair_family"
        | "missing_current_side_anchor"
        | "missing_current_anchor_mode"
        | "missing_operation_side_median"
        | "missing_side_step_anchor"
        | "missing_remote_reference_peak_side_anchor"
        | "missing_distant_operation_reversion"
        | "missing_inverted_anchor_reversion"
        | "missing_coarse_remote_side_consensus"
        | "false_physical_current_anchor"
        | "false_current_anchor"
        | "false_remote_joint_peak"
        | "false_side_step_edge"
        | "false_counterfactual_pair_peak"
        | "false_older_pair_peak"
        | "false_bounded_contrast"
        | "false_candidate_older_consensus"
        | "false_physical_boundary_side"
        | "false_point_remote_side"
        | "false_weak_operation_side"
        | "false_paired_reference_peak"
        | "false_coarse_older_clipping"
        | "false_reference_median_recenter"
        | "false_weak_split_anchor_reversion"
        | "false_concentrated_prior_reversion"
        | "false_current_prior_reversion"
        | "false_strong_anchor_prior_reversion"
        | "false_counterfactual_side_anchor"
        | "false_distant_operation_anchor"
        | "false_bounded_older_side_anchor"
        | "false_coarse_older_edge_consensus"
        | "false_joint_operation_peak_consensus"
        | "false_local_boundary_consensus";
};

type ScoredMode = {
    window: UnitEventRankerWindow;
    score: number;
};

type ProfileModeComparison = {
    candidate: ScoredMode;
    current: ScoredMode;
    advantage: number;
    remoteMargin: number;
};

type FamilyModeComparison = {
    candidate: ScoredMode;
    distance: number;
    gain: number;
    peakMargin: number;
    votes: number;
    spread: number;
    currentAnchorAdvantage: number;
};

const widthOf = (window: UnitEventRankerWindow): number => (
    window.endYear - window.startYear + 1
);

const containsYear = (
    window: UnitEventRankerWindow,
    year: number | undefined,
): boolean => (
    year !== undefined
    && year >= window.startYear
    && year <= window.endYear
);

const sameWindow = (
    left: UnitEventRankerWindow,
    right: UnitEventRankerWindow,
): boolean => (
    left.startYear === right.startYear
    && left.endYear === right.endYear
);

const distanceToWindow = (
    window: UnitEventRankerWindow,
    year: number | undefined,
): number => {
    if (year === undefined) return Number.POSITIVE_INFINITY;
    if (year < window.startYear) return window.startYear - year;
    if (year > window.endYear) return year - window.endYear;
    return 0;
};

const evidenceAnchors = (input: UnitEventWindowRankerInput): number[] => [
    input.currentPrimaryYear,
    input.operationEvidence?.bestYear,
    input.operationEvidence?.sideStepBestYear,
].filter((year): year is number => year !== undefined);

const retainedCurrentAnchors = (
    input: UnitEventWindowRankerInput,
    current: UnitEventRankerWindow,
    candidate: UnitEventRankerWindow,
): boolean => evidenceAnchors(input).every((year) => (
    !containsYear(current, year) || containsYear(candidate, year)
));

const candidateAnchorCount = (
    input: UnitEventWindowRankerInput,
    candidate: UnitEventRankerWindow,
): number => evidenceAnchors(input).filter((year) => (
    containsYear(candidate, year)
)).length;

const boundedCenteredWindow = (
    centerYear: number | undefined,
    bounds: UnitEventRankerWindow | undefined,
): UnitEventRankerWindow | null => {
    if (
        centerYear === undefined
        || !bounds
        || widthOf(bounds) < MODE_WIDTH
    ) return null;
    const startYear = Math.max(
        bounds.startYear,
        Math.min(
            Math.round(centerYear) - Math.floor(MODE_WIDTH / 2),
            bounds.endYear - MODE_WIDTH + 1,
        ),
    );
    return { startYear, endYear: startYear + MODE_WIDTH - 1 };
};

const seriesBounds = (
    input: UnitEventWindowRankerInput,
): UnitEventRankerWindow | undefined => {
    const startYear = input.years[0];
    const endYear = input.years[input.years.length - 1];
    return startYear === undefined || endYear === undefined
        ? undefined
        : { startYear, endYear };
};

const median = (values: readonly number[]): number => {
    const ordered = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 0
        ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
        : ordered[middle] ?? 0;
};

const shiftedModeWindow = (
    input: UnitEventWindowRankerInput,
    current: UnitEventRankerWindow,
    shiftYears: number,
): UnitEventRankerWindow | null => boundedCenteredWindow(
    (current.startYear + current.endYear) / 2 + shiftYears,
    seriesBounds(input),
);

const scoreProfileModes = (
    input: UnitEventWindowRankerInput,
    profileNames: readonly string[],
): ScoredMode[] => {
    const coarse = input.coarseWindow;
    if (!coarse || widthOf(coarse) < MODE_WIDTH) return [];
    const indexByYear = new Map(
        input.years.map((year, index) => [year, index]),
    );
    const prefixes = profileNames.flatMap((profileName) => {
        const values = input.ranks.get(profileName);
        if (!values || values.length !== input.years.length) return [];
        const prefix = [0];
        values.forEach((value) => {
            prefix.push(
                prefix[prefix.length - 1]!
                + (Number.isFinite(value) ? value : 0),
            );
        });
        return [prefix];
    });
    if (prefixes.length !== profileNames.length) return [];

    const modes: ScoredMode[] = [];
    for (
        let startYear = coarse.startYear;
        startYear <= coarse.endYear - MODE_WIDTH + 1;
        startYear += 1
    ) {
        const startIndex = indexByYear.get(startYear);
        const endIndex = indexByYear.get(startYear + MODE_WIDTH - 1);
        if (
            startIndex === undefined
            || endIndex === undefined
            || endIndex - startIndex !== MODE_WIDTH - 1
        ) continue;
        const score = prefixes.reduce((sum, prefix) => (
            sum + prefix[endIndex + 1]! - prefix[startIndex]!
        ), 0) / prefixes.length;
        modes.push({
            window: {
                startYear,
                endYear: startYear + MODE_WIDTH - 1,
            },
            score,
        });
    }
    return modes;
};

const normalizeScores = (scores: readonly number[]): number[] => {
    const minimum = Math.min(...scores);
    const maximum = Math.max(...scores);
    const span = maximum - minimum;
    if (!Number.isFinite(span) || span <= SCORE_EPSILON) {
        return scores.map(() => 0);
    }
    return scores.map((score) => (score - minimum) / span);
};

const percentileRanks = (values: readonly number[]): number[] => values.map(
    (selected) => (
        values.filter((value) => value < selected).length
        + values.filter((value) => value === selected).length * 0.5
    ) / Math.max(1, values.length),
);

const falseReferenceMedianMode = (
    input: UnitEventWindowRankerInput,
    current: UnitEventRankerWindow,
): ScoredMode | null => {
    const rows = input.falseCounterfactualRows;
    if (!rows || rows.length < MODE_WIDTH) return null;
    const values = rows.map((row) => (
        Number(row.profiles.differenceReferenceRankMedian31)
    ));
    if (values.some((value) => !Number.isFinite(value))) return null;
    const ranked = percentileRanks(values);
    const prefix = [0];
    ranked.forEach((value) => prefix.push(prefix[prefix.length - 1]! + value));
    let best: ScoredMode | null = null;
    let currentScore: number | null = null;
    for (let index = 0; index + MODE_WIDTH <= rows.length; index += 1) {
        const startYear = rows[index]!.year;
        const endYear = rows[index + MODE_WIDTH - 1]!.year;
        if (endYear !== startYear + MODE_WIDTH - 1) continue;
        const score = prefix[index + MODE_WIDTH]! - prefix[index]!;
        const candidate = {
            window: { startYear, endYear },
            score,
        };
        if (sameWindow(candidate.window, current)) currentScore = score;
        if (
            !best
            || score > best.score + SCORE_EPSILON
            || Math.abs(score - best.score) <= SCORE_EPSILON
                && startYear > best.window.startYear
        ) best = candidate;
    }
    return best
        && currentScore !== null
        && best.score > currentScore + SCORE_EPSILON
        && !sameWindow(best.window, current)
        ? best
        : null;
};

/**
 * Compares one evidence family after normalizing each member profile. The
 * normalization prevents a high-amplitude profile from duplicating the votes
 * of several independent profiles in the same family.
 */
const compareMissingFamilyMode = (
    input: UnitEventWindowRankerInput,
    current: UnitEventRankerWindow,
    profileNames: readonly string[],
    searchScope: "coarse" | "series" = "coarse",
): FamilyModeComparison | null => {
    const bounds = searchScope === "series"
        ? seriesBounds(input)
        : input.coarseWindow;
    if (!bounds || widthOf(bounds) < MODE_WIDTH) return null;
    const starts = Array.from(
        { length: widthOf(bounds) - MODE_WIDTH + 1 },
        (_, index) => bounds.startYear + index,
    );
    const firstYear = input.years[0];
    const lastYear = input.years[input.years.length - 1];
    if (firstYear === undefined || lastYear === undefined) return null;
    const indexByYear = new Map(
        input.years.map((year, index) => [year, index]),
    );
    const normalizedMembers = profileNames.flatMap((profileName) => {
        const values = input.ranks.get(profileName);
        if (!values || values.length !== input.years.length) return [];
        const prefix = [0];
        values.forEach((value) => {
            prefix.push(
                prefix[prefix.length - 1]!
                + (Number.isFinite(value) ? value : 0),
            );
        });
        const scores = starts.map((startYear) => {
            const overlapStart = Math.max(startYear, firstYear);
            const overlapEnd = Math.min(
                startYear + MODE_WIDTH - 1,
                lastYear,
            );
            if (overlapStart > overlapEnd) return 0;
            const startIndex = indexByYear.get(overlapStart);
            const endIndex = indexByYear.get(overlapEnd);
            if (startIndex === undefined || endIndex === undefined) return 0;
            return prefix[endIndex + 1]! - prefix[startIndex]!;
        });
        return [normalizeScores(scores)];
    });
    if (normalizedMembers.length !== profileNames.length) return null;

    const modes = starts.map((startYear, index) => ({
        window: {
            startYear,
            endYear: startYear + MODE_WIDTH - 1,
        },
        score: normalizedMembers.reduce((sum, scores) => (
            sum + scores[index]!
        ), 0) / normalizedMembers.length,
    }));
    const currentIndex = modes.findIndex((mode) => (
        sameWindow(mode.window, current)
    ));
    if (currentIndex < 0) return null;
    const candidateIndex = modes.reduce((best, mode, index) => (
        mode.score > modes[best]!.score ? index : best
    ), 0);
    if (candidateIndex === currentIndex) return null;

    const memberBestIndexes = normalizedMembers.map((scores) => (
        scores.reduce((best, score, index) => (
            score > scores[best]! ? index : best
        ), 0)
    ));
    const candidate = modes[candidateIndex]!;
    const secondScore = modes.reduce((best, mode, index) => (
        index === candidateIndex ? best : Math.max(best, mode.score)
    ), Number.NEGATIVE_INFINITY);
    const candidateStart = candidate.window.startYear;
    const memberBestStarts = memberBestIndexes.map((index) => (
        modes[index]!.window.startYear
    ));
    const currentCenter = (current.startYear + current.endYear) / 2;
    const candidateCenter = (
        candidate.window.startYear + candidate.window.endYear
    ) / 2;
    const currentPrimaryYear = input.currentPrimaryYear;
    return {
        candidate,
        distance: Math.abs(candidateStart - current.startYear),
        gain: candidate.score - modes[currentIndex]!.score,
        peakMargin: candidate.score - secondScore,
        votes: memberBestStarts.filter((startYear) => (
            Math.abs(startYear - candidateStart) <= 2
        )).length,
        spread: Math.max(...memberBestStarts) - Math.min(...memberBestStarts),
        currentAnchorAdvantage: currentPrimaryYear === undefined
            ? Number.NEGATIVE_INFINITY
            : Math.abs(currentCenter - currentPrimaryYear)
                - Math.abs(candidateCenter - currentPrimaryYear),
    };
};

export const selectMissingRingFamilyProfileModeRecovery = (
    input: UnitEventWindowRankerInput,
    current: UnitEventRankerWindow,
    sourceRule: UnitEventWindowRankerResult["windowCenteringRule"],
    currentFinal: UnitEventRankerWindow = current,
): UnitEventEvidenceModeRecovery | null => {
    if (
        input.eventType !== "missingRing"
        || widthOf(current) !== MODE_WIDTH
    ) return null;

    const operation = input.operationEvidence;
    const anchorYears = evidenceAnchors(input);
    const anchorSpread = anchorYears.length > 0
        ? Math.max(...anchorYears) - Math.min(...anchorYears)
        : Number.POSITIVE_INFINITY;
    const currentAnchor = boundedCenteredWindow(
        input.currentPrimaryYear,
        seriesBounds(input),
    );
    const currentAnchorDistance = currentAnchor
        ? Math.abs(currentAnchor.startYear - current.startYear)
        : 0;
    if (
        currentAnchor
        && !sameWindow(currentAnchor, current)
        && (
            (
                currentAnchorDistance >= 9
                && currentAnchorDistance <= 12
            )
            || (
                currentAnchorDistance >= 7
                && currentAnchorDistance <= 20
                && anchorYears.length >= 2
                && anchorSpread <= 3
            )
        )
    ) {
        return {
            window: currentAnchor,
            rule: "missing_family_profile_mode",
            evidence: "missing_current_anchor_mode",
        };
    }

    const operationSideAnchor = operation?.sideStepBestYear === undefined
        ? null
        : boundedCenteredWindow(
                median([operation.bestYear, operation.sideStepBestYear]),
                seriesBounds(input),
            );
    if (
        sourceRule === "missing_mode_side_corrector"
        && operation
        && operationSideAnchor
        && !sameWindow(operationSideAnchor, current)
    ) {
        const currentCenter = (current.startYear + current.endYear) / 2;
        const candidateCenter = (
            operationSideAnchor.startYear + operationSideAnchor.endYear
        ) / 2;
        const direction = Math.sign(candidateCenter - currentCenter);
        const votes = anchorYears.filter((year) => (
            Math.sign(year - currentCenter) === direction
        )).length;
        const distance = Math.abs(
            operationSideAnchor.startYear - current.startYear,
        );
        if (
            distance >= 2
            && distance <= 20
            && votes >= 2
            && (operation.bestDifferenceGain
                ?? Number.NEGATIVE_INFINITY) >= 0.4
            && (operation.bestSideStepScore
                ?? Number.NEGATIVE_INFINITY) >= 0.5
        ) {
            return {
                window: operationSideAnchor,
                rule: "missing_family_profile_mode",
                evidence: "missing_operation_side_median",
            };
        }
    }

    const fullIntervalCumulative = sourceRule === "missing_mode_side_corrector"
        ? compareMissingFamilyMode(
                input,
                current,
                MISSING_CUMULATIVE_FAMILY_PROFILES,
                "series",
            )
        : null;
    if (
        fullIntervalCumulative
        && fullIntervalCumulative.distance >= 10
        && fullIntervalCumulative.gain >= 0.03
        && fullIntervalCumulative.votes >= 4
        && fullIntervalCumulative.spread <= 24
        && fullIntervalCumulative.candidate.window.startYear
            < current.startYear
        && operation?.sideStepBestYear !== undefined
        && Math.abs(operation.bestYear - operation.sideStepBestYear) <= 1
        && containsYear(
            fullIntervalCumulative.candidate.window,
            operation.bestYear,
        )
        && containsYear(
            fullIntervalCumulative.candidate.window,
            operation.sideStepBestYear,
        )
        && (operation.bestDifferenceGain ?? Number.NEGATIVE_INFINITY) >= 0.4
    ) {
        return {
            window: fullIntervalCumulative.candidate.window,
            rule: "missing_family_profile_mode",
            evidence: "missing_full_interval_cumulative_family",
        };
    }

    const currentSideAnchor = boundedCenteredWindow(
        input.currentPrimaryYear,
        seriesBounds(input),
    );
    const anchorDistance = currentSideAnchor
        ? current.startYear - currentSideAnchor.startYear
        : 0;
    if (
        sourceRule === "missing_evidence_profile_mode"
        && currentSideAnchor
        && anchorDistance >= 7
        && anchorDistance <= 20
        && operation?.sideStepBestYear !== undefined
        && input.currentPrimaryYear !== undefined
        && Math.abs(
            operation.sideStepBestYear - input.currentPrimaryYear,
        ) <= 1
        && containsYear(currentSideAnchor, operation.sideStepBestYear)
        && (operation.bestDifferenceGain ?? Number.NEGATIVE_INFINITY) >= 0.3
        && (operation.bestSideStepScore ?? Number.NEGATIVE_INFINITY) >= 0.7
        && (operation.sideStepRemoteMargin ?? Number.NEGATIVE_INFINITY) >= 0.1
    ) {
        return {
            window: currentSideAnchor,
            rule: "missing_family_profile_mode",
            evidence: "missing_current_side_anchor",
        };
    }

    const sideAnchor = boundedCenteredWindow(
        operation?.sideStepBestYear,
        seriesBounds(input),
    );
    const sideAnchorDistance = sideAnchor
        ? current.startYear - sideAnchor.startYear
        : 0;
    if (
        sourceRule === "missing_mode_side_corrector"
        && sideAnchor
        && sideAnchorDistance >= 5
        && sideAnchorDistance <= 8
        && anchorSpread <= 8
        && (operation?.bestSideStepScore ?? Number.NEGATIVE_INFINITY) >= 0.2
        && (operation?.sideStepRemoteMargin
            ?? Number.NEGATIVE_INFINITY) >= 0.01
    ) {
        return {
            window: sideAnchor,
            rule: "missing_family_profile_mode",
            evidence: "missing_side_step_anchor",
        };
    }

    const sideYear = operation?.sideStepBestYear;
    const coarse = input.coarseWindow;
    const remoteReferencePeakCount = sideYear === undefined
        ? 0
        : input.internalCandidates.filter((candidate) => (
                (
                    candidate.source === "reference_transition:peakKernel9"
                    || candidate.source === "reference_transition:peakKernel13"
                )
                && containsYear(candidate, sideYear)
            )).length;
    if (
        sourceRule === "missing_direct_anchor_consensus"
        && sideAnchor
        && sideYear !== undefined
        && operation
        && coarse
        && coarse.startYear - sideYear >= 10
        && input.currentPrimaryYear !== undefined
        && Math.abs(operation.bestYear - input.currentPrimaryYear) <= 2
        && remoteReferencePeakCount >= 2
        && (operation.bestSideStepScore ?? Number.NEGATIVE_INFINITY) >= 0.4
    ) {
        return {
            window: sideAnchor,
            rule: "missing_family_profile_mode",
            evidence: "missing_remote_reference_peak_side_anchor",
        };
    }

    const cumulative = sourceRule === "missing_direct_mode_ranker"
        ? compareMissingFamilyMode(
                input,
                current,
                MISSING_CUMULATIVE_FAMILY_PROFILES,
            )
        : null;
    if (
        cumulative
        && cumulative.distance >= 1
        && cumulative.gain >= 0.15
        && cumulative.votes >= 3
        && cumulative.spread <= 8
        && cumulative.currentAnchorAdvantage >= -2
    ) {
        return {
            window: cumulative.candidate.window,
            rule: "missing_family_profile_mode",
            evidence: "missing_cumulative_family",
        };
    }

    const pair = sourceRule === "mode_mass"
        ? compareMissingFamilyMode(
                input,
                current,
                MISSING_PAIR_FAMILY_PROFILES,
            )
        : null;
    const pairFinalWindow = pair
        ? {
                startYear: pair.candidate.window.startYear,
                endYear: pair.candidate.window.startYear + 8,
            }
        : null;
    if (
        pair
        && pairFinalWindow
        && pair.distance >= 2
        && pair.gain >= 0
        && pair.votes >= 3
        && pair.spread <= 4
        && pair.currentAnchorAdvantage >= -2
        && pair.candidate.window.startYear < current.startYear
        && input.operationEvidence?.sideStepBestYear !== undefined
        && currentFinal.startYear
            - input.operationEvidence.sideStepBestYear >= 3
        && distanceToWindow(
            pairFinalWindow,
            input.currentPrimaryYear,
        ) <= 1
        && distanceToWindow(
            pairFinalWindow,
            input.operationEvidence.bestYear,
        ) <= 1
    ) {
        return {
            window: pair.candidate.window,
            finalWindow: pairFinalWindow,
            recommendedWidth: 9,
            rule: "missing_family_profile_mode",
            evidence: "missing_pair_family",
        };
    }

    const transition = sourceRule === "missing_evidence_profile_mode"
        ? compareMissingFamilyMode(
                input,
                current,
                MISSING_TRANSITION_FAMILY_PROFILES,
            )
        : null;
    if (
        transition
        && transition.distance >= 4
        && transition.gain >= 0
        && transition.peakMargin >= 0.01
        && transition.votes >= 2
        && transition.spread <= 2
        && retainedCurrentAnchors(input, current, transition.candidate.window)
    ) {
        return {
            window: transition.candidate.window,
            rule: "missing_family_profile_mode",
            evidence: "missing_transition_family",
        };
    }
    return null;
};

/**
 * Revisits the final false-ring mode after every learned and side selector has
 * run. Each branch requires a different independent evidence pattern, while
 * the UI still receives one operation and one 13-year review window.
 */
export type UnitEventFinalModeMetrics = {
    learnedWindowMargin: number;
    learnedWindowRemoteMargin: number;
};

const completeAnchorYears = (
    input: UnitEventWindowRankerInput,
): [number, number, number] | null => {
    const current = input.currentPrimaryYear;
    const best = input.operationEvidence?.bestYear;
    const side = input.operationEvidence?.sideStepBestYear;
    return current === undefined || best === undefined || side === undefined
        ? null
        : [current, best, side];
};

export const selectMissingRingFinalEvidenceModeRecovery = (
    input: UnitEventWindowRankerInput,
    current: UnitEventRankerWindow,
    sourceRule: UnitEventWindowRankerResult["windowCenteringRule"],
    priorMode: UnitEventRankerWindow | undefined,
    metrics: UnitEventFinalModeMetrics,
): UnitEventEvidenceModeRecovery | null => {
    const operation = input.operationEvidence;
    const anchorYears = completeAnchorYears(input);
    const bounds = seriesBounds(input);
    if (
        input.eventType === "missingRing"
        && input.coarseRecoveryRule === "missing_remote_side_consensus"
        && widthOf(current) === MODE_WIDTH
        && bounds
        && input.currentPrimaryYear !== undefined
        && operation?.bestYear !== undefined
        && operation.sideStepBestYear !== undefined
        && operation.bestDifferenceGain !== undefined
        && Math.abs(operation.bestYear - input.currentPrimaryYear) <= 1
        && operation.bestDifferenceGain <= 0.15
        && input.currentPrimaryYear - operation.sideStepBestYear >= 15
        && input.currentPrimaryYear - operation.sideStepBestYear <= 45
        && operation.sideStepBestYear - bounds.startYear >= 3
    ) {
        const recovered = boundedCenteredWindow(
            operation.sideStepBestYear + 3,
            bounds,
        );
        if (recovered && !sameWindow(recovered, current)) {
            return {
                window: recovered,
                rule: "missing_coarse_remote_side_mode",
                evidence: "missing_coarse_remote_side_consensus",
            };
        }
    }
    if (
        input.eventType !== "missingRing"
        || sourceRule !== "missing_evidence_profile_mode"
        || widthOf(current) !== MODE_WIDTH
        || !priorMode
        || widthOf(priorMode) !== MODE_WIDTH
        || input.currentPrimaryYear === undefined
        || operation?.bestYear === undefined
    ) return null;

    const priorDisplacement = priorMode.startYear - current.startYear;
    if (
        priorDisplacement >= 1
        && priorDisplacement <= 4
        && Math.abs(operation.bestYear - input.currentPrimaryYear) >= 50
        && (operation.bestDifferenceGain ?? Number.POSITIVE_INFINITY) <= 0
    ) {
        return {
            window: priorMode,
            rule: "missing_operation_evidence_reversion",
            evidence: "missing_distant_operation_reversion",
        };
    }

    if (
        priorDisplacement >= -6
        && priorDisplacement <= -5
        && anchorYears
        && anchorYears.every((year) => containsYear(current, year))
        && anchorYears.every((year) => !containsYear(priorMode, year))
        && metrics.learnedWindowMargin <= -1
        && (operation.bestDifferenceGain
            ?? Number.NEGATIVE_INFINITY) >= 0.5
        && (operation.sideStepRemoteMargin
            ?? Number.NEGATIVE_INFINITY) >= 0.25
    ) {
        return {
            window: priorMode,
            rule: "missing_operation_evidence_reversion",
            evidence: "missing_inverted_anchor_reversion",
        };
    }
    return null;
};

export const selectFalseRingFinalEvidenceModeRecovery = (
    input: UnitEventWindowRankerInput,
    current: UnitEventRankerWindow,
    sourceRule: UnitEventWindowRankerResult["windowCenteringRule"],
    priorMode?: UnitEventRankerWindow,
    metrics: UnitEventFinalModeMetrics = {
        learnedWindowMargin: 0,
        learnedWindowRemoteMargin: 0,
    },
): UnitEventEvidenceModeRecovery | null => {
    const coarse = input.coarseWindow;
    const operation = input.operationEvidence;
    const bounds = seriesBounds(input);
    if (
        input.eventType !== "falseRing"
        || widthOf(current) !== MODE_WIDTH
        || !coarse
        || !bounds
    ) return null;

    const anchorYears = completeAnchorYears(input);
    const priorDisplacement = priorMode
        ? priorMode.startYear - current.startYear
        : 0;
    const coarseEndGap = coarse.endYear - current.endYear;
    const reliableReferenceRankSource = input.coarseSource !== undefined
        && /^reference_transition:(rankMean|rankMedian|weightedRankMean)$/
            .test(input.coarseSource);
    if (
        reliableReferenceRankSource
        && coarseEndGap >= 0
        && coarseEndGap <= 1
        && current.startYear - coarse.startYear >= 15
        && (operation?.bestDifferenceGain
            ?? Number.POSITIVE_INFINITY) <= 0.5
        && (operation?.sideStepRemoteMargin
            ?? Number.NEGATIVE_INFINITY) >= 0.08
    ) {
        const candidate = boundedCenteredWindow(coarse.startYear, bounds);
        if (candidate && !sameWindow(candidate, current)) {
            return {
                window: candidate,
                rule: "false_boundary_evidence_mode",
                evidence: "false_coarse_older_edge_consensus",
            };
        }
    }

    const jointPeak = pointProfilePeak(
        input,
        current,
        "jointOperationMargin",
    );
    if (
        sourceRule === "false_side_step_mode"
        && jointPeak
        && input.currentPrimaryYear !== undefined
        && operation?.bestYear !== undefined
        && operation.sideStepBestYear !== undefined
        && jointPeak.year - current.endYear >= 5
        && jointPeak.year - current.endYear <= 9
        && jointPeak.year - coarse.endYear >= 0
        && jointPeak.year - coarse.endYear <= 3
        && Math.abs(operation.bestYear - input.currentPrimaryYear) <= 1
        && input.currentPrimaryYear - operation.sideStepBestYear >= 10
        && input.currentPrimaryYear - operation.sideStepBestYear <= 20
        && (operation.bestDifferenceGain
            ?? Number.NEGATIVE_INFINITY) >= 0.2
        && (operation.bestDifferenceGain
            ?? Number.POSITIVE_INFINITY) <= 0.4
        && (operation.remoteDifferenceMargin
            ?? Number.NEGATIVE_INFINITY) >= 0.05
        && (operation.sideStepRemoteMargin
            ?? Number.NEGATIVE_INFINITY) >= 0.08
    ) {
        const candidate = boundedCenteredWindow(jointPeak.year, bounds);
        if (candidate && !sameWindow(candidate, current)) {
            return {
                window: candidate,
                rule: "false_boundary_evidence_mode",
                evidence: "false_joint_operation_peak_consensus",
            };
        }
    }

    const correctedPeak = pointProfilePeak(
        input,
        current,
        "correctedSideSupport",
    );
    const combinedContrastPeak = pointProfilePeak(
        input,
        current,
        "cumulativeCombinedContrast",
    );
    if (
        sourceRule === "false_reference_median_mode"
        && correctedPeak
        && combinedContrastPeak
        && Math.abs(correctedPeak.year - combinedContrastPeak.year) <= 2
    ) {
        const consensusYear = Math.round(
            (correctedPeak.year + combinedContrastPeak.year) / 2,
        );
        const candidate = boundedCenteredWindow(consensusYear, bounds);
        if (
            consensusYear < current.startYear
            && candidate
            && !sameWindow(candidate, current)
        ) {
            return {
                window: candidate,
                rule: "false_boundary_evidence_mode",
                evidence: "false_local_boundary_consensus",
            };
        }
    }
    if (
        sourceRule === "false_evidence_profile_mode"
        && priorMode
        && widthOf(priorMode) === MODE_WIDTH
        && anchorYears
        && priorDisplacement >= 1
        && priorDisplacement <= 3
        && anchorYears.every((year) => containsYear(current, year))
        && anchorYears.every((year) => containsYear(priorMode, year))
        && metrics.learnedWindowRemoteMargin >= 8
    ) {
        return {
            window: priorMode,
            rule: "false_operation_evidence_reversion",
            evidence: "false_concentrated_prior_reversion",
        };
    }

    if (
        sourceRule === "false_evidence_profile_mode"
        && priorMode
        && widthOf(priorMode) === MODE_WIDTH
        && priorDisplacement >= -12
        && priorDisplacement <= -9
        && containsYear(priorMode, input.currentPrimaryYear)
        && !containsYear(current, input.currentPrimaryYear)
        && (operation?.bestYear ?? Number.NEGATIVE_INFINITY)
            > current.endYear
        && (operation?.sideStepBestYear ?? Number.NEGATIVE_INFINITY)
            > current.endYear
        && (operation?.bestDifferenceGain
            ?? Number.NEGATIVE_INFINITY) >= 0.35
        && (operation?.bestDifferenceGain
            ?? Number.POSITIVE_INFINITY) <= 0.6
    ) {
        return {
            window: priorMode,
            rule: "false_operation_evidence_reversion",
            evidence: "false_current_prior_reversion",
        };
    }

    if (
        sourceRule === "false_evidence_profile_mode"
        && priorMode
        && widthOf(priorMode) === MODE_WIDTH
        && anchorYears
        && priorDisplacement >= -6
        && priorDisplacement <= -4
        && anchorYears.every((year) => containsYear(current, year))
        && anchorYears.every((year) => containsYear(priorMode, year))
        && (operation?.bestDifferenceGain
            ?? Number.NEGATIVE_INFINITY) >= 0.75
        && (operation?.sideStepRemoteMargin
            ?? Number.NEGATIVE_INFINITY) >= 0.3
    ) {
        return {
            window: priorMode,
            rule: "false_operation_evidence_reversion",
            evidence: "false_strong_anchor_prior_reversion",
        };
    }

    if (
        sourceRule === "false_evidence_profile_mode"
        && priorMode
        && widthOf(priorMode) === MODE_WIDTH
        && containsYear(priorMode, operation?.bestYear)
        && !containsYear(current, operation?.bestYear)
        && containsYear(current, input.currentPrimaryYear)
        && !containsYear(priorMode, input.currentPrimaryYear)
        && containsYear(current, operation?.sideStepBestYear)
        && !containsYear(priorMode, operation?.sideStepBestYear)
        && (operation?.bestDifferenceGain ?? Number.POSITIVE_INFINITY) <= 0.1
        && (operation?.remoteDifferenceMargin ?? Number.POSITIVE_INFINITY) <= 0.01
    ) {
        return {
            window: priorMode,
            rule: "false_operation_evidence_reversion",
            evidence: "false_weak_split_anchor_reversion",
        };
    }

    if (sourceRule === "false_mode_side_corrector") {
        const referenceMedian = falseReferenceMedianMode(input, current);
        if (referenceMedian) {
            return {
                window: referenceMedian.window,
                rule: "false_reference_median_mode",
                evidence: "false_reference_median_recenter",
            };
        }
    }

    const candidateStarts = input.internalCandidates.map((candidate) => (
        candidate.startYear
    ));
    const coarseOlderOffset = current.startYear - coarse.startYear;
    if (
        sourceRule === "false_counterfactual_mass"
        && candidateStarts.length > 0
        && Math.max(...candidateStarts) <= current.startYear - 2
        && coarseOlderOffset >= 0
        && coarseOlderOffset <= 7
    ) {
        const candidate = shiftedModeWindow(input, current, -2);
        if (candidate && !sameWindow(candidate, current)) {
            return {
                window: candidate,
                rule: "false_evidence_profile_mode",
                evidence: "false_candidate_older_consensus",
            };
        }
    }

    const sideYear = operation?.sideStepBestYear;
    const sideCandidate = boundedCenteredWindow(sideYear, bounds);
    const boundedSideCandidate = boundedCenteredWindow(sideYear, coarse);
    const boundedOperationCandidate = boundedCenteredWindow(
        operation?.bestYear,
        coarse,
    );
    const boundedSideDisplacement = boundedSideCandidate
        ? boundedSideCandidate.startYear - current.startYear
        : 0;
    if (
        sourceRule === "false_counterfactual_mass"
        && boundedSideCandidate
        && boundedSideDisplacement <= -14
        && (operation?.bestYear ?? Number.NEGATIVE_INFINITY)
            >= (input.currentPrimaryYear ?? Number.POSITIVE_INFINITY) + 5
        && (sideYear ?? Number.POSITIVE_INFINITY) < current.startYear
        && (operation?.bestDifferenceGain
            ?? Number.NEGATIVE_INFINITY) >= 0.2
        && (operation?.bestDifferenceGain
            ?? Number.POSITIVE_INFINITY) <= 0.5
    ) {
        return {
            window: boundedSideCandidate,
            rule: "false_evidence_profile_mode",
            evidence: "false_counterfactual_side_anchor",
        };
    }

    if (
        sourceRule === "false_mode_side_corrector"
        && boundedOperationCandidate
        && input.currentPrimaryYear !== undefined
        && operation?.bestYear !== undefined
        && operation.sideStepBestYear !== undefined
        && operation.bestYear - input.currentPrimaryYear >= 15
        && Math.abs(
            operation.sideStepBestYear - input.currentPrimaryYear,
        ) <= 1
        && (operation.bestDifferenceGain
            ?? Number.NEGATIVE_INFINITY) >= 0.6
        && (operation.remoteDifferenceMargin
            ?? Number.POSITIVE_INFINITY) <= 0.001
    ) {
        return {
            window: boundedOperationCandidate,
            rule: "false_evidence_profile_mode",
            evidence: "false_distant_operation_anchor",
        };
    }

    const currentSideDistance = sideYear === undefined
        || input.currentPrimaryYear === undefined
        ? Number.POSITIVE_INFINITY
        : input.currentPrimaryYear - sideYear;
    if (
        sourceRule === "false_point_mode"
        && boundedSideCandidate
        && boundedSideDisplacement <= -10
        && currentSideDistance >= 15
        && currentSideDistance <= 30
        && input.currentPrimaryYear !== undefined
        && Math.abs(
            (operation?.bestYear ?? Number.POSITIVE_INFINITY)
                - input.currentPrimaryYear,
        ) <= 3
        && (operation?.bestDifferenceGain
            ?? Number.POSITIVE_INFINITY) <= 0.15
        && (operation?.sideStepRemoteMargin
            ?? Number.NEGATIVE_INFINITY) >= 0.005
    ) {
        return {
            window: boundedSideCandidate,
            rule: "false_evidence_profile_mode",
            evidence: "false_bounded_older_side_anchor",
        };
    }
    const sideBeyondCoarse = sideYear === undefined
        ? Number.POSITIVE_INFINITY
        : sideYear - coarse.endYear;
    if (
        sourceRule === "false_physical_profile_mode"
        && sideCandidate
        && sideBeyondCoarse >= 1
        && sideBeyondCoarse <= 3
        && (operation?.bestDifferenceGain
            ?? Number.NEGATIVE_INFINITY) >= 0.6
        && (operation?.bestSideStepScore
            ?? Number.NEGATIVE_INFINITY) >= 0.6
        && (operation?.bestCorrectedSideSupport
            ?? Number.NEGATIVE_INFINITY) >= 0.4
    ) {
        return {
            window: sideCandidate,
            rule: "false_evidence_profile_mode",
            evidence: "false_physical_boundary_side",
        };
    }

    if (
        sourceRule === "false_point_mode"
        && sideCandidate
        && sideBeyondCoarse >= 6
        && sideBeyondCoarse <= 8
        && (operation?.bestDifferenceGain
            ?? Number.NEGATIVE_INFINITY) >= 0.7
        && (operation?.bestSideStepScore
            ?? Number.NEGATIVE_INFINITY) >= 0.65
        && (operation?.bestCorrectedSideSupport
            ?? Number.NEGATIVE_INFINITY) >= 0.5
        && (operation?.sideStepRemoteMargin
            ?? Number.POSITIVE_INFINITY) <= 0.01
    ) {
        return {
            window: sideCandidate,
            rule: "false_evidence_profile_mode",
            evidence: "false_point_remote_side",
        };
    }

    const sideOlderDisplacement = sideCandidate
        ? current.startYear - sideCandidate.startYear
        : 0;
    if (
        sourceRule === "false_evidence_profile_mode"
        && sideYear !== undefined
        && sideCandidate
        && sideYear >= coarse.startYear
        && sideYear <= coarse.endYear
        && sideOlderDisplacement >= 13
        && sideOlderDisplacement <= 20
        && (operation?.bestDifferenceGain
            ?? Number.POSITIVE_INFINITY) <= 0.2
        && (operation?.bestSideStepScore
            ?? Number.NEGATIVE_INFINITY) >= 0.35
        && (operation?.bestCorrectedSideSupport
            ?? Number.NEGATIVE_INFINITY) >= 0.35
        && (operation?.sideStepRemoteMargin
            ?? Number.POSITIVE_INFINITY) <= 0.02
    ) {
        return {
            window: sideCandidate,
            rule: "false_evidence_profile_mode",
            evidence: "false_weak_operation_side",
        };
    }

    if (sourceRule === "false_side_step_mode") {
        const referenceCenters = input.internalCandidates
            .filter((candidate) => (
                candidate.source === "reference_transition:peakKernel9"
                || candidate.source === "reference_transition:peakKernel13"
            ))
            .map((candidate) => (
                (candidate.startYear + candidate.endYear) / 2
            ));
        const referenceSpread = referenceCenters.length > 0
            ? Math.max(...referenceCenters) - Math.min(...referenceCenters)
            : Number.POSITIVE_INFINITY;
        const candidate = referenceCenters.length >= 2
            ? boundedCenteredWindow(median(referenceCenters), bounds)
            : null;
        const distance = candidate
            ? Math.abs(candidate.startYear - current.startYear)
            : 0;
        if (
            candidate
            && referenceSpread <= 1
            && distance >= 15
            && distance <= 30
        ) {
            return {
                window: candidate,
                rule: "false_evidence_profile_mode",
                evidence: "false_paired_reference_peak",
            };
        }
    }

    const candidateStartMedian = candidateStarts.length > 0
        ? median(candidateStarts)
        : Number.POSITIVE_INFINITY;
    if (
        sourceRule === "false_point_mode"
        && current.startYear === coarse.startYear
        && candidateStartMedian <= current.startYear - 3
    ) {
        const candidate = shiftedModeWindow(input, current, -3);
        if (candidate && !sameWindow(candidate, current)) {
            return {
                window: candidate,
                rule: "false_evidence_profile_mode",
                evidence: "false_coarse_older_clipping",
            };
        }
    }
    return null;
};

const compareProfileMode = (
    input: UnitEventWindowRankerInput,
    current: UnitEventRankerWindow,
    profileNames: readonly string[],
    remoteStartGap: number,
): ProfileModeComparison | null => {
    const modes = scoreProfileModes(input, profileNames);
    const currentMode = modes.find((mode) => sameWindow(mode.window, current));
    if (!currentMode) return null;
    const candidate = modes.reduce<ScoredMode | null>((best, mode) => (
        !best
        || mode.score > best.score + SCORE_EPSILON
        || (
            Math.abs(mode.score - best.score) <= SCORE_EPSILON
            && mode.window.startYear > best.window.startYear
        )
            ? mode
            : best
    ), null);
    if (!candidate || sameWindow(candidate.window, current)) return null;
    const remote = modes.reduce<ScoredMode | null>((best, mode) => {
        if (
            Math.abs(mode.window.startYear - candidate.window.startYear)
                < remoteStartGap
        ) return best;
        return !best || mode.score > best.score ? mode : best;
    }, null);
    if (!remote) return null;
    return {
        candidate,
        current: currentMode,
        advantage: candidate.score - currentMode.score,
        remoteMargin: candidate.score - remote.score,
    };
};

const acceptedMissingProfileMode = (
    input: UnitEventWindowRankerInput,
    current: UnitEventRankerWindow,
    sourceRule: UnitEventWindowRankerResult["windowCenteringRule"],
): UnitEventEvidenceModeRecovery | null => {
    const referencePeak = compareProfileMode(
        input,
        current,
        ["reference:peakKernel13"],
        DISTINCT_REMOTE_START_GAP,
    );
    if (
        sourceRule === "missing_direct_anchor_consensus"
        && referencePeak
        && referencePeak.advantage >= 1
        && referencePeak.remoteMargin >= 1
        && referencePeak.candidate.window.startYear
            - current.startYear >= 10
        && containsYear(
            referencePeak.candidate.window,
            input.currentPrimaryYear,
        )
    ) {
        return {
            window: referencePeak.candidate.window,
            rule: "missing_evidence_profile_mode",
            evidence: "missing_reference_peak",
        };
    }

    const remoteCore = compareProfileMode(
        input,
        current,
        MISSING_CORE_CONTRAST_PROFILES,
        DISTINCT_REMOTE_START_GAP,
    );
    if (
        sourceRule === "missing_direct_mode_ranker"
        && remoteCore
        && remoteCore.advantage >= 0.5
        && remoteCore.remoteMargin >= 0.5
        && remoteCore.candidate.window.startYear - current.startYear >= 10
        && distanceToWindow(
            remoteCore.candidate.window,
            input.currentPrimaryYear,
        ) <= 3
    ) {
        return {
            window: remoteCore.candidate.window,
            rule: "missing_evidence_profile_mode",
            evidence: "missing_remote_core_contrast",
        };
    }

    const localCore = compareProfileMode(
        input,
        current,
        MISSING_CORE_CONTRAST_PROFILES,
        LOCAL_REMOTE_START_GAP,
    );
    if (
        localCore
        && localCore.advantage >= 0.386
        && localCore.remoteMargin >= 0.015
        && Math.abs(
            localCore.candidate.window.startYear - current.startYear,
        ) <= 6
        && candidateAnchorCount(input, localCore.candidate.window) >= 2
        && retainedCurrentAnchors(input, current, localCore.candidate.window)
    ) {
        return {
            window: localCore.candidate.window,
            rule: "missing_evidence_profile_mode",
            evidence: "missing_local_core_contrast",
        };
    }

    const cumulative = compareProfileMode(
        input,
        current,
        ["cumulativeCombined"],
        DISTINCT_REMOTE_START_GAP,
    );
    if (
        cumulative
        && cumulative.advantage >= 0.03
        && cumulative.remoteMargin >= 0.039
        && retainedCurrentAnchors(input, current, cumulative.candidate.window)
    ) {
        return {
            window: cumulative.candidate.window,
            rule: "missing_evidence_profile_mode",
            evidence: "missing_cumulative_step",
        };
    }
    return null;
};

const pointProfilePeak = (
    input: UnitEventWindowRankerInput,
    current: UnitEventRankerWindow,
    profileName: string,
): {
    year: number;
    score: number;
    remoteMargin: number;
    currentCenterAdvantage: number;
} | null => {
    const values = input.ranks.get(profileName);
    if (!values || values.length !== input.years.length) return null;
    let bestIndex = -1;
    values.forEach((value, index) => {
        if (
            !Number.isFinite(value)
            || (
                bestIndex >= 0
                && value < values[bestIndex]! - SCORE_EPSILON
            )
        ) return;
        bestIndex = index;
    });
    if (bestIndex < 0) return null;
    const year = input.years[bestIndex]!;
    const score = values[bestIndex]!;
    let remoteScore = Number.NEGATIVE_INFINITY;
    values.forEach((value, index) => {
        if (
            Number.isFinite(value)
            && Math.abs(input.years[index]! - year)
                >= LOCAL_REMOTE_START_GAP
        ) remoteScore = Math.max(remoteScore, value);
    });
    const centerYear = Math.round((current.startYear + current.endYear) / 2);
    const centerIndex = input.years.indexOf(centerYear);
    if (centerIndex < 0 || !Number.isFinite(remoteScore)) return null;
    return {
        year,
        score,
        remoteMargin: score - remoteScore,
        currentCenterAdvantage: score - (values[centerIndex] ?? 0),
    };
};

const acceptedFalseProfileMode = (
    input: UnitEventWindowRankerInput,
    current: UnitEventRankerWindow,
    sourceRule: UnitEventWindowRankerResult["windowCenteringRule"],
): UnitEventEvidenceModeRecovery | null => {
    const operation = input.operationEvidence;
    const coarse = input.coarseWindow;

    if (
        sourceRule === "false_physical_profile_mode"
        && coarse
        && input.currentPrimaryYear !== undefined
        && !containsYear(current, input.currentPrimaryYear)
    ) {
        const distanceOutsideCoarse = input.currentPrimaryYear < coarse.startYear
            ? coarse.startYear - input.currentPrimaryYear
            : input.currentPrimaryYear > coarse.endYear
                ? input.currentPrimaryYear - coarse.endYear
                : 0;
        const candidate = boundedCenteredWindow(
            input.currentPrimaryYear,
            seriesBounds(input),
        );
        if (
            distanceOutsideCoarse >= 1
            && distanceOutsideCoarse <= 6
            && candidate
            && !sameWindow(candidate, current)
        ) {
            return {
                window: candidate,
                rule: "false_evidence_profile_mode",
                evidence: "false_physical_current_anchor",
            };
        }
    }

    const currentAnchor = boundedCenteredWindow(
        input.currentPrimaryYear,
        coarse,
    );
    if (
        sourceRule === "false_point_mode"
        && currentAnchor
        && currentAnchor.startYear <= current.startYear - 3
    ) {
        return {
            window: currentAnchor,
            rule: "false_evidence_profile_mode",
            evidence: "false_current_anchor",
        };
    }

    const jointPeak = pointProfilePeak(
        input,
        current,
        "jointOperationMargin",
    );
    const jointPeakWindow = boundedCenteredWindow(jointPeak?.year, coarse);
    if (
        sourceRule === "false_point_mode"
        && jointPeak
        && jointPeakWindow
        && jointPeakWindow.startYear <= current.startYear - 12
        && jointPeak.remoteMargin >= 0.03
        && jointPeak.currentCenterAdvantage >= 0.3
    ) {
        return {
            window: jointPeakWindow,
            rule: "false_evidence_profile_mode",
            evidence: "false_remote_joint_peak",
        };
    }

    const sideYear = operation?.sideStepBestYear;
    const sideDistance = sideYear === undefined
        ? 0
        : sideYear < current.startYear
            ? current.startYear - sideYear
            : sideYear > current.endYear
                ? sideYear - current.endYear
                : 0;
    if (
        sourceRule === "false_family_mode_consensus"
        && coarse
        && sideYear !== undefined
        && sideDistance >= 1
        && sideDistance <= 3
        && (operation?.sideStepRemoteMargin ?? Number.NEGATIVE_INFINITY)
            >= 0.2
        && (operation?.remoteDifferenceMargin ?? Number.NEGATIVE_INFINITY)
            >= 0.03
    ) {
        const desiredStart = sideYear < current.startYear
            ? sideYear
            : sideYear - MODE_WIDTH + 1;
        const startYear = Math.max(
            coarse.startYear,
            Math.min(desiredStart, coarse.endYear - MODE_WIDTH + 1),
        );
        const candidate = {
            startYear,
            endYear: startYear + MODE_WIDTH - 1,
        };
        if (!sameWindow(candidate, current)) {
            return {
                window: candidate,
                rule: "false_evidence_profile_mode",
                evidence: "false_side_step_edge",
            };
        }
    }

    const pairPeak = compareProfileMode(
        input,
        current,
        ["pairPeakKernel9"],
        sourceRule === "false_counterfactual_mass"
            ? DISJOINT_REMOTE_START_GAP
            : LOCAL_REMOTE_START_GAP,
    );
    if (
        sourceRule === "false_counterfactual_mass"
        && pairPeak
        && pairPeak.advantage >= 0.25
        && pairPeak.remoteMargin >= 0.8
        && pairPeak.candidate.window.startYear > current.startYear
    ) {
        return {
            window: pairPeak.candidate.window,
            rule: "false_evidence_profile_mode",
            evidence: "false_counterfactual_pair_peak",
        };
    }
    if (
        pairPeak
        && pairPeak.advantage >= 2.7
        && pairPeak.remoteMargin >= 1.8
        && pairPeak.candidate.window.startYear < current.startYear
    ) {
        return {
            window: pairPeak.candidate.window,
            rule: "false_evidence_profile_mode",
            evidence: "false_older_pair_peak",
        };
    }

    const contrast = compareProfileMode(
        input,
        current,
        FALSE_CONTRAST_PROFILES,
        LOCAL_REMOTE_START_GAP,
    );
    const contrastShift = contrast
        ? contrast.candidate.window.startYear - current.startYear
        : 0;
    if (
        contrast
        && contrast.advantage >= 0.177
        && contrast.remoteMargin >= 0.035
        && contrastShift >= 1
        && contrastShift <= 6
        && candidateAnchorCount(input, contrast.candidate.window) >= 1
    ) {
        return {
            window: contrast.candidate.window,
            rule: "false_evidence_profile_mode",
            evidence: "false_bounded_contrast",
        };
    }
    return null;
};

export const selectUnitEventEvidenceModeRecovery = (
    input: UnitEventWindowRankerInput,
    current: UnitEventRankerWindow,
    recommendedWidth: 5 | 7 | 9 | 13,
    sourceRule: UnitEventWindowRankerResult["windowCenteringRule"],
): UnitEventEvidenceModeRecovery | null => {
    if (
        recommendedWidth !== MODE_WIDTH
        || widthOf(current) !== MODE_WIDTH
    ) return null;
    return input.eventType === "missingRing"
        ? acceptedMissingProfileMode(input, current, sourceRule)
        : acceptedFalseProfileMode(input, current, sourceRule);
};

export const shouldRestoreUnitEventModeWidth = (input: {
    eventType: UnitEventWindowRankerInput["eventType"];
    recommendedWidth: 5 | 7 | 9 | 13;
    sourceRule: UnitEventWindowRankerResult["windowCenteringRule"];
    operationEvidence?: UnitEventWindowRankerInput["operationEvidence"];
    modeWindow?: UnitEventRankerWindow;
    finalWindow?: UnitEventRankerWindow;
}): boolean => {
    if (input.recommendedWidth === MODE_WIDTH) return false;
    if (
        input.eventType === "missingRing"
        && input.sourceRule === "missing_boundary_anchor_recenter"
    ) return true;
    if (
        input.eventType === "missingRing"
        && input.recommendedWidth === 9
        && input.sourceRule === "mode_mass"
        && input.modeWindow
        && input.finalWindow
        && containsYear(
            input.modeWindow,
            input.operationEvidence?.sideStepBestYear,
        )
        && !containsYear(
            input.finalWindow,
            input.operationEvidence?.sideStepBestYear,
        )
        && (input.operationEvidence?.bestDifferenceGain
            ?? Number.NEGATIVE_INFINITY) >= 0.5
        && (input.operationEvidence?.remoteDifferenceMargin
            ?? Number.NEGATIVE_INFINITY) >= 0.05
        && (input.operationEvidence?.sideStepRemoteMargin
            ?? Number.NEGATIVE_INFINITY) >= 0.2
    ) return true;
    return input.eventType === "falseRing"
        && input.sourceRule === "false_point_narrow_mode"
        && (input.operationEvidence?.remoteDifferenceMargin
            ?? Number.NEGATIVE_INFINITY) >= 0.065
        && (input.operationEvidence?.sideStepRemoteMargin
            ?? Number.NEGATIVE_INFINITY) >= 0.16;
};
