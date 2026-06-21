/**
 * 用于整体对齐的整条序列 lag 搜索。
 * 给定目标序列和 master chronology，扫描候选年份偏移，并返回相关与 t-like 证据最强的整体匹配。
 */
import { CrossdateConfig } from "./config";
import { pearson, tLikeForCorrelation } from "./series";
import type { GlobalSlidingLagResult, GlobalSlidingMatch } from "./types";

type SlidingMatchOptions = {
    seriesId?: string;
    lagMin?: number;
    lagMax?: number;
    minOverlap?: number;
};

const compareSlidingLagResults = (
    a: GlobalSlidingLagResult,
    b: GlobalSlidingLagResult,
): number => {
    const aScore = a.tLike ?? (a.r ?? -Infinity);
    const bScore = b.tLike ?? (b.r ?? -Infinity);
    if (bScore !== aScore) return bScore - aScore;
    if (b.overlapYears !== a.overlapYears) return b.overlapYears - a.overlapYears;
    return Math.abs(a.lag) - Math.abs(b.lag);
};

export function runGlobalSlidingMatch(
    targetSeries: Map<number, number>,
    masterChronology: Map<number, number>,
    options: SlidingMatchOptions = {},
): GlobalSlidingMatch {
    const lagMin = Math.floor(options.lagMin ?? CrossdateConfig.globalLagMin);
    const lagMax = Math.floor(options.lagMax ?? CrossdateConfig.globalLagMax);
    const minOverlap = Math.max(3, Math.floor(options.minOverlap ?? CrossdateConfig.minGlobalOverlap));
    const [startLag, endLag] = lagMin <= lagMax ? [lagMin, lagMax] : [lagMax, lagMin];
    const lagResults: GlobalSlidingLagResult[] = [];

    for (let lag = startLag; lag <= endLag; lag += 1) {
        const pairs: Array<[number, number]> = [];
        targetSeries.forEach((targetValue, year) => {
            const masterValue = masterChronology.get(year + lag);
            if (masterValue !== undefined) {
                pairs.push([targetValue, masterValue]);
            }
        });
        const r = pearson(pairs, minOverlap);
        lagResults.push({
            lag,
            r,
            tLike: tLikeForCorrelation(r, pairs.length),
            overlapYears: pairs.length,
        });
    }

    const current = lagResults.find((result) => result.lag === 0) ?? {
        lag: 0,
        r: null,
        tLike: null,
        overlapYears: 0,
    };
    const best = lagResults
        .filter((result) => result.r !== null)
        .sort(compareSlidingLagResults)[0]
        ?? current;

    return {
        seriesId: options.seriesId ?? "",
        lagResults,
        bestGlobalLag: best.lag,
        bestGlobalR: best.r,
        bestGlobalTLike: best.tLike,
        overlapYears: best.overlapYears,
        currentR: current.r,
        currentTLike: current.tLike,
        currentOverlapYears: current.overlapYears,
    };
}
