export type FileCorrelationBand =
    | "from060To070"
    | "from070To080"
    | "atLeast080";

export type FileCorrelationBandCounts = Record<FileCorrelationBand, number>;

export const parseFileCorrelationBandCounts = (
    input: string,
): FileCorrelationBandCounts | null => {
    const values = input
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map(Number);
    if (values.length === 0) return null;
    if (values.length !== 3
        || values.some((value) => !Number.isInteger(value) || value < 0)) {
        throw new Error("file correlation band counts must be three non-negative integers");
    }
    return {
        from060To070: values[0],
        from070To080: values[1],
        atLeast080: values[2],
    };
};

export const fileCorrelationBandFor = (
    correlation: number,
): FileCorrelationBand | null => {
    if (correlation >= 0.6 && correlation < 0.7) return "from060To070";
    if (correlation >= 0.7 && correlation < 0.8) return "from070To080";
    if (correlation >= 0.8) return "atLeast080";
    return null;
};

export const hasTargetExcludedReferenceCapacity = (
    eligibleCoreCount: number,
    minimumTargetExcludedReferenceCores: number,
): boolean => eligibleCoreCount - 1 >= minimumTargetExcludedReferenceCores;
