import "./Home.css";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { deleteYearFromRwl, formateRwlFromMapToString, insertYearToRwl, readRwlToMap } from "../utils/rwlOperator.ts";
import MenuItem from "../components/MenuItem.tsx";
import Menu from "../components/Menu.tsx";
import { createRoot } from "react-dom/client";


// Extend HTMLElement type
declare global {
    interface HTMLElement {
        __root?: ReturnType<typeof createRoot>;
    }
}


export default function Home() {

    const [rwlStr, setRwlStr] = useState<string>("")
    const [treeOptions, setTreeOptions] = useState<string[]>([])  // 存储树种选项
    const [selectedTree, setSelectedTree] = useState<string>("全部");  // 存储选中的树种编号
    const [year, setYear] = useState<string>("")
    const filePathRef = useRef<string | null>(null);
    const rwlDataRef = useRef<Map<string, any>>(new Map());// 存储 rwl_data 的 ref 结构化的宽度数据

    // 当 rwl_data 更新时，更新树种选项
    useEffect(() => {
        if (rwlDataRef.current.size > 0) {
            const options = Array.from(rwlDataRef.current.keys());  // 获取所有键名
            setTreeOptions(options);  // 更新树种选项
        }
    }, [rwlDataRef.current]);  // 依赖项是 rwlDataRef rwlDataRef 更新时更新选项

    // 监听 selectedTree 变化，并更新 rwl_value
    useEffect(() => {
        if (rwlDataRef.current.size > 0 && selectedTree) {
            const rwl_str = formateRwlFromMapToString(rwlDataRef.current, selectedTree);
            setRwlStr(rwl_str);
        }
    }, [selectedTree, rwlDataRef.current]); // 依赖 selectedTree 和 rwlDataRef



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

            const menuTitle = document.getElementById("menu-title")
            if (menuTitle) {
                menuTitle.textContent = filePath;
            }

            // 修改窗口标题
            await getCurrentWindow().setTitle(filePath);

            // 读取文件内容
            const content = await readTextFile(filePath);
            // 提取并存储数据 编号：(year:width)
            const rwl_data = readRwlToMap(content);
            if (rwl_data) {
                rwlDataRef.current = rwl_data;  // 存储 rwl_data 到状态
                const rwl_str = formateRwlFromMapToString(rwl_data, selectedTree)
                setRwlStr(rwl_str)
            }
            filePathRef.current = filePath
        } catch (error) {
            console.error("读取文件时出错:", error);
        }
    }

    /** //TODO:1.保存后自动使用COFECHA检验
     *         2.加载CHFECHA内容，并提取最重要部分，主序列系数显示（将小于-1的值高亮出来，越小越亮）
     *         3.悬浮在宽度上提示年份
     *         4.编辑操作撤销重做
     *         5.曲线图
     *         6.双击更改年份内容
     *         7.年轮宽度示意图
     * */
    const HandleSave = async () => {
        if (!filePathRef.current) {
            alert("请先打开一个文件");
            return;
        }

        try {
            const rwlStr = formateRwlFromMapToString(rwlDataRef.current);
            console.log(rwlDataRef.current)
            await writeTextFile(filePathRef.current, rwlStr);
            console.log("文件已成功保存到:", filePathRef.current);
        } catch (error) {
            console.error("写入文件时出错:", error);
        }
    }
    const HandleSaveAs = async () => {
        try {
            // 如果没有文件路径，提示用户保存文件
            if (!filePathRef.current) {
                alert("请先打开一个文件");
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
            console.log(rwlDataRef.current)
            const rwlStr = formateRwlFromMapToString(rwlDataRef.current)
            // 写入文件
            await writeTextFile(filePathToSave, rwlStr);
            console.log("文件已成功保存到:", filePathToSave);
        } catch (error) {
            console.error("写入文件时出错:", error);
        }
    }

    const HandleInsert = () => {
        const yearToInsert = parseInt(year ?? '');  // 转换为数字
        if (isNaN(yearToInsert)) {
            alert('请输入有效的年份');
            return;
        }
        if (selectedTree === "全部") {
            alert("请选择一根树芯")
        }
        let treeData = rwlDataRef.current.get(selectedTree)
        treeData = insertYearToRwl(treeData, yearToInsert)
        const updatedRwlData = new Map(rwlDataRef.current); // 创建一个新的 Map 对象，避免直接修改状态
        updatedRwlData.set(selectedTree, treeData); // 更新指定树的数据
        rwlDataRef.current = updatedRwlData
    }

    const HandleDelete = () => {
        const yearToInsert = parseInt(year ?? '');  // 转换为数字
        if (isNaN(yearToInsert)) {
            alert('请输入有效的年份');
            return;
        }
        let treeData = rwlDataRef.current.get(selectedTree)
        treeData = deleteYearFromRwl(treeData, yearToInsert)
        const updatedRwlData = new Map(rwlDataRef.current); // 创建一个新的 Map 对象，避免直接修改状态
        updatedRwlData.set(selectedTree, treeData); // 更新指定树的数据
        rwlDataRef.current = updatedRwlData
    }


    const menuEditItems = [
        { label: '撤销' },
        { label: '恢复' },
        {
            label: '文件(F)',
            children: (
                <div>
                    <MenuItem label="新建文件" />
                    <MenuItem label="打开文件" />
                    <MenuItem label="保存" />
                    <MenuItem label="另存为" />
                </div>
            ),
        },
        { label: '查找' },
        { label: '替换' },
    ];

    const menuFileItems = [
        { label: '打开文件', onClick: HandleLoad },
        { label: '保存', onClick: HandleSave },
        { label: '另存为', onClick: HandleSaveAs },
    ];

    const [activeMenu, setActiveMenu] = useState<"file" | "edit" | null>(null);

    useEffect(() => {
        const buttons = document.querySelectorAll(".title-menu-item"); // 选取所有菜单按钮
        buttons.forEach(button => {
            (button as HTMLElement).style.backgroundColor = "transparent"; // 先重置所有按钮
        });

        const activeButton = document.getElementById(`title-submenu-${activeMenu}-button`);
        if (activeButton) activeButton.style.backgroundColor = "#e8e8e8"; // 仅修改当前激活的按钮

        const menuContainerFile = document.getElementById("title-submenu-file-container");
        const menuContainerEdit = document.getElementById("title-submenu-edit-container");
        const titleMenuFileButton = document.getElementById("title-submenu-file-button");
        const titleMenuEditButton = document.getElementById("title-submenu-edit-button");
        // 添加点击事件监听器
        titleMenuFileButton?.addEventListener("click", (e) => {
            e.stopPropagation();
            activeMenu === "file" ? setActiveMenu(null) : setActiveMenu("file")
        })
        titleMenuEditButton?.addEventListener("click", (e) => {
            e.stopPropagation();
            activeMenu === "edit" ? setActiveMenu(null) : setActiveMenu("edit")
        })

        // 确保 `createRoot` 只创建一次
        if (menuContainerFile && !menuContainerFile.__root) {
            menuContainerFile.__root = createRoot(menuContainerFile);
            menuContainerFile.__root.render(<Menu items={menuFileItems} />);
        }
        if (menuContainerEdit && !menuContainerEdit.__root) {
            menuContainerEdit.__root = createRoot(menuContainerEdit);
            menuContainerEdit.__root.render(<Menu items={menuEditItems} />);
        }

        // 渲染当前激活的菜单
        if (activeMenu === "file" && menuContainerFile && menuContainerFile.__root) {
            menuContainerFile.style.display = "block";
            if (menuContainerEdit) menuContainerEdit.style.display = "none"; // 关闭另一个菜单
        } else if (activeMenu === "edit" && menuContainerEdit && menuContainerEdit.__root) {
            menuContainerEdit.style.display = "block";
            if (menuContainerFile) menuContainerFile.style.display = "none"; // 关闭另一个菜单
        } else {
            // 如果 `activeMenu` 为空，则隐藏所有菜单
            if (menuContainerFile) menuContainerFile.style.display = "none";
            if (menuContainerEdit) menuContainerEdit.style.display = "none";
        }

        // 监听点击外部区域，自动关闭菜单
        const handleClickOutside = (event: MouseEvent) => {
            if (
                !menuContainerFile?.contains(event.target as Node) &&
                !menuContainerEdit?.contains(event.target as Node)
            ) {
                setActiveMenu(null);
            }
        };

        document.addEventListener("click", handleClickOutside);
        return () => document.removeEventListener("click", handleClickOutside);
    }, [activeMenu]);


    return (
        <>
            <div className="home_container">
                <div className="side_bar">
                    <select name="trees" id="tree_selector" onChange={(e) => { setSelectedTree(e.target.value) }}>
                        <option key="全部" value="全部">全部</option>
                        {treeOptions.map((tree) => (
                            <option key={tree} value={tree}>
                                {tree}
                            </option>
                        ))}
                    </select>
                    <input type="text" id="year_insert_pos" onChange={(e) => setYear(e.target.value)} placeholder="需要操作的年份" />
                    <button onClick={HandleInsert}>插入</button>
                    <button onClick={HandleDelete}>删除</button>
                    <hr />
                </div>
                <div className="data_container">
                    <p>{rwlStr}</p>
                </div>
            </div>
        </>
    )
}
