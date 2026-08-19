import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TreeRingPreview } from "./TreeRingPreview";

describe("generated tree-ring header visibility", () => {
    it("uses canvas without embedding SVG artwork", () => {
        const markup = renderToStaticMarkup(createElement(TreeRingPreview, {
            seriesId: "TEST01",
            series: new Map([[2000, 100], [2001, 120]]),
            stopMarkerValue: -9999,
            onYearSelect: vi.fn(),
            onOpen: vi.fn(),
        }));

        expect(markup).toContain("<canvas");
        expect(markup).not.toContain("<svg");
        expect(markup).not.toContain("<image");
    });

    it("keeps the button but omits generated artwork when disabled", () => {
        const markup = renderToStaticMarkup(createElement(TreeRingPreview, {
            seriesId: "TEST01",
            series: new Map([[2000, 100], [2001, 120]]),
            stopMarkerValue: -9999,
            showArtwork: false,
            onYearSelect: vi.fn(),
            onOpen: vi.fn(),
        }));

        expect(markup).toContain("<button");
        expect(markup).toContain("图片已隐藏");
        expect(markup).not.toContain("<image");
    });
});
