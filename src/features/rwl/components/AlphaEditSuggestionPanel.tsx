import { createPortal } from "react-dom";
import { useMemo, useState } from "react";
import type { CofechaPassReference } from "@/features/crossdating/reference";
import {
    DEFAULT_ALPHA_EDIT_CONFIG,
    suggestInsertDeleteYearsAlphaEdit,
    summarizeAlphaEditOperations,
    type AlphaEditCandidate,
    type AlphaEditSuggestionResult,
} from "@/features/rwl/alphaEditSuggestions";
import type { RwlTreeData } from "@/features/rwl/types";
import styles from "./AlphaEditSuggestionPanel.module.css";

type AlphaEditSuggestionPanelProps = {
    seriesId: string;
    series: RwlTreeData;
    reference: CofechaPassReference | null | undefined;
    referenceStale?: boolean;
    disabled?: boolean;
    onApplyCandidate?: (
        seriesId: string,
        result: AlphaEditSuggestionResult,
        candidate: AlphaEditCandidate,
    ) => void;
    onPreviewCandidate?: (seriesId: string, candidate: AlphaEditCandidate) => void;
};

let globalAlphaEditRunning = false;

const formatNumber = (value: number | null | undefined, digits = 3) => (
    typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-"
);

const operationTypeLabel = (operationType: AlphaEditCandidate["operations"][number]["operationType"]) => (
    operationType === "insert_missing_ring_suggestion" ? "插年" : "删年"
);

function AlphaEditPopover({
    result,
    error,
    onClose,
    onApply,
    onPreview,
}: {
    result: AlphaEditSuggestionResult | null;
    error: string;
    onClose: () => void;
    onApply: (candidate: AlphaEditCandidate) => void;
    onPreview: (candidate: AlphaEditCandidate) => void;
}) {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selectedCandidate = useMemo(() => (
        result?.candidates.find((candidate) => candidate.id === selectedId)
        ?? result?.candidates[0]
        ?? null
    ), [result?.candidates, selectedId]);

    return createPortal(
        <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
            <div
                className={styles.popover}
                role="dialog"
                aria-modal="true"
                aria-label="插删年建议"
                onMouseDown={(event) => event.stopPropagation()}
            >
                <div className={styles.header}>
                    <div>
                        <h3 className={styles.title}>插删年建议</h3>
                        <p className={styles.subtitle}>{result?.seriesId ?? "当前序列"}</p>
                    </div>
                    <button type="button" className={styles.close} onClick={onClose} aria-label="关闭">×</button>
                </div>

                <div className={styles.body}>
                    {error ? <p className={styles.error}>{error}</p> : null}
                    {result ? (
                        <>
                            <section className={styles.section}>
                                <h4 className={styles.sectionTitle}>Parameters</h4>
                                <div className={styles.metrics}>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>alphaMax / minOverlap / topK</span>
                                        <span className={styles.metricValue}>
                                            {result.alphaMax} / {result.minOverlap} / {result.returnedCount}
                                        </span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>costMode</span>
                                        <span className={styles.metricValue}>{result.costMode}</span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>reference range</span>
                                        <span className={styles.metricValue}>
                                            {result.referenceOuterYear ?? "-"}-{result.referenceInnerYear ?? "-"}
                                        </span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>candidates</span>
                                        <span className={styles.metricValue}>
                                            {result.returnedCount} / {result.candidateCount}
                                        </span>
                                    </div>
                                </div>
                                {result.warnings.length > 0 ? (
                                    <ul className={styles.warnings}>
                                        {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                                    </ul>
                                ) : null}
                            </section>

                            <section className={styles.section}>
                                <h4 className={styles.sectionTitle}>Candidates</h4>
                                <div className={styles.tableWrap}>
                                    <table className={styles.table}>
                                        <thead>
                                            <tr>
                                                <th>#</th>
                                                <th>outer</th>
                                                <th>inner</th>
                                                <th>t</th>
                                                <th>r</th>
                                                <th>SSE</th>
                                                <th>norm</th>
                                                <th>α/edit</th>
                                                <th>I/M</th>
                                                <th>overlap</th>
                                                <th>operations</th>
                                                <th>redundant</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {result.candidates.map((candidate) => (
                                                <tr
                                                    key={candidate.id}
                                                    className={`${styles.candidateRow}${selectedCandidate?.id === candidate.id ? ` ${styles.candidateRowSelected}` : ""}`}
                                                    onClick={() => setSelectedId(candidate.id)}
                                                >
                                                    <td>{candidate.rank}</td>
                                                    <td>{candidate.suggestedOuterYear}</td>
                                                    <td>{candidate.suggestedInnerYear}</td>
                                                    <td>{formatNumber(candidate.tValue)}</td>
                                                    <td>{formatNumber(candidate.correlation)}</td>
                                                    <td>{formatNumber(candidate.sumSquaredError, 2)}</td>
                                                    <td>{formatNumber(candidate.normalizedEditDistance, 4)}</td>
                                                    <td>{candidate.alpha}/{candidate.editCount}</td>
                                                    <td>{candidate.insertCount}/{candidate.mergeCount}</td>
                                                    <td>{candidate.overlap}</td>
                                                    <td className={styles.opsCell}>{summarizeAlphaEditOperations(candidate)}</td>
                                                    <td>{candidate.isRedundant ? candidate.redundancyReason ?? "yes" : "no"}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </section>

                            {selectedCandidate ? (
                                <section className={styles.section}>
                                    <h4 className={styles.sectionTitle}>Preview</h4>
                                    <div className={styles.previewBox}>
                                        {selectedCandidate.operations.length === 0 ? (
                                            <p>该候选是 α=0 的普通匹配，不包含插年或删年操作。</p>
                                        ) : selectedCandidate.operations.map((operation) => (
                                            <p key={`${operation.operationOrder}-${operation.operationType}`}>
                                                {operationTypeLabel(operation.operationType)}
                                                {" · "}
                                                target index {operation.targetBoundaryIndex ?? operation.recommendedDeleteIndex ?? "-"}
                                                {" · "}
                                                reference {operation.referenceYear}
                                                {" · "}
                                                cost {formatNumber(operation.costContribution, 4)}
                                            </p>
                                        ))}
                                        {selectedCandidate.warnings.length > 0 ? (
                                            <ul className={styles.warnings}>
                                                {selectedCandidate.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                                            </ul>
                                        ) : null}
                                    </div>
                                </section>
                            ) : null}

                            <div className={styles.actions}>
                                <button
                                    type="button"
                                    className={styles.secondary}
                                    disabled={!selectedCandidate}
                                    onClick={() => selectedCandidate && onPreview(selectedCandidate)}
                                >
                                    预览候选
                                </button>
                                <button
                                    type="button"
                                    className={styles.apply}
                                    disabled={!selectedCandidate || selectedCandidate.operations.length === 0}
                                    onClick={() => selectedCandidate && onApply(selectedCandidate)}
                                >
                                    应用候选
                                </button>
                            </div>
                        </>
                    ) : !error ? (
                        <p className={styles.subtitle}>计算中...</p>
                    ) : null}
                </div>
            </div>
        </div>,
        document.body,
    );
}

export function AlphaEditSuggestionPanel({
    seriesId,
    series,
    reference,
    referenceStale = false,
    disabled = false,
    onApplyCandidate,
    onPreviewCandidate,
}: AlphaEditSuggestionPanelProps) {
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<AlphaEditSuggestionResult | null>(null);
    const [error, setError] = useState("");
    const [open, setOpen] = useState(false);

    const disabledReason = useMemo(() => {
        if (disabled) return "当前序列不可计算插删年建议";
        if (!reference) return "需要先生成 COFECHA-pass 参考序列";
        if (reference.points.length === 0) return "COFECHA-pass 参考序列没有可用点";
        return "";
    }, [disabled, reference]);

    const referenceWarning = referenceStale
        ? "Reference 已过期，建议结果仅供参考。"
        : "";

    const handleRun = async () => {
        if (!reference || disabledReason || running) return;
        if (globalAlphaEditRunning) {
            setError("已有插删年建议任务正在运行，请等待当前任务完成。");
            setResult(null);
            setOpen(true);
            return;
        }

        setRunning(true);
        setError("");
        setResult(null);
        setOpen(true);
        globalAlphaEditRunning = true;

        try {
            const nextResult = await suggestInsertDeleteYearsAlphaEdit({
                seriesId,
                series,
                reference,
            });
            setResult(referenceWarning
                ? {
                    ...nextResult,
                    warnings: [referenceWarning, ...nextResult.warnings],
                }
                : nextResult);
        } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : String(nextError));
        } finally {
            globalAlphaEditRunning = false;
            setRunning(false);
        }
    };

    const handleApply = (candidate: AlphaEditCandidate) => {
        if (!result) return;
        onApplyCandidate?.(seriesId, result, candidate);
        setOpen(false);
    };

    const handlePreview = (candidate: AlphaEditCandidate) => {
        onPreviewCandidate?.(seriesId, candidate);
    };

    return (
        <span className={styles.root}>
            <button
                type="button"
                className={styles.button}
                disabled={running || Boolean(disabledReason)}
                title={disabledReason || `Wenk 2003 alpha-edit: alphaMax=${DEFAULT_ALPHA_EDIT_CONFIG.alphaMax}, minOverlap=${DEFAULT_ALPHA_EDIT_CONFIG.minOverlap}`}
                onClick={() => { void handleRun(); }}
            >
                {running ? "计算中..." : "定年建议"}
            </button>
            {open ? (
                <AlphaEditPopover
                    result={result}
                    error={error}
                    onClose={() => setOpen(false)}
                    onApply={handleApply}
                    onPreview={handlePreview}
                />
            ) : null}
        </span>
    );
}
