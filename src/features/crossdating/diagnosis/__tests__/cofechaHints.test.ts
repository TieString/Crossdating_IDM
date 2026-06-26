/**
 * COFECHA hints 解析单元测试（测试 9、10）。
 */
import { describe, expect, it } from "vitest";
import {
    getCofechaEvidenceForYear,
    getCofechaSegmentLagSupport,
    parseCofechaHints,
} from "../cofechaHints";

const SEGMENT_TABLE = `RDM151    1815 to  2023     209 years                                                                                    Series  23
[A] Segment   High   -10   -9   -8   -7   -6   -5   -4   -3   -2   -1   +0   +1   +2   +3   +4   +5   +6   +7   +8   +9  +10

---

1815 1864   -1    .06 -.02  .03  .15 -.22 -.16 -.10 -.05  .03  .71* .15|-.15 -.11 -.13 -.17  .25  .19  .18 -.03 -.11 -.20
1825 1874   -1   -.15  .07  .13  .05 -.25 -.11 -.16 -.07 -.03  .77*-.02|-.01 -.06 -.08 -.01  .07  .17  .07  .10 -.19  .12
1850 1899   -1   -.20  .23  .15 -.16 -.15 -.11 -.18 -.08 -.09  .76*-.02|-.08  .03 -.01  .03 -.04  .17  .12  .04 -.15  .15
1875 1924   -1   -.26  .14  .00 -.24  .02 -.16 -.11  .09  .27  .79* .30| .04  .11 -.15 -.28 -.18 -.13  .21  .05 -.06 -.02`;

const EFFECT_TABLE = `[B] Entire series, effect on correlation (  .380) is:
Lower   1866< -.053   1865> -.035   1884> -.019   1829> -.016   1876> -.013   1824< -.012  Higher   2009  .029   1960  .019
1815 to 1864 segment:
Lower   1829> -.049   1824< -.040   1857> -.031   1850> -.030   1835> -.018   1826> -.014  Higher   1830  .044   1815  .033
1825 to 1874 segment:
Lower   1865> -.085   1866< -.072   1829> -.023   1850> -.019   1857> -.018   1869> -.010  Higher   1830  .041   1864  .025
[C] Year-to-year changes diverging by over 4.0 std deviations:
1829 1830  -5.5 SD    1865 1866  -4.9 SD
[E] Outliers     4   3.0 SD above or -4.5 SD below mean for year
1829 +4.0 SD;    1865 +4.3 SD;    1884 +3.7 SD;    1936 +3.1 SD`;

describe("测试9：COFECHA [A] segment lag table 解析", () => {
    const hints = parseCofechaHints(SEGMENT_TABLE);

    it("解析出 4 个 segment hint，highLag 均为 -1", () => {
        expect(hints.segments).toHaveLength(4);
        hints.segments.forEach((segment) => expect(segment.highLag).toBe(-1));
    });

    it("第一段年份与 starred 值正确", () => {
        const first = hints.segments[0];
        expect(first.startYear).toBe(1815);
        expect(first.endYear).toBe(1864);
        expect(first.starredLag).toBe(-1);
        expect(first.starredR).toBeCloseTo(0.71, 5);
        expect(first.correlationsByLag[-1]).toBeCloseTo(0.71, 5);
        expect(first.correlationsByLag[0]).toBeCloseTo(0.15, 5);
        expect(first.correlationsByLag[1]).toBeCloseTo(-0.15, 5);
    });

    it("segment lag support 对 lag -1 为正", () => {
        expect(getCofechaSegmentLagSupport(hints, 1815, 1864, -1)).toBeGreaterThan(0);
        expect(getCofechaSegmentLagSupport(hints, 1815, 1864, 1)).toBe(0);
    });
});

describe("测试10：COFECHA [B]/[C]/[E] 解析", () => {
    const hints = parseCofechaHints(EFFECT_TABLE);

    it("解析出 effect hints，包含 1865 和 1866", () => {
        const years = hints.effects.map((e) => e.year);
        expect(years).toContain(1865);
        expect(years).toContain(1866);
    });

    it("解析出 year-to-year hints，包含 1865-1866 -4.9 SD", () => {
        const hit = hints.yearToYear.find((e) => e.year1 === 1865 && e.year2 === 1866);
        expect(hit).toBeDefined();
        expect(hit?.sd).toBeCloseTo(-4.9, 5);
    });

    it("解析出 outliers，包含 1865 +4.3 SD", () => {
        const hit = hints.outliers.find((e) => e.year === 1865);
        expect(hit).toBeDefined();
        expect(hit?.sd).toBeCloseTo(4.3, 5);
    });

    it("getCofechaEvidenceForYear(1865) > 0 且 >= 无提示年(1900)", () => {
        const e1865 = getCofechaEvidenceForYear(hints, 1865);
        const e1900 = getCofechaEvidenceForYear(hints, 1900);
        expect(e1865).toBeGreaterThan(0);
        expect(e1900).toBe(0);
        expect(e1865).toBeGreaterThanOrEqual(e1900);
    });

    it("能解析 entire 与 segment 两种 scope 的 effect", () => {
        expect(hints.effects.some((e) => e.scope === "entire")).toBe(true);
        expect(hints.effects.some((e) => e.scope === "segment")).toBe(true);
    });
});
