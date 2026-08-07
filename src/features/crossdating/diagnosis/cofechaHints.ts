/**
 * COFECHA 文本输出解析。
 *
 * 这是一个可选模块：解析 COFECHA 风格文本输出（[A] segment lag table、
 * [B] effect on correlation、[C] year-to-year divergence、[E] outliers），
 * 把它们转成“提示（hints）”。核心算法不依赖它——用户没有提供 COFECHA 文本时
 * 算法仍正常运行；hints 只作为候选证据的加权项，权重默认 0.8，不会超过
 * propagation / 实际重诊断证据的权重。
 */

export type CofechaSegmentHint = {
    seriesId: string | null;
    startYear: number;
    endYear: number;
    highLag: number;
    correlationsByLag: Record<number, number>;
    starredLag: number | null;
    starredR: number | null;
};

export type CofechaEffectHint = {
    seriesId: string | null;
    scope: "entire" | "segment";
    segmentStartYear?: number;
    segmentEndYear?: number;
    direction: "lower" | "higher";
    year: number;
    marker?: "<" | ">";
    effect: number;
};

export type CofechaYearToYearHint = {
    seriesId: string | null;
    year1: number;
    year2: number;
    sd: number;
};

export type CofechaOutlierHint = {
    seriesId: string | null;
    year: number;
    sd: number;
};

export type CofechaHints = {
    segments: CofechaSegmentHint[];
    effects: CofechaEffectHint[];
    yearToYear: CofechaYearToYearHint[];
    outliers: CofechaOutlierHint[];
};

type Section = "none" | "A" | "B" | "C" | "E";

const LAG_MIN = -10;
const LAG_MAX = 10;

const detectSection = (line: string): Section | null => {
    if (/\[A\]\s*Segment/i.test(line)) return "A";
    if (/\[B\]/.test(line)) return "B";
    if (/\[C\]/.test(line)) return "C";
    if (/\[E\]/.test(line)) return "E";
    return null;
};

/**
 * 解析 [A] 表格行：startYear endYear highLag 后跟 21 个 lag 列相关值。
 * 相关值形如 .71（无前导 0）、-.15；带 * 的为该行选中的 high lag；
 * COFECHA 用 | 在 +0 和 +1 列之间分隔，解析时按空白处理。
 */
const parseSegmentRow = (line: string, seriesId: string | null): CofechaSegmentHint | null => {
    const head = line.trim().match(/^(\d{3,4})\s+(\d{3,4})\s+([+-]?\d+)\s+(.*)$/);
    if (!head) return null;
    const startYear = Number(head[1]);
    const endYear = Number(head[2]);
    const highLag = Number(head[3]);
    const rest = head[4].replace(/\|/g, " ");
    const tokenRegex = /(-?(?:\d*\.\d+|\d+\.\d+|\d+))(\*?)/g;
    const correlationsByLag: Record<number, number> = {};
    let starredLag: number | null = null;
    let starredR: number | null = null;
    let index = 0;
    let match: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((match = tokenRegex.exec(rest)) !== null) {
        const lag = LAG_MIN + index;
        if (lag > LAG_MAX) break;
        const value = Number(match[1]);
        if (!Number.isFinite(value)) {
            index += 1;
            continue;
        }
        correlationsByLag[lag] = value;
        if (match[2] === "*") {
            starredLag = lag;
            starredR = value;
        }
        index += 1;
    }

    if (Object.keys(correlationsByLag).length === 0) return null;
    return { seriesId, startYear, endYear, highLag, correlationsByLag, starredLag, starredR };
};

const parseEffectEntries = (
    segment: string,
    direction: "lower" | "higher",
    scope: "entire" | "segment",
    segmentStartYear: number | undefined,
    segmentEndYear: number | undefined,
    seriesId: string | null,
): CofechaEffectHint[] => {
    const entries: CofechaEffectHint[] = [];
    const regex = /(\d{4})([<>])?\s+(-?\d*\.\d+)/g;
    let match: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((match = regex.exec(segment)) !== null) {
        entries.push({
            seriesId,
            scope,
            segmentStartYear,
            segmentEndYear,
            direction,
            year: Number(match[1]),
            marker: (match[2] as "<" | ">" | undefined) ?? undefined,
            effect: Number(match[3]),
        });
    }
    return entries;
};

const parseEffectLine = (
    line: string,
    scope: "entire" | "segment",
    segmentStartYear: number | undefined,
    segmentEndYear: number | undefined,
    seriesId: string | null,
): CofechaEffectHint[] => {
    const higherIndex = line.indexOf("Higher");
    const lowerPart = higherIndex >= 0 ? line.slice(0, higherIndex) : line;
    const higherPart = higherIndex >= 0 ? line.slice(higherIndex) : "";
    return [
        ...parseEffectEntries(lowerPart.replace(/Lower/i, ""), "lower", scope, segmentStartYear, segmentEndYear, seriesId),
        ...parseEffectEntries(higherPart.replace(/Higher/i, ""), "higher", scope, segmentStartYear, segmentEndYear, seriesId),
    ];
};

export const parseCofechaHints = (text: string): CofechaHints => {
    const result: CofechaHints = { segments: [], effects: [], yearToYear: [], outliers: [] };
    if (!text) return result;

    let section: Section = "none";
    let effectScope: "entire" | "segment" = "entire";
    let effectSegmentStart: number | undefined;
    let effectSegmentEnd: number | undefined;
    let currentSeriesId: string | null = null;

    text.split(/\r?\n/).forEach((rawLine) => {
        const line = rawLine.trimEnd();
        // 序列头行，形如 "EBD011    1850 to  2024     175 years ... Series   1"：切换当前序列上下文。
        const seriesHeader = line.match(/^\s*([A-Za-z][\w-]*?)\s+\d{3,4}\s+to\s+\d{3,4}\s+\d+\s+years\b/);
        if (seriesHeader) {
            currentSeriesId = seriesHeader[1];
            section = "none";
            return;
        }
        const detected = detectSection(line);
        if (detected) {
            section = detected;
            if (detected === "B") {
                effectScope = "entire";
                effectSegmentStart = undefined;
                effectSegmentEnd = undefined;
            }
            // [B] 头行同时声明 entire series，需要继续解析本行内 Lower/Higher。
            if (detected !== "B") return;
        }

        if (section === "A") {
            const hint = parseSegmentRow(line, currentSeriesId);
            if (hint) result.segments.push(hint);
            return;
        }

        if (section === "B") {
            const segmentHeader = line.match(/^\s*(\d{4})\s+to\s+(\d{4})\s+segment/i);
            if (segmentHeader) {
                effectScope = "segment";
                effectSegmentStart = Number(segmentHeader[1]);
                effectSegmentEnd = Number(segmentHeader[2]);
                return;
            }
            if (/Lower|Higher/i.test(line)) {
                result.effects.push(...parseEffectLine(line, effectScope, effectSegmentStart, effectSegmentEnd, currentSeriesId));
            }
            return;
        }

        if (section === "C") {
            const regex = /(\d{4})\s+(\d{4})\s+(-?\d+\.\d+)\s*SD/g;
            let match: RegExpExecArray | null;
            // eslint-disable-next-line no-cond-assign
            while ((match = regex.exec(line)) !== null) {
                result.yearToYear.push({
                    seriesId: currentSeriesId,
                    year1: Number(match[1]),
                    year2: Number(match[2]),
                    sd: Number(match[3]),
                });
            }
            return;
        }

        if (section === "E") {
            const regex = /(\d{4})\s+([+-]?\d+\.\d+)\s*SD/g;
            let match: RegExpExecArray | null;
            // eslint-disable-next-line no-cond-assign
            while ((match = regex.exec(line)) !== null) {
                result.outliers.push({ seriesId: currentSeriesId, year: Number(match[1]), sd: Number(match[2]) });
            }
        }
    });

    return result;
};

/**
 * 判断某 hint 是否属于目标序列：seriesId 未指定（单序列文本）或与 hint 的 seriesId 匹配时为真。
 * COFECHA 序列 ID 可能带后缀差异，按前缀宽松匹配。
 */
const hintMatchesSeries = (hintSeriesId: string | null, seriesId: string | null): boolean => {
    if (!seriesId || !hintSeriesId) return true;
    return hintSeriesId === seriesId
        || hintSeriesId.startsWith(seriesId)
        || seriesId.startsWith(hintSeriesId);
};

/**
 * 某一年的 COFECHA 综合证据（0..~1+）。综合 effect / year-to-year / outlier 提示，
 * 多个 segment 中重复出现的年份权重更高。没有任何提示的年份返回 0。
 * 传入 seriesId 时只统计该序列的提示（避免把别的序列的 hint 误用）。
 */
export const getCofechaEvidenceForYear = (hints: CofechaHints, year: number, seriesId: string | null = null): number => {
    let evidence = 0;
    hints.effects.forEach((effect) => {
        if (!hintMatchesSeries(effect.seriesId, seriesId)) return;
        if (effect.year === year) {
            // lower 方向（删掉/移动该年会提升相关）权重略高。
            const directionWeight = effect.direction === "lower" ? 1.2 : 0.8;
            evidence += Math.min(0.3, Math.abs(effect.effect) * 4 * directionWeight);
        }
    });
    hints.yearToYear.forEach((entry) => {
        if (!hintMatchesSeries(entry.seriesId, seriesId)) return;
        if (entry.year1 === year || entry.year2 === year) {
            evidence += Math.min(0.4, Math.abs(entry.sd) / 10);
        }
    });
    hints.outliers.forEach((outlier) => {
        if (!hintMatchesSeries(outlier.seriesId, seriesId)) return;
        if (outlier.year === year) {
            evidence += Math.min(0.3, Math.abs(outlier.sd) / 10);
        }
    });
    return evidence;
};

/**
 * [A] segment lag table 对某 lag 的支持度。
 * 覆盖给定年份范围的 segment 中，highLag === lag 的越多/相关越高，支持度越高。
 */
export const getCofechaSegmentLagSupport = (
    hints: CofechaHints,
    segmentStart: number,
    segmentEnd: number,
    lag: number,
    seriesId: string | null = null,
): number => {
    let support = 0;
    hints.segments.forEach((segment) => {
        if (!hintMatchesSeries(segment.seriesId, seriesId)) return;
        const overlaps = segment.startYear <= segmentEnd && segmentStart <= segment.endYear;
        if (!overlaps) return;
        if (segment.highLag === lag) {
            const r = segment.starredR ?? segment.correlationsByLag[lag] ?? 0.5;
            support += Math.max(0.1, r);
        }
    });
    return support;
};

export type CofechaFlaggedRegion = {
    /** lag 方向；仅 |highLag|=1 直接映射为缺轮/伪轮，负向大 lag 映射为 partialMove。 */
    editType: "insert" | "delete";
    /** 主导 lag 符号绝对值（通常为 1；多个累积时可能更大）。 */
    lag: number;
    /** 最新 flagged 段的范围（人工流程：从此段开始处理）。 */
    startYear: number;
    endYear: number;
    /** 该方向的 [A] 支持强度（starredR 之和，越大越可信）。 */
    support: number;
};

export type CofechaTerminalLagEstimate = {
    lag: number;
    support: number;
    segmentCount: number;
    consistency: number;
    terminalEndYear: number;
    unmatchedTailYears: number;
};

/**
 * Estimate the lag state that reaches the checked newer endpoint. A local missing/false event
 * stops producing non-zero [A] rows once COFECHA reaches its fixed newer side; a true whole
 * baseline (including whole + local compositions) keeps the same non-zero lag through the last
 * checked rows. The default requires two agreeing rows; callers may admit one strong endpoint row
 * only when a later joint counterfactual gate validates it.
 */
export const getCofechaTerminalLagEstimate = (
    hints: CofechaHints,
    seriesId: string | null,
    seriesEndYear: number,
    options: {
        maxUnmatchedTailYears?: number;
        maxSupportingLookbackYears?: number;
        minStarredR?: number;
        minEndpointStarredR?: number;
        minimumSegments?: number;
        minimumConsistency?: number;
    } = {},
): CofechaTerminalLagEstimate | null => {
    const maxUnmatchedTailYears = options.maxUnmatchedTailYears ?? 12;
    const maxSupportingLookbackYears = options.maxSupportingLookbackYears ?? 25;
    const minStarredR = options.minStarredR ?? 0.3;
    const minEndpointStarredR = options.minEndpointStarredR ?? minStarredR;
    const minimumSegments = options.minimumSegments ?? 2;
    const minimumConsistency = options.minimumConsistency ?? 2 / 3;
    const reliableSegments = hints.segments.filter((segment) => {
        const starredR = segment.starredR
            ?? segment.correlationsByLag[segment.highLag]
            ?? 0;
        return hintMatchesSeries(segment.seriesId, seriesId)
            && segment.highLag !== 0
            && seriesEndYear - segment.endYear >= 0
            && starredR >= minStarredR;
    });
    const endpointLags = new Set(reliableSegments
        .filter((segment) => {
            const starredR = segment.starredR
                ?? segment.correlationsByLag[segment.highLag]
                ?? 0;
            return seriesEndYear - segment.endYear <= maxUnmatchedTailYears
                && starredR >= minEndpointStarredR;
        })
        .map((segment) => segment.highLag));
    if (endpointLags.size === 0) return null;
    const endpointSegments = reliableSegments.filter((segment) => (
        endpointLags.has(segment.highLag)
        && seriesEndYear - segment.endYear
            <= maxUnmatchedTailYears + maxSupportingLookbackYears
    ));
    if (endpointSegments.length < minimumSegments) return null;

    const votes = new Map<number, { support: number; count: number; endYear: number }>();
    endpointSegments.forEach((segment) => {
        const starredR = segment.starredR
            ?? segment.correlationsByLag[segment.highLag]
            ?? minStarredR;
        const vote = votes.get(segment.highLag) ?? {
            support: 0,
            count: 0,
            endYear: segment.endYear,
        };
        vote.support += Math.max(0.1, starredR);
        vote.count += 1;
        vote.endYear = Math.max(vote.endYear, segment.endYear);
        votes.set(segment.highLag, vote);
    });
    const ranked = Array.from(votes, ([lag, vote]) => ({ lag, ...vote }))
        .sort((left, right) => (
            right.support - left.support
            || right.count - left.count
            || right.endYear - left.endYear
        ));
    const winner = ranked[0];
    if (!winner || winner.count < minimumSegments) return null;
    const totalSupport = ranked.reduce((sum, vote) => sum + vote.support, 0);
    const consistency = totalSupport > 0 ? winner.support / totalSupport : 0;
    if (consistency < minimumConsistency) return null;
    return {
        lag: winner.lag,
        support: winner.support,
        segmentCount: winner.count,
        consistency,
        terminalEndYear: winner.endYear,
        unmatchedTailYears: seriesEndYear - winner.endYear,
    };
};

/**
 * 从 COFECHA [A] 段级 lag 表提取某序列**最新**的 flagged 区域（人工定年流程：从较近年份处理）。
 *
 * COFECHA 的 [A] 表对真实缺/伪轮给出极干净的 highLag（如全段 -1=缺轮 / +1=伪轮，相关从 ~0 跳到 .7+）；
 * 负向大 lag 保留为连续缺测的局部移动幅度。
 * 真编辑点在"最新一段非零 highLag 段"的较新边界附近（更老段同号只是错位向更老传播）。
 * 这里取该序列中 highLag 同号、|highLag|>=1 的 segment 里 **endYear 最大** 的那一段作为待处理区域，
 * 其 highLag 符号决定编辑类型。无 flagged 段返回 null。
 */
export const getNewestFlaggedCofechaSegment = (
    hints: CofechaHints,
    seriesId: string | null,
    minStarredR = 0.3,
): CofechaFlaggedRegion | null => {
    const flagged = hints.segments.filter((segment) => (
        hintMatchesSeries(segment.seriesId, seriesId)
        && Math.abs(segment.highLag) >= 1
        && (segment.starredR ?? segment.correlationsByLag[segment.highLag] ?? 0) >= minStarredR
    ));
    if (flagged.length === 0) return null;
    // 取 endYear 最大（最新）的 flagged 段。
    const newest = flagged.slice().sort((a, b) => b.endYear - a.endYear)[0];
    const sign = Math.sign(newest.highLag);
    // 累计该序列中与最新段同号、且与其相邻/重叠传播的支持强度。
    const support = flagged
        .filter((segment) => Math.sign(segment.highLag) === sign)
        .reduce((sum, segment) => sum + Math.max(0.1, segment.starredR ?? segment.correlationsByLag[segment.highLag] ?? 0.3), 0);
    return {
        editType: newest.highLag < 0 ? "insert" : "delete",
        lag: Math.abs(newest.highLag),
        startYear: newest.startYear,
        endYear: newest.endYear,
        support,
    };
};
