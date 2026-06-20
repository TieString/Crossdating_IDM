import type { WorkspaceWindowKind } from "./workspaceWindowBridge";

export const ALL_OPTION_VALUE = "\u5168\u90e8";
export const DEFAULT_HOME_TITLE = "\u4ea4\u53c9\u5b9a\u5e74-IDM";

export const formatTitle = (fileName: string | null, isModified: boolean) => (
    fileName ? `${fileName}${isModified ? " *" : ""}` : DEFAULT_HOME_TITLE
);

export type CofechaVersion = "cofecha" | "cofecha12k" | "cofechawin";
export type TitleMenuKind = "file" | "edit" | "run";

export const TREE_ALL_OPTION_LABEL = "📜 全部";
export const TREE_WARNING_MARK = "⚠️";
export const TREE_NORMAL_MARK = "🪵";
export const WELCOME_TEXT = "开发者：何志浩、张同文、张瑞波、靳春寒、喻树龙、尚华明、秦莉";

export const COFECHA_PART_OPTIONS = [
    { value: ALL_OPTION_VALUE, label: "📜 全部内容" },
    { value: "PART 1", label: "📋 PART 1: Summary" },
    { value: "PART 2", label: "📈 PART 2: Time Plot of Series" },
    { value: "PART 3", label: "⭐ PART 3: Master Dating Series" },
    { value: "PART 4", label: "📊 PART 4: Master Bar Plot" },
    { value: "PART 5", label: "🔗 PART 5: Correlation of Series by Segment" },
    { value: "PART 6", label: "⚠️ PART 6: Potential Problems" },
    { value: "PART 7", label: "🪶 PART 7: Descriptive Statistics" },
];

export const PANEL_DIVIDER_GUTTER_SIZE = 8;
export const COLLAPSED_PANEL_RATIO = 0.995;

export const isPanelRatioCollapsed = (ratio: number) => (
    ratio <= 1 - COLLAPSED_PANEL_RATIO || ratio >= COLLAPSED_PANEL_RATIO
);

export type ExternalWorkspaceWindows = Record<WorkspaceWindowKind, boolean>;

export const EMPTY_EXTERNAL_WORKSPACE_WINDOWS: ExternalWorkspaceWindows = {
    "operation-log": false,
    cofecha: false,
    "line-chart": false,
};

export type DeleteSeriesRequest = {
    id: number;
    tree: string;
};

export type CofechaCellJumpTarget = {
    id: number;
    tree: string;
    year?: number;
};

export type CofechaCellReference = {
    tree: string;
    year?: number;
};

export type EditHighlightTarget = {
    id: number;
    cells: { tree: string; year: number }[];
    scrollTree: string;
    scrollYear?: number;
};

export const resolveCofechaTreeCode = (tree: string, siteData: ReadonlyMap<string, unknown>) => {
    if (siteData.has(tree)) {
        return tree;
    }

    const normalizedTree = tree.toLowerCase();
    return Array.from(siteData.keys()).find((siteTree) => siteTree.toLowerCase() === normalizedTree) ?? tree;
};

export const getErrorMessage = (error: unknown) => (
    error instanceof Error ? error.message : String(error)
);

export const escapeHtml = (value: string) => (
    value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
);
