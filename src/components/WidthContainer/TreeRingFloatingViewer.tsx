import { useEffect, useMemo, useRef, useState } from "react";
import type {
    KeyboardEvent as ReactKeyboardEvent,
    MouseEvent as ReactMouseEvent,
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
import type { TreeRingViewerAnchor, TreeRingViewerDisplayMode } from "./TreeRingPreview";
import {
    focusTreeRingFullViewport,
    getTreeRingFullViewSize,
    panTreeRingFullViewport,
    TREE_RING_FULL_MIN_ZOOM,
    type TreeRingFullViewport,
    zoomTreeRingFullViewport,
} from "./treeRingFullViewport";
import {
    focusTreeRingViewport,
    getTreeRingOneCentimetreZoom,
    getTreeRingPreviewViewHeight,
    getTreeRingViewportWidth,
    panTreeRingViewport,
    TREE_RING_MIN_ZOOM,
    type TreeRingViewport,
    zoomTreeRingViewport,
} from "./treeRingViewport";
import { getTreeRingArtwork, getTreeRingFeature } from "./treeRingArtwork";
import {
    resolveFullTreeRingViewerFeature,
    resolveStripTreeRingViewerFeature,
} from "./treeRingViewerLink";
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

interface FullImagePanState {
    kind: "full";
    pointerId: number;
    startClientX: number;
    startClientY: number;
    viewportPixels: number;
    startViewport: TreeRingFullViewport;
    moved: boolean;
}

interface StripImagePanState {
    kind: "strip";
    pointerId: number;
    startClientX: number;
    viewportPixels: number;
    startViewport: TreeRingViewport;
    moved: boolean;
}

type ImagePanState = FullImagePanState | StripImagePanState;

type GeneratedViewerMode = "full" | "strip";

interface HoveredGeneratedYear {
    label: string;
    left: number;
    top: number;
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
    focusRequestId?: number;
    anchor: TreeRingViewerAnchor;
    initialView?: TreeRingViewerDisplayMode;
    scanFile?: TreeRingScanFile;
    scanState?: TreeRingScanSeriesState;
    operationLog?: readonly RwlOperationLogEntry[];
    yearMapping?: TreeRingYearMapping;
    onScanStateChange?: (state: TreeRingScanSeriesState) => void;
    onYearSelect?: (seriesId: string, year: number) => void;
    onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
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
    focusRequestId,
    anchor,
    initialView = "full",
    scanFile,
    scanState,
    operationLog = [],
    yearMapping,
    onScanStateChange,
    onYearSelect,
    onContextMenu,
    onClose,
}: TreeRingFloatingViewerProps) {
    const artwork = useMemo(
        () => getTreeRingArtwork(series, stopMarkerValue, true),
        [series, stopMarkerValue],
    );
    const initialImageSize = calculateImageSize(anchor, initialView === "scan" ? 360 : 120);
    const initialStripSurfaceWidth = Math.max(1, initialImageSize - 24);
    const initialStripSurfaceHeight = Math.round(clamp(initialImageSize * 0.24, 64, 140));
    const initialStripZoom = artwork
        ? getTreeRingOneCentimetreZoom(
            artwork.geometry.radiusMm,
            artwork.geometry.windowHeightMm,
            initialStripSurfaceWidth,
            initialStripSurfaceHeight,
        )
        : TREE_RING_MIN_ZOOM;
    const [imageSize, setImageSize] = useState(initialImageSize);
    const [position, setPosition] = useState(() => getInitialPosition(anchor, initialImageSize));
    const [imageViewport, setImageViewport] = useState<TreeRingFullViewport>({
        zoom: TREE_RING_FULL_MIN_ZOOM,
        startX: 0,
        startY: 0,
    });
    const [viewerMode, setViewerMode] = useState<TreeRingImageMode>(
        initialView === "scan" && scanFile ? "scan" : "generated",
    );
    const [generatedViewerMode, setGeneratedViewerMode] = useState<GeneratedViewerMode>(
        initialView === "strip" ? "strip" : "full",
    );
    const [stripViewport, setStripViewport] = useState<TreeRingViewport>({
        zoom: initialStripZoom,
        startX: artwork?.radiusMm ?? 1,
    });
    const [hoveredGeneratedYear, setHoveredGeneratedYear] = useState<HoveredGeneratedYear | null>(null);
    const [isWindowDragging, setIsWindowDragging] = useState(false);
    const [isImagePanning, setIsImagePanning] = useState(false);
    const [isResizing, setIsResizing] = useState(false);
    const previousScanCropRef = useRef(scanState?.crop);
    const previousPreferredModeRef = useRef(scanState?.mode);
    const imageSizeRef = useRef(imageSize);
    const imageFrameRef = useRef<HTMLDivElement | null>(null);
    const generatedSurfaceRef = useRef<HTMLDivElement | null>(null);
    const windowDragRef = useRef<WindowDragState | null>(null);
    const imagePanRef = useRef<ImagePanState | null>(null);
    const suppressGeneratedClickRef = useRef(false);
    const handledFocusRequestIdRef = useRef<number | undefined>(undefined);
    const resizeRef = useRef<ResizeState | null>(null);
    const stripSurfaceWidth = Math.max(1, imageSize - 24);
    const stripSurfaceHeight = Math.round(clamp(imageSize * 0.24, 64, 140));
    const stripBaseZoom = artwork
        ? getTreeRingOneCentimetreZoom(
            artwork.geometry.radiusMm,
            artwork.geometry.windowHeightMm,
            stripSurfaceWidth,
            stripSurfaceHeight,
        )
        : TREE_RING_MIN_ZOOM;
    const stripViewWidth = artwork
        ? getTreeRingViewportWidth(artwork.geometry.radiusMm, stripViewport.zoom)
        : 1;
    const stripViewHeight = artwork
        ? getTreeRingPreviewViewHeight(
            stripViewWidth,
            artwork.geometry.diameterMm,
            stripSurfaceWidth,
            stripSurfaceHeight,
            artwork.geometry.windowHeightMm,
        )
        : 1;
    const stripViewTop = artwork
        ? artwork.geometry.radiusMm - stripViewHeight / 2
        : 0;

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
        const previousMode = previousPreferredModeRef.current;
        previousPreferredModeRef.current = scanState?.mode;
        if (!scanState?.mode || scanState.mode === previousMode) return;
        setViewerMode(scanState.mode === "scan" && scanFile ? "scan" : "generated");
        setHoveredGeneratedYear(null);
    }, [scanFile, scanState?.mode]);

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

    // Reset only for new artwork; resizing the viewer must preserve both zoom states.
    useEffect(() => {
        setImageViewport({ zoom: TREE_RING_FULL_MIN_ZOOM, startX: 0, startY: 0 });
        setStripViewport({
            zoom: stripBaseZoom,
            startX: artwork?.radiusMm ?? 1,
        });
        setHoveredGeneratedYear(null);
    }, [artwork?.cacheKey, artwork?.radiusMm]);

    useEffect(() => {
        if (
            viewerMode !== "generated"
            || focusRequestId === undefined
            || handledFocusRequestIdRef.current === focusRequestId
            || !artwork
            || highlightedYear === undefined
        ) return;
        const feature = getTreeRingFeature(artwork.geometry, highlightedYear);
        if (!feature) return;
        handledFocusRequestIdRef.current = focusRequestId;
        setImageViewport((current) => focusTreeRingFullViewport(
            current,
            artwork.geometry.diameterMm,
            feature.centreRadiusMm,
        ));
        setStripViewport((current) => focusTreeRingViewport(
            current,
            artwork.geometry.radiusMm,
            feature.centreRadiusMm,
        ));
    }, [artwork, focusRequestId, generatedViewerMode, highlightedYear, viewerMode]);

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
        const surface = generatedSurfaceRef.current;
        if (!surface || !artwork || viewerMode !== "generated") return;
        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setHoveredGeneratedYear(null);
            const rect = surface.getBoundingClientRect();
            const cursorXRatio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
            if (generatedViewerMode === "strip") {
                setStripViewport((current) => zoomTreeRingViewport(
                    current,
                    artwork.geometry.radiusMm,
                    cursorXRatio,
                    event.deltaY,
                ));
            } else {
                const cursorYRatio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
                setImageViewport((current) => zoomTreeRingFullViewport(
                    current,
                    artwork.geometry.diameterMm,
                    cursorXRatio,
                    cursorYRatio,
                    event.deltaY,
                ));
            }
        };
        surface.addEventListener("wheel", handleWheel, { passive: false, capture: true });
        return () => surface.removeEventListener("wheel", handleWheel, { capture: true });
    }, [artwork, generatedViewerMode, viewerMode]);

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

    const resolveGeneratedFeature = (
        clientX: number,
        clientY: number,
        element: HTMLDivElement,
    ) => {
        const rect = element.getBoundingClientRect();
        const localX = clientX - rect.left;
        const localY = clientY - rect.top;
        const feature = generatedViewerMode === "strip"
            ? resolveStripTreeRingViewerFeature(
                artwork.geometry,
                stripViewport,
                localX,
                rect.width,
            )
            : resolveFullTreeRingViewerFeature(
                artwork.geometry,
                imageViewport,
                localX,
                localY,
                rect.width,
                rect.height,
            );
        return feature ? {
            feature,
            left: clamp(localX, 30, Math.max(30, rect.width - 30)),
            top: clamp(localY, 28, Math.max(28, rect.height - 22)),
        } : null;
    };

    const updateGeneratedHover = (event: ReactPointerEvent<HTMLDivElement>) => {
        const resolved = resolveGeneratedFeature(event.clientX, event.clientY, event.currentTarget);
        if (!resolved) {
            setHoveredGeneratedYear(null);
            return;
        }
        const { feature } = resolved;
        setHoveredGeneratedYear({
            left: resolved.left,
            top: resolved.top,
            label: feature.kind === "gap"
                ? `${feature.startYear === feature.endYear ? feature.startYear : `${feature.startYear}–${feature.endYear}`} 年缺测`
                : `${feature.startYear} 年`,
        });
    };

    const handleImagePanStart = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        const canPan = generatedViewerMode === "strip"
            ? stripViewport.zoom > TREE_RING_MIN_ZOOM
            : imageViewport.zoom > TREE_RING_FULL_MIN_ZOOM;
        if (!canPan) return;
        event.preventDefault();
        setHoveredGeneratedYear(null);
        const rect = event.currentTarget.getBoundingClientRect();
        imagePanRef.current = generatedViewerMode === "strip"
            ? {
                kind: "strip",
                pointerId: event.pointerId,
                startClientX: event.clientX,
                viewportPixels: rect.width,
                startViewport: stripViewport,
                moved: false,
            }
            : {
                kind: "full",
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                viewportPixels: Math.min(rect.width, rect.height),
                startViewport: imageViewport,
                moved: false,
            };
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsImagePanning(true);
    };

    const handleImagePanMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const pan = imagePanRef.current;
        if (!pan) {
            updateGeneratedHover(event);
            return;
        }
        if (pan.pointerId !== event.pointerId) return;
        event.stopPropagation();
        const deltaX = event.clientX - pan.startClientX;
        const deltaY = pan.kind === "full" ? event.clientY - pan.startClientY : 0;
        if (!pan.moved && Math.hypot(deltaX, deltaY) >= 3) pan.moved = true;
        if (!pan.moved) return;
        if (pan.kind === "strip") {
            setStripViewport(panTreeRingViewport(
                pan.startViewport,
                artwork.geometry.radiusMm,
                deltaX,
                pan.viewportPixels,
            ));
        } else {
            setImageViewport(panTreeRingFullViewport(
                pan.startViewport,
                diameterMm,
                deltaX,
                deltaY,
                pan.viewportPixels,
            ));
        }
    };

    const finishImagePan = (event: ReactPointerEvent<HTMLDivElement>) => {
        const pan = imagePanRef.current;
        if (!pan || pan.pointerId !== event.pointerId) return;
        event.stopPropagation();
        imagePanRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setIsImagePanning(false);
        if (pan.moved) {
            suppressGeneratedClickRef.current = true;
            window.setTimeout(() => { suppressGeneratedClickRef.current = false; }, 0);
        }
    };

    const handleGeneratedClick = (event: ReactMouseEvent<HTMLDivElement>) => {
        event.stopPropagation();
        if (event.detail > 1 || suppressGeneratedClickRef.current) return;
        const resolved = resolveGeneratedFeature(event.clientX, event.clientY, event.currentTarget);
        if (resolved) onYearSelect?.(seriesId, resolved.feature.startYear);
    };

    const resetGeneratedViewport = () => {
        if (generatedViewerMode === "strip") {
            setStripViewport({ zoom: stripBaseZoom, startX: artwork.geometry.radiusMm });
        } else {
            setImageViewport({ zoom: TREE_RING_FULL_MIN_ZOOM, startX: 0, startY: 0 });
        }
        setHoveredGeneratedYear(null);
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
            aria-label={`${seriesId} 的树轮影像查看器`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onContextMenu?.(event);
            }}
        >
            <div
                className={styles.titleBar}
                onPointerDown={handleWindowDragStart}
                onPointerUp={finishWindowDrag}
                onPointerCancel={finishWindowDrag}
                onLostPointerCapture={() => setIsWindowDragging(false)}
            >
                <span className={styles.title}>
                    {seriesId} · {viewerMode === "scan"
                        ? "扫描影像"
                        : generatedViewerMode === "strip" ? "1 cm 窗口" : "完整截面"}
                </span>
                <span className={styles.modeSwitch}>
                    <button
                        type="button"
                        className={viewerMode === "generated" && generatedViewerMode === "strip" ? styles.modeActive : undefined}
                        aria-pressed={viewerMode === "generated" && generatedViewerMode === "strip"}
                        title="查看与宽度模块横条一致的 1 cm 绘制窗口"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            setViewerMode("generated");
                            setGeneratedViewerMode("strip");
                            setHoveredGeneratedYear(null);
                        }}
                    >
                        1 cm
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
                    <button
                        type="button"
                        className={viewerMode === "generated" && generatedViewerMode === "full" ? styles.modeActive : undefined}
                        aria-pressed={viewerMode === "generated" && generatedViewerMode === "full"}
                        title="查看完整圆形绘制截面"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            setViewerMode("generated");
                            setGeneratedViewerMode("full");
                            setHoveredGeneratedYear(null);
                        }}
                    >
                        完整
                    </button>
                </span>
                <span className={styles.meta}>
                    {viewerMode === "scan"
                        ? (scanFile?.name ?? "无同名影像")
                        : generatedViewerMode === "strip"
                            ? `${artwork.ringCount} 年 · ×${stripViewport.zoom.toFixed(1)}`
                            : `${artwork.ringCount} 年 · 半径 ${artwork.radiusMm.toFixed(3)} mm · ×${imageViewport.zoom.toFixed(1)}`}
                </span>
                <button
                    type="button"
                    className={styles.closeButton}
                    aria-label="关闭树轮影像查看器"
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
                className={`${styles.imageFrame}${viewerMode === "scan" ? ` ${styles.scanImageFrame}` : ""}${viewerMode === "generated" && (generatedViewerMode === "strip" ? stripViewport.zoom > TREE_RING_MIN_ZOOM : imageViewport.zoom > TREE_RING_FULL_MIN_ZOOM) ? ` ${styles.imageFrameZoomed}` : ""}${isImagePanning ? ` ${styles.imageFramePanning}` : ""}`}
                style={{ height: `${imageSize}px` }}
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
                        focusRequestId={focusRequestId}
                        yearMapping={yearMapping}
                        size={imageSize}
                        onChange={onScanStateChange}
                        onYearSelect={onYearSelect}
                    />
                ) : (
                    <div
                        ref={generatedSurfaceRef}
                        className={`${styles.generatedSurface}${generatedViewerMode === "strip" ? ` ${styles.stripSurface}` : ` ${styles.fullSurface}`}`}
                        style={generatedViewerMode === "strip" ? {
                            width: `${stripSurfaceWidth}px`,
                            height: `${stripSurfaceHeight}px`,
                        } : undefined}
                        title="滚轮缩放；放大后拖动平移；单击定位宽度格；双击重置视图"
                        onPointerDown={handleImagePanStart}
                        onPointerMove={handleImagePanMove}
                        onPointerUp={finishImagePan}
                        onPointerCancel={finishImagePan}
                        onPointerLeave={() => {
                            if (!imagePanRef.current) setHoveredGeneratedYear(null);
                        }}
                        onLostPointerCapture={() => {
                            imagePanRef.current = null;
                            setIsImagePanning(false);
                        }}
                        onClick={handleGeneratedClick}
                        onDoubleClick={(event) => {
                            event.stopPropagation();
                            resetGeneratedViewport();
                        }}
                    >
                        <svg
                            className={styles.fullViewport}
                            viewBox={generatedViewerMode === "strip"
                                ? `${stripViewport.startX} ${stripViewTop} ${stripViewWidth} ${stripViewHeight}`
                                : `${imageViewport.startX} ${imageViewport.startY} ${viewSizeMm} ${viewSizeMm}`}
                            preserveAspectRatio="xMidYMid meet"
                            role="img"
                            aria-label={`${seriesId} 的${generatedViewerMode === "strip" ? " 1 cm 树轮窗口" : "完整树轮截面图"}`}
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
                        {hoveredGeneratedYear ? (
                            <span
                                className={styles.yearTooltip}
                                style={{
                                    left: `${hoveredGeneratedYear.left}px`,
                                    top: `${hoveredGeneratedYear.top}px`,
                                }}
                            >
                                {hoveredGeneratedYear.label}
                            </span>
                        ) : null}
                        <span className={styles.linkHint}>单击定位宽度格</span>
                    </div>
                )}
            </div>
            <button
                type="button"
                className={styles.resizeHandle}
                aria-label="调节树轮影像窗口大小"
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
