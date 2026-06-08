import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import styles from "./FloatingScrollbar.module.css";
import "./FloatingScrollbar.scroll.css";

type FloatingScrollbarProps = {
    /** The native scroll container to mirror. Must be the child of a positioned wrapper that also contains this component. */
    targetRef: RefObject<HTMLElement | null>;
    /** Bump (e.g. selected series / welcome toggle) to force a metrics recompute when the content element swaps. */
    revision?: unknown;
    /** Selector (within target) of a sticky top element the vertical thumb should stay clear of, e.g. a sticky header. */
    topClearanceSelector?: string;
    /** Gap (px) kept at both ends of each track so the thumb never touches the corners. */
    edgeInset?: number;
};

const MIN_THUMB = 28;
const HIDE_DELAY_MS = 1000;
const DEFAULT_EDGE_INSET = 8;

/**
 * Whether the browser can drive the thumb position on the compositor via a
 * scroll-driven animation. When true the thumb stays glued to the scroll
 * position even if the main thread is busy (e.g. the data grid virtualizing);
 * when false we fall back to updating `transform` from the scroll event.
 */
const SUPPORTS_SCROLL_TIMELINE =
    typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("animation-timeline: scroll()");

/**
 * Lightweight floating overlay scrollbar for a natively-scrolled element.
 * Keeps native (composited) scrolling and only draws two thumbs; their size is
 * computed in JS on ResizeObserver ticks while their position follows scroll
 * (compositor-driven where supported — see above).
 */
export function FloatingScrollbar({
    targetRef,
    revision,
    topClearanceSelector,
    edgeInset = DEFAULT_EDGE_INSET,
}: FloatingScrollbarProps) {
    const rootRef = useRef<HTMLDivElement>(null);
    const vThumbRef = useRef<HTMLDivElement>(null);
    const hThumbRef = useRef<HTMLDivElement>(null);
    const hideTimerRef = useRef<number | null>(null);
    const metricsRef = useRef({
        vScrollable: 0,
        hScrollable: 0,
        maxThumbTop: 0,
        maxThumbLeft: 0,
        vEnabled: false,
        hEnabled: false,
    });

    const reveal = useCallback(() => {
        const root = rootRef.current;
        if (!root) {
            return;
        }
        root.classList.add(styles.visible);
        if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current);
        }
        hideTimerRef.current = window.setTimeout(() => {
            rootRef.current?.classList.remove(styles.visible);
            hideTimerRef.current = null;
        }, HIDE_DELAY_MS);
    }, []);

    // Fallback position update (only used when scroll-driven animations are unsupported).
    const updatePositions = useCallback(() => {
        if (SUPPORTS_SCROLL_TIMELINE) {
            return;
        }
        const target = targetRef.current;
        const vThumb = vThumbRef.current;
        const hThumb = hThumbRef.current;
        if (!target || !vThumb || !hThumb) {
            return;
        }
        const m = metricsRef.current;
        if (m.vEnabled) {
            const top = m.vScrollable > 0 ? (target.scrollTop / m.vScrollable) * m.maxThumbTop : 0;
            vThumb.style.transform = `translateY(${top}px)`;
        }
        if (m.hEnabled) {
            const left = m.hScrollable > 0 ? (target.scrollLeft / m.hScrollable) * m.maxThumbLeft : 0;
            hThumb.style.transform = `translateX(${left}px)`;
        }
    }, [targetRef]);

    const refreshMetrics = useCallback(() => {
        const target = targetRef.current;
        const vThumb = vThumbRef.current;
        const hThumb = hThumbRef.current;
        if (!target || !vThumb || !hThumb) {
            return;
        }
        const { scrollHeight, scrollWidth, clientHeight, clientWidth } = target;

        let topInset = edgeInset;
        if (topClearanceSelector) {
            const headerEl = target.querySelector<HTMLElement>(topClearanceSelector);
            if (headerEl) {
                topInset = Math.max(edgeInset, headerEl.getBoundingClientRect().height + 4);
            }
        }

        const vScrollable = scrollHeight - clientHeight;
        const vTrack = Math.max(0, clientHeight - topInset - edgeInset);
        const vEnabled = vScrollable > 1 && vTrack > MIN_THUMB;
        if (vEnabled) {
            const thumbH = Math.max(MIN_THUMB, Math.round((clientHeight / scrollHeight) * vTrack));
            const maxThumbTop = vTrack - thumbH;
            metricsRef.current.maxThumbTop = maxThumbTop;
            vThumb.style.top = `${topInset}px`;
            vThumb.style.height = `${thumbH}px`;
            vThumb.style.setProperty("--ft-vmax", `${maxThumbTop}px`);
            vThumb.style.display = "block";
        } else {
            vThumb.style.display = "none";
        }
        metricsRef.current.vScrollable = vScrollable;
        metricsRef.current.vEnabled = vEnabled;

        const hScrollable = scrollWidth - clientWidth;
        const hTrack = Math.max(0, clientWidth - edgeInset * 2);
        const hEnabled = hScrollable > 1 && hTrack > MIN_THUMB;
        if (hEnabled) {
            const thumbW = Math.max(MIN_THUMB, Math.round((clientWidth / scrollWidth) * hTrack));
            const maxThumbLeft = hTrack - thumbW;
            metricsRef.current.maxThumbLeft = maxThumbLeft;
            hThumb.style.left = `${edgeInset}px`;
            hThumb.style.width = `${thumbW}px`;
            hThumb.style.setProperty("--ft-hmax", `${maxThumbLeft}px`);
            hThumb.style.display = "block";
        } else {
            hThumb.style.display = "none";
        }
        metricsRef.current.hScrollable = hScrollable;
        metricsRef.current.hEnabled = hEnabled;

        updatePositions();
    }, [targetRef, topClearanceSelector, edgeInset, updatePositions]);

    // Hook up the compositor scroll timelines once (no-op where unsupported).
    useEffect(() => {
        const target = targetRef.current;
        const root = rootRef.current;
        if (!target || !root || !SUPPORTS_SCROLL_TIMELINE) {
            return;
        }
        const wrapper = target.parentElement;
        target.style.setProperty("scroll-timeline-name", "--ftScrollY, --ftScrollX");
        target.style.setProperty("scroll-timeline-axis", "block, inline");
        wrapper?.style.setProperty("timeline-scope", "--ftScrollY, --ftScrollX");
        root.dataset.ftComposited = "true";

        return () => {
            target.style.removeProperty("scroll-timeline-name");
            target.style.removeProperty("scroll-timeline-axis");
            wrapper?.style.removeProperty("timeline-scope");
            delete root.dataset.ftComposited;
        };
    }, [targetRef]);

    useEffect(() => {
        const target = targetRef.current;
        if (!target) {
            return;
        }

        refreshMetrics();

        const onScroll = () => {
            updatePositions();
            reveal();
        };

        target.addEventListener("scroll", onScroll, { passive: true });
        target.addEventListener("pointermove", reveal, { passive: true });

        const resizeObserver = new ResizeObserver(refreshMetrics);
        resizeObserver.observe(target);
        const content = target.firstElementChild;
        if (content) {
            resizeObserver.observe(content);
        }

        return () => {
            target.removeEventListener("scroll", onScroll);
            target.removeEventListener("pointermove", reveal);
            resizeObserver.disconnect();
            if (hideTimerRef.current !== null) {
                window.clearTimeout(hideTimerRef.current);
                hideTimerRef.current = null;
            }
        };
    }, [targetRef, revision, refreshMetrics, updatePositions, reveal]);

    const startVDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        const target = targetRef.current;
        if (!target) {
            return;
        }
        event.preventDefault();
        const thumb = event.currentTarget;
        const startY = event.clientY;
        const startScrollTop = target.scrollTop;
        thumb.setPointerCapture(event.pointerId);

        const onMove = (moveEvent: PointerEvent) => {
            const m = metricsRef.current;
            const ratio = m.maxThumbTop > 0 ? (moveEvent.clientY - startY) / m.maxThumbTop : 0;
            target.scrollTop = startScrollTop + ratio * m.vScrollable;
            updatePositions();
            reveal();
        };
        const onUp = (upEvent: PointerEvent) => {
            thumb.releasePointerCapture?.(upEvent.pointerId);
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }, [targetRef, updatePositions, reveal]);

    const startHDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        const target = targetRef.current;
        if (!target) {
            return;
        }
        event.preventDefault();
        const thumb = event.currentTarget;
        const startX = event.clientX;
        const startScrollLeft = target.scrollLeft;
        thumb.setPointerCapture(event.pointerId);

        const onMove = (moveEvent: PointerEvent) => {
            const m = metricsRef.current;
            const ratio = m.maxThumbLeft > 0 ? (moveEvent.clientX - startX) / m.maxThumbLeft : 0;
            target.scrollLeft = startScrollLeft + ratio * m.hScrollable;
            updatePositions();
            reveal();
        };
        const onUp = (upEvent: PointerEvent) => {
            thumb.releasePointerCapture?.(upEvent.pointerId);
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }, [targetRef, updatePositions, reveal]);

    return (
        <div ref={rootRef} className={styles.root} aria-hidden="true">
            <div ref={vThumbRef} className={styles.vThumb} data-ft-thumb="v" onPointerDown={startVDrag} />
            <div ref={hThumbRef} className={styles.hThumb} data-ft-thumb="h" onPointerDown={startHDrag} />
        </div>
    );
}
