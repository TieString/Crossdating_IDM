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
        title: "偏好设置",
        width: 680,
        height: 520,
        decorations: true,
        resizable: false,
        center: true,
    });
}
