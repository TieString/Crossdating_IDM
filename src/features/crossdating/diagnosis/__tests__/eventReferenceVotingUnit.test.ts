import { describe, expect, it } from "vitest";
import {
    passesReferenceRecoveryGate,
    selectReferenceRecoveryEventType,
    type ReferenceRecoveryPeakSummary,
    unitPairDurationBounds,
} from "../eventReferenceVoting";

const peak = (
    eventType: ReferenceRecoveryPeakSummary["eventType"],
    gain: number,
    remoteMargin: number,
): ReferenceRecoveryPeakSummary => ({ eventType, gain, remoteMargin });

describe("selectReferenceRecoveryEventType", () => {
    it("protects a plausible false ring from a low-separation partial winner", () => {
        const partial = peak("partialMove", 0.057, 0.0027);
        const falseRing = peak("falseRing", 0.034, 0.0048);

        expect(selectReferenceRecoveryEventType(
            [partial],
            [partial, falseRing],
        )).toBe("falseRing");
    });

    it("preserves a separated partial winner", () => {
        const partial = peak("partialMove", 0.057, 0.004);
        const falseRing = peak("falseRing", 0.034, 0.0048);

        expect(selectReferenceRecoveryEventType(
            [partial],
            [partial, falseRing],
        )).toBe("partialMove");
    });

    it("does not promote weak or distant false-ring evidence", () => {
        const partial = peak("partialMove", 0.06, 0.002);

        expect(selectReferenceRecoveryEventType(
            [partial],
            [partial, peak("falseRing", 0.019, 0.005)],
        )).toBe("partialMove");
        expect(selectReferenceRecoveryEventType(
            [partial],
            [partial, peak("falseRing", 0.02, 0.005)],
        )).toBe("partialMove");
    });
});

describe("passesReferenceRecoveryGate", () => {
    it("rejects a high-gain partial when the year-by-shift winner is not separated", () => {
        expect(passesReferenceRecoveryGate(
            peak("partialMove", 0.2, 0),
        )).toBe(false);
        expect(passesReferenceRecoveryGate(
            peak("partialMove", 0.0999, 0.02),
        )).toBe(false);
        expect(passesReferenceRecoveryGate(
            peak("partialMove", 0.1, 0.0039),
        )).toBe(false);
        expect(passesReferenceRecoveryGate(
            peak("partialMove", 0.1, 0.004),
        )).toBe(true);
    });
});

describe("unitPairDurationBounds", () => {
    it("keeps the calibrated unhinted and short-pulse search unchanged", () => {
        expect(unitPairDurationBounds()).toEqual({ minimum: 8, maximum: 14 });
        expect(unitPairDurationBounds({
            orientation: "missingThenFalse",
            olderYear: 1900,
            newerYear: 1909,
            maximumDistance: 4,
        })).toEqual({ minimum: 8, maximum: 14 });
    });

    it("expands only a path-hinted long pulse around both uncertain boundaries", () => {
        expect(unitPairDurationBounds({
            orientation: "falseThenMissing",
            olderYear: 1900,
            newerYear: 1921,
            maximumDistance: 4,
        })).toEqual({ minimum: 13, maximum: 29 });
        expect(unitPairDurationBounds({
            orientation: "falseThenMissing",
            olderYear: 1900,
            newerYear: 1990,
            maximumDistance: 4,
        })).toEqual({ minimum: 70, maximum: 70 });
    });
});
