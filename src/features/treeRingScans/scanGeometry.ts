import type { TreeRingScanAnchor, TreeRingScanSeriesState } from "./types";

export interface TreeRingScanYearPosition {
    originalYear: number;
    xRatio: number;
    width: number;
}

const clamp = (value: number, minimum: number, maximum: number) => (
    Math.min(maximum, Math.max(minimum, value))
);

const sortedAnchors = (anchors: readonly TreeRingScanAnchor[]) => (
    [...anchors].sort((left, right) => left.originalYear - right.originalYear)
);

const baselineWidthMap = (scanState: TreeRingScanSeriesState) => (
    new Map(scanState.baselineWidths ?? [])
);

const calendarDistance = (leftYear: number, rightYear: number): number => (
    Math.max(1, Math.abs(rightYear - leftYear))
);

const physicalDistance = (
    widths: ReadonlyMap<number, number>,
    leftYear: number,
    rightYear: number,
): number => {
    const start = Math.min(leftYear, rightYear);
    const end = Math.max(leftYear, rightYear);
    let total = 0;
    for (let year = start + 1; year <= end; year += 1) {
        total += Math.max(0, widths.get(year) ?? 0);
    }
    return total;
};

const fractionBetweenYears = (
    widths: ReadonlyMap<number, number>,
    startYear: number,
    endYear: number,
    targetYear: number,
): number => {
    if (startYear === endYear) return 0;
    const low = Math.min(startYear, endYear);
    const high = Math.max(startYear, endYear);
    const target = clamp(targetYear, low, high);
    const totalWidth = physicalDistance(widths, low, high);
    const calendarFraction = (target - low) / (high - low);
    if (!(totalWidth > 0)) return calendarFraction;
    const physicalFraction = physicalDistance(widths, low, target) / totalWidth;
    return startYear <= endYear ? physicalFraction : 1 - physicalFraction;
};

/** Interpolate a physical image x-coordinate from decade anchors and baseline widths. */
export function getTreeRingScanXRatioForOriginalYear(
    scanState: TreeRingScanSeriesState,
    originalYear: number,
): number | null {
    const anchors = sortedAnchors(scanState.anchors);
    if (anchors.length === 0) return null;
    if (anchors.length === 1) return anchors[0].xRatio;
    const widths = baselineWidthMap(scanState);

    let left = anchors[0];
    let right = anchors[1];
    if (originalYear >= anchors[anchors.length - 1].originalYear) {
        left = anchors[anchors.length - 2];
        right = anchors[anchors.length - 1];
    } else if (originalYear > anchors[0].originalYear) {
        for (let index = 1; index < anchors.length; index += 1) {
            if (originalYear <= anchors[index].originalYear) {
                left = anchors[index - 1];
                right = anchors[index];
                break;
            }
        }
    }

    const boundedYear = clamp(originalYear, left.originalYear, right.originalYear);
    const boundedFraction = fractionBetweenYears(
        widths,
        left.originalYear,
        right.originalYear,
        boundedYear,
    );
    let ratio = left.xRatio + (right.xRatio - left.xRatio) * boundedFraction;

    if (originalYear < left.originalYear || originalYear > right.originalYear) {
        const anchorDistance = physicalDistance(widths, left.originalYear, right.originalYear);
        const perYearFallback = calendarDistance(left.originalYear, right.originalYear);
        const targetDistance = originalYear < left.originalYear
            ? physicalDistance(widths, originalYear, left.originalYear)
            : physicalDistance(widths, right.originalYear, originalYear);
        const multiplier = (anchorDistance > 0 ? targetDistance / anchorDistance : (
            Math.abs(originalYear - (originalYear < left.originalYear ? left.originalYear : right.originalYear)) / perYearFallback
        ));
        ratio = originalYear < left.originalYear
            ? left.xRatio - (right.xRatio - left.xRatio) * multiplier
            : right.xRatio + (right.xRatio - left.xRatio) * multiplier;
    }
    return clamp(ratio, 0, 1);
}

export function buildTreeRingScanYearPositions(
    scanState: TreeRingScanSeriesState,
): TreeRingScanYearPosition[] {
    const startYear = scanState.baselineStartYear;
    const endYear = scanState.baselineEndYear;
    if (startYear === undefined || endYear === undefined || scanState.anchors.length < 2) return [];
    const widths = baselineWidthMap(scanState);
    const positions: TreeRingScanYearPosition[] = [];
    for (let year = startYear; year <= endYear; year += 1) {
        if (!widths.has(year)) continue;
        const xRatio = getTreeRingScanXRatioForOriginalYear(scanState, year);
        if (xRatio === null) continue;
        positions.push({ originalYear: year, xRatio, width: widths.get(year) ?? 0 });
    }
    return positions;
}

export function resolveTreeRingScanOriginalYearAtX(
    positions: readonly TreeRingScanYearPosition[],
    xRatio: number,
): number | null {
    let best: TreeRingScanYearPosition | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const position of positions) {
        const distance = Math.abs(position.xRatio - xRatio);
        if (distance < bestDistance) {
            best = position;
            bestDistance = distance;
        }
    }
    return best?.originalYear ?? null;
}

/** Estimate ten physical millimetres in scan pixels from anchored decade spans. */
export function estimateTreeRingScanBandHeightPixels(
    scanState: TreeRingScanSeriesState,
    naturalWidth: number,
    naturalHeight: number,
): number {
    const anchors = sortedAnchors(scanState.anchors);
    const widths = baselineWidthMap(scanState);
    const pixelsPerMillimetre: number[] = [];
    for (let index = 1; index < anchors.length; index += 1) {
        const previous = anchors[index - 1];
        const current = anchors[index];
        const widthUnits = physicalDistance(widths, previous.originalYear, current.originalYear);
        if (!(widthUnits > 0)) continue;
        const pixelDistance = Math.abs(current.xRatio - previous.xRatio) * naturalWidth;
        if (pixelDistance > 0) pixelsPerMillimetre.push(pixelDistance / (widthUnits / 1000));
    }
    pixelsPerMillimetre.sort((left, right) => left - right);
    const median = pixelsPerMillimetre.length > 0
        ? pixelsPerMillimetre[Math.floor(pixelsPerMillimetre.length / 2)]
        : naturalHeight / 10;
    return clamp(median * 10, Math.max(4, naturalHeight * 0.02), naturalHeight);
}

export function getTreeRingScanBandCenterYRatio(scanState: TreeRingScanSeriesState): number {
    if (scanState.anchors.length === 0) return 0.5;
    const ordered = scanState.anchors.map((anchor) => anchor.yRatio).sort((left, right) => left - right);
    return ordered[Math.floor(ordered.length / 2)];
}
