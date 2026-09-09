import { emitTo } from "@tauri-apps/api/event";
import { useState } from "react";
import { WORKSPACE_WINDOW_COMMAND_EVENT, type WorkspaceWindowCommand } from "@/pages/home/workspaceWindowBridge";
import styles from "./SettingsPage.module.css";

export function WorkspaceTransferSection() {
    const [error, setError] = useState("");
    const send = async (type: "export-workspace" | "import-workspace") => {
        try {
            await emitTo("main", WORKSPACE_WINDOW_COMMAND_EVENT, { kind: "transfer", type } satisfies WorkspaceWindowCommand);
            setError("请在主窗口完成文件选择与确认。");
        } catch (failure) { setError(String(failure)); }
    };
    return <div>
        <h2 className={styles["section-title"]}>工作区迁移</h2>
        <div className={styles["row-body"]}>
            <button className={styles["action-button"]} type="button" onClick={() => void send("export-workspace")}>导出当前文件工作区</button>
            <button className={styles["secondary-button"]} type="button" onClick={() => void send("import-workspace")}>导入工作区</button>
            <p className={styles["setting-note"]}>.cdworkspace 保存主窗口当前RWL、未保存修改、原始对比基线、修改标记与完整记录。导入时按文件内容匹配，也可以将包内当前版本另存为新RWL。</p>
            <p className={styles["setting-note"]}>不包含扫描图片、模型或COFECHA报告。扫描标注保留校准基线，重新选择影像文件夹后校验原图并恢复关联。此操作不会清理缓存。</p>
            <p className={styles["setting-note"]}>导出以当前宽度网格为准；尚未应用的文本编辑或图表移动预览，请先应用后再导出。</p>
            <p className={styles["setting-note"]} role="status">{error}</p>
        </div>
    </div>;
}
