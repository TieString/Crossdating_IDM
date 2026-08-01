import { describe, expect, it } from "vitest";
import { cofechaStyleStandardize } from "../../reference";
import { scoreFixedContextTransitions } from "../fixedContextTransition";
import type { SeriesCoreDiagnosis } from "../types";

const sourceSeries = (): Map<number, number> => {
    let state = 0x51f15e;
    const result = new Map<number, number>();
    for (let year = 1700; year <= 1900; year += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        result.set(year, 200 + state % 1800);
    }
    return result;
};

const diagnosisFor = (
    source: Map<number, number>,
    boundaryYear: number,
    olderLag: number,
): SeriesCoreDiagnosis => {
    const target = new Map<number, number>();
    for (let year = 1700; year <= 1900; year += 1) {
        if (olderLag === 1 && year === boundaryYear) {
            target.set(year, 900);
            continue;
        }
        const sourceYear = year <= boundaryYear ? year + olderLag : year;
        const value = source.get(sourceYear);
        if (value !== undefined) target.set(year, value);
    }
    return {
        rawTarget: target,
        targetRange: { startYear: 1700, endYear: 1900 },
        master: {
            data: new Map(
                cofechaStyleStandardize(source).map((point) => [point.year, point.value]),
            ),
        },
    } as SeriesCoreDiagnosis;
};

describe("fixed-context transition scoring", () => {
    it.each([-1, 1, -3, 3])("localizes a persistent lag %s without widening", (lag) => {
        const boundaryYear = 1800;
        const rows = scoreFixedContextTransitions(
            diagnosisFor(sourceSeries(), boundaryYear, lag),
            lag,
        );

        expect(rows.length).toBeGreaterThan(100);
        expect(Math.abs(rows[0].year - boundaryYear)).toBeLessThanOrEqual(
            Math.abs(lag) === 1 ? 1 : 4,
        );
        expect(rows[0].olderAdvantage).toBeGreaterThan(0);
        expect(rows[0].newerAdvantage).toBeGreaterThan(0);
    });
});
