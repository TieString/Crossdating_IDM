import { describe, expect, it } from "vitest";
import {
    ITRDB_VALIDATION_PROTOCOL,
    itrdbEndpointStratum,
    itrdbEventSpacingStratum,
    itrdbSplitForRelativePath,
    normalizeItrdbRelativePath,
} from "./itrdbValidationProtocol";

describe("ITRDB validation protocol", () => {
    it("assigns a site path to exactly one stable split", () => {
        const paths = [
            "northamerica/usa/co536.rwl",
            "NORTHAMERICA\\USA\\co536.rwl",
            "newz010.rwl",
            "europe/some-site.rwl",
        ];
        const normalized = paths.map(normalizeItrdbRelativePath);
        expect(itrdbSplitForRelativePath(paths[0])).toBe(
            itrdbSplitForRelativePath(paths[1]),
        );
        normalized.forEach((path) => {
            expect(["development", "calibration", "final"]).toContain(
                itrdbSplitForRelativePath(path),
            );
        });
        expect(new Set(ITRDB_VALIDATION_PROTOCOL.splitBuckets.development)).toEqual(
            new Set([0, 1, 2, 3, 4, 5]),
        );
    });

    it("preserves the asymmetric endpoint and event-spacing strata", () => {
        expect(itrdbEndpointStratum(14, 2)).toBe("newer_2_14");
        expect(itrdbEndpointStratum(14, 40)).toBe("older_14_29");
        expect(itrdbEndpointStratum(40, 20)).toBe("newer_15_29");
        expect(itrdbEndpointStratum(40, 40)).toBe("interior_30_plus");
        expect(itrdbEventSpacingStratum([1900])).toBe("single");
        expect(itrdbEventSpacingStratum([1900, 1901])).toBe("adjacent_1");
        expect(itrdbEventSpacingStratum([1900, 1906])).toBe("near_2_10");
        expect(itrdbEventSpacingStratum([1900, 1912, 1940])).toBe(
            "separated_11_plus",
        );
    });
});
