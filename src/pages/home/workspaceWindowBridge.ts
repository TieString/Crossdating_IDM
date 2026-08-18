import { Window } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type {
    CrossdatingDiagnosis,
    DiagnosisBatchApplyResult,
    DiagnosisCandidateOperation,
    DiagnosisEvent,
    LocalSimulationApplyRequest,
} from "@/features/crossdating/diagnosis";
import type { CrossdatingValidationSummary } from "@/features/crossdating/validation";
import type { ReferenceSeriesConfig } from "@/features/crossdating/reference";
import type { DeleteMode, DeleteShift, MissingInsertSide, RwlOperationLogEntry, SerializedRwlTreeData } from "@/features/rwl/edit";
import type { ICofechaResult } from "@/features/cofecha/types";
import type { RwlSiteData } from "@/features/rwl/types";
import type { ChartJumpTarget } from "@/components/Chart/chartNavigation";

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

export const workspaceWindowTitles: Record<WorkspaceWindowKind, string> = {
    "operation-log": "操作日志",
    cofecha: "COFECHA",
    "line-chart": "Line Chart",
};

export const isWorkspaceWindowLabel = (
    kind: WorkspaceWindowKind,
    label: string,
): boolean => workspaceWindowLabels[kind] === label;

export const createWorkspaceWindowClosedPayload = (
    kind: WorkspaceWindowKind,
    requesterLabel: string,
): WorkspaceWindowClosedPayload => ({ kind, requesterLabel });

const workspaceWindowSizes: Record<WorkspaceWindowKind, { width: number; height: number }> = {
    "operation-log": { width: 900, height: 620 },
    cofecha: { width: 1040, height: 760 },
    "line-chart": { width: 1200, height: 780 },
};

const WORKSPACE_WINDOW_CREATION_TIMEOUT_MS = 5000;

const waitForWebviewWindowCreated = (targetWindow: WebviewWindow, label: string) => new Promise<void>((resolve, reject) => {
    let createdUnlisten: (() => void) | undefined;
    let errorUnlisten: (() => void) | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const cleanup = () => {
        createdUnlisten?.();
        errorUnlisten?.();
        if (timeoutId !== undefined) {
            globalThis.clearTimeout(timeoutId);
        }
    };

    const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
    };

    timeoutId = globalThis.setTimeout(() => {
        void Window.getByLabel(label)
            .then((existing) => {
                settle(() => {
                    if (existing) {
                        resolve();
                    } else {
                        reject(new Error(`Workspace window was not created: ${label}`));
                    }
                });
            })
            .catch((error) => {
                settle(() => reject(error));
            });
    }, WORKSPACE_WINDOW_CREATION_TIMEOUT_MS);

    void targetWindow.once("tauri://created", () => {
        settle(resolve);
    }).then((unlisten) => {
        if (settled) {
            unlisten();
            return;
        }
        createdUnlisten = unlisten;
    }).catch((error) => {
        settle(() => reject(error));
    });

    void targetWindow.once<unknown>("tauri://error", (event) => {
        settle(() => reject(event.payload));
    }).then((unlisten) => {
        if (settled) {
            unlisten();
            return;
        }
        errorUnlisten = unlisten;
    }).catch((error) => {
        settle(() => reject(error));
    });
});

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
    canResetToRawData: boolean;
};

export type CofechaWindowState = {
    kind: "cofecha";
    isCofechaOutdated: boolean;
    isCofechaRunning: boolean;
    canRunValidation: boolean;
    validationSummary: CrossdatingValidationSummary;
    cofechaResult?: CofechaWindowResult;
    linkedReport: { html: string; count: number };
    partOptions: Array<{ value: string; label: string }>;
    selectedPart: string;
    /** 主窗口请求独立 COFECHA 窗口滚动到某序列 PART 6 块时的跳转目标。 */
    jumpTarget?: { id: number; tree: string };
};

export type LineChartWindowState = {
    kind: "line-chart";
    siteData: SerializedRwlSiteData;
    selectedTrees: string[];
    focusedTree: string | null;
    jumpTarget?: ChartJumpTarget;
    activeDiagnosisEvent?: DiagnosisEvent | null;
    referenceConfig: ReferenceSeriesConfig | null;
    dynamicReferenceConfig: ReferenceSeriesConfig | null;
    diagnosis: CrossdatingDiagnosis;
    diagnosisBatchResult: DiagnosisBatchApplyResult | null;
    cofechaPart6Trees: string[];
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
    requesterLabel: string;
};

export type WorkspaceWindowCommand =
    | { kind: "operation-log"; type: "undo-log-entry"; entryId: string }
    | { kind: "operation-log"; type: "reset-to-raw" }
    | { kind: "operation-log"; type: "jump"; tree: string; year?: number }
    | { kind: "cofecha"; type: "select-part"; part: string }
    | { kind: "cofecha"; type: "run-validation" }
    | { kind: "cofecha"; type: "jump"; tree: string; year?: number }
    | { kind: "line-chart"; type: "set-selection"; trees: string[] }
    | { kind: "line-chart"; type: "locate-width"; tree: string; year: number }
    | { kind: "line-chart"; type: "edit-as-text"; tree: string }
    | { kind: "line-chart"; type: "locate-cofecha"; tree: string }
    | { kind: "line-chart"; type: "preview-diagnosis-event"; eventId: string; year: number }
    | { kind: "line-chart"; type: "set-reference"; config: ReferenceSeriesConfig | null }
    | { kind: "line-chart"; type: "apply-diagnosis-candidate"; candidate: DiagnosisCandidateOperation }
    | { kind: "line-chart"; type: "apply-diagnosis-candidates"; candidates: DiagnosisCandidateOperation[] }
    | { kind: "line-chart"; type: "apply-local-simulation"; request: LocalSimulationApplyRequest }
    | { kind: "line-chart"; type: "insert-missing"; tree: string; year: number; side: MissingInsertSide }
    | { kind: "line-chart"; type: "delete-year"; tree: string; year: number; mode: DeleteMode; shift?: DeleteShift }
    | { kind: "line-chart"; type: "move-series-range"; tree: string; selectedStartYear: number; selectedEndYear: number; yearOffset: number }
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
        await existing.show();
        await existing.unminimize();
        await existing.setFocus();
        return;
    }

    const { width, height } = workspaceWindowSizes[kind];
    const window = new WebviewWindow(label, {
        url: `/?page=${kind}`,
        title: workspaceWindowTitles[kind],
        width,
        height,
        // 除主窗口外统一使用系统原生标题栏（与设置窗口一致）
        decorations: true,
        resizable: true,
        center: true,
    });
    await waitForWebviewWindowCreated(window, label);
}
