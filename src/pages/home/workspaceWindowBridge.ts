import { Window } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { DeleteMode, MissingInsertSide, RwlOperationLogEntry, SerializedRwlTreeData } from "@/features/rwl/edit";
import type { ICofechaResult } from "@/features/cofecha/types";
import type { RwlSiteData } from "@/features/rwl/types";

export type WorkspaceWindowKind = "operation-log" | "cofecha" | "line-chart";

export const WORKSPACE_WINDOW_REQUEST_EVENT = "workspace-window://request-state";
export const WORKSPACE_WINDOW_STATE_EVENT = "workspace-window://state";
export const WORKSPACE_WINDOW_COMMAND_EVENT = "workspace-window://command";
export const WORKSPACE_WINDOW_CLOSED_EVENT = "workspace-window://closed";

export const workspaceWindowLabels: Record<WorkspaceWindowKind, string> = {
    "operation-log": "workspace-operation-log",
    cofecha: "workspace-cofecha",
    "line-chart": "workspace-line-chart",
};

const workspaceWindowTitles: Record<WorkspaceWindowKind, string> = {
    "operation-log": "操作日志",
    cofecha: "COFECHA",
    "line-chart": "Line Chart",
};

const workspaceWindowSizes: Record<WorkspaceWindowKind, { width: number; height: number }> = {
    "operation-log": { width: 900, height: 620 },
    cofecha: { width: 1040, height: 760 },
    "line-chart": { width: 1200, height: 780 },
};

export type SerializedRwlSiteData = Array<[string, SerializedRwlTreeData]>;

export type CofechaWindowResult = Pick<
    ICofechaResult,
    "possibleProblemsCount" |
    "masterSeriesYear" |
    "seriesIntercorrelation" |
    "averageMeanSensitivity" |
    "meanLength"
>;

export type OperationLogWindowState = {
    kind: "operation-log";
    fileName: string | null;
    operationLog: RwlOperationLogEntry[];
};

export type CofechaWindowState = {
    kind: "cofecha";
    cofechaResult?: CofechaWindowResult;
    linkedReport: { html: string; count: number };
    partOptions: Array<{ value: string; label: string }>;
    selectedPart: string;
};

export type LineChartWindowState = {
    kind: "line-chart";
    siteData: SerializedRwlSiteData;
};

export type WorkspaceWindowState =
    | OperationLogWindowState
    | CofechaWindowState
    | LineChartWindowState;

export type WorkspaceWindowRequestPayload = {
    kind: WorkspaceWindowKind;
    requesterLabel: string;
};

export type WorkspaceWindowStatePayload = {
    kind: WorkspaceWindowKind;
    state: WorkspaceWindowState;
};

export type WorkspaceWindowClosedPayload = {
    kind: WorkspaceWindowKind;
};

export type WorkspaceWindowCommand =
    | { kind: "operation-log"; type: "undo-log-entry"; entryId: string }
    | { kind: "operation-log"; type: "redo-log-entry"; entryId: string }
    | { kind: "cofecha"; type: "select-part"; part: string }
    | { kind: "cofecha"; type: "jump"; tree: string; year?: number }
    | { kind: "line-chart"; type: "insert-missing"; tree: string; year: number; side: MissingInsertSide }
    | { kind: "line-chart"; type: "delete-year"; tree: string; year: number; mode: DeleteMode }
    | { kind: "line-chart"; type: "delete-series"; tree: string };

export function serializeRwlSiteData(siteData: RwlSiteData): SerializedRwlSiteData {
    return Array.from(siteData.entries()).map(([tree, treeData]) => [
        tree,
        Array.from(treeData.entries()),
    ]);
}

export function deserializeRwlSiteData(siteData: SerializedRwlSiteData): RwlSiteData {
    return new Map(siteData.map(([tree, treeData]) => [
        tree,
        new Map(treeData),
    ]));
}

export async function openWorkspaceWindow(kind: WorkspaceWindowKind) {
    const label = workspaceWindowLabels[kind];
    const existing = await Window.getByLabel(label);
    if (existing) {
        await existing.setFocus();
        return;
    }

    const { width, height } = workspaceWindowSizes[kind];
    new WebviewWindow(label, {
        url: `/?page=${kind}`,
        title: workspaceWindowTitles[kind],
        width,
        height,
        decorations: true,
        resizable: true,
        center: true,
    });
}
