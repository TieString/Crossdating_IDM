import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { AnimationSettings, AppSettings } from "./settings";
import { loadSettings, saveSettings, STORAGE_KEY } from "./settings";

interface SettingsContextValue {
    settings: AppSettings;
    updateAnimationSettings: (update: Partial<AnimationSettings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
    const [settings, setSettings] = useState<AppSettings>(loadSettings);

    const updateAnimationSettings = useCallback((update: Partial<AnimationSettings>) => {
        setSettings((prev) => {
            const next: AppSettings = {
                ...prev,
                animation: { ...prev.animation, ...update },
            };
            saveSettings(next);
            return next;
        });
    }, []);

    // 监听其他窗口（如设置窗口）对 localStorage 的修改，实时同步到本窗口
    useEffect(() => {
        const handleStorage = (e: StorageEvent) => {
            if (e.key === STORAGE_KEY && e.newValue) {
                try {
                    setSettings(loadSettings());
                } catch {
                    // ignore
                }
            }
        };
        window.addEventListener("storage", handleStorage);
        return () => window.removeEventListener("storage", handleStorage);
    }, []);

    const value = useMemo(() => ({ settings, updateAnimationSettings }), [settings, updateAnimationSettings]);

    return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
    const ctx = useContext(SettingsContext);
    if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
    return ctx;
}
