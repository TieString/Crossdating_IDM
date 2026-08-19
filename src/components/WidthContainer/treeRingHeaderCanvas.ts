import {
    getTreeRingFeature,
    TREE_RING_BOUNDARY_WIDTH_MM,
    TREE_RING_DOT_PATTERN_SPECS,
    TREE_RING_DOT_SPACING_SCALE,
    TREE_RING_LATEWOOD_RATIO,
    type TreeRingGeometry,
} from "./treeRingArtwork";

interface TreeRingHeaderCanvasOptions {
    cssWidth: number;
    cssHeight: number;
    pixelRatio: number;
    startX: number;
    viewTop: number;
    viewWidth: number;
    viewHeight: number;
    highlightedYear?: number;
}

interface PatternViewport {
    deviceScale: number;
    startX: number;
    viewTop: number;
}

function createLatewoodPatterns(
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    viewport: PatternViewport,
): Array<CanvasPattern | string> {
    const ownerDocument = canvas.ownerDocument;
    const Matrix = ownerDocument.defaultView?.DOMMatrix;

    return TREE_RING_DOT_PATTERN_SPECS.map(([, tileSize, dots]) => {
        const tileSizeMm = tileSize * TREE_RING_DOT_SPACING_SCALE;
        const desiredTilePixels = Math.max(0.01, tileSizeMm * viewport.deviceScale);
        const tilePixels = Math.max(1, Math.ceil(desiredTilePixels));
        const tileCanvas = ownerDocument.createElement("canvas");
        tileCanvas.width = tilePixels;
        tileCanvas.height = tilePixels;
        const tileContext = tileCanvas.getContext("2d");
        if (!tileContext) return "#000000";

        tileContext.fillStyle = "#000000";
        dots.forEach(([x, y, radius]) => {
            tileContext.beginPath();
            tileContext.arc(
                x * TREE_RING_DOT_SPACING_SCALE / tileSizeMm * tilePixels,
                y * TREE_RING_DOT_SPACING_SCALE / tileSizeMm * tilePixels,
                Math.max(0.01, radius / tileSizeMm * tilePixels),
                0,
                Math.PI * 2,
            );
            tileContext.fill();
        });

        const pattern = context.createPattern(tileCanvas, "repeat");
        if (!pattern) return "#000000";
        if (Matrix && typeof pattern.setTransform === "function") {
            const matrix = new Matrix();
            matrix.translateSelf(
                -viewport.startX * viewport.deviceScale,
                -viewport.viewTop * viewport.deviceScale,
            );
            const scale = desiredTilePixels / tilePixels;
            matrix.scaleSelf(scale, scale);
            pattern.setTransform(matrix);
        }
        return pattern;
    });
}

/**
 * Draw the generated header and floating 1 cm view with the same physical styling as the former
 * SVG: six nested latewood dot patterns, 0.18 mm boundaries, and screen-sized event overlays.
 */
export function drawTreeRingHeaderCanvas(
    canvas: HTMLCanvasElement,
    geometry: TreeRingGeometry,
    options: TreeRingHeaderCanvasOptions,
): void {
    const {
        cssWidth,
        cssHeight,
        pixelRatio,
        startX,
        viewTop,
        viewWidth,
        viewHeight,
        highlightedYear,
    } = options;
    if (!(cssWidth > 0) || !(cssHeight > 0) || !(viewWidth > 0) || !(viewHeight > 0)) return;

    const ratio = Math.max(1, pixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(cssWidth * ratio));
    const pixelHeight = Math.max(1, Math.round(cssHeight * ratio));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, pixelWidth, pixelHeight);
    context.save();
    context.beginPath();
    context.rect(0, 0, pixelWidth, pixelHeight);
    context.clip();

    const deviceScale = pixelWidth / viewWidth;
    const centreX = (geometry.radiusMm - startX) * deviceScale;
    const centreY = (geometry.radiusMm - viewTop) * deviceScale;
    const visibleMinRadius = Math.max(0, startX - geometry.radiusMm - 2 / deviceScale);
    const visibleMaxRadius = Math.min(
        geometry.radiusMm,
        startX + viewWidth - geometry.radiusMm + 2 / deviceScale,
    );
    const latewoodPatterns = createLatewoodPatterns(canvas, context, {
        deviceScale,
        startX,
        viewTop,
    });

    let innerRadius = 0;
    geometry.rings.forEach((ring) => {
        const outerRadius = ring.outerRadiusMm;
        const ringWidth = Math.max(0, outerRadius - innerRadius);
        if (outerRadius >= visibleMinRadius && innerRadius <= visibleMaxRadius && ringWidth > 0) {
            const latewoodWidth = ringWidth * TREE_RING_LATEWOOD_RATIO;
            const latewoodStart = outerRadius - latewoodWidth;
            latewoodPatterns.forEach((pattern, level) => {
                const bandInner = latewoodStart
                    + latewoodWidth * (level / latewoodPatterns.length);
                const bandWidth = outerRadius - bandInner;
                if (!(bandWidth > 0)) return;
                context.beginPath();
                context.arc(
                    centreX,
                    centreY,
                    (bandInner + bandWidth / 2) * deviceScale,
                    0,
                    Math.PI * 2,
                );
                context.strokeStyle = pattern;
                context.lineWidth = bandWidth * deviceScale;
                context.stroke();
            });

            context.beginPath();
            context.arc(centreX, centreY, outerRadius * deviceScale, 0, Math.PI * 2);
            context.strokeStyle = "#000000";
            context.lineWidth = TREE_RING_BOUNDARY_WIDTH_MM * deviceScale;
            context.setLineDash([]);
            context.stroke();
        }
        innerRadius = outerRadius;
    });

    const drawCircle = (
        radiusMm: number,
        color: string,
        lineWidthCssPixels: number,
        dashCssPixels: number[] = [],
    ) => {
        if (radiusMm < visibleMinRadius || radiusMm > visibleMaxRadius) return;
        context.beginPath();
        context.arc(centreX, centreY, radiusMm * deviceScale, 0, Math.PI * 2);
        context.strokeStyle = color;
        context.lineWidth = lineWidthCssPixels * ratio;
        context.setLineDash(dashCssPixels.map((value) => value * ratio));
        context.stroke();
        context.setLineDash([]);
    };

    geometry.gaps.forEach((gap) => {
        drawCircle(gap.radiusMm, "rgba(220, 38, 38, 0.22)", 7);
        drawCircle(gap.radiusMm, "#dc2626", 2, [4, 3]);
    });
    geometry.rings.forEach((ring) => {
        if (ring.widthMm === 0) drawCircle(ring.outerRadiusMm, "#d97706", 2, [2, 2]);
    });

    const highlighted = getTreeRingFeature(geometry, highlightedYear);
    if (highlighted && highlighted.centreRadiusMm >= visibleMinRadius && highlighted.centreRadiusMm <= visibleMaxRadius) {
        context.beginPath();
        context.arc(centreX, centreY, highlighted.centreRadiusMm * deviceScale, 0, Math.PI * 2);
        context.strokeStyle = "rgba(255, 212, 0, 0.62)";
        context.lineWidth = highlighted.kind === "ring" && highlighted.outerRadiusMm > highlighted.innerRadiusMm
            ? (highlighted.outerRadiusMm - highlighted.innerRadiusMm) * deviceScale
            : 9 * ratio;
        context.stroke();
        drawCircle(highlighted.outerRadiusMm, "#ff3b30", 2.5);
        if (highlighted.kind === "ring" && highlighted.innerRadiusMm > 0) {
            drawCircle(highlighted.innerRadiusMm, "#ff3b30", 1.5);
        }
    }

    context.restore();
}
