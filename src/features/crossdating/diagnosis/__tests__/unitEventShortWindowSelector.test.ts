import { describe, expect, it } from "vitest";
import type { CalibratedEventWindowResult } from "../calibratedEventWindow";
import { selectUnitEventShortWindow } from "../unitEventShortWindowSelector";
import type { UnitEventWindowRankerResult } from "../unitEventWindowRanker";

const learned = (
    startYear: number,
    width: 9 | 13 = 9,
): UnitEventWindowRankerResult => {
    const modeWindow = width === 13
        ? { startYear, endYear: startYear + 12 }
        : { startYear: startYear - 2, endYear: startYear + 10 };
    return ({
    window: { startYear, endYear: startYear + width - 1 },
    modeWindow,
    prePointModeWindow: modeWindow,
    preFalseCurrentAnchorModeWindow: modeWindow,
    preDirectModeWindow: modeWindow,
    recommendedWidth: width,
    nineYearSafety: 0.9,
    widthThreshold: 0.8,
    windowCenteringRule: "mode_mass",
    widthFallbackRule: "none",
    widthSelectionRule: "legacy_model",
    score: 1,
    margin: 0.2,
    remoteMargin: 0.3,
    scoredWindows: [],
});
};

const profileNames = [
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeReferenceMedian",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
    "piecewiseCombinedObjective",
    "transitionSplitGain",
    "rawFull",
    "differenceFull",
    "comboFull",
    "whitenedFull",
    "pairDifferenceWeighted",
    "pairWhitenedMean",
] as const;
const falseProfileNames = [
    ...profileNames,
    "cumulativeReferenceVoteCusum",
] as const;

const years = Array.from({ length: 41 }, (_, index) => 1880 + index);
const profileRanks = (
    preferredOffset: number,
    overrides: Partial<Record<typeof profileNames[number], number>> = {},
): ReadonlyMap<string, readonly number[]> => new Map(profileNames.map((name) => {
    const offset = overrides[name] ?? preferredOffset;
    const startYear = 1898 + offset;
    return [name, years.map((year) => (
        year >= startYear && year < startYear + 9 ? 1 : 0
    ))];
}));

const falseProfileRanks = (
    preferredOffset: number,
): ReadonlyMap<string, readonly number[]> => new Map(falseProfileNames.map((name) => {
    const startYear = 1898 + preferredOffset;
    return [name, years.map((year) => (
        year >= startYear && year < startYear + 9 ? 1 : 0
    ))];
}));

const independent = (
    startYear: number,
    width: 5 | 7 | 9 | 13,
): CalibratedEventWindowResult => ({
    window: { startYear, endYear: startYear + width - 1 },
    modeWindow: { startYear: startYear - 2, endYear: startYear + 10 },
    width,
    profileNames: ["test"],
    calibrationRule: "test",
    concentration: 0.9,
    remoteMargin: 0.2,
    scoreByYear: new Map(),
});

describe("unit event short-window selector", () => {
    it("accepts a nested independent 7-year missing-ring window", () => {
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1901, 7),
        })).toEqual({
            window: { startYear: 1901, endYear: 1907 },
            recommendedWidth: 7,
            rule: "independent_consensus_7",
        });
    });

    it("requires calibrated operation separation for a 7-year false-ring window", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1901, 7),
            operationEvidence: {
                bestYear: 1904,
                remoteDifferenceMargin: 0.10,
            },
        })?.recommendedWidth).toBe(7);
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1901, 7),
            operationEvidence: {
                bestYear: 1904,
                remoteDifferenceMargin: 0.099,
            },
        })).toBeNull();
    });

    it("does not shorten a 13-year learned window", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: learned(1900, 13),
            independentWindow: independent(1902, 7),
        })).toEqual({
            window: { startYear: 1901, endYear: 1909 },
            recommendedWidth: 9,
            rule: "independent_calibrated_9",
        });
    });

    it("keeps a difficult independent 13-year false-ring mode wide", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: learned(1900, 13),
            independentWindow: independent(1900, 13),
        })).toBeNull();
    });

    it("uses a 9-year side-step window for a gated subtle false-ring recovery", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: learned(1871, 13),
            subtleFalseRingRecovery: true,
            operationEvidence: {
                bestYear: 1870,
                sideStepBestYear: 1880,
            },
        })).toEqual({
            window: { startYear: 1875, endYear: 1883 },
            recommendedWidth: 9,
            rule: "false_subtle_empty_recovery_9",
        });
    });

    it("does not shorten an unmarked false-ring recovery without calibration", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: learned(1871, 13),
            operationEvidence: {
                bestYear: 1870,
                sideStepBestYear: 1880,
            },
        })).toBeNull();
    });

    it("keeps an existing false-ring nine-year calibration ahead of profile narrowing", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: learned(1898, 13),
            independentWindow: independent(1900, 9),
            currentPrimaryYear: 1902,
            operationEvidence: {
                bestYear: 1903,
                sideStepBestYear: 1904,
            },
            years,
            ranks: falseProfileRanks(1),
        })).toEqual({
            window: { startYear: 1900, endYear: 1908 },
            recommendedWidth: 9,
            rule: "independent_calibrated_9",
        });
    });

    it.each([
        {
            eventType: "missingRing" as const,
            ranks: profileRanks(1),
            rule: "missing_concentrated_profile_9",
        },
        {
            eventType: "falseRing" as const,
            ranks: falseProfileRanks(1),
            rule: "false_concentrated_profile_9",
        },
    ])("shortens a concentrated $eventType profile mode to nine years", ({
        eventType,
        ranks,
        rule,
    }) => {
        expect(selectUnitEventShortWindow({
            eventType,
            learnedWindow: learned(1898, 13),
            independentWindow: independent(1898, 13),
            currentPrimaryYear: 1902,
            operationEvidence: {
                bestYear: 1903,
                sideStepBestYear: 1904,
            },
            years,
            ranks,
        })).toEqual({
            window: { startYear: 1899, endYear: 1907 },
            recommendedWidth: 9,
            rule,
        });
    });

    it("keeps a concentrated profile mode wide when operation anchors diverge", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: learned(1898, 13),
            independentWindow: independent(1898, 13),
            currentPrimaryYear: 1900,
            operationEvidence: {
                bestYear: 1902,
                sideStepBestYear: 1904,
            },
            years,
            ranks: falseProfileRanks(1),
        })).toBeNull();
    });

    it("keeps a concentrated false-ring profile wide when an anchor lacks a flank", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: learned(1898, 13),
            independentWindow: independent(1898, 13),
            currentPrimaryYear: 1900,
            operationEvidence: {
                bestYear: 1901,
                sideStepBestYear: 1902,
            },
            years,
            ranks: falseProfileRanks(1),
        })).toBeNull();
    });

    it("narrows a wide missing-ring mode when three strong anchors are compact", () => {
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: {
                ...learned(1898, 13),
                widthSelectionRule: "missing_anchor_consensus_uncertain_13",
            },
            independentWindow: independent(1898, 13),
            currentPrimaryYear: 1902,
            operationEvidence: {
                bestYear: 1903,
                sideStepBestYear: 1904,
                remoteDifferenceMargin: 0.08,
            },
        })).toEqual({
            window: { startYear: 1899, endYear: 1907 },
            recommendedWidth: 9,
            rule: "missing_compact_anchor_9",
        });
    });

    it("keeps ambiguous missing-ring side evidence at thirteen years", () => {
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: {
                ...learned(1900),
                widthSelectionRule: "missing_point_model",
            },
            independentWindow: independent(1900, 9),
            operationEvidence: {
                bestYear: 1904,
                sideStepBestYear: 1890,
                bestSideStepScore: 0.6,
                sideStepRemoteMargin: 0.08,
            },
        })).toEqual({
            window: { startYear: 1898, endYear: 1910 },
            recommendedWidth: 13,
            rule: "missing_ambiguous_remote_side_13",
        });
    });

    it("keeps a weak missing-ring profile recenter at thirteen years", () => {
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: {
                ...learned(1900),
                widthSelectionRule: "missing_point_model",
            },
            independentWindow: independent(1900, 9),
            operationEvidence: {
                bestYear: 1904,
                sideStepBestYear: 1905,
                bestDifferenceGain: 0.25,
                sideStepRemoteMargin: 0.049,
            },
            years,
            ranks: profileRanks(4),
        })).toEqual({
            window: { startYear: 1898, endYear: 1910 },
            recommendedWidth: 13,
            rule: "missing_weak_profile_evidence_13",
        });
    });

    it("rejects an independent window outside the selected 9-year mode", () => {
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1899, 7),
        })).toBeNull();
    });

    it("accepts a high-margin missing-ring 5-year window", () => {
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1902, 5),
            operationEvidence: {
                bestYear: 1904,
                remoteDifferenceMargin: 0.13,
            },
        })?.recommendedWidth).toBe(5);
    });

    it("rejects a missing-ring 5-year window below its frozen margin", () => {
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1902, 5),
            operationEvidence: {
                bestYear: 1904,
                remoteDifferenceMargin: 0.129,
            },
        })).toBeNull();
    });

    it("rejects a five-year missing-ring window when anchors sit at its edge", () => {
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1902, 5),
            currentPrimaryYear: 1902,
            operationEvidence: {
                bestYear: 1903,
                sideStepBestYear: 1902,
                remoteDifferenceMargin: 0.2,
            },
        })).toBeNull();
    });

    it("calibrates a high-margin false-ring five-year mode to seven years", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1902, 5),
            currentPrimaryYear: 1904,
            operationEvidence: {
                bestYear: 1904,
                remoteDifferenceMargin: 0.09,
                sideStepBestYear: 1908,
            },
        })).toEqual({
            window: { startYear: 1901, endYear: 1907 },
            recommendedWidth: 7,
            rule: "independent_minimum_calibrated_7",
        });
    });

    it.each([
        { margin: 0.089, sideStepBestYear: 1904 },
        { margin: 0.12, sideStepBestYear: 1909 },
    ])("rejects unsafe false-ring 5-year evidence %#", ({
        margin,
        sideStepBestYear,
    }) => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1902, 5),
            currentPrimaryYear: 1904,
            operationEvidence: {
                bestYear: 1904,
                remoteDifferenceMargin: margin,
                sideStepBestYear,
            },
        })).toBeNull();
    });

    it("does not expose 9- or 13-year independent windows as short choices", () => {
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1900, 9),
        })).toBeNull();
    });

    it("keeps a corrected false-ring mode wide when independent evidence disagrees", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: {
                ...learned(1898, 13),
                windowCenteringRule: "false_difference_profile_mode",
            },
            independentWindow: independent(1902, 9),
        })).toEqual({
            window: { startYear: 1898, endYear: 1910 },
            recommendedWidth: 13,
            rule: "false_evidence_arbitration_13",
        });
    });

    it("preserves a false-ring point mode widened by operation evidence", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: {
                ...learned(1898, 13),
                windowCenteringRule: "false_point_narrow_mode",
                widthSelectionRule: "false_point_narrow_evidence_wide",
            },
            independentWindow: independent(1900, 9),
            operationEvidence: { bestYear: 1908 },
        })).toEqual({
            window: { startYear: 1898, endYear: 1910 },
            recommendedWidth: 13,
            rule: "false_evidence_arbitration_13",
        });
    });

    it("allows a short false-ring point mode when its operation peak has flanks", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: {
                ...learned(1898, 13),
                windowCenteringRule: "false_point_narrow_mode",
                widthSelectionRule: "false_point_narrow_evidence_wide",
            },
            independentWindow: independent(1900, 9),
            operationEvidence: { bestYear: 1904 },
        })?.recommendedWidth).toBe(9);
    });

    it("keeps false-ring side and family flank conflicts wide", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: {
                ...learned(1898, 13),
                windowCenteringRule: "false_side_step_mode",
            },
            independentWindow: independent(1898, 9),
            operationEvidence: { bestYear: 1904, sideStepBestYear: 1916 },
        })?.rule).toBe("false_side_mode_flank_13");

        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: {
                ...learned(1898, 13),
                windowCenteringRule: "false_family_mode_consensus",
            },
            independentWindow: independent(1901, 9),
            operationEvidence: {
                bestYear: 1904,
                bestDifferenceGain: 0.09,
                remoteDifferenceMargin: 0.09,
                sideStepBestYear: 1895,
            },
        })?.rule).toBe("false_family_flank_13");
    });

    it("repositions a missing-ring window only with directional profile support", () => {
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1900, 9),
            years,
            ranks: profileRanks(0),
            operationEvidence: { bestYear: 1904, sideStepBestYear: 1899 },
        })).toEqual({
            window: { startYear: 1898, endYear: 1906 },
            recommendedWidth: 9,
            rule: "missing_profile_side_older_9",
        });

        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1900, 9),
            years,
            ranks: profileRanks(2, {
                cumulativeReferenceMedian: 4,
                cumulativeReferenceMean: 4,
                cumulativeReferenceVote: 4,
            }),
            operationEvidence: { bestYear: 1904, sideStepBestYear: 1909 },
        })?.rule).toBe("missing_profile_median_9");
    });

    it("keeps a missing-ring boundary conflict and adjacent recenter wide", () => {
        const boundary = {
            ...learned(1901),
            modeWindow: { startYear: 1898, endYear: 1910 },
            windowCenteringRule: "missing_boundary_feature_recenter" as const,
        };
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: boundary,
            independentWindow: independent(1901, 9),
            years,
            ranks: profileRanks(3),
            operationEvidence: { bestYear: 1905, sideStepBestYear: 1911 },
        })?.rule).toBe("missing_boundary_conflict_13");

        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: {
                ...learned(1900),
                windowCenteringRule: "missing_adjacent_mode_recenter",
            },
            independentWindow: independent(1900, 9),
            years,
            ranks: profileRanks(2),
        })?.rule).toBe("missing_adjacent_mode_13");
    });

    it("uses the median physical profile to finalize every missing-ring short width", () => {
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1900, 9),
            years,
            ranks: profileRanks(4),
        })).toEqual({
            window: { startYear: 1902, endYear: 1910 },
            recommendedWidth: 9,
            rule: "missing_profile_median_9",
        });

        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1902, 5),
            years,
            ranks: profileRanks(1),
            operationEvidence: {
                bestYear: 1904,
                remoteDifferenceMargin: 0.2,
            },
        })).toEqual({
            window: { startYear: 1899, endYear: 1907 },
            recommendedWidth: 9,
            rule: "missing_profile_median_9",
        });
    });

    it("keeps a missing-ring short window when strong side evidence is outside the median", () => {
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1900, 9),
            years,
            ranks: profileRanks(4),
            operationEvidence: {
                bestYear: 1904,
                sideStepBestYear: 1899,
                sideStepRemoteMargin: 0.05,
            },
        })).toBeNull();
    });

    it("keeps a supported mode-mass window when moderate evidence only shifts it newer", () => {
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: learned(1900),
            independentWindow: independent(1900, 9),
            years,
            ranks: profileRanks(4),
            operationEvidence: {
                bestYear: 1904,
                bestDifferenceGain: 0.349,
                sideStepBestYear: 1904,
                sideStepRemoteMargin: 0.1,
            },
        })).toBeNull();
    });

    it("recenters only the selected false-ring family mode", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: {
                ...learned(1900),
                windowCenteringRule: "false_family_mode_consensus",
            },
            independentWindow: independent(1900, 9),
            years,
            ranks: falseProfileRanks(4),
            operationEvidence: {
                bestYear: 1904,
                sideStepBestYear: 1904,
                sideStepRemoteMargin: 0.02,
            },
        })).toEqual({
            window: { startYear: 1902, endYear: 1910 },
            recommendedWidth: 9,
            rule: "false_family_profile_median_9",
        });
    });

    it("keeps a risky false-ring family flank and strong side conflict wide", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: {
                ...learned(1901),
                modeWindow: { startYear: 1898, endYear: 1910 },
                windowCenteringRule: "false_family_mode_consensus",
            },
            independentWindow: independent(1901, 9),
            years,
            ranks: falseProfileRanks(2),
            operationEvidence: {
                bestYear: 1905,
                sideStepBestYear: 1904,
                sideStepRemoteMargin: 0.02,
            },
        })?.rule).toBe("false_family_profile_risk_13");

        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: {
                ...learned(1900),
                windowCenteringRule: "false_counterfactual_mass",
            },
            independentWindow: independent(1900, 9),
            operationEvidence: {
                bestYear: 1904,
                sideStepBestYear: 1915,
                sideStepRemoteMargin: 0.1,
            },
        })?.rule).toBe("false_counterfactual_side_conflict_13");
    });

    it("keeps a physical-profile mode recovery at its calibrated 13 years", () => {
        expect(selectUnitEventShortWindow({
            eventType: "falseRing",
            learnedWindow: {
                ...learned(1898, 13),
                windowCenteringRule: "false_physical_profile_mode",
            },
            independentWindow: independent(1902, 9),
        })?.recommendedWidth).toBe(13);
    });

    it.each([
        "missing_family_profile_mode",
        "missing_anchor_consensus_uncertain_13",
    ] as const)("keeps %s at its calibrated 13 years", (widthSelectionRule) => {
        expect(selectUnitEventShortWindow({
            eventType: "missingRing",
            learnedWindow: {
                ...learned(1898, 13),
                widthSelectionRule,
            },
            independentWindow: independent(1902, 9),
            currentPrimaryYear: 1902,
            operationEvidence: {
                bestYear: 1903,
                sideStepBestYear: 1904,
            },
            years,
            ranks: profileRanks(1),
        })).toBeNull();
    });
});
