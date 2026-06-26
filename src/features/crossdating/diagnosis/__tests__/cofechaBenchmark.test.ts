/**
 * 真实 COFECHA 驱动准确率基准（需实时运行 COFECHA 程序，仅在 RUN_COFECHA_BENCH=1 时执行）。
 *
 * 对每条单缺轮 crossdated 序列：移除该 0 重建缺轮序列 → 写成 rwl → 运行 笔记/数据 下的 COFECHA 程序
 * 实时生成 .OUT → 把 .OUT 作为 cofechaText 喂给诊断。对比"有 COFECHA / 无 COFECHA"两种下的
 * 缺轮 top5/top1，量化 COFECHA [A] 段级 lag 驱动是否真正提升真实数据上的召回/准确率。
 *
 * 运行：RUN_COFECHA_BENCH=1 npx vitest run cofechaBenchmark
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { diagnoseCrossdating } from "../engine";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    DATA_FOLDERS,
    buildLeaveOneOutMaster,
    buildSyntheticSite,
    createEndAnchoredFalseRingCase,
    dataFoldersAvailable,
    extractExpertEdits,
    getEligibleSeriesForSyntheticTests,
    groupEligibleSeries,
    loadDataFolder,
    loadRdmFixture,
    pickSafeYear,
    pickStrongSignalYear,
    reconstructMissingFromZero,
    sampleAcross,
    seriesToTreeData,
    zeroYearsOf,
    type RwlSeries,
} from "./rdmFixture";

const dataDir = fileURLToPath(new URL("../../../../../笔记/数据/", import.meta.url));
const exePath = `${dataDir}cofecha-x86_64-pc-windows-msvc.exe`;
const benchRwl = `${dataDir}_bench.rwl`;
const benchOut = `${dataDir}TESTCOF.OUT`;

const enabled = process.env.RUN_COFECHA_BENCH === "1" && dataFoldersAvailable() && existsSync(exePath);
const d = enabled ? describe : describe.skip;

/** 把站点写成 rwl、运行 COFECHA、返回生成的 .OUT 文本（失败返回 null）。 */
const runCofecha = (site: RwlSiteData): string | null => {
    try {
        writeFileSync(benchRwl, formatTucson(site, false), "utf8");
        execFileSync(exePath, [], {
            cwd: dataDir,
            input: "test\n_bench.rwl\n\n\n\n\n\n",
            timeout: 30000,
            stdio: ["pipe", "ignore", "ignore"],
        });
        return existsSync(benchOut) ? readFileSync(benchOut, "utf8") : null;
    } catch {
        return null;
    }
};

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

const near = (year: number | undefined, target: number, tol = 1): boolean => (
    year !== undefined && Math.abs(year - target) <= tol
);

d("COFECHA 驱动真实准确率基准", () => {
    it("缺轮 top5/top1：有 COFECHA vs 无 COFECHA", () => {
        let attempted = 0;
        const base = { top5: 0, top1: 0 };
        const cof = { top5: 0, top1: 0 };
        let rangeContains = 0;
        let rangeCount = 0;
        const widths: number[] = [];
        const lines: string[] = [];

        DATA_FOLDERS.forEach((folder) => {
            const data = loadDataFolder(folder);
            if (!data) return;
            const all = Array.from(data.crossdated.values());
            all.forEach((series) => {
                const zeros = zeroYearsOf(series);
                if (zeros.length !== 1) return;
                if (series.length < 120) return;
                const zeroYear = zeros[0];
                if (zeroYear - series.startYear < 15 || series.endYear - zeroYear < 15) return;
                if (overlapWithOthers(series, all) < 5) return;

                const corrupted = reconstructMissingFromZero(series.valuesByYear, zeroYear);
                const { site } = buildSyntheticSite(data.crossdated, series.id, corrupted, { minReferences: 5, minOverlap: 80 });
                if (!site) return;

                const cofechaText = runCofecha(site);
                if (!cofechaText) return;
                attempted += 1;

                const tally = (cofecha: boolean) => {
                    const cands = diagnoseCrossdating(site, { referenceConfig: null, cofechaText: cofecha ? cofechaText : undefined })
                        .candidates.filter((c) => c.targetTree === series.id);
                    const inserts = cands.filter((c) => c.operationType === "INSERT_MISSING_RING");
                    const hit5 = inserts.some((c) => near(c.targetYear, zeroYear));
                    const hit1 = cands[0]?.operationType === "INSERT_MISSING_RING" && near(cands[0]?.targetYear, zeroYear);
                    const insertRange = inserts.find((c) => c.suggestedRange)?.suggestedRange;
                    return { hit5, hit1, insertRange };
                };

                const b = tally(false);
                const c = tally(true);
                if (b.hit5) base.top5 += 1;
                if (b.hit1) base.top1 += 1;
                if (c.hit5) cof.top5 += 1;
                if (c.hit1) cof.top1 += 1;
                // 缺轮范围标定：COFECHA 下 insert 候选的 suggestedRange 是否含真值、窗宽多少。
                if (c.insertRange) {
                    rangeCount += 1;
                    widths.push(c.insertRange.endYear - c.insertRange.startYear + 1);
                    if (zeroYear >= c.insertRange.startYear - 1 && zeroYear <= c.insertRange.endYear + 1) rangeContains += 1;
                }
                if (b.hit5 !== c.hit5 || b.hit1 !== c.hit1) {
                    lines.push(`${series.id}@${zeroYear}: base(${b.hit5 ? "T5" : "--"}/${b.hit1 ? "T1" : "--"}) cof(${c.hit5 ? "T5" : "--"}/${c.hit1 ? "T1" : "--"})`);
                }
            });
        });

        const pct = (n: number) => attempted ? (n / attempted).toFixed(2) : "-";
        const medWidth = widths.length ? widths.slice().sort((a, b) => a - b)[Math.floor(widths.length / 2)] : 0;
        // eslint-disable-next-line no-console
        console.log(`COFECHA BENCH attempted=${attempted}`);
        // eslint-disable-next-line no-console
        console.log(`  缺轮范围: 有范围 ${rangeCount} 个, 含真值=${rangeCount ? (rangeContains / rangeCount).toFixed(2) : "-"} (${rangeContains}), 中位窗宽=${medWidth}`);
        // eslint-disable-next-line no-console
        console.log(`  无COFECHA: top5=${pct(base.top5)} (${base.top5}) top1=${pct(base.top1)} (${base.top1})`);
        // eslint-disable-next-line no-console
        console.log(`  有COFECHA: top5=${pct(cof.top5)} (${cof.top5}) top1=${pct(cof.top1)} (${cof.top1})`);
        lines.forEach((l) => console.log(`  ${l}`));
    }, 600000);

    it("伪轮 top5/top1：有 COFECHA vs 无 COFECHA（RDM 合成）", () => {
        const fixture = loadRdmFixture();
        if (!fixture.available) return;
        const eligible = getEligibleSeriesForSyntheticTests(fixture.series);
        const groups = groupEligibleSeries(eligible);
        const longSeries = groups.eligibleLongSeries.length >= 5 ? groups.eligibleLongSeries : eligible;
        const targets = sampleAcross(longSeries, 5).slice(0, 12);
        const modes = ["average", "moderate", "splitLike"] as const;

        const markerYearFor = (series: RwlSeries): number | null => {
            const loo = buildLeaveOneOutMaster(fixture.series, series.id);
            if (loo.skipped) return pickSafeYear(series);
            return pickStrongSignalYear(series, loo.masterValuesByYear);
        };

        let attempted = 0;
        const base = { top5: 0, top1: 0 };
        const cof = { top5: 0, top1: 0 };
        const lines: string[] = [];

        targets.forEach((series, index) => {
            const falseYear = markerYearFor(series);
            if (falseYear === null) return;
            const { corrupted } = createEndAnchoredFalseRingCase(series, falseYear, modes[index % modes.length]);
            const { site } = buildSyntheticSite(fixture.series, series.id, corrupted);
            if (!site) return;
            const cofechaText = runCofecha(site);
            if (!cofechaText) return;
            attempted += 1;

            const tally = (cofecha: boolean) => {
                const cands = diagnoseCrossdating(site, { referenceConfig: null, cofechaText: cofecha ? cofechaText : undefined })
                    .candidates.filter((c) => c.targetTree === series.id);
                const deletes = cands.filter((c) => c.operationType === "DELETE_FALSE_RING");
                const hit5 = deletes.some((c) => near(c.targetYear, falseYear));
                const hit1 = cands[0]?.operationType === "DELETE_FALSE_RING" && near(cands[0]?.targetYear, falseYear);
                return { hit5, hit1 };
            };
            const b = tally(false);
            const c = tally(true);
            if (b.hit5) base.top5 += 1;
            if (b.hit1) base.top1 += 1;
            if (c.hit5) cof.top5 += 1;
            if (c.hit1) cof.top1 += 1;
            if (b.hit5 !== c.hit5 || b.hit1 !== c.hit1) {
                lines.push(`${series.id}@${falseYear}: base(${b.hit5 ? "T5" : "--"}/${b.hit1 ? "T1" : "--"}) cof(${c.hit5 ? "T5" : "--"}/${c.hit1 ? "T1" : "--"})`);
            }
        });

        const pct = (n: number) => attempted ? (n / attempted).toFixed(2) : "-";
        // eslint-disable-next-line no-console
        console.log(`COFECHA BENCH FALSE attempted=${attempted}`);
        // eslint-disable-next-line no-console
        console.log(`  无COFECHA: top5=${pct(base.top5)} (${base.top5}) top1=${pct(base.top1)} (${base.top1})`);
        // eslint-disable-next-line no-console
        console.log(`  有COFECHA: top5=${pct(cof.top5)} (${cof.top5}) top1=${pct(cof.top1)} (${cof.top1})`);
        lines.forEach((l) => console.log(`  ${l}`));
    }, 600000);

    it("真实单伪轮：删年候选范围覆盖率 vs 窗宽（RAW vs crossdated 提取）", () => {
        let attempted = 0;
        let top5 = 0;
        let top1 = 0;
        let exact1 = 0;
        let rangeContains = 0;
        const widths: number[] = [];
        const lines: string[] = [];

        DATA_FOLDERS.forEach((folder) => {
            const data = loadDataFolder(folder);
            if (!data) return;
            data.crossdated.forEach((xSeries, id) => {
                const rawSeries = data.raw.get(id);
                if (!rawSeries) return;
                const edits = extractExpertEdits(rawSeries, xSeries);
                // 干净单伪轮：1 个删、0 个插、对齐自检通过、且 span 仅差 1 年（排除整体重定年的伪匹配）。
                if (edits.falseRings.length !== 1 || edits.missingYears.length !== 0 || !edits.reconstructionMatchesRaw) return;
                if (xSeries.startYear !== rawSeries.startYear + 1 || xSeries.endYear !== rawSeries.endYear) return;
                const falseYear = edits.falseRings[0].rawYear;
                if (rawSeries.length < 120) return;
                if (falseYear - rawSeries.startYear < 15 || rawSeries.endYear - falseYear < 15) return;

                // 站点：目标用 RAW（含伪轮），其余参考用 crossdated（已正确定年）。
                const site: RwlSiteData = new Map();
                data.crossdated.forEach((s, sid) => { if (sid !== id) site.set(sid, seriesToTreeData(s)); });
                site.set(id, seriesToTreeData(rawSeries));
                // 至少 5 条重叠参考。
                let refs = 0;
                site.forEach((_, sid) => {
                    if (sid === id) return;
                    let ov = 0;
                    rawSeries.valuesByYear.forEach((__, y) => { if (data.crossdated.get(sid)?.valuesByYear.has(y)) ov += 1; });
                    if (ov >= 80) refs += 1;
                });
                if (refs < 5) return;

                const cofechaText = runCofecha(site);
                if (!cofechaText) return;
                attempted += 1;

                const cands = diagnoseCrossdating(site, { referenceConfig: null, cofechaText })
                    .candidates.filter((c) => c.targetTree === id);
                const deletes = cands.filter((c) => c.operationType === "DELETE_FALSE_RING");
                const hit5 = deletes.some((c) => Math.abs((c.targetYear ?? 0) - falseYear) <= 1);
                if (hit5) top5 += 1;
                const top = cands[0];
                if (top?.operationType === "DELETE_FALSE_RING" && Math.abs((top.targetYear ?? 0) - falseYear) <= 1) top1 += 1;
                if (top?.operationType === "DELETE_FALSE_RING" && (top.targetYear ?? -9999) === falseYear) exact1 += 1;
                // 范围 = 全部删年候选的年份跨度（top5 内）。
                const years = deletes.map((c) => c.targetYear ?? 0).filter((y) => y > 0);
                if (years.length > 0) {
                    const lo = Math.min(...years);
                    const hi = Math.max(...years);
                    const contains = falseYear >= lo - 1 && falseYear <= hi + 1;
                    if (contains) rangeContains += 1;
                    widths.push(hi - lo + 1);
                    lines.push(`${folder}/${id} F@${falseYear}: range=[${lo},${hi}] w=${hi - lo + 1} ${contains ? "✓含" : "✗漏"} nDel=${deletes.length}`);
                } else {
                    lines.push(`${folder}/${id} F@${falseYear}: 无删年候选`);
                }
            });
        });

        const medWidth = widths.length ? widths.slice().sort((a, b) => a - b)[Math.floor(widths.length / 2)] : 0;
        // eslint-disable-next-line no-console
        console.log(`REAL FALSE attempted=${attempted} top1(±1)=${attempted ? (top1 / attempted).toFixed(2) : "-"} (${top1}) exact=${attempted ? (exact1 / attempted).toFixed(2) : "-"} (${exact1}) top5(±1)=${attempted ? (top5 / attempted).toFixed(2) : "-"} (${top5}) 范围含真值=${attempted ? (rangeContains / attempted).toFixed(2) : "-"} (${rangeContains}) 中位窗宽=${medWidth}`);
        lines.forEach((l) => console.log(`  ${l}`));
    }, 600000);
});
