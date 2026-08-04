import { describe, expect, it } from "vitest";
import {
    passesReferenceRecoveryGate,
    selectReferenceRecoveryEventType,
    type ReferenceRecoveryPeakSummary,
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
