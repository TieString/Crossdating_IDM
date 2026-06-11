import { useMemo, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { TreeChartManager } from "@/components/Chart/TreeChartManager";
import { OverlayScroll } from "@/components/OverlayScroll/OverlayScroll";
import { RollingNumber } from "@/components/RollingNumber/RollingNumber";
import type { ICofechaResult } from "@/features/cofecha/types";
import type { DeleteMode, MissingInsertSide, RwlOperationLogEntry } from "@/features/rwl/edit";
import type { RwlSiteData } from "@/features/rwl/types";
import styles from "./WorkspacePages.module.css";

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

type OperationLogPageProps = {
    fileName: string | null;
    operationLog: RwlOperationLogEntry[];
    onUndoEntry: (entryId: string) => void | Promise<void>;
    onRedoEntry: (entryId: string) => void | Promise<void>;
    onClose: () => void;
};

export function OperationLogPage({
    fileName,
    operationLog,
    onUndoEntry,
    onRedoEntry,
    onClose,
}: OperationLogPageProps) {
    const sequenceGroups = useMemo(() => {
        const groups = new Map<string, RwlOperationLogEntry[]>();
        operationLog.forEach((entry) => {
            const tree = entry.tree ?? "未分组";
            groups.set(tree, [...(groups.get(tree) ?? []), entry]);
        });
        return Array.from(groups.entries())
            .map(([tree, entries]) => ({ tree, entries: [...entries].reverse() }))
            .sort((a, b) => a.tree.localeCompare(b.tree));
    }, [operationLog]);
    const undoableCount = operationLog.filter((entry) => entry.canUndo).length;
    const redoableCount = operationLog.filter((entry) => entry.canRedo).length;

    return (
        <PageShell
            title="操作日志"
            subtitle={fileName ?? "未打开文件"}
            onClose={onClose}
        >
            <div className={styles["log-layout"]}>
                <aside className={styles["log-summary"]}>
                    <div className={styles["summary-number"]}>
                        <span>日志</span>
                        <strong>{operationLog.length}</strong>
                    </div>
                    <div className={styles["summary-grid"]}>
                        <span>序列</span><strong>{sequenceGroups.length}</strong>
                        <span>可撤销</span><strong>{undoableCount}</strong>
                        <span>可重做</span><strong>{redoableCount}</strong>
                    </div>
                    <div className={styles["sequence-list"]}>
                        {sequenceGroups.map((group) => (
                            <a key={group.tree} href={`#log-tree-${encodeURIComponent(group.tree)}`}>
                                <span>{group.tree}</span>
                                <strong>{group.entries.length}</strong>
                            </a>
                        ))}
                    </div>
                </aside>

                <OverlayScroll className={styles["log-scroll"]}>
                    {operationLog.length === 0 ? (
                        <motion.div
                            className={styles["empty-state"]}
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                        >
                            还没有序列操作。
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
                                        <motion.article
                                            layout
                                            key={entry.id}
                                            className={styles["log-entry"]}
                                            initial={{ opacity: 0, x: 16 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            transition={{ duration: 0.18, delay: Math.min((groupIndex + index) * 0.012, 0.12) }}
                                        >
                                            <div className={styles["log-entry-main"]}>
                                                <span className={`${styles["action-badge"]} ${entry.undone ? styles["action-undone"] : styles["action-apply"]}`}>
                                                    {entry.undone ? "已撤销" : "执行"}
                                                </span>
                                                <div className={styles["log-entry-copy"]}>
                                                    <h3>{entry.summary}</h3>
                                                    <p>{entry.detail}</p>
                                                </div>
                                            </div>
                                            <div className={styles["log-entry-side"]}>
                                                <div className={styles["log-entry-controls"]}>
                                                    <button
                                                        type="button"
                                                        disabled={!entry.canUndo}
                                                        onClick={() => { void onUndoEntry(entry.id); }}
                                                    >
                                                        ↶
                                                    </button>
                                                    <button
                                                        type="button"
                                                        disabled={!entry.canRedo}
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
                                    ))}
                                </section>
                            ))}
                        </div>
                    )}
                </OverlayScroll>
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
    linkedReport: { html: string; count: number };
    partOptions: CofechaPartOption[];
    selectedPart: string;
    onSelectedPartChange: (part: string) => void;
    onTextClick: (event: MouseEvent<HTMLParagraphElement>) => void;
    onTextKeyDown: (event: KeyboardEvent<HTMLParagraphElement>) => void;
    onClose: () => void;
};

export function CofechaReportPage({
    cofechaResult,
    linkedReport,
    partOptions,
    selectedPart,
    onSelectedPartChange,
    onTextClick,
    onTextKeyDown,
    onClose,
}: CofechaReportPageProps) {
    return (
        <PageShell
            title="COFECHA"
            subtitle="VERYCOF.OUT"
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
                </div>

                <OverlayScroll className={styles["report-scroll"]}>
                    <p
                        className={styles["report-text"]}
                        onClick={onTextClick}
                        onKeyDown={onTextKeyDown}
                        dangerouslySetInnerHTML={{ __html: linkedReport.html }}
                    />
                </OverlayScroll>
            </div>
        </PageShell>
    );
}

type ExpandedChartPageProps = {
    siteData: RwlSiteData;
    onInsertMissingYearAtSide: (tree: string, year: number, side: MissingInsertSide) => void;
    onDeleteYearWithMode: (tree: string, year: number, mode: DeleteMode) => void;
    onDeleteSeries: (tree: string) => void;
    onClose: () => void;
};

export function ExpandedChartPage({
    siteData,
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

    return (
        <PageShell
            title="Line Chart"
            subtitle={`${stats.seriesCount} 条序列 · ${stats.pointCount} 个观测 · ${stats.yearSpan}`}
            onClose={onClose}
        >
            <div className={styles["chart-page"]}>
                <TreeChartManager
                    variant="expanded"
                    fullData={siteData}
                    onInsertMissingYearAtSide={onInsertMissingYearAtSide}
                    onDeleteYearWithMode={onDeleteYearWithMode}
                    onDeleteSeries={onDeleteSeries}
                />
            </div>
        </PageShell>
    );
}
