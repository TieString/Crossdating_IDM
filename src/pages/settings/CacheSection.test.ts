import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { CacheSection } from "./CacheSection";
import { scheduleCacheCleanup } from "@/services/fs/cacheMaintenance";
import { SettingsProvider } from "@/features/settings/SettingsContext";

const renderSection = () => renderToStaticMarkup(createElement(SettingsProvider, null, createElement(CacheSection)));

afterEach(() => vi.unstubAllGlobals());
it("preserves workspace records by default and describes when cleanup runs", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => null } });
    const html = renderSection();
    expect(html).toContain("缓存管理");
    expect(html).toContain("下次启动时清理");
    expect(html).toContain("默认保留未保存草稿");
    expect(html).not.toContain("checked=");
});

it("restores the pending scope with an explicit cancel action", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value); },
    } });
    scheduleCacheCleanup(true);
    const html = renderSection();
    expect(html).toContain("临时缓存及全部工作区记录");
    expect(html).toContain("取消待执行清理");
});
