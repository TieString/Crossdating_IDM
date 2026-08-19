import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
    CofechaReportPage,
    ExpandedChartPage,
    OperationLogPage,
} from "@/pages/home/WorkspacePages";
import {
    createWorkspaceWindowClosedPayload,
    deserializeRwlSiteData,
    WORKSPACE_WINDOW_CLOSED_EVENT,
    WORKSPACE_WINDOW_COMMAND_EVENT,
    WORKSPACE_WINDOW_REQUEST_EVENT,
    WORKSPACE_WINDOW_STATE_EVENT,
    type WorkspaceWindowCommand,
    type WorkspaceWindowKind,
    type WorkspaceWindowRequestPayload,
    type WorkspaceWindowState,
    type WorkspaceWindowStatePayload,
} from "@/pages/home/workspaceWindowBridge";
import type { DeleteMode, DeleteShift, MissingInsertSide } from "@/features/rwl/edit";
import styles from "./WorkspaceWindowPage.module.css";

const MAIN_WINDOW_LABEL = "main";

const isWorkspaceWindowKind = (value: string | null): value is WorkspaceWindowKind => (
    value === "operation-log" || value === "cofecha" || value === "line-chart"
);

async function sendCommand(command: WorkspaceWindowCommand) {
    await emitTo(MAIN_WINDOW_LABEL, WORKSPACE_WINDOW_COMMAND_EVENT, command);
}

export default function WorkspaceWindowPage() {
    const page = new URLSearchParams(window.location.search).get("page");
    const kind = isWorkspaceWindowKind(page) ? page : null;
    const [state, setState] = useState<WorkspaceWindowState | null>(null);

    useEffect(() => {
        if (!kind) return;

        let isMounted = true;
        let hasState = false;
        let retryTimer: number | undefined;
        const unlisteners: UnlistenFn[] = [];
        const currentWindow = getCurrentWindow();
        const requestPayload: WorkspaceWindowRequestPayload = {
            kind,
            requesterLabel: currentWindow.label,
        };
        const closedPayload = createWorkspaceWindowClosedPayload(kind, currentWindow.label);

        const requestState = () => {
            void emitTo(MAIN_WINDOW_LABEL, WORKSPACE_WINDOW_REQUEST_EVENT, requestPayload);
        };

        const stopRetry = () => {
            if (retryTimer !== undefined) {
                window.clearInterval(retryTimer);
                retryTimer = undefined;
            }
        };

        const setup = async () => {
            unlisteners.push(await listen<WorkspaceWindowStatePayload>(
                WORKSPACE_WINDOW_STATE_EVENT,
                (event) => {
                    if (!isMounted || event.payload.kind !== kind) return;
                    hasState = true;
                    stopRetry();
                    setState(event.payload.state);
                },
            ));
            unlisteners.push(await currentWindow.onCloseRequested(async () => {
                await emitTo(MAIN_WINDOW_LABEL, WORKSPACE_WINDOW_CLOSED_EVENT, closedPayload);
            }));
            if (!isMounted) return;
            requestState();
            // 首个 STATE 到达前每 500ms 重发一次 REQUEST，兜住「子窗口先于主窗口
            // 注册监听就发了请求」的竞态，避免独立窗口卡在「正在连接主窗口...」。
            retryTimer = window.setInterval(() => {
                if (hasState) {
                    stopRetry();
                    return;
                }
                requestState();
            }, 500);
        };

        void setup();

        return () => {
            isMounted = false;
            stopRetry();
            unlisteners.forEach((unlisten) => unlisten());
            // 真正的关闭由窗口的 onCloseRequested 通知主窗口；
            // 这里不再发送 CLOSED，避免 StrictMode 的 mount→cleanup→mount
            // 误判窗口已关闭，导致主窗口停止向本窗口同步状态。
        };
    }, [kind]);

    const closeWindow = useCallback(() => {
        if (!kind) return;
        const requesterLabel = getCurrentWindow().label;
        void emitTo(
            MAIN_WINDOW_LABEL,
            WORKSPACE_WINDOW_CLOSED_EVENT,
            createWorkspaceWindowClosedPayload(kind, requesterLabel),
        ).finally(() => {
            void getCurrentWindow().close();
        });
    }, [kind]);

    const handleCofechaTextClick = useCallback((event: MouseEvent<HTMLParagraphElement>) => {
        if (!kind || kind !== "cofecha") return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const link = target.closest<HTMLElement>("[data-cofecha-link='true']");
        if (!link) return;

        const tree = link.dataset.tree;
        const rawYear = link.dataset.year;
        const year = rawYear === undefined ? undefined : Number(rawYear);
        if (!tree || (rawYear !== undefined && !Number.isInteger(year))) return;

        void sendCommand({ kind: "cofecha", type: "jump", tree, year });
    }, [kind]);

    const handleCofechaTextKeyDown = useCallback((event: KeyboardEvent<HTMLParagraphElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const link = target.closest<HTMLElement>("[data-cofecha-link='true']");
        if (!link) return;

        const tree = link.dataset.tree;
        const rawYear = link.dataset.year;
        const year = rawYear === undefined ? undefined : Number(rawYear);
        if (!tree || (rawYear !== undefined && !Number.isInteger(year))) return;

        event.preventDefault();
        void sendCommand({ kind: "cofecha", type: "jump", tree, year });
    }, []);

    const chartData = useMemo(() => (
        state?.kind === "line-chart" ? deserializeRwlSiteData(state.siteData) : new Map()
    ), [state]);

    if (!kind) {
        return <div className={styles["workspace-loading"]}>未知窗口</div>;
    }

    if (!state || state.kind !== kind) {
        return <div className={styles["workspace-loading"]}>正在连接主窗口...</div>;
    }

    if (state.kind === "operation-log") {
        return (
            <OperationLogPage
                fileName={state.fileName}
                operationLog={state.operationLog}
                canResetToRawData={state.canResetToRawData}
                onUndoEntry={(entryId) => sendCommand({ kind: "operation-log", type: "undo-log-entry", entryId })}
                onJumpEntry={(tree, year) => sendCommand({ kind: "operation-log", type: "jump", tree, year })}
                onResetToRawData={() => sendCommand({ kind: "operation-log", type: "reset-to-raw" })}
                onClose={closeWindow}
            />
        );
    }

    if (state.kind === "cofecha") {
        return (
            <CofechaReportPage
                cofechaResult={state.cofechaResult}
                isCofechaOutdated={state.isCofechaOutdated}
                isCofechaRunning={state.isCofechaRunning}
                canRunValidation={state.canRunValidation}
                validationSummary={state.validationSummary}
                linkedReport={state.linkedReport}
                partOptions={state.partOptions}
                selectedPart={state.selectedPart}
                jumpTarget={state.jumpTarget}
                onSelectedPartChange={(part) => sendCommand({ kind: "cofecha", type: "select-part", part })}
                onRunValidation={() => sendCommand({ kind: "cofecha", type: "run-validation" })}
                onTextClick={handleCofechaTextClick}
                onTextKeyDown={handleCofechaTextKeyDown}
                onClose={closeWindow}
            />
        );
    }

    return (
        <ExpandedChartPage
            siteData={chartData}
            selectedTrees={state.selectedTrees}
            treeOffsets={new Map(state.treeOffsets ?? [])}
            focusedTree={state.focusedTree}
            jumpTarget={state.jumpTarget}
            activeDiagnosisEvent={state.activeDiagnosisEvent}
            showPersistentTooltip
            referenceConfig={state.referenceConfig}
            dynamicReferenceConfig={state.dynamicReferenceConfig}
            diagnosis={state.diagnosis}
            diagnosisBatchResult={state.diagnosisBatchResult}
            onReferenceConfigChange={(config) => {
                void sendCommand({ kind: "line-chart", type: "set-reference", config });
            }}
            onApplyDiagnosisCandidate={(candidate) => {
                void sendCommand({ kind: "line-chart", type: "apply-diagnosis-candidate", candidate });
            }}
            onApplyDiagnosisCandidateBatch={(candidates) => {
                void sendCommand({ kind: "line-chart", type: "apply-diagnosis-candidates", candidates });
            }}
            onApplyLocalSimulation={(request) => {
                void sendCommand({ kind: "line-chart", type: "apply-local-simulation", request });
            }}
            onInsertMissingYearAtSide={(tree: string, year: number, side: MissingInsertSide) => {
                void sendCommand({ kind: "line-chart", type: "insert-missing", tree, year, side });
            }}
            onDeleteYearWithMode={(tree: string, year: number, mode: DeleteMode, shift?: DeleteShift) => {
                void sendCommand({ kind: "line-chart", type: "delete-year", tree, year, mode, shift });
            }}
            onMoveSeriesTailByOffset={(tree, selectedStartYear, selectedEndYear, yearOffset) => {
                void sendCommand({
                    kind: "line-chart",
                    type: "move-series-range",
                    tree,
                    selectedStartYear,
                    selectedEndYear,
                    yearOffset,
                });
            }}
            onDeleteSeries={(tree: string) => {
                void sendCommand({ kind: "line-chart", type: "delete-series", tree });
            }}
            onSelectedTreesChange={(trees) => {
                void sendCommand({ kind: "line-chart", type: "set-selection", trees });
            }}
            onTreeOffsetsChange={(offsets) => {
                void sendCommand({
                    kind: "line-chart",
                    type: "set-tree-offsets",
                    offsets: Array.from(offsets.entries()),
                });
            }}
            onLocateWidth={(tree, year) => {
                void sendCommand({ kind: "line-chart", type: "locate-width", tree, year });
            }}
            onEditAsText={(tree) => {
                void sendCommand({ kind: "line-chart", type: "edit-as-text", tree });
            }}
            onJumpToCofecha={(tree) => {
                void sendCommand({ kind: "line-chart", type: "locate-cofecha", tree });
            }}
            onDiagnosisPreviewChange={(event, year) => {
                void sendCommand({
                    kind: "line-chart",
                    type: "preview-diagnosis-event",
                    eventId: event.id,
                    year,
                });
            }}
            cofechaPart6Trees={state.cofechaPart6Trees}
            onClose={closeWindow}
        />
    );
}
