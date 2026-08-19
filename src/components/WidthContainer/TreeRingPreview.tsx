import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { RwlTreeData } from "@/features/rwl";
import {
    getTreeRingArtwork,
    getTreeRingFeature,
    getTreeRingFeatureAtRadius,
    type TreeRingFeature,
} from "./treeRingArtwork";
import { TreeRingSvgOverlay } from "./TreeRingSvgOverlay";
import {
    focusTreeRingViewport,
    getTreeRingPreviewViewHeight,
    getTreeRingViewportWidth,
    panTreeRingViewport,
    TREE_RING_MIN_ZOOM,
    type TreeRingViewport,
    zoomTreeRingViewport,
} from "./treeRingViewport";
import styles from "./TreeRingPreview.module.css";

export interface TreeRingViewerAnchor {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
}

export interface TreeRingViewerRequest {
    id: number;
    seriesId: string;
    anchor: TreeRingViewerAnchor;
    initialView: TreeRingViewerDisplayMode;
}

export type TreeRingViewerDisplayMode = "full" | "strip" | "scan";

interface TreeRingPreviewProps {
    seriesId: string;
    series: RwlTreeData;
    stopMarkerValue: number;
    highlightedYear?: number;
    focusRequestId?: number;
    onYearSelect: (seriesId: string, year: number) => void;
    onOpen: (seriesId: string, anchor: TreeRingViewerAnchor) => void;
    onContextMenu?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

interface PreviewPanGesture {
    pointerId: number;
    startClientX: number;
    viewportPixels: number;
    startViewport: TreeRingViewport;
    moved: boolean;
}

interface HoveredTreeRingYear {
    label: string;
    left: number;
}

function TreeRingPreviewComponent({
    seriesId,
    series,
    stopMarkerValue,
    highlightedYear,
    focusRequestId,
    onYearSelect,
    onOpen,
    onContextMenu,
}: TreeRingPreviewProps) {
    const artwork = useMemo(
        () => getTreeRingArtwork(series, stopMarkerValue, false),
        [series, stopMarkerValue],
    );
    const radiusMm = artwork?.radiusMm ?? 1;
    const [viewport, setViewport] = useState<TreeRingViewport>({
        zoom: TREE_RING_MIN_ZOOM,
        startX: radiusMm,
    });
    const [isPanning, setIsPanning] = useState(false);
    const [hoveredYear, setHoveredYear] = useState<HoveredTreeRingYear | null>(null);
    const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const svgRef = useRef<SVGSVGElement | null>(null);
    const panGestureRef = useRef<PreviewPanGesture | null>(null);
    const suppressClickRef = useRef(false);
    const handledFocusRequestIdRef = useRef<number | undefined>(undefined);

    useEffect(() => {
        setViewport({ zoom: TREE_RING_MIN_ZOOM, startX: radiusMm });
    }, [artwork?.cacheKey, radiusMm]);

    useEffect(() => {
        if (
            focusRequestId === undefined
            || handledFocusRequestIdRef.current === focusRequestId
            || !artwork
            || highlightedYear === undefined
        ) return;
        const feature = getTreeRingFeature(artwork.geometry, highlightedYear);
        if (!feature) return;
        handledFocusRequestIdRef.current = focusRequestId;
        setViewport((current) => focusTreeRingViewport(
            current,
            artwork.radiusMm,
            feature.centreRadiusMm,
        ));
    }, [artwork, focusRequestId, highlightedYear]);

    // React can delegate wheel events through a passive listener. A native,
    // non-passive capture listener guarantees that zooming never scrolls the workspace.
    useEffect(() => {
        const button = buttonRef.current;
        if (!button || !artwork) return;

        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setHoveredYear(null);
            const rect = button.getBoundingClientRect();
            const cursorRatio = rect.width > 0
                ? (event.clientX - rect.left) / rect.width
                : 0.5;
            setViewport((current) => zoomTreeRingViewport(
                current,
                artwork.geometry.radiusMm,
                cursorRatio,
                event.deltaY,
            ));
        };

        button.addEventListener("wheel", handleWheel, { passive: false, capture: true });
        return () => button.removeEventListener("wheel", handleWheel, { capture: true });
    }, [artwork]);

    useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return;

        const measure = () => {
            const rect = svg.getBoundingClientRect();
            setPreviewSize((current) => (
                current.width === rect.width && current.height === rect.height
                    ? current
                    : { width: rect.width, height: rect.height }
            ));
        };
        measure();
        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", measure);
            return () => window.removeEventListener("resize", measure);
        }
        const observer = new ResizeObserver(measure);
        observer.observe(svg);
        return () => observer.disconnect();
    }, [artwork?.cacheKey]);

    if (!artwork) {
        return <span className={styles.unavailable} title="该序列没有可绘制的正宽度年轮">无截面</span>;
    }

    const geometry = artwork.geometry;
    const viewWidth = getTreeRingViewportWidth(geometry.radiusMm, viewport.zoom);
    const viewHeight = getTreeRingPreviewViewHeight(
        viewWidth,
        geometry.diameterMm,
        previewSize.width,
        previewSize.height,
        geometry.windowHeightMm,
    );
    const viewTop = geometry.radiusMm - viewHeight / 2;
    const gapYearCount = geometry.gaps.reduce((sum, gap) => sum + gap.yearCount, 0);
    const title = `1 cm 树轮窗口 · ${artwork.ringCount} 个年轮 · 半径 ${artwork.radiusMm.toFixed(3)} mm`
        + `${gapYearCount > 0 ? ` · 中间缺少 ${gapYearCount} 年记录` : ""}`
        + "（滚轮缩放，放大后左右拖动，单击选择年份，双击打开 1 cm 视图）";

    const resolveFeatureAtClientX = (
        clientX: number,
        element: HTMLButtonElement,
    ): { feature: TreeRingFeature; left: number } | null => {
        const rect = element.getBoundingClientRect();
        if (!(rect.width > 0)) return null;
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        const radialCoordinate = viewport.startX + ratio * viewWidth - geometry.radiusMm;
        const markerToleranceMm = viewWidth / rect.width * 5;
        const feature = getTreeRingFeatureAtRadius(
            geometry,
            radialCoordinate,
            markerToleranceMm,
        );
        return feature ? {
            feature,
            left: Math.min(rect.width - 18, Math.max(18, clientX - rect.left)),
        } : null;
    };

    const showHoveredYear = (clientX: number, element: HTMLButtonElement) => {
        const resolved = resolveFeatureAtClientX(clientX, element);
        if (!resolved) {
            setHoveredYear(null);
            return;
        }
        const { feature, left } = resolved;
        setHoveredYear({
            left,
            label: feature.kind === "gap"
                ? `${feature.startYear === feature.endYear ? feature.startYear : `${feature.startYear}–${feature.endYear}`} 缺`
                : String(feature.startYear),
        });
    };

    const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        panGestureRef.current = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            viewportPixels: rect.width,
            startViewport: viewport,
            moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const gesture = panGestureRef.current;
        if (!gesture) {
            showHoveredYear(event.clientX, event.currentTarget);
            return;
        }
        if (gesture.pointerId !== event.pointerId || gesture.startViewport.zoom <= TREE_RING_MIN_ZOOM) {
            return;
        }
        event.stopPropagation();
        const deltaPixels = event.clientX - gesture.startClientX;
        if (!gesture.moved && Math.abs(deltaPixels) >= 3) {
            gesture.moved = true;
            setIsPanning(true);
            setHoveredYear(null);
        }
        if (!gesture.moved) return;
        setViewport(panTreeRingViewport(
            gesture.startViewport,
            geometry.radiusMm,
            deltaPixels,
            gesture.viewportPixels,
        ));
    };

    const finishPointerGesture = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const gesture = panGestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        event.stopPropagation();
        panGestureRef.current = null;
        setIsPanning(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (gesture.moved) {
            suppressClickRef.current = true;
            window.setTimeout(() => {
                suppressClickRef.current = false;
            }, 0);
        }
    };

    return (
        <div className={styles.previewShell}>
            <button
                ref={buttonRef}
                type="button"
                className={`${styles.previewButton}${viewport.zoom > TREE_RING_MIN_ZOOM ? ` ${styles.zoomed}` : ""}${isPanning ? ` ${styles.panning}` : ""}`}
                title={title}
                aria-label={`${seriesId} 的 1 cm 树轮窗口；可滚轮缩放和左右拖动，单击选择年份，双击打开 1 cm 视图`}
                onContextMenu={onContextMenu}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPointerGesture}
                onPointerCancel={finishPointerGesture}
                onPointerLeave={() => setHoveredYear(null)}
                onClick={(event) => {
                    event.stopPropagation();
                    if (event.detail > 1) return;
                    if (suppressClickRef.current) {
                        event.preventDefault();
                        suppressClickRef.current = false;
                        return;
                    }
                    const resolved = resolveFeatureAtClientX(event.clientX, event.currentTarget);
                    if (resolved) {
                        onYearSelect(seriesId, resolved.feature.startYear);
                    }
                }}
                onDoubleClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    onOpen(seriesId, {
                        left: rect.left,
                        right: rect.right,
                        top: rect.top,
                        bottom: rect.bottom,
                        width: rect.width,
                        height: rect.height,
                    });
                }}
            >
                <svg
                    ref={svgRef}
                    className={styles.previewSvg}
                    viewBox={`${viewport.startX} ${viewTop} ${viewWidth} ${viewHeight}`}
                    preserveAspectRatio="xMidYMid meet"
                    overflow="hidden"
                    role="img"
                    aria-label={`${seriesId} 从树心到三点钟方向的树轮窗口`}
                >
                    <image
                        href={artwork.previewUrl}
                        x={0}
                        y={0}
                        width={geometry.diameterMm}
                        height={geometry.diameterMm}
                        preserveAspectRatio="xMidYMid meet"
                    />
                    <TreeRingSvgOverlay geometry={geometry} highlightedYear={highlightedYear} />
                </svg>
                {viewport.zoom > TREE_RING_MIN_ZOOM ? (
                    <span className={styles.zoomBadge} aria-hidden="true">×{viewport.zoom.toFixed(1)}</span>
                ) : null}
            </button>
            {hoveredYear ? (
                <span
                    className={styles.hoverYear}
                    style={{ left: `${hoveredYear.left}px` }}
                    aria-hidden="true"
                >
                    {hoveredYear.label}
                </span>
            ) : null}
        </div>
    );
}

export const TreeRingPreview = memo(TreeRingPreviewComponent);
