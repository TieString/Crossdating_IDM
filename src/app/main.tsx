import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsProvider } from "@/features/settings/SettingsContext";
import SettingsPage from "@/pages/settings/SettingsPage";
import WorkspaceWindowPage from "@/pages/workspace/WorkspaceWindowPage";

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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
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
