/**
 * 候选召回扩展集成测试（文档测试 8/13 精神）。
 * 启用时：HMM 边界 + 区域内锐利 prescan 应在真实缺轮附近产出 insert 候选，并带 bayesianPosterior。
 * fixture 缺失则 skip。
 */
import { describe, expect, it } from "vitest";
import { diagnoseSeriesCore } from "../segments";
import { getConfig } from "../config";
import { makeBayesianRecallDrafts } from "../candidateRecallExpansion";
import {
    buildLeaveOneOutMaster,
    buildSyntheticSite,
    createEndAnchoredMissingRingCase,
    getEligibleSeriesForSyntheticTests,
    groupEligibleSeries,
    loadRdmFixture,
    pickStrongSignalYear,
    sampleAcross,
} from "./rdmFixture";

const fixture = loadRdmFixture();
const d = fixture.available ? describe : describe.skip;

d("makeBayesianRecallDrafts", () => {
    it("缺轮：贝叶斯召回在真值附近产出带后验的 insert 候选（recall）", () => {
        const eligible = getEligibleSeriesForSyntheticTests(fixture.series);
        const longSeries = groupEligibleSeries(eligible).eligibleLongSeries;
        const targets = sampleAcross(longSeries.length >= 5 ? longSeries : eligible, 4).slice(0, 8);
        const config = getConfig({ referenceConfig: null });
        let attempted = 0;
        let recallHit = 0;
        let sawPosterior = false;

        targets.forEach((series) => {
            const loo = buildLeaveOneOutMaster(fixture.series, series.id);
            if (loo.skipped) return;
            const year = pickStrongSignalYear(series, loo.masterValuesByYear);
            if (year === null) return;
            const { corrupted } = createEndAnchoredMissingRingCase(series, year);
            const { site } = buildSyntheticSite(fixture.series, series.id, corrupted);
            if (!site) return;
            const core = diagnoseSeriesCore(site, series.id, config);
            if (!core) return;
            attempted += 1;
            const { drafts } = makeBayesianRecallDrafts(core, config);
            const inserts = drafts.filter((x) => x.operationType === "INSERT_MISSING_RING");
            if (inserts.some((x) => x.bayesianPosterior !== undefined && x.bayesianPosterior > 0)) sawPosterior = true;
            if (inserts.some((x) => Math.abs((x.targetYear ?? 0) - year) <= 3)) recallHit += 1;
        });

        // eslint-disable-next-line no-console
        console.log(`bayes recall: attempted=${attempted} recall±3=${attempted ? (recallHit / attempted).toFixed(2) : "n/a"}`);
        // 机制正确性校验：能产出带 HMM 后验的 insert 候选，且确实有部分落在真值附近。
        // 注：HMM 边界在个体-均值数据上定位偏移较大，召回有限——这是默认关闭并入候选池的原因。
        if (attempted >= 4) {
            expect(sawPosterior).toBe(true);
            expect(recallHit).toBeGreaterThan(0);
        }
    });
});
