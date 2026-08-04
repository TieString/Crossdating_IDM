/** Final deterministic arbitration between a selected mode and operation evidence. */
import type {
    UnitEventRankerWindow,
    UnitEventWindowRankerInput,
    UnitEventWindowRankerResult,
} from "./unitEventWindowRanker";

const MODE_WIDTH = 13;

type EvidenceModeArbitrationRule = Extract<
    UnitEventWindowRankerResult["windowCenteringRule"],
    | "missing_boundary_operation_reversion"
    | "missing_remote_side_reversion"
    | "false_point_evidence_reversion"
    | "false_operation_evidence_reversion"
    | "false_family_anchor_reversion"
    | "false_difference_profile_mode"
>;

export type UnitEventEvidenceModeArbitration = {
    window: UnitEventRankerWindow;
    rule: EvidenceModeArbitrationRule;
};

const distanceToWindow = (
    window: UnitEventRankerWindow,
    year: number,
): number => (
    year < window.startYear
        ? window.startYear - year
        : year > window.endYear
            ? year - window.endYear
            : 0
);

const operationWindow = (
    input: UnitEventWindowRankerInput,
    anchor: number | undefined,
): UnitEventRankerWindow | null => {
    if (anchor === undefined || !input.coarseWindow) return null;
    const startYear = Math.max(
        input.coarseWindow.startYear,
        Math.min(
            Math.round(anchor) - Math.floor(MODE_WIDTH / 2),
            input.coarseWindow.endYear - MODE_WIDTH + 1,
        ),
    );
    return { startYear, endYear: startYear + MODE_WIDTH - 1 };
};

const anchors = (input: UnitEventWindowRankerInput): number[] => [
    input.currentPrimaryYear,
    input.operationEvidence?.bestYear,
    input.operationEvidence?.sideStepBestYear,
].filter((year): year is number => year !== undefined);

const anchorSpread = (input: UnitEventWindowRankerInput): number => {
    const values = anchors(input);
    return values.length > 0 ? Math.max(...values) - Math.min(...values) : 0;
};

const containsYear = (
    window: UnitEventRankerWindow,
    year: number | undefined,
): boolean => (
    year !== undefined
    && year >= window.startYear
    && year <= window.endYear
);

const selectProfileMassWindow = (
    input: UnitEventWindowRankerInput,
    profileName: string,
): { window: UnitEventRankerWindow; margin: number } | null => {
    const values = input.ranks.get(profileName);
    if (
        !values
        || values.length !== input.years.length
        || !input.coarseWindow
    ) return null;

    const scored = input.years.flatMap((startYear, startIndex) => {
        const endIndex = startIndex + MODE_WIDTH - 1;
        const endYear = startYear + MODE_WIDTH - 1;
        if (
            startYear < input.coarseWindow!.startYear
            || endYear > input.coarseWindow!.endYear
            || endIndex >= input.years.length
            || input.years[endIndex] !== endYear
        ) return [];
        let score = 0;
        for (let index = startIndex; index <= endIndex; index += 1) {
            const value = values[index] ?? 0;
            score += Number.isFinite(value) ? value : 0;
        }
        return [{ window: { startYear, endYear }, score }];
    }).sort((left, right) => (
        right.score - left.score
        || right.window.startYear - left.window.startYear
    ));
    const selected = scored[0];
    if (!selected) return null;
    return {
        window: selected.window,
        margin: selected.score - (scored[1]?.score ?? selected.score),
    };
};

export const shouldRejectMissingFamilyRemoteMode = (
    input: UnitEventWindowRankerInput,
    currentWindow: UnitEventRankerWindow,
    remoteWindow: UnitEventRankerWindow,
): boolean => {
    if (input.eventType !== "missingRing") return false;
    let currentVotes = 0;
    let remoteVotes = 0;
    anchors(input).forEach((year) => {
        const currentDistance = distanceToWindow(currentWindow, year);
        const remoteDistance = distanceToWindow(remoteWindow, year);
        currentVotes += Number(currentDistance < remoteDistance);
        remoteVotes += Number(remoteDistance < currentDistance);
    });
    return currentVotes > remoteVotes;
};

export const selectMissingRingCurrentAnchorRecovery = (
    input: UnitEventWindowRankerInput,
    currentWindow: UnitEventRankerWindow,
): UnitEventRankerWindow | null => {
    if (input.eventType !== "missingRing") return null;
    const candidate = operationWindow(input, input.currentPrimaryYear);
    if (!candidate || candidate.startYear === currentWindow.startYear) return null;
    const distance = Math.abs(candidate.startYear - currentWindow.startYear);
    if (distance < 7 || distance > 8 || anchorSpread(input) > 12) return null;
    const currentCenter = (
        currentWindow.startYear + currentWindow.endYear
    ) / 2;
    const candidateCenter = (
        candidate.startYear + candidate.endYear
    ) / 2;
    const direction = Math.sign(candidateCenter - currentCenter);
    const votes = anchors(input).filter((year) => (
        Math.sign(year - currentCenter) === direction
    )).length;
    return votes >= 2 ? candidate : null;
};

export type FalseRingOperationModeRecovery = {
    window: UnitEventRankerWindow;
    sourceRule: UnitEventWindowRankerResult["windowCenteringRule"];
};

export const selectFalseRingOperationModeRecovery = (
    input: UnitEventWindowRankerInput,
    currentWindow: UnitEventRankerWindow,
    sourceRule: UnitEventWindowRankerResult["windowCenteringRule"],
): FalseRingOperationModeRecovery | null => {
    if (input.eventType !== "falseRing") return null;
    const operation = input.operationEvidence;
    const candidate = operationWindow(input, operation?.bestYear);
    if (!candidate || candidate.startYear === currentWindow.startYear) return null;
    const distance = Math.abs(candidate.startYear - currentWindow.startYear);
    const spread = anchorSpread(input);
    const differenceGain = operation?.bestDifferenceGain ?? 0;
    const remoteMargin = operation?.remoteDifferenceMargin ?? 0;

    const accepted = sourceRule === "false_current_remote_mode"
        ? distance >= 12 && distance <= 20 && differenceGain >= 0.2
        : sourceRule === "false_current_anchor_consensus"
            ? distance >= 1 && distance <= 12
                && spread <= 20 && remoteMargin >= 0.01
            : sourceRule === "false_counterfactual_mass"
                ? distance >= 7 && distance <= 12
                    && spread <= 20 && differenceGain >= 0.15
                : sourceRule === "false_family_mode_consensus"
                    ? distance >= 7 && distance <= 20
                        && spread <= 3 && remoteMargin >= 0.005
                    : sourceRule === "false_point_mode"
                        ? distance >= 3 && distance <= 5
                            && spread <= 20
                            && differenceGain >= 0.3
                            && remoteMargin >= 0.1
                        : false;
    return accepted ? { window: candidate, sourceRule } : null;
};

/**
 * Resolves the last few cases where one selector contradicts several independent
 * physical signals. It only changes the 13-year mode; width calibration remains
 * a separate decision.
 */
export const selectUnitEventEvidenceModeArbitration = (
    input: UnitEventWindowRankerInput,
    currentWindow: UnitEventRankerWindow,
    prePointWindow: UnitEventRankerWindow,
    sourceRule: UnitEventWindowRankerResult["windowCenteringRule"],
): UnitEventEvidenceModeArbitration | null => {
    const operation = input.operationEvidence;

    if (input.eventType === "missingRing") {
        const displacement = currentWindow.startYear - prePointWindow.startYear;
        if (
            sourceRule === "missing_boundary_feature_recenter"
            && displacement >= 3
            && displacement <= 4
            && (operation?.bestYear ?? Number.POSITIVE_INFINITY)
                <= prePointWindow.startYear
            && (operation?.bestDifferenceGain ?? 0) >= 0.6
            && (operation?.remoteDifferenceMargin ?? 0) >= 0.08
        ) {
            return {
                window: prePointWindow,
                rule: "missing_boundary_operation_reversion",
            };
        }
        if (
            sourceRule === "missing_family_remote_mode"
            && (operation?.sideStepBestYear ?? Number.POSITIVE_INFINITY)
                < prePointWindow.startYear
        ) {
            return {
                window: prePointWindow,
                rule: "missing_remote_side_reversion",
            };
        }
        return null;
    }

    const prePointDisplacement = (
        prePointWindow.startYear - currentWindow.startYear
    );
    const pointNarrowNewerDisplacement = (
        currentWindow.startYear - prePointWindow.startYear
    );
    if (
        sourceRule === "false_point_narrow_mode"
        && pointNarrowNewerDisplacement >= 1
        && pointNarrowNewerDisplacement <= 4
        && (operation?.bestDifferenceGain ?? 0) >= 0.5
        && (operation?.remoteDifferenceMargin ?? 0) >= 0.065
        && (operation?.sideStepRemoteMargin ?? 0) >= 0.2
    ) {
        return {
            window: prePointWindow,
            rule: "false_point_evidence_reversion",
        };
    }
    if (
        sourceRule === "false_point_mode"
        && prePointDisplacement >= 8
        && prePointDisplacement <= 12
        && (operation?.bestDifferenceGain ?? 0) >= 0.6
        && (operation?.sideStepRemoteMargin ?? Number.POSITIVE_INFINITY) <= 0.2
    ) {
        return {
            window: prePointWindow,
            rule: "false_point_evidence_reversion",
        };
    }

    if (
        sourceRule === "false_operation_mode_recovery"
        && prePointDisplacement >= 8
        && containsYear(prePointWindow, input.currentPrimaryYear)
        && containsYear(prePointWindow, operation?.sideStepBestYear)
        && !containsYear(currentWindow, input.currentPrimaryYear)
        && !containsYear(currentWindow, operation?.sideStepBestYear)
        && (
            Math.abs(
                input.currentPrimaryYear! - operation!.sideStepBestYear!,
            ) <= 1
            || (
                Math.abs(
                    input.currentPrimaryYear! - operation!.sideStepBestYear!,
                ) <= 2
                && (operation?.bestDifferenceGain
                    ?? Number.NEGATIVE_INFINITY) >= 0.6
                && (operation?.sideStepRemoteMargin
                    ?? Number.NEGATIVE_INFINITY) >= 0.1
            )
        )
    ) {
        return {
            window: prePointWindow,
            rule: "false_operation_evidence_reversion",
        };
    }

    const evidenceYears = [
        input.currentPrimaryYear,
        operation?.bestYear,
        operation?.sideStepBestYear,
    ];
    if (
        sourceRule === "false_family_remote_mode"
        && evidenceYears.every((year) => (
            year !== undefined && year > currentWindow.endYear
        ))
    ) {
        return {
            window: prePointWindow,
            rule: "false_family_anchor_reversion",
        };
    }

    if (sourceRule === "false_counterfactual_mass") {
        const profileMode = selectProfileMassWindow(input, "differenceFull");
        const olderDisplacement = profileMode
            ? currentWindow.startYear - profileMode.window.startYear
            : 0;
        if (
            profileMode
            && olderDisplacement >= 3
            && olderDisplacement <= 5
            && profileMode.margin >= 0.02
            && (operation?.bestDifferenceGain ?? 0) >= 0.6
            && (operation?.remoteDifferenceMargin ?? 0) >= 0.05
            && (operation?.sideStepRemoteMargin ?? 0) >= 0.2
        ) {
            return {
                window: profileMode.window,
                rule: "false_difference_profile_mode",
            };
        }
    }
    return null;
};
