import { memo, useEffect, useMemo, useRef, useState } from "react";
import type {
    MouseEvent as ReactMouseEvent,
    PointerEvent as ReactPointerEvent,
} from "react";
import {
    buildTreeRingScanYearPositions,
    getTreeRingScanBandCenterYRatio,
    getTreeRingScanXRatioForOriginalYear,
    rotatedTreeRingScanSize,
    resolveTreeRingScanOriginalYearAtX,
    type TreeRingScanFile,
    type TreeRingScanSeriesState,
    type TreeRingYearMapping,
} from "@/features/treeRingScans";
import type { TreeRingViewerAnchor } from "./TreeRingPreview";
import {
    getTreeRingScanHeaderPixelRatio,
    getTreeRingScanMaximumZoom,
    getTreeRingScanPreviewViewSize,
    shouldSmoothTreeRingScanImage,
    TREE_RING_SCAN_MIN_ZOOM,
} from "./scanDetailRendering";
import { useTreeRingScanImage } from "./useTreeRingScanImage";
import styles from "./TreeRingScanPreview.module.css";
import { isPanelResizeActive, PANEL_RESIZE_END_EVENT } from "@/shared/panelResize";

interface TreeRingScanPreviewProps {
    seriesId: string;
    file: TreeRingScanFile;
    scanState: TreeRingScanSeriesState;
    yearMapping: TreeRingYearMapping;
    highlightedYear?: number;
    focusRequestId?: number;
    onYearSelect: (seriesId: string, year: number) => void;
    onOpen: (seriesId: string, anchor: TreeRingViewerAnchor) => void;
    onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

interface PreviewPanGesture {
    pointerId: number;
    startClientX: number;
    viewportPixels: number;
    startX: number;
    moved: boolean;
}

interface HoveredYear {
    originalYear: number;
    currentYear: number | null;
    left: number;
}

const clamp = (value: number, minimum: number, maximum: number) => (
    Math.min(maximum, Math.max(minimum, value))
);

function TreeRingScanPreviewComponent({
    seriesId,
    file,
    scanState,
    yearMapping,
    highlightedYear,
    focusRequestId,
    onYearSelect,
    onOpen,
    onContextMenu,
}: TreeRingScanPreviewProps) {
    const image = useTreeRingScanImage(file, scanState.crop);
    const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
    const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
    const [zoom, setZoom] = useState(TREE_RING_SCAN_MIN_ZOOM);
    const [startX, setStartX] = useState(0);
    const [hoveredYear, setHoveredYear] = useState<HoveredYear | null>(null);
    const [isPanning, setIsPanning] = useState(false);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const sourceImageRef = useRef<HTMLImageElement | null>(null);
    const panGestureRef = useRef<PreviewPanGesture | null>(null);
    const suppressClickRef = useRef(false);
    const handledFocusRequestIdRef = useRef<number | undefined>(undefined);
    const positions = useMemo(() => buildTreeRingScanYearPositions(scanState), [scanState]);
    const rotation = scanState.rotation ?? 0;
    const unrotatedDisplaySize = useMemo(() => {
        if (!scanState.crop || image.cropApplied) return naturalSize;
        return {
            width: naturalSize.width * scanState.crop.widthRatio,
            height: naturalSize.height * scanState.crop.heightRatio,
        };
    }, [image.cropApplied, naturalSize, scanState.crop]);
    const displaySize = useMemo(() => rotatedTreeRingScanSize(
        unrotatedDisplaySize.width,
        unrotatedDisplaySize.height,
        rotation,
    ), [rotation, unrotatedDisplaySize]);
    const pixelRatio = getTreeRingScanHeaderPixelRatio(
        typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
    );
    const maximumZoom = getTreeRingScanMaximumZoom(
        displaySize.width,
        displaySize.height,
        Math.max(1, previewSize.width),
        Math.max(1, previewSize.height),
        pixelRatio,
    );

    const previewView = getTreeRingScanPreviewViewSize(
        displaySize.width,
        displaySize.height,
        zoom,
        previewSize.width,
        previewSize.height,
    );
    const { aspect, width: viewWidth, height: viewHeight } = previewView;
    const centreY = getTreeRingScanBandCenterYRatio(scanState) * displaySize.height;
    const viewTop = clamp(
        centreY - viewHeight / 2,
        0,
        Math.max(0, displaySize.height - viewHeight),
    );
    const maximumStartX = Math.max(0, displaySize.width - viewWidth);
    const clampedStartX = clamp(startX, 0, maximumStartX);

    useEffect(() => {
        setZoom(TREE_RING_SCAN_MIN_ZOOM);
        setStartX(0);
        setHoveredYear(null);
    }, [file.path]);

    useEffect(() => {
        const target = canvasRef.current ?? buttonRef.current;
        if (!target) return;
        let deferred = false;
        const measure = () => {
            if (isPanelResizeActive()) {
                deferred = true;
                return;
            }
            const rect = target.getBoundingClientRect();
            setPreviewSize((current) => (
                current.width === rect.width && current.height === rect.height
                    ? current
                    : { width: rect.width, height: rect.height }
            ));
        };
        const measureAfterPanelResize = () => {
            if (!deferred) return;
            deferred = false;
            measure();
        };
        measure();
        window.addEventListener(PANEL_RESIZE_END_EVENT, measureAfterPanelResize);
        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", measure);
            return () => {
                window.removeEventListener("resize", measure);
                window.removeEventListener(PANEL_RESIZE_END_EVENT, measureAfterPanelResize);
            };
        }
        const observer = new ResizeObserver(measure);
        observer.observe(target);
        return () => {
            observer.disconnect();
            window.removeEventListener(PANEL_RESIZE_END_EVENT, measureAfterPanelResize);
        };
    }, [image.url]);

    useEffect(() => {
        setNaturalSize({ width: 0, height: 0 });
        sourceImageRef.current = null;
        if (!image.url) return () => undefined;
        let active = true;
        const source = new Image();
        source.decoding = "async";
        source.onload = () => {
            if (!active) return;
            sourceImageRef.current = source;
            setNaturalSize({ width: source.naturalWidth, height: source.naturalHeight });
        };
        source.src = image.url;
        return () => {
            active = false;
            if (sourceImageRef.current === source) sourceImageRef.current = null;
        };
    }, [image.url]);

    useEffect(() => {
        setZoom((current) => clamp(current, TREE_RING_SCAN_MIN_ZOOM, maximumZoom));
    }, [maximumZoom]);

    useEffect(() => {
        const canvas = canvasRef.current;
        const source = sourceImageRef.current;
        if (
            !canvas
            || !source
            || !(naturalSize.width > 0)
            || !(naturalSize.height > 0)
            || !(previewSize.width > 0)
            || !(previewSize.height > 0)
            || !(viewWidth > 0)
            || !(viewHeight > 0)
        ) return;

        const pixelWidth = Math.max(1, Math.round(previewSize.width * pixelRatio));
        const pixelHeight = Math.max(1, Math.round(previewSize.height * pixelRatio));
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) return;

        const sourceX = scanState.crop && !image.cropApplied
            ? scanState.crop.xRatio * naturalSize.width
            : 0;
        const sourceY = scanState.crop && !image.cropApplied
            ? scanState.crop.yRatio * naturalSize.height
            : 0;
        const sourceWidth = scanState.crop && !image.cropApplied
            ? scanState.crop.widthRatio * naturalSize.width
            : naturalSize.width;
        const sourceHeight = scanState.crop && !image.cropApplied
            ? scanState.crop.heightRatio * naturalSize.height
            : naturalSize.height;
        const uniformScale = previewSize.width / viewWidth;

        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, previewSize.width, previewSize.height);
        context.imageSmoothingEnabled = shouldSmoothTreeRingScanImage(
            sourceWidth,
            sourceHeight,
            unrotatedDisplaySize.width * uniformScale,
            unrotatedDisplaySize.height * uniformScale,
            pixelRatio,
        );
        if (context.imageSmoothingEnabled) context.imageSmoothingQuality = "high";

        context.save();
        context.beginPath();
        context.rect(0, 0, previewSize.width, previewSize.height);
        context.clip();
        context.scale(uniformScale, uniformScale);
        context.translate(-clampedStartX, -viewTop);
        if (rotation === 90) {
            context.translate(displaySize.width, 0);
            context.rotate(Math.PI / 2);
        } else if (rotation === 180) {
            context.translate(displaySize.width, displaySize.height);
            context.rotate(Math.PI);
        } else if (rotation === 270) {
            context.translate(0, displaySize.height);
            context.rotate(-Math.PI / 2);
        }
        context.drawImage(
            source,
            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight,
            0,
            0,
            unrotatedDisplaySize.width,
            unrotatedDisplaySize.height,
        );
        context.restore();
    }, [
        clampedStartX,
        displaySize.height,
        displaySize.width,
        image.cropApplied,
        image.url,
        naturalSize.height,
        naturalSize.width,
        pixelRatio,
        previewSize.height,
        previewSize.width,
        rotation,
        scanState.crop,
        unrotatedDisplaySize.height,
        unrotatedDisplaySize.width,
        viewHeight,
        viewTop,
        viewWidth,
    ]);

    useEffect(() => {
        if (
            focusRequestId === undefined
            || handledFocusRequestIdRef.current === focusRequestId
            || highlightedYear === undefined
            || !yearMapping.valid
            || displaySize.width <= 0
        ) return;
        const originalYear = yearMapping.originalByCurrent.get(highlightedYear);
        if (originalYear === undefined) return;
        const xRatio = getTreeRingScanXRatioForOriginalYear(scanState, originalYear);
        if (xRatio === null) return;
        handledFocusRequestIdRef.current = focusRequestId;
        const targetX = xRatio * displaySize.width;
        setStartX(clamp(targetX - viewWidth / 2, 0, maximumStartX));
    }, [displaySize.width, focusRequestId, highlightedYear, maximumStartX, scanState, viewWidth, yearMapping]);

    useEffect(() => {
        const button = buttonRef.current;
        if (!button || displaySize.width <= 0) return;
        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setHoveredYear(null);
            const rect = button.getBoundingClientRect();
            const cursorRatio = rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0.5;
            const nextZoom = clamp(
                zoom * Math.exp(-event.deltaY * 0.0022),
                TREE_RING_SCAN_MIN_ZOOM,
                maximumZoom,
            );
            const nextRequestedWidth = displaySize.width / nextZoom;
            const nextViewWidth = Math.min(nextRequestedWidth, displaySize.height * aspect);
            const imageX = clampedStartX + cursorRatio * viewWidth;
            setZoom(nextZoom);
            setStartX(clamp(imageX - cursorRatio * nextViewWidth, 0, Math.max(0, displaySize.width - nextViewWidth)));
        };
        button.addEventListener("wheel", handleWheel, { passive: false, capture: true });
        return () => button.removeEventListener("wheel", handleWheel, { capture: true });
    }, [aspect, clampedStartX, displaySize.height, displaySize.width, maximumZoom, viewWidth, zoom]);

    const resolveAtClientX = (clientX: number, element: HTMLButtonElement) => {
        const rect = element.getBoundingClientRect();
        if (!(rect.width > 0) || !(displaySize.width > 0)) return null;
        const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
        const imageXRatio = (clampedStartX + ratio * viewWidth) / displaySize.width;
        const originalYear = resolveTreeRingScanOriginalYearAtX(positions, imageXRatio);
        if (originalYear === null) return null;
        return {
            originalYear,
            currentYear: yearMapping.currentByOriginal.get(originalYear) ?? null,
            left: clamp(clientX - rect.left, 22, rect.width - 22),
        };
    };

    const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        panGestureRef.current = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            viewportPixels: rect.width,
            startX: clampedStartX,
            moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const gesture = panGestureRef.current;
        if (!gesture) {
            setHoveredYear(resolveAtClientX(event.clientX, event.currentTarget));
            return;
        }
        if (gesture.pointerId !== event.pointerId || zoom <= TREE_RING_SCAN_MIN_ZOOM) return;
        const delta = event.clientX - gesture.startClientX;
        if (!gesture.moved && Math.abs(delta) >= 3) {
            gesture.moved = true;
            setIsPanning(true);
            setHoveredYear(null);
        }
        if (!gesture.moved) return;
        const deltaImage = gesture.viewportPixels > 0 ? delta / gesture.viewportPixels * viewWidth : 0;
        setStartX(clamp(gesture.startX - deltaImage, 0, maximumStartX));
    };

    const finishPointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const gesture = panGestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        panGestureRef.current = null;
        setIsPanning(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (gesture.moved) {
            suppressClickRef.current = true;
            window.setTimeout(() => { suppressClickRef.current = false; }, 0);
        }
    };

    if (image.loading) return <span className={styles.status}>加载扫描影像…</span>;
    if (image.error || !image.url) {
        return <span className={styles.error} title={image.error ?? undefined}>扫描影像不可用</span>;
    }

    const selectedOriginalYear = highlightedYear === undefined
        ? undefined
        : yearMapping.originalByCurrent.get(highlightedYear);
    const selectedXRatio = selectedOriginalYear === undefined
        ? null
        : getTreeRingScanXRatioForOriginalYear(scanState, selectedOriginalYear);
    const selectedScreenX = selectedXRatio === null || !(previewSize.width > 0)
        ? null
        : (selectedXRatio * displaySize.width - clampedStartX) / viewWidth * previewSize.width;

    return (
        <div className={styles.previewShell}>
            <button
                ref={buttonRef}
                type="button"
                className={`${styles.previewButton}${zoom > TREE_RING_SCAN_MIN_ZOOM ? ` ${styles.zoomed}` : ""}${isPanning ? ` ${styles.panning}` : ""}`}
                title="扫描样芯截面 · 滚轮缩放，拖动平移，单击跳转，双击打开扫描视图"
                onContextMenu={onContextMenu}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPointer}
                onPointerCancel={finishPointer}
                onPointerLeave={() => setHoveredYear(null)}
                onClick={(event) => {
                    event.stopPropagation();
                    if (event.detail > 1 || suppressClickRef.current) return;
                    const resolved = resolveAtClientX(event.clientX, event.currentTarget);
                    if (resolved?.currentYear !== null && resolved?.currentYear !== undefined) {
                        onYearSelect(seriesId, resolved.currentYear);
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
                <canvas
                    ref={canvasRef}
                    className={styles.previewCanvas}
                    data-panel-resize-heavy-preview="true"
                    role="img"
                    aria-label={`${seriesId} 的扫描影像 1 cm 窗口`}
                />
                {selectedScreenX !== null && selectedScreenX >= 0 && selectedScreenX <= previewSize.width ? (
                    <span className={styles.selectedLine} style={{ left: `${selectedScreenX}px` }} />
                ) : null}
                {zoom > TREE_RING_SCAN_MIN_ZOOM ? <span className={styles.zoomBadge}>×{zoom.toFixed(1)}</span> : null}
                <span className={styles.scanBadge}>扫描</span>
            </button>
            {hoveredYear ? (
                <span className={styles.hoverYear} style={{ left: `${hoveredYear.left}px` }}>
                    {hoveredYear.currentYear === hoveredYear.originalYear ? (
                        `${hoveredYear.originalYear} 年`
                    ) : (
                        <>
                            原 {hoveredYear.originalYear} 年<br />
                            现 {hoveredYear.currentYear === null ? "已删除" : `${hoveredYear.currentYear} 年`}
                        </>
                    )}
                </span>
            ) : null}
        </div>
    );
}

export const TreeRingScanPreview = memo(TreeRingScanPreviewComponent);
