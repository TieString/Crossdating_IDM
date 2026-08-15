import type { DeleteRangeFill } from "@/features/rwl/edit";

export interface RangeDeleteShiftTarget {
    sourceYear: number;
    targetYear: number;
}

export interface RangeDeleteAnimationPlan {
    animationSide: "left" | "right";
    anchorTargetYear: number;
    yearOffset: number;
    shiftTargets: RangeDeleteShiftTarget[];
}

/**
 * Builds the side-fill motion for a range delete; keeping the range missing has
 * no shift plan. Final years reflect the full deleted range, while each visual
 * source stays adjacent to its target so the animation matches a single delete.
 */
export function createRangeDeleteAnimationPlan(
    sourceYears: Iterable<number>,
    selectedStartYear: number,
    selectedEndYear: number,
    fill: DeleteRangeFill,
): RangeDeleteAnimationPlan | null {
    if (fill === "missing") return null;

    const startYear = Math.min(selectedStartYear, selectedEndYear);
    const endYear = Math.max(selectedStartYear, selectedEndYear);
    const rangeLength = endYear - startYear + 1;
    const yearOffset = fill === "left" ? rangeLength : -rangeLength;
    const visualStep = Math.sign(yearOffset);
    const years = Array.from(new Set(sourceYears))
        .filter((year) => fill === "left" ? year < startYear : year > endYear)
        .sort((yearA, yearB) => yearA - yearB);

    return {
        animationSide: fill,
        anchorTargetYear: fill === "left" ? endYear : startYear,
        yearOffset,
        shiftTargets: years.map((dataSourceYear) => {
            const targetYear = dataSourceYear + yearOffset;
            return {
                sourceYear: targetYear - visualStep,
                targetYear,
            };
        }),
    };
}
