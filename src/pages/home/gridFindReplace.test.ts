import { describe, expect, it } from "vitest";
import { findGridMatches, replaceGridMatches, replaceSeriesNameLiteral } from "./gridFindReplace";

describe("width-grid find and replace targets", () => {
    const site = new Map([
        ["183011", new Map([[2000, 183011], [2001, 42], [2002, -9999]])],
        ["ABC011", new Map([[2000, 42], [2002, 21], [2003, -9999]])],
    ]);

    it("finds numeric series identifiers as well as exact numeric cells", () => {
        expect(findGridMatches(site, "183011", -9999)).toEqual([
            { kind: "series", tree: "183011" },
            { kind: "cell", tree: "183011", year: 2000, value: 183011, isStopMarker: false },
        ]);
    });

    it("includes every stop-marker cell", () => {
        expect(findGridMatches(site, "-9999", -9999)).toEqual([
            { kind: "cell", tree: "183011", year: 2002, value: -9999, isStopMarker: true },
            { kind: "cell", tree: "ABC011", year: 2003, value: -9999, isStopMarker: true },
        ]);
    });

    it("finds displayed missing gaps and replaces identifier text case-insensitively", () => {
        expect(findGridMatches(site, "missing", -9999)).toContainEqual({
            kind: "cell",
            tree: "ABC011",
            year: 2001,
            value: undefined,
            isStopMarker: false,
        });
        expect(replaceSeriesNameLiteral("AbcABC01", "abc", "Z")).toBe("ZZ01");
    });

    it("renames numeric identifiers and changes all format-wide delimiters atomically", () => {
        const matches = [
            ...findGridMatches(site, "183011", -9999),
            ...findGridMatches(site, "-9999", -9999),
        ];
        const renamed = replaceGridMatches(site, matches.slice(0, 1), "183011", "183099", -9999);
        expect(Array.from(renamed.data.keys())).toEqual(["183099", "ABC011"]);

        const delimiter = replaceGridMatches(site, matches.slice(2), "-9999", "999", -9999);
        expect(delimiter.nextStopMarkerValue).toBe(999);
        expect(Array.from(delimiter.data.values()).map((tree) => {
            const values = Array.from(tree.values());
            return values[values.length - 1];
        })).toEqual([999, 999]);
    });
});
