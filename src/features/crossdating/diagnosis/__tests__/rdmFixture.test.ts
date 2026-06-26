/**
 * RDM.rwl fixture parser 与 leave-one-out master 测试。
 * fixture 缺失时整组 skip，但 parser 行为本身通过独立 synthetic 文本验证（见末尾）。
 */
import { describe, expect, it } from "vitest";
import {
    buildLeaveOneOutMaster,
    getEligibleSeriesForSyntheticTests,
    loadRdmFixture,
    parseRwl,
} from "./rdmFixture";

const fixture = loadRdmFixture();
const describeFixture = fixture.available ? describe : describe.skip;

describe("parseRwl 通用解析（不依赖 fixture）", () => {
    it("保留 0 宽度年份，仅 -9999 作为 stop marker", () => {
        const text = [
            "AAA 1990 100 0 120 130",
            "AAA 1994 140 -9999 999",
            "BBB 1990 200 210 220",
        ].join("\n");
        const series = parseRwl(text);
        const a = series.get("AAA");
        expect(a).toBeDefined();
        expect(a?.valuesByYear.get(1991)).toBe(0); // 0 必须保留
        expect(a?.zeroCount).toBe(1);
        expect(a?.startYear).toBe(1990);
        expect(a?.valuesByYear.get(1994)).toBe(140); // -9999 之前的值保留
        expect(a?.endYear).toBe(1994);
        expect(a?.valuesByYear.has(1995)).toBe(false); // -9999 之后不计入
        expect(series.get("BBB")?.length).toBe(3);
    });
});

describeFixture("RDM.rwl fixture 读取", () => {
    it("解析成功且 series 数量充足", () => {
        expect(fixture.series.size).toBeGreaterThanOrEqual(20);
    });

    it("包含 RDM151 与 RDM192（smoke）", () => {
        expect(fixture.series.has("RDM151")).toBe(true);
        expect(fixture.series.has("RDM192")).toBe(true);
    });

    it("所有 seriesId 非空、startYear <= endYear、length > 0", () => {
        fixture.series.forEach((series) => {
            expect(series.id.length).toBeGreaterThan(0);
            expect(series.startYear).toBeLessThanOrEqual(series.endYear);
            expect(series.length).toBeGreaterThan(0);
        });
    });

    it("RDM151 / RDM192 解析范围正确", () => {
        const rdm151 = fixture.series.get("RDM151");
        const rdm192 = fixture.series.get("RDM192");
        expect(rdm151?.startYear).toBe(1814);
        expect(rdm151?.endYear).toBe(2023);
        expect(rdm192?.startYear).toBe(1840);
        expect(rdm192?.endYear).toBe(2023);
    });

    it("至少若干条 series 可用于 synthetic 测试", () => {
        const eligible = getEligibleSeriesForSyntheticTests(fixture.series);
        expect(eligible.length).toBeGreaterThanOrEqual(5);
    });

    it("RDM192 可构建 leave-one-out master", () => {
        const result = buildLeaveOneOutMaster(fixture.series, "RDM192");
        expect(result.skipped).not.toBe(true);
        expect(result.referenceSeriesIds.length).toBeGreaterThanOrEqual(5);
        expect(result.overlapYears.length).toBeGreaterThanOrEqual(80);
        expect(result.referenceSeriesIds).not.toContain("RDM192");
    });
});
