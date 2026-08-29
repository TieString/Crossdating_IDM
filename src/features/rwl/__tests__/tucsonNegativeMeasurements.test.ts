import { describe, expect, it } from "vitest";
import { parseTucson } from "../parsers/tucson";

const line = (
    id: string,
    year: number,
    values: readonly number[],
) => id.padEnd(8, " ")
    + String(year).padStart(4, " ")
    + values.map((value) => String(value).padStart(6, " ")).join("");

const source = [
    line("NEG001", 2000, [10, -8, 0, 20]),
    line("NEG001", 2004, [999]),
].join("\r\n");

describe("Tucson negative measurement preservation", () => {
    it("keeps the existing default missing-value behavior", () => {
        const result = parseTucson(source, {
            edgeZeros: true,
            header: false,
            stopMarker: 999,
        });
        const tree = result.data.get("NEG001")!;
        expect(tree.get(2000)).toBe(10);
        expect(tree.get(2001)).toBeNull();
        expect(tree.get(2002)).toBe(0);
        expect(tree.get(2004)).toBe(999);
    });

    it("retains negative values only for the exact COFECHA view", () => {
        const result = parseTucson(source, {
            edgeZeros: true,
            header: false,
            stopMarker: 999,
            preserveNegativeMeasurements: true,
        });
        const tree = result.data.get("NEG001")!;
        expect(tree.get(2001)).toBe(-8);
        expect(tree.get(2002)).toBe(0);
        expect(tree.get(2004)).toBe(999);
    });
});
