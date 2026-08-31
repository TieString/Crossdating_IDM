import { describe, expect, it } from "vitest";
import {
    fileCorrelationBandFor,
    hasTargetExcludedReferenceCapacity,
    parseFileCorrelationBandCounts,
} from "../qualityProtocol";

describe("unseen ITRDB quality protocol", () => {
    it("uses the frozen file-level correlation bands", () => {
        expect(fileCorrelationBandFor(0.599)).toBeNull();
        expect(fileCorrelationBandFor(0.6)).toBe("from060To070");
        expect(fileCorrelationBandFor(0.7)).toBe("from070To080");
        expect(fileCorrelationBandFor(0.8)).toBe("atLeast080");
    });

    it("parses exact per-band file quotas", () => {
        expect(parseFileCorrelationBandCounts("17,17,16")).toEqual({
            from060To070: 17,
            from070To080: 17,
            atLeast080: 16,
        });
        expect(parseFileCorrelationBandCounts("")).toBeNull();
        expect(() => parseFileCorrelationBandCounts("17,16")).toThrow();
    });

    it("counts references after excluding the current target", () => {
        expect(hasTargetExcludedReferenceCapacity(6, 5)).toBe(true);
        expect(hasTargetExcludedReferenceCapacity(5, 5)).toBe(false);
    });
});
