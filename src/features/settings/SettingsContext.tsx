import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type {
    AnimationSettings,
    AppSettings,
    CofechaSettings,
    DiagnosisSettings,
    TreeRingImageSettings,
} from "./settings";
import { loadSettings, saveSettings, STORAGE_KEY } from "./settings";

/** Runtime settings context exposed to React components. */
export interface SettingsContextValue {
    /** Current persisted settings. */
    settings: AppSettings;
    /** Merges animation setting updates and persists the result. */
    updateAnimationSettings: (update: Partial<AnimationSettings>) => void;
    /** Merges COFECHA setting updates and persists the result. */
    updateCofechaSettings: (update: Partial<CofechaSettings>) => void;
    /** Merges automatic diagnosis setting updates and persists the result. */
    updateDiagnosisSettings: (update: Partial<DiagnosisSettings>) => void;
    /** Merges generated tree-ring image setting updates and persists the result. */
    updateTreeRingImageSettings: (update: Partial<TreeRingImageSettings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

/** Provides app settings and synchronizes localStorage changes from other windows. */
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

    const updateCofechaSettings = useCallback((update: Partial<CofechaSettings>) => {
        setSettings((prev) => {
            const next: AppSettings = {
                ...prev,
                cofecha: { ...prev.cofecha, ...update },
            };
            saveSettings(next);
            return next;
        });
    }, []);

    const updateDiagnosisSettings = useCallback((update: Partial<DiagnosisSettings>) => {
        setSettings((prev) => {
            const next: AppSettings = {
                ...prev,
                diagnosis: { ...prev.diagnosis, ...update },
            };
            saveSettings(next);
            return next;
        });
    }, []);

    const updateTreeRingImageSettings = useCallback((update: Partial<TreeRingImageSettings>) => {
        setSettings((prev) => {
            const next: AppSettings = {
                ...prev,
                treeRingImage: { ...prev.treeRingImage, ...update },
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

    const value = useMemo(
        () => ({
            settings,
            updateAnimationSettings,
            updateCofechaSettings,
            updateDiagnosisSettings,
            updateTreeRingImageSettings,
        }),
        [settings, updateAnimationSettings, updateCofechaSettings, updateDiagnosisSettings, updateTreeRingImageSettings],
    );

    return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

/** Reads the settings context and throws when used outside SettingsProvider. */
export function useSettings() {
    const ctx = useContext(SettingsContext);
    if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
    return ctx;
}
