import { useCallback, useEffect, useRef, useState } from "react";

const LAYOUT_STORAGE_KEY = "crossdating.homeLayout.v1";

const DEFAULT_LAYOUT = {
    mainSplitRatio: 0.5,
    leftBottomRatio: 0.12,
    rightBottomRatio: 0.35,
} as const;

type LayoutKey = keyof typeof DEFAULT_LAYOUT;
type ResizeAxis = "x" | "y";

type ResizeConfig = {
    key: LayoutKey;
    axis: ResizeAxis;
    container: HTMLElement | null | (() => HTMLElement | null);
    minStart: number;
    minEnd: number;
};

type StoredLayout = Record<LayoutKey, number>;

const isValidRatio = (value: unknown): value is number => {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
};

const readStoredLayout = (): StoredLayout => {
    if (typeof window === "undefined") {
        return { ...DEFAULT_LAYOUT };
    }

    try {
        const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
        if (!raw) {
            return { ...DEFAULT_LAYOUT };
        }

        const parsed = JSON.parse(raw) as Partial<StoredLayout>;
        return {
            mainSplitRatio: isValidRatio(parsed.mainSplitRatio) ? parsed.mainSplitRatio : DEFAULT_LAYOUT.mainSplitRatio,
            leftBottomRatio: isValidRatio(parsed.leftBottomRatio) ? parsed.leftBottomRatio : DEFAULT_LAYOUT.leftBottomRatio,
            rightBottomRatio: isValidRatio(parsed.rightBottomRatio) ? parsed.rightBottomRatio : DEFAULT_LAYOUT.rightBottomRatio,
        };
    } catch {
        return { ...DEFAULT_LAYOUT };
    }
};

const clamp = (value: number, min: number, max: number) => {
    if (min >= max) {
        return min;
    }

    return Math.min(Math.max(value, min), max);
};

export function useResizablePanels() {
    const [layout, setLayout] = useState<StoredLayout>(() => readStoredLayout());
    const [draggingKey, setDraggingKey] = useState<LayoutKey | null>(null);
    const cleanupRef = useRef<(() => void) | null>(null);
    const layoutRef = useRef<StoredLayout>(layout);

    useEffect(() => {
        window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    }, [layout]);

    useEffect(() => {
        layoutRef.current = layout;
    }, [layout]);

    useEffect(() => {
        return () => {
            cleanupRef.current?.();
        };
    }, []);

    const startResize = useCallback(({ key, axis, container, minStart, minEnd }: ResizeConfig) => {
        return (event: React.PointerEvent<HTMLDivElement>) => {
            const resolvedContainer = typeof container === "function" ? container() : container;
            if (event.button !== 0 || !resolvedContainer) {
                return;
            }

            event.preventDefault();

            const rect = resolvedContainer.getBoundingClientRect();
            const size = axis === "x" ? rect.width : rect.height;
            if (size <= 0) {
                return;
            }

            const effectiveSize = Math.max(size, minStart + minEnd);
            const minRatio = minStart / effectiveSize;
            const maxRatio = 1 - minEnd / effectiveSize;
            const pointerStart = axis === "x" ? event.clientX : event.clientY;
            const startRatio = layoutRef.current[key];
            const cursor = axis === "x" ? "col-resize" : "row-resize";
            const originalUserSelect = document.body.style.userSelect;
            const originalCursor = document.body.style.cursor;

            const applyRatio = (clientX: number, clientY: number) => {
                const delta = (axis === "x" ? clientX : clientY) - pointerStart;
                const nextRatio = clamp(startRatio + delta / size, minRatio, maxRatio);

                setLayout((previous) => {
                    if (Math.abs(previous[key] - nextRatio) < 0.0001) {
                        return previous;
                    }

                    return {
                        ...previous,
                        [key]: nextRatio,
                    };
                });
            };

            const finishResize = () => {
                window.removeEventListener("pointermove", handlePointerMove);
                window.removeEventListener("pointerup", finishResize);
                window.removeEventListener("pointercancel", finishResize);
                document.body.style.userSelect = originalUserSelect;
                document.body.style.cursor = originalCursor;
                setDraggingKey(null);
                cleanupRef.current = null;
            };

            const handlePointerMove = (moveEvent: PointerEvent) => {
                applyRatio(moveEvent.clientX, moveEvent.clientY);
            };

            cleanupRef.current?.();
            cleanupRef.current = finishResize;
            setDraggingKey(key);
            document.body.style.userSelect = "none";
            document.body.style.cursor = cursor;

            window.addEventListener("pointermove", handlePointerMove);
            window.addEventListener("pointerup", finishResize);
            window.addEventListener("pointercancel", finishResize);
        };
    }, []);

    return {
        layout,
        draggingKey,
        startResize,
    };
}
