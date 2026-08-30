import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CofechaUndatedControls } from "./CofechaUndatedControls";

describe("CofechaUndatedControls", () => {
    it("shows a single load command before an undated file is selected", () => {
        const html = renderToStaticMarkup(createElement(CofechaUndatedControls, {
            fileName: null,
            sort: "correlation",
            onLoad: () => undefined,
            onClear: () => undefined,
            onSortChange: () => undefined,
        }));

        expect(html).toContain("加载未定年");
        expect(html).not.toContain("未定年匹配排序");
    });

    it("shows the file, R/D sort and clear command after selection", () => {
        const html = renderToStaticMarkup(createElement(CofechaUndatedControls, {
            fileName: "UNDATED.RWL",
            sort: "adjustment",
            onLoad: () => undefined,
            onClear: () => undefined,
            onSortChange: () => undefined,
        }));

        expect(html).toContain("UNDATED.RWL");
        expect(html).toContain("最高相关 R");
        expect(html).toContain("年份调整 D");
        expect(html).toContain("aria-label=\"清除未定年 RWL\"");
    });
});
