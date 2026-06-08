import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ClipboardEvent, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { TreeChartManager } from "@/components/Chart/TreeChartManager";
import { RollingNumber } from "@/components/RollingNumber/RollingNumber";
import WidthContainer from "@/components/WidthContainer/WidthContainer";
import { OverlayScroll } from "@/components/OverlayScroll/OverlayScroll";
import { FloatingScrollbar } from "@/components/FloatingScrollbar/FloatingScrollbar";
import { openSettingsWindow } from "@/pages/settings/openSettingsWindow";
import style from "./Home.module.css";
import { ALL_OPTION_VALUE, TitleMenuKind } from "./home/constants";
import { HomeTitleBarBridge } from "./home/HomeTitleBarBridge";
import { useHomeWorkspace } from "./home/useHomeWorkspace";
import { useResizablePanels } from "./useResizablePanels";

const TREE_ALL_OPTION_LABEL = "📜 全部";
const TREE_WARNING_MARK = "⚠️";
const TREE_NORMAL_MARK = "🪵";
const WELCOME_TEXT = "开发者：何志浩、张同文、张瑞波、靳春寒、喻树龙、尚华明、秦莉";
const PANEL_DIVIDER_GUTTER_SIZE = 8;
const COLLAPSED_PANEL_RATIO = 0.995;

const COFECHA_PART_OPTIONS = [
    { value: ALL_OPTION_VALUE, label: "📜 全部内容" },
    { value: "PART 1", label: "📌 PART 1: Summary" },
    { value: "PART 2", label: "📈 PART 2: Time Plot of Series" },
    { value: "PART 3", label: "⭐ PART 3: Master Dating Series" },
    { value: "PART 4", label: "📊 PART 4: Master Bar Plot" },
    { value: "PART 5", label: "🔗 PART 5: Correlation of Series by Segment" },
    { value: "PART 6", label: "⚠️ PART 6: Potential Problems" },
    { value: "PART 7", label: "🪧 PART 7: Descriptive Statistics" },
];

type DeleteSeriesRequest = {
    id: number;
    tree: string;
};

type CofechaCellJumpTarget = {
    id: number;
    tree: string;
    year?: number;
};

type CofechaCellReference = {
    tree: string;
    year?: number;
};

const COFECHA_PROBLEM_REFERENCE_RE = /^(.*?[>＞]{2}\s+)(\S+)(\s+)(-?\d{4})(.*)$/;
const COFECHA_PART6_SERIES_HEADER_RE = /^(\s*)(\S+)(\s+)(-?\d{4})(\s+to\s+)(-?\d{4})(.*\bSeries\b.*)$/i;
const COFECHA_ABSENT_RING_SUMMARY_RE = /^(\s*)(\S+)(\s+\d+\s+absent\s+rings?:\s*)(.*)$/i;
const COFECHA_ABSENT_RING_CONTINUATION_RE = /^(\s{8,})(-?\d{4}(?:\s+-?\d{4})*)(\s*)$/;
const COFECHA_YEAR_TOKEN_RE = /\b(-?\d{4})\b/g;
const COFECHA_PART_SEPARATOR_RE = /^\s*=+\s*$/;

const getErrorMessage = (error: unknown) => (
    error instanceof Error ? error.message : String(error)
);

const isPanelRatioCollapsed = (ratio: number) => (
    ratio <= 1 - COLLAPSED_PANEL_RATIO || ratio >= COLLAPSED_PANEL_RATIO
);

const resolveCofechaTreeCode = (tree: string, siteData: ReadonlyMap<string, unknown>) => {
    if (siteData.has(tree)) {
        return tree;
    }

    const normalizedTree = tree.toLowerCase();
    return Array.from(siteData.keys()).find((siteTree) => siteTree.toLowerCase() === normalizedTree) ?? tree;
};

const escapeHtml = (value: string) => (
    value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
);

const isTreeBoundary = (value: string | undefined) => (
    value === undefined || !/[A-Za-z0-9_]/.test(value)
);

const makeCofechaCellLinkHtml = (tree: string, rawYear: string, label = rawYear) => (
    `<span class="${style["cofecha-year-link"]}" data-cofecha-link="true" data-tree="${escapeHtml(tree)}" data-year="${escapeHtml(rawYear)}" role="button" tabindex="0" title="跳转到 ${escapeHtml(tree)} ${escapeHtml(rawYear)}" style="color:#0f5f9e;background-color:rgba(47,95,147,0.08);font-weight:700;text-decoration:underline;text-underline-offset:2px;cursor:pointer;border-radius:3px;padding:0 2px;">${escapeHtml(label)}</span>`
);

const makeCofechaSeriesLinkHtml = (tree: string) => (
    `<span class="${style["cofecha-year-link"]}" data-cofecha-link="true" data-tree="${escapeHtml(tree)}" role="button" tabindex="0" title="跳转到 ${escapeHtml(tree)}" style="color:#0f5f9e;background-color:rgba(47,95,147,0.08);font-weight:700;text-decoration:underline;text-underline-offset:2px;cursor:pointer;border-radius:3px;padding:0 2px;">${escapeHtml(tree)}</span>`
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

        return {
            html: [
                linkCofechaTreesInText(prefix, knownTrees).html,
                makeCofechaSeriesLinkHtml(tree),
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
        const [, prefix, tree, label, yearsText] = absentRingMatch;
        const linkedYears = linkCofechaYearsInText(yearsText, tree, knownTrees);

        return {
            html: [
                linkCofechaTreesInText(prefix, knownTrees).html,
                makeCofechaSeriesLinkHtml(tree),
                linkCofechaTreesInText(label, knownTrees).html,
                linkedYears.html,
                linkCofechaTreesInText(lineBreak, knownTrees).html,
            ].join(""),
            count: linkedYears.count + 1,
            currentSeriesTree,
            absentRingTree: tree,
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

const renderCofechaHtmlWithLinks = (text: string | undefined, trees: readonly string[]) => {
    const lines = (text ?? "").split(/\r\n|\n|\r/);
    const knownTrees = [...trees].sort((a, b) => b.length - a.length);
    let currentSeriesTree: string | null = null;
    let absentRingTree: string | null = null;
    let count = 0;

    const html = lines.map((line, index) => {
        const lineBreak = index < lines.length - 1 ? "\n" : "";
        const result = renderCofechaLineWithLinks(line, lineBreak, knownTrees, currentSeriesTree, absentRingTree);

        currentSeriesTree = result.currentSeriesTree;
        absentRingTree = result.absentRingTree;
        count += result.count;
        return result.html;
    }).join("");

    return { html, count };
};

export default function Home() {
    const homeContainerRef = useRef<HTMLDivElement>(null);
    const dataContainerRef = useRef<HTMLDivElement>(null);
    const rawEditorRef = useRef<HTMLParagraphElement>(null);
    const leftPanelsRef = useRef<HTMLDivElement>(null);
    const rightPanelsRef = useRef<HTMLDivElement>(null);
    const deleteSeriesRequestIdRef = useRef(0);
    const cofechaCellJumpIdRef = useRef(0);
    const { layout, draggingKey, startResize } = useResizablePanels();
    const [activeMenu, setActiveMenu] = useState<TitleMenuKind | null>(null);
    const [deleteSeriesRequest, setDeleteSeriesRequest] = useState<DeleteSeriesRequest | null>(null);
    const [cofechaCellJumpTarget, setCofechaCellJumpTarget] = useState<CofechaCellJumpTarget | null>(null);
    const [isRawEditing, setIsRawEditing] = useState(false);
    const [rawEditorInitialText, setRawEditorInitialText] = useState("");
    const [rawEditorRevision, setRawEditorRevision] = useState(0);
    const [rawEditorError, setRawEditorError] = useState("");
    const {
        applyRawRwlText,
        cofechaResult,
        cofechaVersion,
        deletionMarkers,
        getCurrentRwlText,
        handleDeleteSeries,
        handleDeleteYearWithMode,
        handleDeleteYearWithModeFromChart,
        handleInsertMissingYearAtSide,
        handleInsertMissingYearAtSideFromChart,
        handleLoad: handleWorkspaceLoad,
        handleMarkYearRangeAsMissing,
        handleMoveSeriesTailByOffset,
        handleRedo,
        handleReplaceTreeData,
        handleRestoreDeletion,
        handleSave: handleStructuredSave,
        handleSaveAs: handleStructuredSaveAs,
        handleSaveRawText,
        handleSaveRawTextAs,
        handleTreeSelectionChange,
        handleUndo,
        hasChart,
        hasProblems,
        historyAnimation,
        possibleProblemsDetail,
        problemTextColor,
        processingText,
        reportText,
        selectedPart,
        selectedProblemText,
        selectedTree,
        setCofechaVersion,
        setSelectedPart,
        shouldShowProcessing,
        shouldShowWelcome,
        siteData,
        treeOptions,
        windowTitle,
    } = useHomeWorkspace();

    const mainDividerCollapsed = isPanelRatioCollapsed(layout.mainSplitRatio);
    const leftBottomDividerCollapsed = layout.leftBottomRatio >= COLLAPSED_PANEL_RATIO;
    const rightBottomDividerCollapsed = isPanelRatioCollapsed(layout.rightBottomRatio);
    const mainDividerClassName = `${style["panel-divider"]} ${style["panel-divider-vertical"]} ${draggingKey === "mainSplitRatio" ? style["panel-divider-active"] : ""} ${mainDividerCollapsed ? style["panel-divider-collapsed"] : ""}`;
    const nestedDividerClassName = `${style["panel-divider"]} ${style["panel-divider-horizontal"]}`;
    const widthModuleStyle: CSSProperties = {
        flex: `0 0 ${layout.mainSplitRatio * 100}%`,
        ...(!mainDividerCollapsed ? { maxWidth: `calc(100% - ${PANEL_DIVIDER_GUTTER_SIZE}px)` } : {}),
    };
    const dataContainerStyle = hasProblems
        ? {
            flex: `0 0 ${layout.leftBottomRatio * 100}%`,
            ...(!leftBottomDividerCollapsed ? { maxHeight: `calc(100% - ${PANEL_DIVIDER_GUTTER_SIZE}px)` } : {}),
        }
        : undefined;
    const cofechaTextStyle = hasChart
        ? {
            flex: `0 0 ${layout.rightBottomRatio * 100}%`,
            ...(!rightBottomDividerCollapsed ? { maxHeight: `calc(100% - ${PANEL_DIVIDER_GUTTER_SIZE}px)` } : {}),
        }
        : undefined;

    const handleDeleteSeriesFromChart = useCallback((tree: string) => {
        deleteSeriesRequestIdRef.current += 1;
        setDeleteSeriesRequest({ id: deleteSeriesRequestIdRef.current, tree });
    }, []);

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

    const linkedReport = useMemo(() => (
        renderCofechaHtmlWithLinks(reportText, treeOptions)
    ), [reportText, treeOptions]);

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

    const getRawEditorText = useCallback(() => (
        rawEditorRef.current?.innerText ?? rawEditorInitialText
    ), [rawEditorInitialText]);

    const handleOpenRawEditor = useCallback(() => {
        setRawEditorInitialText(getCurrentRwlText());
        setRawEditorError("");
        setIsRawEditing(true);
        setRawEditorRevision((revision) => revision + 1);
    }, [getCurrentRwlText]);

    const handleCancelRawEditor = useCallback(() => {
        setIsRawEditing(false);
        setRawEditorError("");
    }, []);

    const applyRawEditor = useCallback(async (refocusOnError = false) => {
        try {
            await applyRawRwlText(getRawEditorText());
            setIsRawEditing(false);
            setRawEditorError("");
        } catch (error) {
            setRawEditorError(getErrorMessage(error));
            if (refocusOnError) {
                window.requestAnimationFrame(() => {
                    rawEditorRef.current?.focus();
                });
            }
        }
    }, [applyRawRwlText, getRawEditorText]);

    const handleApplyRawEditor = useCallback(async () => {
        await applyRawEditor();
    }, [applyRawEditor]);

    const handleLoad = useCallback(async () => {
        setIsRawEditing(false);
        setRawEditorError("");
        await handleWorkspaceLoad();
    }, [handleWorkspaceLoad]);

    const handleSave = useCallback(async () => {
        if (!isRawEditing) {
            await handleStructuredSave();
            return;
        }

        try {
            await handleSaveRawText(getRawEditorText());
            setRawEditorError("");
        } catch (error) {
            setRawEditorError(getErrorMessage(error));
        }
    }, [getRawEditorText, handleSaveRawText, handleStructuredSave, isRawEditing]);

    const handleSaveAs = useCallback(async () => {
        if (!isRawEditing) {
            await handleStructuredSaveAs();
            return;
        }

        try {
            await handleSaveRawTextAs(getRawEditorText());
            setRawEditorError("");
        } catch (error) {
            setRawEditorError(getErrorMessage(error));
        }
    }, [getRawEditorText, handleSaveRawTextAs, handleStructuredSaveAs, isRawEditing]);

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

    const handleRawEditorBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
            return;
        }

        void applyRawEditor(true);
    }, [applyRawEditor]);


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
                onCofechaVersionChange={setCofechaVersion}
                onActiveMenuChange={setActiveMenu}
                onOpenSettings={openSettingsWindow}
            />

            <div className={style["home-container"]} ref={homeContainerRef}>
                <div
                    className={style["width-module"]}
                    style={widthModuleStyle}
                >
                    {isRawEditing ? (
                        <div className={style["raw-width-container"]} onBlur={handleRawEditorBlur}>
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

                            {rawEditorError ? (
                                <div className={style["raw-editor-error"]}>
                                    {rawEditorError}
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <div className={style["structured-width-container"]}>
                            {!shouldShowWelcome ? (
                                <>
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
                                                {possibleProblemsDetail.has(tree) ? TREE_WARNING_MARK : TREE_NORMAL_MARK}{tree}
                                            </option>
                                        ))}
                                    </select>
                                    <div className={style["width-legend"]} aria-hidden="true">
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
                                    </div>
                                </>
                            ) : null}

                            <div className={style["width-panels"]} ref={leftPanelsRef}>
                                <div
                                    className={`${style["data-viewport"]} ${activeMenu ? style["z-index-1"] : ""}`}
                                    style={dataContainerStyle}
                                >
                                    <div
                                        className={style["data-container"]}
                                        ref={dataContainerRef}
                                        aria-busy={shouldShowProcessing}
                                    >
                                        {shouldShowWelcome ? (
                                            <div className={style["loading-container"]}>
                                                <img src="IDM.png" className={style["loading-image"]} alt="IDM loading" />
                                                <p className={style["developers"]}>{WELCOME_TEXT}</p>
                                            </div>
                                        ) : (
                                            <WidthContainer
                                                siteData={siteData}
                                                selected={selectedTree}
                                                masterSeries={cofechaResult?.masterDatingSeries}
                                                historyAnimation={historyAnimation}
                                                jumpTarget={cofechaCellJumpTarget}
                                                deleteSeriesRequest={deleteSeriesRequest}
                                                deletionMarkers={deletionMarkers}
                                                scrollContainerRef={dataContainerRef}
                                                onInsertMissingYearAtSide={handleInsertMissingYearAtSide}
                                                onMoveSeriesTailByOffset={handleMoveSeriesTailByOffset}
                                                onDeleteYearWithMode={handleDeleteYearWithMode}
                                                onMarkYearRangeAsMissing={handleMarkYearRangeAsMissing}
                                                onRestoreDeletion={handleRestoreDeletion}
                                                onDeleteSeries={handleDeleteSeries}
                                                onEditAsText={handleOpenRawEditor}
                                                onDeleteSeriesRequestHandled={handleDeleteSeriesRequestHandled}
                                                onReplaceTreeData={handleReplaceTreeData}
                                            />
                                        )}

                                        {shouldShowProcessing ? (
                                            <div className={style["processing-mask"]}>
                                                <span>{processingText}</span>
                                            </div>
                                        ) : null}
                                    </div>
                                    <FloatingScrollbar
                                        targetRef={dataContainerRef}
                                        topClearanceSelector="[data-grid-header]"
                                        revision={`${shouldShowWelcome}:${selectedTree ?? ""}`}
                                    />
                                </div>

                                {hasProblems ? (
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

                                        <OverlayScroll className={style["problems-container"]}>
                                            <p className={style["potential-problems"]}>
                                                {selectedProblemText}
                                            </p>
                                        </OverlayScroll>
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
                    <div className={style["statics-info"]}>
                        <span className={style["stat-item"]} style={{ color: problemTextColor }}>
                            <span className={style["stat-label"]}>*A*</span>
                            <span className={style["stat-value"]}>
                                <RollingNumber value={cofechaResult?.possibleProblemsCount} />
                            </span>
                        </span>
                        <span className={style["stat-item"]}>
                            <span className={style["stat-label"]}>Master series</span>
                            <span className={style["stat-value"]}>
                                <RollingNumber value={cofechaResult?.masterSeriesYear} />
                            </span>
                        </span>
                        <span className={style["stat-item"]}>
                            <span className={style["stat-label"]}>Intercorrelation</span>
                            <span className={style["stat-value"]}>
                                <RollingNumber value={cofechaResult?.seriesIntercorrelation} />
                            </span>
                        </span>
                        <span className={style["stat-item"]}>
                            <span className={style["stat-label"]}>Mean sensitivity</span>
                            <span className={style["stat-value"]}>
                                <RollingNumber value={cofechaResult?.averageMeanSensitivity} />
                            </span>
                        </span>
                        <span className={style["stat-item"]}>
                            <span className={style["stat-label"]}>Mean length</span>
                            <span className={style["stat-value"]}>
                                <RollingNumber value={cofechaResult?.meanLength} />
                            </span>
                        </span>
                    </div>

                    <div className={style["cofecha-panels"]} ref={rightPanelsRef}>
                        <OverlayScroll
                            className={style["full-text"]}
                            style={cofechaTextStyle}
                        >
                            <div className={style["cofecha-panel-content"]}>
                                {!shouldShowWelcome ? (
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
                                        {linkedReport.count > 0 ? (
                                            <span className={style["cofecha-link-count"]}>
                                                跳转链接 {linkedReport.count}
                                            </span>
                                        ) : null}
                                    </div>
                                ) : null
                                }

                                <p
                                    id={style["cofecha-text"]}
                                    onClick={handleCofechaTextClick}
                                    onKeyDown={handleCofechaTextKeyDown}
                                    dangerouslySetInnerHTML={{ __html: linkedReport.html }}
                                />
                            </div>
                        </OverlayScroll>

                        {hasChart ? (
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

                                <div className={style["line-chart"]}>
                                    <div className={`${style["cofecha-panel-content"]} ${style["line-chart-content"]}`}>
                                        <TreeChartManager
                                            fullData={siteData}
                                            onInsertMissingYearAtSide={handleInsertMissingYearAtSideFromChart}
                                            onDeleteYearWithMode={handleDeleteYearWithModeFromChart}
                                            onDeleteSeries={handleDeleteSeriesFromChart}
                                        />
                                    </div>
                                </div>
                            </>
                        ) : null}
                    </div>
                </div>
            </div>
        </>
    );
}
