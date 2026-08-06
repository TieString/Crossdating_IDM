export type ItrdbValidationSplit = "development" | "calibration" | "final";

export type ItrdbEndpointStratum =
    | "older_14_29"
    | "interior_30_plus"
    | "newer_15_29"
    | "newer_2_14";

export const ITRDB_VALIDATION_PROTOCOL = Object.freeze({
    schemaVersion: 1,
    protocolVersion: "itrdb-js-event-generalization-v1",
    seed: "2026-08-06-task4-v1",
    splitBuckets: Object.freeze({
        development: Object.freeze([0, 1, 2, 3, 4, 5]),
        calibration: Object.freeze([6, 7]),
        final: Object.freeze([8, 9]),
    }),
    inclusion: Object.freeze({
        minimumInjectedSeriesLength: 150,
        minimumNaturalSeriesLength: 120,
        minimumReferenceOverlapYears: 80,
        minimumReferenceCount: 5,
        minimumOlderContextYears: 14,
        minimumNewerContextYears: 2,
        maximumNaturalZeroDensity: 0.1,
    }),
    formalHoldout: Object.freeze({
        filesPerSplit: 320,
        casesPerSplit: 240,
        offset: 8,
        skipPartialTruth: true,
    }),
    supplementary: Object.freeze({
        naturalSingleCasesPerSplit: 80,
        separatedMultiCasesPerSplit: 45,
        adjacentMultiCasesPerSplit: 45,
        crossSeriesCasesPerSplit: 35,
        naturalBootstrapSitesPerSplit: 6,
        separatedMissingCount: 3,
        adjacentMissingCount: 2,
        minimumSeparatedEventSpacingYears: 12,
        maximumNaturalBootstrapTruths: 24,
        maximumAutomaticWrongApplications: 4,
    }),
});

export const normalizeItrdbRelativePath = (value: string): string => (
    value.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase()
);

export const stableItrdbPathHash = (value: string): number => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
};

export const itrdbSplitForRelativePath = (relativePath: string): ItrdbValidationSplit => {
    const bucket = stableItrdbPathHash(normalizeItrdbRelativePath(relativePath)) % 10;
    if (bucket <= 5) return "development";
    if (bucket <= 7) return "calibration";
    return "final";
};

export const itrdbDatasetGroup = (relativePath: string): string => {
    const normalized = normalizeItrdbRelativePath(relativePath);
    const separator = normalized.indexOf("/");
    return separator < 0 ? "root" : normalized.slice(0, separator);
};

export const itrdbEndpointStratum = (
    olderContextYears: number,
    newerContextYears: number,
): ItrdbEndpointStratum => {
    if (newerContextYears <= 14) return "newer_2_14";
    if (newerContextYears <= 29) return "newer_15_29";
    if (olderContextYears <= 29) return "older_14_29";
    return "interior_30_plus";
};

export const itrdbSeriesLengthStratum = (length: number): string => {
    if (length < 200) return "years_120_199";
    if (length < 400) return "years_200_399";
    return "years_400_plus";
};

export const itrdbReferenceDepthStratum = (count: number): string => {
    if (count < 10) return "refs_5_9";
    if (count < 20) return "refs_10_19";
    return "refs_20_plus";
};

export const itrdbEventSpacingStratum = (years: number[]): string => {
    if (years.length < 2) return "single";
    const sorted = [...years].sort((left, right) => left - right);
    let minimum = Infinity;
    for (let index = 1; index < sorted.length; index += 1) {
        minimum = Math.min(minimum, sorted[index] - sorted[index - 1]);
    }
    if (minimum === 1) return "adjacent_1";
    if (minimum <= 10) return "near_2_10";
    return "separated_11_plus";
};
