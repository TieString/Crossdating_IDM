// Home 页面是整个应用的工作流编排入口。
// 这里负责把“打开文件 -> 解析 RWL -> 编辑 -> 保存 -> 运行 COFECHA -> 解析结果”串成一条完整链路。
// 页面本身不负责具体格式解析或 COFECHA 细节，只负责状态管理、事件绑定和 UI 刷新。

// 功能路线图：
// 已完成：保存后自动运行 COFECHA、读取 COFECHA 输出、悬浮提示年份、撤销重做、曲线图、双击修改年份。
// 待完善：更细的 COFECHA 结果高亮、年轮宽度示意图等视觉增强。

import style from "./Home.module.css";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readTextFile } from "@tauri-apps/plugin-fs";
import { RwlEditor, registerChangeYearWidth } from "@/features/rwl/edit";
import type { RwlSiteData } from "@/features/rwl/types";
import Menu from "@/components/Menu/Menu.tsx";
import { createRoot, Root } from "react-dom/client";
import WidthContainer from "@/components/WidthContainer/WidthContainer.tsx";
import { parseCofechaResult, splitReportByParts } from "@/features/cofecha/formatter.ts";
import { ICofechaResult } from "@/features/cofecha/types.ts";
import { TreeChartManager } from "@/components/Chart/TreeChartManager.tsx";
import { runCofecha } from "@/services/cofecha/runner.ts";
import { readRwlFile, saveFile } from "@/services/fs/io";
import { useResizablePanels } from "./useResizablePanels";


// Extend HTMLElement type
declare global {
    interface HTMLElement {
        __root?: ReturnType<typeof createRoot>;
    }
}

// 在组件外部定义一个 `title` 处理工具函数
const formatTitle = (fileName: string | null, isModified: boolean) => {
    return fileName ? `${fileName}${isModified ? " *" : ""}` : "交叉定年-IDM";
};


export default function Home() {

    // 主要数据状态：RWL 编辑器、原始快照、文件路径和 COFECHA 结果。
    const rwlEditorRef = useRef<RwlEditor>(new RwlEditor(new Map()));// 存储 rwl_data 的 ref 结构化的宽度数据
    const [siteDataSnapshot, setSiteDataSnapshot] = useState<RwlSiteData>(() => rwlEditorRef.current.getData());
    // 保存加载/最后一次保存时的基准数据，用于和当前编辑器内容比较
    const originalDataRef = useRef<RwlSiteData>(new Map());

    // 文件与树种选择状态。
    const [treeOptions, setTreeOptions] = useState<string[]>([])  // 存储树种选项
    const [selectedTree, setSelectedTree] = useState<string>("全部");  // 存储选中的树种编号

    // 每当 treeOptions 变化时，若当前选中项不在新列表中则重置为全部
    useEffect(() => {
        if (selectedTree !== "全部" && !treeOptions.includes(selectedTree)) {
            setSelectedTree("全部");
        }
    }, [treeOptions]);
    const [year, setYear] = useState<string>("")
    const filePathRef = useRef<string | null>(null);
    const [fileName, setFileName] = useState<string | null>(null); // 存储文件名
    const [isModified, setIsModified] = useState(false); // 记录文件是否被修改

    // COFECHA 输出与结果面板状态。
    const outFileContent = useRef<string>("")
    const [potentialProblemsDetail, setPotentialProblemsDetail] = useState<Map<string, string>>(new Map)
    const [cofechaResult, setCofechaResult] = useState<ICofechaResult>()
    const [selectedPart, setSelectedPart] = useState("全部"); // 选中的部分
    const [cofechaVersion, setCofechaVersion] = useState<"cofecha" | "cofecha12k">("cofecha"); // COFECHA 版本选择
    const cofechaParts = useRef<Map<string, string>>(new Map);
    const [isFileLoading, setIsFileLoading] = useState(false);
    const [isCofechaRunning, setIsCofechaRunning] = useState(false);

    // 通过一个无意义的状态值强制刷新，避免直接依赖深层 Map 变化。
    const [_, setRender] = useState(0); // 只是用来触发重新渲染
    const emitRender = () => {
        setRender(prev => prev + 1); // 触发重新渲染
    };
    const homeContainerRef = useRef<HTMLDivElement>(null);
    const dataContainerRef = useRef<HTMLDivElement>(null);
    const leftPanelsRef = useRef<HTMLDivElement>(null);
    const rightPanelsRef = useRef<HTMLDivElement>(null);
    const { layout, draggingKey, startResize } = useResizablePanels();


    // 比较两个 RWL 数据是否相等
    const rwlDataEquals = (a: RwlSiteData, b: RwlSiteData) => {
        if (a.size !== b.size) return false;
        for (let [tree, mapA] of a) {
            const mapB = b.get(tree);
            if (!mapB) return false;
            if (mapA.size !== mapB.size) return false;
            for (let [year, widthA] of mapA) {
                const widthB = mapB.get(year);
                if (widthA !== widthB) return false;
            }
        }
        return true;
    };

    // 辅助：当编辑器内部数据变化时自动更新 isModified 并触发渲染
    const setupEditor = (editor: RwlEditor) => {
        editor.registerChangeCallback(() => {
            const nextData = editor.getData();
            const changed = !rwlDataEquals(originalDataRef.current, nextData);
            setIsModified(changed);
            setSiteDataSnapshot(nextData);
            emitRender();
        });
    };

    // 初始引用的编辑器也需要注册回调
    useEffect(() => {
        setupEditor(rwlEditorRef.current);
    }, []);

    useEffect(() => {
        const titleMenuUndoButton = document.getElementById("title-submenu-undo-button");
        const titleMenuRedoButton = document.getElementById("title-submenu-redo-button");
        // 添加点击事件监听器
        const handleUndoClick = (e: Event) => {
            e.stopPropagation();
            HandleUndo();
        };
        const handleRedoClick = (e: Event) => {
            e.stopPropagation();
            HandleRedo();
        };
        // 绑定事件
        titleMenuUndoButton?.addEventListener("click", handleUndoClick);
        titleMenuRedoButton?.addEventListener("click", handleRedoClick);
        document.body.addEventListener("keydown", handleKeyDown);
        // 组件卸载时移除监听，避免重复绑定
        return () => {
            titleMenuUndoButton?.removeEventListener("click", handleUndoClick);
            titleMenuRedoButton?.removeEventListener("click", handleRedoClick);
            document.body.removeEventListener("keydown", handleKeyDown);
        };
    }, []);

    const handleKeyDown = (event: KeyboardEvent) => {
        if (event.ctrlKey && event.key === "s") {
            event.preventDefault();
            HandleSave();
        } else if (event.ctrlKey && event.key === "z") {
            event.preventDefault();
            HandleUndo();
        } else if (event.ctrlKey && event.key === "y") {
            event.preventDefault();
            HandleRedo();
        }
    };

    // 更新窗口标题
    useEffect(() => {
        const title = formatTitle(fileName, isModified);
        getCurrentWindow().setTitle(title); // 更新 Tauri 窗口标题
        const menuTitle = document.getElementById("menu-title");
        if (menuTitle) menuTitle.textContent = title
    }, [fileName, isModified]);

    // 在 Home 中注册rwlEditorRef的方法，供外部调用以更新年轮宽度数据
    useEffect(() => {
        registerChangeYearWidth((tree, year, width) => {
            rwlEditorRef.current?.changeYearWidth(tree, year, width);
        });
    }, [/* 无需依赖 */]);

    const runCofechaAndApplyResult = async (input: string, sourcePath: string) => {
        setIsCofechaRunning(true);
        try {
            const baseName = sourcePath.split(/\\|\//).pop() || "INPUT.RWL";
            const outText = await runCofecha(input, baseName, sourcePath, cofechaVersion);
            outFileContent.current = outText;
            const result = parseCofechaResult(outText);
            setCofechaResult(result);
            setPotentialProblemsDetail(result.possibleProblemsDetail);
            cofechaParts.current = splitReportByParts(outText);
        } finally {
            setIsCofechaRunning(false);
        }
    };



    // 打开并读取 RWL 文件，同时触发解析、初始化编辑器和 COFECHA 运行。
    const HandleLoad = async () => {
        try {
            // 打开文件选择对话框，让用户选择要读取的文件
            const filePath = await open({
                filters: [
                    { name: "Tucson Files", extensions: ["rwl"] }, // 仅限 .rwl 文件
                    { name: "所有文件", extensions: ["*"] }   // 允许所有文件
                ],
                // title: "打开文件",
                multiple: false, // 仅允许选择一个文件
            });

            // 如果用户取消了文件选择
            if (!filePath) {
                console.log("用户取消了文件选择");
                return;
            }

            setIsFileLoading(true);
            filePathRef.current = filePath; // 更新文件路径
            const menuTitle = document.getElementById("menu-title")
            if (menuTitle) {
                menuTitle.textContent = filePath;
            }

            // 修改窗口标题
            await getCurrentWindow().setTitle(filePath);

            // 读取文件内容
            const content = await readTextFile(filePath);
            // 提取并存储数据 编号：(year:width)
            const rwlData = await readRwlFile(filePath);
            if (rwlData.data) {
                console.log(rwlData.data);

                // 创建编辑器，传递格式信息
                rwlEditorRef.current = new RwlEditor(rwlData.data, rwlData.readOptions, rwlData.format);
                setupEditor(rwlEditorRef.current);
                const nextData = rwlEditorRef.current.getData();
                originalDataRef.current = nextData;
                setSiteDataSnapshot(nextData);
                const options = Array.from(rwlData.data.keys());  // 获取所有键名
                setTreeOptions(options);  // 更新树种选项
                // 确保控件和状态都回到“全部”
                setSelectedTree("全部");
            }
            setFileName(filePath); // 更新文件名
            setIsModified(false);
            // 等待 cofecha 完成并获取输出文本，传入原始文件名以便 OUT 中显示该名称
            try {
                await runCofechaAndApplyResult(content, filePath as string);
            } catch (err) {
                console.error('cofecha 执行失败', err);
            }
            emitRender();
        } catch (error) {
            console.error("读取文件时出错:", error);
        } finally {
            setIsFileLoading(false);
        }
    }

    // 将当前编辑器状态格式化回 RWL，并保存到原文件。
    const HandleSave = async () => {
        if (!filePathRef.current) {
            console.log("请先打开一个文件");
            return;
        }

        try {
            const rwlStr = rwlEditorRef.current.exportAsRwlString();
            await saveFile(filePathRef.current, rwlStr);
            console.log("文件已成功保存到:", filePathRef.current);
            // 更新基准数据并清除修改标志
            const nextData = rwlEditorRef.current.getData();
            originalDataRef.current = nextData;
            setSiteDataSnapshot(nextData);
            setIsModified(false);

            try {
                await runCofechaAndApplyResult(rwlStr, filePathRef.current as string);
            } catch (err) {
                console.error('cofecha 执行失败', err);
            }
        } catch (error) {
            console.error("写入文件时出错:", error);
        }
    }

    // 另存为：当前实现保留入口，但仍依赖已有文件路径。
    const HandleSaveAs = async () => {
        try {
            // 如果没有文件路径，提示用户保存文件
            if (!filePathRef.current) {
                console.log("请先打开一个文件");
                return;
            }

            // 让用户选择保存路径
            const filePathToSave = await save({
                filters: [{ name: "Tucson Files", extensions: ["rwl"] }], // 只允许 .rwl 文件
            });

            // 用户取消了保存
            if (!filePathToSave) {
                console.log("用户取消了保存操作");
                return;
            }
            const rwlStr = rwlEditorRef.current.exportAsRwlString();
            await saveFile(filePathToSave, rwlStr);
            console.log("文件已成功保存到:", filePathToSave);
            const nextData = rwlEditorRef.current.getData();
            originalDataRef.current = nextData;
            setSiteDataSnapshot(nextData);
            setIsModified(false); // 文件保存后标记为未修改
        } catch (error) {
            console.error("写入文件时出错:", error);
        }
    }

    const HandleInsert = () => {
        const yearToInsert = parseInt(year ?? '');  // 转换为数字
        if (isNaN(yearToInsert)) {
            alert('无效的数值');
            return;
        }
        if (selectedTree === "全部") {
            alert("请选择一个编号")
            return;
        }
        rwlEditorRef.current.insertYear(selectedTree, yearToInsert);
        // 编辑器自身回调会处理修改标记和渲染
    }

    const HandleDelete = () => {
        const yearToDelete = parseInt(year ?? '');  // 转换为数字
        if (isNaN(yearToDelete)) {
            alert('无效的数值');
            return;
        }
        if (selectedTree === "全部") {
            alert("请选择一个编号")
            return;
        }
        rwlEditorRef.current.deleteYear(selectedTree, yearToDelete);
        // 编辑器自身回调会处理修改标记和渲染
    }

    const HandleUndo = () => {
        rwlEditorRef.current.undo();
        // 回调会设置 isModified 及 trigger render
    };

    const HandleRedo = () => {
        rwlEditorRef.current.redo();
        // 回调会设置 isModified 及 trigger render
    };

    const handleGridClick = useCallback((year: number) => {
        setYear(year.toString());
    }, []);

    // 包装菜单项回调，使执行后自动关闭顶级菜单
    const closeAnd = (fn: (() => any) | undefined) => {
        return async () => {
            try {
                if (fn) await fn();
            } finally {
                setActiveMenu(null);
            }
        };
    };

    const menuEditItems = [
        { label: '撤销', onClick: closeAnd(HandleUndo) },
        { label: '恢复', onClick: closeAnd(HandleRedo) },
        { label: '查找' },
        { label: '替换' },
    ];

    const menuRunItems = [
        {
            label: `${cofechaVersion === 'cofecha' ? '✓ ' : ''}COFECHA`,
            onClick: () => {
                setCofechaVersion('cofecha');
                setActiveMenu(null);
            }
        },
        {
            label: `${cofechaVersion === 'cofecha12k' ? '✓ ' : ''}COFECHA 12K`,
            onClick: () => {
                setCofechaVersion('cofecha12k');
                setActiveMenu(null);
            }
        },
    ];

    const menuFileItems = [
        { label: '打开文件', onClick: closeAnd(HandleLoad) },
        { label: '保存', onClick: closeAnd(HandleSave) },
        { label: '另存为', onClick: closeAnd(HandleSaveAs) },
    ];

    const [activeMenu, setActiveMenu] = useState<"file" | "edit" | "run" | null>(null);
    const activeMenuRef = useRef<"file" | "edit" | "run" | null>(null);
    // 同步 ref
    useEffect(() => {
        activeMenuRef.current = activeMenu;
    }, [activeMenu]);

    // 用 useRef 存储根节点，避免重复创建
    const fileMenuRoot = useRef<Root | null>(null);
    const editMenuRoot = useRef<Root | null>(null);
    const runMenuRoot = useRef<Root | null>(null);

    useEffect(() => {
        const menuContainerFile = document.getElementById("title-submenu-file-container");
        const menuContainerEdit = document.getElementById("title-submenu-edit-container");
        const menuContainerRun = document.getElementById("title-submenu-run-container");

        // **1️⃣ 只在第一次渲染时创建 React Root**
        if (!fileMenuRoot.current && menuContainerFile) {
            fileMenuRoot.current = createRoot(menuContainerFile);
            fileMenuRoot.current.render(<Menu items={menuFileItems} />);
        }
        if (!editMenuRoot.current && menuContainerEdit) {
            editMenuRoot.current = createRoot(menuContainerEdit);
            editMenuRoot.current.render(<Menu items={menuEditItems} />);
        }
        if (!runMenuRoot.current && menuContainerRun) {
            runMenuRoot.current = createRoot(menuContainerRun);
            runMenuRoot.current.render(<Menu items={menuRunItems} />);
        } else if (runMenuRoot.current && menuContainerRun) {
            // 当选中的引擎变化时，重新渲染菜单
            runMenuRoot.current.render(<Menu items={menuRunItems} />);
        }


        // **2️⃣ 监听点击事件（只绑定一次）**
        interface ClickTarget {
            target: EventTarget | null;
        }

        const handleClickOutside = (event: MouseEvent & ClickTarget) => {
            if (
                !menuContainerFile?.contains(event.target as Node) &&
                !menuContainerEdit?.contains(event.target as Node) &&
                !menuContainerRun?.contains(event.target as Node)
            ) {
                setActiveMenu(null);
            }
        };
        document.addEventListener("click", handleClickOutside);
        const titleMenuFileButton = document.getElementById("title-submenu-file-button");
        const titleMenuEditButton = document.getElementById("title-submenu-edit-button");
        const titleMenuRunButton = document.getElementById("title-submenu-run-button");
        // 添加点击事件监听器
        interface MenuClickEvent extends MouseEvent {
            target: EventTarget | null;
        }

        const handleFileButtonClick = (e: MenuClickEvent) => {
            e.stopPropagation();
            activeMenuRef.current === "file" ? setActiveMenu(null) : setActiveMenu("file");
        };

        const handleEditButtonClick = (e: MenuClickEvent) => {
            e.stopPropagation();
            activeMenuRef.current === "edit" ? setActiveMenu(null) : setActiveMenu("edit");
        };

        const handleRunButtonClick = (e: MenuClickEvent) => {
            e.stopPropagation();
            activeMenuRef.current === "run" ? setActiveMenu(null) : setActiveMenu("run");
        };

        titleMenuFileButton?.addEventListener("click", handleFileButtonClick);
        titleMenuEditButton?.addEventListener("click", handleEditButtonClick);
        titleMenuRunButton?.addEventListener("click", handleRunButtonClick);

        // 鼠标悬停时切换菜单（仅当已有活动菜单）
        const handleFileMouseEnter = () => {
            if (activeMenuRef.current && activeMenuRef.current !== "file") {
                setActiveMenu("file");
            }
        };
        const handleEditMouseEnter = () => {
            if (activeMenuRef.current && activeMenuRef.current !== "edit") {
                setActiveMenu("edit");
            }
        };
        const handleRunMouseEnter = () => {
            if (activeMenuRef.current && activeMenuRef.current !== "run") {
                setActiveMenu("run");
            }
        };
        titleMenuFileButton?.addEventListener("mouseenter", handleFileMouseEnter);
        titleMenuEditButton?.addEventListener("mouseenter", handleEditMouseEnter);
        titleMenuRunButton?.addEventListener("mouseenter", handleRunMouseEnter);


        return () => {
            document.removeEventListener("click", handleClickOutside);
            titleMenuFileButton?.removeEventListener("click", handleFileButtonClick);
            titleMenuEditButton?.removeEventListener("click", handleEditButtonClick);
            titleMenuRunButton?.removeEventListener("click", handleRunButtonClick);
            titleMenuFileButton?.removeEventListener("mouseenter", handleFileMouseEnter);
            titleMenuEditButton?.removeEventListener("mouseenter", handleEditMouseEnter);
            titleMenuRunButton?.removeEventListener("mouseenter", handleRunMouseEnter);
        };
    }, [cofechaVersion]); // ✅ 当 cofechaVersion 变化时重新渲染菜单

    // **3️⃣ 仅在 activeMenu 变化时更新 UI**
    useEffect(() => {
        // 使用 class 而非 inline style 来避免覆盖 CSS
        document.querySelectorAll(".title-menu-item").forEach(button => {
            button.classList.remove("title-menu-item-active");
        });

        const activeButton = document.getElementById(`title-submenu-${activeMenu}-button`);
        if (activeButton) activeButton.classList.add("title-menu-item-active");

        const menuContainerFile = document.getElementById("title-submenu-file-container");
        const menuContainerEdit = document.getElementById("title-submenu-edit-container");
        const menuContainerRun = document.getElementById("title-submenu-run-container");

        if (activeMenu === "file") {
            if (menuContainerFile) menuContainerFile.style.display = "block";
            if (menuContainerEdit) menuContainerEdit.style.display = "none";
            if (menuContainerRun) menuContainerRun.style.display = "none";
        } else if (activeMenu === "edit") {
            if (menuContainerEdit) menuContainerEdit.style.display = "block";
            if (menuContainerFile) menuContainerFile.style.display = "none";
            if (menuContainerRun) menuContainerRun.style.display = "none";
        } else if (activeMenu === "run") {
            if (menuContainerRun) menuContainerRun.style.display = "block";
            if (menuContainerFile) menuContainerFile.style.display = "none";
            if (menuContainerEdit) menuContainerEdit.style.display = "none";
        } else {
            if (menuContainerFile) menuContainerFile.style.display = "none";
            if (menuContainerEdit) menuContainerEdit.style.display = "none";
            if (menuContainerRun) menuContainerRun.style.display = "none";
        }
    }, [activeMenu]); // ✅ 仅当 `activeMenu` 变化时更新 UI

    const getTextColor = () => {
        const count = cofechaResult?.possibleProblemsCount;
        return count !== undefined && count >= 100 ? "red" : "black";
    };

    const siteData = siteDataSnapshot;
    const selectedProblemText = potentialProblemsDetail.get(selectedTree);
    const hasProblems = Boolean(selectedProblemText);
    const hasChart = siteData.size > 0;
    const shouldShowWelcome = !fileName && !isFileLoading;
    const shouldShowProcessing = isFileLoading || isCofechaRunning;
    const processingText = isFileLoading ? "正在读取并解析 RWL..." : "正在运行 COFECHA...";
    const mainDividerClassName = `${style["panel-divider"]} ${style["panel-divider-vertical"]} ${draggingKey === "mainSplitRatio" ? style["panel-divider-active"] : ""}`;
    const nestedDividerClassName = `${style["panel-divider"]} ${style["panel-divider-horizontal"]}`;


    return (
        <>
            <div className={style["home-container"]} ref={homeContainerRef}>
                <div
                    className={style["width-module"]}
                    style={{ flex: `0 0 ${layout.mainSplitRatio * 100}%` }}
                >
                    <div className={style["control-bar"]}>
                        <select name="trees" id={style["tree_selector"]} onChange={(e) => { setSelectedTree(e.target.value) }}>
                            <option key="全部" value="全部">📜 全部</option>
                            {treeOptions.map((tree) => (
                                <option key={tree} value={tree}>
                                    -{cofechaResult?.possibleProblemsDetail.has(tree) ? "⚠️" : "🪵"}{tree}
                                </option>
                            ))}
                        </select>
                        <input
                            type="text"
                            id={style["year_to_edit"]}
                            onChange={(e) => setYear(e.target.value)}
                            value={year} placeholder="输入或点击需要操作的年份"
                        />
                        <button onClick={HandleInsert}>插入</button>
                        <button onClick={HandleDelete}>删除</button>
                    </div>
                    <div className={style["width-panels"]} ref={leftPanelsRef}>
                        <div
                            className={`${style["data-container"]} ${activeMenu ? style["z-index-1"] : ""}`}
                            style={hasProblems ? { flex: `0 0 ${layout.leftBottomRatio * 100}%` } : undefined}
                            ref={dataContainerRef}
                            aria-busy={shouldShowProcessing}
                        >
                            {/* 加载界面：图片在上，开发者信息在下；成功加载文件后隐藏 */}
                            {shouldShowWelcome ?
                                (
                                    <div className={style["loading-container"]}>
                                        <img src="IDM.png" className={style["loading-image"]} alt="IDM loading" />
                                        <p className={style["developers"]}>开发者：何志浩、张同文、张瑞波、靳春寒、喻树龙、尚华明、秦莉</p>
                                    </div>
                                ) : <WidthContainer
                                    siteData={siteData}
                                    selected={selectedTree}
                                    masterSeries={cofechaResult?.masterDatingSeries}
                                    scrollContainerRef={dataContainerRef}
                                    onYearClick={handleGridClick} // 添加 onYearClick 事件处理函数
                                />
                            }

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
                        <span className={style["stat-item"]} style={{ color: getTextColor() }}>
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
                                <select name="cofecha" id={style["cofecha-selector"]} onChange={(e) => {
                                    setSelectedPart(e.target.value);
                                }}>
                                    <option key="全部" value="全部">📜 全部内容</option>
                                    <option key="part1" value="PART 1">📌 PART 1: Summary</option>
                                    <option key="part2" value="PART 2">📈 PART 2: Time Plot of Series</option>
                                    <option key="part3" value="PART 3">📉 PART 3: Master Dating Series</option>
                                    <option key="part4" value="PART 4">📊 PART 4: Master Bar Plot</option>
                                    <option key="part5" value="PART 5">📰 PART 5: Correlation of Series by Segment</option>
                                    <option key="part6" value="PART 6">⚠️ PART 6: Potential Problems</option>
                                    <option key="part7" value="PART 7">🪧 PART 7: Descriptive Statistics</option>
                                </select>
                                <p id={style["cofecha-text"]}>
                                    {selectedPart === "全部" ? outFileContent.current : cofechaParts.current.get(selectedPart)}
                                </p>
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
            </div >
        </>
    )
}
