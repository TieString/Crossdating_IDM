export type WidthGridHoverSide = "left" | "right";

export function resolveWidthGridHoverSide(
    clientX: number,
    cellLeft: number,
    cellWidth: number,
): WidthGridHoverSide {
    return clientX - cellLeft < cellWidth / 2 ? "left" : "right";
}
