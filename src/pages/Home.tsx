import { useRef, useState } from "react";
import { TreeChartManager } from "@/components/Chart/TreeChartManager";
import WidthContainer from "@/components/WidthContainer/WidthContainer";
import style from "./Home.module.css";
import { ALL_OPTION_VALUE, TitleMenuKind } from "./home/constants";
import { HomeTitleBarBridge } from "./home/HomeTitleBarBridge";
import { useHomeWorkspace } from "./home/useHomeWorkspace";
import { useResizablePanels } from "./useResizablePanels";

const TREE_ALL_OPTION_LABEL = "📜 全部";
const TREE_WARNING_MARK = "⚠️";
const TREE_NORMAL_MARK = "🪵";
const YEAR_PLACEHOLDER = "\u8f93\u5165\u6216\u70b9\u51fb\u9700\u8981\u64cd\u4f5c\u7684\u5e74\u4efd";
const INSERT_LABEL = "\u63d2\u5165";
const DELETE_LABEL = "\u5220\u9664";
const WELCOME_TEXT = "开发者：何志浩、张同文、张瑞波、靳春寒、喻树龙、尚华明、秦莉";

const COFECHA_PART_OPTIONS = [
    { value: ALL_OPTION_VALUE, label: "📜 全部内容" },
    { value: "PART 1", label: "📌 PART 1: Summary" },
    { value: "PART 2", label: "📈 PART 2: Time Plot of Series" },
    { value: "PART 3", label: "📉 PART 3: Master Dating Series" },
    { value: "PART 4", label: "📊 PART 4: Master Bar Plot" },
    { value: "PART 5", label: "📰 PART 5: Correlation of Series by Segment" },
    { value: "PART 6", label: "⚠️ PART 6: Potential Problems" },
    { value: "PART 7", label: "🪧 PART 7: Descriptive Statistics" },
];

export default function Home() {
    const homeContainerRef = useRef<HTMLDivElement>(null);
    const dataContainerRef = useRef<HTMLDivElement>(null);
    const leftPanelsRef = useRef<HTMLDivElement>(null);
    const rightPanelsRef = useRef<HTMLDivElement>(null);
    const { layout, draggingKey, startResize } = useResizablePanels();
    const [activeMenu, setActiveMenu] = useState<TitleMenuKind | null>(null);
    const {
        cofechaResult,
        cofechaVersion,
        handleDelete,
        handleGridClick,
        handleInsert,
        handleLoad,
        handleRedo,
        handleSave,
        handleSaveAs,
        handleTreeSelectionChange,
        handleUndo,
        handleYearChange,
        hasChart,
        hasProblems,
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
        year,
    } = useHomeWorkspace();

    const mainDividerClassName = `${style["panel-divider"]} ${style["panel-divider-vertical"]} ${draggingKey === "mainSplitRatio" ? style["panel-divider-active"] : ""}`;
    const nestedDividerClassName = `${style["panel-divider"]} ${style["panel-divider-horizontal"]}`;

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
            />

            <div className={style["home-container"]} ref={homeContainerRef}>
                <div
                    className={style["width-module"]}
                    style={{ flex: `0 0 ${layout.mainSplitRatio * 100}%` }}
                >
                    <div className={style["control-bar"]}>
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
                                    -{possibleProblemsDetail.has(tree) ? TREE_WARNING_MARK : TREE_NORMAL_MARK}{tree}
                                </option>
                            ))}
                        </select>

                        <input
                            type="text"
                            id={style["year_to_edit"]}
                            onChange={(event) => {
                                handleYearChange(event.target.value);
                            }}
                            value={year}
                            placeholder={YEAR_PLACEHOLDER}
                        />

                        <button onClick={handleInsert}>{INSERT_LABEL}</button>
                        <button onClick={handleDelete}>{DELETE_LABEL}</button>
                    </div>

                    <div className={style["width-panels"]} ref={leftPanelsRef}>
                        <div
                            className={`${style["data-container"]} ${activeMenu ? style["z-index-1"] : ""}`}
                            style={hasProblems ? { flex: `0 0 ${layout.leftBottomRatio * 100}%` } : undefined}
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
                                    scrollContainerRef={dataContainerRef}
                                    onYearClick={handleGridClick}
                                />
                            )}

                            {shouldShowProcessing ? (
                                <div className={style["processing-mask"]}>
                                    <span>{processingText}</span>
                                </div>
                            ) : null}
                        </div>

                        {hasProblems ? (
                            <>
                                <div
                                    role="separator"
                                    aria-orientation="horizontal"
                                    aria-label="调整数据区和问题区高度"
                                    className={`${nestedDividerClassName} ${draggingKey === "leftBottomRatio" ? style["panel-divider-active"] : ""}`}
                                    onPointerDown={startResize({
                                        key: "leftBottomRatio",
                                        axis: "y",
                                        container: () => leftPanelsRef.current,
                                        minStart: 220,
                                        minEnd: 96,
                                    })}
                                />

                                <div className={style["problems-container"]}>
                                    <p className={style["potential-problems"]}>
                                        {selectedProblemText}
                                    </p>
                                </div>
                            </>
                        ) : null}
                    </div>
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
                            <span className={style["stat-value"]}>{cofechaResult?.possibleProblemsCount}</span>
                        </span>
                        <span className={style["stat-item"]}>
                            <span className={style["stat-label"]}>Master series</span>
                            <span className={style["stat-value"]}>{cofechaResult?.masterSeriesYear}</span>
                        </span>
                        <span className={style["stat-item"]}>
                            <span className={style["stat-label"]}>Intercorrelation</span>
                            <span className={style["stat-value"]}>{cofechaResult?.seriesIntercorrelation}</span>
                        </span>
                        <span className={style["stat-item"]}>
                            <span className={style["stat-label"]}>Mean sensitivity</span>
                            <span className={style["stat-value"]}>{cofechaResult?.averageMeanSensitivity}</span>
                        </span>
                        <span className={style["stat-item"]}>
                            <span className={style["stat-label"]}>Mean length</span>
                            <span className={style["stat-value"]}>{cofechaResult?.meanLength}</span>
                        </span>
                    </div>

                    <div className={style["cofecha-panels"]} ref={rightPanelsRef}>
                        <div
                            className={style["full-text"]}
                            style={hasChart ? { flex: `0 0 ${layout.rightBottomRatio * 100}%` } : undefined}
                        >
                            <div className={style["cofecha-panel-content"]}>
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

                                <p id={style["cofecha-text"]}>{reportText}</p>
                            </div>
                        </div>

                        {hasChart ? (
                            <>
                                <div
                                    role="separator"
                                    aria-orientation="horizontal"
                                    aria-label="调整 COFECHA 文本和折线图高度"
                                    className={`${nestedDividerClassName} ${draggingKey === "rightBottomRatio" ? style["panel-divider-active"] : ""}`}
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
                                        <TreeChartManager fullData={siteData} />
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
