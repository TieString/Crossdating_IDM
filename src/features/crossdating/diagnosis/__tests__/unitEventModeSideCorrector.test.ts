import { describe, expect, it } from "vitest";
import { shouldKeepDirectModeAgainstSideCorrection } from "../unitEventModeSideCorrector";

describe("unit event mode-side correction", () => {
    it("keeps a direct missing-ring mode when both independent anchors are outside the corrected side", () => {
        expect(shouldKeepDirectModeAgainstSideCorrection({
            eventType: "missingRing",
            centeringRule: "missing_direct_mode_ranker",
            modeWindow: { startYear: 1771, endYear: 1783 },
            currentPrimaryYear: 1759,
            operationBestYear: 1768,
            direction: -1,
        })).toBe(true);
        expect(shouldKeepDirectModeAgainstSideCorrection({
            eventType: "missingRing",
            centeringRule: "missing_direct_mode_ranker",
            modeWindow: { startYear: 1903, endYear: 1915 },
            currentPrimaryYear: 1910,
            operationBestYear: 1906,
            direction: -1,
        })).toBe(false);
    });

    it("does not apply the direct-mode guard to false rings or other mode sources", () => {
        expect(shouldKeepDirectModeAgainstSideCorrection({
            eventType: "falseRing",
            centeringRule: "false_point_mode",
            modeWindow: { startYear: 1771, endYear: 1783 },
            currentPrimaryYear: 1759,
            operationBestYear: 1768,
            direction: -1,
        })).toBe(false);
        expect(shouldKeepDirectModeAgainstSideCorrection({
            eventType: "missingRing",
            centeringRule: "missing_adjacent_mode_recenter",
            modeWindow: { startYear: 1771, endYear: 1783 },
            currentPrimaryYear: 1759,
            operationBestYear: 1768,
            direction: -1,
        })).toBe(false);
    });
});
