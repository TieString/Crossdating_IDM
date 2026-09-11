import { getLocale, t } from '@/i18n/core';
import React from "react";
import { LanguageBridge } from "@/i18n/react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsProvider } from "@/features/settings/SettingsContext";
import SettingsPage from "@/pages/settings/SettingsPage";
import WorkspaceWindowPage from "@/pages/workspace/WorkspaceWindowPage";
import { runPendingCacheCleanup } from "@/services/fs/cacheMaintenance";

const page = new URLSearchParams(window.location.search).get("page");
const isSettingsPage = page === "settings";
const isWorkspaceWindowPage = page === "operation-log" || page === "cofecha" || page === "line-chart";

if (isSettingsPage || isWorkspaceWindowPage) {
    // 除主窗口外的所有窗口统一使用系统原生标题栏，隐藏页面内嵌的自定义标题栏，
    // 并重置 #root 的边距使内容填满整个窗口。
    const titlebar = document.querySelector<HTMLElement>(".titlebar");
    if (titlebar) titlebar.style.display = "none";

    const rootEl = document.getElementById("root");
    if (rootEl) {
        rootEl.style.marginTop = "0";
        rootEl.style.marginLeft = "0";
        rootEl.style.marginRight = "0";
        rootEl.style.marginBottom = "0";
        rootEl.style.height = "100%";
    }
}

async function mountApplication() {
    // Apply the saved language before potentially slow pre-mount cache maintenance.
    document.documentElement.lang = getLocale();
    for (const [id, key] of [["title-submenu-file-button", "文件(F)"], ["title-submenu-edit-button", "编辑(E)"], ["title-submenu-run-button", "运行(R)"]]) {
        const button = document.getElementById(id);
        if (button) button.textContent = t(key);
    }
    if (!isSettingsPage && !isWorkspaceWindowPage) {
        try { await runPendingCacheCleanup(); }
        catch (error) { console.warn("缓存清理未完成，保留任务供下次启动重试:", error); }
    }
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <LanguageBridge />
        {isSettingsPage ? (
            <SettingsProvider>
                <SettingsPage />
            </SettingsProvider>
        ) : isWorkspaceWindowPage ? (
            <SettingsProvider>
                <WorkspaceWindowPage />
            </SettingsProvider>
        ) : (
            <App />
        )}
    </React.StrictMode>,
);
}
void mountApplication();
