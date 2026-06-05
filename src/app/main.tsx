import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsProvider } from "@/features/settings/SettingsContext";
import SettingsPage from "@/pages/settings/SettingsPage";

const isSettingsPage = new URLSearchParams(window.location.search).get("page") === "settings";

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
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        {isSettingsPage ? (
            <SettingsProvider>
                <SettingsPage />
            </SettingsProvider>
        ) : (
            <App />
        )}
    </React.StrictMode>,
);
