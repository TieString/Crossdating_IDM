// TODO:
/** 1.保存后自动使用COFECHA检验 √
 *  2.加载CHFECHA内容，并提取最重要部分，主序列系数显示（将小于-1的值高亮出来，越小越亮） √
 *  3.悬浮在宽度上提示年份 √
 *  4.编辑操作撤销重做 √
 *  5.曲线图
 *  6.双击更改年份内容
 *  7.年轮宽度示意图
 * */

import "./Home.css";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { RwlEditor, readRwlToMap, formateRwlFromMapToString } from "../utils/rwlOperator.ts";
// import MenuItem from "../components/MenuItem.tsx";
import Menu from "../components/Menu.tsx";
import { createRoot, Root } from "react-dom/client";
import WidthContainer from "../components/WidthContainer.tsx";
import { Command } from '@tauri-apps/plugin-shell'
import { parseCofechaResult, readOutFile, splitReportByParts } from "../utils/COFECHAFormatter.ts";
import { ICofechaResult } from "../types.ts";

// Extend HTMLElement type
declare global {
    interface HTMLElement {
        __root?: ReturnType<typeof createRoot>;
    }
}

// 在组件外部定义一个 `title` 处理工具函数
const formatTitle = (fileName: string | null, isModified: boolean) => {
    return fileName ? `${fileName}${isModified ? " *" : ""}` : "未命名文件";
};


export default function Home() {

    const rwlEditorRef = useRef<RwlEditor>(new RwlEditor(new Map()));// 存储 rwl_data 的 ref 结构化的宽度数据
    const [treeOptions, setTreeOptions] = useState<string[]>([])  // 存储树种选项
    const [selectedTree, setSelectedTree] = useState<string>("全部");  // 存储选中的树种编号
    const [year, setYear] = useState<string>("")
    const filePathRef = useRef<string | null>(null);
    const [fileName, setFileName] = useState<string | null>(null); // 存储文件名
    const [isModified, setIsModified] = useState(false); // 记录文件是否被修改
    const outFileContent = useRef<string>("")
    const [potentialProblemsDetail, setPotentialProblemsDetail] = useState<Map<string, string>>(new Map)
    const [cofechaResult, setCofechaResult] = useState<ICofechaResult>()
    const [selectedPart, setSelectedPart] = useState("全部"); // 选中的部分
    const cofechaParts = useRef<Map<string, string>>(new Map);

    const [_, setRender] = useState(0); // 只是用来触发重新渲染
    const emitRender = () => {
        setRender(prev => prev + 1); // 触发重新渲染
    };

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

    // 标记文件为修改状态
    const markAsModified = () => {
        setIsModified(true);
    };


    // 读取文件的处理
    const HandleLoad = async () => {
        try {
            // 打开文件选择对话框，让用户选择要读取的文件
            const filePath = await open({
                filters: [{ name: "Tucson Files", extensions: ["rwl"] }], // 仅限 .rwl 文件
                // title: "打开文件",
                multiple: false, // 仅允许选择一个文件
            });

            // 如果用户取消了文件选择
            if (!filePath) {
                console.log("用户取消了文件选择");
                return;
            }

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
            const rwlData = readRwlToMap(content);
            if (rwlData) {
                rwlEditorRef.current = new RwlEditor(rwlData);
                const options = Array.from(rwlData.keys());  // 获取所有键名
                setTreeOptions(options);  // 更新树种选项
            }
            setFileName(filePath); // 更新文件名
            setIsModified(false);
            runCofecha();
            emitRender();
        } catch (error) {
            console.error("读取文件时出错:", error);
        }
    }

    const HandleSave = async () => {
        if (!filePathRef.current) {
            console.log("请先打开一个文件");
            return;
        }

        try {
            const rwlStr = formateRwlFromMapToString(rwlEditorRef.current.getData());
            await writeTextFile(filePathRef.current, rwlStr);
            console.log("文件已成功保存到:", filePathRef.current);
            setIsModified(false); // 文件保存后标记为未修改

            await runCofecha();
        } catch (error) {
            console.error("写入文件时出错:", error);
        }
    }

    const readCofechaFile = async () => {
        outFileContent.current = await readOutFile();
        emitRender()
        const result = parseCofechaResult(outFileContent.current)

        setCofechaResult(result)
        setPotentialProblemsDetail(result.possibleProblemsDetail)
        cofechaParts.current = splitReportByParts(outFileContent.current)
    }


    const runCofecha = async () => {
        const command = Command.create("bin/cofecha");
        command.on('close', async data => {
            // Terminate the process
            await child.kill();
            console.log(`command finished with code ${data.code} and signal ${data.signal}`)
            await readCofechaFile();
        });
        command.stdout.on("data", line => console.log("stdout:", line))
        command.stderr.on("data", err => console.error("stderr:", err))

        const child = await command.spawn()
        // 向 stdin 传递数据
        child.write("very\n");
        child.write(`${filePathRef.current}\n`)
        child.write("\n") // echo.
        child.write("\n");
        child.write("\n");
        child.write("\n");
        child.write("\n");

        console.log("COFECHA 运行完成");
    };

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
            const rwlStr = formateRwlFromMapToString(rwlEditorRef.current.getData())
            // 写入文件
            await writeTextFile(filePathToSave, rwlStr);
            console.log("文件已成功保存到:", filePathToSave);
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
        markAsModified()
        emitRender()
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
        markAsModified()
        emitRender()
    }

    const HandleUndo = () => {
        rwlEditorRef.current.undo();
        setIsModified(true);
        emitRender();
    };

    const HandleRedo = () => {
        rwlEditorRef.current.redo();
        setIsModified(true);
        emitRender();
    };

    const handleGridClick = (year: number) => {
        setYear(year.toString());
    };

    const menuEditItems = [
        { label: '撤销', onClick: HandleUndo },
        { label: '恢复', onClick: HandleRedo },
        // {
        //     label: '文件(F)',
        //     children: (
        //         <div>
        //             <MenuItem label="新建文件" />
        //             <MenuItem label="打开文件" />
        //             <MenuItem label="保存" />
        //             <MenuItem label="另存为" />
        //         </div>
        //     ),
        // },
        { label: '查找' },
        { label: '替换' },
    ];

    const menuFileItems = [
        { label: '打开文件', onClick: HandleLoad },
        { label: '保存', onClick: HandleSave },
        { label: '另存为', onClick: HandleSaveAs },
    ];

    const [activeMenu, setActiveMenu] = useState<"file" | "edit" | null>(null);

    // 用 useRef 存储根节点，避免重复创建
    const fileMenuRoot = useRef<Root | null>(null);
    const editMenuRoot = useRef<Root | null>(null);

    useEffect(() => {
        const menuContainerFile = document.getElementById("title-submenu-file-container");
        const menuContainerEdit = document.getElementById("title-submenu-edit-container");

        // **1️⃣ 只在第一次渲染时创建 React Root**
        if (!fileMenuRoot.current && menuContainerFile) {
            fileMenuRoot.current = createRoot(menuContainerFile);
            fileMenuRoot.current.render(<Menu items={menuFileItems} />);
        }
        if (!editMenuRoot.current && menuContainerEdit) {
            editMenuRoot.current = createRoot(menuContainerEdit);
            editMenuRoot.current.render(<Menu items={menuEditItems} />);
        }

        // **2️⃣ 监听点击事件（只绑定一次）**
        interface ClickTarget {
            target: EventTarget | null;
        }

        const handleClickOutside = (event: MouseEvent & ClickTarget) => {
            if (
                !menuContainerFile?.contains(event.target as Node) &&
                !menuContainerEdit?.contains(event.target as Node)
            ) {
                setActiveMenu(null);
            }
        };
        document.addEventListener("click", handleClickOutside);
        const titleMenuFileButton = document.getElementById("title-submenu-file-button");
        const titleMenuEditButton = document.getElementById("title-submenu-edit-button");
        // 添加点击事件监听器
        interface MenuClickEvent extends MouseEvent {
            target: EventTarget | null;
        }

        const handleFileButtonClick = (e: MenuClickEvent) => {
            e.stopPropagation();
            activeMenu === "file" ? setActiveMenu(null) : setActiveMenu("file")
        };

        titleMenuFileButton?.addEventListener("click", handleFileButtonClick);

        const handleEditButtonClick = (e: MenuClickEvent) => {
            e.stopPropagation(); 
            activeMenu === "edit" ? setActiveMenu(null) : setActiveMenu("edit")
        };
        titleMenuEditButton?.addEventListener("click", handleEditButtonClick);

        return () => {
            document.removeEventListener("click", handleClickOutside);
            document.removeEventListener("click", handleFileButtonClick);
            document.removeEventListener("click", handleEditButtonClick); 
        };
        }, []); // ✅ `useEffect` 只执行一次，避免重复绑定事件

    // **3️⃣ 仅在 activeMenu 变化时更新 UI**
    useEffect(() => {
        document.querySelectorAll(".title-menu-item").forEach(button => {
            (button as HTMLElement).style.backgroundColor = "transparent";
        });

        const activeButton = document.getElementById(`title-submenu-${activeMenu}-button`);
        if (activeButton) activeButton.style.backgroundColor = "#e8e8e8";

        const menuContainerFile = document.getElementById("title-submenu-file-container");
        const menuContainerEdit = document.getElementById("title-submenu-edit-container");

        if (activeMenu === "file") {
            if (menuContainerFile) menuContainerFile.style.display = "block";
            if (menuContainerEdit) menuContainerEdit.style.display = "none";
        } else if (activeMenu === "edit") {
            if (menuContainerEdit) menuContainerEdit.style.display = "block";
            if (menuContainerFile) menuContainerFile.style.display = "none";
        } else {
            if (menuContainerFile) menuContainerFile.style.display = "none";
            if (menuContainerEdit) menuContainerEdit.style.display = "none";
        }
    }, [activeMenu]); // ✅ 仅当 `activeMenu` 变化时更新 UI

    const getTextColor = () => {
        const count = cofechaResult?.possibleProblemsCount;
        return count !== undefined && count >= 100 ? "red" : "black";
    };
    return (
        <>
            <div className="home-container">
                <div className="width-module">
                    <div className="control-bar">
                        <select name="trees" id="tree_selector" onChange={(e) => { setSelectedTree(e.target.value) }}>
                            <option key="全部" value="全部">📜 全部</option>
                            {treeOptions.map((tree) => (
                                <option key={tree} value={tree}>
                                    -{cofechaResult?.possibleProblemsDetail.has(tree) ? "⚠️" : "🪵"}{tree}
                                </option>
                            ))}
                        </select>
                        <input
                            type="text"
                            id="year_to_edit"
                            onChange={(e) => setYear(e.target.value)}
                            value={year} placeholder="输入或点击需要操作的年份"
                        />
                        <button onClick={HandleInsert}>插入</button>
                        <button onClick={HandleDelete}>删除</button>
                    </div>
                    <div className={`data-container ${activeMenu ? "z-index-1" : ""}`}>
                        <WidthContainer
                            siteData={rwlEditorRef.current.getData()}
                            selected={selectedTree}
                            masterSeries={cofechaResult?.masterDatingSeries}
                            onYearClick={handleGridClick} // 添加 onYearClick 事件处理函数
                        />
                    </div>
                    <div className="problems-container">
                        <p className="potential-problems">
                            {potentialProblemsDetail.get(selectedTree)}
                        </p>
                    </div>
                </div>
                <div className="cofecha-module">
                    <div className="statics-info">
                        <span style={{ color: getTextColor() }}>
                            *A*<br />
                            {cofechaResult?.possibleProblemsCount}
                        </span>
                        <span>Master series<br />{cofechaResult?.masterSeriesYear}</span>
                        <span>Intercorrelation<br />{cofechaResult?.seriesIntercorrelation}</span>
                        <span>Mean sensitivity<br />{cofechaResult?.averageMeanSensitivity}</span>
                        <span>Mean length<br />{cofechaResult?.meanLength}</span>
                    </div>
                    {/* <div className="graph">

                    </div> */}
                    <div className="full-text">
                        <select name="cofecha" id="cofecha-selector" onChange={(e) => {
                            setSelectedPart(e.target.value);
                        }}>
                            <option key="全部" value="全部">📜 全部内容</option>
                            <option key="part1" value="PART 1">📌 PART 1: Summary</option>
                            <option key="part2" value="PART 2">📈 PART 2: Time Plot of Series</option>
                            <option key="part3" value="PART 3">📉 PART 3: Master Dating Series</option>
                            <option key="part4" value="PART 4">📊 PART 4: Master Bar Plot</option>
                            <option key="part5" value="PART 5">📰 PART 5: Corrlation of Series by Segment</option>
                            <option key="part6" value="PART 6">⚠️ PART 6: Potential Problems</option>
                            <option key="part7" value="PART 7">🪧 PART 7: Descriptive Statistics</option>
                        </select>
                        <p>
                            {selectedPart === "全部" ? outFileContent.current : cofechaParts.current.get(selectedPart)}
                        </p>
                    </div>
                </div>
            </div >
        </>
    )
}
