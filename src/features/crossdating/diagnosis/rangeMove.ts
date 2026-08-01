/**
 * 年份范围移动与边界推断工具。
 * 这里负责从异常 lag 推导 selectedRange、missingRange，并细化部分移动的边界。
 */
import { CrossdateConfig } from "./config";
import { runGlobalSlidingMatch } from "./sliding";
import {
    adaptiveImprovementThreshold,
    correlationForSegment,
    filterSeriesByRange,
    getRangeForSeries,
    preprocessSeries,
} from "./series";
import { boundaryAlignmentSharpness, firstDifferenceCorrelation } from "./evaluationMetrics";
import type {
    EffectiveDiagnosisConfig,
    GlobalSlidingMatch,
    NumericSeries,
    PartialRangeMoveEvidence,
    PropagationPattern,
    SegmentDiagnosis,
    SeriesCoreDiagnosis,
    YearRange,
} from "./types";

export const getLagSupportingSegments = (
    segments: SegmentDiagnosis[],
    lag: number,
): SegmentDiagnosis[] => (
    segments.filter((segment) => segment.flag === "B_like" && segment.bestLag === lag)
);

export const getMeanLag = (segments: SegmentDiagnosis[]): number => {
    if (segments.length === 0) return 0;
    return segments.reduce((sum, segment) => sum + segment.bestLag, 0) / segments.length;
};

export const getRepresentativeSegmentForLag = (
    diagnosis: SeriesCoreDiagnosis,
    lag: number,
): SegmentDiagnosis | null => (
    getLagSupportingSegments(diagnosis.segments, lag)
        .sort((a, b) => b.samplePairs - a.samplePairs)[0]
    ?? getSegmentNearYear(diagnosis.segments, diagnosis.targetRange.endYear)
);

const overlapRange = (a: YearRange, b: YearRange): boolean => (
    a.startYear <= b.endYear && b.startYear <= a.endYear
);

export const nearestExistingYear = (
    years: number[],
    targetYear: number,
    minYear: number,
    maxYear: number,
): number | null => {
    let bestYear: number | null = null;
    let bestDistance = Infinity;

    years.forEach((year) => {
        if (year < minYear || year > maxYear) return;
        const distance = Math.abs(year - targetYear);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestYear = year;
        }
    });

    return bestYear;
};

export const getSegmentNearYear = (
    segments: SegmentDiagnosis[],
    year: number,
): SegmentDiagnosis | null => (
    segments.find((segment) => year >= segment.startYear && year <= segment.endYear)
    ?? segments.slice().sort((a, b) => (
        Math.abs(((a.startYear + a.endYear) / 2) - year)
        - Math.abs(((b.startYear + b.endYear) / 2) - year)
    ))[0]
    ?? null
);

export const missingRangeForMove = (
    selectedRange: YearRange,
    deltaYears: number,
): YearRange | undefined => {
    if (deltaYears < 0) {
        return {
            startYear: selectedRange.endYear + deltaYears + 1,
            endYear: selectedRange.endYear,
        };
    }
    if (deltaYears > 0) {
        return {
            startYear: selectedRange.endYear + 1,
            endYear: selectedRange.endYear + deltaYears,
        };
    }
    return undefined;
};

/**
 * 模拟删除一年（end-anchored，匹配 edit.ts deleteYearFromRwl shift="right"）。
 */
const simulateDelete = (series: NumericSeries, deleteYear: number): NumericSeries => {
    const result = new Map<number, number>();
    series.forEach((value, year) => {
        if (year === deleteYear) return;
        const offset = year < deleteYear ? 1 : 0;
        result.set(year + offset, value);
    });
    return result;
};

/**
 * 模拟插入缺轮（end-anchored，匹配 edit.ts insertMissingYearAtSide side="right"）。
 * 数值诊断会把 RWL 中的 0 视为 absent ring，因此这里不把占位 0 加入序列。
 */
const simulateInsert = (series: NumericSeries, insertYear: number): NumericSeries => {
    const result = new Map<number, number>();
    series.forEach((current, year) => {
        if (year <= insertYear) {
            result.set(year - 1, current);
        } else {
            result.set(year, current);
        }
    });
    return result;
};

const masterNarrowBonus = (
    diagnosis: SeriesCoreDiagnosis,
    year: number,
    config: EffectiveDiagnosisConfig,
): number => {
    const masterValue = diagnosis.master.data.get(year);
    if (masterValue === undefined) return 0;
    if (masterValue <= config.strongNarrowYearThreshold) return 2;
    if (masterValue <= config.narrowYearThreshold) return 1;
    return 0;
};

/**
 * 局部 marker 强度：master 在该年比邻域平均窄多少（正值=更窄，是指针/窄轮年）。
 * 比全局窄轮阈值更稳健——能识别“相对邻域明显偏窄”的指针年（缺轮的典型发生处），
 * 即使其绝对值未达全局窄轮阈值。
 */
const localMarkerStrength = (
    master: NumericSeries,
    year: number,
): number => {
    const center = master.get(year);
    if (center === undefined) return 0;
    const neighbors: number[] = [];
    for (let d = -3; d <= 3; d += 1) {
        if (d === 0) continue;
        const v = master.get(year + d);
        if (v !== undefined) neighbors.push(v);
    }
    if (neighbors.length < 3) return 0;
    const mean = neighbors.reduce((s, v) => s + v, 0) / neighbors.length;
    return mean - center;
};

/**
 * COFECHA PART 6 [C] 风格的年际变化异常检测。
 * 在预处理的序列上计算逐年差值，标记超过 threshold 倍标准差的变化涉及的年份。
 */
const findExtremeChangeYears = (
    series: NumericSeries,
    threshold: number = 3.0,
): Map<number, number> => {
    const sorted = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
    if (sorted.length < 10) return new Map();

    // 逐年差值
    const changes: Array<{ year: number; change: number }> = [];
    for (let i = 1; i < sorted.length; i += 1) {
        const [year, value] = sorted[i];
        const [, prevValue] = sorted[i - 1];
        if (year === sorted[i - 1][0] + 1) {
            changes.push({ year, change: value - prevValue });
        }
    }
    if (changes.length < 10) return new Map();

    const changeValues = changes.map((c) => c.change);
    const mean = changeValues.reduce((a, b) => a + b, 0) / changeValues.length;
    const variance = changeValues.reduce((a, b) => a + (b - mean) ** 2, 0) / changeValues.length;
    const sd = Math.sqrt(variance);
    if (sd < 1e-9) return new Map();

    // 标记极端变化涉及的年份，得分 = |change| / sd（归一化强度）。
    const scored = new Map<number, number>();
    changes.forEach(({ year, change }) => {
        const zScore = Math.abs(change - mean) / sd;
        if (zScore >= threshold) {
            scored.set(year, Math.max(scored.get(year) ?? 0, zScore));
            // 也标记前一年（变化的上游）
            const prevYear = year - 1;
            if (series.has(prevYear)) {
                scored.set(prevYear, Math.max(scored.get(prevYear) ?? 0, zScore * 0.8));
            }
        }
    });
    return scored;
};

/**
 * 在给定（已模拟编辑的）序列上做窗口 lag 扫描，统计“残留错位窗口”比例。
 * 复用已有 master（不重建），与主诊断同口径但更快。正确的编辑年会让较老一侧整体对齐，
 * 残留错位窗口趋于 0；错误年份残留一段未对齐区，多个窗口仍偏好非零 lag。
 */
const residualMisalignment = (
    edited: NumericSeries,
    master: NumericSeries,
    config: EffectiveDiagnosisConfig,
): { residual: number; windows: number } => {
    const z = preprocessSeries(edited);
    const range = getRangeForSeries(z);
    if (!range) return { residual: 1, windows: 0 };
    const winLen = 30;
    const step = 12;
    let misaligned = 0;
    let windows = 0;
    for (let start = range.startYear; start + winLen - 1 <= range.endYear; start += step) {
        const end = start + winLen - 1;
        const base = correlationForSegment(z, master, start, end, 0, config.minPairsForCorrelation);
        if (base.correlation === null) continue;
        windows += 1;
        let bestLag = 0;
        let bestR = base.correlation;
        for (let lag = -3; lag <= 3; lag += 1) {
            if (lag === 0) continue;
            const r = correlationForSegment(z, master, start, end, lag, config.minPairsForCorrelation).correlation;
            if (r !== null && r > bestR) {
                bestR = r;
                bestLag = lag;
            }
        }
        const improvement = bestR - (base.correlation ?? -1);
        if (bestLag !== 0 && improvement >= adaptiveImprovementThreshold(base.samplePairs) && bestR >= 0.25) {
            misaligned += 1;
        }
    }
    return { residual: windows > 0 ? misaligned / windows : 1, windows };
};

/**
 * 锚年预扫描（残留错位法 + 一阶差分定位）。
 *
 * 主信号：对每个候选年模拟端锚编辑后，复用 master 重新做窗口 lag 扫描，
 * 统计残留错位窗口比例——正确年份让较老一侧整体对齐、残留趋 0，错误年份残留一段未对齐区。
 * 这与主诊断同口径，比纯相关稳健（不受树轮自相关导致的“偏移一年相关几乎不变”影响）。
 *
 * 次级信号（同残留时打破平台、定位到 ±1）：一阶差分相关高通（对错位一年敏感）、
 * master 窄轮先验（仅插年）、COFECHA [C] 风格年际异常（仅删年）、离传播边界的轻微距离惩罚。
 */
export type EditYearScanEvidence = {
    year: number;
    quality: number;
    residualMisalignment: number;
    boundaryStrength: number;
    localContrast: number;
    boundarySharpness: number;
    markerStrength: number;
    narrowBonus: number;
    anomalyStrength: number;
    boundaryDistance: number;
};

const scoreEditYears = (
    diagnosis: SeriesCoreDiagnosis,
    candidateYears: number[],
    editType: "insert" | "delete",
    config: EffectiveDiagnosisConfig,
    boundaryYear: number,
): EditYearScanEvidence[] => {
    const extremeYears = editType === "delete"
        ? findExtremeChangeYears(preprocessSeries(diagnosis.rawTarget), 3.0)
        : new Map<number, number>();
    const master = diagnosis.master.data;
    const shiftLag = editType === "insert" ? -1 : 1;
    const W = 15;
    const z = preprocessSeries(diagnosis.rawTarget);

    return candidateYears
        .map((year) => {
            const edited = editType === "insert"
                ? simulateInsert(diagnosis.rawTarget, year)
                : simulateDelete(diagnosis.rawTarget, year);
            const { residual } = residualMisalignment(edited, master, config);
            // 一阶差分边界信号（两侧绝对相关 + 偏好对比）：
            const olderShift = firstDifferenceCorrelation(z, master, year - W, year - 1, 6, shiftLag) ?? 0;
            const olderZero = firstDifferenceCorrelation(z, master, year - W, year - 1, 6, 0) ?? 0;
            const newerZero = firstDifferenceCorrelation(z, master, year + 1, year + W, 6, 0) ?? 0;
            const newerShift = firstDifferenceCorrelation(z, master, year + 1, year + W, 6, shiftLag) ?? 0;
            // 边界强度：真实边界处“较老侧在移位 lag 下绝对相关高”且“较新侧在 lag0 下绝对相关高”
            // 两者同时成立才高；较老移位区的杂峰因较新侧实际仍错位、其 lag0 绝对相关低而被压低。
            const boundaryStrength = Math.min(Math.max(0, olderShift), Math.max(0, newerZero));
            // 偏好对比：较老侧偏好移位 + 较新侧偏好 0，用于在平台上精确到 ±1。
            const localContrast = (olderShift - olderZero) + (newerZero - newerShift);
            // 逐点边界分类：比窗口相关在 ±1 处更锐利。insert 用它精确定位；
            // delete 不用（伪轮额外值占一个模糊点，逐点分类反而误导，实测降召回）。
            const split = editType === "insert"
                ? boundaryAlignmentSharpness(z, master, year, shiftLag, W)
                : 0;
            // 缺轮多发于局部窄轮（指针）年：在残留错位平台上，用局部 marker 强度把候选拉到指针年。
            const marker = editType === "insert" ? Math.max(0, localMarkerStrength(master, year)) : 0;
            const narrow = editType === "insert" ? masterNarrowBonus(diagnosis, year, config) : 0;
            const anomaly = editType === "delete" ? (extremeYears.get(year) ?? 0) : 0;
            const boundaryDistance = Math.abs(year - boundaryYear);
            // 残留错位定位粗区段；边界强度/对比/逐点分类在平台上精确到边界年。
            const quality = -residual * 2.5
                + boundaryStrength * 1.8
                + localContrast * 0.5
                + split * 1.5
                + marker * 0.5
                + narrow * 0.2
                + anomaly * 0.05
                - boundaryDistance * 0.001;
            return {
                year,
                quality,
                residualMisalignment: residual,
                boundaryStrength,
                localContrast,
                boundarySharpness: split,
                markerStrength: marker,
                narrowBonus: narrow,
                anomalyStrength: anomaly,
                boundaryDistance,
            };
        })
        .sort((a, b) => b.quality - a.quality)
};

const prescanEditYears = (
    diagnosis: SeriesCoreDiagnosis,
    candidateYears: number[],
    editType: "insert" | "delete",
    config: EffectiveDiagnosisConfig,
    boundaryYear: number,
): number[] => scoreEditYears(
    diagnosis,
    candidateYears,
    editType,
    config,
    boundaryYear,
).map((entry) => entry.year);

export const pickSingleYearAnchor = (
    diagnosis: SeriesCoreDiagnosis,
    pattern: PropagationPattern,
    fallbackYear: number,
    config: EffectiveDiagnosisConfig,
): number => {
    const anchors = pickTopSingleYearAnchors(diagnosis, pattern, fallbackYear, config, 1);
    return anchors[0] ?? fallbackYear;
};

/**
 * 在给定年份区域内用同一锐利预扫描挑 top-N 精确编辑年。
 * 供贝叶斯召回使用：HMM 给出区域，这里给出区域内最锐利的精确年（避免 ±窗口枚举稀释精排）。
 */
export const prescanEditYearsInRegion = (
    diagnosis: SeriesCoreDiagnosis,
    editType: "insert" | "delete",
    regionStart: number,
    regionEnd: number,
    boundaryYear: number,
    config: EffectiveDiagnosisConfig,
    topN: number,
): number[] => {
    const start = Math.max(diagnosis.targetRange.startYear, regionStart);
    const end = Math.min(diagnosis.targetRange.endYear, regionEnd);
    const existingYears = Array.from(diagnosis.rawTarget.keys())
        .filter((year) => year >= start && year <= end);
    if (existingYears.length === 0) return [];
    return prescanEditYears(diagnosis, existingYears, editType, config, boundaryYear).slice(0, topN);
};

export const scoreEditYearsInRegion = (
    diagnosis: SeriesCoreDiagnosis,
    editType: "insert" | "delete",
    regionStart: number,
    regionEnd: number,
    boundaryYear: number,
    config: EffectiveDiagnosisConfig,
): EditYearScanEvidence[] => {
    const start = Math.max(diagnosis.targetRange.startYear, regionStart);
    const end = Math.min(diagnosis.targetRange.endYear, regionEnd);
    const existingYears = Array.from(diagnosis.rawTarget.keys())
        .filter((year) => year >= start && year <= end);
    return scoreEditYears(diagnosis, existingYears, editType, config, boundaryYear);
};

/**
 * 返回多个候选锚年（默认 top 3），交给 evaluateDraft 做精确重诊断排名。
 * 插年与删年统一走 prescanEditYears（模拟端锚编辑 + 整条相关）。
 */
export const pickTopSingleYearAnchors = (
    diagnosis: SeriesCoreDiagnosis,
    pattern: PropagationPattern,
    fallbackYear: number,
    config: EffectiveDiagnosisConfig,
    topN: number = 3,
): number[] => {
    // 搜索窗口覆盖整个受影响（较老）一侧及边界附近余量，确保真实边界年在内。
    // 分段窗口（50 年、步长 25）会让传播边界比真实编辑年保守约半个窗口，
    // 因此向较新方向额外延伸约一个 segmentLength，避免真实年落在搜索窗口之外。
    const searchEndYear = Math.min(
        diagnosis.targetRange.endYear,
        pattern.newerBoundaryYear + config.segmentLength,
    );
    const searchStartYear = Math.max(
        diagnosis.targetRange.startYear,
        pattern.olderBoundaryYear - 2,
    );
    const existingYears = Array.from(diagnosis.rawTarget.keys())
        .filter((year) => year >= searchStartYear && year <= searchEndYear);
    if (existingYears.length === 0) return [fallbackYear];

    const editType = pattern.patternType === "possibleMissingYear"
        ? "insert"
        : pattern.patternType === "possibleFalseYear"
            ? "delete"
            : null;
    if (!editType) return [fallbackYear];

    const ranked = prescanEditYears(
        diagnosis,
        existingYears,
        editType,
        config,
        pattern.newerBoundaryYear,
    );
    return ranked.slice(0, topN);
};

export const runSlidingMatchForRange = (
    diagnosis: SeriesCoreDiagnosis,
    range: YearRange,
    config: EffectiveDiagnosisConfig,
): GlobalSlidingMatch => (
    runGlobalSlidingMatch(
        filterSeriesByRange(preprocessSeries(diagnosis.rawTarget), range),
        diagnosis.master.data,
        {
            seriesId: diagnosis.targetTree,
            lagMin: config.globalLagMin,
            lagMax: config.globalLagMax,
            minOverlap: Math.max(config.minLocalOverlap, CrossdateConfig.localEditAlignment.minLocalOverlap),
        },
    )
);

export const makePartialRangeEvidence = (
    diagnosis: SeriesCoreDiagnosis,
    selectedRange: YearRange,
    deltaYears: number,
): Omit<PartialRangeMoveEvidence, "afterUnresolvedA" | "afterUnresolvedB"> => {
    const fixedRange = selectedRange.endYear < diagnosis.targetRange.endYear
        ? { startYear: selectedRange.endYear + 1, endYear: diagnosis.targetRange.endYear }
        : undefined;
    const newerSegments = fixedRange
        ? diagnosis.segments.filter((segment) => overlapRange(fixedRange, segment))
        : [];

    return {
        fixedRange,
        selectedRange,
        deltaYears,
        inferredMissingRange: missingRangeForMove(selectedRange, deltaYears),
        boundaryYear: selectedRange.endYear,
        olderSideLag: deltaYears,
        newerSideMeanLag: getMeanLag(newerSegments),
        beforeUnresolvedA: diagnosis.unresolvedA,
        beforeUnresolvedB: diagnosis.unresolvedB,
    };
};

const moveNumericRangeByOffset = (
    series: NumericSeries,
    selectedRange: YearRange,
    deltaYears: number,
): NumericSeries => {
    const next = new Map<number, number>();
    series.forEach((value, year) => {
        if (year < selectedRange.startYear || year > selectedRange.endYear) {
            next.set(year, value);
        }
    });
    series.forEach((value, year) => {
        if (year >= selectedRange.startYear && year <= selectedRange.endYear) {
            next.set(year + deltaYears, value);
        }
    });
    return new Map(Array.from(next.entries()).sort((a, b) => a[0] - b[0]));
};

export const refinePartialSelectedRange = (
    diagnosis: SeriesCoreDiagnosis,
    initialRange: YearRange,
    deltaYears: number,
    config: EffectiveDiagnosisConfig,
): YearRange => {
    if (deltaYears === 0) return initialRange;

    const years = Array.from(diagnosis.rawTarget.keys()).sort((a, b) => a - b);
    const radius = Math.max(Math.abs(deltaYears) * 2, config.overlap, 8);
    const candidateEndYears = years.filter((year) => (
        year >= initialRange.endYear - radius
        && year <= initialRange.endYear + radius
        && year >= initialRange.startYear
        && year < diagnosis.targetRange.endYear
    ));
    if (candidateEndYears.length === 0) return initialRange;

    const scored = candidateEndYears
        .map((endYear) => {
            const selectedRange = { startYear: initialRange.startYear, endYear };
            const moved = preprocessSeries(moveNumericRangeByOffset(diagnosis.rawTarget, selectedRange, deltaYears));
            const movedRange = {
                startYear: selectedRange.startYear + deltaYears,
                endYear: selectedRange.endYear + deltaYears,
            };
            const older = correlationForSegment(
                moved,
                diagnosis.master.data,
                movedRange.startYear,
                movedRange.endYear,
                0,
                config.minPairsForCorrelation,
            );
            const fixed = correlationForSegment(
                moved,
                diagnosis.master.data,
                endYear + 1,
                diagnosis.targetRange.endYear,
                0,
                config.minPairsForCorrelation,
            );
            const olderScore = older.correlation ?? -1;
            const fixedScore = fixed.correlation ?? 0;
            return {
                endYear,
                score: olderScore + fixedScore * 0.25 - Math.abs(endYear - initialRange.endYear) * 0.001,
            };
        })
        .sort((a, b) => b.score - a.score || Math.abs(a.endYear - initialRange.endYear) - Math.abs(b.endYear - initialRange.endYear));
    const best = scored[0];
    return best ? { ...initialRange, endYear: best.endYear } : initialRange;
};

export const extendPartialBoundaryByPointFit = (
    diagnosis: SeriesCoreDiagnosis,
    selectedRange: YearRange,
    deltaYears: number,
): YearRange => {
    if (deltaYears === 0 || selectedRange.endYear >= diagnosis.targetRange.endYear) return selectedRange;

    const target = preprocessSeries(diagnosis.rawTarget);
    const maxExtension = Math.max(2, Math.abs(deltaYears));
    let endYear = selectedRange.endYear;

    for (let nextYear = selectedRange.endYear + 1; nextYear <= selectedRange.endYear + maxExtension; nextYear += 1) {
        if (nextYear >= diagnosis.targetRange.endYear) break;
        const targetValue = target.get(nextYear);
        const fixedMasterValue = diagnosis.master.data.get(nextYear);
        const shiftedMasterValue = diagnosis.master.data.get(nextYear + deltaYears);
        if (targetValue === undefined || shiftedMasterValue === undefined) break;

        const fixedDistance = fixedMasterValue === undefined
            ? Infinity
            : Math.abs(targetValue - fixedMasterValue);
        const shiftedDistance = Math.abs(targetValue - shiftedMasterValue);
        if (shiftedDistance + 0.05 < fixedDistance) {
            endYear = nextYear;
            continue;
        }
        break;
    }

    return { ...selectedRange, endYear };
};
