/**
 * 自适应分段分类。
 * 这里把单个窗口的 lag 搜索结果（r0 / bestLag / bestR / tLike / fisherZ / effectiveN）
 * 映射成 A_like / B_like / none，并给出 0..1 的置信度。
 *
 * 关键改进：阈值不再是固定常数，而是随 effectiveN（有效重叠年数）自适应——
 * 小样本窗口的 r 噪声更大，需要更宽松的低相关阈值与更大的改进幅度才认定异常，
 * 以避免短窗口产生假阳性。
 */
import {
    adaptiveImprovementThreshold,
    adaptiveLowCorrelationThreshold,
} from "./series";
import type { SegmentDiagnosisFlag } from "./types";

export type SegmentClassificationInput = {
    effectiveN: number;
    r0: number | null;
    bestLag: number;
    bestR: number | null;
    rImprovement: number;
    t0: number;
    bestT: number;
    tImprovement: number;
};

export type SegmentClassificationParams = {
    minValidYears: number;
    minTImprovement: number;
    minAcceptableBestR: number;
};

export type SegmentClassificationResult = {
    classification: SegmentDiagnosisFlag;
    confidence: number;
    reason: string;
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * B-like 置信度：综合 rImprovement、tImprovement、bestR、effectiveN。
 */
const bLikeConfidence = (
    input: SegmentClassificationInput,
    params: SegmentClassificationParams,
): number => clamp01(
    0.30 * clamp01(input.rImprovement / 0.30)
    + 0.30 * clamp01(input.tImprovement / 4)
    + 0.20 * clamp01(((input.bestR ?? 0) - params.minAcceptableBestR) / 0.5)
    + 0.20 * clamp01(input.effectiveN / 50),
);

/**
 * A-like 置信度：r0 越低于自适应阈值、样本越多、且没有更优 lag 时越高。
 */
const aLikeConfidence = (
    input: SegmentClassificationInput,
    lowRThreshold: number,
): number => {
    const r0 = input.r0 ?? 1;
    return clamp01(
        0.5 * clamp01((lowRThreshold - r0) / Math.max(0.01, lowRThreshold))
        + 0.3 * clamp01(input.effectiveN / 50)
        + 0.2 * (1 - clamp01((input.bestR ?? 0) / 0.4)),
    );
};

/**
 * 把单窗口的统计量分类为 A_like / B_like / none。
 *
 * B-like 判定（需同时满足）：
 *   1. bestLag != 0
 *   2. rImprovement >= 自适应 minRImprovement
 *   3. tImprovement (bestT - t0) >= minTImprovement（默认 0.6）
 *   4. bestR >= minAcceptableBestR（默认 0.25）
 *   5. effectiveN >= minValidYears
 *
 * A-like 判定：
 *   1. r0 < 自适应 lowRThreshold
 *   2. bestLag 没有显著改善（或 bestR 仍低）
 *
 * effectiveN < minValidYears 时直接 none，confidence = 0。
 */
export const classifySegment = (
    input: SegmentClassificationInput,
    params: SegmentClassificationParams,
): SegmentClassificationResult => {
    if (input.effectiveN < params.minValidYears) {
        return { classification: "none", confidence: 0, reason: "样本对不足，暂不判定" };
    }

    const lowRThreshold = adaptiveLowCorrelationThreshold(input.effectiveN);
    const minRImprovement = adaptiveImprovementThreshold(input.effectiveN);

    const isBLike = input.bestLag !== 0
        && input.rImprovement >= minRImprovement
        && input.tImprovement >= params.minTImprovement
        && (input.bestR ?? -1) >= params.minAcceptableBestR;

    if (isBLike) {
        const confidence = bLikeConfidence(input, params);
        return {
            classification: "B_like",
            confidence,
            reason: `B-like：lag ${input.bestLag > 0 ? "+" : ""}${input.bestLag} 相关 +${input.rImprovement.toFixed(2)}、t +${input.tImprovement.toFixed(1)}（n=${input.effectiveN}，阈值 ${minRImprovement.toFixed(2)}）`,
        };
    }

    const isALike = (input.r0 ?? 1) < lowRThreshold
        && (
            input.bestLag === 0
            || input.rImprovement < minRImprovement
            || (input.bestR ?? -1) < params.minAcceptableBestR
        );

    if (isALike) {
        const confidence = aLikeConfidence(input, lowRThreshold);
        return {
            classification: "A_like",
            confidence,
            reason: `A-like：当前相关 ${(input.r0 ?? 0).toFixed(2)} 低于自适应阈值 ${lowRThreshold.toFixed(2)}，未发现更优整体 lag`,
        };
    }

    return { classification: "none", confidence: 0, reason: "未发现明显问题" };
};
