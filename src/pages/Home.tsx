import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnimatePresence } from "motion/react";
import { TreeChartManager } from "@/components/Chart/TreeChartManager";
import { CurrentEventSuggestionPanel } from "@/components/DiagnosisCandidates/CurrentEventSuggestionPanel";
import { DiagnosisEventPanel } from "@/components/DiagnosisCandidates/DiagnosisEventPanel";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis";
import { hashRwlSiteData } from "@/features/crossdating/reference";
import WidthContainer, { WidthGridSkeleton } from "@/components/WidthContainer/WidthContainer";
import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu/ContextMenu";
import { FloatingScrollArea } from "@/components/FloatingScrollArea/FloatingScrollArea";
import { FloatingScrollbar } from "@/components/FloatingScrollbar/FloatingScrollbar";
import { FindReplaceBar, type FindReplaceMode } from "@/components/FindReplace/FindReplaceBar";
import { openSettingsWindow } from "@/pages/settings/openSettingsWindow";
import { stopMarker } from "@/shared/constants";
import { CURRENT_EVENT_PYTHON_MODELS_ENABLED } from "@/shared/featureFlags";
import style from "./Home.module.css";
import {
    ALL_OPTION_VALUE,
    COLLAPSED_PANEL_RATIO,
    COFECHA_PART_OPTIONS,
    EMPTY_EXTERNAL_WORKSPACE_WINDOWS,
    isPanelRatioCollapsed,
    PANEL_DIVIDER_GUTTER_SIZE,
    TitleMenuKind,
    TREE_ALL_OPTION_LABEL,
    TREE_NORMAL_MARK,
    TREE_WARNING_MARK,
    WELCOME_TEXT,
    escapeHtml,
    getErrorMessage,
    resolveCofechaTreeCode,
    type CofechaCellJumpTarget,
    type CofechaCellReference,
    type DeleteSeriesRequest,
    type EditHighlightTarget,
    type ExternalWorkspaceWindows,
} from "./home/homeShared";
import {
    CofechaEmptySkeleton,
    CofechaEmptyState,
    CofechaStatValue,
    CofechaToolbarSkeleton,
    LineChartEmptySkeleton,
    LineChartEmptyState,
    WorkspaceWindowPlaceholder,
} from "./home/HomePanelComponents";
import { HomeTitleBarBridge } from "./home/HomeTitleBarBridge";
import { useHomeWorkspace } from "./home/useHomeWorkspace";
import {
    COFECHA_ABSENT_RING_CONTINUATION_RE,
    COFECHA_ABSENT_RING_SUMMARY_RE,
    COFECHA_PART6_ANCHOR_ATTR,
    COFECHA_PART6_HIGHLIGHT_MS,
    COFECHA_PART6_PART_VALUE,
    COFECHA_PART6_SERIES_HEADER_RE,
    COFECHA_PART_SEPARATOR_RE,
    COFECHA_PROBLEM_REFERENCE_RE,
    COFECHA_YEAR_TOKEN_RE,
    cofechaReportShowsPart6,
    findCofechaPart6Anchor,
    scrollCofechaAnchorIntoView,
} from "./home/cofechaReportAnchor";
import {
    isWorkspaceWindowLabel,
    openWorkspaceWindow,
    serializeRwlSiteData,
    workspaceWindowLabels,
    WORKSPACE_WINDOW_CLOSED_EVENT,
    WORKSPACE_WINDOW_COMMAND_EVENT,
    WORKSPACE_WINDOW_REQUEST_EVENT,
    WORKSPACE_WINDOW_STATE_EVENT,
    type WorkspaceWindowClosedPayload,
    type WorkspaceWindowCommand,
    type WorkspaceWindowKind,
    type WorkspaceWindowRequestPayload,
    type WorkspaceWindowState,
} from "./home/workspaceWindowBridge";
import { useResizablePanels } from "./useResizablePanels";
import { publishConsoleDataExport } from "./home/consoleDataExport";
import type { CurrentEventSuggestion } from "@/services/currentEventRanker/types";
import { hasCofechaSeriesMapValue } from "@/features/cofecha/seriesId";
import type { ChartJumpTarget } from "@/components/Chart/chartNavigation";

const isTreeBoundary = (value: string | undefined) => (
    value === undefined || !/[A-Za-z0-9_]/.test(value)
);

const makeCofechaCellLinkHtml = (tree: string, rawYear: string, label = rawYear) => (
    `<span class="${style["cofecha-year-link"]}" data-cofecha-link="true" data-tree="${escapeHtml(tree)}" data-year="${escapeHtml(rawYear)}" role="button" tabindex="0" title="跳转到 ${escapeHtml(tree)} ${escapeHtml(rawYear)}" style="color:#0f5f9e;background-color:rgba(47,95,147,0.08);font-weight:700;text-decoration:underline;text-underline-offset:2px;cursor:pointer;border-radius:3px;padding:0 2px;">${escapeHtml(label)}</span>`
);

const makeCofechaSeriesLinkHtml = (tree: string) => (
    `<span class="${style["cofecha-year-link"]}" data-cofecha-link="true" data-tree="${escapeHtml(tree)}" role="button" tabindex="0" title="跳转到 ${escapeHtml(tree)}" style="color:#0f5f9e;background-color:rgba(47,95,147,0.08);font-weight:700;text-decoration:underline;text-underline-offset:2px;cursor:pointer;border-radius:3px;padding:0 2px;">${escapeHtml(tree)}</span>`
);

// PART 6 序列标题里的序列名：除了普通的跳转链接，还带上锚点属性，便于从年轮网格右键
// “在 COFECHA 中定位”反向跳转到该序列的潜在问题块。命中跳转时附加高亮类。
const makeCofechaPart6HeaderHtml = (tree: string, highlighted: boolean) => (
    `<span class="${style["cofecha-year-link"]}${highlighted ? ` ${style["cofecha-part6-active"]}` : ""}" data-cofecha-link="true" ${COFECHA_PART6_ANCHOR_ATTR}="${escapeHtml(tree)}" data-tree="${escapeHtml(tree)}" role="button" tabindex="0" title="跳转到 ${escapeHtml(tree)}" style="color:#0f5f9e;background-color:rgba(47,95,147,0.08);font-weight:700;text-decoration:underline;text-underline-offset:2px;cursor:pointer;border-radius:3px;padding:0 2px;">${escapeHtml(tree)}</span>`
);

const linkCofechaTreesInText = (text: string, knownTrees: readonly string[]) => {
    let html = "";
    let count = 0;
    let cursor = 0;

    while (cursor < text.length) {
        const matchedTree = knownTrees.find((tree) => (
            text.startsWith(tree, cursor)
            && isTreeBoundary(text[cursor - 1])
            && isTreeBoundary(text[cursor + tree.length])
        ));

        if (!matchedTree) {
            html += escapeHtml(text[cursor]);
            cursor += 1;
            continue;
        }

        html += makeCofechaSeriesLinkHtml(matchedTree);
        cursor += matchedTree.length;
        count += 1;
    }

    return { html, count };
};

const linkCofechaYearsInText = (text: string, tree: string, knownTrees: readonly string[]) => {
    let html = "";
    let count = 0;
    let cursor = 0;

    COFECHA_YEAR_TOKEN_RE.lastIndex = 0;

    for (const match of text.matchAll(COFECHA_YEAR_TOKEN_RE)) {
        const rawYear = match[1];
        const index = match.index ?? 0;
        const plainText = linkCofechaTreesInText(text.slice(cursor, index), knownTrees);
        html += plainText.html;
        html += makeCofechaCellLinkHtml(tree, rawYear);
        cursor = index + rawYear.length;
        count += plainText.count + 1;
    }

    const rest = linkCofechaTreesInText(text.slice(cursor), knownTrees);
    html += rest.html;
    count += rest.count;
    return { html, count };
};

const renderCofechaLineWithLinks = (
    line: string,
    lineBreak: string,
    knownTrees: readonly string[],
    currentSeriesTree: string | null,
    absentRingTree: string | null,
    highlightTree: string | null,
) => {
    if (COFECHA_PART_SEPARATOR_RE.test(line)) {
        const plainText = linkCofechaTreesInText(line + lineBreak, knownTrees);
        return {
            html: plainText.html,
            count: plainText.count,
            currentSeriesTree: null,
            absentRingTree: null,
        };
    }

    const problemMatch = line.match(COFECHA_PROBLEM_REFERENCE_RE);

    if (problemMatch) {
        const [, prefix, tree, gap, rawYear, suffix] = problemMatch;
        return {
            html: [
                linkCofechaTreesInText(prefix, knownTrees).html,
                makeCofechaSeriesLinkHtml(tree),
                linkCofechaTreesInText(gap, knownTrees).html,
                makeCofechaCellLinkHtml(tree, rawYear),
                linkCofechaTreesInText(suffix + lineBreak, knownTrees).html,
            ].join(""),
            count: 2,
            currentSeriesTree,
            absentRingTree: null,
        };
    }

    const seriesHeaderMatch = line.match(COFECHA_PART6_SERIES_HEADER_RE);

    if (seriesHeaderMatch) {
        const [, prefix, tree, gap, rawStartYear, toLabel, rawEndYear, suffix] = seriesHeaderMatch;

        const isHighlighted = highlightTree !== null && tree.toLowerCase() === highlightTree.toLowerCase();

        return {
            html: [
                linkCofechaTreesInText(prefix, knownTrees).html,
                makeCofechaPart6HeaderHtml(tree, isHighlighted),
                linkCofechaTreesInText(gap, knownTrees).html,
                makeCofechaCellLinkHtml(tree, rawStartYear),
                linkCofechaTreesInText(toLabel, knownTrees).html,
                makeCofechaCellLinkHtml(tree, rawEndYear),
                linkCofechaTreesInText(suffix + lineBreak, knownTrees).html,
            ].join(""),
            count: 3,
            currentSeriesTree: tree,
            absentRingTree: null,
        };
    }

    const absentRingMatch = line.match(COFECHA_ABSENT_RING_SUMMARY_RE);

    if (absentRingMatch) {
        const [, prefix, marker, label, yearsText] = absentRingMatch;
        // marker 可能是序列名（PART 3 "ABSENT RINGS listed by SERIES" 行首即序列名），
        // 也可能是 PART 6 的 [D] 等小节标记。行首是已知序列时缺失年份归属于它；
        // 否则回退到 currentSeriesTree（PART 6 由前面的序列标题行设定）。
        const ownerTree = knownTrees.includes(marker) ? marker : currentSeriesTree;
        const head = linkCofechaTreesInText(prefix + marker + label, knownTrees);
        const linkedYears = ownerTree
            ? linkCofechaYearsInText(yearsText, ownerTree, knownTrees)
            : linkCofechaTreesInText(yearsText, knownTrees);

        return {
            html: [
                head.html,
                linkedYears.html,
                linkCofechaTreesInText(lineBreak, knownTrees).html,
            ].join(""),
            count: head.count + linkedYears.count,
            currentSeriesTree,
            absentRingTree: ownerTree,
        };
    }

    const continuationMatch = absentRingTree
        ? line.match(COFECHA_ABSENT_RING_CONTINUATION_RE)
        : null;

    if (continuationMatch && absentRingTree) {
        const [, prefix, yearsText, suffix] = continuationMatch;
        const linkedYears = linkCofechaYearsInText(yearsText, absentRingTree, knownTrees);

        return {
            html: [
                linkCofechaTreesInText(prefix, knownTrees).html,
                linkedYears.html,
                linkCofechaTreesInText(suffix + lineBreak, knownTrees).html,
            ].join(""),
            count: linkedYears.count,
            currentSeriesTree,
            absentRingTree,
        };
    }

    if (currentSeriesTree) {
        const linkedYears = linkCofechaYearsInText(line, currentSeriesTree, knownTrees);

        if (linkedYears.count > 0) {
            return {
                html: linkedYears.html + linkCofechaTreesInText(lineBreak, knownTrees).html,
                count: linkedYears.count,
                currentSeriesTree,
                absentRingTree: null,
            };
        }
    }

    const plainText = linkCofechaTreesInText(line + lineBreak, knownTrees);

    return {
        html: plainText.html,
        count: plainText.count,
        currentSeriesTree,
        absentRingTree: null,
    };
};

const renderCofechaHtmlWithLinks = (
    text: string | undefined,
    trees: readonly string[],
    highlightTree: string | null = null,
) => {
    const lines = (text ?? "").split(/\r\n|\n|\r/);
    const knownTrees = [...trees].sort((a, b) => b.length - a.length);
    let currentSeriesTree: string | null = null;
    let absentRingTree: string | null = null;
    let count = 0;

    const html = lines.map((line, index) => {
        const lineBreak = index < lines.length - 1 ? "\n" : "";
        const result = renderCofechaLineWithLinks(line, lineBreak, knownTrees, currentSeriesTree, absentRingTree, highlightTree);

        currentSeriesTree = result.currentSeriesTree;
        absentRingTree = result.absentRingTree;
        count += result.count;
        return result.html;
    }).join("");

    return { html, count };
};

export default function Home() {
    const homeContainerRef = useRef<HTMLDivElement>(null);
    const rawEditorRef = useRef<HTMLParagraphElement>(null);
    const leftPanelsRef = useRef<HTMLDivElement>(null);
    const rightPanelsRef = useRef<HTMLDivElement>(null);
    const deleteSeriesRequestIdRef = useRef(0);
    const cofechaCellJumpIdRef = useRef(0);
    const cofechaPart6JumpIdRef = useRef(0);
    const chartJumpIdRef = useRef(0);
    const handledCofechaPart6JumpIdRef = useRef<number | null>(null);
    const cofechaReportScrollRef = useRef<HTMLDivElement | null>(null);
    const editHighlightIdRef = useRef(0);
    const { layout, draggingKey, startResize } = useResizablePanels();
    const [activeMenu, setActiveMenu] = useState<TitleMenuKind | null>(null);
    const [deleteSeriesRequest, setDeleteSeriesRequest] = useState<DeleteSeriesRequest | null>(null);
    const [cofechaCellJumpTarget, setCofechaCellJumpTarget] = useState<CofechaCellJumpTarget | null>(null);
    const [cofechaPart6JumpTarget, setCofechaPart6JumpTarget] = useState<{ id: number; tree: string } | null>(null);
    const [chartJumpTarget, setChartJumpTarget] = useState<ChartJumpTarget | null>(null);
    const [editHighlightTarget, setEditHighlightTarget] = useState<EditHighlightTarget | null>(null);
    const [isRawEditing, setIsRawEditing] = useState(false);
    const [legendContainer, setLegendContainer] = useState<HTMLElement | null>(null);
    const [rawEditorTree, setRawEditorTree] = useState<string | null>(null);
    const [rawEditorInitialText, setRawEditorInitialText] = useState("");
    const [rawEditorRevision, setRawEditorRevision] = useState(0);
    const [rawEditorError, setRawEditorError] = useState("");
    const [externalWorkspaceWindows, setExternalWorkspaceWindows] = useState<ExternalWorkspaceWindows>(EMPTY_EXTERNAL_WORKSPACE_WINDOWS);
    const [panelContextMenu, setPanelContextMenu] = useState<{ x: number; y: number; kind: WorkspaceWindowKind } | null>(null);
    const [findReplaceOpen, setFindReplaceOpen] = useState(false);
    const [findReplaceMode, setFindReplaceMode] = useState<FindReplaceMode>("find");
    const [findQuery, setFindQuery] = useState("");
    const [replaceValue, setReplaceValue] = useState("");
    const [findMatchIndex, setFindMatchIndex] = useState(0);
    const [problemTab, setProblemTab] = useState<"problems" | "candidates">("problems");
    const [focusedCurrentEventSuggestion, setFocusedCurrentEventSuggestion] = useState<CurrentEventSuggestion | null>(null);
    const [chartSelectedTrees, setChartSelectedTrees] = useState<string[]>([]);
    const chartSelectionFileRef = useRef<string | null>(null);
    const {
        applyRawRwlText,
        applyRawRwlTextForTree,
        canResetToRawData,
        cofechaResult,
        cofechaVersion,
        crossdatingValidationSummary,
        crossdatingDiagnosis,
        currentEventRankerSession,
        currentEventModels,
        activeCurrentEventModelId,
        currentEventModelCatalogError,
        cancelCurrentEventRanker,
        deletionMarkers,
        diagnosisBatchResult,
        dynamicReferenceConfig,
        fileName,
        getCurrentRwlText,
        handleDeleteSeries,
        handleDeleteYearWithMode,
        handleDeleteYearWithModeFromChart,
        handleInsertMissingYearAtSide,
        handleInsertMissingYearAtSideFromChart,
        handleLoad: handleWorkspaceLoad,
        handleMarkYearRangeAsMissing,
        handleMoveSeriesTailByOffset,
        handleApplyDiagnosisCandidate,
        handleApplyDiagnosisCandidateBatch,
        handleApplyDiagnosisEvent,
        handleApplyCurrentEventConfirmedYears,
        handleApplyBayesianStartYear,
        handleApplyLocalSimulation,
        handleConfirmCurrentEventYear,
        handleReferenceConfigChange,
        handleResetReferenceToDynamic,
        handleRedo,
        handleReplaceTreeData,
        handleResetToRawData,
        handleRestoreDeletion,
        handleRunCofechaValidation,
        handleRunCurrentEventRanker,
        handleSave: handleStructuredSave,
        handleSaveAs: handleStructuredSaveAs,
        handleTreeSelectionChange,
        handleUndoCurrentEventConfirmation,
        handleUndo,
        handleUndoOperationLogEntry,
        hasChart,
        historyAnimation,
        historyStatus,
        isCofechaOutdated,
        isCofechaRunning,
        isEventDiagnosisRunning,
        isFileLoading,
        isModified,
        operationLog,
        possibleProblemsDetail,
        problemTextColor,
        referenceConfig,
        processingText,
        reportText,
        cofechaPart6Text,
        selectedPart,
        selectedProblemText,
        selectedTree,
        setCofechaVersion,
        setSelectedPart,
        selectCurrentEventModel,
        retryCurrentEventRanker,
        shouldShowProcessing,
        shouldShowWelcome,
        siteData,
        treeOptions,
        windowTitle,
    } = useHomeWorkspace();

    useEffect(() => {
        const fileChanged = chartSelectionFileRef.current !== fileName;
        chartSelectionFileRef.current = fileName;
        if (fileChanged) {
            setChartJumpTarget(null);
        }
        setChartSelectedTrees((previous) => {
            const next = fileChanged
                ? []
                : previous.filter((tree) => siteData.has(tree));
            return next.length === previous.length
                && next.every((tree, index) => tree === previous[index])
                ? previous
                : next;
        });
    }, [fileName, siteData]);

    const handleChartSelectedTreesChange = useCallback((trees: string[]) => {
        const next = Array.from(new Set(trees.filter((tree) => siteData.has(tree))));
        setChartSelectedTrees(next);
    }, [siteData]);

    useEffect(() => {
        publishConsoleDataExport(fileName, siteData, cofechaResult);
    }, [cofechaResult, fileName, siteData]);

    const selectedTreeEvents = useMemo(
        () => crossdatingDiagnosis.events.filter((event) => (
            event.seriesId === selectedTree && !event.stale
        )),
        [crossdatingDiagnosis, selectedTree],
    );
    const currentSiteHash = useMemo(() => hashRwlSiteData(siteData), [siteData]);
    const visibleCurrentEventSession = useMemo(() => {
        const context = currentEventRankerSession.context;
        if (!context || (
            context.rwlPath === fileName
            && context.targetSeriesId === selectedTree
            && context.sourceHash === currentSiteHash
        )) {
            return currentEventRankerSession;
        }
        return {
            ...currentEventRankerSession,
            status: "stale" as const,
            requestId: null,
            context: null,
            confirmedYears: [],
            result: null,
            error: null,
            staleReason: "旧模型结果不属于当前文件、序列或数据版本，已停止显示。",
        };
    }, [currentEventRankerSession, currentSiteHash, fileName, selectedTree]);
    useEffect(() => {
        setFocusedCurrentEventSuggestion(null);
    }, [visibleCurrentEventSession.requestId, selectedTree]);
    const suggestedRangeHighlights = useMemo(
        () => [
            ...crossdatingDiagnosis.events.flatMap((event) => (
                !event.stale && event.eventType !== "wholeSeriesMove"
                    ? [{
                        tree: event.seriesId,
                        startYear: event.startYear,
                        endYear: event.endYear,
                    }]
                    : []
            )),
            ...(CURRENT_EVENT_PYTHON_MODELS_ENABLED
                && (visibleCurrentEventSession.status === "advice"
                || visibleCurrentEventSession.status === "range_advice")
                && visibleCurrentEventSession.result?.eventRange
                && selectedTree !== ALL_OPTION_VALUE
                ? [{
                    tree: selectedTree,
                    startYear: visibleCurrentEventSession.result.eventRange.startYear,
                    endYear: visibleCurrentEventSession.result.eventRange.endYear,
                }]
                : []),
            ...(CURRENT_EVENT_PYTHON_MODELS_ENABLED
                && focusedCurrentEventSuggestion
                && selectedTree !== ALL_OPTION_VALUE
                ? [{
                    tree: selectedTree,
                    startYear: focusedCurrentEventSuggestion.rangeStart,
                    endYear: focusedCurrentEventSuggestion.rangeEnd,
                }]
                : []),
        ],
        [crossdatingDiagnosis, focusedCurrentEventSuggestion, selectedTree, visibleCurrentEventSession],
    );
    const currentEventTabAvailable = CURRENT_EVENT_PYTHON_MODELS_ENABLED
        && Boolean(fileName && selectedTree !== ALL_OPTION_VALUE);
    const currentEventSuggestionCount = visibleCurrentEventSession.status === "advice"
        ? visibleCurrentEventSession.result?.suggestions.length ?? 0
        : 0;
    const candidateTabAvailable = currentEventTabAvailable
        || selectedTreeEvents.length > 0
        || isEventDiagnosisRunning;
    const problemTabAvailable = Boolean(selectedProblemText);
    const showProblemsPanel = problemTabAvailable || candidateTabAvailable;
    const activeProblemTab: "problems" | "candidates" = problemTab === "candidates" && candidateTabAvailable
        ? "candidates"
        : problemTab === "problems" && problemTabAvailable
            ? "problems"
            : candidateTabAvailable
                ? "candidates"
                : "problems";

    const mainDividerCollapsed = isPanelRatioCollapsed(layout.mainSplitRatio);
    const leftBottomDividerCollapsed = layout.leftBottomRatio >= COLLAPSED_PANEL_RATIO;
    const rightBottomDividerCollapsed = isPanelRatioCollapsed(layout.rightBottomRatio);
    const mainDividerClassName = `${style["panel-divider"]} ${style["panel-divider-vertical"]} ${draggingKey === "mainSplitRatio" ? style["panel-divider-active"] : ""} ${mainDividerCollapsed ? style["panel-divider-collapsed"] : ""}`;
    const nestedDividerClassName = `${style["panel-divider"]} ${style["panel-divider-horizontal"]}`;
    const widthModuleStyle: CSSProperties = {
        flex: `0 0 ${layout.mainSplitRatio * 100}%`,
        ...(!mainDividerCollapsed ? { maxWidth: `calc(100% - ${PANEL_DIVIDER_GUTTER_SIZE}px)` } : {}),
    };
    const dataContainerStyle = showProblemsPanel
        ? {
            flex: `0 0 ${layout.leftBottomRatio * 100}%`,
            ...(!leftBottomDividerCollapsed ? { maxHeight: `calc(100% - ${PANEL_DIVIDER_GUTTER_SIZE}px)` } : {}),
        }
        : undefined;
    const shouldShowRightSkeleton = isFileLoading;
    const shouldShowWidthSkeleton = shouldShowWelcome || isFileLoading || (!hasChart && shouldShowProcessing);
    const shouldShowRightBottomPane = hasChart || shouldShowWelcome || shouldShowRightSkeleton;
    const rightBottomCofechaCollapsed = layout.rightBottomRatio <= 1 - COLLAPSED_PANEL_RATIO;
    const cofechaTextStyle: CSSProperties | undefined = !shouldShowRightBottomPane
        ? undefined
        : rightBottomCofechaCollapsed
            ? { display: "none" }
            : {
                flex: `0 0 ${layout.rightBottomRatio * 100}%`,
                ...(!rightBottomDividerCollapsed ? { maxHeight: `calc(100% - ${PANEL_DIVIDER_GUTTER_SIZE}px)` } : {}),
            };
    const handleDeleteSeriesFromChart = useCallback((tree: string) => {
        deleteSeriesRequestIdRef.current += 1;
        setDeleteSeriesRequest({ id: deleteSeriesRequestIdRef.current, tree });
    }, []);

    const handleOpenWorkspaceWindow = useCallback((kind: WorkspaceWindowKind) => {
        void openWorkspaceWindow(kind)
            .then(() => {
                setExternalWorkspaceWindows((previous) => ({ ...previous, [kind]: true }));
            })
            .catch((error) => {
                console.error("打开工作区独立窗口失败:", error);
                setExternalWorkspaceWindows((previous) => ({ ...previous, [kind]: false }));
            });
    }, []);

    const handlePanelContextMenu = useCallback((kind: WorkspaceWindowKind) => (event: MouseEvent) => {
        event.preventDefault();
        setPanelContextMenu({ x: event.clientX, y: event.clientY, kind });
    }, []);

    const closePanelContextMenu = useCallback(() => setPanelContextMenu(null), []);

    const panelContextMenuItems = useMemo<ContextMenuItem[]>(() => {
        if (!panelContextMenu) {
            return [];
        }
        const isOpen = externalWorkspaceWindows[panelContextMenu.kind];
        return [
            {
                key: "open-window",
                label: isOpen ? "聚焦独立窗口" : "在独立窗口中打开",
                onSelect: () => handleOpenWorkspaceWindow(panelContextMenu.kind),
            },
        ];
    }, [panelContextMenu, externalWorkspaceWindows, handleOpenWorkspaceWindow]);

    const handleJumpToChart = useCallback((tree: string, year: number) => {
        const resolvedTree = resolveCofechaTreeCode(tree, siteData);
        if (!siteData.has(resolvedTree) || !Number.isFinite(year)) return;

        chartJumpIdRef.current += 1;
        setChartSelectedTrees((previous) => (
            previous.includes(resolvedTree) ? previous : [...previous, resolvedTree]
        ));
        if (selectedTree !== resolvedTree) {
            handleTreeSelectionChange(resolvedTree);
        }
        setChartJumpTarget({ id: chartJumpIdRef.current, tree: resolvedTree, year });
        if (externalWorkspaceWindows["line-chart"]) {
            handleOpenWorkspaceWindow("line-chart");
        }
    }, [externalWorkspaceWindows, handleOpenWorkspaceWindow, handleTreeSelectionChange, selectedTree, siteData]);

    const handleDeleteSeriesRequestHandled = useCallback((id: number) => {
        setDeleteSeriesRequest((request) => request?.id === id ? null : request);
    }, []);

    const handleCofechaCellReferenceClick = useCallback(({ tree, year }: CofechaCellReference) => {
        const resolvedTree = resolveCofechaTreeCode(tree, siteData);

        if (!siteData.has(resolvedTree)) {
            return;
        }

        cofechaCellJumpIdRef.current += 1;
        setIsRawEditing(false);

        if (selectedTree !== ALL_OPTION_VALUE && selectedTree !== resolvedTree) {
            handleTreeSelectionChange(resolvedTree);
        }

        setCofechaCellJumpTarget({
            id: cofechaCellJumpIdRef.current,
            tree: resolvedTree,
            year,
        });
    }, [handleTreeSelectionChange, selectedTree, siteData]);

    const handleChartLocateWidth = useCallback((tree: string, year: number) => {
        const resolvedTree = resolveCofechaTreeCode(tree, siteData);
        if (!siteData.has(resolvedTree) || !Number.isFinite(year)) return;

        cofechaCellJumpIdRef.current += 1;
        setIsRawEditing(false);
        if (selectedTree !== resolvedTree) {
            handleTreeSelectionChange(resolvedTree);
        }
        setCofechaCellJumpTarget({
            id: cofechaCellJumpIdRef.current,
            tree: resolvedTree,
            year,
        });
    }, [handleTreeSelectionChange, selectedTree, siteData]);

    const handleOpenRawEditorForTree = useCallback((tree: string) => {
        const resolvedTree = resolveCofechaTreeCode(tree, siteData);
        if (!siteData.has(resolvedTree)) return;

        // 明确使用菜单对应的序列，避免依赖尚未完成的 selectedTree 状态更新。
        setFindReplaceOpen(false);
        setCofechaCellJumpTarget(null);
        setEditHighlightTarget(null);
        if (selectedTree !== resolvedTree) {
            handleTreeSelectionChange(resolvedTree);
        }
        setRawEditorTree(resolvedTree);
        setRawEditorInitialText(getCurrentRwlText(resolvedTree));
        setRawEditorError("");
        setIsRawEditing(true);
        setRawEditorRevision((revision) => revision + 1);
        // 从独立折线图发起时，把已打开文本编辑器的主窗口带到前台。
        void getCurrentWindow().setFocus();
    }, [getCurrentRwlText, handleTreeSelectionChange, selectedTree, siteData]);

    const handleFocusDiagnosisEvent = useCallback((event: DiagnosisEvent, selectedYear?: number) => {
        if (event.eventType === "wholeSeriesMove") {
            handleCofechaCellReferenceClick({ tree: event.seriesId });
            return;
        }
        const preferredYear = selectedYear
            ?? event.rankedYears[0]?.year
            ?? Math.round((event.startYear + event.endYear) / 2);
        handleCofechaCellReferenceClick({ tree: event.seriesId, year: preferredYear });
    }, [handleCofechaCellReferenceClick]);

    const linkedReport = useMemo(() => (
        renderCofechaHtmlWithLinks(reportText, treeOptions, cofechaPart6JumpTarget?.tree ?? null)
    ), [reportText, treeOptions, cofechaPart6JumpTarget]);

    // 拥有 PART 6 潜在问题块的序列集合（小写），用于决定右键菜单是否显示
    // “在 COFECHA 中定位”。可用 possibleProblemsDetail 不够：它只收录带 [A] Segment
    // 的序列，而仅有 [B]/[E] 等条目的序列同样出现在 PART 6 里。
    const cofechaPart6Trees = useMemo(() => {
        const trees = new Set<string>();
        for (const line of (cofechaPart6Text ?? "").split(/\r\n|\n|\r/)) {
            const match = line.match(COFECHA_PART6_SERIES_HEADER_RE);
            if (match) {
                trees.add(match[2].toLowerCase());
            }
        }
        return trees;
    }, [cofechaPart6Text]);
    const cofechaPart6TreeList = useMemo(() => Array.from(cofechaPart6Trees), [cofechaPart6Trees]);

    const handleJumpToCofechaPart6 = useCallback((tree: string) => {
        const resolvedTree = resolveCofechaTreeCode(tree, siteData);
        cofechaPart6JumpIdRef.current += 1;
        setIsRawEditing(false);
        // 已显示“全部内容”时报告已含 PART 6 区段，保持当前视图直接跳转；
        // 仅当选中了其它单一部分时才切到 PART 6，避免无谓地改动 selector。
        if (!cofechaReportShowsPart6(selectedPart)) {
            setSelectedPart(COFECHA_PART6_PART_VALUE);
        }
        setCofechaPart6JumpTarget({ id: cofechaPart6JumpIdRef.current, tree: resolvedTree });
        // 报告已弹出到独立窗口时，主窗口只剩占位符——聚焦独立窗口，让那边完成滚动。
        if (externalWorkspaceWindows.cofecha) {
            handleOpenWorkspaceWindow("cofecha");
        } else {
            // 从独立折线图发起且 COFECHA 留在主窗口时，将主窗口带到前台。
            void getCurrentWindow().setFocus();
        }
    }, [externalWorkspaceWindows.cofecha, handleOpenWorkspaceWindow, selectedPart, setSelectedPart, siteData]);

    // PART 6 跳转：切到 PART 6 且报告在主窗口内时，滚动到对应序列的标题锚点。
    useLayoutEffect(() => {
        const target = cofechaPart6JumpTarget;
        if (!target || handledCofechaPart6JumpIdRef.current === target.id) {
            return;
        }
        if (externalWorkspaceWindows.cofecha) {
            handledCofechaPart6JumpIdRef.current = target.id;
            return;
        }
        if (!cofechaReportShowsPart6(selectedPart)) {
            return; // 等 setSelectedPart 切到 PART 6、报告重渲染后再滚动
        }
        const scroller = cofechaReportScrollRef.current;
        if (!scroller) {
            return;
        }
        handledCofechaPart6JumpIdRef.current = target.id;
        const anchor = findCofechaPart6Anchor(scroller, target.tree);
        if (anchor) {
            scrollCofechaAnchorIntoView(scroller, anchor);
        }
    }, [cofechaPart6JumpTarget, externalWorkspaceWindows.cofecha, linkedReport, selectedPart]);

    // 高亮维持一段时间后清除跳转目标，报告随之去掉高亮类。
    useEffect(() => {
        const target = cofechaPart6JumpTarget;
        if (!target) {
            return;
        }
        const timer = window.setTimeout(() => {
            setCofechaPart6JumpTarget((previous) => (previous?.id === target.id ? null : previous));
        }, COFECHA_PART6_HIGHLIGHT_MS);
        return () => {
            window.clearTimeout(timer);
        };
    }, [cofechaPart6JumpTarget]);

    const workspaceWindowState = useMemo<Record<WorkspaceWindowKind, WorkspaceWindowState>>(() => ({
        "operation-log": {
            kind: "operation-log",
            fileName,
            operationLog,
            canResetToRawData,
        },
        cofecha: {
            kind: "cofecha",
            isCofechaOutdated,
            isCofechaRunning,
            canRunValidation: Boolean(fileName),
            validationSummary: crossdatingValidationSummary,
            cofechaResult: cofechaResult ? {
                possibleProblemsCount: cofechaResult.possibleProblemsCount,
                masterSeriesYear: cofechaResult.masterSeriesYear,
                seriesIntercorrelation: cofechaResult.seriesIntercorrelation,
                averageMeanSensitivity: cofechaResult.averageMeanSensitivity,
                meanLength: cofechaResult.meanLength,
            } : undefined,
            linkedReport,
            partOptions: COFECHA_PART_OPTIONS,
            selectedPart,
            jumpTarget: cofechaPart6JumpTarget ?? undefined,
        },
        "line-chart": {
            kind: "line-chart",
            siteData: serializeRwlSiteData(siteData),
            selectedTrees: chartSelectedTrees,
            focusedTree: selectedTree === ALL_OPTION_VALUE ? null : selectedTree,
            jumpTarget: chartJumpTarget ?? undefined,
            referenceConfig,
            dynamicReferenceConfig,
            diagnosis: crossdatingDiagnosis,
            diagnosisBatchResult,
            cofechaPart6Trees: cofechaPart6TreeList,
        },
    }), [canResetToRawData, chartJumpTarget, chartSelectedTrees, cofechaPart6JumpTarget, cofechaPart6TreeList, cofechaResult, crossdatingDiagnosis, crossdatingValidationSummary, diagnosisBatchResult, dynamicReferenceConfig, fileName, isCofechaOutdated, isCofechaRunning, linkedReport, operationLog, referenceConfig, selectedPart, selectedTree, siteData]);

    const handleCofechaTextClick = useCallback((event: MouseEvent<HTMLParagraphElement>) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        const link = target.closest<HTMLElement>("[data-cofecha-link='true']");
        if (!link) {
            return;
        }

        const tree = link.dataset.tree;
        const rawYear = link.dataset.year;
        const year = rawYear === undefined ? undefined : Number(rawYear);
        if (!tree || (rawYear !== undefined && !Number.isInteger(year))) {
            return;
        }

        handleCofechaCellReferenceClick({ tree, year });
    }, [handleCofechaCellReferenceClick]);

    const handleCofechaTextKeyDown = useCallback((event: KeyboardEvent<HTMLParagraphElement>) => {
        if (event.key !== "Enter" && event.key !== " ") {
            return;
        }

        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        const link = target.closest<HTMLElement>("[data-cofecha-link='true']");
        if (!link) {
            return;
        }

        const tree = link.dataset.tree;
        const rawYear = link.dataset.year;
        const year = rawYear === undefined ? undefined : Number(rawYear);
        if (!tree || (rawYear !== undefined && !Number.isInteger(year))) {
            return;
        }

        event.preventDefault();
        handleCofechaCellReferenceClick({ tree, year });
    }, [handleCofechaCellReferenceClick]);

    // 始终持有最新的工作区状态 / 命令处理函数，供「只注册一次」的事件监听器读取。
    // 若把它们放进监听器 effect 的依赖里，每次状态变化都会重注册监听器，
    // 其异步间隙会丢掉子窗口发来的 COMMAND（例如独立窗口里切换 PART 不生效）。
    const workspaceWindowStateRef = useRef(workspaceWindowState);
    useEffect(() => {
        workspaceWindowStateRef.current = workspaceWindowState;
    }, [workspaceWindowState]);

    const emitWorkspaceState = useCallback((kind: WorkspaceWindowKind, targetLabel = workspaceWindowLabels[kind]) => {
        void emitTo(targetLabel, WORKSPACE_WINDOW_STATE_EVENT, {
            kind,
            state: workspaceWindowStateRef.current[kind],
        });
    }, []);

    const handleWorkspaceWindowCommand = useCallback((command: WorkspaceWindowCommand) => {
        switch (command.kind) {
            case "operation-log":
                if (command.type === "undo-log-entry") {
                    handleUndoOperationLogEntry(command.entryId);
                } else if (command.type === "reset-to-raw") {
                    handleResetToRawData();
                } else {
                    handleCofechaCellReferenceClick({ tree: command.tree, year: command.year });
                }
                break;
            case "cofecha":
                if (command.type === "select-part") {
                    setSelectedPart(command.part);
                } else if (command.type === "run-validation") {
                    void handleRunCofechaValidation();
                } else {
                    handleCofechaCellReferenceClick({ tree: command.tree, year: command.year });
                }
                break;
            case "line-chart":
                if (command.type === "set-selection") {
                    handleChartSelectedTreesChange(command.trees);
                } else if (command.type === "locate-width") {
                    handleChartLocateWidth(command.tree, command.year);
                } else if (command.type === "edit-as-text") {
                    handleOpenRawEditorForTree(command.tree);
                } else if (command.type === "locate-cofecha") {
                    handleJumpToCofechaPart6(command.tree);
                } else if (command.type === "set-reference") {
                    handleReferenceConfigChange(command.config);
                } else if (command.type === "reset-reference-dynamic") {
                    handleResetReferenceToDynamic();
                } else if (command.type === "apply-diagnosis-candidate") {
                    handleApplyDiagnosisCandidate(command.candidate);
                } else if (command.type === "apply-diagnosis-candidates") {
                    handleApplyDiagnosisCandidateBatch(command.candidates);
                } else if (command.type === "apply-local-simulation") {
                    handleApplyLocalSimulation(command.request);
                } else if (command.type === "insert-missing") {
                    handleInsertMissingYearAtSideFromChart(command.tree, command.year, command.side);
                } else if (command.type === "delete-year") {
                    handleDeleteYearWithModeFromChart(command.tree, command.year, command.mode, command.shift);
                } else if (command.type === "delete-series") {
                    handleDeleteSeriesFromChart(command.tree);
                }
                break;
        }
    }, [
        handleCofechaCellReferenceClick,
        handleChartLocateWidth,
        handleChartSelectedTreesChange,
        handleJumpToCofechaPart6,
        handleOpenRawEditorForTree,
        handleDeleteSeriesFromChart,
        handleDeleteYearWithModeFromChart,
        handleApplyDiagnosisCandidate,
        handleApplyDiagnosisCandidateBatch,
        handleApplyLocalSimulation,
        handleInsertMissingYearAtSideFromChart,
        handleReferenceConfigChange,
        handleResetReferenceToDynamic,
        handleRunCofechaValidation,
        handleResetToRawData,
        handleUndoOperationLogEntry,
        setSelectedPart,
    ]);

    const handleWorkspaceWindowCommandRef = useRef(handleWorkspaceWindowCommand);
    useEffect(() => {
        handleWorkspaceWindowCommandRef.current = handleWorkspaceWindowCommand;
    }, [handleWorkspaceWindowCommand]);

    useEffect(() => {
        let isMounted = true;
        const unlisteners: UnlistenFn[] = [];

        const setup = async () => {
            unlisteners.push(await listen<WorkspaceWindowRequestPayload>(
                WORKSPACE_WINDOW_REQUEST_EVENT,
                (event) => {
                    if (!isMounted) return;
                    if (!isWorkspaceWindowLabel(event.payload.kind, event.payload.requesterLabel)) return;
                    // 窗口主动请求状态即代表其存活，标记为已打开，
                    // 以便后续状态变化（如切换 PART）能继续同步过去。
                    setExternalWorkspaceWindows((previous) => (
                        previous[event.payload.kind]
                            ? previous
                            : { ...previous, [event.payload.kind]: true }
                    ));
                    emitWorkspaceState(event.payload.kind, event.payload.requesterLabel);
                },
            ));
            unlisteners.push(await listen<WorkspaceWindowCommand>(
                WORKSPACE_WINDOW_COMMAND_EVENT,
                (event) => {
                    if (!isMounted) return;
                    handleWorkspaceWindowCommandRef.current(event.payload);
                },
            ));
            unlisteners.push(await listen<WorkspaceWindowClosedPayload>(
                WORKSPACE_WINDOW_CLOSED_EVENT,
                (event) => {
                    if (!isMounted) return;
                    if (!isWorkspaceWindowLabel(event.payload.kind, event.payload.requesterLabel)) return;
                    setExternalWorkspaceWindows((previous) => ({
                        ...previous,
                        [event.payload.kind]: false,
                    }));
                },
            ));
        };

        void setup();

        return () => {
            isMounted = false;
            unlisteners.forEach((unlisten) => unlisten());
        };
    }, [emitWorkspaceState]);

    useEffect(() => {
        (Object.keys(externalWorkspaceWindows) as WorkspaceWindowKind[]).forEach((kind) => {
            if (externalWorkspaceWindows[kind]) {
                emitWorkspaceState(kind);
            }
        });
        // 依赖 workspaceWindowState：状态变化时把最新快照推送给所有已打开的独立窗口。
    }, [emitWorkspaceState, externalWorkspaceWindows, workspaceWindowState]);

    const jumpToCellRef = useRef(handleCofechaCellReferenceClick);
    useEffect(() => {
        jumpToCellRef.current = handleCofechaCellReferenceClick;
    }, [handleCofechaCellReferenceClick]);

    // 左侧宽度模块：把查找词解析为宽度值，命中所有等于该值的年轮单元格。
    const widthMatches = useMemo(() => {
        const queryValue = Number(findQuery.trim());
        if (findQuery.trim() === "" || !Number.isFinite(queryValue) || queryValue === stopMarker.value) {
            return [] as { tree: string; year: number }[];
        }

        const matches: { tree: string; year: number }[] = [];
        siteData.forEach((treeData, tree) => {
            treeData.forEach((width, year) => {
                if (width === queryValue) {
                    matches.push({ tree, year });
                }
            });
        });
        return matches;
    }, [findQuery, siteData]);

    const matchCount = widthMatches.length;
    const effectiveMatchIndex = matchCount > 0 ? ((findMatchIndex % matchCount) + matchCount) % matchCount : 0;

    const currentWidthMatch = findReplaceOpen && matchCount > 0
        ? widthMatches[effectiveMatchIndex]
        : undefined;
    const currentWidthMatchTree = currentWidthMatch?.tree;
    const currentWidthMatchYear = currentWidthMatch?.year;

    // 查找：当前命中变化时滚动并高亮对应单元格（复用 COFECHA 跳转逻辑）。
    useEffect(() => {
        if (currentWidthMatchTree === undefined || currentWidthMatchYear === undefined) {
            return;
        }
        jumpToCellRef.current({ tree: currentWidthMatchTree, year: currentWidthMatchYear });
    }, [currentWidthMatchTree, currentWidthMatchYear]);

    const handleOpenFind = useCallback(() => {
        setFindReplaceMode("find");
        setFindReplaceOpen(true);
    }, []);

    const handleOpenReplace = useCallback(() => {
        setFindReplaceMode("replace");
        setFindReplaceOpen(true);
    }, []);

    const handleCloseFindReplace = useCallback(() => {
        setFindReplaceOpen(false);
    }, []);

    const handleFindModeChange = useCallback((mode: FindReplaceMode) => {
        setFindReplaceMode(mode);
    }, []);

    const handleFindQueryChange = useCallback((query: string) => {
        setFindQuery(query);
        setFindMatchIndex(0);
    }, []);

    const handleFindNext = useCallback(() => {
        setFindMatchIndex((previous) => matchCount > 0 ? (previous + 1) % matchCount : 0);
    }, [matchCount]);

    const handleFindPrev = useCallback(() => {
        setFindMatchIndex((previous) => matchCount > 0 ? (previous - 1 + matchCount) % matchCount : 0);
    }, [matchCount]);

    const handleReplaceOne = useCallback(() => {
        const replaceNumber = Number(replaceValue.trim());
        if (replaceValue.trim() === "" || !Number.isFinite(replaceNumber) || replaceNumber === Number(findQuery.trim())) {
            return;
        }
        const match = widthMatches[effectiveMatchIndex];
        const treeData = match ? siteData.get(match.tree) : undefined;
        if (!match || !treeData) {
            return;
        }
        const nextData = new Map(treeData);
        nextData.set(match.year, replaceNumber);
        handleReplaceTreeData(match.tree, nextData);
    }, [findQuery, replaceValue, widthMatches, effectiveMatchIndex, siteData, handleReplaceTreeData]);

    const handleReplaceAll = useCallback(() => {
        if (widthMatches.length === 0) {
            return;
        }
        const replaceNumber = Number(replaceValue.trim());
        if (replaceValue.trim() === "" || !Number.isFinite(replaceNumber) || replaceNumber === Number(findQuery.trim())) {
            return;
        }

        const yearsByTree = new Map<string, number[]>();
        widthMatches.forEach(({ tree, year }) => {
            const years = yearsByTree.get(tree) ?? [];
            years.push(year);
            yearsByTree.set(tree, years);
        });

        yearsByTree.forEach((years, tree) => {
            const treeData = siteData.get(tree);
            if (!treeData) {
                return;
            }
            const nextData = new Map(treeData);
            years.forEach((year) => nextData.set(year, replaceNumber));
            handleReplaceTreeData(tree, nextData);
        });

        setFindMatchIndex(0);
    }, [findQuery, replaceValue, widthMatches, siteData, handleReplaceTreeData]);

    const getRawEditorText = useCallback(() => (
        rawEditorRef.current?.innerText ?? rawEditorInitialText
    ), [rawEditorInitialText]);

    const handleCancelRawEditor = useCallback(() => {
        setIsRawEditing(false);
        setRawEditorError("");
    }, []);

    const applyRawEditor = useCallback(async (refocusOnError = false) => {
        try {
            const before = siteData;
            const after = rawEditorTree
                ? await applyRawRwlTextForTree(getRawEditorText(), rawEditorTree)
                : await applyRawRwlText(getRawEditorText());
            setIsRawEditing(false);
            setRawEditorError("");

            // 对比编辑前后的数据，找出被改动的格子；按显示顺序的第一条被改序列作为滚动目标。
            const changed: { tree: string; year: number }[] = [];
            after.forEach((treeData, tree) => {
                const beforeTree = before.get(tree);
                treeData.forEach((width, year) => {
                    if (typeof width === "number" && width !== stopMarker.value && beforeTree?.get(year) !== width) {
                        changed.push({ tree, year });
                    }
                });
            });

            if (changed.length > 0) {
                const scrollTree = changed[0].tree;
                const scrollYear = changed
                    .filter((cell) => cell.tree === scrollTree)
                    .reduce((min, cell) => Math.min(min, cell.year), Number.POSITIVE_INFINITY);

                // 若当前只显示某一条序列、而改动不止落在它上面，切回"全部"以便看到/滚动到被改序列。
                const changedTrees = new Set(changed.map((cell) => cell.tree));
                const confinedToSelected = changedTrees.size === 1 && changedTrees.has(selectedTree);
                if (selectedTree !== ALL_OPTION_VALUE && !confinedToSelected) {
                    handleTreeSelectionChange(ALL_OPTION_VALUE);
                }

                editHighlightIdRef.current += 1;
                const highlightTarget: EditHighlightTarget = {
                    id: editHighlightIdRef.current,
                    cells: changed,
                    scrollTree,
                    scrollYear: Number.isFinite(scrollYear) ? scrollYear : undefined,
                };
                // 退出文本模式会让 WidthContainer 全新重挂载；它消费跳转的 layout effect 会
                // 在祖先（FloatingScrollArea）的滚动容器 ref attach 之前先跑，此时拿不到滚动容器
                // 而直接放弃。推迟到下一帧再设目标，保证在“已挂载”的更新渲染里触发，一次到位。
                window.requestAnimationFrame(() => {
                    setEditHighlightTarget(highlightTarget);
                });
            } else {
                setEditHighlightTarget(null);
            }
            return true;
        } catch (error) {
            setRawEditorError(getErrorMessage(error));
            if (refocusOnError) {
                window.requestAnimationFrame(() => {
                    rawEditorRef.current?.focus();
                });
            }
            return false;
        }
    }, [applyRawRwlText, applyRawRwlTextForTree, rawEditorTree, getRawEditorText, siteData, selectedTree, handleTreeSelectionChange]);

    const handleApplyRawEditor = useCallback(async () => {
        await applyRawEditor();
    }, [applyRawEditor]);

    const handleLoad = useCallback(async () => {
        setIsRawEditing(false);
        setRawEditorError("");
        setCofechaCellJumpTarget(null);
        setEditHighlightTarget(null);
        await handleWorkspaceLoad();
    }, [handleWorkspaceLoad]);

    const handleSave = useCallback(async () => {
        // 文本编辑视图下：保存即"应用更改 + 退出编辑 + 写入文件"。
        if (isRawEditing) {
            const applied = await applyRawEditor();
            if (applied) {
                await handleStructuredSave();
            }
            return;
        }
        await handleStructuredSave();
    }, [applyRawEditor, handleStructuredSave, isRawEditing]);

    const handleSaveAs = useCallback(async () => {
        if (isRawEditing) {
            const applied = await applyRawEditor();
            if (applied) {
                await handleStructuredSaveAs();
            }
            return;
        }
        await handleStructuredSaveAs();
    }, [applyRawEditor, handleStructuredSaveAs, isRawEditing]);

    const handleRawEditorInput = useCallback(() => {
        if (rawEditorError) {
            setRawEditorError("");
        }
    }, [rawEditorError]);

    const handleRawEditorPaste = useCallback((event: ClipboardEvent<HTMLParagraphElement>) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        document.execCommand("insertText", false, text);
    }, []);

    const handleRawEditorKeyDown = useCallback((event: KeyboardEvent<HTMLParagraphElement>) => {
        const key = event.key.toLowerCase();
        const isCommandKey = event.ctrlKey || event.metaKey;

        if (isCommandKey && key === "s") {
            event.preventDefault();
            // 忽略按住时的自动重复，避免连续触发保存与 COFECHA 验证。
            if (event.repeat) {
                return;
            }
            void handleSave();
            return;
        }

        if (isCommandKey && event.key === "Enter") {
            event.preventDefault();
            void applyRawEditor();
            return;
        }

        if (event.key === "Escape") {
            event.preventDefault();
            handleCancelRawEditor();
        }
    }, [applyRawEditor, handleCancelRawEditor, handleSave]);

    useEffect(() => {
        if (!isRawEditing) {
            return;
        }

        const frameId = window.requestAnimationFrame(() => {
            rawEditorRef.current?.focus();
        });

        return () => {
            window.cancelAnimationFrame(frameId);
        };
    }, [isRawEditing, rawEditorRevision]);

    // 标题栏图例的 portal 挂载点（位于 index.html 的 .titlebar 内）
    useEffect(() => {
        setLegendContainer(document.getElementById("titlebar-legend-container"));
    }, []);

    return (
        <>
            <HomeTitleBarBridge
                title={windowTitle}
                cofechaVersion={cofechaVersion}
                onLoad={handleLoad}
                onSave={handleSave}
                onSaveAs={handleSaveAs}
                onUndo={handleUndo}
                onRedo={handleRedo}
                canUndo={historyStatus.undoCount > 0}
                canRedo={historyStatus.redoCount > 0}
                onCofechaVersionChange={setCofechaVersion}
                onActiveMenuChange={setActiveMenu}
                onOpenOperationLog={() => handleOpenWorkspaceWindow("operation-log")}
                onOpenSettings={openSettingsWindow}
                onOpenFind={handleOpenFind}
                onOpenReplace={handleOpenReplace}
            />

            <div className={style["home-container"]} ref={homeContainerRef}>
                <AnimatePresence>
                    {findReplaceOpen ? (
                        <FindReplaceBar
                            key="find-replace"
                            mode={findReplaceMode}
                            query={findQuery}
                            replaceValue={replaceValue}
                            matchIndex={effectiveMatchIndex}
                            matchCount={matchCount}
                            onModeChange={handleFindModeChange}
                            onQueryChange={handleFindQueryChange}
                            onReplaceValueChange={setReplaceValue}
                            onNext={handleFindNext}
                            onPrev={handleFindPrev}
                            onReplaceOne={handleReplaceOne}
                            onReplaceAll={handleReplaceAll}
                            onClose={handleCloseFindReplace}
                        />
                    ) : null}
                </AnimatePresence>
                <div
                    className={style["width-module"]}
                    style={widthModuleStyle}
                >
                    {isRawEditing ? (
                        <div className={style["raw-width-container"]}>
                            <div className={style["raw-editor-actions"]}>
                                <button
                                    type="button"
                                    className={style["raw-editor-button"]}
                                    title="应用文本编辑"
                                    aria-label="应用文本编辑"
                                    onClick={handleApplyRawEditor}
                                >
                                    ✓
                                </button>
                                <button
                                    type="button"
                                    className={style["raw-editor-button"]}
                                    title="取消文本编辑"
                                    aria-label="取消文本编辑"
                                    onClick={handleCancelRawEditor}
                                >
                                    ×
                                </button>
                            </div>

                            <p
                                key={rawEditorRevision}
                                ref={rawEditorRef}
                                className={`${style["width-text"]} ${rawEditorError ? style["raw-editor-invalid"] : ""}`}
                                contentEditable
                                suppressContentEditableWarning
                                role="textbox"
                                aria-label="RWL 文本编辑器"
                                aria-multiline="true"
                                spellCheck={false}
                                onInput={handleRawEditorInput}
                                onPaste={handleRawEditorPaste}
                                onKeyDown={handleRawEditorKeyDown}
                            >
                                {rawEditorInitialText}
                            </p>
                            <FloatingScrollbar
                                targetRef={rawEditorRef}
                                revision={rawEditorRevision}
                            />

                            {rawEditorError ? (
                                <div className={style["raw-editor-error"]}>
                                    {rawEditorError}
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <div className={style["structured-width-container"]}>
                            {!shouldShowWidthSkeleton ? (
                                <select
                                    name="trees"
                                    id={style["tree_selector"]}
                                    value={selectedTree}
                                    onChange={(event) => {
                                        handleTreeSelectionChange(event.target.value);
                                    }}
                                >
                                    <option key={ALL_OPTION_VALUE} value={ALL_OPTION_VALUE}>
                                        {TREE_ALL_OPTION_LABEL}
                                    </option>
                                    {treeOptions.map((tree) => (
                                        <option key={tree} value={tree}>
                                            {hasCofechaSeriesMapValue(possibleProblemsDetail, tree) ? TREE_WARNING_MARK : TREE_NORMAL_MARK}{tree}
                                        </option>
                                    ))}
                                </select>
                            ) : null}
                            {legendContainer && !shouldShowWidthSkeleton
                                ? createPortal(
                                    <div aria-hidden="true" style={{ display: "contents" }}>
                                        <span className={style["legend-item"]}>
                                            <span className={`${style["legend-swatch"]} ${style["legend-swatch-narrow"]}`} />
                                            窄年
                                        </span>
                                        <span className={style["legend-item"]}>
                                            <span className={`${style["legend-swatch"]} ${style["legend-swatch-false-ring"]}`} />
                                            伪轮
                                        </span>
                                        <span className={style["legend-item"]}>
                                            <span className={`${style["legend-swatch"]} ${style["legend-swatch-absent"]}`} />
                                            缺轮
                                        </span>
                                        <span className={style["legend-item"]}>
                                            <span className={`${style["legend-swatch"]} ${style["legend-swatch-missing"]}`} />
                                            缺测
                                        </span>
                                    </div>,
                                    legendContainer,
                                )
                                : null}

                            <div className={style["width-panels"]} ref={leftPanelsRef}>
                                <FloatingScrollArea
                                    viewportClassName={`${style["data-viewport"]} ${activeMenu ? style["z-index-1"] : ""}`}
                                    viewportStyle={dataContainerStyle}
                                    className={style["data-container"]}
                                    aria-busy={shouldShowProcessing}
                                    topClearanceSelector="[data-grid-header]"
                                    scrollbarRevision={`${shouldShowWidthSkeleton}:${selectedTree ?? ""}`}
                                >
                                    {(dataContainerRef) => (
                                        <>
                                            {shouldShowWidthSkeleton ? (
                                                <>
                                                    <WidthGridSkeleton showRows={isFileLoading} />
                                                    {shouldShowWelcome ? (
                                                        <div className={style["width-empty-state"]}>
                                                            <img src="IDM.png" className={style["width-empty-state-image"]} alt="IDM" />
                                                            <p className={style["width-empty-state-developers"]}>{WELCOME_TEXT}</p>
                                                        </div>
                                                    ) : null}
                                                </>
                                            ) : (
                                                <WidthContainer
                                                    siteData={siteData}
                                                    selected={selectedTree}
                                                    suggestedRanges={suggestedRangeHighlights}
                                                    masterSeries={cofechaResult?.masterDatingSeries}
                                                    cofechaPassReference={dynamicReferenceConfig?.cofechaPassReference ?? null}
                                                    masterCorrelations={cofechaResult?.masterCorrelations}
                                                    seriesProblemCounts={cofechaResult?.seriesProblemCounts}
                                                    historyAnimation={historyAnimation}
                                                    jumpTarget={cofechaCellJumpTarget}
                                                    editHighlightTarget={editHighlightTarget}
                                                    deleteSeriesRequest={deleteSeriesRequest}
                                                    deletionMarkers={deletionMarkers}
                                                    scrollContainerRef={dataContainerRef}
                                                    onInsertMissingYearAtSide={handleInsertMissingYearAtSide}
                                                    onMoveSeriesTailByOffset={handleMoveSeriesTailByOffset}
                                                    onDeleteYearWithMode={handleDeleteYearWithMode}
                                                    onMarkYearRangeAsMissing={handleMarkYearRangeAsMissing}
                                                    onRestoreDeletion={handleRestoreDeletion}
                                                    onDeleteSeries={handleDeleteSeries}
                                                    onEditAsText={handleOpenRawEditorForTree}
                                                    onDeleteSeriesRequestHandled={handleDeleteSeriesRequestHandled}
                                                    onReplaceTreeData={handleReplaceTreeData}
                                                    onApplyBayesianStartYear={handleApplyBayesianStartYear}
                                                    onJumpToChart={handleJumpToChart}
                                                    onJumpToCofecha={handleJumpToCofechaPart6}
                                                    cofechaPart6Trees={cofechaPart6Trees}
                                                />
                                            )}

                                            {shouldShowProcessing ? (
                                                <div className={style["processing-mask"]}>
                                                    <span>{processingText}</span>
                                                </div>
                                            ) : null}
                                        </>
                                    )}
                                </FloatingScrollArea>

                                {showProblemsPanel ? (
                                    <>
                                        <div
                                            role="separator"
                                            aria-orientation="horizontal"
                                            aria-label="调整数据区和问题区高度"
                                            className={`${nestedDividerClassName} ${draggingKey === "leftBottomRatio" ? style["panel-divider-active"] : ""} ${leftBottomDividerCollapsed ? style["panel-divider-collapsed"] : ""}`}
                                            onPointerDown={startResize({
                                                key: "leftBottomRatio",
                                                axis: "y",
                                                container: () => leftPanelsRef.current,
                                                minStart: 220,
                                                minEnd: 0,
                                            })}
                                        />

                                        <div className={style["problems-container"]}>
                                            <div className={style["problem-tabs"]}>
                                                <button
                                                    type="button"
                                                    className={`${style["problem-tab"]} ${activeProblemTab === "problems" ? style["problem-tab-active"] : ""}`}
                                                    disabled={!problemTabAvailable}
                                                    onClick={() => setProblemTab("problems")}
                                                >
                                                    可能问题
                                                </button>
                                                <button
                                                    type="button"
                                                    className={`${style["problem-tab"]} ${activeProblemTab === "candidates" ? style["problem-tab-active"] : ""}`}
                                                    disabled={!candidateTabAvailable}
                                                    onClick={() => setProblemTab("candidates")}
                                                >
                                                    定年建议
                                                    {currentEventTabAvailable
                                                        ? visibleCurrentEventSession.status === "running"
                                                            ? " · 模型计算中"
                                                            : ` · 模型 ${currentEventSuggestionCount}`
                                                        : ""}
                                                    {selectedTreeEvents.length > 0 ? ` · 事件 ${selectedTreeEvents.length}` : ""}
                                                    {isEventDiagnosisRunning ? " · 计算中" : ""}
                                                </button>
                                            </div>

                                            <FloatingScrollArea className={style["problem-tab-body"]}>
                                                {activeProblemTab === "candidates" ? (
                                                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                                        {currentEventTabAvailable ? (
                                                            <CurrentEventSuggestionPanel
                                                                session={visibleCurrentEventSession}
                                                                models={currentEventModels}
                                                                activeModelId={activeCurrentEventModelId}
                                                                modelCatalogError={currentEventModelCatalogError}
                                                                targetSeriesId={selectedTree}
                                                                isFileModified={isModified}
                                                                onAnalyze={handleRunCurrentEventRanker}
                                                                onConfirmYear={handleConfirmCurrentEventYear}
                                                                onUndoConfirmation={handleUndoCurrentEventConfirmation}
                                                                onApplyConfirmedYears={handleApplyCurrentEventConfirmedYears}
                                                                onCancel={cancelCurrentEventRanker}
                                                                onRetry={retryCurrentEventRanker}
                                                                onFocusSuggestion={setFocusedCurrentEventSuggestion}
                                                                onSelectModel={selectCurrentEventModel}
                                                            />
                                                        ) : null}
                                                        {selectedTreeEvents.length > 0 ? (
                                                            <DiagnosisEventPanel
                                                                events={selectedTreeEvents}
                                                                onFocusEvent={handleFocusDiagnosisEvent}
                                                                onApplyEvent={handleApplyDiagnosisEvent}
                                                            />
                                                        ) : null}
                                                        {isEventDiagnosisRunning && selectedTreeEvents.length === 0 ? (
                                                            <div style={{ padding: "8px 6px", color: "#6b7280", fontSize: 12 }}>
                                                                正在计算当前序列的事件级诊断...
                                                            </div>
                                                        ) : null}
                                                    </div>
                                                ) : (
                                                    <p className={style["potential-problems"]}>
                                                        {selectedProblemText}
                                                    </p>
                                                )}
                                            </FloatingScrollArea>
                                        </div>
                                    </>
                                ) : null}
                            </div>
                        </div>
                    )}
                </div>

                <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整年轮数据区和 COFECHA 区宽度"
                    className={mainDividerClassName}
                    onPointerDown={startResize({
                        key: "mainSplitRatio",
                        axis: "x",
                        container: () => homeContainerRef.current,
                        minStart: 0,
                        minEnd: 0,
                    })}
                />

                <div className={style["cofecha-module"]}>
                    <FloatingScrollArea
                        className={style["statics-info"]}
                        viewportClassName={style["statics-info-viewport"]}
                    >
                        <span className={style["stat-item"]} style={{ color: problemTextColor }}>
                            <span className={style["stat-label"]}>*A*</span>
                            <span className={style["stat-value"]}>
                                <CofechaStatValue value={cofechaResult?.possibleProblemsCount} showSkeleton={shouldShowRightSkeleton} />
                            </span>
                        </span>
                        <span className={style["stat-item"]}>
                            <span className={style["stat-label"]}>Master series</span>
                            <span className={style["stat-value"]}>
                                <CofechaStatValue value={cofechaResult?.masterSeriesYear} showSkeleton={shouldShowRightSkeleton} />
                            </span>
                        </span>
                        <span className={style["stat-item"]}>
                            <span className={style["stat-label"]}>Intercorrelation</span>
                            <span className={style["stat-value"]}>
                                <CofechaStatValue value={cofechaResult?.seriesIntercorrelation} showSkeleton={shouldShowRightSkeleton} />
                            </span>
                        </span>
                        <span className={style["stat-item"]}>
                            <span className={style["stat-label"]}>Mean sensitivity</span>
                            <span className={style["stat-value"]}>
                                <CofechaStatValue value={cofechaResult?.averageMeanSensitivity} showSkeleton={shouldShowRightSkeleton} />
                            </span>
                        </span>
                        <span className={style["stat-item"]}>
                            <span className={style["stat-label"]}>Mean length</span>
                            <span className={style["stat-value"]}>
                                <CofechaStatValue value={cofechaResult?.meanLength} showSkeleton={shouldShowRightSkeleton} />
                            </span>
                        </span>
                    </FloatingScrollArea>
                    <div className={`${style["validation-summary"]} ${style[`validation-${crossdatingValidationSummary.severity}`]}`}>
                        <div>
                            <strong>{crossdatingValidationSummary.title}</strong>
                            <span>{crossdatingValidationSummary.detail}</span>
                        </div>
                        {crossdatingValidationSummary.items.length > 0 ? (
                            <ul>
                                {crossdatingValidationSummary.items.slice(0, 3).map((item) => (
                                    <li key={item}>{item}</li>
                                ))}
                            </ul>
                        ) : null}
                    </div>

                    <div className={style["cofecha-panels"]} ref={rightPanelsRef}>
                        <div
                            className={style["cofecha-pane"]}
                            style={cofechaTextStyle}
                            onContextMenu={handlePanelContextMenu("cofecha")}
                        >
                            {externalWorkspaceWindows.cofecha ? (
                                <WorkspaceWindowPlaceholder
                                    message="COFECHA 已在独立窗口打开"
                                    onFocusWindow={() => handleOpenWorkspaceWindow("cofecha")}
                                />
                            ) : (
                                <>
                                    {!shouldShowRightSkeleton ? (
                                        <div className={style["cofecha-toolbar"]}>
                                            <select
                                                name="cofecha"
                                                id={style["cofecha-selector"]}
                                                value={selectedPart}
                                                onChange={(event) => {
                                                    setSelectedPart(event.target.value);
                                                }}
                                            >
                                                {COFECHA_PART_OPTIONS.map((option) => (
                                                    <option key={option.value} value={option.value}>
                                                        {option.label}
                                                    </option>
                                                ))}
                                            </select>
                                            <button
                                                type="button"
                                                className={style["cofecha-validation-button"]}
                                                disabled={!fileName || isCofechaRunning}
                                                title={fileName ? "用当前工作数据重新运行 COFECHA" : "打开 RWL 文件后才能运行 COFECHA"}
                                                onClick={() => { void handleRunCofechaValidation(); }}
                                            >
                                                {isCofechaRunning ? "正在验证" : "重新验证"}
                                            </button>
                                            {linkedReport.count > 0 ? (
                                                <span className={style["cofecha-link-count"]}>
                                                    跳转链接 {linkedReport.count}
                                                </span>
                                            ) : null}
                                            {isCofechaOutdated ? (
                                                <span
                                                    className={style["cofecha-outdated-badge"]}
                                                    title="当前 RWL 工作数据或 COFECHA 版本已变化，可以手动重新验证当前工作数据。"
                                                >
                                                    COFECHA 待验证
                                                </span>
                                            ) : null}
                                        </div>
                                    ) : (
                                        <CofechaToolbarSkeleton />
                                    )}

                                    <FloatingScrollArea
                                        ref={cofechaReportScrollRef}
                                        className={style["full-text"]}
                                    >
                                        <div className={style["cofecha-panel-content"]}>
                                            {shouldShowRightSkeleton ? (
                                                <CofechaEmptySkeleton />
                                            ) : !hasChart ? (
                                                <CofechaEmptyState />
                                            ) : (
                                                <p
                                                    id={style["cofecha-text"]}
                                                    onClick={handleCofechaTextClick}
                                                    onKeyDown={handleCofechaTextKeyDown}
                                                    dangerouslySetInnerHTML={{ __html: linkedReport.html }}
                                                />
                                            )}
                                        </div>
                                    </FloatingScrollArea>
                                </>
                            )}
                        </div>

                        {shouldShowRightBottomPane ? (
                            <>
                                <div
                                    role="separator"
                                    aria-orientation="horizontal"
                                    aria-label="调整 COFECHA 文本和折线图高度"
                                    className={`${nestedDividerClassName} ${draggingKey === "rightBottomRatio" ? style["panel-divider-active"] : ""} ${rightBottomDividerCollapsed ? style["panel-divider-collapsed"] : ""}`}
                                    onPointerDown={startResize({
                                        key: "rightBottomRatio",
                                        axis: "y",
                                        container: () => rightPanelsRef.current,
                                        minStart: 0,
                                        minEnd: 0,
                                    })}
                                />

                                <FloatingScrollArea
                                    className={style["line-chart"]}
                                    onContextMenu={handlePanelContextMenu("line-chart")}
                                >
                                    {externalWorkspaceWindows["line-chart"] ? (
                                        <div className={`${style["cofecha-panel-content"]} ${style["line-chart-content"]}`}>
                                            <WorkspaceWindowPlaceholder
                                                message="Line Chart 已在独立窗口打开"
                                                onFocusWindow={() => handleOpenWorkspaceWindow("line-chart")}
                                            />
                                        </div>
                                    ) : (
                                        <div className={`${style["cofecha-panel-content"]} ${style["line-chart-content"]}`}>
                                            {shouldShowRightSkeleton ? (
                                                <LineChartEmptySkeleton />
                                            ) : !hasChart ? (
                                                <LineChartEmptyState />
                                            ) : (
                                                <TreeChartManager
                                                    fullData={siteData}
                                                    selectedTrees={chartSelectedTrees}
                                                    focusedTree={selectedTree === ALL_OPTION_VALUE ? null : selectedTree}
                                                    jumpTarget={chartJumpTarget}
                                                    referenceConfig={referenceConfig}
                                                    dynamicReferenceConfig={dynamicReferenceConfig}
                                                    diagnosis={crossdatingDiagnosis}
                                                    diagnosisBatchResult={diagnosisBatchResult}
                                                    onReferenceConfigChange={handleReferenceConfigChange}
                                                    onResetReferenceToDynamic={handleResetReferenceToDynamic}
                                                    onApplyDiagnosisCandidate={handleApplyDiagnosisCandidate}
                                                    onApplyDiagnosisCandidateBatch={handleApplyDiagnosisCandidateBatch}
                                                    onApplyLocalSimulation={handleApplyLocalSimulation}
                                                    onInsertMissingYearAtSide={handleInsertMissingYearAtSideFromChart}
                                                    onDeleteYearWithMode={handleDeleteYearWithModeFromChart}
                                                    onDeleteSeries={handleDeleteSeriesFromChart}
                                                    onSelectedTreesChange={handleChartSelectedTreesChange}
                                                    onLocateWidth={handleChartLocateWidth}
                                                    onEditAsText={handleOpenRawEditorForTree}
                                                    onJumpToCofecha={handleJumpToCofechaPart6}
                                                    cofechaPart6Trees={cofechaPart6TreeList}
                                                />
                                            )}
                                        </div>
                                    )}
                                </FloatingScrollArea>
                            </>
                        ) : null}
                    </div>
                </div>
            </div>

            <ContextMenu
                open={panelContextMenu !== null}
                x={panelContextMenu?.x ?? 0}
                y={panelContextMenu?.y ?? 0}
                items={panelContextMenuItems}
                onClose={closePanelContextMenu}
            />
        </>
    );
}
