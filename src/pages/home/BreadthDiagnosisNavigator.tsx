import type { MouseEventHandler } from "react";
import { FloatingScrollArea } from "@/components/FloatingScrollArea/FloatingScrollArea";
import {
    getBreadthOperationLabel,
    getBreadthPriorityLabel,
    type BreadthDiagnosisNavigatorState,
    type BreadthDiagnosisSuggestion,
} from "./breadthDiagnosis";
import styles from "../Home.module.css";

type Props = {
    navigator: BreadthDiagnosisNavigatorState;
    scanAvailable: boolean;
    onRunScan: () => void;
    onSelectSuggestion: (suggestion: BreadthDiagnosisSuggestion) => void;
};

const getPauseText = (navigator: BreadthDiagnosisNavigatorState) => {
    switch (navigator.pauseReason) {
        case "file-load":
            return "读取文件时暂停后台扫描";
        case "save":
            return "保存数据时暂停后台扫描";
        case "cofecha":
            return "COFECHA 运行时暂停后台扫描";
        case "selected-diagnosis":
            return "当前序列诊断优先，后台扫描已暂停";
        default:
            return "后台扫描暂时暂停";
    }
};

const getStatusText = (
    navigator: BreadthDiagnosisNavigatorState,
    scanAvailable: boolean,
) => {
    if (!scanAvailable) return "等待 COFECHA 自动参考";
    if (navigator.totalCount === 0) return "当前没有待扫描序列";
    switch (navigator.status) {
        case "idle":
            return "点击扫描待复核序列";
        case "stale":
            return "扫描结果已过期，点击重新扫描";
        case "paused":
            return getPauseText(navigator);
        case "scanning":
            return `后台扫描 ${navigator.scannedCount} / ${navigator.totalCount}`;
        case "complete":
            return navigator.suggestions.length > 0
                ? `另有 ${navigator.suggestions.length} 条序列需要复核`
                : "暂未发现复核窗口";
    }
};

const getSeverityClass = (navigator: BreadthDiagnosisNavigatorState) => {
    if (navigator.status === "complete" && navigator.suggestions.length === 0) {
        return styles["validation-success"];
    }
    if (navigator.suggestions.length > 0) {
        return styles["validation-warning"];
    }
    return styles["validation-neutral"];
};

export function BreadthDiagnosisNavigator({
    navigator,
    scanAvailable,
    onRunScan,
    onSelectSuggestion,
}: Props) {
    const scanIsRunning = navigator.status === "scanning" || navigator.status === "paused";
    const scanButtonLabel = navigator.status === "paused"
        ? "已暂停"
        : navigator.status === "scanning"
            ? "扫描中"
        : navigator.status === "complete"
            ? "重新扫描"
            : "扫描";
    const makeClickHandler = (
        suggestion: BreadthDiagnosisSuggestion,
    ): MouseEventHandler<HTMLButtonElement> => () => onSelectSuggestion(suggestion);

    return (
        <section
            className={`${styles["validation-summary"]} ${styles["breadth-navigator"]} ${getSeverityClass(navigator)}`}
            aria-label="待复核序列提示器"
        >
            <div className={styles["breadth-summary"]}>
                <strong>
                    待复核序列
                    <span className={styles["breadth-count"]}>{navigator.suggestions.length}</span>
                    <button
                        type="button"
                        className={styles["breadth-scan-button"]}
                        disabled={!scanAvailable || scanIsRunning || navigator.totalCount === 0}
                        title={!scanAvailable
                            ? "等待 COFECHA 自动参考生成完成"
                            : navigator.totalCount === 0
                                ? "当前没有待扫描序列"
                                : "扫描待复核序列"}
                        onClick={onRunScan}
                    >
                        {scanButtonLabel}
                    </button>
                </strong>
                <span>{getStatusText(navigator, scanAvailable)}</span>
                {navigator.totalCount > 0
                    && (navigator.status === "scanning" || navigator.status === "paused") ? (
                    <span
                        className={styles["breadth-progress-track"]}
                        role="progressbar"
                        aria-label="诊断扫描进度"
                        aria-valuemin={0}
                        aria-valuemax={navigator.totalCount}
                        aria-valuenow={navigator.scannedCount}
                    >
                        <span
                            className={styles["breadth-progress-value"]}
                            style={{ width: `${Math.min(100, navigator.scannedCount / navigator.totalCount * 100)}%` }}
                        />
                    </span>
                ) : null}
            </div>

            <FloatingScrollArea
                viewportClassName={styles["breadth-suggestion-viewport"]}
                className={styles["breadth-suggestion-list"]}
                viewportStyle={{ flex: "0 0 55px", height: 55, maxHeight: 55 }}
                aria-label="待复核序列滚动列表"
                data-visible-rows="2"
                tabIndex={navigator.suggestions.length > 2 ? 0 : -1}
                scrollbarRevision={navigator.suggestions.length}
                edgeInset={1}
            >
                    {navigator.suggestions.map((suggestion) => (
                        <button
                            key={`${suggestion.seriesId}:${suggestion.firstSeenOrder}`}
                            type="button"
                            className={styles["breadth-suggestion"]}
                            title={[
                                `选择 ${suggestion.seriesId} 并定位到 ${suggestion.topYear} 年`,
                                getBreadthPriorityLabel(suggestion),
                                suggestion.priority.sharedOverlapYears > 0
                                    ? `预计可重新对齐约 ${suggestion.priority.sharedOverlapYears} 个重叠年`
                                    : "",
                            ].filter(Boolean).join("；")}
                            onClick={makeClickHandler(suggestion)}
                        >
                            <span className={styles["breadth-series"]}>{suggestion.seriesId}</span>
                            <span className={styles["breadth-window"]}>
                                {suggestion.startYear}-{suggestion.endYear}
                            </span>
                            <span className={styles["breadth-operation"]}>
                                {getBreadthOperationLabel(suggestion.eventType)}
                                {suggestion.shiftYears !== undefined
                                    && Math.abs(suggestion.shiftYears) > 1
                                    ? ` ${suggestion.shiftYears}`
                                    : ""}
                                {` · ${getBreadthPriorityLabel(suggestion)}`}
                            </span>
                        </button>
                    ))}
            </FloatingScrollArea>
        </section>
    );
}
