import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
    CofechaReportPage,
    ExpandedChartPage,
    OperationLogPage,
} from "@/pages/home/WorkspacePages";
import {
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
import type { DeleteMode, MissingInsertSide } from "@/features/rwl/edit";
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
        const unlisteners: UnlistenFn[] = [];
        const currentWindow = getCurrentWindow();
        const requestPayload: WorkspaceWindowRequestPayload = {
            kind,
            requesterLabel: currentWindow.label,
        };

        const setup = async () => {
            unlisteners.push(await listen<WorkspaceWindowStatePayload>(
                WORKSPACE_WINDOW_STATE_EVENT,
                (event) => {
                    if (!isMounted || event.payload.kind !== kind) return;
                    setState(event.payload.state);
                },
            ));
            unlisteners.push(await currentWindow.onCloseRequested(async () => {
                await emitTo(MAIN_WINDOW_LABEL, WORKSPACE_WINDOW_CLOSED_EVENT, { kind });
            }));
            await emitTo(MAIN_WINDOW_LABEL, WORKSPACE_WINDOW_REQUEST_EVENT, requestPayload);
        };

        void setup();

        return () => {
            isMounted = false;
            unlisteners.forEach((unlisten) => unlisten());
            void emitTo(MAIN_WINDOW_LABEL, WORKSPACE_WINDOW_CLOSED_EVENT, { kind });
        };
    }, [kind]);

    const closeWindow = useCallback(() => {
        if (!kind) return;
        void emitTo(MAIN_WINDOW_LABEL, WORKSPACE_WINDOW_CLOSED_EVENT, { kind }).finally(() => {
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
                onUndoEntry={(entryId) => sendCommand({ kind: "operation-log", type: "undo-log-entry", entryId })}
                onRedoEntry={(entryId) => sendCommand({ kind: "operation-log", type: "redo-log-entry", entryId })}
                onClose={closeWindow}
            />
        );
    }

    if (state.kind === "cofecha") {
        return (
            <CofechaReportPage
                cofechaResult={state.cofechaResult}
                linkedReport={state.linkedReport}
                partOptions={state.partOptions}
                selectedPart={state.selectedPart}
                onSelectedPartChange={(part) => sendCommand({ kind: "cofecha", type: "select-part", part })}
                onTextClick={handleCofechaTextClick}
                onTextKeyDown={handleCofechaTextKeyDown}
                onClose={closeWindow}
            />
        );
    }

    return (
        <ExpandedChartPage
            siteData={chartData}
            onInsertMissingYearAtSide={(tree: string, year: number, side: MissingInsertSide) => {
                void sendCommand({ kind: "line-chart", type: "insert-missing", tree, year, side });
            }}
            onDeleteYearWithMode={(tree: string, year: number, mode: DeleteMode) => {
                void sendCommand({ kind: "line-chart", type: "delete-year", tree, year, mode });
            }}
            onDeleteSeries={(tree: string) => {
                void sendCommand({ kind: "line-chart", type: "delete-series", tree });
            }}
            onClose={closeWindow}
        />
    );
}
