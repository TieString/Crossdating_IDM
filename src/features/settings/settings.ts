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

/** Persisted application settings shape. */
export interface AppSettings {
    /** Animation-related preferences. */
    animation: AnimationSettings;
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

        return {
            animation: {
                ...DEFAULT_SETTINGS.animation,
                ...parsedAnimation,
                speed: normalizeAnimationSpeed((parsedAnimation as Partial<AnimationSettings>).speed),
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
