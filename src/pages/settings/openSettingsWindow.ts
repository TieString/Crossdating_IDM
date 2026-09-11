import { t } from '@/i18n/core';
import { Window } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export async function openSettingsWindow() {
    const existing = await Window.getByLabel("settings");
    if (existing) {
        await existing.setFocus();
        return;
    }

    new WebviewWindow("settings", {
        url: "/?page=settings",
        title: t("偏好设置"),
        width: 820,
        minWidth: 680,
        height: 600,
        minHeight: 520,
        decorations: true,
        resizable: true,
        center: true,
    });
}
