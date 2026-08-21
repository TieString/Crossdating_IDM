/** Animation used when an entire series is deleted. */
export type DeleteSeriesAnimation = "shatter-rise" | "fade" | "none";
/** Animation used when a single year is deleted. */
export type DeleteYearAnimation = "pixel-burst" | "none";
/** Animation used when a missing year is inserted. */
export type InsertYearAnimation = "slide-shift" | "pulse-shift" | "side-pop-shift" | "flight-shift" | "none";
/** Generic enabled/disabled animation switch. */
export type AnimationSwitch = "enabled" | "disabled";
export type HistoryAnimation = AnimationSwitch;

export const ANIMATION_SPEED_MIN = 0.1;
export const ANIMATION_SPEED_MAX = 5;
export const ANIMATION_SPEED_STEP = 0.1;
export const DEFAULT_ANIMATION_SPEED = 1;

export interface AnimationSettings {
    /** Global animation enable switch. */
    enabled: AnimationSwitch;
    /** User animation speed multiplier. */
    speed: number;
    /** Whole-series delete animation. */
    deleteSeries: DeleteSeriesAnimation;
    /** Single-year delete animation. */
    deleteYear: DeleteYearAnimation;
    /** Missing-year insert animation. */
    insertYear: InsertYearAnimation;
    /** Undo/redo animation switch. */
    historyAnim: HistoryAnimation;
}

export interface CofechaSettings {
    /** User-selected COFECHA executable, regardless of release family. */
    executablePath: string;
}

export interface DiagnosisSettings {
    /** Automatically diagnose the currently selected series after selection or data changes. */
    enabled: boolean;
}

export interface TreeRingImageSettings {
    /** Show generated tree-ring artwork inside the series header button. */
    showGeneratedPreview: boolean;
}

/** Persisted application settings shape. */
export interface AppSettings {
    /** Animation-related preferences. */
    animation: AnimationSettings;
    /** COFECHA engine preferences. */
    cofecha: CofechaSettings;
    /** Automatic dating-suggestion preferences. */
    diagnosis: DiagnosisSettings;
    /** Generated tree-ring image preferences. */
    treeRingImage: TreeRingImageSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
    animation: {
        enabled: "enabled",
        speed: DEFAULT_ANIMATION_SPEED,
        deleteSeries: "shatter-rise",
        deleteYear: "pixel-burst",
        insertYear: "slide-shift",
        historyAnim: "enabled",
    },
    cofecha: {
        executablePath: "",
    },
    diagnosis: {
        enabled: true,
    },
    treeRingImage: {
        showGeneratedPreview: true,
    },
};

export const STORAGE_KEY = "crossdating-idm-settings";

/** Coerces any input to the persisted animation-speed step and bounds. */
export function normalizeAnimationSpeed(value: unknown): number {
    const numeric = typeof value === "number" ? value : Number(value);

    if (!Number.isFinite(numeric)) {
        return DEFAULT_ANIMATION_SPEED;
    }

    const stepped = Math.round(numeric / ANIMATION_SPEED_STEP) * ANIMATION_SPEED_STEP;
    return Math.min(ANIMATION_SPEED_MAX, Math.max(ANIMATION_SPEED_MIN, stepped));
}

/** Loads settings from localStorage, falling back to defaults for invalid or missing values. */
export function loadSettings(): AppSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_SETTINGS;
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        const parsedAnimation = parsed.animation && typeof parsed.animation === "object"
            ? parsed.animation
            : {};
        const parsedCofecha = parsed.cofecha && typeof parsed.cofecha === "object"
            ? parsed.cofecha
            : {};
        const parsedDiagnosis = parsed.diagnosis && typeof parsed.diagnosis === "object"
            ? parsed.diagnosis
            : {};
        const parsedTreeRingImage = parsed.treeRingImage && typeof parsed.treeRingImage === "object"
            ? parsed.treeRingImage
            : {};
        const parsedDiagnosisEnabled = (parsedDiagnosis as Partial<DiagnosisSettings>).enabled;
        const parsedGeneratedPreview = (parsedTreeRingImage as Partial<TreeRingImageSettings>).showGeneratedPreview;
        const parsedExecutablePath = (parsedCofecha as Partial<CofechaSettings>).executablePath;

        return {
            animation: {
                ...DEFAULT_SETTINGS.animation,
                ...parsedAnimation,
                speed: normalizeAnimationSpeed((parsedAnimation as Partial<AnimationSettings>).speed),
            },
            cofecha: {
                executablePath: typeof parsedExecutablePath === "string"
                    ? parsedExecutablePath.trim()
                    : DEFAULT_SETTINGS.cofecha.executablePath,
            },
            diagnosis: {
                enabled: typeof parsedDiagnosisEnabled === "boolean"
                    ? parsedDiagnosisEnabled
                    : DEFAULT_SETTINGS.diagnosis.enabled,
            },
            treeRingImage: {
                showGeneratedPreview: typeof parsedGeneratedPreview === "boolean"
                    ? parsedGeneratedPreview
                    : DEFAULT_SETTINGS.treeRingImage.showGeneratedPreview,
            },
        };
    } catch {
        return DEFAULT_SETTINGS;
    }
}

/** Saves settings to localStorage and ignores storage write failures. */
export function saveSettings(settings: AppSettings): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // ignore
    }
}
