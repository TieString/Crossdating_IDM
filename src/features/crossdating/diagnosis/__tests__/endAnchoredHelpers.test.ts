/**
 * end-anchored 插年/删年 helper 单元测试（section 九）。
 * 重点验证 1865/1866 附近的 off-by-one 正确。
 */
import { describe, expect, it } from "vitest";
import {
    applyEndAnchoredDeleteFalseYear,
    applyEndAnchoredInsertMissingYear,
} from "./rdmFixture";

const base = () => new Map<number, number>([
    [1863, 101],
    [1864, 102],
    [1865, 103],
    [1866, 104],
    [1867, 105],
]);

describe("applyEndAnchoredInsertMissingYear", () => {
    it("在 1865 插入 0：endYear 固定，1865 以前整体偏移，1866/1867 不动", () => {
        const result = applyEndAnchoredInsertMissingYear(base(), 1865, 0);
        expect(result.get(1863)).toBe(102); // 原 1864
        expect(result.get(1864)).toBe(103); // 原 1865
        expect(result.get(1865)).toBe(0);
        expect(result.get(1866)).toBe(104); // 原 1866 不变
        expect(result.get(1867)).toBe(105); // 原 1867 不变
        expect(Math.max(...result.keys())).toBe(1867);
    });
});

describe("applyEndAnchoredDeleteFalseYear", () => {
    it("删除 1865：endYear 固定，1865 及更老向较新偏移一年，最老一年腾出", () => {
        const result = applyEndAnchoredDeleteFalseYear(base(), 1865);
        expect(result.get(1864)).toBe(101); // 原 1863
        expect(result.get(1865)).toBe(102); // 原 1864
        expect(result.get(1866)).toBe(104); // 原 1866 不变
        expect(result.get(1867)).toBe(105); // 原 1867 不变
        expect(result.has(1863)).toBe(false); // 老端缩短一年
        expect(Math.max(...result.keys())).toBe(1867);
    });
});
