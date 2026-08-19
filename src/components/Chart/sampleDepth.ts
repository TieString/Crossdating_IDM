export interface SampleDepthSeries {
    counts: Array<number | null>;
    max: number;
}

/** Build sample depth without drawing artificial zeroes outside observed coverage. */
export function buildSampleDepthSeries(
    years: readonly number[],
    coverageData: ReadonlyMap<string, ReadonlyMap<number, number | null>>,
    stopMarkerValue: number,
): SampleDepthSeries {
    let max = 0;
    const counts = years.map((year) => {
        let count = 0;
        coverageData.forEach((yearMap) => {
            const value = yearMap.get(year);
            if (
                typeof value === "number"
                && Number.isFinite(value)
                && value >= 0
                && value !== stopMarkerValue
            ) {
                count += 1;
            }
        });
        if (count === 0) return null;
        if (count > max) max = count;
        return count;
    });
    return { counts, max };
}
