import type { MouseEventHandler } from "react";
import {
    getBreadthOperationLabel,
    type BreadthDiagnosisNavigatorState,
    type BreadthDiagnosisSuggestion,
} from "./breadthDiagnosis";
import styles from "../Home.module.css";

type Props = {
    navigator: BreadthDiagnosisNavigatorState;
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

const getStatusText = (navigator: BreadthDiagnosisNavigatorState) => {
    switch (navigator.status) {
        case "idle":
            return "打开 RWL 后开始全文件扫描";
        case "stale":
            return "结果已过期，等待重新扫描";
        case "paused":
            return getPauseText(navigator);
        case "scanning":
            return `全文件后台扫描 ${navigator.scannedCount} / ${navigator.totalCount}`;
        case "complete":
            return navigator.suggestions.length > 0
                ? `另有 ${navigator.suggestions.length} 条序列需要复核`
                : "暂未发现其他复核窗口";
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

export function BreadthDiagnosisNavigator({ navigator, onSelectSuggestion }: Props) {
    const visibleSuggestions = navigator.suggestions.slice(0, 3);
    const remainingCount = Math.max(0, navigator.suggestions.length - visibleSuggestions.length);
    const makeClickHandler = (
        suggestion: BreadthDiagnosisSuggestion,
    ): MouseEventHandler<HTMLButtonElement> => () => onSelectSuggestion(suggestion);

    return (
        <section
            className={`${styles["validation-summary"]} ${styles["breadth-navigator"]} ${getSeverityClass(navigator)}`}
            aria-label="全文件广度优先复核提示器"
        >
            <div className={styles["breadth-summary"]}>
                <strong>
                    待复核序列
                    <span className={styles["breadth-count"]}>{navigator.suggestions.length}</span>
                </strong>
                <span>{getStatusText(navigator)}</span>
                {navigator.totalCount > 0 && navigator.status !== "complete" ? (
                    <span
                        className={styles["breadth-progress-track"]}
                        role="progressbar"
                        aria-label="全文件诊断扫描进度"
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

            {visibleSuggestions.length > 0 ? (
                <div className={styles["breadth-suggestion-list"]}>
                    {visibleSuggestions.map((suggestion) => (
                        <button
                            key={`${suggestion.seriesId}:${suggestion.firstSeenOrder}`}
                            type="button"
                            className={styles["breadth-suggestion"]}
                            title={`选择 ${suggestion.seriesId} 并定位到 ${suggestion.topYear} 年`}
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
                            </span>
                        </button>
                    ))}
                    {remainingCount > 0 ? (
                        <span className={styles["breadth-more"]}>还有 {remainingCount} 条</span>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}
