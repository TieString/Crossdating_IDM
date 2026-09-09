import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WorkspaceTransferSection } from "./WorkspaceTransferSection";
import { OperationLogPage } from "@/pages/home/WorkspacePages";

it("provides the two migration actions and makes the package distinct from cache cleanup", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceTransferSection));
    expect(html).toContain("导出当前文件工作区");
    expect(html).toContain("导入工作区");
    expect(html).toContain(".cdworkspace");
    expect(html).toContain("此操作不会清理缓存");
});
it("exposes effective-change CSV export in the operation-record window", () => {
    const html = renderToStaticMarkup(createElement(OperationLogPage, { fileName: "BL1.rwl", operationLog: [],
        canResetToRawData: false, onUndoEntry: () => {}, onJumpEntry: () => {}, onResetToRawData: () => {},
        onClose: () => {}, onExportEffectiveChanges: () => {} }));
    expect(html).toContain("导出有效修改记录");
});
