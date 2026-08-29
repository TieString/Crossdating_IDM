import { describe, expect, it } from "vitest";
import { parseCofecha606TucsonWidth } from "../cofecha606F63";

describe("COFECHA 6.06 Tucson F6.3 parsing", () => {
    it("matches captured Microsoft FORTRAN float32 values", () => {
        expect(parseCofecha606TucsonWidth(1010, -9999)).toBe(1.0100001096725464);
        expect(parseCofecha606TucsonWidth(994, -9999)).toBe(0.9939999580383301);
        expect(parseCofecha606TucsonWidth(998, -9999)).toBe(0.9979999661445618);
        expect(parseCofecha606TucsonWidth(1266, -9999)).toBe(1.2660000324249268);
    });

    it("preserves zero as an absent-ring placeholder", () => {
        expect(parseCofecha606TucsonWidth(0, -9999)).toBe(0);
    });
});
