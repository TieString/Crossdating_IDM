import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { message } from "@tauri-apps/plugin-dialog";
import { formatRwlReadError, showRwlReadError } from "./rwlReadError";
import { parseTucson } from "@/features/rwl/parsers/tucson";

vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(message).mockReset().mockResolvedValue(undefined); });

describe("RWL read failure dialog", () => {
    it("shows a native dialog for the actual missing-terminator failure", async () => {
        const row = (year: number, values: number[]) => "1011".padEnd(8) + String(year).padStart(4)
            + values.map(v => String(v).padStart(6)).join("");
        let failure: unknown;
        try { parseTucson([row(2003,[663,429,487,605,497,545]),row(2010,[436,583,-9999])].join("\n")); }
        catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        await showRwlReadError(failure, "D:/BL11.rwl");
        expect(message).toHaveBeenCalledWith(expect.stringContaining("截至 2008 年的数据段缺少结束符"),
            { title: "无法打开 RWL 文件", kind: "error" });
        const text = vi.mocked(message).mock.calls[0][0];
        expect(text).toContain("2009");
        expect(text).toContain("1011");
        expect(text).toContain("D:/BL11.rwl");
        expect(text).not.toContain("inferred");
    });
    it("keeps general read errors visible", async () => {
        await showRwlReadError(new Error("access denied"));
        expect(message).toHaveBeenCalledWith(expect.stringContaining("access denied"), expect.objectContaining({kind:"error"}));
    });
    it("uses an alert if the native dialog is unavailable", async () => {
        const alert = vi.fn(); vi.stubGlobal("window", { alert });
        vi.spyOn(console,"error").mockImplementation(() => undefined);
        vi.mocked(message).mockRejectedValueOnce(new Error("dialog unavailable"));
        await showRwlReadError(new Error("bad RWL"));
        expect(alert).toHaveBeenCalledWith(expect.stringContaining("bad RWL"));
    });
    it("limits long diagnostics without hiding the issue count", () => {
        const error = new Error(Array.from({length:8},(_,i)=>`missing stop marker in A${i} before 2009; inferred 999`).join("\n"));
        expect(formatRwlReadError(error)).toContain("另有 3 处同类问题");
    });
    it("wires the open-file catch to the visible error reporter", () => {
        const source = readFileSync(new URL("./useHomeWorkspace.ts", import.meta.url),"utf8");
        expect(source).toMatch(/console\.error\("读取文件时出错:", error\);\s*await showRwlReadError\(error, loadingPath\);/);
    });
});
