/**
 * ITRDB 大规模真实数据缺轮检测基准（gated RUN_ITRDB_BENCH=1）。
 *
 * 国际树轮库（笔记/数据/itrdb/measurements）数据已交叉定年，0 = 真实专家确认的缺轮。
 * 对每条单缺轮序列：移除该 0 重建缺轮序列 → 对同文件其它（已定年）序列诊断 → 看是否在 0 处建议插入。
 * 大规模、多物种/地区，检验"高质量数据上 top1 是否更高"。默认测基线（无 COFECHA）。
 *
 * 运行：RUN_ITRDB_BENCH=1 npx vitest run itrdbBenchmark
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { diagnoseCrossdating } from "../engine";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import { applyInsertRestore, buildMultiMissingCorrupted, reconstructMissingFromZero, sameSeries } from "./rdmFixture";

const ITRDB_DIR = fileURLToPath(new URL("../../../../../笔记/数据/itrdb/measurements/", import.meta.url));
const COF_DIR = fileURLToPath(new URL("../../../../../笔记/数据/", import.meta.url));
const COF_EXE = `${COF_DIR}cofecha-x86_64-pc-windows-msvc.exe`;
// 全量跑（用上全部 ITRDB 文件）远超默认 10 分钟，单个 it 超时按需放大（默认仍 10 分钟）。
const BENCH_TIMEOUT = Number(process.env.ITRDB_TIMEOUT ?? 600000);

const runCofecha = (site: RwlSiteData): string | null => {
    try {
        writeFileSync(`${COF_DIR}_bench.rwl`, formatTucson(site, false), "utf8");
        execFileSync(COF_EXE, [], { cwd: COF_DIR, input: "test\n_bench.rwl\n\n\n\n\n\n", timeout: 30000, stdio: ["pipe", "ignore", "ignore"] });
        return existsSync(`${COF_DIR}TESTCOF.OUT`) ? readFileSync(`${COF_DIR}TESTCOF.OUT`, "utf8") : null;
    } catch { return null; }
};
const STOP_MARKERS = new Set([999, -999, 9990, -9999]);

type Series = { id: string; valuesByYear: Map<number, number>; startYear: number; endYear: number; zeros: number[] };

/** 解析 ITRDB/Tucson 文件：每行 `id decade v...`；999/-9999=停止；0=缺轮（保留）；过滤头部 junk。 */
const parseItrdb = (text: string): Map<string, Series> => {
    const byId = new Map<string, Map<number, number>>();
    text.split(/\r?\n/).forEach((raw) => {
        const line = raw.trimEnd();
        if (!line.trim()) return;
        const tokens = line.trim().split(/\s+/);
        if (tokens.length < 3) return;
        const id = tokens[0];
        const decade = Number(tokens[1]);
        if (!Number.isFinite(decade) || decade < 1000 || decade > 2100) return; // 跳过头部行（小序号）
        const map = byId.get(id) ?? new Map<number, number>();
        let year = decade;
        for (let i = 2; i < tokens.length; i += 1) {
            const v = Number(tokens[i]);
            if (!Number.isFinite(v)) continue;
            if (STOP_MARKERS.has(v)) break;
            if (v < 0) continue;
            map.set(year, v);
            year += 1;
        }
        byId.set(id, map);
    });
    const out = new Map<string, Series>();
    byId.forEach((valuesByYear, id) => {
        if (valuesByYear.size < 30) return;
        const years = Array.from(valuesByYear.keys()).sort((a, b) => a - b);
        const startYear = years[0];
        const endYear = years[years.length - 1];
        if (startYear < 1000 || endYear > 2100) return;
        const zeros = years.filter((y) => valuesByYear.get(y) === 0);
        out.set(id, { id, valuesByYear, startYear, endYear, zeros });
    });
    return out;
};

const collectFiles = (dir: string, acc: string[]) => {
    for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        const st = statSync(full);
        if (st.isDirectory()) collectFiles(full, acc);
        else if (entry.toLowerCase().endsWith(".rwl")) acc.push(full);
    }
};

const overlap = (a: Series, b: Series): number => {
    let n = 0;
    a.valuesByYear.forEach((_, y) => { if (b.valuesByYear.has(y)) n += 1; });
    return n;
};


const enabled = process.env.RUN_ITRDB_BENCH === "1" && existsSync(ITRDB_DIR);
const d = enabled ? describe : describe.skip;

d("ITRDB 大规模缺轮基准", () => {
    it("真实缺轮 top5/top1（基线，无 COFECHA）", () => {
        const allFiles: string[] = [];
        collectFiles(ITRDB_DIR, allFiles);
        allFiles.sort();
        // 跨地区均匀步进采样，限规模。
        const sampleCount = Number(process.env.ITRDB_FILES ?? 200);
        const stride = Math.max(1, Math.floor(allFiles.length / sampleCount));
        const files = allFiles.filter((_, i) => i % stride === 0).slice(0, sampleCount);

        let attempted = 0;
        let top5 = 0;
        let top1 = 0;
        let exact = 0;
        // 不同容差下的 top1（首位建议落在真值 ±tol 内）：区域/段级识别口径。
        const top1Tol: Record<number, number> = { 1: 0, 2: 0, 3: 0, 5: 0 };
        const top5Tol: Record<number, number> = { 1: 0, 2: 0, 3: 0, 5: 0 };
        const maxCasesPerFile = 3;
        const maxCases = Number(process.env.ITRDB_CASES ?? 500);

        for (const file of files) {
            if (attempted >= maxCases) break;
            let parsed: Map<string, Series>;
            try { parsed = parseItrdb(readFileSync(file, "utf8")); } catch { continue; }
            const series = Array.from(parsed.values());
            if (series.length < 6) continue;
            const singleZero = series.filter((s) => (
                s.zeros.length === 1
                && s.valuesByYear.size >= 120
                && s.zeros[0] - s.startYear >= 15
                && s.endYear - s.zeros[0] >= 15
            ));
            let casesThisFile = 0;
            for (const target of singleZero) {
                if (casesThisFile >= maxCasesPerFile || attempted >= maxCases) break;
                const refs = series.filter((s) => s.id !== target.id && overlap(s, target) >= 80);
                if (refs.length < 5) continue;
                const zeroYear = target.zeros[0];
                const corrupted = reconstructMissingFromZero(target.valuesByYear, zeroYear);
                const site: RwlSiteData = new Map();
                series.forEach((s) => { if (s.id !== target.id) site.set(s.id, new Map(s.valuesByYear) as RwlTreeData); });
                site.set(target.id, corrupted as RwlTreeData);

                let cands;
                try {
                    cands = diagnoseCrossdating(site, { referenceConfig: null }).candidates.filter((c) => c.targetTree === target.id);
                } catch { continue; }
                attempted += 1;
                casesThisFile += 1;
                const inserts = cands.filter((c) => c.operationType === "INSERT_MISSING_RING");
                if (inserts.some((c) => Math.abs((c.targetYear ?? 0) - zeroYear) <= 1)) top5 += 1;
                const t = cands[0];
                const topIsInsert = t?.operationType === "INSERT_MISSING_RING";
                const topDist = topIsInsert ? Math.abs((t.targetYear ?? 0) - zeroYear) : Infinity;
                if (topDist <= 1) top1 += 1;
                if (topIsInsert && t.targetYear === zeroYear) exact += 1;
                [1, 2, 3, 5].forEach((tol) => {
                    if (topDist <= tol) top1Tol[tol] += 1;
                    if (inserts.some((c) => Math.abs((c.targetYear ?? 0) - zeroYear) <= tol)) top5Tol[tol] += 1;
                });
            }
        }

        const pct = (n: number) => attempted ? (n / attempted).toFixed(3) : "-";
        // eslint-disable-next-line no-console
        console.log(`ITRDB BASELINE files=${files.length} attempted=${attempted}`);
        // eslint-disable-next-line no-console
        console.log(`  缺轮 top5(±1)=${pct(top5)} (${top5}) top1(±1)=${pct(top1)} (${top1}) exact(±0)=${pct(exact)} (${exact})`);
        // eslint-disable-next-line no-console
        console.log(`  top1 多容差: ±1=${pct(top1Tol[1])} ±2=${pct(top1Tol[2])} ±3=${pct(top1Tol[3])} ±5=${pct(top1Tol[5])}`);
        // eslint-disable-next-line no-console
        console.log(`  top5 多容差: ±1=${pct(top5Tol[1])} ±2=${pct(top5Tol[2])} ±3=${pct(top5Tol[3])} ±5=${pct(top5Tol[5])}`);
    }, BENCH_TIMEOUT);

    it("真实缺轮 top5/top1：有 COFECHA vs 无（ITRDB 子集，需运行 COFECHA）", () => {
        if (!existsSync(COF_EXE)) return;
        const allFiles: string[] = [];
        collectFiles(ITRDB_DIR, allFiles);
        allFiles.sort();
        const stride = Math.max(1, Math.floor(allFiles.length / 120));
        const files = allFiles.filter((_, i) => i % stride === 0);
        const maxCases = Number(process.env.ITRDB_COF_CASES ?? 40);

        let attempted = 0;
        const base = { top5: 0, top1: 0, exact: 0 };
        const cof = { top5: 0, top1: 0, exact: 0 };
        let rangeContains = 0;
        const widths: number[] = [];

        for (const file of files) {
            if (attempted >= maxCases) break;
            let parsed: Map<string, Series>;
            try { parsed = parseItrdb(readFileSync(file, "utf8")); } catch { continue; }
            const series = Array.from(parsed.values());
            if (series.length < 6 || series.length > 40) continue; // 跳过过大文件控制 COFECHA 时间
            const target = series.find((s) => (
                s.zeros.length === 1 && s.valuesByYear.size >= 120
                && s.zeros[0] - s.startYear >= 15 && s.endYear - s.zeros[0] >= 15
                && series.filter((o) => o.id !== s.id && overlap(o, s) >= 80).length >= 5
            ));
            if (!target) continue;
            const zeroYear = target.zeros[0];
            const corrupted = reconstructMissingFromZero(target.valuesByYear, zeroYear);
            const site: RwlSiteData = new Map();
            series.forEach((s) => { if (s.id !== target.id) site.set(s.id, new Map(s.valuesByYear) as RwlTreeData); });
            site.set(target.id, corrupted as RwlTreeData);

            const cofechaText = runCofecha(site);
            if (!cofechaText) continue;
            attempted += 1;

            const tally = (acc: typeof base, useCof: boolean) => {
                let cands;
                try { cands = diagnoseCrossdating(site, { referenceConfig: null, cofechaText: useCof ? cofechaText : undefined }).candidates.filter((c) => c.targetTree === target.id); } catch { return; }
                const inserts = cands.filter((c) => c.operationType === "INSERT_MISSING_RING");
                if (inserts.some((c) => Math.abs((c.targetYear ?? 0) - zeroYear) <= 1)) acc.top5 += 1;
                const t = cands[0];
                if (t?.operationType === "INSERT_MISSING_RING" && Math.abs((t.targetYear ?? 0) - zeroYear) <= 1) acc.top1 += 1;
                if (t?.operationType === "INSERT_MISSING_RING" && t.targetYear === zeroYear) acc.exact += 1;
                if (useCof) {
                    const r = inserts.find((c) => c.suggestedRange)?.suggestedRange;
                    if (r) { widths.push(r.endYear - r.startYear + 1); if (zeroYear >= r.startYear - 1 && zeroYear <= r.endYear + 1) rangeContains += 1; }
                }
            };
            tally(base, false);
            tally(cof, true);
        }

        const pct = (n: number) => attempted ? (n / attempted).toFixed(3) : "-";
        const medW = widths.length ? widths.slice().sort((a, b) => a - b)[Math.floor(widths.length / 2)] : 0;
        // eslint-disable-next-line no-console
        console.log(`ITRDB COFECHA attempted=${attempted}`);
        // eslint-disable-next-line no-console
        console.log(`  无COFECHA: top5=${pct(base.top5)} top1=${pct(base.top1)} exact=${pct(base.exact)}`);
        // eslint-disable-next-line no-console
        console.log(`  有COFECHA: top5=${pct(cof.top5)} top1=${pct(cof.top1)} exact=${pct(cof.exact)}`);
        // eslint-disable-next-line no-console
        console.log(`  范围: 含真值=${widths.length ? (rangeContains / widths.length).toFixed(2) : "-"} 中位窗宽=${medW}`);
    }, BENCH_TIMEOUT);

    it("真实多缺轮 迭代全复原（基线，无 COFECHA）", () => {
        const allFiles: string[] = [];
        collectFiles(ITRDB_DIR, allFiles);
        allFiles.sort();
        const sampleCount = Number(process.env.ITRDB_MULTI_FILES ?? 300);
        const stride = Math.max(1, Math.floor(allFiles.length / sampleCount));
        const files = allFiles.filter((_, i) => i % stride === 0).slice(0, sampleCount);
        const maxCases = Number(process.env.ITRDB_MULTI_CASES ?? 80);
        const maxCasesPerFile = 2;
        const maxK = Number(process.env.ITRDB_MULTI_MAXK ?? 5);

        let attempted = 0;
        let totalMissing = 0;
        let restoredSteps = 0;          // 累计单步命中数（±1）
        let fullyRestored = 0;          // 全程每步都 ±1 命中的 case 数
        let reconstructOk = 0;          // 端锚重建/复原自检通过的 case 数
        const fullyByTol: Record<number, number> = { 1: 0, 2: 0, 3: 0, 5: 0 };
        const fracs: number[] = [];

        for (const file of files) {
            if (attempted >= maxCases) break;
            let parsed: Map<string, Series>;
            try { parsed = parseItrdb(readFileSync(file, "utf8")); } catch { continue; }
            const series = Array.from(parsed.values());
            if (series.length < 6) continue;
            const multi = series.filter((s) => {
                const z = s.zeros;
                return z.length >= 2 && z.length <= maxK
                    && s.valuesByYear.size >= 120
                    && z[0] - s.startYear >= 15
                    && s.endYear - z[z.length - 1] >= 15
                    && z.length / s.valuesByYear.size < 0.1; // 排除 0 占位密度异常的序列
            });
            let casesThisFile = 0;
            for (const target of multi) {
                if (casesThisFile >= maxCasesPerFile || attempted >= maxCases) break;
                const refs = series.filter((s) => s.id !== target.id && overlap(s, target) >= 80);
                if (refs.length < 5) continue;

                const zeros = [...target.zeros].sort((a, b) => a - b);
                let corrupted = buildMultiMissingCorrupted(target.valuesByYear, zeros);
                attempted += 1;
                casesThisFile += 1;
                totalMissing += zeros.length;

                // 从最靠树皮（max）到树心（min）逐个复原。每步在"上方已对齐"的帧里诊断，
                // 期望系统首位建议指向当前剩余缺轮的最大年份；按真值推进以隔离每步定位能力。
                const remaining = [...zeros];
                let stepHits = 0;
                let perfect = true;
                const tolPerfect: Record<number, boolean> = { 1: true, 2: true, 3: true, 5: true };

                while (remaining.length > 0) {
                    const zTop = remaining[remaining.length - 1];
                    const site: RwlSiteData = new Map();
                    series.forEach((s) => { if (s.id !== target.id) site.set(s.id, new Map(s.valuesByYear) as RwlTreeData); });
                    site.set(target.id, new Map(corrupted) as RwlTreeData);

                    let cands;
                    try {
                        cands = diagnoseCrossdating(site, { referenceConfig: null }).candidates.filter((c) => c.targetTree === target.id);
                    } catch { perfect = false; break; }

                    const t = cands[0];
                    const isInsert = t?.operationType === "INSERT_MISSING_RING";
                    const dist = isInsert ? Math.abs((t.targetYear ?? 0) - zTop) : Infinity;
                    [1, 2, 3, 5].forEach((tol) => { if (dist > tol) tolPerfect[tol] = false; });
                    if (dist <= 1) stepHits += 1; else perfect = false;

                    corrupted = applyInsertRestore(corrupted, zTop);
                    remaining.pop();
                }

                if (sameSeries(corrupted, target.valuesByYear)) reconstructOk += 1;
                restoredSteps += stepHits;
                fracs.push(stepHits / zeros.length);
                if (perfect) fullyRestored += 1;
                [1, 2, 3, 5].forEach((tol) => { if (tolPerfect[tol]) fullyByTol[tol] += 1; });
            }
        }

        const pct = (n: number) => attempted ? (n / attempted).toFixed(3) : "-";
        const meanFrac = fracs.length ? (fracs.reduce((s, v) => s + v, 0) / fracs.length).toFixed(3) : "-";
        // eslint-disable-next-line no-console
        console.log(`ITRDB MULTI files=${files.length} attempted=${attempted} 缺轮总数=${totalMissing} 自检通过=${reconstructOk}/${attempted}`);
        // eslint-disable-next-line no-console
        console.log(`  完全复原率(全程±1)=${pct(fullyRestored)} (${fullyRestored})  平均每case复原比例=${meanFrac}  单步命中率(±1)=${totalMissing ? (restoredSteps / totalMissing).toFixed(3) : "-"}`);
        // eslint-disable-next-line no-console
        console.log(`  完全复原率多容差: ±1=${pct(fullyByTol[1])} ±2=${pct(fullyByTol[2])} ±3=${pct(fullyByTol[3])} ±5=${pct(fullyByTol[5])}`);
    }, BENCH_TIMEOUT);

    it("真实多缺轮 迭代全复原：有 COFECHA vs 无（每步跑 COFECHA，对齐树皮优先工作流）", () => {
        if (!existsSync(COF_EXE)) return;
        const allFiles: string[] = [];
        collectFiles(ITRDB_DIR, allFiles);
        allFiles.sort();
        const sampleCount = Number(process.env.ITRDB_MULTI_COF_FILES ?? 150);
        const stride = Math.max(1, Math.floor(allFiles.length / sampleCount));
        const files = allFiles.filter((_, i) => i % stride === 0);
        const maxCases = Number(process.env.ITRDB_MULTI_COF_CASES ?? 30);
        const maxK = Number(process.env.ITRDB_MULTI_MAXK ?? 5);

        type Acc = { steps: number; fully: number; tol: Record<number, number> };
        const mkAcc = (): Acc => ({ steps: 0, fully: 0, tol: { 1: 0, 2: 0, 3: 0, 5: 0 } });
        const base = mkAcc();
        const cof = mkAcc();
        let attempted = 0;
        let totalMissing = 0;
        let reconstructOk = 0;

        // 取某次诊断首位建议相对 zTop 的距离（非 INSERT 记 Infinity）。
        const topDist = (cands: ReturnType<typeof diagnoseCrossdating>["candidates"], zTop: number): number => {
            const t = cands[0];
            return t?.operationType === "INSERT_MISSING_RING" ? Math.abs((t.targetYear ?? 0) - zTop) : Infinity;
        };

        for (const file of files) {
            if (attempted >= maxCases) break;
            let parsed: Map<string, Series>;
            try { parsed = parseItrdb(readFileSync(file, "utf8")); } catch { continue; }
            const series = Array.from(parsed.values());
            if (series.length < 6 || series.length > 40) continue; // 控制 COFECHA 时间
            const multi = series.filter((s) => {
                const z = s.zeros;
                return z.length >= 2 && z.length <= maxK
                    && s.valuesByYear.size >= 120
                    && z[0] - s.startYear >= 15
                    && s.endYear - z[z.length - 1] >= 15
                    && z.length / s.valuesByYear.size < 0.1;
            });
            const target = multi.find((s) => series.filter((o) => o.id !== s.id && overlap(o, s) >= 80).length >= 5);
            if (!target) continue;

            const zeros = [...target.zeros].sort((a, b) => a - b);
            let corrupted = buildMultiMissingCorrupted(target.valuesByYear, zeros);
            attempted += 1;
            totalMissing += zeros.length;

            const remaining = [...zeros];
            let baseHits = 0;
            let cofHits = 0;
            let basePerfect = true;
            let cofPerfect = true;
            const basePerfectTol: Record<number, boolean> = { 1: true, 2: true, 3: true, 5: true };
            const cofPerfectTol: Record<number, boolean> = { 1: true, 2: true, 3: true, 5: true };

            while (remaining.length > 0) {
                const zTop = remaining[remaining.length - 1];
                const site: RwlSiteData = new Map();
                series.forEach((s) => { if (s.id !== target.id) site.set(s.id, new Map(s.valuesByYear) as RwlTreeData); });
                site.set(target.id, new Map(corrupted) as RwlTreeData);

                const cofechaText = runCofecha(site);
                let dBase = Infinity;
                let dCof = Infinity;
                try {
                    dBase = topDist(diagnoseCrossdating(site, { referenceConfig: null }).candidates.filter((c) => c.targetTree === target.id), zTop);
                } catch { basePerfect = false; }
                if (cofechaText) {
                    try {
                        dCof = topDist(diagnoseCrossdating(site, { referenceConfig: null, cofechaText }).candidates.filter((c) => c.targetTree === target.id), zTop);
                    } catch { cofPerfect = false; }
                } else {
                    cofPerfect = false; // 没跑出 COFECHA 这步算未命中
                }

                if (dBase <= 1) baseHits += 1; else basePerfect = false;
                if (dCof <= 1) cofHits += 1; else cofPerfect = false;
                [1, 2, 3, 5].forEach((tol) => {
                    if (dBase > tol) basePerfectTol[tol] = false;
                    if (dCof > tol) cofPerfectTol[tol] = false;
                });

                corrupted = applyInsertRestore(corrupted, zTop);
                remaining.pop();
            }

            if (sameSeries(corrupted, target.valuesByYear)) reconstructOk += 1;
            base.steps += baseHits;
            cof.steps += cofHits;
            if (basePerfect) base.fully += 1;
            if (cofPerfect) cof.fully += 1;
            [1, 2, 3, 5].forEach((tol) => {
                if (basePerfectTol[tol]) base.tol[tol] += 1;
                if (cofPerfectTol[tol]) cof.tol[tol] += 1;
            });
        }

        const pct = (n: number) => attempted ? (n / attempted).toFixed(3) : "-";
        const stepPct = (n: number) => totalMissing ? (n / totalMissing).toFixed(3) : "-";
        // eslint-disable-next-line no-console
        console.log(`ITRDB MULTI-COF attempted=${attempted} 缺轮总数=${totalMissing} 自检通过=${reconstructOk}/${attempted}`);
        // eslint-disable-next-line no-console
        console.log(`  无COFECHA: 完全复原(±1)=${pct(base.fully)} 单步命中(±1)=${stepPct(base.steps)} 完全±2=${pct(base.tol[2])} ±3=${pct(base.tol[3])} ±5=${pct(base.tol[5])}`);
        // eslint-disable-next-line no-console
        console.log(`  有COFECHA: 完全复原(±1)=${pct(cof.fully)} 单步命中(±1)=${stepPct(cof.steps)} 完全±2=${pct(cof.tol[2])} ±3=${pct(cof.tol[3])} ±5=${pct(cof.tol[5])}`);
    }, BENCH_TIMEOUT);
});
