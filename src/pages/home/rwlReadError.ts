import { message } from "@tauri-apps/plugin-dialog";

/** Convert parser diagnostics to actionable text without guessing missing data. */
export function formatRwlReadError(error: unknown, filePath?: string): string {
    const detail = error instanceof Error ? error.message : String(error);
    const missing = [...detail.matchAll(/missing stop marker in (.+?) before (-?\d+); inferred (?:-9999|999)/g)];
    const file = filePath ? `文件：${filePath}\n\n` : "";
    if (missing.length) {
        const locations = missing.slice(0, 5).map(([, id, year]) =>
            `序列 ${id}：截至 ${Number(year) - 1} 年的数据段缺少结束符（下一位置为 ${year} 年）。`);
        if (missing.length > 5) locations.push(`另有 ${missing.length - 5} 处同类问题。`);
        return `${file}${locations.join("\n")}\n\n请核对断开位置：如果是分段缺测，请在上一段末尾补写结束符；如果遗漏了测量值，请补回正确数据。\n结束符按该段实际单位选择：999（0.01 mm）或 -9999（0.001 mm）。\n\n该文件未载入；软件没有自动补0、补测量值或改写原文件。`;
    }
    return `${file}读取文件失败：\n${detail}\n\n请检查文件格式及读取权限，修正后重新打开。`;
}

export async function showRwlReadError(error: unknown, filePath?: string): Promise<void> {
    const text = formatRwlReadError(error, filePath);
    try {
        await message(text, { title: "无法打开 RWL 文件", kind: "error" });
    } catch (dialogError) {
        console.error("无法显示读取错误对话框:", dialogError);
        // Browser preview or a failed native dialog must still show the error.
        window.alert(text);
    }
}
