/**
 * 真实 COFECHA 输出驱动候选生成（集成测试）。
 *
 * 用仓库内真实 COFECHA 输出 笔记/数据/EBD/RAW.OUT（对应 EBD/RAW.rwl）验证：
 * 当提供 cofechaText 时，诊断流程用 [A] 段级 lag 表确定缺/伪轮区域与类型，
 * 在 COFECHA flagged 的区域内产出对应类型的候选（algorithmSource 含 cofecha_segment_lag）。
 * 这是“参考 COFECHA 输出”能力的回归护栏。数据缺失则 skip。
 */
import { describe, expect, it } from "vitest";
import { diagnoseCrossdating } from "../engine";
import {
    getNewestFlaggedCofechaSegment,
    parseCofechaHints,
} from "../cofechaHints";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    dataFoldersAvailable,
    loadCofechaOut,
    loadDataFolder,
    seriesToTreeData,
} from "./rdmFixture";

const hasData = dataFoldersAvailable() && loadCofechaOut("EBD") !== null;
const d = hasData ? describe : describe.skip;

d("COFECHA [A] 驱动候选（EBD 真实输出）", () => {
    it("解析序列级 [A] 并定位最新 flagged 段", () => {
        const out = loadCofechaOut("EBD");
        expect(out).not.toBeNull();
        const hints = parseCofechaHints(out as string);
        // [A] 段应带 seriesId（多序列文本必须区分）。
        expect(hints.segments.length).toBeGreaterThan(0);
        expect(hints.segments.some((s) => s.seriesId !== null)).toBe(true);
        // EBD031 在 RAW.OUT 中四段一致 highLag=-5（缺轮信号），最新 flagged 应判为 insert。
        const ebd031 = getNewestFlaggedCofechaSegment(hints, "EBD031");
        expect(ebd031).not.toBeNull();
        expect(ebd031?.editType).toBe("insert");
    });

    it("提供 cofechaText 时，flagged 序列产出区域内对应类型候选", () => {
        const folder = loadDataFolder("EBD");
        const out = loadCofechaOut("EBD");
        if (!folder || !out) return;
        const site: RwlSiteData = new Map();
        folder.raw.forEach((series, id) => site.set(id, seriesToTreeData(series)));
        const hints = parseCofechaHints(out);

        const withCofecha = diagnoseCrossdating(site, { referenceConfig: null, cofechaText: out });

        // 至少应有若干来自 COFECHA 段级 lag 的候选。
        const cofechaCands = withCofecha.candidates.filter((c) => c.algorithmSource.includes("cofecha_segment_lag"));
        expect(cofechaCands.length).toBeGreaterThan(0);

        // 每个 COFECHA 驱动候选：类型与该序列最新 flagged 段的 lag 符号一致，且落在 flagged 区域附近。
        let inRegionMatched = 0;
        cofechaCands.forEach((c) => {
            const region = getNewestFlaggedCofechaSegment(hints, c.targetTree);
            if (!region) return;
            const expectedOp = region.editType === "insert" ? "INSERT_MISSING_RING" : "DELETE_FALSE_RING";
            const typeOk = c.operationType === expectedOp;
            const y = c.targetYear ?? -9999;
            const inRegion = y >= region.startYear - 5 && y <= region.endYear + Math.ceil(50 / 2) + 5;
            if (typeOk && inRegion) inRegionMatched += 1;
        });
        // 绝大多数 COFECHA 驱动候选应类型正确且落在 flagged 区域内。
        expect(inRegionMatched).toBeGreaterThan(0);
        expect(inRegionMatched).toBeGreaterThanOrEqual(Math.ceil(cofechaCands.length * 0.7));
    });
});
