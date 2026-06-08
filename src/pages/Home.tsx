import { useCallback, useEffect, useRef, useState, type CSSProperties, type ClipboardEvent, type FocusEvent, type KeyboardEvent } from "react";
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

const getErrorMessage = (error: unknown) => (
    error instanceof Error ? error.message : String(error)
);

const isPanelRatioCollapsed = (ratio: number) => (
    ratio <= 1 - COLLAPSED_PANEL_RATIO || ratio >= COLLAPSED_PANEL_RATIO
);

export default function Home() {
    const homeContainerRef = useRef<HTMLDivElement>(null);
    const dataContainerRef = useRef<HTMLDivElement>(null);
    const rawEditorRef = useRef<HTMLParagraphElement>(null);
    const leftPanelsRef = useRef<HTMLDivElement>(null);
    const rightPanelsRef = useRef<HTMLDivElement>(null);
    const deleteSeriesRequestIdRef = useRef(0);
    const { layout, draggingKey, startResize } = useResizablePanels();
    const [activeMenu, setActiveMenu] = useState<TitleMenuKind | null>(null);
    const [deleteSeriesRequest, setDeleteSeriesRequest] = useState<DeleteSeriesRequest | null>(null);
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
                                ) : null
                                }

                                <p id={style["cofecha-text"]}>{reportText}</p>
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
