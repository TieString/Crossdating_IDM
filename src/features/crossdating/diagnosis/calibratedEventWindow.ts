/**
 * One-mode calibrated review windows for an already selected event operation.
 *
 * A 13-year event-specific profile first selects one local mode inside the high-recall coarse
 * region. Narrower windows may only compete inside that mode. Physical partial moves use
 * cross-profile agreement and operation separation to select 5, 7, or 9 years; unresolved
 * cases remain at 13 years instead of falling back to 17 or the full coarse region.
 */
import type { DiagnosisEventType } from "./types";

type LocalizableEventType = Exclude<DiagnosisEventType, "wholeSeriesMove">;

export type CalibratedEventWindow = {
    startYear: number;
    endYear: number;
};

export type CalibratedWindowCandidate = CalibratedEventWindow & {
    source: string;
};

export type CalibratedEventWindowInput = {
    eventType: LocalizableEventType;
    years: readonly number[];
    ranks: ReadonlyMap<string, readonly number[]>;
    coarseWindow: CalibratedEventWindow;
    internalCandidates: readonly CalibratedWindowCandidate[];
    currentPrimaryYear?: number;
    decisiveYear?: number;
    operationEvidence?: {
        bestYear: number;
        remoteDifferenceMargin: number;
        sideStepBestYear?: number;
        sideStepRemoteMargin?: number;
    };
};

export type CalibratedEventWindowResult = {
    window: CalibratedEventWindow;
    modeWindow: CalibratedEventWindow;
    width: 5 | 7 | 9 | 13;
    profileNames: string[];
    calibrationRule: string;
    concentration: number;
    remoteMargin: number;
    scoreByYear: ReadonlyMap<number, number>;
};

type WindowEvidence = CalibratedEventWindow & {
    score: number;
    remoteMargin: number;
};

export const CALIBRATED_EVENT_WINDOW_WIDTHS = [
    5,
    7,
    9,
    13,
] as const;

const MODE_PROFILES: Record<LocalizableEventType, readonly string[]> = {
    // In frozen arbitrary-year normal-series cases, missing rings localize most reliably from
    // the cumulative lag step. False rings need both the sharp edit residual and the one-sided
    // split gain so either channel cannot drag the single displayed mode to a remote plateau.
    missingRing: ["cumulativeCombined"],
    falseRing: ["comboFull", "cumulativeReferenceVote", "currentPeak"],
    partialMove: ["differenceFull"],
};

const FALSE_RING_CUSUM_MODE_PROFILES = [
    "cumulativeCombined",
    "cumulativeCombinedCusum",
] as const;

const FALSE_RING_INDEPENDENT_BOUNDARY_PROFILES = [
    "rawFull",
    "transitionSplitGain",
    "cumulativeReferenceVote",
    "sideStepScore",
] as const;

const PHYSICAL_PARTIAL_CONSENSUS_PROFILES = [
    "boundaryLocal:stepMinimum3",
    "boundaryLocal:stepMinimum5",
    "piecewiseCombinedObjective",
    "cumulativeCombined",
    "differenceFull",
    "whitenedFull",
    "rawFull",
    "cumulativeReferenceMedian",
    "reference:rankMean",
] as const;

const PARTIAL_REFERENCE_MODE_PROFILES = [
    "pairFixedLagStepWeighted",
    "pairFixedLagStepMedian",
] as const;

const UNIT_EVENT_SHARP_PROFILES = [
    "differenceFull",
    "transitionSplitGain",
    "whitenedFull",
] as const;

const DIFFUSE_MISSING_MODE_PROFILES = [
    "differenceFull",
    "cumulativeCombined",
    "rawFull",
    "reference:rankMedian",
    "currentPeak",
] as const;

const UNIT_FIVE_YEAR_INDEPENDENT_MAX_DISTANCE = 2;
const MISSING_NINE_YEAR_MINIMUM_OPERATION_MARGIN = 0.025;
const FALSE_RING_NINE_YEAR_MINIMUM_OPERATION_MARGIN = 0.025;
const FALSE_RING_MODE_KERNEL_BANDWIDTH = 1.5;
const FALSE_RING_CUSUM_MODE_KERNEL_BANDWIDTH = 3;
const FALSE_RING_NARROW_CUSUM_MAX_DISTANCE = 4;
const FALSE_RING_NINE_YEAR_RAW_MAX_DISTANCE = 2;
const FALSE_RING_INDEPENDENT_MODE_MINIMUM_OPERATION_MARGIN = 0.05;
const FALSE_RING_INDEPENDENT_MODE_MINIMUM_NEWER_SHIFT = 2;
const MISSING_DIFFUSE_MODE_MINIMUM_SHIFT = 2;
const MISSING_SIDE_STEP_MINIMUM_REMOTE_MARGIN = 0.04;
const PARTIAL_NINE_YEAR_MINIMUM_OPERATION_MARGIN = 0.015;

const percentileRanks = (values: number[]): number[] => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const result = new Array(values.length).fill(0);
    let start = 0;
    while (start < ordered.length) {
        let end = start + 1;
        while (end < ordered.length && ordered[end].value === ordered[start].value) {
            end += 1;
        }
        const rank = ((start + end - 1) / 2) / Math.max(1, ordered.length - 1);
        for (let index = start; index < end; index += 1) {
            result[ordered[index].index] = rank;
        }
        start = end;
    }
    return result;
};

const contains = (
    window: CalibratedEventWindow,
    year: number,
): boolean => year >= window.startYear && year <= window.endYear;

const mean = (values: number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

const profileRows = (
    input: CalibratedEventWindowInput,
    profileNames: readonly string[],
): Array<{ year: number; value: number }> => {
    const currentPeak = percentileRanks(input.years.map((year) => (
        input.currentPrimaryYear === undefined
            ? 0
            : Math.max(0, 1 - Math.abs(year - input.currentPrimaryYear) / 9)
    )));
    return input.years.map((year, index) => ({
        year,
        value: mean(profileNames.map((profile) => (
            profile === "currentPeak"
                ? currentPeak[index] ?? 0
                : input.ranks.get(profile)?.[index] ?? 0
        ))),
    })).filter((row) => contains(input.coarseWindow, row.year));
};

const scoreWindows = (
    rows: Array<{ year: number; value: number }>,
    width: number,
    bounds: CalibratedEventWindow,
): WindowEvidence[] => {
    const maximumStart = bounds.endYear - width + 1;
    const candidates: Array<CalibratedEventWindow & { score: number }> = [];
    for (let startYear = bounds.startYear; startYear <= maximumStart; startYear += 1) {
        const endYear = startYear + width - 1;
        const inside = rows.filter((row) => (
            row.year >= startYear && row.year <= endYear
        ));
        if (inside.length === 0) continue;
        candidates.push({
            startYear,
            endYear,
            score: inside.reduce((sum, row) => sum + row.value, 0)
                / Math.sqrt(inside.length),
        });
    }
    candidates.sort((left, right) => (
        right.score - left.score || right.startYear - left.startYear
    ));
    return candidates.map((candidate) => {
        const remote = candidates.find((other) => (
            other.endYear < candidate.startYear
            || other.startYear > candidate.endYear
        ));
        return {
            ...candidate,
            remoteMargin:
                candidate.score - (remote?.score ?? candidate.score),
        };
    });
};

const bestWindow = (
    rows: Array<{ year: number; value: number }>,
    width: number,
    bounds: CalibratedEventWindow,
): WindowEvidence | null => scoreWindows(rows, width, bounds)[0] ?? null;

const kernelConsensusWindow = (
    input: CalibratedEventWindowInput,
    profileNames: readonly string[],
    width: number,
    bounds: CalibratedEventWindow,
    bandwidth: number,
): WindowEvidence | null => {
    const starts = profileNames.flatMap((profile) => {
        const window = bestWindow(profileRows(input, [profile]), width, bounds);
        return window ? [window.startYear] : [];
    });
    if (starts.length !== profileNames.length) return null;
    const rows = profileRows(input, profileNames);
    const windows = scoreWindows(rows, width, bounds);
    return windows.reduce<WindowEvidence | null>((best, window) => {
        const consensus = starts.reduce((sum, startYear) => (
            sum + Math.exp(
                -0.5 * ((window.startYear - startYear) / bandwidth) ** 2,
            )
        ), 0);
        const bestConsensus = best === null
            ? Number.NEGATIVE_INFINITY
            : starts.reduce((sum, startYear) => (
                sum + Math.exp(
                    -0.5 * ((best.startYear - startYear) / bandwidth) ** 2,
                )
            ), 0);
        return consensus > bestConsensus
            || (consensus === bestConsensus
                && (best === null || window.startYear > best.startYear))
            ? window
            : best;
    }, null);
};

const windowCenter = (window: CalibratedEventWindow): number => (
    (window.startYear + window.endYear) / 2
);

const physicalPartialConsensus = (
    input: CalibratedEventWindowInput,
    modeWindow: CalibratedEventWindow,
): {
    narrowRows: Array<{ year: number; value: number }>;
    fiveYearWindow: WindowEvidence;
} | null => {
    if (!PHYSICAL_PARTIAL_CONSENSUS_PROFILES.every(
        (profile) => input.ranks.has(profile),
    )) {
        return null;
    }
    const narrowRows = profileRows(input, ["boundaryLocal:stepMinimum3"]);
    const fiveYearWindow = bestWindow(narrowRows, 5, modeWindow);
    if (!fiveYearWindow) return null;
    const center = windowCenter(fiveYearWindow);
    const agrees = PHYSICAL_PARTIAL_CONSENSUS_PROFILES.every((profile) => {
        const profileWindow = bestWindow(
            profileRows(input, [profile]),
            5,
            modeWindow,
        );
        return profileWindow !== null
            && Math.abs(windowCenter(profileWindow) - center) <= 2;
    });
    return agrees ? { narrowRows, fiveYearWindow } : null;
};

type UnitBoundaryConsensus = {
    modeMass: WindowEvidence;
    sharpMass: WindowEvidence;
    sharpRows: Array<{ year: number; value: number }>;
    profileSpread: number;
    anchorSpread: number;
    currentOperationDistance: number;
    operationMargin: number;
    massDistance: number;
    medianAnchor: number;
};

const unitBoundaryConsensus = (
    input: CalibratedEventWindowInput,
    modeWindow: CalibratedEventWindow,
    modeRows: Array<{ year: number; value: number }>,
    width: 5 | 7 | 9,
): UnitBoundaryConsensus | null => {
    if (
        input.currentPrimaryYear === undefined
        || input.operationEvidence === undefined
        || !UNIT_EVENT_SHARP_PROFILES.every(
            (profile) => input.ranks.has(profile),
        )
    ) {
        return null;
    }
    const profileWindows = UNIT_EVENT_SHARP_PROFILES.map((profile) => (
        bestWindow(profileRows(input, [profile]), 5, modeWindow)
    ));
    if (profileWindows.some((window) => window === null)) return null;

    const profileCenters = profileWindows.map((window) => (
        windowCenter(window!)
    ));
    const anchorCenters = [
        ...profileCenters,
        input.currentPrimaryYear,
        input.operationEvidence.bestYear,
    ];
    const profileSpread = Math.max(...profileCenters)
        - Math.min(...profileCenters);
    const anchorSpread = Math.max(...anchorCenters)
        - Math.min(...anchorCenters);
    const currentOperationDistance = Math.abs(
        input.currentPrimaryYear - input.operationEvidence.bestYear,
    );
    const sharpRows = profileRows(input, UNIT_EVENT_SHARP_PROFILES);
    const modeMass = bestWindow(modeRows, width, modeWindow);
    const sharpMass = bestWindow(
        sharpRows,
        width,
        modeWindow,
    );
    if (!modeMass || !sharpMass) return null;
    const orderedAnchors = anchorCenters.slice().sort(
        (left, right) => left - right,
    );
    return {
        modeMass,
        sharpMass,
        sharpRows,
        profileSpread,
        anchorSpread,
        currentOperationDistance,
        operationMargin: input.operationEvidence.remoteDifferenceMargin,
        massDistance: Math.abs(
            windowCenter(sharpMass) - windowCenter(modeMass),
        ),
        medianAnchor:
            orderedAnchors[Math.floor(orderedAnchors.length / 2)],
    };
};

const centeredWindow = (
    centerYear: number,
    width: number,
    bounds: CalibratedEventWindow,
): CalibratedEventWindow => {
    const startYear = Math.max(
        bounds.startYear,
        Math.min(
            centerYear - Math.floor((width - 1) / 2),
            bounds.endYear - width + 1,
        ),
    );
    return { startYear, endYear: startYear + width - 1 };
};

const evidenceAtWindow = (
    rows: Array<{ year: number; value: number }>,
    width: 5 | 7,
    bounds: CalibratedEventWindow,
    window: CalibratedEventWindow,
): WindowEvidence | null => scoreWindows(rows, width, bounds).find(
    (candidate) => candidate.startYear === window.startYear,
) ?? null;

type UnitWindowSelection = {
    window: WindowEvidence;
    rows: Array<{ year: number; value: number }>;
    profileNames: string[];
    calibrationRule: string;
};

const selectMissingRingNarrowWindow = (
    input: CalibratedEventWindowInput,
    modeWindow: CalibratedEventWindow,
    modeRows: Array<{ year: number; value: number }>,
): UnitWindowSelection | null => {
    const five = unitBoundaryConsensus(input, modeWindow, modeRows, 5);
    const fiveYearEvidenceIsConcentrated = (
        five
        && five.anchorSpread <= 4
        && five.profileSpread <= 2
        && five.currentOperationDistance <= 4
        && five.operationMargin >= 0.08
        && five.massDistance <= 1
    );
    if (fiveYearEvidenceIsConcentrated) {
        const referenceVoteWindow = input.ranks.has("cumulativeReferenceVote")
            ? bestWindow(
                profileRows(input, ["cumulativeReferenceVote"]),
                5,
                modeWindow,
            )
            : null;
        if (
            referenceVoteWindow
            && Math.abs(
                windowCenter(referenceVoteWindow) - five.medianAnchor,
            ) > UNIT_FIVE_YEAR_INDEPENDENT_MAX_DISTANCE
        ) {
            return null;
        }
        const window = evidenceAtWindow(
            modeRows,
            5,
            modeWindow,
            centeredWindow(five.medianAnchor, 5, modeWindow),
        );
        if (window) {
            return {
                window,
                rows: modeRows,
                profileNames: [...MODE_PROFILES.missingRing],
                calibrationRule:
                    "missing_ring_concentrated_anchor_consensus_5",
            };
        }
    }

    const seven = unitBoundaryConsensus(input, modeWindow, modeRows, 7);
    if (
        seven
        && seven.anchorSpread <= 2
        && seven.profileSpread <= 2
        && seven.currentOperationDistance <= 2
        && seven.operationMargin >= 0.04
        && seven.massDistance <= 1
    ) {
        return {
            window: seven.sharpMass,
            rows: seven.sharpRows,
            profileNames: [...UNIT_EVENT_SHARP_PROFILES],
            calibrationRule: "missing_ring_boundary_consensus_7",
        };
    }

    const nine = unitBoundaryConsensus(input, modeWindow, modeRows, 9);
    if (
        nine
        && nine.profileSpread <= 2
        && nine.anchorSpread <= 12
        && nine.currentOperationDistance <= 8
        && nine.operationMargin >= 0.01
        && nine.massDistance <= 2
        && contains(nine.modeMass, input.currentPrimaryYear!)
    ) {
        return {
            window: nine.modeMass,
            rows: modeRows,
            profileNames: [...MODE_PROFILES.missingRing],
            calibrationRule: "missing_ring_cross_evidence_consensus_9",
        };
    }
    return null;
};

const selectFalseRingNarrowWindow = (
    input: CalibratedEventWindowInput,
    modeWindow: CalibratedEventWindow,
    modeRows: Array<{ year: number; value: number }>,
): UnitWindowSelection | null => {
    const five = unitBoundaryConsensus(input, modeWindow, modeRows, 5);
    const fiveYearEvidenceIsConcentrated = (
        five
        && five.anchorSpread <= 4
        && five.profileSpread <= 2
        && five.currentOperationDistance <= 1
        && five.operationMargin >= 0.08
        && five.massDistance <= 1
    );
    if (fiveYearEvidenceIsConcentrated) {
        const rawResidualWindow = input.ranks.has("rawFull")
            ? bestWindow(
                profileRows(input, ["rawFull"]),
                5,
                modeWindow,
            )
            : null;
        if (
            rawResidualWindow
            && Math.abs(
                windowCenter(rawResidualWindow)
                - input.currentPrimaryYear!,
            ) > UNIT_FIVE_YEAR_INDEPENDENT_MAX_DISTANCE
        ) {
            return null;
        }
        const window = evidenceAtWindow(
            modeRows,
            5,
            modeWindow,
            centeredWindow(input.currentPrimaryYear!, 5, modeWindow),
        );
        if (window) {
            return {
                window,
                rows: modeRows,
                profileNames: [...MODE_PROFILES.falseRing],
                calibrationRule:
                    "false_ring_concentrated_anchor_consensus_5",
            };
        }
    }

    const seven = unitBoundaryConsensus(input, modeWindow, modeRows, 7);
    if (
        seven
        && seven.anchorSpread <= 6
        && seven.profileSpread <= 2
        && seven.currentOperationDistance <= 8
        && seven.operationMargin >= 0.04
        && seven.massDistance === 0
    ) {
        return {
            window: seven.modeMass,
            rows: modeRows,
            profileNames: [...MODE_PROFILES.falseRing],
            calibrationRule: "false_ring_boundary_consensus_7",
        };
    }

    const nine = unitBoundaryConsensus(input, modeWindow, modeRows, 9);
    if (
        nine
        && nine.profileSpread <= 6
        && nine.anchorSpread <= 6
        && nine.currentOperationDistance <= 4
        && nine.operationMargin
            >= FALSE_RING_NINE_YEAR_MINIMUM_OPERATION_MARGIN
        && nine.massDistance <= 4
    ) {
        return {
            window: nine.modeMass,
            rows: modeRows,
            profileNames: [...MODE_PROFILES.falseRing],
            calibrationRule: "false_ring_cross_evidence_consensus_9",
        };
    }
    return null;
};

const windowConcentration = (
    rows: Array<{ year: number; value: number }>,
    window: CalibratedEventWindow,
): number => {
    const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0);
    const inside = rows.filter((row) => contains(window, row.year)).reduce(
        (sum, row) => sum + Math.max(0, row.value),
        0,
    );
    return inside / Math.max(1e-9, total);
};

export const selectCalibratedEventWindow = (
    input: CalibratedEventWindowInput,
): CalibratedEventWindowResult | null => {
    if (
        input.years.length === 0
        || input.coarseWindow.endYear - input.coarseWindow.startYear + 1 < 13
    ) {
        return null;
    }
    const usesFalseRingCusumMode = input.eventType === "falseRing"
        && input.ranks.has("cumulativeCombinedCusum");
    const baseModeProfileNames = usesFalseRingCusumMode
        ? FALSE_RING_CUSUM_MODE_PROFILES
        : MODE_PROFILES[input.eventType];
    const modeProfileNames = input.eventType === "partialMove"
        ? [
            ...baseModeProfileNames,
            ...PARTIAL_REFERENCE_MODE_PROFILES.filter((profile) => (
                input.ranks.has(profile)
            )),
        ]
        : baseModeProfileNames;
    const modeRows = profileRows(input, modeProfileNames);
    const evidenceModeWindow = input.eventType === "falseRing"
        ? kernelConsensusWindow(
            input,
            modeProfileNames,
            13,
            input.coarseWindow,
            usesFalseRingCusumMode
                ? FALSE_RING_CUSUM_MODE_KERNEL_BANDWIDTH
                : FALSE_RING_MODE_KERNEL_BANDWIDTH,
        )
        : bestWindow(modeRows, 13, input.coarseWindow);
    if (!evidenceModeWindow) return null;
    const decisiveWindow = input.decisiveYear !== undefined
        && contains(input.coarseWindow, input.decisiveYear)
        ? centeredWindow(input.decisiveYear, 13, input.coarseWindow)
        : null;
    let modeWindow = decisiveWindow
        ? scoreWindows(modeRows, 13, input.coarseWindow).find((candidate) => (
            candidate.startYear === decisiveWindow.startYear
        )) ?? evidenceModeWindow
        : evidenceModeWindow;

    let selected: WindowEvidence = modeWindow;
    let selectedRows = modeRows;
    let selectedProfiles = [...modeProfileNames];
    let calibrationRule = decisiveWindow
        ? "decisive_joint_operation_13"
        : "calibrated_default_13";

    if (input.eventType === "missingRing") {
        const narrow = selectMissingRingNarrowWindow(
            input,
            modeWindow,
            modeRows,
        );
        if (narrow) {
            selected = narrow.window;
            selectedRows = narrow.rows;
            selectedProfiles = narrow.profileNames;
            calibrationRule = narrow.calibrationRule;
        }
        if (
            narrow?.calibrationRule
                === "missing_ring_cross_evidence_consensus_9"
            && (
                (
                    input.operationEvidence?.remoteDifferenceMargin
                    ?? Number.POSITIVE_INFINITY
                ) < MISSING_NINE_YEAR_MINIMUM_OPERATION_MARGIN
                || (
                    input.operationEvidence !== undefined
                    && !contains(
                        narrow.window,
                        input.operationEvidence.bestYear,
                    )
                )
            )
        ) {
            const differenceRows = profileRows(input, ["differenceFull"]);
            const lowMarginMode = bestWindow(
                differenceRows,
                13,
                input.coarseWindow,
            );
            if (lowMarginMode) {
                modeWindow = lowMarginMode;
                selected = lowMarginMode;
                selectedRows = differenceRows;
                selectedProfiles = ["differenceFull"];
                calibrationRule =
                    "missing_ring_low_operation_margin_difference_13";
            }
        }
        const sideStepBestYear = input.operationEvidence?.sideStepBestYear;
        if (
            selected.endYear - selected.startYear + 1 < 13
            && sideStepBestYear !== undefined
            && (
                input.operationEvidence?.sideStepRemoteMargin
                ?? Number.NEGATIVE_INFINITY
            ) >= MISSING_SIDE_STEP_MINIMUM_REMOTE_MARGIN
            && !contains(selected, sideStepBestYear)
            && input.ranks.has("sideStepScore")
        ) {
            const sideStepRows = profileRows(input, ["sideStepScore"]);
            const sideStepMode = bestWindow(
                sideStepRows,
                13,
                input.coarseWindow,
            );
            if (
                sideStepMode
                && contains(sideStepMode, sideStepBestYear)
            ) {
                modeWindow = sideStepMode;
                selected = sideStepMode;
                selectedRows = sideStepRows;
                selectedProfiles = ["sideStepScore"];
                calibrationRule =
                    "missing_ring_side_step_disagreement_13";
            }
        }
    } else if (input.eventType === "falseRing") {
        const narrow = selectFalseRingNarrowWindow(
            input,
            modeWindow,
            modeRows,
        );
        if (narrow) {
            selected = narrow.window;
            selectedRows = narrow.rows;
            selectedProfiles = narrow.profileNames;
            calibrationRule = narrow.calibrationRule;
        }
        if (
            narrow?.calibrationRule
                === "false_ring_cross_evidence_consensus_9"
            && input.ranks.has("rawFull")
        ) {
            const rawResidualWindow = bestWindow(
                profileRows(input, ["rawFull"]),
                5,
                modeWindow,
            );
            if (
                rawResidualWindow
                && Math.abs(
                    windowCenter(rawResidualWindow)
                    - windowCenter(narrow.window),
                ) > FALSE_RING_NINE_YEAR_RAW_MAX_DISTANCE
            ) {
                selected = modeWindow;
                selectedRows = modeRows;
                selectedProfiles = [...modeProfileNames];
                calibrationRule = "false_ring_raw_disagreement_mode_13";
            }
        }
        if (
            selected.endYear - selected.startYear + 1 < 13
            && input.ranks.has("cumulativeCombinedCusum")
        ) {
            const cusumMode = bestWindow(
                profileRows(input, ["cumulativeCombinedCusum"]),
                13,
                input.coarseWindow,
            );
            if (
                cusumMode
                && Math.abs(
                    windowCenter(cusumMode) - windowCenter(selected),
                ) > FALSE_RING_NARROW_CUSUM_MAX_DISTANCE
            ) {
                selected = modeWindow;
                selectedRows = modeRows;
                selectedProfiles = [...modeProfileNames];
                calibrationRule = "false_ring_cusum_disagreement_mode_13";
            }
        }
        if (
            input.operationEvidence
            && input.operationEvidence.remoteDifferenceMargin >= 0.01
            && !contains(selected, input.operationEvidence.bestYear)
            && input.ranks.has("differenceFull")
        ) {
            const differenceRows = profileRows(input, ["differenceFull"]);
            const operationMode = bestWindow(
                differenceRows,
                13,
                input.coarseWindow,
            );
            if (
                operationMode
                && contains(
                    operationMode,
                    input.operationEvidence.bestYear,
                )
            ) {
                modeWindow = operationMode;
                selected = operationMode;
                selectedRows = differenceRows;
                selectedProfiles = ["differenceFull"];
                calibrationRule =
                    "false_ring_operation_consistent_difference_13";
            }
        }
        if (
            selected.endYear - selected.startYear + 1 < 13
            && (
                input.operationEvidence?.remoteDifferenceMargin
                ?? Number.NEGATIVE_INFINITY
            ) >= FALSE_RING_INDEPENDENT_MODE_MINIMUM_OPERATION_MARGIN
            && FALSE_RING_INDEPENDENT_BOUNDARY_PROFILES.every(
                (profile) => input.ranks.has(profile),
            )
            && input.ranks.has("cumulativeCombined")
            && input.ranks.has("cumulativeCombinedCusum")
        ) {
            const cumulativeMode = bestWindow(
                profileRows(input, ["cumulativeCombined"]),
                13,
                input.coarseWindow,
            );
            const cusumMode = bestWindow(
                profileRows(input, ["cumulativeCombinedCusum"]),
                13,
                input.coarseWindow,
            );
            const independentMode = kernelConsensusWindow(
                input,
                FALSE_RING_INDEPENDENT_BOUNDARY_PROFILES,
                13,
                input.coarseWindow,
                1.5,
            );
            if (
                cumulativeMode
                && cusumMode
                && independentMode
                && Math.abs(
                    cumulativeMode.startYear - cusumMode.startYear,
                ) <= 1
                && independentMode.startYear - cumulativeMode.startYear
                    >= FALSE_RING_INDEPENDENT_MODE_MINIMUM_NEWER_SHIFT
            ) {
                modeWindow = independentMode;
                selected = independentMode;
                selectedRows = profileRows(
                    input,
                    FALSE_RING_INDEPENDENT_BOUNDARY_PROFILES,
                );
                selectedProfiles = [
                    ...FALSE_RING_INDEPENDENT_BOUNDARY_PROFILES,
                ];
                calibrationRule =
                    "false_ring_independent_boundary_mode_13";
            }
        }
    } else if (input.eventType === "partialMove") {
        const consensus = physicalPartialConsensus(input, modeWindow);
        const operationEvidence = input.operationEvidence;
        if (
            consensus
            && operationEvidence
            && operationEvidence.remoteDifferenceMargin >= 0.04
            && contains(
                consensus.fiveYearWindow,
                operationEvidence.bestYear,
            )
        ) {
            selected = consensus.fiveYearWindow;
            selectedRows = consensus.narrowRows;
            selectedProfiles = ["boundaryLocal:stepMinimum3"];
            calibrationRule = "partial_physical_consensus_5";
        } else if (
            consensus
            && operationEvidence
            && operationEvidence.remoteDifferenceMargin >= 0.025
        ) {
            const sevenYearWindow = bestWindow(
                consensus.narrowRows,
                7,
                modeWindow,
            );
            if (
                sevenYearWindow
                && contains(sevenYearWindow, operationEvidence.bestYear)
            ) {
                selected = sevenYearWindow;
                selectedRows = consensus.narrowRows;
                selectedProfiles = ["boundaryLocal:stepMinimum3"];
                calibrationRule = "partial_physical_consensus_7";
            }
        }
        const narrowProfiles = [
            "whitenedFull",
            "comboFull",
            "currentPeak",
        ];
        const narrowRows = profileRows(input, narrowProfiles);
        const narrow = bestWindow(narrowRows, 9, modeWindow);
        const profilePeak = Math.max(
            0,
            ...narrowRows.map((row) => row.value),
        );
        if (
            selected === modeWindow
            &&
            narrow
            && narrow.score >= 2.96
            && profilePeak >= 0.9895540914026256
            && (
                operationEvidence === undefined
                || operationEvidence.remoteDifferenceMargin
                    >= PARTIAL_NINE_YEAR_MINIMUM_OPERATION_MARGIN
            )
            && (
                input.decisiveYear === undefined
                || contains(narrow, input.decisiveYear)
            )
        ) {
            selected = narrow;
            selectedRows = narrowRows;
            selectedProfiles = narrowProfiles;
            calibrationRule = "partial_physical_peak_score_9";
        }
    }

    if (
        input.eventType === "missingRing"
        && calibrationRule === "calibrated_default_13"
        && DIFFUSE_MISSING_MODE_PROFILES.every((profile) => (
            profile === "currentPeak" || input.ranks.has(profile)
        ))
    ) {
        const diffuseMode = kernelConsensusWindow(
            input,
            DIFFUSE_MISSING_MODE_PROFILES,
            13,
            input.coarseWindow,
            2,
        );
        if (diffuseMode) {
            if (
                Math.abs(
                    windowCenter(diffuseMode) - windowCenter(modeWindow),
                ) >= MISSING_DIFFUSE_MODE_MINIMUM_SHIFT
            ) {
                modeWindow = diffuseMode;
                selected = diffuseMode;
                selectedRows = profileRows(
                    input,
                    DIFFUSE_MISSING_MODE_PROFILES,
                );
                selectedProfiles = [...DIFFUSE_MISSING_MODE_PROFILES];
                calibrationRule = "missing_ring_diffuse_mode_consensus_13";
            }
        }
    }

    const scoreByYear = new Map(
        selectedRows.map((row) => [row.year, row.value]),
    );
    return {
        window: {
            startYear: selected.startYear,
            endYear: selected.endYear,
        },
        modeWindow: {
            startYear: modeWindow.startYear,
            endYear: modeWindow.endYear,
        },
        width: (
            selected.endYear - selected.startYear + 1
        ) as CalibratedEventWindowResult["width"],
        profileNames: selectedProfiles,
        calibrationRule,
        concentration: windowConcentration(selectedRows, selected),
        remoteMargin: selected.remoteMargin,
        scoreByYear,
    };
};
