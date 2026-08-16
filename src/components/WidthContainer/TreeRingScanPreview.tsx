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
import { useTreeRingScanImage } from "./useTreeRingScanImage";
import styles from "./TreeRingScanPreview.module.css";

interface TreeRingScanPreviewProps {
    seriesId: string;
    file: TreeRingScanFile;
    scanState: TreeRingScanSeriesState;
    yearMapping: TreeRingYearMapping;
    highlightedYear?: number;
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

const MIN_ZOOM = 1;
const MAX_ZOOM = 32;

const clamp = (value: number, minimum: number, maximum: number) => (
    Math.min(maximum, Math.max(minimum, value))
);

function TreeRingScanPreviewComponent({
    seriesId,
    file,
    scanState,
    yearMapping,
    highlightedYear,
    onYearSelect,
    onOpen,
    onContextMenu,
}: TreeRingScanPreviewProps) {
    const image = useTreeRingScanImage(file, scanState.crop);
    const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
    const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
    const [zoom, setZoom] = useState(MIN_ZOOM);
    const [startX, setStartX] = useState(0);
    const [hoveredYear, setHoveredYear] = useState<HoveredYear | null>(null);
    const [isPanning, setIsPanning] = useState(false);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const svgRef = useRef<SVGSVGElement | null>(null);
    const panGestureRef = useRef<PreviewPanGesture | null>(null);
    const suppressClickRef = useRef(false);
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

    const aspect = previewSize.width > 0 && previewSize.height > 0
        ? previewSize.width / previewSize.height
        : 18;
    const requestedViewWidth = displaySize.width > 0 ? displaySize.width / zoom : 1;
    const viewWidth = displaySize.height > 0
        ? Math.min(requestedViewWidth, displaySize.height * aspect)
        : requestedViewWidth;
    const viewHeight = Math.max(1, viewWidth / aspect);
    const centreY = getTreeRingScanBandCenterYRatio(scanState) * displaySize.height;
    const viewTop = clamp(
        centreY - viewHeight / 2,
        0,
        Math.max(0, displaySize.height - viewHeight),
    );
    const maximumStartX = Math.max(0, displaySize.width - viewWidth);
    const clampedStartX = clamp(startX, 0, maximumStartX);

    useEffect(() => {
        setZoom(MIN_ZOOM);
        setStartX(0);
        setHoveredYear(null);
    }, [file.path]);

    useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return;
        const measure = () => {
            const rect = svg.getBoundingClientRect();
            setPreviewSize({ width: rect.width, height: rect.height });
        };
        measure();
        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", measure);
            return () => window.removeEventListener("resize", measure);
        }
        const observer = new ResizeObserver(measure);
        observer.observe(svg);
        return () => observer.disconnect();
    }, [image.url]);

    useEffect(() => {
        if (highlightedYear === undefined || !yearMapping.valid || displaySize.width <= 0) return;
        const originalYear = yearMapping.originalByCurrent.get(highlightedYear);
        if (originalYear === undefined) return;
        const xRatio = getTreeRingScanXRatioForOriginalYear(scanState, originalYear);
        if (xRatio === null) return;
        const targetX = xRatio * displaySize.width;
        setStartX(clamp(targetX - viewWidth / 2, 0, maximumStartX));
    }, [displaySize.width, highlightedYear, maximumStartX, scanState, viewWidth, yearMapping]);

    useEffect(() => {
        const button = buttonRef.current;
        if (!button || displaySize.width <= 0) return;
        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setHoveredYear(null);
            const rect = button.getBoundingClientRect();
            const cursorRatio = rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0.5;
            const nextZoom = clamp(zoom * Math.exp(-event.deltaY * 0.0022), MIN_ZOOM, MAX_ZOOM);
            const nextRequestedWidth = displaySize.width / nextZoom;
            const nextViewWidth = Math.min(nextRequestedWidth, displaySize.height * aspect);
            const imageX = clampedStartX + cursorRatio * viewWidth;
            setZoom(nextZoom);
            setStartX(clamp(imageX - cursorRatio * nextViewWidth, 0, Math.max(0, displaySize.width - nextViewWidth)));
        };
        button.addEventListener("wheel", handleWheel, { passive: false, capture: true });
        return () => button.removeEventListener("wheel", handleWheel, { capture: true });
    }, [aspect, clampedStartX, displaySize.height, displaySize.width, viewWidth, zoom]);

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
        if (gesture.pointerId !== event.pointerId || zoom <= MIN_ZOOM) return;
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
    const sourceViewBox = scanState.crop && !image.cropApplied
        ? `${scanState.crop.xRatio * naturalSize.width} ${scanState.crop.yRatio * naturalSize.height} ${scanState.crop.widthRatio * naturalSize.width} ${scanState.crop.heightRatio * naturalSize.height}`
        : `0 0 ${naturalSize.width || 1} ${naturalSize.height || 1}`;
    const rotationTransform = rotation === 90
        ? `translate(${displaySize.width} 0) rotate(90)`
        : (rotation === 180
            ? `translate(${displaySize.width} ${displaySize.height}) rotate(180)`
            : (rotation === 270 ? `translate(0 ${displaySize.height}) rotate(-90)` : undefined));

    return (
        <div className={styles.previewShell}>
            <button
                ref={buttonRef}
                type="button"
                className={`${styles.previewButton}${zoom > MIN_ZOOM ? ` ${styles.zoomed}` : ""}${isPanning ? ` ${styles.panning}` : ""}`}
                title="扫描样芯截面 · 滚轮缩放，拖动平移，单击跳转，双击查看完整影像"
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
                <svg
                    ref={svgRef}
                    className={styles.previewSvg}
                    viewBox={`${clampedStartX} ${viewTop} ${viewWidth} ${viewHeight}`}
                    preserveAspectRatio="xMidYMid meet"
                    role="img"
                    aria-label={`${seriesId} 的扫描影像 1 cm 窗口`}
                >
                    <g transform={rotationTransform}>
                        <svg
                            x={0}
                            y={0}
                            width={unrotatedDisplaySize.width || 1}
                            height={unrotatedDisplaySize.height || 1}
                            viewBox={sourceViewBox}
                            preserveAspectRatio="none"
                        >
                            <image
                                href={image.url}
                                x={0}
                                y={0}
                                width={naturalSize.width || 1}
                                height={naturalSize.height || 1}
                                preserveAspectRatio="none"
                                onLoad={(event) => {
                                    const element = event.currentTarget as SVGImageElement;
                                    const htmlImage = new Image();
                                    htmlImage.onload = () => setNaturalSize({ width: htmlImage.naturalWidth, height: htmlImage.naturalHeight });
                                    htmlImage.src = element.href.baseVal;
                                }}
                            />
                        </svg>
                    </g>
                    {selectedXRatio !== null ? (
                        <line
                            x1={selectedXRatio * displaySize.width}
                            x2={selectedXRatio * displaySize.width}
                            y1={viewTop}
                            y2={viewTop + viewHeight}
                            className={styles.selectedLine}
                            vectorEffect="non-scaling-stroke"
                        />
                    ) : null}
                </svg>
                {zoom > MIN_ZOOM ? <span className={styles.zoomBadge}>×{zoom.toFixed(1)}</span> : null}
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
