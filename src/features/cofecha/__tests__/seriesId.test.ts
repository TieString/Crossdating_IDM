import { describe, expect, it } from "vitest";
import { extractPossibleProblemsDetail } from "../formatter";
import {
    getCofechaSeriesMapValue,
    hasCofechaSeriesMapValue,
    normalizeCofechaSeriesId,
} from "../seriesId";

describe("COFECHA series id binding", () => {
    it("binds lowercase RWL ids to canonical PART 6 map keys", () => {
        const detail = extractPossibleProblemsDetail(`
            mon131    1575 to  2000     426 years  Series 1
            [A] Segment   High   -10   -9   -8   -7   -6   -5   -4   -3   -2   -1   +0
            1900 1949  10  .01 .02 .03
            =====================================================================
        `);

        expect(normalizeCofechaSeriesId(" mon131 ")).toBe("MON131");
        expect(detail.has("MON131")).toBe(true);
        expect(hasCofechaSeriesMapValue(detail, "mon131")).toBe(true);
        expect(getCofechaSeriesMapValue(detail, "mon131")).toContain("[A] Segment");
        expect(getCofechaSeriesMapValue(new Map([["mon131", "legacy"]]), "MON131")).toBe("legacy");
    });
});
