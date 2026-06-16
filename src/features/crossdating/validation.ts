import type { DiagnosisBatchApplyResult } from "./diagnosis";

export type CrossdatingValidationStatus =
    | "no-data"
    | "running"
    | "needs-cofecha"
    | "stale"
    | "failed"
    | "passed";

export type CrossdatingValidationSeverity = "neutral" | "success" | "warning" | "danger";

export type CrossdatingValidationSummary = {
    status: CrossdatingValidationStatus;
    severity: CrossdatingValidationSeverity;
    title: string;
    detail: string;
    items: string[];
};

type BuildCrossdatingValidationSummaryInput = {
    hasData: boolean;
    isCofechaRunning: boolean;
    isCofechaOutdated: boolean;
    cofechaPossibleProblemsCount?: number;
    cofechaProblemSeries?: string[];
    internalProblemSegmentCount: number;
    internalCandidateCount: number;
    batchResult?: DiagnosisBatchApplyResult | null;
};

const formatBatchLine = (batchResult: DiagnosisBatchApplyResult | null | undefined): string | null => {
    if (!batchResult) return null;
    return `最近批次：请求 ${batchResult.requestedCount}，应用 ${batchResult.appliedCount}，跳过 ${batchResult.skippedCount}，失败 ${batchResult.failedCount}`;
};

const formatProblemSeriesLine = (series: readonly string[] | undefined): string | null => {
    if (!series || series.length === 0) return null;
    const shown = series.slice(0, 8).join(", ");
    const suffix = series.length > 8 ? ` 等 ${series.length} 条` : "";
    return `COFECHA 问题序列：${shown}${suffix}`;
};

export function buildCrossdatingValidationSummary({
    hasData,
    isCofechaRunning,
    isCofechaOutdated,
    cofechaPossibleProblemsCount,
    cofechaProblemSeries,
    internalProblemSegmentCount,
    internalCandidateCount,
    batchResult,
}: BuildCrossdatingValidationSummaryInput): CrossdatingValidationSummary {
    const batchLine = formatBatchLine(batchResult);
    const problemSeriesLine = formatProblemSeriesLine(cofechaProblemSeries);
    const baseItems = [
        `内部诊断：${internalProblemSegmentCount} 个问题段，${internalCandidateCount} 个候选`,
        batchLine,
    ].filter((item): item is string => Boolean(item));

    if (!hasData) {
        return {
            status: "no-data",
            severity: "neutral",
            title: "尚未载入 RWL",
            detail: "打开 RWL 文件后可以运行 COFECHA 并生成交叉定年验证摘要。",
            items: [],
        };
    }

    if (isCofechaRunning) {
        return {
            status: "running",
            severity: "warning",
            title: "正在运行 COFECHA",
            detail: "外部验证完成后会刷新 VERYCOF.OUT 和诊断摘要。",
            items: baseItems,
        };
    }

    if (cofechaPossibleProblemsCount === undefined || cofechaPossibleProblemsCount < 0) {
        return {
            status: "needs-cofecha",
            severity: "warning",
            title: "需要 COFECHA 验证",
            detail: "当前工作数据还没有可用的 COFECHA 摘要结果。",
            items: baseItems,
        };
    }

    if (isCofechaOutdated) {
        return {
            status: "stale",
            severity: "warning",
            title: "COFECHA 结果已过期",
            detail: "当前工作数据或 COFECHA 版本已变化，显示的是上一次验证结果。",
            items: [
                `上次 COFECHA problem：${cofechaPossibleProblemsCount}`,
                problemSeriesLine,
                ...baseItems,
            ].filter((item): item is string => Boolean(item)),
        };
    }

    if (cofechaPossibleProblemsCount > 0 || internalProblemSegmentCount > 0) {
        const blockers = [
            cofechaPossibleProblemsCount > 0 ? `COFECHA problem 仍为 ${cofechaPossibleProblemsCount}` : null,
            internalProblemSegmentCount > 0 ? `内部诊断仍有 ${internalProblemSegmentCount} 个问题段` : null,
        ].filter((item): item is string => Boolean(item));

        return {
            status: "failed",
            severity: "danger",
            title: "交叉定年仍未通过",
            detail: blockers.join("；"),
            items: [
                ...blockers,
                problemSeriesLine,
                `可继续检查候选：${internalCandidateCount}`,
                ...(batchLine ? [batchLine] : []),
            ].filter((item): item is string => Boolean(item)),
        };
    }

    return {
        status: "passed",
        severity: "success",
        title: "交叉定年验证通过",
        detail: "COFECHA problem 为 0，内部轻量诊断未发现明显问题。",
        items: [
            "COFECHA problem：0",
            "内部诊断：0 个问题段",
            ...(batchLine ? [batchLine] : []),
        ],
    };
}
