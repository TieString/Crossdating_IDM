import { createPortal } from "react-dom";
import { useMemo, useState } from "react";
import type { CofechaPassReference } from "@/features/crossdating/reference";
import {
    DEFAULT_BAYESIAN_MCMC_CONFIG,
    runBayesianDatingMcmc,
    type BayesianDatingCandidate,
    type BayesianMcmcDatingResult,
    type BayesianParameterStats,
} from "@/features/rwl/bayesianDating";
import type { RwlTreeData } from "@/features/rwl/types";
import styles from "./BayesianDateButton.module.css";

type BayesianDateButtonProps = {
     seriesId: string;
    series: RwlTreeData;
    reference: CofechaPassReference | null | undefined;
    disabled?: boolean;
    onApplyStartYear?: (
        seriesId: string,
        startYear: number,
        result: BayesianMcmcDatingResult,
        candidate: BayesianDatingCandidate,
    ) => void;
};

let globalBayesianDatingRunning = false;

const formatNumber = (value: number | null | undefined, digits = 3) => (
    typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—"
);

const formatPercent = (value: number | null | undefined) => (
    typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—"
);

const statusClassName = (status: string) => {
    switch (status) {
        case "accepted":
            return `${styles.status} ${styles.statusAccepted}`;
        case "rejected":
            return `${styles.status} ${styles.statusRejected}`;
        case "unavailable":
            return `${styles.status} ${styles.statusUnavailable}`;
        default:
            return `${styles.status} ${styles.statusAmbiguous}`;
    }
};

const summarizeCandidate = (candidate: BayesianDatingCandidate | null | undefined) => (
    candidate
        ? `${candidate.startYear}-${candidate.endYear} · ${formatPercent(candidate.posterior)}`
        : "—"
);

const parameterText = (stats: BayesianParameterStats) => (
    `${formatNumber(stats.mean)} ± ${formatNumber(stats.sd)} (${formatNumber(stats.q025)}, ${formatNumber(stats.median)}, ${formatNumber(stats.q975)})`
);

function ResultPopover({
    result,
    error,
    onClose,
    onApply,
}: {
    result: BayesianMcmcDatingResult | null;
    error: string;
    onClose: () => void;
    onApply: (candidate: BayesianDatingCandidate) => void;
}) {
    const [selectedStartYear, setSelectedStartYear] = useState<number | null>(null);
    const best = result?.best ?? null;
    const selectedCandidate = useMemo(() => (
        result?.candidates.find((candidate) => candidate.startYear === selectedStartYear)
        ?? best
    ), [best, result?.candidates, selectedStartYear]);
    const rHat = result?.diagnostics.rHat;
    const warningItems = result?.diagnostics.warnings ?? [];

    return createPortal(
        <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
            <div
                className={styles.popover}
                role="dialog"
                aria-modal="true"
                aria-label="贝叶斯定年结果"
                onMouseDown={(event) => event.stopPropagation()}
            >
                <div className={styles.header}>
                    <div>
                        <h3 className={styles.title}>贝叶斯定年</h3>
                        <p className={styles.subtitle}>{result?.targetSeriesId ?? "当前序列"}</p>
                    </div>
                    <button type="button" className={styles.close} onClick={onClose} aria-label="关闭">×</button>
                </div>
                <div className={styles.body}>
                    {error ? <p className={styles.error}>{error}</p> : null}
                    {result ? (
                        <>
                            <span className={statusClassName(result.decision.status)}>
                                {result.decision.status} · {result.decision.reason}
                            </span>

                            <section className={styles.section}>
                                <h4 className={styles.sectionTitle}>Posterior</h4>
                                <div className={styles.metrics}>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>最佳起始年</span>
                                        <span className={styles.metricValue}>{best?.startYear ?? "—"}</span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>最佳结束年</span>
                                        <span className={styles.metricValue}>{best?.endYear ?? "—"}</span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>后验概率</span>
                                        <span className={styles.metricValue}>{formatPercent(best?.posterior)}</span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>第二候选</span>
                                        <span className={styles.metricValue}>{summarizeCandidate(result.secondBest)}</span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>95% HPD 候选数</span>
                                        <span className={styles.metricValue}>{result.hpd95.length}</span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>overlap / r / t</span>
                                        <span className={styles.metricValue}>
                                            {best ? `${best.overlap} · ${formatNumber(best.correlation)} · ${formatNumber(best.tValue)}` : "—"}
                                        </span>
                                    </div>
                                </div>
                            </section>

                            <section className={styles.section}>
                                <h4 className={styles.sectionTitle}>MCMC</h4>
                                <div className={styles.metrics}>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>iterations / burn-in / thin</span>
                                        <span className={styles.metricValue}>
                                            {result.mcmcSummary.iterations} / {result.mcmcSummary.burnIn} / {result.mcmcSummary.thin}
                                        </span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>chains / retained</span>
                                        <span className={styles.metricValue}>
                                            {result.mcmcSummary.chains} / {result.mcmcSummary.retainedSamples}
                                        </span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>candidate count</span>
                                        <span className={styles.metricValue}>{result.candidateCount}</span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>reference range</span>
                                        <span className={styles.metricValue}>{result.referenceStartYear}-{result.referenceEndYear}</span>
                                    </div>
                                </div>
                            </section>

                            <section className={styles.section}>
                                <h4 className={styles.sectionTitle}>Parameters</h4>
                                <div className={styles.metrics}>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>β</span>
                                        <span className={styles.metricValue}>{parameterText(result.parameterSummary.beta)}</span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>σ²u</span>
                                        <span className={styles.metricValue}>{parameterText(result.parameterSummary.sigmaU2)}</span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>σ²e</span>
                                        <span className={styles.metricValue}>{parameterText(result.parameterSummary.sigmaE2)}</span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>S</span>
                                        <span className={styles.metricValue}>{parameterText(result.parameterSummary.signalToNoise)}</span>
                                    </div>
                                </div>
                            </section>

                            <section className={styles.section}>
                                <h4 className={styles.sectionTitle}>Diagnostics</h4>
                                <div className={styles.metrics}>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>R-hat β / σ²u / σ²e / S</span>
                                        <span className={styles.metricValue}>
                                            {formatNumber(rHat?.beta)} / {formatNumber(rHat?.sigmaU2)} / {formatNumber(rHat?.sigmaE2)} / {formatNumber(rHat?.signalToNoise)}
                                        </span>
                                    </div>
                                    <div className={styles.metric}>
                                        <span className={styles.metricLabel}>chain top agreement</span>
                                        <span className={styles.metricValue}>{result.diagnostics.chainTopAgreement ? "yes" : "no"}</span>
                                    </div>
                                </div>
                                {warningItems.length > 0 ? (
                                    <ul className={styles.warnings}>
                                        {warningItems.map((warning) => <li key={warning}>{warning}</li>)}
                                    </ul>
                                ) : null}
                            </section>

                            <section className={styles.section}>
                                <h4 className={styles.sectionTitle}>Top Candidates</h4>
                                <div className={styles.tableWrap}>
                                    <table className={styles.table}>
                                        <thead>
                                            <tr>
                                                <th></th>
                                                <th>start</th>
                                                <th>end</th>
                                                <th>posterior</th>
                                                <th>samples</th>
                                                <th>overlap</th>
                                                <th>r</th>
                                                <th>t</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {result.candidates.slice(0, 10).map((candidate) => (
                                                <tr
                                                    key={candidate.startYear}
                                                    className={`${styles.candidateRow}${selectedCandidate?.startYear === candidate.startYear ? ` ${styles.candidateRowSelected}` : ""}`}
                                                    onClick={() => setSelectedStartYear(candidate.startYear)}
                                                    title={`选择 ${candidate.startYear}-${candidate.endYear}`}
                                                >
                                                    <td>
                                                        {selectedCandidate?.startYear === candidate.startYear ? (
                                                            <span className={styles.selectedMark}>✓</span>
                                                        ) : null}
                                                    </td>
                                                    <td>{candidate.startYear}</td>
                                                    <td>{candidate.endYear}</td>
                                                    <td>{formatPercent(candidate.posterior)}</td>
                                                    <td>{candidate.sampleCount}</td>
                                                    <td>{candidate.overlap}</td>
                                                    <td>{formatNumber(candidate.correlation)}</td>
                                                    <td>{formatNumber(candidate.tValue)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </section>

                            <div className={styles.actions}>
                                <button
                                    type="button"
                                    className={styles.apply}
                                    disabled={!selectedCandidate}
                                    onClick={() => selectedCandidate && onApply(selectedCandidate)}
                                >
                                    应用选中候选
                                </button>
                            </div>
                        </>
                    ) : !error ? (
                        <p className={styles.subtitle}>定年中…</p>
                    ) : null}
                </div>
            </div>
        </div>,
        document.body,
    );
}

export function BayesianDateButton({
    seriesId,
    series,
    reference,
    disabled = false,
    onApplyStartYear,
}: BayesianDateButtonProps) {
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<BayesianMcmcDatingResult | null>(null);
    const [error, setError] = useState("");
    const [open, setOpen] = useState(false);

    const disabledReason = useMemo(() => {
        if (disabled) return "当前序列不可定年";
        if (!reference) return "需要先生成动态 COFECHA 参考序列";
        if (reference.source !== "cofecha_pass_anchor" && reference.source !== "cofecha_master_series") {
            return "需要使用动态 COFECHA 参考序列";
        }
        if (reference.points.length === 0) return "动态 COFECHA 参考序列没有可用点";
        return "";
     }, [disabled, reference]);

    const handleRun = async () => {
        if (!reference || disabledReason || running) return;
        if (globalBayesianDatingRunning) {
            setError("已有贝叶斯定年任务正在运行，请等待当前任务完成。");
            setResult(null);
            setOpen(true);
            return;
        }

        setRunning(true);
        setError("");
        setResult(null);
        setOpen(true);
        globalBayesianDatingRunning = true;

        try {
           const nextResult = await runBayesianDatingMcmc({
                targetSeriesId: seriesId,
                series,
                reference,
            });
            setResult(nextResult);
        } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : String(nextError));
        } finally {
            globalBayesianDatingRunning = false;
            setRunning(false);
        }
    };

    const handleApply = (candidate: BayesianDatingCandidate) => {
        if (!result) return;
        onApplyStartYear?.(seriesId, candidate.startYear, result, candidate);
        setOpen(false);
    };

    return (
        <span className={styles.root}>
            <button
                type="button"
                className={styles.button}
                disabled={running || Boolean(disabledReason)}
                title={disabledReason || `贝叶斯定年 默认 MCMC：${DEFAULT_BAYESIAN_MCMC_CONFIG.chains} chains × ${DEFAULT_BAYESIAN_MCMC_CONFIG.iterations} iterations`}
                onClick={() => { void handleRun(); }}
            >
                {running ? "确定中…" : "年代确定"}
            </button>
            {open ? (
                <ResultPopover
                    result={result}
                    error={error}
                    onClose={() => setOpen(false)}
                    onApply={handleApply}
                />
            ) : null}
        </span>
    );
}
