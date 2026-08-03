import { describe, expect, it } from "vitest";
import type { CalibratedEventWindowResult } from "../calibratedEventWindow";
import { selectUnitEventShortWindow } from "../unitEventShortWindowSelector";
import type { UnitEventWindowRankerResult } from "../unitEventWindowRanker";

const learned = (
    startYear: number,
    width: 9 | 13 = 9,
): UnitEventWindowRankerResult => ({
    window: { startYear, endYear: startYear + width - 1 },
    modeWindow: { startYear: startYear - 2, endYear: startYear + 10 },
    prePointModeWindow: { startYear: startYear - 2, endYear: startYear + 10 },
    preFalseCurrentAnchorModeWindow: { startYear: startYear - 2, endYear: startYear + 10 },
    preDirectModeWindow: { startYear: startYear - 2, endYear: startYear + 10 },
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
        })).toBeNull();
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

    it("accepts a high-margin false-ring 5-year window with a local side anchor", () => {
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
        })?.recommendedWidth).toBe(5);
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
});
