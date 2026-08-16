import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { RwlTreeData } from "@/features/rwl";
import type { RwlOperationLogEntry } from "@/features/rwl/edit";
import {
    getFirstTreeRingScanAnchorYear,
    getTreeRingScanXRatioForOriginalYear,
    getLatestSeriesOperationSequence,
    getTreeRingScanMarkerCount,
    displayTreeRingScanCropToOriginal,
    normalizeTreeRingScanRotation,
    originalTreeRingScanCropToDisplay,
    rotatedTreeRingScanSize,
    rotateTreeRingScanAnchors,
    type TreeRingScanCrop,
    type TreeRingScanFile,
    type TreeRingScanSeriesState,
    type TreeRingYearMapping,
} from "@/features/treeRingScans";
import { useTreeRingScanImage } from "./useTreeRingScanImage";
import styles from "./TreeRingScanViewer.module.css";

interface TreeRingScanViewerProps {
    seriesId: string;
    series: RwlTreeData;
    stopMarkerValue: number;
    file: TreeRingScanFile;
    scanState: TreeRingScanSeriesState;
    operationLog: readonly RwlOperationLogEntry[];
    highlightedYear?: number;
    yearMapping?: TreeRingYearMapping;
    size: number;
    onChange: (state: TreeRingScanSeriesState) => void;
}

type ViewerTool = "pan" | "crop" | "point";

interface PanGesture {
    kind: "pan";
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPanX: number;
    startPanY: number;
    moved: boolean;
}

interface CropGesture {
    kind: "crop";
    pointerId: number;
    start: { xRatio: number; yRatio: number };
    current: { xRatio: number; yRatio: number };
}

type ViewerGesture = PanGesture | CropGesture;

const MIN_ZOOM = 1;
const MAX_ZOOM = 32;

const clamp = (value: number, minimum: number, maximum: number) => (
    Math.min(maximum, Math.max(minimum, value))
);

const normalizedCrop = (
    start: { xRatio: number; yRatio: number },
    end: { xRatio: number; yRatio: number },
): TreeRingScanCrop => ({
    xRatio: Math.min(start.xRatio, end.xRatio),
    yRatio: Math.min(start.yRatio, end.yRatio),
    widthRatio: Math.abs(end.xRatio - start.xRatio),
    heightRatio: Math.abs(end.yRatio - start.yRatio),
});

export function TreeRingScanViewer({
    seriesId,
    series,
    stopMarkerValue,
    file,
    scanState,
    operationLog,
    highlightedYear,
    yearMapping,
    size,
    onChange,
}: TreeRingScanViewerProps) {
    const rotation = scanState.rotation ?? 0;
    const [tool, setTool] = useState<ViewerTool>(() => (
        !scanState.crop ? "crop" : (scanState.anchors.length < 2 ? "point" : "pan")
    ));
    const displayedCrop = tool === "crop" ? undefined : scanState.crop;
    const image = useTreeRingScanImage(file, displayedCrop);
    const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
    const [zoom, setZoom] = useState(MIN_ZOOM);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [draftCrop, setDraftCrop] = useState<TreeRingScanCrop | null>(null);
    const frameRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const sourceImageRef = useRef<HTMLImageElement | null>(null);
    const gestureRef = useRef<ViewerGesture | null>(null);
    const editableEntries = useMemo(() => Array.from(series.entries())
        .filter((entry): entry is [number, number] => (
            typeof entry[1] === "number"
            && Number.isFinite(entry[1])
            && entry[1] !== stopMarkerValue
        ))
        .sort(([left], [right]) => left - right), [series, stopMarkerValue]);

    const unrotatedDisplayNaturalSize = useMemo(() => {
        if (!displayedCrop || image.cropApplied) return naturalSize;
        return {
            width: naturalSize.width * displayedCrop.widthRatio,
            height: naturalSize.height * displayedCrop.heightRatio,
        };
    }, [displayedCrop, image.cropApplied, naturalSize]);
    const displayNaturalSize = useMemo(() => rotatedTreeRingScanSize(
        unrotatedDisplayNaturalSize.width,
        unrotatedDisplayNaturalSize.height,
        rotation,
    ), [rotation, unrotatedDisplayNaturalSize]);

    const fittedSize = useMemo(() => {
        if (!(displayNaturalSize.width > 0) || !(displayNaturalSize.height > 0)) {
            return { width: size, height: size };
        }
        const scale = Math.min(size / displayNaturalSize.width, size / displayNaturalSize.height);
        return {
            width: displayNaturalSize.width * scale,
            height: displayNaturalSize.height * scale,
        };
    }, [displayNaturalSize.height, displayNaturalSize.width, size]);
    const sourceLayerSize = useMemo(() => rotatedTreeRingScanSize(
        fittedSize.width,
        fittedSize.height,
        normalizeTreeRingScanRotation(360 - rotation),
    ), [fittedSize.height, fittedSize.width, rotation]);

    const clampPan = (candidate: { x: number; y: number }, candidateZoom = zoom) => {
        const maximumX = Math.max(0, (fittedSize.width * candidateZoom - size) / 2);
        const maximumY = Math.max(0, (fittedSize.height * candidateZoom - size) / 2);
        return {
            x: clamp(candidate.x, -maximumX, maximumX),
            y: clamp(candidate.y, -maximumY, maximumY),
        };
    };

    useEffect(() => {
        setNaturalSize({ width: 0, height: 0 });
        setZoom(MIN_ZOOM);
        setPan({ x: 0, y: 0 });
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
        const canvas = canvasRef.current;
        const source = sourceImageRef.current;
        if (!canvas || !source || !(naturalSize.width > 0) || !(naturalSize.height > 0)) return;
        const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
        const pixelWidth = Math.max(1, Math.round(size * pixelRatio));
        const pixelHeight = Math.max(1, Math.round(size * pixelRatio));
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) return;
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        context.fillStyle = "#eef1f4";
        context.fillRect(0, 0, size, size);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";

        const sourceX = displayedCrop && !image.cropApplied
            ? displayedCrop.xRatio * naturalSize.width
            : 0;
        const sourceY = displayedCrop && !image.cropApplied
            ? displayedCrop.yRatio * naturalSize.height
            : 0;
        const sourceWidth = displayedCrop && !image.cropApplied
            ? displayedCrop.widthRatio * naturalSize.width
            : naturalSize.width;
        const sourceHeight = displayedCrop && !image.cropApplied
            ? displayedCrop.heightRatio * naturalSize.height
            : naturalSize.height;

        context.save();
        context.beginPath();
        context.rect(0, 0, size, size);
        context.clip();
        context.translate(size / 2 + pan.x, size / 2 + pan.y);
        context.scale(zoom, zoom);
        context.rotate(rotation * Math.PI / 180);
        context.drawImage(
            source,
            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight,
            -sourceLayerSize.width / 2,
            -sourceLayerSize.height / 2,
            sourceLayerSize.width,
            sourceLayerSize.height,
        );
        context.restore();
    }, [
        displayedCrop?.heightRatio,
        displayedCrop?.widthRatio,
        displayedCrop?.xRatio,
        displayedCrop?.yRatio,
        image.cropApplied,
        image.url,
        naturalSize.height,
        naturalSize.width,
        pan.x,
        pan.y,
        rotation,
        size,
        sourceLayerSize.height,
        sourceLayerSize.width,
        zoom,
    ]);

    useEffect(() => {
        setDraftCrop(null);
        setTool(!scanState.crop ? "crop" : (scanState.anchors.length < 2 ? "point" : "pan"));
    }, [file.path]);

    useEffect(() => {
        setPan((current) => clampPan(current));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fittedSize.height, fittedSize.width, size, zoom]);

    const highlightedOriginalYear = highlightedYear === undefined
        ? undefined
        : yearMapping?.originalByCurrent.get(highlightedYear);
    const highlightedXRatio = highlightedOriginalYear === undefined || !displayedCrop
        ? null
        : getTreeRingScanXRatioForOriginalYear(scanState, highlightedOriginalYear);

    useEffect(() => {
        if (highlightedXRatio === null || zoom <= MIN_ZOOM) return;
        setPan((current) => clampPan({
            ...current,
            x: -(highlightedXRatio - 0.5) * fittedSize.width * zoom,
        }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [highlightedXRatio, fittedSize.width, zoom]);

    useEffect(() => {
        const frame = frameRef.current;
        if (!frame) return;
        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            if (tool === "crop") return;
            const rect = frame.getBoundingClientRect();
            const cursorX = event.clientX - rect.left - rect.width / 2;
            const cursorY = event.clientY - rect.top - rect.height / 2;
            const nextZoom = clamp(zoom * Math.exp(-event.deltaY * 0.0022), MIN_ZOOM, MAX_ZOOM);
            const ratio = nextZoom / zoom;
            const nextPan = clampPan({
                x: cursorX - (cursorX - pan.x) * ratio,
                y: cursorY - (cursorY - pan.y) * ratio,
            }, nextZoom);
            setZoom(nextZoom);
            setPan(nextPan);
        };
        frame.addEventListener("wheel", handleWheel, { passive: false, capture: true });
        return () => frame.removeEventListener("wheel", handleWheel, { capture: true });
    }, [fittedSize.height, fittedSize.width, pan.x, pan.y, size, tool, zoom]);

    const nextAnchorYear = scanState.anchors.length > 0
        ? scanState.anchors[scanState.anchors.length - 1].originalYear - 10
        : getFirstTreeRingScanAnchorYear(editableEntries[editableEntries.length - 1]?.[0] ?? 0);
    const nextMarkerCount = getTreeRingScanMarkerCount(nextAnchorYear);

    const resolveImageRatios = (clientX: number, clientY: number) => {
        const frame = frameRef.current;
        if (!frame || !(fittedSize.width > 0) || !(fittedSize.height > 0)) return null;
        const rect = frame.getBoundingClientRect();
        const localX = clientX - rect.left;
        const localY = clientY - rect.top;
        const frameCentreX = rect.width / 2;
        const frameCentreY = rect.height / 2;
        const untransformedX = (localX - frameCentreX - pan.x) / zoom + frameCentreX;
        const untransformedY = (localY - frameCentreY - pan.y) / zoom + frameCentreY;
        const imageLeft = (rect.width - fittedSize.width) / 2;
        const imageTop = (rect.height - fittedSize.height) / 2;
        const xRatio = (untransformedX - imageLeft) / fittedSize.width;
        const yRatio = (untransformedY - imageTop) / fittedSize.height;
        if (xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) return null;
        return { xRatio, yRatio };
    };

    const addAnchor = (clientX: number, clientY: number) => {
        if (tool !== "point" || !scanState.crop) return;
        const point = resolveImageRatios(clientX, clientY);
        if (!point || editableEntries.length === 0) return;
        const isFirst = scanState.anchors.length === 0;
        const anchors = [
            ...scanState.anchors,
            {
                originalYear: nextAnchorYear,
                xRatio: point.xRatio,
                yRatio: point.yRatio,
                markerCount: nextMarkerCount,
            },
        ];
        onChange({
            ...scanState,
            imagePath: file.path,
            mode: anchors.length >= 2 ? "scan" : scanState.mode,
            anchors,
            ...(isFirst ? {
                baselineStartYear: editableEntries[0][0],
                baselineEndYear: editableEntries[editableEntries.length - 1][0],
                baselineOperationSequence: getLatestSeriesOperationSequence(operationLog, seriesId),
                baselineWidths: editableEntries,
            } : {}),
        });
    };

    const selectTool = (nextTool: ViewerTool) => {
        if (nextTool === "point" && !scanState.crop) return;
        setTool(nextTool);
        setDraftCrop(null);
        setZoom(MIN_ZOOM);
        setPan({ x: 0, y: 0 });
    };

    const rotateImage = (degrees: -90 | 90) => {
        const nextRotation = normalizeTreeRingScanRotation(rotation + degrees);
        onChange({
            ...scanState,
            rotation: nextRotation,
            anchors: rotateTreeRingScanAnchors(scanState.anchors, rotation, nextRotation),
        });
        setDraftCrop(null);
        setZoom(MIN_ZOOM);
        setPan({ x: 0, y: 0 });
    };

    const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (tool === "crop") {
            const point = resolveImageRatios(event.clientX, event.clientY);
            if (!point) return;
            gestureRef.current = {
                kind: "crop",
                pointerId: event.pointerId,
                start: point,
                current: point,
            };
            setDraftCrop(normalizedCrop(point, point));
        } else {
            gestureRef.current = {
                kind: "pan",
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startPanX: pan.x,
                startPanY: pan.y,
                moved: false,
            };
        }
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        if (gesture.kind === "crop") {
            const point = resolveImageRatios(event.clientX, event.clientY);
            if (!point) return;
            gesture.current = point;
            setDraftCrop(normalizedCrop(gesture.start, point));
            return;
        }
        const deltaX = event.clientX - gesture.startClientX;
        const deltaY = event.clientY - gesture.startClientY;
        if (!gesture.moved && Math.hypot(deltaX, deltaY) >= 3) gesture.moved = true;
        if (!gesture.moved) return;
        event.preventDefault();
        event.stopPropagation();
        setPan(clampPan({ x: gesture.startPanX + deltaX, y: gesture.startPanY + deltaY }));
    };

    const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        gestureRef.current = null;
        event.stopPropagation();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (gesture.kind === "crop") {
            const displayCrop = normalizedCrop(gesture.start, gesture.current);
            const minimumWidth = Math.max(0.002, 4 / Math.max(1, fittedSize.width));
            const minimumHeight = Math.max(0.002, 4 / Math.max(1, fittedSize.height));
            if (displayCrop.widthRatio < minimumWidth || displayCrop.heightRatio < minimumHeight) {
                setDraftCrop(null);
                return;
            }
            const crop = displayTreeRingScanCropToOriginal(displayCrop, rotation);
            onChange({
                ...scanState,
                mode: "generated",
                imagePath: file.path,
                crop,
                anchors: [],
                baselineStartYear: undefined,
                baselineEndYear: undefined,
                baselineOperationSequence: undefined,
                baselineWidths: undefined,
            });
            setDraftCrop(null);
            setTool("point");
            return;
        }
        if (!gesture.moved) addAnchor(event.clientX, event.clientY);
    };

    const removeLastAnchor = () => {
        const anchors = scanState.anchors.slice(0, -1);
        onChange({
            ...scanState,
            anchors,
            mode: anchors.length >= 2 ? scanState.mode : "generated",
            ...(anchors.length === 0 ? {
                baselineStartYear: undefined,
                baselineEndYear: undefined,
                baselineOperationSequence: undefined,
                baselineWidths: undefined,
            } : {}),
        });
    };

    if (image.loading) {
        return (
            <div className={styles.message}>
                {displayedCrop ? "正在从原始影像提取最高分辨率截面…" : "正在生成扫描影像总览…"}
            </div>
        );
    }
    if (image.error || !image.url) {
        return <div className={styles.error}>扫描影像读取失败：{image.error ?? "未知错误"}</div>;
    }

    const visibleCrop = draftCrop ?? (tool === "crop" && scanState.crop
        ? originalTreeRingScanCropToDisplay(scanState.crop, rotation)
        : undefined);

    return (
        <div
            ref={frameRef}
            className={`${styles.frame} ${styles[`${tool}Tool`]}`}
            style={{ width: `${size}px`, height: `${size}px` }}
            title={tool === "crop"
                ? "拖动框选磨平后的长方形样芯截面"
                : (tool === "point" ? `点击标注 ${nextAnchorYear} 年锚点；拖动可平移` : "滚轮缩放；拖动平移")}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishPointer}
            onPointerCancel={finishPointer}
            onDoubleClick={(event) => {
                if (tool === "crop") return;
                event.stopPropagation();
                setZoom(MIN_ZOOM);
                setPan({ x: 0, y: 0 });
            }}
        >
            <canvas
                ref={canvasRef}
                className={styles.scanCanvas}
                role="img"
                aria-label={`${seriesId} 扫描影像`}
            />
            <div
                className={styles.imageStage}
                style={{
                    width: `${fittedSize.width}px`,
                    height: `${fittedSize.height}px`,
                    left: `${(size - fittedSize.width) / 2}px`,
                    top: `${(size - fittedSize.height) / 2}px`,
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                }}
            >
                {visibleCrop ? (
                    <span
                        className={`${styles.cropSelection}${draftCrop ? ` ${styles.cropSelectionDraft}` : ""}`}
                        style={{
                            left: `${visibleCrop.xRatio * 100}%`,
                            top: `${visibleCrop.yRatio * 100}%`,
                            width: `${visibleCrop.widthRatio * 100}%`,
                            height: `${visibleCrop.heightRatio * 100}%`,
                        }}
                    />
                ) : null}
                {highlightedXRatio !== null ? (
                    <span
                        className={styles.currentYearLine}
                        style={{
                            left: `${highlightedXRatio * 100}%`,
                            transform: `translateX(-50%) scaleX(${1 / zoom})`,
                        }}
                        aria-hidden="true"
                    />
                ) : null}
                {displayedCrop ? scanState.anchors.map((anchor, anchorIndex) => (
                    <span
                        key={`${anchor.originalYear}-${anchor.xRatio}-${anchor.yRatio}`}
                        className={styles.anchor}
                        style={{
                            left: `${anchor.xRatio * 100}%`,
                            top: `${anchor.yRatio * 100}%`,
                            transform: `translate(-50%, -50%) scale(${1 / zoom})`,
                        }}
                    >
                        <span className={styles.anchorDots} aria-hidden="true">
                            {Array.from({ length: anchor.markerCount }, (_, index) => <i key={index} />)}
                        </span>
                        <span
                            className={styles.anchorYear}
                            style={{ transform: `translateY(${(anchorIndex % 3 - 1) * 17}px)` }}
                        >
                            {anchor.originalYear}
                        </span>
                    </span>
                )) : null}
            </div>
            <div className={styles.toolbar} onPointerDown={(event) => event.stopPropagation()}>
                <button
                    type="button"
                    className={tool === "crop" ? styles.activeTool : undefined}
                    aria-pressed={tool === "crop"}
                    onClick={() => selectTool("crop")}
                >
                    选框
                </button>
                <button
                    type="button"
                    className={tool === "point" ? styles.activeTool : undefined}
                    aria-pressed={tool === "point"}
                    disabled={!scanState.crop}
                    onClick={() => selectTool("point")}
                >
                    点工具
                </button>
                <button
                    type="button"
                    className={tool === "pan" ? styles.activeTool : undefined}
                    aria-pressed={tool === "pan"}
                    disabled={!scanState.crop}
                    onClick={() => selectTool("pan")}
                >
                    平移
                </button>
                <button type="button" title="向左旋转 90°" onClick={() => rotateImage(-90)}>↶</button>
                <button type="button" title="向右旋转 90°" onClick={() => rotateImage(90)}>↷</button>
                {scanState.crop ? (
                    <span className={styles.nextAnchor}>
                        下一点 {nextAnchorYear} · {"•".repeat(nextMarkerCount)}
                    </span>
                ) : null}
                <button type="button" disabled={scanState.anchors.length === 0} onClick={removeLastAnchor}>撤销点</button>
                <button
                    type="button"
                    disabled={scanState.anchors.length === 0}
                    onClick={() => onChange({
                        ...scanState,
                        mode: "generated",
                        anchors: [],
                        baselineStartYear: undefined,
                        baselineEndYear: undefined,
                        baselineOperationSequence: undefined,
                        baselineWidths: undefined,
                    })}
                >
                    清空点
                </button>
                <span className={styles.zoom}>×{zoom.toFixed(1)}</span>
            </div>
            {displayedCrop && image.cropApplied ? (
                <span className={styles.fullResolution}>
                    原图截面 {naturalSize.width}×{naturalSize.height} px
                </span>
            ) : null}
            {tool === "crop" ? (
                <div className={styles.guide}>
                    在总览上拖出长方形，只框选磨平后的样芯截面；松开后会从 TIFF 原图提取该区域。
                </div>
            ) : (scanState.anchors.length < 2 ? (
                <div className={styles.guide}>
                    从最新的整十年标记开始，按年代向前依次点击；至少标注两个点后才会显示在 header。
                </div>
            ) : null)}
        </div>
    );
}
