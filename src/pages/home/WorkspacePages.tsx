import { Suspense, lazy, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { FloatingScrollArea } from "@/components/FloatingScrollArea/FloatingScrollArea";
import { cofechaReportShowsPart6, findCofechaPart6Anchor, scrollCofechaAnchorIntoView } from "./cofechaReportAnchor";
import { RollingNumber } from "@/components/RollingNumber/RollingNumber";
import type {
    CrossdatingDiagnosis,
    DiagnosisBatchApplyResult,
    DiagnosisCandidateOperation,
    LocalSimulationApplyRequest,
} from "@/features/crossdating/diagnosis";
import type { CrossdatingValidationSummary } from "@/features/crossdating/validation";
import type { ReferenceSeriesConfig } from "@/features/crossdating/reference";
import type { ICofechaResult } from "@/features/cofecha/types";
import type { DeleteMode, DeleteShift, MissingInsertSide, RwlOperationLogEntry, RwlOperationSource } from "@/features/rwl/edit";
import type { RwlSiteData } from "@/features/rwl/types";
import styles from "./WorkspacePages.module.css";

const LazyTreeChartManager = lazy(async () => {
    const module = await import("@/components/Chart/TreeChartManager");
    return { default: module.TreeChartManager };
});

export type CofechaPartOption = {
    value: string;
    label: string;
};

type PageShellProps = {
    title: string;
    subtitle?: string;
    actions?: ReactNode;
    children: ReactNode;
    onClose: () => void;
};

function PageShell({ title, subtitle, actions, children, onClose }: PageShellProps) {
    return (
        <motion.section
            className={styles["workspace-page"]}
            initial={{ opacity: 0, y: 18, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.985 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
            <header className={styles["workspace-header"]}>
                <div className={styles["workspace-title-block"]}>
                    <h1>{title}</h1>
                    {subtitle ? <p>{subtitle}</p> : null}
                </div>
                <div className={styles["workspace-actions"]}>
                    {actions}
                    <button
                        type="button"
                        className={styles["icon-button"]}
                        title="关闭"
                        aria-label="关闭"
                        onClick={onClose}
                    >
                        ×
                    </button>
                </div>
            </header>
            <div className={styles["workspace-body"]}>
                {children}
            </div>
        </motion.section>
    );
}

const formatLogTime = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).format(date);
};

const operationSourceLabels: Record<RwlOperationSource, string> = {
    manual: "手动",
    "reference-assisted": "参考",
    "cofecha-assisted": "COFECHA",
    "auto-suggested": "建议",
    imported: "导入",
    system: "系统",
};

type OperationLogStateFilter = "all" | "applied" | "reverted" | "undoable" | "redoable" | "batch";

const operationLogStateFilterOptions: Array<{ value: OperationLogStateFilter; label: string }> = [
    { value: "all", label: "全部状态" },
    { value: "applied", label: "已应用" },
    { value: "reverted", label: "已回滚" },
    { value: "undoable", label: "可撤销" },
    { value: "redoable", label: "可重做" },
    { value: "batch", label: "批次" },
];

const formatAffectedRange = (entry: RwlOperationLogEntry) => {
    if (entry.affectedRange) {
        const { startYear, endYear } = entry.affectedRange;
        return startYear === endYear ? String(startYear) : `${startYear}-${endYear}`;
    }
    return entry.targetYear == null ? null : String(entry.targetYear);
};

const formatMetricValue = (value: number | string | null) => {
    if (value === null) return "-";
    if (typeof value === "number") {
        return Number.isInteger(value) ? String(value) : value.toFixed(3);
    }
    return value;
};

const formatLogValue = (value: number | null | undefined) => {
    if (value === undefined) return "未记录";
    if (value === null) return "缺失";
    return formatMetricValue(value);
};

const formatValueChange = (entry: RwlOperationLogEntry) => {
    if (entry.oldValue === undefined && entry.newValue === undefined) return null;
    return `值 ${formatLogValue(entry.oldValue)} → ${formatLogValue(entry.newValue)}`;
};

const formatYearChange = (entry: RwlOperationLogEntry) => {
    if (entry.oldYear === undefined || entry.newYear === undefined || entry.oldYear === entry.newYear) return null;
    return `年份 ${entry.oldYear} → ${entry.newYear}`;
};

const formatShortId = (value: string | undefined) => {
    if (!value) return null;
    return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
};

const formatMetrics = (
    prefix: string,
    metrics: Record<string, number | string | null> | undefined,
) => (
    Object.entries(metrics ?? {}).map(([key, value]) => `${prefix}.${key}: ${formatMetricValue(value)}`)
);

type OperationLogPageProps = {
    fileName: string | null;
    operationLog: RwlOperationLogEntry[];
    canResetToRawData: boolean;
    onUndoEntry: (entryId: string) => void | Promise<void>;
    onUndoBatch: (batchId: string) => void | Promise<void>;
    onRedoEntry: (entryId: string) => void | Promise<void>;
    onJumpEntry: (tree: string, year?: number) => void | Promise<void>;
    onResetToRawData: () => void | Promise<void>;
    onClose: () => void;
};

export function OperationLogPage({
    fileName,
    operationLog,
    canResetToRawData,
    onUndoEntry,
    onUndoBatch,
    onRedoEntry,
    onJumpEntry,
    onResetToRawData,
    onClose,
}: OperationLogPageProps) {
    const [logQuery, setLogQuery] = useState("");
    const [sourceFilter, setSourceFilter] = useState<RwlOperationSource | "all">("all");
    const [stateFilter, setStateFilter] = useState<OperationLogStateFilter>("all");
    const filteredOperationLog = useMemo(() => {
        const query = logQuery.trim().toLowerCase();

        return operationLog.filter((entry) => {
            const source = entry.source ?? "manual";
            const isReverted = entry.isReverted ?? Boolean(entry.undone);
            const isApplied = entry.isApplied ?? !isReverted;

            if (sourceFilter !== "all" && source !== sourceFilter) {
                return false;
            }
            if (stateFilter === "applied" && (!isApplied || isReverted)) {
                return false;
            }
            if (stateFilter === "reverted" && !isReverted) {
                return false;
            }
            if (stateFilter === "undoable" && !entry.canUndo) {
                return false;
            }
            if (stateFilter === "redoable" && !entry.canRedo) {
                return false;
            }
            if (stateFilter === "batch" && !entry.batchId) {
                return false;
            }

            if (!query) {
                return true;
            }

            const searchable = [
                entry.sequence,
                entry.tree,
                entry.summary,
                entry.detail,
                entry.operationType,
                operationSourceLabels[source],
                source,
                entry.reason,
                entry.targetYear,
                entry.targetIndex,
                entry.oldValue,
                entry.newValue,
                entry.oldYear,
                entry.newYear,
                entry.batchId,
                entry.parentOperationId,
                formatAffectedRange(entry),
                ...formatMetrics("before", entry.metricsBefore),
                ...formatMetrics("after", entry.metricsAfter),
            ].filter((value) => value !== undefined && value !== null).join(" ").toLowerCase();

            return searchable.includes(query);
        });
    }, [logQuery, operationLog, sourceFilter, stateFilter]);

    const sequenceGroups = useMemo(() => {
        const groups = new Map<string, RwlOperationLogEntry[]>();
        filteredOperationLog.forEach((entry) => {
            const tree = entry.tree ?? "未分组";
            groups.set(tree, [...(groups.get(tree) ?? []), entry]);
        });
        return Array.from(groups.entries())
            .map(([tree, entries]) => ({ tree, entries: [...entries].reverse() }))
            .sort((a, b) => a.tree.localeCompare(b.tree));
    }, [filteredOperationLog]);
    const undoableCount = operationLog.filter((entry) => entry.canUndo).length;
    const redoableCount = operationLog.filter((entry) => entry.canRedo).length;
    const appliedCount = operationLog.filter((entry) => entry.isApplied ?? !entry.undone).length;
    const revertedCount = operationLog.filter((entry) => entry.isReverted ?? Boolean(entry.undone)).length;
    const referenceCount = operationLog.filter((entry) => entry.source === "reference-assisted").length;
    const suggestedCount = operationLog.filter((entry) => entry.source === "auto-suggested").length;
    const cofechaCount = operationLog.filter((entry) => entry.source === "cofecha-assisted").length;
    const batchCount = new Set(operationLog.map((entry) => entry.batchId).filter(Boolean)).size;
    const batchSummaries = useMemo(() => {
        const groups = new Map<string, RwlOperationLogEntry[]>();
        filteredOperationLog.forEach((entry) => {
            if (!entry.batchId) return;
            groups.set(entry.batchId, [...(groups.get(entry.batchId) ?? []), entry]);
        });

        return Array.from(groups.entries())
            .map(([batchId, entries]) => {
                const latestTimestamp = entries
                    .map((entry) => new Date(entry.timestamp).getTime())
                    .filter(Number.isFinite)
                    .sort((a, b) => b - a)[0] ?? 0;
                const reverted = entries.filter((entry) => entry.isReverted ?? Boolean(entry.undone)).length;
                return {
                    batchId,
                    latestTimestamp,
                    total: entries.length,
                    applied: entries.length - reverted,
                    reverted,
                    canUndo: entries.some((entry) => entry.canUndoBatch),
                    trees: Array.from(new Set(entries.map((entry) => entry.tree).filter((tree): tree is string => Boolean(tree)))),
                };
            })
            .sort((a, b) => b.latestTimestamp - a.latestTimestamp)
            .slice(0, 5);
    }, [filteredOperationLog]);

    return (
        <PageShell
            title="操作日志"
            subtitle={fileName ?? "未打开文件"}
            onClose={onClose}
        >
            <div className={styles["log-layout"]}>
                <aside className={styles["log-summary"]}>
                    <div className={styles["summary-number"]}>
                        <span>显示 / 总计</span>
                        <strong>{filteredOperationLog.length}</strong>
                        <small>{operationLog.length} 条日志</small>
                    </div>
                    <div className={styles["log-filter-panel"]}>
                        <label>
                            <span>搜索</span>
                            <input
                                type="search"
                                value={logQuery}
                                placeholder="序列、年份、批次、原因"
                                onChange={(event) => setLogQuery(event.target.value)}
                            />
                        </label>
                        <div className={styles["log-filter-row"]}>
                            <label>
                                <span>来源</span>
                                <select
                                    value={sourceFilter}
                                    onChange={(event) => setSourceFilter(event.target.value as RwlOperationSource | "all")}
                                >
                                    <option value="all">全部来源</option>
                                    {Object.entries(operationSourceLabels).map(([source, label]) => (
                                        <option key={source} value={source}>{label}</option>
                                    ))}
                                </select>
                            </label>
                            <label>
                                <span>状态</span>
                                <select
                                    value={stateFilter}
                                    onChange={(event) => setStateFilter(event.target.value as OperationLogStateFilter)}
                                >
                                    {operationLogStateFilterOptions.map((option) => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                </select>
                            </label>
                        </div>
                    </div>
                    <div className={styles["summary-grid"]}>
                        <span>序列</span><strong>{sequenceGroups.length}</strong>
                        <span>已应用</span><strong>{appliedCount}</strong>
                        <span>已回滚</span><strong>{revertedCount}</strong>
                        <span>可撤销</span><strong>{undoableCount}</strong>
                        <span>可重做</span><strong>{redoableCount}</strong>
                        <span>参考记录</span><strong>{referenceCount}</strong>
                        <span>建议记录</span><strong>{suggestedCount}</strong>
                        <span>COFECHA</span><strong>{cofechaCount}</strong>
                        <span>批次</span><strong>{batchCount}</strong>
                    </div>
                    <div className={styles["summary-actions"]}>
                        <button
                            type="button"
                            className={styles["command-button"]}
                            disabled={!canResetToRawData}
                            title="恢复到首次加载该文件时的原始序列"
                            onClick={() => { void onResetToRawData(); }}
                        >
                            回到原始
                        </button>
                    </div>
                    {batchSummaries.length > 0 ? (
                        <div className={styles["batch-summary-list"]}>
                            <div className={styles["batch-summary-title"]}>建议批次</div>
                            {batchSummaries.map((batch) => (
                                <div key={batch.batchId} className={styles["batch-summary-item"]}>
                                    <div className={styles["batch-summary-copy"]}>
                                        <strong title={batch.batchId}>{formatShortId(batch.batchId)}</strong>
                                        <span>{batch.total} 条 · 应用 {batch.applied} · 回滚 {batch.reverted}</span>
                                        <small title={batch.trees.join(", ")}>
                                            {batch.trees.slice(0, 3).join(", ") || "未分组"}
                                        </small>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={!batch.canUndo}
                                        title={batch.canUndo ? `整批回滚 ${batch.batchId}` : "该批次当前不能完整回滚"}
                                        onClick={() => { void onUndoBatch(batch.batchId); }}
                                    >
                                        回滚
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    <FloatingScrollArea className={styles["sequence-list"]}>
                        {sequenceGroups.map((group) => (
                            <a key={group.tree} href={`#log-tree-${encodeURIComponent(group.tree)}`}>
                                <span>{group.tree}</span>
                                <strong>{group.entries.length}</strong>
                            </a>
                        ))}
                    </FloatingScrollArea>
                </aside>

                <FloatingScrollArea className={styles["log-scroll"]}>
                    {filteredOperationLog.length === 0 ? (
                        <motion.div
                            className={styles["empty-state"]}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                        >
                            {operationLog.length === 0 ? "还没有序列操作。" : "没有匹配的操作记录。"}
                        </motion.div>
                    ) : (
                        <div className={styles["log-list"]}>
                            {sequenceGroups.map((group, groupIndex) => (
                                <section
                                    key={group.tree}
                                    id={`log-tree-${encodeURIComponent(group.tree)}`}
                                    className={styles["log-group"]}
                                >
                                    <h2>{group.tree}</h2>
                                    {group.entries.map((entry, index) => (
                                        (() => {
                                            const source = entry.source ?? "manual";
                                            const range = formatAffectedRange(entry);
                                            const jumpYear = entry.targetYear ?? entry.affectedRange?.startYear;
                                            const isReverted = entry.isReverted ?? Boolean(entry.undone);
                                            const isApplied = entry.isApplied ?? !isReverted;
                                            const stateLabel = isReverted ? "已回滚" : isApplied ? "已应用" : "待确认";
                                            const stateClass = isReverted ? styles["action-undone"] : styles["action-apply"];
                                            const canJump = Boolean(
                                                entry.tree
                                                && source !== "reference-assisted"
                                                && source !== "cofecha-assisted"
                                            );
                                            const sourceClass = styles[`source-${source}`] ?? "";
                                            const canUndoBatch = Boolean(entry.canUndoBatch);
                                            const metricLabels = [
                                                ...formatMetrics("before", entry.metricsBefore),
                                                ...formatMetrics("after", entry.metricsAfter),
                                            ];
                                            const auditLabels = [
                                                formatValueChange(entry),
                                                formatYearChange(entry),
                                                entry.targetIndex === undefined ? null : `index ${entry.targetIndex}`,
                                                entry.createdBy ? `by ${entry.createdBy}` : null,
                                                entry.batchId ? `batch ${formatShortId(entry.batchId)}` : null,
                                                entry.parentOperationId ? `parent ${formatShortId(entry.parentOperationId)}` : null,
                                            ].filter((label): label is string => Boolean(label));
                                            return (
                                        <motion.article
                                            layout
                                            key={entry.id}
                                            className={styles["log-entry"]}
                                            initial={{ opacity: 0, x: 16 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            transition={{ duration: 0.18, delay: Math.min((groupIndex + index) * 0.012, 0.12) }}
                                        >
                                            <div className={styles["log-entry-main"]}>
                                                <span className={`${styles["action-badge"]} ${stateClass}`}>
                                                    {stateLabel}
                                                </span>
                                                <div className={styles["log-entry-copy"]}>
                                                    <div className={styles["log-entry-title-row"]}>
                                                        <h3>{entry.summary}</h3>
                                                        <span className={`${styles["source-badge"]} ${sourceClass}`}>
                                                            {operationSourceLabels[source]}
                                                        </span>
                                                    </div>
                                                    <p>{entry.detail}</p>
                                                    {(entry.operationType || range || auditLabels.length > 0) ? (
                                                        <p className={styles["log-entry-details"]}>
                                                            {entry.operationType ? <span>{entry.operationType}</span> : null}
                                                            {range ? <span>{range}</span> : null}
                                                            {auditLabels.map((label) => <span key={label}>{label}</span>)}
                                                        </p>
                                                    ) : null}
                                                    {(entry.reason || metricLabels.length > 0) ? (
                                                        <p className={styles["log-entry-details"]}>
                                                            {entry.reason ? <span>{entry.reason}</span> : null}
                                                            {metricLabels.map((label) => <span key={label}>{label}</span>)}
                                                        </p>
                                                    ) : null}
                                                </div>
                                            </div>
                                            <div className={styles["log-entry-side"]}>
                                                <div className={styles["log-entry-controls"]}>
                                                    <button
                                                        type="button"
                                                        disabled={!canJump}
                                                        title={jumpYear == null ? "定位到序列" : `定位到 ${entry.tree} ${jumpYear}`}
                                                        onClick={() => {
                                                            if (entry.tree) {
                                                                void onJumpEntry(entry.tree, jumpYear);
                                                            }
                                                        }}
                                                    >
                                                        ⌖
                                                    </button>
                                                    <button
                                                        type="button"
                                                        disabled={!canUndoBatch}
                                                        aria-label={entry.batchId ? `整批回滚 ${entry.batchId}` : "该记录不属于批次"}
                                                        title={entry.batchId
                                                            ? canUndoBatch
                                                                ? `整批回滚 ${entry.batchId}`
                                                                : "该批次当前不能完整回滚"
                                                            : "该记录不属于批次"}
                                                        onClick={() => {
                                                            if (entry.batchId) {
                                                                void onUndoBatch(entry.batchId);
                                                            }
                                                        }}
                                                    >
                                                        批
                                                    </button>
                                                    <button
                                                        type="button"
                                                        disabled={!entry.canUndo}
                                                        title="撤销该条操作"
                                                        onClick={() => { void onUndoEntry(entry.id); }}
                                                    >
                                                        ↶
                                                    </button>
                                                    <button
                                                        type="button"
                                                        disabled={!entry.canRedo}
                                                        title="重做该条操作"
                                                        onClick={() => { void onRedoEntry(entry.id); }}
                                                    >
                                                        ↷
                                                    </button>
                                                </div>
                                                <div className={styles["log-entry-meta"]}>
                                                    <span>#{entry.sequence}</span>
                                                    <span>{formatLogTime(entry.timestamp)}</span>
                                                </div>
                                            </div>
                                        </motion.article>
                                            );
                                        })()
                                    ))}
                                </section>
                            ))}
                        </div>
                    )}
                </FloatingScrollArea>
            </div>
        </PageShell>
    );
}

type CofechaReportPageProps = {
    cofechaResult?: Partial<Pick<
        ICofechaResult,
        "possibleProblemsCount" |
        "masterSeriesYear" |
        "seriesIntercorrelation" |
        "averageMeanSensitivity" |
        "meanLength"
    >>;
    isCofechaOutdated: boolean;
    isCofechaRunning: boolean;
    canRunValidation: boolean;
    validationSummary: CrossdatingValidationSummary;
    linkedReport: { html: string; count: number };
    partOptions: CofechaPartOption[];
    selectedPart: string;
    jumpTarget?: { id: number; tree: string };
    onSelectedPartChange: (part: string) => void;
    onRunValidation: () => void | Promise<void>;
    onTextClick: (event: MouseEvent<HTMLParagraphElement>) => void;
    onTextKeyDown: (event: KeyboardEvent<HTMLParagraphElement>) => void;
    onClose: () => void;
};

export function CofechaReportPage({
    cofechaResult,
    isCofechaOutdated,
    isCofechaRunning,
    canRunValidation,
    validationSummary,
    linkedReport,
    partOptions,
    selectedPart,
    jumpTarget,
    onSelectedPartChange,
    onRunValidation,
    onTextClick,
    onTextKeyDown,
    onClose,
}: CofechaReportPageProps) {
    const reportScrollRef = useRef<HTMLDivElement | null>(null);
    const handledJumpIdRef = useRef<number | null>(null);

    // 主窗口下发跳转目标时，滚动到对应序列的 PART 6 标题（高亮已随 HTML 一起到达）。
    useEffect(() => {
        if (!jumpTarget || handledJumpIdRef.current === jumpTarget.id) {
            return;
        }
        if (!cofechaReportShowsPart6(selectedPart)) {
            return; // 等主窗口把视图同步到含 PART 6 区段（全部内容或 PART 6）后再滚动
        }
        const scroller = reportScrollRef.current;
        if (!scroller) {
            return;
        }
        handledJumpIdRef.current = jumpTarget.id;
        const anchor = findCofechaPart6Anchor(scroller, jumpTarget.tree);
        if (anchor) {
            scrollCofechaAnchorIntoView(scroller, anchor);
        }
    }, [jumpTarget, selectedPart, linkedReport]);

    return (
        <PageShell
            title="COFECHA"
            subtitle={isCofechaOutdated ? "VERYCOF.OUT · 上次结果" : "VERYCOF.OUT"}
            onClose={onClose}
        >
            <div className={styles["report-layout"]}>
                <div className={styles["report-stats"]}>
                    <span><small>*A*</small><strong><RollingNumber value={cofechaResult?.possibleProblemsCount} /></strong></span>
                    <span><small>Master</small><strong><RollingNumber value={cofechaResult?.masterSeriesYear} /></strong></span>
                    <span><small>Intercorr.</small><strong><RollingNumber value={cofechaResult?.seriesIntercorrelation} /></strong></span>
                    <span><small>Sensitivity</small><strong><RollingNumber value={cofechaResult?.averageMeanSensitivity} /></strong></span>
                    <span><small>Length</small><strong><RollingNumber value={cofechaResult?.meanLength} /></strong></span>
                </div>
                <div className={`${styles["validation-summary"]} ${styles[`validation-${validationSummary.severity}`]}`}>
                    <div>
                        <strong>{validationSummary.title}</strong>
                        <span>{validationSummary.detail}</span>
                    </div>
                    {validationSummary.items.length > 0 ? (
                        <ul>
                            {validationSummary.items.slice(0, 4).map((item) => (
                                <li key={item}>{item}</li>
                            ))}
                        </ul>
                    ) : null}
                </div>

                <div className={styles["report-toolbar"]}>
                    <select
                        value={selectedPart}
                        onChange={(event) => onSelectedPartChange(event.target.value)}
                    >
                        {partOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                    <span>{linkedReport.count} 跳转链接</span>
                    {isCofechaOutdated ? (
                        <span
                            className={styles["report-status"]}
                            title="当前 RWL 工作数据或 COFECHA 版本已变化，可以手动重新验证当前工作数据。"
                        >
                            待验证
                        </span>
                    ) : null}
                    <button
                        type="button"
                        className={styles["report-command"]}
                        disabled={!canRunValidation || isCofechaRunning}
                        title={canRunValidation ? "用当前工作数据重新运行 COFECHA" : "打开 RWL 文件后才能运行 COFECHA"}
                        onClick={() => { void onRunValidation(); }}
                    >
                        {isCofechaRunning ? "验证中" : "重新验证"}
                    </button>
                </div>

                <FloatingScrollArea ref={reportScrollRef} className={styles["report-scroll"]}>
                    <p
                        className={styles["report-text"]}
                        onClick={onTextClick}
                        onKeyDown={onTextKeyDown}
                        dangerouslySetInnerHTML={{ __html: linkedReport.html }}
                    />
                </FloatingScrollArea>
            </div>
        </PageShell>
    );
}

type ExpandedChartPageProps = {
    siteData: RwlSiteData;
    referenceConfig: ReferenceSeriesConfig | null;
    diagnosis: CrossdatingDiagnosis;
    diagnosisBatchResult: DiagnosisBatchApplyResult | null;
    onReferenceConfigChange: (config: ReferenceSeriesConfig | null) => void;
    onApplyDiagnosisCandidate: (candidate: DiagnosisCandidateOperation) => void;
    onApplyDiagnosisCandidateBatch: (candidates: DiagnosisCandidateOperation[]) => void;
    onApplyLocalSimulation: (request: LocalSimulationApplyRequest) => void;
    onInsertMissingYearAtSide: (tree: string, year: number, side: MissingInsertSide) => void;
    onDeleteYearWithMode: (tree: string, year: number, mode: DeleteMode, shift?: DeleteShift) => void;
    onDeleteSeries: (tree: string) => void;
    onClose: () => void;
};

export function ExpandedChartPage({
    siteData,
    referenceConfig,
    diagnosis,
    diagnosisBatchResult,
    onReferenceConfigChange,
    onApplyDiagnosisCandidate,
    onApplyDiagnosisCandidateBatch,
    onApplyLocalSimulation,
    onInsertMissingYearAtSide,
    onDeleteYearWithMode,
    onDeleteSeries,
    onClose,
}: ExpandedChartPageProps) {
    const stats = useMemo(() => {
        let pointCount = 0;
        let minYear = Number.POSITIVE_INFINITY;
        let maxYear = Number.NEGATIVE_INFINITY;

        siteData.forEach((treeData) => {
            treeData.forEach((value, year) => {
                if (typeof value !== "number" || value <= 0) return;
                pointCount += 1;
                minYear = Math.min(minYear, year);
                maxYear = Math.max(maxYear, year);
            });
        });

        return {
            seriesCount: siteData.size,
            pointCount,
            yearSpan: Number.isFinite(minYear) && Number.isFinite(maxYear) ? `${minYear}-${maxYear}` : "-",
        };
    }, [siteData]);

    const diagnosisSubtitle = diagnosis.problemSegmentCount > 0
        ? ` · 诊断 ${diagnosis.problemSegmentCount} 段 · 候选 ${diagnosis.candidateCount}`
        : " · 诊断未发现明显问题";

    return (
        <PageShell
            title="Line Chart"
            subtitle={`${stats.seriesCount} 条序列 · ${stats.pointCount} 个观测 · ${stats.yearSpan}${diagnosisSubtitle}`}
            onClose={onClose}
        >
            <div className={styles["chart-page"]}>
                <Suspense fallback={<div className={styles["chart-loading"]}>正在加载折线图...</div>}>
                    <LazyTreeChartManager
                        variant="expanded"
                        fullData={siteData}
                        referenceConfig={referenceConfig}
                        diagnosis={diagnosis}
                        diagnosisBatchResult={diagnosisBatchResult}
                        onReferenceConfigChange={onReferenceConfigChange}
                        onApplyDiagnosisCandidate={onApplyDiagnosisCandidate}
                        onApplyDiagnosisCandidateBatch={onApplyDiagnosisCandidateBatch}
                        onApplyLocalSimulation={onApplyLocalSimulation}
                        onInsertMissingYearAtSide={onInsertMissingYearAtSide}
                        onDeleteYearWithMode={onDeleteYearWithMode}
                        onDeleteSeries={onDeleteSeries}
                    />
                </Suspense>
            </div>
        </PageShell>
    );
}
