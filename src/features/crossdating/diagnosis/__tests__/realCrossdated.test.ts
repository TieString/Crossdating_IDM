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
    applyInsertRestore,
    buildMultiMissingCorrupted,
    buildSyntheticSite,
    dataFoldersAvailable,
    loadDataFolder,
    reconstructMissingFromZero,
    sameSeries,
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

    // 真实工作口径：不筛选——所有含缺轮序列（单缺轮/多缺轮/短序列/端点缺轮）全部纳入，
    // 多缺轮按人工流程逐个处理：每步诊断取首位建议，对当前最靠树皮缺轮判命中，按真值复原后继续向树心。
    it("全部含缺轮序列 迭代逐个复原（含多缺轮/短序列/端点，不筛选）", () => {
        let attempted = 0;
        let skippedNoRef = 0;       // 参考不足无法建 master（物理上无法交叉定年）
        let totalMissing = 0;
        let stepHits = 0;           // 单步命中（±1）累计
        let fullyRestored = 0;      // 全程每步 ±1 命中的序列数
        let reconstructOk = 0;      // 端锚重建/复原自检通过数
        const fracs: number[] = [];
        const tolFully: Record<number, number> = { 1: 0, 2: 0, 3: 0, 5: 0 };
        const byCount = new Map<number, { series: number; missing: number; hits: number; fully: number }>();

        DATA_FOLDERS.forEach((folder) => {
            const data = loadDataFolder(folder);
            if (!data) return;
            const all = Array.from(data.crossdated.values());
            all.forEach((series) => {
                const zeros = zeroYearsOf(series);
                if (zeros.length === 0) return; // 只测含缺轮的；不再筛长度/位置/缺轮数
                const corrupted0 = buildMultiMissingCorrupted(series.valuesByYear, zeros);
                // 唯一物理必需：能建起 master（有足够重叠参考）。门槛放宽以尽量纳入短序列。
                const { site } = buildSyntheticSite(data.crossdated, series.id, corrupted0, { minReferences: 3, minOverlap: 60 });
                if (!site) { skippedNoRef += 1; return; }

                attempted += 1;
                totalMissing += zeros.length;
                const k = zeros.length;
                const bucket = byCount.get(k) ?? { series: 0, missing: 0, hits: 0, fully: 0 };
                bucket.series += 1; bucket.missing += k;

                let corrupted = corrupted0;
                const remaining = [...zeros]; // 升序，每次取最大（最靠树皮）
                let hits = 0;
                let perfect = true;
                const tolPerfect: Record<number, boolean> = { 1: true, 2: true, 3: true, 5: true };

                while (remaining.length > 0) {
                    const zTop = remaining[remaining.length - 1];
                    const stepSite = new Map(site);
                    stepSite.set(series.id, new Map(corrupted));
                    let cands;
                    try {
                        cands = diagnoseCrossdating(stepSite, { referenceConfig: null }).candidates.filter((c) => c.targetTree === series.id);
                    } catch { perfect = false; break; }
                    const t = cands[0];
                    const isInsert = t?.operationType === "INSERT_MISSING_RING";
                    const dist = isInsert ? Math.abs((t.targetYear ?? 0) - zTop) : Infinity;
                    [1, 2, 3, 5].forEach((tol) => { if (dist > tol) tolPerfect[tol] = false; });
                    if (dist <= 1) hits += 1; else perfect = false;
                    corrupted = applyInsertRestore(corrupted, zTop);
                    remaining.pop();
                }

                if (sameSeries(corrupted, series.valuesByYear)) reconstructOk += 1;
                stepHits += hits;
                bucket.hits += hits;
                fracs.push(hits / zeros.length);
                if (perfect) { fullyRestored += 1; bucket.fully += 1; }
                [1, 2, 3, 5].forEach((tol) => { if (tolPerfect[tol]) tolFully[tol] += 1; });
                byCount.set(k, bucket);
            });
        });

        const pct = (n: number, denom: number) => denom ? (n / denom).toFixed(3) : "-";
        const meanFrac = fracs.length ? (fracs.reduce((s, v) => s + v, 0) / fracs.length).toFixed(3) : "-";
        // eslint-disable-next-line no-console
        console.log(`REAL ALL-missing 迭代复原: 序列=${attempted} 缺轮总数=${totalMissing} 参考不足跳过=${skippedNoRef} 自检=${reconstructOk}/${attempted}`);
        // eslint-disable-next-line no-console
        console.log(`  完全复原(全程±1)=${pct(fullyRestored, attempted)} 单步命中(±1)=${pct(stepHits, totalMissing)} 平均每序列复原比例=${meanFrac}`);
        // eslint-disable-next-line no-console
        console.log(`  完全复原多容差: ±1=${pct(tolFully[1], attempted)} ±2=${pct(tolFully[2], attempted)} ±3=${pct(tolFully[3], attempted)} ±5=${pct(tolFully[5], attempted)}`);
        const counts = Array.from(byCount.keys()).sort((a, b) => a - b);
        // eslint-disable-next-line no-console
        console.log(`  按缺轮数: ${counts.map((c) => { const b = byCount.get(c)!; return `${c}个[${b.series}条 单步${pct(b.hits, b.missing)} 全复原${pct(b.fully, b.series)}]`; }).join(" ")}`);

        // 端锚重建/复原逻辑必须自检全过（否则后续命中判定的对齐假设不成立）。
        expect(reconstructOk).toBe(attempted);
        expect(attempted).toBeGreaterThan(0);
    }, 300000);
});
