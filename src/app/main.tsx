import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsProvider } from "@/features/settings/SettingsContext";
import SettingsPage from "@/pages/settings/SettingsPage";
import WorkspaceWindowPage from "@/pages/workspace/WorkspaceWindowPage";
import { workspaceWindowTitles, type WorkspaceWindowKind } from "@/pages/home/workspaceWindowBridge";

const page = new URLSearchParams(window.location.search).get("page");
const isSettingsPage = page === "settings";
const isWorkspaceWindowPage = page === "operation-log" || page === "cofecha" || page === "line-chart";

if (isSettingsPage) {
    // 设置窗口使用系统原生标题栏，隐藏页面内嵌的自定义标题栏
    const titlebar = document.querySelector<HTMLElement>(".titlebar");
    if (titlebar) titlebar.style.display = "none";

    // 重置 #root 的边距使其填满整个窗口
    const rootEl = document.getElementById("root");
    if (rootEl) {
        rootEl.style.marginTop = "0";
        rootEl.style.marginLeft = "0";
        rootEl.style.marginRight = "0";
        rootEl.style.marginBottom = "0";
        rootEl.style.height = "100%";
    }
} else if (isWorkspaceWindowPage) {
    // 工作区独立窗口复用主窗口的自定义标题栏（拖拽区 + 最小化/最大化/关闭按钮），
    // 仅隐藏「文件/编辑/运行」「撤销/恢复」这些主窗口专属菜单，使外观与主窗口统一。
    // #root 沿用 App.css 的 margin-top:35px 给标题栏留白，无需重置。
    const menu = document.querySelector<HTMLElement>(".titlebar .menu");
    if (menu) menu.style.display = "none";

    // 菜单隐藏后左上角空出来，显示软件 logo（与主窗口同一个 IDM.png）
    const logo = document.getElementById("titlebar-logo");
    if (logo) logo.style.display = "flex";

    const menuTitle = document.getElementById("menu-title");
    if (menuTitle) menuTitle.textContent = workspaceWindowTitles[page as WorkspaceWindowKind] ?? "";
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
