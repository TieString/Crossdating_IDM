import type {
    TreeRingScanAnchor,
    TreeRingScanCrop,
    TreeRingScanRotation,
} from "./types";

export const normalizeTreeRingScanRotation = (rotation: number): TreeRingScanRotation => (
    (((rotation % 360) + 360) % 360) as TreeRingScanRotation
);

export const rotateTreeRingScanPoint = (
    xRatio: number,
    yRatio: number,
    clockwiseDegrees: TreeRingScanRotation,
): { xRatio: number; yRatio: number } => {
    switch (clockwiseDegrees) {
        case 90:
            return { xRatio: 1 - yRatio, yRatio: xRatio };
        case 180:
            return { xRatio: 1 - xRatio, yRatio: 1 - yRatio };
        case 270:
            return { xRatio: yRatio, yRatio: 1 - xRatio };
        default:
            return { xRatio, yRatio };
    }
};

export const rotateTreeRingScanAnchors = (
    anchors: readonly TreeRingScanAnchor[],
    from: TreeRingScanRotation,
    to: TreeRingScanRotation,
): TreeRingScanAnchor[] => {
    const delta = normalizeTreeRingScanRotation(to - from);
    return anchors.map((anchor) => ({
        ...anchor,
        ...rotateTreeRingScanPoint(anchor.xRatio, anchor.yRatio, delta),
    }));
};

/** Convert a rectangle in original image coordinates to the currently rotated overview. */
export const originalTreeRingScanCropToDisplay = (
    crop: TreeRingScanCrop,
    rotation: TreeRingScanRotation,
): TreeRingScanCrop => {
    switch (rotation) {
        case 90:
            return {
                xRatio: 1 - crop.yRatio - crop.heightRatio,
                yRatio: crop.xRatio,
                widthRatio: crop.heightRatio,
                heightRatio: crop.widthRatio,
            };
        case 180:
            return {
                xRatio: 1 - crop.xRatio - crop.widthRatio,
                yRatio: 1 - crop.yRatio - crop.heightRatio,
                widthRatio: crop.widthRatio,
                heightRatio: crop.heightRatio,
            };
        case 270:
            return {
                xRatio: crop.yRatio,
                yRatio: 1 - crop.xRatio - crop.widthRatio,
                widthRatio: crop.heightRatio,
                heightRatio: crop.widthRatio,
            };
        default:
            return { ...crop };
    }
};

/** Convert a freely drawn rectangle on the rotated overview back to original TIFF coordinates. */
export const displayTreeRingScanCropToOriginal = (
    crop: TreeRingScanCrop,
    rotation: TreeRingScanRotation,
): TreeRingScanCrop => {
    switch (rotation) {
        case 90:
            return {
                xRatio: crop.yRatio,
                yRatio: 1 - crop.xRatio - crop.widthRatio,
                widthRatio: crop.heightRatio,
                heightRatio: crop.widthRatio,
            };
        case 180:
            return {
                xRatio: 1 - crop.xRatio - crop.widthRatio,
                yRatio: 1 - crop.yRatio - crop.heightRatio,
                widthRatio: crop.widthRatio,
                heightRatio: crop.heightRatio,
            };
        case 270:
            return {
                xRatio: 1 - crop.yRatio - crop.heightRatio,
                yRatio: crop.xRatio,
                widthRatio: crop.heightRatio,
                heightRatio: crop.widthRatio,
            };
        default:
            return { ...crop };
    }
};

export const rotatedTreeRingScanSize = (
    width: number,
    height: number,
    rotation: TreeRingScanRotation,
) => rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width, height };

