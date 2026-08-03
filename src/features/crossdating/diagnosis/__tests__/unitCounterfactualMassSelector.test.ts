import { describe, expect, it } from "vitest";
import {
    FALSE_RING_COUNTERFACTUAL_PROFILES,
    type FalseRingCoarseCounterfactualRow,
} from "../falseRingCoarseCounterfactual";
import {
    selectFalseRingCounterfactualMassWindow,
} from "../unitCounterfactualMassSelector";

const makeRows = (
    centerYear: number,
    length = 29,
): FalseRingCoarseCounterfactualRow[] => (
    Array.from({ length }, (_, index) => {
        const year = 1926 + index;
        return {
            year,
            profiles: Object.fromEntries(FALSE_RING_COUNTERFACTUAL_PROFILES.map((profile) => [
                profile,
                Math.exp(-Math.pow((year - centerYear) / 2.5, 2)),
            ])) as FalseRingCoarseCounterfactualRow["profiles"],
        };
    })
);

describe("unit counterfactual mass selector", () => {
    it("re-centers one wide false-ring mode when the full curves agree", () => {
        const result = selectFalseRingCounterfactualMassWindow({
            rows: makeRows(1946),
            currentModeWindow: { startYear: 1934, endYear: 1946 },
        });

        expect(result).not.toBeNull();
        expect(result!.centerYear).toBeGreaterThan(1940);
        expect(result!.window.endYear - result!.window.startYear + 1).toBe(13);
        expect(result!.centerDistance).toBeLessThanOrEqual(8);
    });

    it("does not change an already aligned mode", () => {
        expect(selectFalseRingCounterfactualMassWindow({
            rows: makeRows(1940),
            currentModeWindow: { startYear: 1934, endYear: 1946 },
        })).toBeNull();
    });

    it("rejects a remote counterfactual mode", () => {
        expect(selectFalseRingCounterfactualMassWindow({
            rows: makeRows(1956, 45),
            currentModeWindow: { startYear: 1934, endYear: 1946 },
        })).toBeNull();
    });
});
