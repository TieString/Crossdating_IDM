/**
 * 真实 RAW/crossdated 验证（专家 ground truth）。
 *
 * crossdated.rwl 里专家插入的 0 宽度年 = 真实确认的缺轮位置。对每条含缺轮的 crossdated 序列，
 * 移除该 0 重建“校正前缺这一环”的序列，针对同站点其它已正确定年的 crossdated 序列做诊断，
 * 检验算法能否把这条真实缺轮召回（top5，人工确认口径）并尽量排到 top1。
 *
 * 这是比合成测试更可信的现实评估：缺轮年是专家实际定出的（多在指针年），跨 8 个站点聚合。
 * 数据缺失则 skip。
 */
import { describe, expect, it } from "vitest";
import { diagnoseCrossdating } from "../engine";
import {
    DATA_FOLDERS,
    buildSyntheticSite,
    dataFoldersAvailable,
    loadDataFolder,
    reconstructMissingFromZero,
    zeroYearsOf,
    type RwlSeries,
} from "./rdmFixture";

const d = dataFoldersAvailable() ? describe : describe.skip;

const overlapWithOthers = (series: RwlSeries, others: RwlSeries[]): number => {
    let count = 0;
    others.forEach((o) => {
        if (o.id === series.id) return;
        let ov = 0;
        series.valuesByYear.forEach((_, y) => { if (o.valuesByYear.has(y)) ov += 1; });
        if (ov >= 80) count += 1;
    });
    return count;
};

d("真实 crossdated 缺轮召回（专家 ground truth）", () => {
    it("跨站点真实缺轮 top5/top1", () => {
        let attempted = 0;
        let top5 = 0;
        let top1 = 0;
        const perFolder: string[] = [];
        const failures: string[] = [];

        DATA_FOLDERS.forEach((folder) => {
            const data = loadDataFolder(folder);
            if (!data) return;
            const all = Array.from(data.crossdated.values());
            let fAtt = 0;
            let fTop5 = 0;
            let fTop1 = 0;

            all.forEach((series) => {
                // 单缺轮、足够长、且有足够同站点参考的序列，作为干净的真实缺轮测试。
                const zeros = zeroYearsOf(series);
                if (zeros.length !== 1) return;
                if (series.length < 120) return;
                const zeroYear = zeros[0];
                // 避开两端 15 年（端点缺轮无法双侧定位）。
                if (zeroYear - series.startYear < 15 || series.endYear - zeroYear < 15) return;
                if (overlapWithOthers(series, all) < 5) return;

                const corrupted = reconstructMissingFromZero(series.valuesByYear, zeroYear);
                const { site } = buildSyntheticSite(data.crossdated, series.id, corrupted, { minReferences: 5, minOverlap: 80 });
                if (!site) return;

                attempted += 1; fAtt += 1;
                const cands = diagnoseCrossdating(site, { referenceConfig: null })
                    .candidates.filter((c) => c.targetTree === series.id);
                const inserts = cands.filter((c) => c.operationType === "INSERT_MISSING_RING");
                const hit5 = inserts.some((c) => Math.abs((c.targetYear ?? 0) - zeroYear) <= 1);
                const hit1 = cands[0]?.operationType === "INSERT_MISSING_RING"
                    && Math.abs((cands[0]?.targetYear ?? 0) - zeroYear) <= 1;
                if (hit5) { top5 += 1; fTop5 += 1; }
                if (hit1) { top1 += 1; fTop1 += 1; }
                if (!hit5) {
                    failures.push(`${series.id}@${zeroYear} top=${cands.slice(0, 3).map((c) => `${c.operationType}@${c.targetYear ?? c.deltaYears}`).join(",")}`);
                }
            });
            if (fAtt > 0) perFolder.push(`${folder}: att=${fAtt} top5=${(fTop5 / fAtt).toFixed(2)} top1=${(fTop1 / fAtt).toFixed(2)}`);
        });

        const top5Rate = attempted ? top5 / attempted : 0;
        const top1Rate = attempted ? top1 / attempted : 0;
        // eslint-disable-next-line no-console
        console.log(`REAL missing (expert ground truth): attempted=${attempted} top5=${top5} (${top5Rate.toFixed(2)}) top1=${top1} (${top1Rate.toFixed(2)})`);
        // eslint-disable-next-line no-console
        console.log(perFolder.join(" | "));
        if (failures.length) console.log(`  failures: ${failures.slice(0, 20).join(" | ")}`);

        // 人工确认口径（COFECHA/CDendro 真实工作方式）：以 top5 召回为主指标——
        // 候选面板展示 top5，测年员秒选确认。实测真实专家缺轮 top5≈0.70、top1≈0.43。
        // 阈值取实测水平作回归护栏（top1 仅记录，不硬断言：真实数据 ±1 自动定位受生物学噪声限制）。
        if (attempted >= 10) {
            expect(top5Rate).toBeGreaterThanOrEqual(0.60);
            expect(top1Rate).toBeGreaterThanOrEqual(0.30);
        }
    });
});
