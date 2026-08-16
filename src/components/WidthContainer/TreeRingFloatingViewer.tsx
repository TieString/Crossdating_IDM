import { useEffect, useMemo, useRef, useState } from "react";
import type {
    KeyboardEvent as ReactKeyboardEvent,
    PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { RwlTreeData } from "@/features/rwl";
import type { RwlOperationLogEntry } from "@/features/rwl/edit";
import type {
    TreeRingImageMode,
    TreeRingScanFile,
    TreeRingScanSeriesState,
    TreeRingYearMapping,
} from "@/features/treeRingScans";
import type { TreeRingViewerAnchor } from "./TreeRingPreview";
import {
    getTreeRingFullViewSize,
    panTreeRingFullViewport,
    TREE_RING_FULL_MIN_ZOOM,
    type TreeRingFullViewport,
    zoomTreeRingFullViewport,
} from "./treeRingFullViewport";
import { getTreeRingArtwork } from "./treeRingArtwork";
import { TreeRingSvgOverlay } from "./TreeRingSvgOverlay";
import { TreeRingScanViewer } from "./TreeRingScanViewer";
import styles from "./TreeRingFloatingViewer.module.css";

interface Point {
    x: number;
    y: number;
}

interface WindowDragState {
    pointerId: number;
    offsetX: number;
    offsetY: number;
}

interface ImagePanState {
    pointerId: number;
    startClientX: number;
    startClientY: number;
    viewportPixels: number;
    startViewport: TreeRingFullViewport;
}

interface ResizeState {
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startSize: number;
    maximumSize: number;
}

interface TreeRingFloatingViewerProps {
    seriesId: string;
    series: RwlTreeData;
    stopMarkerValue: number;
    highlightedYear?: number;
    anchor: TreeRingViewerAnchor;
    initialMode?: TreeRingImageMode;
    scanFile?: TreeRingScanFile;
    scanState?: TreeRingScanSeriesState;
    operationLog?: readonly RwlOperationLogEntry[];
    yearMapping?: TreeRingYearMapping;
    onScanStateChange?: (state: TreeRingScanSeriesState) => void;
    onClose: () => void;
}

const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 12;
const TITLE_HEIGHT = 36;
const MIN_IMAGE_SIZE = 180;
const INITIAL_MAX_IMAGE_SIZE = 620;

const clamp = (value: number, minimum: number, maximum: number) => (
    Math.min(maximum, Math.max(minimum, value))
);

function getMaximumImageSize(position?: Point): number {
    if (typeof window === "undefined") return INITIAL_MAX_IMAGE_SIZE;
    const availableWidth = position
        ? window.innerWidth - position.x - VIEWPORT_MARGIN
        : window.innerWidth - VIEWPORT_MARGIN * 2;
    const availableHeight = position
        ? window.innerHeight - position.y - TITLE_HEIGHT - VIEWPORT_MARGIN
        : window.innerHeight - TITLE_HEIGHT - VIEWPORT_MARGIN * 2;
    return Math.max(80, Math.min(availableWidth, availableHeight));
}

function clampTreeRingViewerImageSize(imageSize: number, position?: Point): number {
    const maximumSize = getMaximumImageSize(position);
    const minimumSize = Math.min(MIN_IMAGE_SIZE, maximumSize);
    return Math.round(clamp(imageSize, minimumSize, maximumSize));
}

function calculateImageSize(anchor: TreeRingViewerAnchor, minimumRightSize = 120): number {
    if (typeof window === "undefined") return 420;
    const preferredSize = Math.max(120, Math.min(
        INITIAL_MAX_IMAGE_SIZE,
        window.innerWidth * 0.42,
        getMaximumImageSize(),
    ));
    const availableOnRight = window.innerWidth - anchor.right - ANCHOR_GAP - VIEWPORT_MARGIN;
    return clampTreeRingViewerImageSize(
        availableOnRight >= minimumRightSize ? Math.min(preferredSize, availableOnRight) : preferredSize,
    );
}

export function clampTreeRingViewerPosition(position: Point, imageSize: number): Point {
    if (typeof window === "undefined") return position;
    const panelWidth = imageSize;
    const panelHeight = imageSize + TITLE_HEIGHT;
    return {
        x: Math.min(
            Math.max(VIEWPORT_MARGIN, position.x),
            Math.max(VIEWPORT_MARGIN, window.innerWidth - panelWidth - VIEWPORT_MARGIN),
        ),
        y: Math.min(
            Math.max(VIEWPORT_MARGIN, position.y),
            Math.max(VIEWPORT_MARGIN, window.innerHeight - panelHeight - VIEWPORT_MARGIN),
        ),
    };
}

function getInitialPosition(anchor: TreeRingViewerAnchor, imageSize: number): Point {
    const panelHeight = imageSize + TITLE_HEIGHT;
    return clampTreeRingViewerPosition({
        x: anchor.right + ANCHOR_GAP,
        y: anchor.top + anchor.height / 2 - panelHeight / 2,
    }, imageSize);
}

export function TreeRingFloatingViewer({
    seriesId,
    series,
    stopMarkerValue,
    highlightedYear,
    anchor,
    initialMode = "generated",
    scanFile,
    scanState,
    operationLog = [],
    yearMapping,
    onScanStateChange,
    onClose,
}: TreeRingFloatingViewerProps) {
    const artwork = useMemo(
        () => getTreeRingArtwork(series, stopMarkerValue, true),
        [series, stopMarkerValue],
    );
    const initialImageSize = calculateImageSize(anchor, initialMode === "scan" ? 360 : 120);
    const [imageSize, setImageSize] = useState(initialImageSize);
    const [position, setPosition] = useState(() => getInitialPosition(anchor, initialImageSize));
    const [imageViewport, setImageViewport] = useState<TreeRingFullViewport>({
        zoom: TREE_RING_FULL_MIN_ZOOM,
        startX: 0,
        startY: 0,
    });
    const [viewerMode, setViewerMode] = useState<TreeRingImageMode>(
        initialMode === "scan" && scanFile ? "scan" : "generated",
    );
    const [isWindowDragging, setIsWindowDragging] = useState(false);
    const [isImagePanning, setIsImagePanning] = useState(false);
    const [isResizing, setIsResizing] = useState(false);
    const previousScanCropRef = useRef(scanState?.crop);
    const imageSizeRef = useRef(imageSize);
    const imageFrameRef = useRef<HTMLDivElement | null>(null);
    const windowDragRef = useRef<WindowDragState | null>(null);
    const imagePanRef = useRef<ImagePanState | null>(null);
    const resizeRef = useRef<ResizeState | null>(null);

    useEffect(() => {
        imageSizeRef.current = imageSize;
    }, [imageSize]);

    useEffect(() => {
        const previousCrop = previousScanCropRef.current;
        previousScanCropRef.current = scanState?.crop;
        const cropWasJustSelected = !previousCrop && Boolean(scanState?.crop);
        if (!cropWasJustSelected || viewerMode !== "scan" || imageSizeRef.current >= 360) return;
        const nextSize = clampTreeRingViewerImageSize(420);
        imageSizeRef.current = nextSize;
        setImageSize(nextSize);
        setPosition((current) => clampTreeRingViewerPosition(current, nextSize));
    }, [scanState?.crop, viewerMode]);

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            const drag = windowDragRef.current;
            if (drag?.pointerId === event.pointerId) {
                event.preventDefault();
                event.stopPropagation();
                setPosition(clampTreeRingViewerPosition({
                    x: event.clientX - drag.offsetX,
                    y: event.clientY - drag.offsetY,
                }, imageSizeRef.current));
                return;
            }

            const resize = resizeRef.current;
            if (resize?.pointerId !== event.pointerId) return;
            event.preventDefault();
            event.stopPropagation();
            const deltaX = event.clientX - resize.startClientX;
            const deltaY = event.clientY - resize.startClientY;
            const delta = Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY;
            const minimumSize = Math.min(MIN_IMAGE_SIZE, resize.maximumSize);
            const nextSize = Math.round(clamp(
                resize.startSize + delta,
                minimumSize,
                resize.maximumSize,
            ));
            imageSizeRef.current = nextSize;
            setImageSize(nextSize);
        };
        const finishGestures = () => {
            windowDragRef.current = null;
            imagePanRef.current = null;
            resizeRef.current = null;
            setIsWindowDragging(false);
            setIsImagePanning(false);
            setIsResizing(false);
        };
        window.addEventListener("pointermove", handlePointerMove, { passive: false, capture: true });
        window.addEventListener("pointerup", finishGestures, { capture: true });
        window.addEventListener("pointercancel", finishGestures, { capture: true });
        return () => {
            window.removeEventListener("pointermove", handlePointerMove, { capture: true });
            window.removeEventListener("pointerup", finishGestures, { capture: true });
            window.removeEventListener("pointercancel", finishGestures, { capture: true });
        };
    }, []);

    useEffect(() => {
        setImageViewport({ zoom: TREE_RING_FULL_MIN_ZOOM, startX: 0, startY: 0 });
    }, [artwork?.cacheKey]);

    useEffect(() => {
        const handleResize = () => {
            const nextSize = clampTreeRingViewerImageSize(imageSizeRef.current);
            imageSizeRef.current = nextSize;
            setImageSize(nextSize);
            setPosition((current) => clampTreeRingViewerPosition(current, nextSize));
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("resize", handleResize);
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("resize", handleResize);
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [onClose]);

    useEffect(() => {
        const frame = imageFrameRef.current;
        if (!frame || !artwork || viewerMode !== "generated") return;
        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = frame.getBoundingClientRect();
            const cursorXRatio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
            const cursorYRatio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
            setImageViewport((current) => zoomTreeRingFullViewport(
                current,
                artwork.geometry.diameterMm,
                cursorXRatio,
                cursorYRatio,
                event.deltaY,
            ));
        };
        frame.addEventListener("wheel", handleWheel, { passive: false, capture: true });
        return () => frame.removeEventListener("wheel", handleWheel, { capture: true });
    }, [artwork, viewerMode]);

    if (!artwork?.fullUrl || typeof document === "undefined") {
        return null;
    }

    const diameterMm = artwork.geometry.diameterMm;
    const viewSizeMm = getTreeRingFullViewSize(diameterMm, imageViewport.zoom);

    const updateImageSize = (nextSize: number) => {
        const clampedSize = clampTreeRingViewerImageSize(nextSize, position);
        imageSizeRef.current = clampedSize;
        setImageSize(clampedSize);
        setPosition((current) => clampTreeRingViewerPosition(current, clampedSize));
    };

    const showScanViewer = () => {
        if (!scanFile) return;
        if (imageSize < 360) {
            const nextSize = clampTreeRingViewerImageSize(420);
            imageSizeRef.current = nextSize;
            setImageSize(nextSize);
            setPosition(getInitialPosition(anchor, nextSize));
        }
        setViewerMode("scan");
    };

    const handleWindowDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        event.stopPropagation();
        event.preventDefault();
        windowDragRef.current = {
            pointerId: event.pointerId,
            offsetX: event.clientX - position.x,
            offsetY: event.clientY - position.y,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsWindowDragging(true);
    };

    const finishWindowDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (windowDragRef.current?.pointerId !== event.pointerId) return;
        event.stopPropagation();
        windowDragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setIsWindowDragging(false);
    };

    const handleImagePanStart = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.stopPropagation();
        if (event.button !== 0 || imageViewport.zoom <= TREE_RING_FULL_MIN_ZOOM) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        imagePanRef.current = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            viewportPixels: Math.min(rect.width, rect.height),
            startViewport: imageViewport,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsImagePanning(true);
    };

    const handleImagePanMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const pan = imagePanRef.current;
        if (!pan || pan.pointerId !== event.pointerId) return;
        event.stopPropagation();
        setImageViewport(panTreeRingFullViewport(
            pan.startViewport,
            diameterMm,
            event.clientX - pan.startClientX,
            event.clientY - pan.startClientY,
            pan.viewportPixels,
        ));
    };

    const finishImagePan = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (imagePanRef.current?.pointerId !== event.pointerId) return;
        event.stopPropagation();
        imagePanRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setIsImagePanning(false);
    };

    const handleResizeStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        resizeRef.current = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startSize: imageSize,
            maximumSize: getMaximumImageSize(position),
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsResizing(true);
    };

    const finishResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (resizeRef.current?.pointerId !== event.pointerId) return;
        event.stopPropagation();
        resizeRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setIsResizing(false);
    };

    const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        const direction = event.key === "ArrowRight" || event.key === "ArrowDown"
            ? 1
            : (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0);
        if (direction === 0) return;
        event.preventDefault();
        event.stopPropagation();
        updateImageSize(imageSize + direction * (event.shiftKey ? 50 : 20));
    };

    return createPortal(
        <div
            className={`${styles.viewer}${isWindowDragging ? ` ${styles.dragging}` : ""}${isResizing ? ` ${styles.resizing}` : ""}`}
            style={{
                left: `${position.x}px`,
                top: `${position.y}px`,
                width: `${imageSize}px`,
            }}
            role="dialog"
            aria-label={`${seriesId} 的完整树轮截面图`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
        >
            <div
                className={styles.titleBar}
                onPointerDown={handleWindowDragStart}
                onPointerUp={finishWindowDrag}
                onPointerCancel={finishWindowDrag}
                onLostPointerCapture={() => setIsWindowDragging(false)}
            >
                <span className={styles.title}>
                    {seriesId} · {viewerMode === "scan" ? "扫描影像" : "完整树轮截面"}
                </span>
                <span className={styles.modeSwitch}>
                    <button
                        type="button"
                        className={viewerMode === "generated" ? styles.modeActive : undefined}
                        aria-pressed={viewerMode === "generated"}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            setViewerMode("generated");
                        }}
                    >
                        绘制
                    </button>
                    <button
                        type="button"
                        className={viewerMode === "scan" ? styles.modeActive : undefined}
                        aria-pressed={viewerMode === "scan"}
                        disabled={!scanFile}
                        title={scanFile ? "切换到同名扫描影像" : "未加载当前序列的同名扫描影像"}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            showScanViewer();
                        }}
                    >
                        扫描
                    </button>
                </span>
                <span className={styles.meta}>
                    {viewerMode === "scan"
                        ? (scanFile?.name ?? "无同名影像")
                        : `${artwork.ringCount} 年 · 半径 ${artwork.radiusMm.toFixed(3)} mm · ×${imageViewport.zoom.toFixed(1)}`}
                </span>
                <button
                    type="button"
                    className={styles.closeButton}
                    aria-label="关闭完整树轮截面图"
                    title="关闭"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        onClose();
                    }}
                >
                    ×
                </button>
            </div>
            <div
                ref={imageFrameRef}
                className={`${styles.imageFrame}${viewerMode === "scan" ? ` ${styles.scanImageFrame}` : ""}${viewerMode === "generated" && imageViewport.zoom > TREE_RING_FULL_MIN_ZOOM ? ` ${styles.imageFrameZoomed}` : ""}${isImagePanning ? ` ${styles.imageFramePanning}` : ""}`}
                style={{ height: `${imageSize}px` }}
                title={viewerMode === "generated" ? "滚轮缩放；放大后拖动图片平移；双击恢复完整截面" : undefined}
                onPointerDown={viewerMode === "generated" ? handleImagePanStart : undefined}
                onPointerMove={viewerMode === "generated" ? handleImagePanMove : undefined}
                onPointerUp={viewerMode === "generated" ? finishImagePan : undefined}
                onPointerCancel={viewerMode === "generated" ? finishImagePan : undefined}
                onLostPointerCapture={() => setIsImagePanning(false)}
                onDoubleClick={(event) => {
                    if (viewerMode !== "generated") return;
                    event.stopPropagation();
                    setImageViewport({ zoom: TREE_RING_FULL_MIN_ZOOM, startX: 0, startY: 0 });
                }}
            >
                {viewerMode === "scan" && scanFile && scanState && onScanStateChange ? (
                    <TreeRingScanViewer
                        seriesId={seriesId}
                        series={series}
                        stopMarkerValue={stopMarkerValue}
                        file={scanFile}
                        scanState={scanState}
                        operationLog={operationLog}
                        highlightedYear={highlightedYear}
                        yearMapping={yearMapping}
                        size={imageSize}
                        onChange={onScanStateChange}
                    />
                ) : (
                    <svg
                        className={styles.fullViewport}
                        viewBox={`${imageViewport.startX} ${imageViewport.startY} ${viewSizeMm} ${viewSizeMm}`}
                        preserveAspectRatio="xMidYMid meet"
                        role="img"
                        aria-label={`${seriesId} 的完整树轮截面图`}
                    >
                        <image
                            href={artwork.fullUrl}
                            x={0}
                            y={0}
                            width={diameterMm}
                            height={diameterMm}
                            preserveAspectRatio="xMidYMid meet"
                        />
                        <TreeRingSvgOverlay
                            geometry={artwork.geometry}
                            highlightedYear={highlightedYear}
                        />
                    </svg>
                )}
            </div>
            <button
                type="button"
                className={styles.resizeHandle}
                aria-label="调节完整树轮截面窗口大小"
                title="拖动调节窗口大小；方向键微调"
                onPointerDown={handleResizeStart}
                onPointerUp={finishResize}
                onPointerCancel={finishResize}
                onLostPointerCapture={() => setIsResizing(false)}
                onKeyDown={handleResizeKeyDown}
            />
        </div>,
        document.body,
    );
}
