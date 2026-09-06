import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsProvider } from "@/features/settings/SettingsContext";
import { CofechaSection } from "./SettingsPage";

describe("COFECHA settings UI", () => {
    it("renders JavaScript as the default report engine and keeps official EXE configuration", () => {
        const html = renderToStaticMarkup(createElement(SettingsProvider, null,
            createElement(CofechaSection)));
        expect(html).toContain("COFECHA 报告引擎");
        expect(html).toContain("aria-pressed=\"true\">JavaScript");
        expect(html).toContain("aria-pressed=\"false\">官方 COFECHA");
        expect(html).toContain("选择 EXE");
    });
});
