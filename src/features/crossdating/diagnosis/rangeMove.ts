/**
 * 年份范围移动与边界推断工具。
 * 这里负责从异常 lag 推导 selectedRange、missingRange，并细化部分移动的边界。
 */
import { CrossdateConfig } from "./config";
import { runGlobalSlidingMatch } from "./sliding";
import { correlationForSegment, filterSeriesByRange, getRangeForSeries, preprocessSeries } from "./series";
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
 * 模拟删除一年，仅用于预扫描。
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
 * 轻量预扫描：对每个候选年模拟删除，结合局部相关性 + COFECHA [C] 风格异常得分。
 * 不跑完整重诊断，仅用于从大海选中快速筛出 top 3。
 */
const preScanDeleteCandidates = (
    diagnosis: SeriesCoreDiagnosis,
    candidateYears: number[],
    config: EffectiveDiagnosisConfig,
    boundaryYear: number,
): number[] => {
    const windowRadius = 20;
    const processed = preprocessSeries(diagnosis.rawTarget);
    const extremeYears = findExtremeChangeYears(processed, 3.0);

    return candidateYears
        .map((year) => {
            const afterSeries = simulateDelete(diagnosis.rawTarget, year);
            const afterProcessed = preprocessSeries(afterSeries);
            const afterRange = getRangeForSeries(afterProcessed);
            if (!afterRange) return { year, quality: -1 };

            const measureStart = Math.max(afterRange.startYear, year - windowRadius);
            const measureEnd = Math.min(afterRange.endYear, year + windowRadius);
            const corr = correlationForSegment(
                afterProcessed,
                diagnosis.master.data,
                measureStart,
                measureEnd,
                0,
                config.minPairsForCorrelation,
            );
            // 局部相关性
            const localQuality = corr.correlation ?? -1;
            // COFECHA [C] 风格异常加分
            const anomalyBonus = (extremeYears.get(year) ?? 0) * 0.025;
            // 离边界距离惩罚：伪轮一定在边界附近，远距离候选降权
            const boundaryPenalty = Math.abs(year - boundaryYear) * 0.004;
            return { year, quality: localQuality + anomalyBonus - boundaryPenalty };
        })
        .sort((a, b) => b.quality - a.quality)
        .slice(0, 3)
        .map((entry) => entry.year);
};

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
 * 返回多个候选锚年。
 *
 * 策略：
 * - DELETE：轻量预扫描所有候选年（模拟删年 + 局部相关性），
 *   取 top 3 交给 evaluateDraft 做精确排名。
 * - INSERT：master 窄轮优先 + 距离排序。
 */
export const pickTopSingleYearAnchors = (
    diagnosis: SeriesCoreDiagnosis,
    pattern: PropagationPattern,
    fallbackYear: number,
    config: EffectiveDiagnosisConfig,
    topN: number = 3,
): number[] => {
    const searchEndYear = Math.min(
        diagnosis.targetRange.endYear,
        pattern.newerBoundaryYear + 5,
    );
    const searchStartYear = Math.max(
        diagnosis.targetRange.startYear,
        pattern.olderBoundaryYear - 5,
    );
    const existingYears = Array.from(diagnosis.rawTarget.keys())
        .filter((year) => year >= searchStartYear && year <= searchEndYear);
    if (existingYears.length === 0) return [fallbackYear];

    if (pattern.patternType === "possibleMissingYear") {
        const sorted = [...existingYears].sort((a, b) => {
            const aMaster = diagnosis.master.data.get(a);
            const bMaster = diagnosis.master.data.get(b);
            const aNarrow = aMaster !== undefined && aMaster <= config.narrowYearThreshold;
            const bNarrow = bMaster !== undefined && bMaster <= config.narrowYearThreshold;
            if (aNarrow !== bNarrow) return bNarrow ? 1 : -1;
            if (aNarrow && bNarrow && aMaster !== undefined && bMaster !== undefined) {
                return aMaster - bMaster;
            }
            return Math.abs(a - fallbackYear) - Math.abs(b - fallbackYear);
        });
        return sorted.slice(0, topN);
    }

    // DELETE：轻量预扫描 → 取 top 3。
    if (pattern.patternType === "possibleFalseYear") {
        return preScanDeleteCandidates(diagnosis, existingYears, config, fallbackYear)
            .slice(0, topN);
    }

    return [fallbackYear];
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
