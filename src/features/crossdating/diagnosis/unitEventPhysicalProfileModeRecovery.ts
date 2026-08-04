/**
 * Final physical-profile arbitration for unresolved 13-year unit-event modes.
 *
 * The learned selectors remain responsible for the normal path. This layer only
 * revisits wide cases when independent lag, reference-vote, and pair evidence
 * agree on another complete mode inside the already accepted coarse interval.
 */
import type {
    UnitEventRankerWindow,
    UnitEventWindowRankerInput,
    UnitEventWindowRankerResult,
} from "./unitEventWindowRanker";

const MODE_WIDTH = 13;
const SCORE_EPSILON = 1e-12;
const MISSING_MINIMUM_WEIGHTED_ADVANTAGE = 5;

const MISSING_PROFILES = [
    { name: "differenceFull", weight: 7 },
    { name: "cumulativeReferenceVote", weight: 6 },
] as const;

const FALSE_PROFILES = [
    { name: "cumulativeCombined", weight: 0.4614 },
    { name: "cumulativeReferenceVoteCusum", weight: 0.3169 },
    { name: "pairPeakKernel5", weight: 0.2217 },
] as const;

const MISSING_PROTECTED_RULES = new Set<string>([
    "missing_current_anchor_recovery",
    "missing_remote_side_reversion",
    "missing_boundary_operation_reversion",
]);

type ProfileDefinition = {
    name: string;
    weight: number;
};

type PreparedProfile = ProfileDefinition & {
    prefix: number[];
};

type ScoredMode = {
    window: UnitEventRankerWindow;
    score: number;
    profileScores: number[];
};

export type UnitEventPhysicalProfileModeRecovery = {
    window: UnitEventRankerWindow;
    rule:
        | "missing_physical_profile_mode"
        | "false_physical_profile_mode";
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

const prepareProfiles = (
    input: UnitEventWindowRankerInput,
    definitions: readonly ProfileDefinition[],
): { profiles: PreparedProfile[]; indexByYear: Map<number, number> } | null => {
    const indexByYear = new Map(
        input.years.map((year, index) => [year, index]),
    );
    const profiles = definitions.flatMap((definition) => {
        const values = input.ranks.get(definition.name);
        if (!values || values.length !== input.years.length) return [];
        const prefix = [0];
        values.forEach((value) => {
            prefix.push(
                prefix[prefix.length - 1]!
                + (Number.isFinite(value) ? value : 0),
            );
        });
        return [{ ...definition, prefix }];
    });
    return profiles.length === definitions.length
        ? { profiles, indexByYear }
        : null;
};

const scoreWindow = (
    prepared: NonNullable<ReturnType<typeof prepareProfiles>>,
    window: UnitEventRankerWindow,
): ScoredMode | null => {
    const startIndex = prepared.indexByYear.get(window.startYear);
    const endIndex = prepared.indexByYear.get(window.endYear);
    if (
        startIndex === undefined
        || endIndex === undefined
        || endIndex - startIndex !== MODE_WIDTH - 1
    ) return null;
    const profileScores = prepared.profiles.map((profile) => (
        profile.prefix[endIndex + 1]! - profile.prefix[startIndex]!
    ));
    return {
        window,
        profileScores,
        score: profileScores.reduce((sum, value, index) => (
            sum + value * prepared.profiles[index]!.weight
        ), 0),
    };
};

const selectBestMode = (
    input: UnitEventWindowRankerInput,
    definitions: readonly ProfileDefinition[],
): {
    best: ScoredMode;
    firstStart: number;
    lastStart: number;
    prepared: NonNullable<ReturnType<typeof prepareProfiles>>;
} | null => {
    const coarseWindow = input.coarseWindow;
    if (!coarseWindow || widthOf(coarseWindow) < MODE_WIDTH) return null;
    const prepared = prepareProfiles(input, definitions);
    if (!prepared) return null;
    const firstStart = coarseWindow.startYear;
    const lastStart = coarseWindow.endYear - MODE_WIDTH + 1;
    let best: ScoredMode | null = null;
    for (let startYear = firstStart; startYear <= lastStart; startYear += 1) {
        const candidate = scoreWindow(prepared, {
            startYear,
            endYear: startYear + MODE_WIDTH - 1,
        });
        if (
            candidate
            && (
                !best
                || candidate.score > best.score + SCORE_EPSILON
                || Math.abs(candidate.score - best.score) <= SCORE_EPSILON
            )
        ) best = candidate;
    }
    return best ? { best, firstStart, lastStart, prepared } : null;
};

export const selectMissingRingPhysicalProfileMode = (
    input: UnitEventWindowRankerInput,
    currentMode: UnitEventRankerWindow,
    recommendedWidth: 5 | 7 | 9 | 13,
    sourceRule: UnitEventWindowRankerResult["windowCenteringRule"],
): UnitEventPhysicalProfileModeRecovery | null => {
    const differenceGain = input.operationEvidence?.bestDifferenceGain;
    if (
        input.eventType !== "missingRing"
        || recommendedWidth !== MODE_WIDTH
        || widthOf(currentMode) !== MODE_WIDTH
        || MISSING_PROTECTED_RULES.has(sourceRule)
        || differenceGain === undefined
        || !Number.isFinite(differenceGain)
        || differenceGain < 0
    ) return null;
    const selection = selectBestMode(input, MISSING_PROFILES);
    if (!selection) return null;
    const currentStart = Math.max(
        selection.firstStart,
        Math.min(currentMode.startYear, selection.lastStart),
    );
    const comparableCurrent = scoreWindow(selection.prepared, {
        startYear: currentStart,
        endYear: currentStart + MODE_WIDTH - 1,
    });
    if (
        !comparableCurrent
        || sameWindow(selection.best.window, currentMode)
        || selection.best.score - comparableCurrent.score
            < MISSING_MINIMUM_WEIGHTED_ADVANTAGE
        || selection.best.profileScores.some((score, index) => (
            score <= comparableCurrent.profileScores[index]! + SCORE_EPSILON
        ))
        || (
            containsYear(currentMode, input.currentPrimaryYear)
            && !containsYear(selection.best.window, input.currentPrimaryYear)
        )
    ) return null;
    return {
        window: selection.best.window,
        rule: "missing_physical_profile_mode",
    };
};

export const selectFalseRingPhysicalProfileMode = (
    input: UnitEventWindowRankerInput,
    currentMode: UnitEventRankerWindow,
    recommendedWidth: 5 | 7 | 9 | 13,
    sourceRule: UnitEventWindowRankerResult["windowCenteringRule"],
): UnitEventPhysicalProfileModeRecovery | null => {
    if (
        input.eventType !== "falseRing"
        || recommendedWidth !== MODE_WIDTH
        || widthOf(currentMode) !== MODE_WIDTH
        || !input.coarseWindow
    ) return null;
    const selection = selectBestMode(input, FALSE_PROFILES);
    const operation = input.operationEvidence;
    if (!selection || !operation || sameWindow(selection.best.window, currentMode)) {
        return null;
    }
    const candidate = selection.best.window;
    const shift = candidate.startYear - currentMode.startYear;
    const coarseDisjoint = (
        currentMode.endYear < input.coarseWindow.startYear
        || currentMode.startYear > input.coarseWindow.endYear
    );
    const currentAnchorProtected = (
        containsYear(currentMode, input.currentPrimaryYear)
        && !containsYear(candidate, input.currentPrimaryYear)
    );
    const accepted = (
        (
            sourceRule === "false_current_remote_mode"
            && (operation.sideStepRemoteMargin ?? Number.POSITIVE_INFINITY) < 0.05
        )
        || (
            sourceRule === "false_current_anchor_consensus"
            && coarseDisjoint
            && containsYear(candidate, operation.bestYear)
        )
        || (
            sourceRule === "false_operation_mode_recovery"
            && (operation.remoteDifferenceMargin ?? Number.NEGATIVE_INFINITY) >= 0.05
        )
        || (
            sourceRule === "false_counterfactual_mass"
            && shift === 1
            && (operation.sideStepRemoteMargin ?? Number.NEGATIVE_INFINITY) >= 0.5
        )
        || (
            sourceRule === "false_point_mode"
            && shift > 0
            && shift <= 2
            && !currentAnchorProtected
        )
        || (
            sourceRule === "false_counterfactual_mass"
            && shift >= 4
            && shift <= 8
            && containsYear(candidate, operation.bestYear)
        )
    );
    return accepted ? {
        window: candidate,
        rule: "false_physical_profile_mode",
    } : null;
};
