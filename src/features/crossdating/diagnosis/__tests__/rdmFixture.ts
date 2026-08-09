/**
 * RDM.rwl fixture 测试工具。
 *
 * 提供：
 * - 通用 Tucson/RWL parser（保留 0 宽度，仅 -9999 作为 stop marker）；
 * - loadRdmFixture（多优先级路径查找，缺失时标记 available=false 供集成测试 skip）；
 * - eligible series 筛选与分组；
 * - leave-one-out master 构建；
 * - end-anchored 插年/删年 helper（仅用于候选模拟与测试构造）；
 * - 确定性 synthetic corruption 生成器（缺轮/伪轮/整条移动/部分移动）。
 *
 * 这些 helper 不依赖任何绝对路径。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";

export const STOP_MARKER = -9999;

export type RwlSeries = {
    id: string;
    startYear: number;
    endYear: number;
    valuesByYear: Map<number, number>;
    nonZeroCount: number;
    zeroCount: number;
    length: number;
};

/**
 * 解析 Tucson/RWL 文本：
 * 每行 `seriesId decade v1 v2 ...`；-9999 为 stop marker（不进入数据）；
 * 0 是缺轮占位，必须保留，不能当作非法值过滤。
 */
export const parseRwl = (text: string): Map<string, RwlSeries> => {
    const valuesById = new Map<string, Map<number, number>>();

    text.split(/\r?\n/).forEach((rawLine) => {
        const line = rawLine.trim();
        if (line.length === 0) return;
        const tokens = line.split(/\s+/);
        if (tokens.length < 2) return;
        const id = tokens[0];
        const decade = Number(tokens[1]);
        if (!Number.isFinite(decade)) return;

        const map = valuesById.get(id) ?? new Map<number, number>();
        let year = decade;
        for (let i = 2; i < tokens.length; i += 1) {
            const value = Number(tokens[i]);
            if (!Number.isFinite(value)) continue;
            if (value === STOP_MARKER) break;
            map.set(year, value);
            year += 1;
        }
        valuesById.set(id, map);
    });

    const series = new Map<string, RwlSeries>();
    valuesById.forEach((valuesByYear, id) => {
        if (valuesByYear.size === 0) return;
        const years = Array.from(valuesByYear.keys()).sort((a, b) => a - b);
        const startYear = years[0];
        const endYear = years[years.length - 1];
        let zeroCount = 0;
        valuesByYear.forEach((value) => {
            if (value === 0) zeroCount += 1;
        });
        series.set(id, {
            id,
            startYear,
            endYear,
            valuesByYear,
            zeroCount,
            nonZeroCount: valuesByYear.size - zeroCount,
            length: valuesByYear.size,
        });
    });

    return series;
};

const FIXTURE_CANDIDATE_PATHS = [
    fileURLToPath(new URL("../__fixtures__/RDM.rwl", import.meta.url)),
    fileURLToPath(new URL("../../../../../tests/fixtures/RDM.rwl", import.meta.url)),
    fileURLToPath(new URL("../../../../../RDM.rwl", import.meta.url)),
];

export type RdmFixture = {
    available: boolean;
    path?: string;
    series: Map<string, RwlSeries>;
};

export const loadRdmFixture = (): RdmFixture => {
    for (const path of FIXTURE_CANDIDATE_PATHS) {
        if (existsSync(path)) {
            return { available: true, path, series: parseRwl(readFileSync(path, "utf8")) };
        }
    }
    return { available: false, series: new Map() };
};

// ── 真实 RAW / crossdated 数据（笔记/数据/<folder>/）──

export const DATA_FOLDERS = ["EBD", "EBM", "EBU", "RDD", "RDM", "RDU", "ZSD", "ZSL"] as const;

const DATA_DIR_CANDIDATES = [
    process.env.CROSSDATING_TEST_DATA_DIR,
    "D:/软件测试/数据/",
    fileURLToPath(new URL("../../../../../笔记/数据/", import.meta.url)),
    fileURLToPath(new URL("../../../../../notes/data/", import.meta.url)),
].filter((candidate): candidate is string => Boolean(candidate));

const dataDir = (): string | null => {
    for (const dir of DATA_DIR_CANDIDATES) {
        const normalized = dir.endsWith("/") || dir.endsWith("\\") ? dir : `${dir}/`;
        if (existsSync(normalized)) return normalized;
    }
    return null;
};

export type RwlFolderData = {
    folder: string;
    raw: Map<string, RwlSeries>;
    crossdated: Map<string, RwlSeries>;
};

export const loadDataFolder = (folder: string): RwlFolderData | null => {
    const dir = dataDir();
    if (!dir) return null;
    const rawPath = `${dir}${folder}/RAW.rwl`;
    const xPath = `${dir}${folder}/crossdated.rwl`;
    if (!existsSync(rawPath) || !existsSync(xPath)) return null;
    return {
        folder,
        raw: parseRwl(readFileSync(rawPath, "utf8")),
        crossdated: parseRwl(readFileSync(xPath, "utf8")),
    };
};

export const dataFoldersAvailable = (): boolean => dataDir() !== null;

/**
 * 读取站点的 COFECHA 输出文本（<folder>/<name>.OUT，name 默认 RAW）。
 * 生产中每次保存会重新生成同名 .OUT；测试用仓库内已有的真实 COFECHA 输出。
 */
export const loadCofechaOut = (folder: string, name: "RAW" | "crossdated" = "RAW"): string | null => {
    const dir = dataDir();
    if (!dir) return null;
    const outPath = `${dir}${folder}/${name}.OUT`;
    return existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
};

export type ExpertEdits = {
    /** crossdated 中专家插入的缺轮年（0 值年）。 */
    missingYears: number[];
    /** 专家删除的伪轮：crossdated 序列“值的位置”被删，falseValue 为 RAW 中被删的宽度值。 */
    falseRings: Array<{ rawYear: number; falseValue: number }>;
    /** 重建的“校正前”值序列（撤销所有编辑）是否与 RAW 值序列完全一致——用于自检对齐正确性。 */
    reconstructionMatchesRaw: boolean;
};

/**
 * 对比 RAW 与 crossdated，提取专家编辑：crossdated 的 0 = 插入的缺轮；RAW 比 crossdated 多出的宽度值
 * = 被删除的伪轮。用 LCS 对齐 RAW 值序列与 crossdated 的非零值序列（后者是前者删去伪轮后的子序列）：
 * 未匹配的 RAW 项即被删伪轮，其 RAW 年份即伪轮所在年（RAW 帧；较近年份的编辑导致的偏移已由对齐吸收）。
 * reconstructionMatchesRaw 自检：crossdated 非零值（按序）+ 被删伪轮 应能还原出 RAW 值序列。
 */
export const extractExpertEdits = (raw: RwlSeries, crossdated: RwlSeries): ExpertEdits => {
    const rawEntries = Array.from(raw.valuesByYear.entries())
        .filter(([, v]) => v !== STOP_MARKER).sort((a, b) => a[0] - b[0]);
    const xEntries = Array.from(crossdated.valuesByYear.entries())
        .filter(([, v]) => v !== STOP_MARKER).sort((a, b) => a[0] - b[0]);
    const missingYears = xEntries.filter(([, v]) => v === 0).map(([y]) => y);
    const xNonZero = xEntries.filter(([, v]) => v !== 0);

    // LCS（值相等）between rawEntries 与 xNonZero。
    const n = rawEntries.length;
    const m = xNonZero.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i += 1) {
        for (let j = 1; j <= m; j += 1) {
            dp[i][j] = rawEntries[i - 1][1] === xNonZero[j - 1][1]
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    // 回溯：未匹配的 RAW 项即被删伪轮。
    const matchedRaw = new Array(n).fill(false);
    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
        if (rawEntries[i - 1][1] === xNonZero[j - 1][1] && dp[i][j] === dp[i - 1][j - 1] + 1) {
            matchedRaw[i - 1] = true;
            i -= 1;
            j -= 1;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    const falseRings = rawEntries
        .filter((_, idx) => !matchedRaw[idx])
        .map(([rawYear, falseValue]) => ({ rawYear, falseValue }));

    // 自检：所有 xNonZero 都应被匹配（dp[n][m] === m）。
    const reconstructionMatchesRaw = dp[n][m] === m;
    return { missingYears, falseRings, reconstructionMatchesRaw };
};

/**
 * 端锚移除一个缺轮 0（专家在 crossdated 里插入的真实缺轮位置的逆操作）：
 * 删除 zeroYear 处的 0，较老一侧整体向较新偏移一年，endYear 不变。
 * 得到“专家校正前、缺这一环”的真实缺轮序列；正确修复应是 insert at zeroYear。
 */
export const reconstructMissingFromZero = (
    valuesByYear: Map<number, number>,
    zeroYear: number,
): Map<number, number> => {
    const result = new Map<number, number>();
    valuesByYear.forEach((v, y) => {
        if (y === zeroYear) return;
        if (y > zeroYear) result.set(y, v);
        else result.set(y + 1, v);
    });
    return result;
};

/**
 * 多缺轮端锚重建：把指定的 n 个 0 从真实序列移除，得到"专家校正前、缺 n 环"的原始测量。
 * endYear（树皮端）固定；某真实年份 y 的值，其上方（更新一侧）每有一个缺轮就把它向树皮顶一年，
 * 故当前年份 = y + (#zeros > y)。结果年份仍连续，长度 = 非零值个数。是逐个 reconstructMissingFromZero 的净效果。
 */
export const buildMultiMissingCorrupted = (
    valuesByYear: Map<number, number>,
    zeros: number[],
): Map<number, number> => {
    const corrupted = new Map<number, number>();
    const removedZeros = new Set(zeros);
    valuesByYear.forEach((v, y) => {
        if (removedZeros.has(y)) return;
        const above = zeros.reduce((n, z) => n + (z > y ? 1 : 0), 0);
        corrupted.set(y + above, v);
    });
    return corrupted;
};

/**
 * 端锚复原一处缺轮（reconstructMissingFromZero 的逆）：在 insertYear 处插 0，
 * insertYear 及更老一侧整体下移一年回到正确年份，endYear 不变，老端补回一年。
 * 多缺轮"逐个从树皮向树心复原"时，每步用当前最靠树皮缺轮年调用。
 */
export const applyInsertRestore = (
    corrupted: Map<number, number>,
    insertYear: number,
): Map<number, number> => {
    const result = new Map<number, number>();
    result.set(insertYear, 0);
    corrupted.forEach((v, y) => {
        if (y > insertYear) result.set(y, v);
        else result.set(y - 1, v);
    });
    return result;
};

/** 两个 year→value Map 是否完全一致（自检端锚重建/复原逻辑）。 */
export const sameSeries = (a: Map<number, number>, b: Map<number, number>): boolean => {
    if (a.size !== b.size) return false;
    for (const [y, v] of a) { if (b.get(y) !== v) return false; }
    return true;
};

/**
 * 取一条 crossdated 序列里所有 0 宽度年（专家确认的真实缺轮年）。
 */
export const zeroYearsOf = (series: RwlSeries): number[] => {
    const years: number[] = [];
    series.valuesByYear.forEach((v, y) => { if (v === 0) years.push(y); });
    return years.sort((a, b) => a - b);
};

export const seriesToTreeData = (series: RwlSeries): RwlTreeData => new Map(series.valuesByYear);

export const valuesToTreeData = (valuesByYear: Map<number, number>): RwlTreeData => new Map(valuesByYear);

// ── eligible 筛选 ──

export type EligibleOptions = {
    minLength?: number;
    minNonZero?: number;
    minSpan?: number;
};

export const getEligibleSeriesForSyntheticTests = (
    seriesMap: Map<string, RwlSeries>,
    options: EligibleOptions = {},
): RwlSeries[] => {
    const minLength = options.minLength ?? 100;
    const minNonZero = options.minNonZero ?? 80;
    const minSpan = options.minSpan ?? 100;
    return Array.from(seriesMap.values())
        .filter((series) => (
            series.length >= minLength
            && series.nonZeroCount >= minNonZero
            && series.endYear - series.startYear + 1 >= minSpan
        ))
        .sort((a, b) => a.id.localeCompare(b.id));
};

export const groupEligibleSeries = (eligible: RwlSeries[]) => ({
    eligibleLongSeries: eligible.filter((series) => series.length >= 150),
    eligibleMediumSeries: eligible.filter((series) => series.length >= 100 && series.length <= 149),
    eligibleWithZeros: eligible.filter((series) => series.zeroCount > 0),
    eligibleWithoutManyZeros: eligible.filter((series) => series.zeroCount <= 3),
});

/**
 * 从头/中/尾各取若干条，避免只测第一条。
 */
export const sampleAcross = <T>(items: T[], perBucket: number): T[] => {
    if (items.length <= perBucket * 3) return [...items];
    const head = items.slice(0, perBucket);
    const midStart = Math.floor(items.length / 2 - perBucket / 2);
    const mid = items.slice(midStart, midStart + perBucket);
    const tail = items.slice(items.length - perBucket);
    const seen = new Set<T>();
    return [...head, ...mid, ...tail].filter((item) => {
        if (seen.has(item)) return false;
        seen.add(item);
        return true;
    });
};

// ── leave-one-out master ──

export type FixtureMasterBuildResult = {
    targetId: string;
    referenceSeriesIds: string[];
    masterValuesByYear: Map<number, number>;
    overlapYears: number[];
    skipped?: boolean;
    skipReason?: string;
};

const zScore = (valuesByYear: Map<number, number>): Map<number, number> => {
    const values = Array.from(valuesByYear.values());
    if (values.length === 0) return new Map();
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const sd = Math.sqrt(variance);
    if (!Number.isFinite(sd) || sd === 0) {
        return new Map(Array.from(valuesByYear.keys()).map((y) => [y, 0]));
    }
    return new Map(Array.from(valuesByYear.entries()).map(([y, v]) => [y, (v - mean) / sd]));
};

const overlapCount = (a: RwlSeries, b: RwlSeries): number => {
    let count = 0;
    a.valuesByYear.forEach((_, year) => {
        if (b.valuesByYear.has(year)) count += 1;
    });
    return count;
};

export type LeaveOneOutOptions = {
    minReferences?: number;
    minOverlap?: number;
    maxReferences?: number;
};

export const buildLeaveOneOutMaster = (
    seriesMap: Map<string, RwlSeries>,
    targetId: string,
    options: LeaveOneOutOptions = {},
): FixtureMasterBuildResult => {
    const minReferences = options.minReferences ?? 5;
    const minOverlap = options.minOverlap ?? 80;
    const target = seriesMap.get(targetId);
    if (!target) {
        return {
            targetId,
            referenceSeriesIds: [],
            masterValuesByYear: new Map(),
            overlapYears: [],
            skipped: true,
            skipReason: `target ${targetId} not found`,
        };
    }

    const references = Array.from(seriesMap.values())
        .filter((series) => series.id !== targetId && overlapCount(series, target) >= minOverlap);

    if (references.length < minReferences) {
        return {
            targetId,
            referenceSeriesIds: references.map((s) => s.id),
            masterValuesByYear: new Map(),
            overlapYears: [],
            skipped: true,
            skipReason: `only ${references.length} reference series overlap >= ${minOverlap} years (need ${minReferences})`,
        };
    }

    const accum = new Map<number, number[]>();
    references.forEach((series) => {
        zScore(series.valuesByYear).forEach((value, year) => {
            const bucket = accum.get(year) ?? [];
            bucket.push(value);
            accum.set(year, bucket);
        });
    });

    const masterValuesByYear = new Map<number, number>();
    accum.forEach((bucket, year) => {
        masterValuesByYear.set(year, bucket.reduce((sum, v) => sum + v, 0) / bucket.length);
    });

    const overlapYears = Array.from(target.valuesByYear.keys())
        .filter((year) => masterValuesByYear.has(year))
        .sort((a, b) => a - b);

    return {
        targetId,
        referenceSeriesIds: references.map((s) => s.id),
        masterValuesByYear,
        overlapYears,
    };
};

/**
 * 构建 synthetic 评估用 siteData：corrupted target + 所有与原始 target 充分重叠的参考序列。
 * referenceConfig 传 null 时，诊断引擎会用其余所有序列做 master（leave-one-out）。
 */
export const buildSyntheticSite = (
    seriesMap: Map<string, RwlSeries>,
    targetId: string,
    corruptedValuesByYear: Map<number, number>,
    options: LeaveOneOutOptions = {},
): { site: RwlSiteData | null; referenceIds: string[]; skipReason?: string } => {
    const minReferences = options.minReferences ?? 5;
    const minOverlap = options.minOverlap ?? 80;
    const target = seriesMap.get(targetId);
    if (!target) return { site: null, referenceIds: [], skipReason: "target not found" };

    const maxReferences = options.maxReferences ?? 24;
    const references = Array.from(seriesMap.values())
        .filter((series) => series.id !== targetId && overlapCount(series, target) >= minOverlap)
        .sort((a, b) => overlapCount(b, target) - overlapCount(a, target))
        .slice(0, maxReferences);
    if (references.length < minReferences) {
        return { site: null, referenceIds: [], skipReason: `only ${references.length} eligible references` };
    }

    const site: RwlSiteData = new Map();
    references.forEach((series) => site.set(series.id, seriesToTreeData(series)));
    site.set(targetId, valuesToTreeData(corruptedValuesByYear));
    return { site, referenceIds: references.map((s) => s.id) };
};

// ── end-anchored 编辑 helper（仅用于候选模拟/测试构造）──

/**
 * end-anchored 插入缺轮：endYear 固定，insertYear 落在较老年份中，
 * insertYear 以前的值整体向较老年份偏移一年，insertYear 处放入新值（默认 0）。
 * 最老一年的值被挤出（保持序列长度不变、endYear 不动）。
 */
export const applyEndAnchoredInsertMissingYear = (
    valuesByYear: Map<number, number>,
    insertYear: number,
    value = 0,
): Map<number, number> => {
    const years = Array.from(valuesByYear.keys()).sort((a, b) => a - b);
    if (years.length === 0) return new Map();
    const startYear = years[0];
    const endYear = years[years.length - 1];
    const result = new Map<number, number>();
    for (let year = startYear; year <= endYear; year += 1) {
        if (year < insertYear) {
            const v = valuesByYear.get(year + 1);
            if (v !== undefined) result.set(year, v);
        } else if (year === insertYear) {
            result.set(year, value);
        } else {
            const v = valuesByYear.get(year);
            if (v !== undefined) result.set(year, v);
        }
    }
    return result;
};

/**
 * end-anchored 删除伪轮：endYear 固定，删除 deleteYear 处的值，
 * deleteYear 及更老的值整体向较新年份偏移一年，最老一年被腾出（序列在老端缩短一年）。
 */
export const applyEndAnchoredDeleteFalseYear = (
    valuesByYear: Map<number, number>,
    deleteYear: number,
): Map<number, number> => {
    const years = Array.from(valuesByYear.keys()).sort((a, b) => a - b);
    if (years.length === 0) return new Map();
    const startYear = years[0];
    const endYear = years[years.length - 1];
    const result = new Map<number, number>();
    for (let year = startYear + 1; year <= endYear; year += 1) {
        if (year > deleteYear) {
            const v = valuesByYear.get(year);
            if (v !== undefined) result.set(year, v);
        } else {
            const v = valuesByYear.get(year - 1);
            if (v !== undefined) result.set(year, v);
        }
    }
    return result;
};

// ── synthetic corruption 生成器（确定性）──

export type MissingRingCase = {
    targetId: string;
    missingYear: number;
    corrupted: Map<number, number>;
};

/**
 * 制造 end-anchored 缺轮 target：删除 missingYear 处的真实环，
 * 较老一侧的值整体向较新年份移动一年（=较老一侧 bestLag -1），endYear 固定。
 */
export const createEndAnchoredMissingRingCase = (
    series: RwlSeries,
    missingYear: number,
): MissingRingCase => {
    const correct = series.valuesByYear;
    const corrupted = new Map<number, number>();
    for (let year = series.startYear + 1; year <= series.endYear; year += 1) {
        const value = year > missingYear ? correct.get(year) : correct.get(year - 1);
        if (value !== undefined) corrupted.set(year, value);
    }
    return { targetId: series.id, missingYear, corrupted };
};

export type FalseRingMode = "average" | "moderate" | "splitLike";

export type FalseRingCase = {
    targetId: string;
    falseYear: number;
    falseValue: number;
    mode: FalseRingMode;
    corrupted: Map<number, number>;
};

const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const splitFalseRingParts = (
    sourceValue: number,
): { falseValue: number; retainedValue: number } => {
    const normalized = Math.max(1, Math.round(sourceValue));
    const falseValue = normalized <= 1
        ? 1
        : Math.max(1, Math.min(normalized - 1, Math.round(normalized * 0.45)));
    return {
        falseValue,
        retainedValue: Math.max(0, normalized - falseValue),
    };
};

/**
 * 制造 end-anchored 伪轮 target：在 falseYear 处插入一个额外环（非极端值），
 * 较老一侧的值整体向较老年份偏移一年（=较老一侧 bestLag +1），endYear 固定。
 *
 * falseValue 不取极端小值，提供三种模式：
 * - average：左右邻居平均
 * - moderate：局部中位数
 * - splitLike：把 falseYear 附近的一个正常值“掰成两个较小值”，但合计接近原值
 */
export const createEndAnchoredFalseRingCase = (
    series: RwlSeries,
    falseYear: number,
    mode: FalseRingMode = "average",
): FalseRingCase => {
    const correct = series.valuesByYear;
    const left = correct.get(falseYear - 1) ?? correct.get(falseYear) ?? 0;
    const right = correct.get(falseYear + 1) ?? correct.get(falseYear) ?? 0;
    const neighborhood: number[] = [];
    for (let y = falseYear - 3; y <= falseYear + 3; y += 1) {
        const v = correct.get(y);
        if (v !== undefined) neighborhood.push(v);
    }

    let falseValue: number;
    let splitRemainderValue: number | null = null;
    if (mode === "average") {
        falseValue = Math.round((left + right) / 2);
    } else if (mode === "moderate") {
        falseValue = Math.round(median(neighborhood));
    } else {
        const localMean = neighborhood.length
            ? neighborhood.reduce((sum, value) => sum + value, 0) / neighborhood.length
            : (left + right) / 2;
        const split = splitFalseRingParts(correct.get(falseYear) ?? localMean);
        falseValue = split.falseValue;
        splitRemainderValue = split.retainedValue;
    }

    const corrupted = new Map<number, number>();
    for (let year = series.startYear - 1; year <= series.endYear; year += 1) {
        if (year > falseYear) {
            const v = correct.get(year);
            if (v !== undefined) corrupted.set(year, v);
        } else if (year === falseYear) {
            corrupted.set(year, falseValue);
        } else if (year === falseYear - 1 && splitRemainderValue !== null) {
            corrupted.set(year, splitRemainderValue);
        } else {
            const v = correct.get(year + 1);
            if (v !== undefined) corrupted.set(year, v);
        }
    }
    return { targetId: series.id, falseYear, falseValue, mode, corrupted };
};

export type WholeMoveCase = {
    targetId: string;
    lag: number;
    corrupted: Map<number, number>;
};

/**
 * 整条移动：保持 values 顺序不变，整体年份偏移 lag（不插 0、不删值）。
 */
export const createWholeSeriesMoveCase = (series: RwlSeries, lag: number): WholeMoveCase => {
    const corrupted = new Map<number, number>();
    series.valuesByYear.forEach((value, year) => corrupted.set(year + lag, value));
    return { targetId: series.id, lag, corrupted };
};

export type PartialMoveCase = {
    targetId: string;
    firstFixedYear: number;
    gapYears: number;
    corrupted: Map<number, number>;
};

export type PiecewiseLagEventSpec = {
    eventType: "missingRing" | "falseRing" | "partialMove";
    year: number;
    /** Correction. For partialMove, `year` is firstFixedYear and shiftYears is <= -2. */
    shiftYears: number;
    falseMode?: FalseRingMode;
};

export type PiecewiseLagMixedCase = {
    targetId: string;
    events: PiecewiseLagEventSpec[];
    wholeSeriesLag: number;
    corrupted: Map<number, number>;
};

const falseValueAt = (
    correct: Map<number, number>,
    sourceYear: number,
    mode: FalseRingMode,
): number => {
    const neighborhood: number[] = [];
    for (let year = sourceYear - 3; year <= sourceYear + 3; year += 1) {
        const value = correct.get(year);
        if (value !== undefined && value > 0) neighborhood.push(value);
    }
    const left = correct.get(sourceYear - 1) ?? correct.get(sourceYear) ?? 1;
    const right = correct.get(sourceYear + 1) ?? correct.get(sourceYear) ?? 1;
    if (mode === "average") return Math.max(1, Math.round((left + right) / 2));
    if (mode === "moderate") return Math.max(1, Math.round(median(neighborhood)));
    const localMean = neighborhood.length
        ? neighborhood.reduce((sum, value) => sum + value, 0) / neighborhood.length
        : (left + right) / 2;
    return splitFalseRingParts(correct.get(sourceYear) ?? localMean).falseValue;
};

/**
 * Build multiple events in one immutable calendar frame.
 *
 * For each displayed year y, `target[y] = correct[y + lag(y)]`. Crossing an event from newer
 * to older adds its corrective shift to lag(y). This avoids sequential insert/delete drift:
 * every supplied event year remains a truth coordinate in the final corrupted series.
 */
export const createPiecewiseLagMixedCase = (
    series: RwlSeries,
    events: PiecewiseLagEventSpec[],
    wholeSeriesLag = 0,
): PiecewiseLagMixedCase => {
    const ordered = [...events].sort((a, b) => b.year - a.year);
    const splitPartsByEventYear = new Map<number, {
        sourceYear: number;
        falseValue: number;
        retainedValue: number;
    }>();
    ordered.forEach((event) => {
        if (event.eventType !== "falseRing" || event.falseMode !== "splitLike") return;
        const active = ordered.filter((candidate) => (
            candidate.eventType === "partialMove"
                ? event.year < candidate.year
                : event.year <= candidate.year
        ));
        const lag = wholeSeriesLag + active.reduce(
            (sum, candidate) => sum + candidate.shiftYears,
            0,
        );
        const sourceYear = event.year + lag - 1;
        const sourceValue = series.valuesByYear.get(sourceYear);
        if (sourceValue === undefined) return;
        splitPartsByEventYear.set(event.year, {
            sourceYear,
            ...splitFalseRingParts(sourceValue),
        });
    });
    const olderSideLag = wholeSeriesLag + ordered.reduce(
        (sum, event) => sum + event.shiftYears,
        0,
    );
    const displayedStartYear = series.startYear - olderSideLag;
    const displayedEndYear = series.endYear - wholeSeriesLag;
    const corrupted = new Map<number, number>();
    for (let year = displayedStartYear; year <= displayedEndYear; year += 1) {
        const active = ordered.filter((event) => (
            event.eventType === "partialMove"
                ? year < event.year
                : year <= event.year
        ));
        const lag = wholeSeriesLag + active.reduce((sum, event) => sum + event.shiftYears, 0);
        const sourceYear = year + lag;
        const falseEvent = active.find((event) => (
            event.eventType === "falseRing" && event.year === year
        ));
        if (falseEvent) {
            const split = splitPartsByEventYear.get(falseEvent.year);
            corrupted.set(
                year,
                split?.falseValue ?? falseValueAt(
                    series.valuesByYear,
                    sourceYear,
                    falseEvent.falseMode ?? "moderate",
                ),
            );
            continue;
        }
        const newerSplit = splitPartsByEventYear.get(year + 1);
        if (newerSplit?.sourceYear === sourceYear) {
            corrupted.set(year, newerSplit.retainedValue);
            continue;
        }
        const value = series.valuesByYear.get(sourceYear);
        if (value !== undefined) corrupted.set(year, value);
    }
    return {
        targetId: series.id,
        events: ordered,
        wholeSeriesLag,
        corrupted,
    };
};

/**
 * Physical unmeasured block: firstFixedYear and newer dates stay correct, while every older
 * displayed value belongs `gapYears` earlier. The correcting partial move is `-gapYears`.
 */
export const createPartialRangeMoveCase = (
    series: RwlSeries,
    firstFixedYear: number,
    gapYears: number,
): PartialMoveCase => {
    if (!Number.isInteger(gapYears) || gapYears < 2) {
        throw new Error("partial missing block must be at least two years");
    }
    const correct = series.valuesByYear;
    const corrupted = new Map<number, number>();
    correct.forEach((value, year) => {
        if (year >= firstFixedYear) {
            corrupted.set(year, value);
        }
    });
    for (let year = series.startYear; year < firstFixedYear; year += 1) {
        const value = correct.get(year - gapYears);
        if (value !== undefined) corrupted.set(year, value);
    }
    return { targetId: series.id, firstFixedYear, gapYears, corrupted };
};

/**
 * 选择一个“marker 年”作为编辑年：在安全范围内挑 master 信号最强（|z| 最大）的年份。
 * 缺/伪轮恰好发生且最易定位在 marker（窄轮/宽轮）年——这与真实交叉定年的指针年思路一致。
 * 提供 master（leave-one-out）时按 |masterZ| 降序挑；否则退回 pickSafeYear。
 */
export const pickMarkerYear = (
    series: RwlSeries,
    master: Map<number, number>,
    preferNarrow = true,
): number | null => {
    const { startYear, endYear } = series;
    const lo = startYear + 20;
    const hi = endYear - 20;
    if (hi <= lo) return null;
    const hasZeroNearby = (year: number): boolean => {
        for (let d = -2; d <= 2; d += 1) {
            if (series.valuesByYear.get(year + d) === 0) return true;
        }
        return false;
    };
    const candidates: Array<{ year: number; strength: number }> = [];
    for (let year = lo; year <= hi; year += 1) {
        if (!series.valuesByYear.has(year)) continue;
        if (hasZeroNearby(year)) continue;
        const m = master.get(year);
        if (m === undefined) continue;
        // 窄轮（z 很负）或宽轮（z 很正）都是强 marker；preferNarrow 时偏向窄轮。
        const strength = preferNarrow ? -m : Math.abs(m);
        candidates.push({ year, strength });
    }
    if (candidates.length === 0) return pickSafeYear(series);
    candidates.sort((a, b) => b.strength - a.strength);
    return candidates[0].year;
};

const windowPearson = (
    target: Map<number, number>,
    master: Map<number, number>,
    start: number,
    end: number,
): number | null => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let y = start; y <= end; y += 1) {
        const t = target.get(y);
        const m = master.get(y);
        if (t === undefined || m === undefined) continue;
        xs.push(t);
        ys.push(m);
    }
    if (xs.length < 15) return null;
    const n = xs.length;
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i += 1) {
        num += (xs[i] - mx) * (ys[i] - my);
        dx += (xs[i] - mx) ** 2;
        dy += (ys[i] - my) ** 2;
    }
    const den = Math.sqrt(dx * dy);
    return den === 0 ? null : num / den;
};

const stableUnsignedHash = (value: string): number => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
};

export type BenchmarkPositionStratum =
    | "olderEdge"
    | "olderInterior"
    | "middle"
    | "newerInterior"
    | "newerEdge";

export type StratifiedCalendarYear = {
    year: number;
    positionStratum: BenchmarkPositionStratum;
    normalizedPosition: number;
    olderContextYears: number;
    newerContextYears: number;
};

export type MixedEventCalendarAnchors = {
    old: number;
    middle: number;
    newer: number;
    adjacent: number;
};

const BENCHMARK_POSITION_STRATA: BenchmarkPositionStratum[] = [
    "olderEdge",
    "olderInterior",
    "middle",
    "newerInterior",
    "newerEdge",
];

/**
 * Pick an existing calendar year without inspecting ring widths or the reference chronology.
 * Bounds may depend on event mechanics, but the selection within them is driven only by `seed`.
 */
export const pickCalendarYearIndependentOfSignal = (
    series: RwlSeries,
    seed: string,
    bounds: { lo: number; hi: number },
): number | null => {
    const lo = Math.max(series.startYear, Math.ceil(bounds.lo));
    const hi = Math.min(series.endYear, Math.floor(bounds.hi));
    if (hi < lo) return null;
    const years: number[] = [];
    for (let year = lo; year <= hi; year += 1) {
        if (series.valuesByYear.has(year)) years.push(year);
    }
    if (years.length === 0) return null;
    return years[stableUnsignedHash(seed) % years.length];
};

/**
 * Deterministic, value-independent benchmark sampling across five calendar-position strata.
 * The index balances strata; the seed randomizes the year within the assigned stratum.
 */
export const pickStratifiedCalendarYear = (
    series: RwlSeries,
    sampleIndex: number,
    seed: string,
    minContextYears = 18,
    asymmetricContext: {
        olderContextYears?: number;
        newerContextYears?: number;
    } = {},
): StratifiedCalendarYear | null => {
    const lo = series.startYear
        + (asymmetricContext.olderContextYears ?? minContextYears);
    const hi = series.endYear
        - (asymmetricContext.newerContextYears ?? minContextYears);
    if (hi < lo) return null;
    const stratumIndex = (
        (Math.floor(sampleIndex) % BENCHMARK_POSITION_STRATA.length)
        + BENCHMARK_POSITION_STRATA.length
    ) % BENCHMARK_POSITION_STRATA.length;
    const availableCount = hi - lo + 1;
    const binLo = lo + Math.floor(availableCount * stratumIndex / BENCHMARK_POSITION_STRATA.length);
    const binHi = stratumIndex === BENCHMARK_POSITION_STRATA.length - 1
        ? hi
        : lo + Math.floor(
            availableCount * (stratumIndex + 1) / BENCHMARK_POSITION_STRATA.length,
        ) - 1;
    const year = pickCalendarYearIndependentOfSignal(series, seed, {
        lo: binLo,
        hi: binHi,
    });
    if (year === null) return null;
    const totalSpan = Math.max(1, series.endYear - series.startYear);
    return {
        year,
        positionStratum: BENCHMARK_POSITION_STRATA[stratumIndex],
        normalizedPosition: (year - series.startYear) / totalSpan,
        olderContextYears: year - series.startYear,
        newerContextYears: series.endYear - year,
    };
};

/**
 * Pick separated and nearby mixed-event anchors without reading ring widths or a reference.
 * The fixed calendar-position bands make mixed cases reproducible while retaining endpoint context.
 */
export const pickMixedEventCalendarAnchors = (
    series: RwlSeries,
    seed: string,
    endpointContextYears = 24,
): MixedEventCalendarAnchors | null => {
    const safeStart = series.startYear + endpointContextYears;
    const safeEnd = series.endYear - endpointContextYears;
    if (safeEnd - safeStart < 54) return null;
    const span = safeEnd - safeStart;
    const old = pickCalendarYearIndependentOfSignal(series, `${seed}:old`, {
        lo: safeStart,
        hi: Math.floor(safeStart + span * 0.24),
    });
    const middle = pickCalendarYearIndependentOfSignal(series, `${seed}:middle`, {
        lo: Math.ceil(safeStart + span * 0.38),
        hi: Math.floor(safeStart + span * 0.52),
    });
    if (old === null || middle === null) return null;
    const adjacent = pickCalendarYearIndependentOfSignal(series, `${seed}:adjacent`, {
        lo: middle + 8,
        hi: middle + 12,
    });
    const newer = pickCalendarYearIndependentOfSignal(series, `${seed}:newer`, {
        lo: Math.max(middle + 20, Math.ceil(safeStart + span * 0.72)),
        hi: safeEnd,
    });
    if (adjacent === null || newer === null) return null;
    if (!(old < middle && middle < adjacent && adjacent < newer)) return null;
    return { old, middle, newer, adjacent };
};

/** Measure local crossdating support after a benchmark year has already been selected. */
export const measureLocalSignalStrength = (
    series: RwlSeries,
    master: Map<number, number>,
    year: number,
    halfWindow = 15,
): number | null => windowPearson(
    series.valuesByYear,
    master,
    year - halfWindow,
    year + halfWindow,
);

/**
 * Exploratory oracle picker: deliberately chooses the easiest high-correlation location.
 *
 * This can estimate an upper bound when local signal is already known to be strong, but it
 * systematically overstates arbitrary-year performance. Never use it for formal accuracy,
 * abstention, false-positive, mixed-event, or holdout reporting.
 */
export const pickExploratoryStrongSignalYear = (
    series: RwlSeries,
    master: Map<number, number>,
    bounds?: { lo: number; hi: number },
): number | null => {
    const { startYear, endYear } = series;
    const lo = bounds ? bounds.lo : startYear + 20;
    const hi = bounds ? bounds.hi : endYear - 20;
    if (hi <= lo) return null;
    const halfWin = 15;
    const hasZeroNearby = (year: number): boolean => {
        for (let d = -2; d <= 2; d += 1) {
            if (series.valuesByYear.get(year + d) === 0) return true;
        }
        return false;
    };
    let bestYear: number | null = null;
    let bestR = -Infinity;
    // z-score target 以与 master 同尺度（master 已是 z-score 均值）。
    const targetZ = (() => {
        const vals = Array.from(series.valuesByYear.values());
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) || 1;
        return new Map(Array.from(series.valuesByYear.entries()).map(([y, v]) => [y, (v - mean) / sd]));
    })();
    for (let year = lo; year <= hi; year += 1) {
        if (!series.valuesByYear.has(year) || hasZeroNearby(year)) continue;
        const r = windowPearson(targetZ, master, year - halfWin, year + halfWin);
        if (r !== null && r > bestR) {
            bestR = r;
            bestYear = year;
        }
    }
    return bestYear ?? pickSafeYear(series);
};

/**
 * 为某条 target 选一个安全的编辑年：避开两端 20 年、避开已有 0 ±2 年、避开缺年。
 */
export const pickSafeYear = (
    series: RwlSeries,
    preferred?: number,
): number | null => {
    const { startYear, endYear } = series;
    const lo = startYear + 20;
    const hi = endYear - 20;
    if (hi <= lo) return null;
    const hasZeroNearby = (year: number): boolean => {
        for (let d = -2; d <= 2; d += 1) {
            if (series.valuesByYear.get(year + d) === 0) return true;
        }
        return false;
    };
    const isUsable = (year: number): boolean => (
        year >= lo
        && year <= hi
        && series.valuesByYear.has(year)
        && !hasZeroNearby(year)
    );
    if (preferred !== undefined && isUsable(preferred)) return preferred;
    const mid = Math.round((lo + hi) / 2);
    for (let offset = 0; offset <= hi - lo; offset += 1) {
        if (isUsable(mid + offset)) return mid + offset;
        if (isUsable(mid - offset)) return mid - offset;
    }
    return null;
};
