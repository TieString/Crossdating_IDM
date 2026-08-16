import type { TreeRingGeometry } from "./treeRingArtwork";
import { getTreeRingFeature } from "./treeRingArtwork";

interface TreeRingSvgOverlayProps {
    geometry: TreeRingGeometry;
    highlightedYear?: number;
}

/** Lightweight dynamic markers layered over the cached SVG artwork. */
export function TreeRingSvgOverlay({ geometry, highlightedYear }: TreeRingSvgOverlayProps) {
    const centre = geometry.radiusMm;
    const highlighted = getTreeRingFeature(geometry, highlightedYear);

    return (
        <g pointerEvents="none">
            {geometry.gaps.map((gap) => (
                <g key={`gap-${gap.startYear}-${gap.endYear}`}>
                    <title>
                        {gap.startYear === gap.endYear
                            ? `${gap.startYear} 年缺少宽度记录`
                            : `${gap.startYear}–${gap.endYear} 共 ${gap.yearCount} 年缺少宽度记录`}
                    </title>
                    <circle
                        cx={centre}
                        cy={centre}
                        r={gap.radiusMm}
                        fill="none"
                        stroke="rgba(220, 38, 38, 0.22)"
                        strokeWidth={7}
                        vectorEffect="non-scaling-stroke"
                    />
                    <circle
                        cx={centre}
                        cy={centre}
                        r={gap.radiusMm}
                        fill="none"
                        stroke="#dc2626"
                        strokeWidth={2}
                        strokeDasharray="4 3"
                        vectorEffect="non-scaling-stroke"
                    />
                </g>
            ))}

            {geometry.rings.filter((ring) => ring.widthMm === 0).map((ring) => (
                <circle
                    key={`zero-${ring.year}`}
                    cx={centre}
                    cy={centre}
                    r={ring.outerRadiusMm}
                    fill="none"
                    stroke="#d97706"
                    strokeWidth={2}
                    strokeDasharray="2 2"
                    vectorEffect="non-scaling-stroke"
                >
                    <title>{ring.year} 年为显式 0 宽缺轮</title>
                </circle>
            ))}

            {highlighted ? (
                <g>
                    {highlighted.kind === "ring" && highlighted.outerRadiusMm > highlighted.innerRadiusMm ? (
                        <circle
                            cx={centre}
                            cy={centre}
                            r={highlighted.centreRadiusMm}
                            fill="none"
                            stroke="#ffd400"
                            strokeOpacity={0.62}
                            strokeWidth={highlighted.outerRadiusMm - highlighted.innerRadiusMm}
                        />
                    ) : (
                        <circle
                            cx={centre}
                            cy={centre}
                            r={highlighted.centreRadiusMm}
                            fill="none"
                            stroke="#ffd400"
                            strokeWidth={9}
                            vectorEffect="non-scaling-stroke"
                        />
                    )}
                    <circle
                        cx={centre}
                        cy={centre}
                        r={highlighted.outerRadiusMm}
                        fill="none"
                        stroke="#ff3b30"
                        strokeWidth={2.5}
                        vectorEffect="non-scaling-stroke"
                    />
                    {highlighted.kind === "ring" && highlighted.innerRadiusMm > 0 ? (
                        <circle
                            cx={centre}
                            cy={centre}
                            r={highlighted.innerRadiusMm}
                            fill="none"
                            stroke="#ff3b30"
                            strokeWidth={1.5}
                            vectorEffect="non-scaling-stroke"
                        />
                    ) : null}
                </g>
            ) : null}
        </g>
    );
}

