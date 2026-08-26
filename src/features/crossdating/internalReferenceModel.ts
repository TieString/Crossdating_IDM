import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import {
    COFECHA_REFERENCE_DEFAULT_OPTIONS,
    classifyCofechaPart6Series,
    cofechaStyleStandardize,
    type CofechaPassReference,
    type CofechaReferencePoint,
    type CofechaArImplementation,
    type CofechaLogImplementation,
    type CofechaSplineImplementation,
    type ReferenceSeriesConfig,
} from "./reference";

export type InternalMasterMethod =
    | "mean"
    | "median"
    | "trimmed"
    | "weighted-mean"
    | "weighted-huber";

export type InternalTargetContribution = "exclude" | "include" | "compatibility-weighted";

export type InternalSeriesCompatibility = {
    seriesId: string;
    zeroCorrelation: number | null;
    bestCorrelation: number | null;
    bestLag: number;
    zeroLagDeficit: number | null;
    overlap: number;
    segmentZeroCorrelationMedian: number | null;
    segmentIncompatibleFraction: number | null;
    redundancyCount: number;
    referenceWeight: number;
};

export type InternalTargetCompatibilityFeatures = {
    zeroCorrelation: number | null;
    bestCorrelation: number | null;
    bestLag: number;
    zeroLagDeficit: number | null;
    overlap: number;
    segmentZeroCorrelationMedian: number | null;
    segmentZeroCorrelationMinimum: number | null;
    segmentIncompatibleFraction: number | null;
    segmentNonzeroLagFraction: number | null;
    perReferenceZeroCorrelationMedian: number | null;
    perReferenceZeroCorrelationQ25: number | null;
    perReferenceIncompatibleFraction: number | null;
    perReferenceNonzeroLagFraction: number | null;
    referenceCount: number;
    meanReferenceWeight: number;
};

export type InternalReferenceModel = {
    referenceConfig: ReferenceSeriesConfig;
    sourceCompatibility: InternalSeriesCompatibility[];
    targetCompatibility: InternalTargetCompatibilityFeatures;
    adaptiveBlendAudit?: InternalReferenceBlendAudit;
};

export type InternalReferenceBlendAudit = {
    applied: boolean;
    weight: number;
    reasons: Array<"anomaly_contrast_gain" | "reference_consensus_gain">;
    targetZeroCorrelationDelta: number | null;
    perReferenceIncompatibleFractionDelta: number | null;
    perReferenceZeroCorrelationMedianDelta: number | null;
};

export const INTERNAL_ADAPTIVE_PRE_SPLINE_BLEND_WEIGHT = 1 / 16;
const INTERNAL_ADAPTIVE_MIN_ANOMALY_CONTRAST_GAIN = 0.015;
const INTERNAL_ADAPTIVE_MAX_PAIR_CONFLICT_INCREASE = 0.06;
const INTERNAL_ADAPTIVE_MIN_PAIR_CONFLICT_REDUCTION = 0.1;
const INTERNAL_ADAPTIVE_MIN_PAIR_MEDIAN_GAIN = 0.04;

const finiteDelta = (next: number | null, previous: number | null) => (
    next !== null && previous !== null
        && Number.isFinite(next) && Number.isFinite(previous)
        ? next - previous
        : null
);

export const adjudicateAdaptiveInternalReferenceBlend = (
    post: InternalTargetCompatibilityFeatures,
    pre: InternalTargetCompatibilityFeatures,
): InternalReferenceBlendAudit => {
    const targetZeroCorrelationDelta = finiteDelta(
        pre.zeroCorrelation,
        post.zeroCorrelation,
    );
    const perReferenceIncompatibleFractionDelta = finiteDelta(
        pre.perReferenceIncompatibleFraction,
        post.perReferenceIncompatibleFraction,
    );
    const perReferenceZeroCorrelationMedianDelta = finiteDelta(
        pre.perReferenceZeroCorrelationMedian,
        post.perReferenceZeroCorrelationMedian,
    );
    const reasons: InternalReferenceBlendAudit["reasons"] = [];
    if (targetZeroCorrelationDelta !== null
        && targetZeroCorrelationDelta <= -INTERNAL_ADAPTIVE_MIN_ANOMALY_CONTRAST_GAIN
        && perReferenceIncompatibleFractionDelta !== null
        && perReferenceIncompatibleFractionDelta
            <= INTERNAL_ADAPTIVE_MAX_PAIR_CONFLICT_INCREASE) {
        reasons.push("anomaly_contrast_gain");
    }
    if (perReferenceIncompatibleFractionDelta !== null
        && perReferenceIncompatibleFractionDelta
            <= -INTERNAL_ADAPTIVE_MIN_PAIR_CONFLICT_REDUCTION
        && perReferenceZeroCorrelationMedianDelta !== null
        && perReferenceZeroCorrelationMedianDelta
            >= INTERNAL_ADAPTIVE_MIN_PAIR_MEDIAN_GAIN) {
        reasons.push("reference_consensus_gain");
    }
    return {
        applied: reasons.length > 0,
        weight: INTERNAL_ADAPTIVE_PRE_SPLINE_BLEND_WEIGHT,
        reasons,
        targetZeroCorrelationDelta,
        perReferenceIncompatibleFractionDelta,
        perReferenceZeroCorrelationMedianDelta,
    };
};

export const INTERNAL_COMPATIBILITY_FEATURE_NAMES = [
    "zeroCorrelation",
    "bestCorrelation",
    "absoluteBestLag",
    "zeroLagDeficit",
    "segmentZeroCorrelationMedian",
    "segmentZeroCorrelationMinimum",
    "segmentIncompatibleFraction",
    "segmentNonzeroLagFraction",
    "perReferenceZeroCorrelationMedian",
    "perReferenceZeroCorrelationQ25",
    "perReferenceIncompatibleFraction",
    "perReferenceNonzeroLagFraction",
    "logReferenceCount",
    "meanReferenceWeight",
] as const;

export type InternalCompatibilityLinearModel = {
    featureNames: readonly string[];
    means: readonly number[];
    scales: readonly number[];
    coefficients: readonly number[];
    intercept: number;
    threshold: number;
    safeStrictSuppressionThreshold?: number | null;
};

export const shouldSuppressInternalStrictSuggestion = (
    probability: number | null,
    hasStrictSuggestion: boolean,
    model: InternalCompatibilityLinearModel | undefined,
) => Boolean(
    hasStrictSuggestion
    && probability !== null
    && model?.safeStrictSuppressionThreshold !== null
    && model?.safeStrictSuppressionThreshold !== undefined
    && probability < model.safeStrictSuppressionThreshold
);

export const internalCompatibilityFeatureVector = (
    features: InternalTargetCompatibilityFeatures,
): number[] => {
    const finite = (value: number | null, fallback: number) => (
        value !== null && Number.isFinite(value) ? value : fallback
    );
    return [
        finite(features.zeroCorrelation, -0.2),
        finite(features.bestCorrelation, -0.2),
        Math.abs(finite(features.bestLag, 10)),
        finite(features.zeroLagDeficit, 1),
        finite(features.segmentZeroCorrelationMedian, -0.2),
        finite(features.segmentZeroCorrelationMinimum, -0.5),
        finite(features.segmentIncompatibleFraction, 1),
        finite(features.segmentNonzeroLagFraction, 1),
        finite(features.perReferenceZeroCorrelationMedian, -0.2),
        finite(features.perReferenceZeroCorrelationQ25, -0.3),
        finite(features.perReferenceIncompatibleFraction, 1),
        finite(features.perReferenceNonzeroLagFraction, 1),
        Math.log1p(Math.max(0, finite(features.referenceCount, 0))),
        finite(features.meanReferenceWeight, 0),
    ];
};

export const predictInternalTargetIncompatibility = (
    features: InternalTargetCompatibilityFeatures,
    model: InternalCompatibilityLinearModel,
): number => {
    if (model.featureNames.length !== INTERNAL_COMPATIBILITY_FEATURE_NAMES.length
        || !model.featureNames.every((name, index) => (
            name === INTERNAL_COMPATIBILITY_FEATURE_NAMES[index]
        ))
        || model.means.length !== model.featureNames.length
        || model.scales.length !== model.featureNames.length
        || model.coefficients.length !== model.featureNames.length) {
        throw new Error("internal compatibility model feature contract mismatch");
    }
    const vector = internalCompatibilityFeatureVector(features);
    const linear = model.intercept + vector.reduce((sum, value, index) => (
        sum + ((value - model.means[index]) / Math.max(1e-12, model.scales[index]))
            * model.coefficients[index]
    ), 0);
    return linear >= 0
        ? 1 / (1 + Math.exp(-linear))
        : Math.exp(linear) / (1 + Math.exp(linear));
};

export const scoreInternalTargetIncompatibility = (
    features: InternalTargetCompatibilityFeatures,
): number => {
    const zeroCorrelation = features.zeroCorrelation ?? -0.2;
    const segmentMinimum = features.segmentZeroCorrelationMinimum ?? -0.2;
    const segmentIncompatible = features.segmentIncompatibleFraction ?? 1;
    const perReferenceIncompatible = features.perReferenceIncompatibleFraction ?? 1;
    return 3 * Math.max(0, 0.72 - zeroCorrelation)
        + 2 * Math.max(0, 0.45 - segmentMinimum)
        + 2 * segmentIncompatible
        + perReferenceIncompatible;
};

export const setInternalTargetCandidate = (
    model: InternalReferenceModel,
    targetId: string,
    candidate: boolean,
): InternalReferenceModel => {
    const candidateSeriesIds = candidate ? [targetId] : [];
    const classification = model.referenceConfig.classification;
    const reference = model.referenceConfig.cofechaPassReference;
    return {
        ...model,
        referenceConfig: {
            ...model.referenceConfig,
            classification: classification ? {
                ...classification,
                anchorPassIds: candidate
                    ? classification.anchorPassIds.filter((seriesId) => seriesId !== targetId)
                    : Array.from(new Set([...classification.anchorPassIds, targetId])),
                candidateFlaggedIds: candidateSeriesIds,
                flaggedAIds: candidateSeriesIds,
            } : classification,
            cofechaPassReference: reference ? {
                ...reference,
                candidateSeriesIds,
            } : reference,
        },
    };
};

type ResidualSeries = {
    seriesId: string;
    values: Map<number, number>;
};

type CorrelationResult = {
    correlation: number | null;
    overlap: number;
};

const clamp = (value: number, minimum: number, maximum: number) => (
    Math.min(maximum, Math.max(minimum, value))
);

const mean = (values: readonly number[]) => (
    values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0
);

const standardDeviation = (values: readonly number[]) => {
    if (values.length < 2) return 0;
    const average = mean(values);
    return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
};

const quantile = (values: readonly number[], probability: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * clamp(probability, 0, 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower] ?? null;
    const fraction = position - lower;
    return (sorted[lower] ?? 0) * (1 - fraction) + (sorted[upper] ?? 0) * fraction;
};

const weightedMedian = (rows: Array<{ value: number; weight: number }>): number => {
    const sorted = [...rows].sort((left, right) => left.value - right.value);
    const total = sorted.reduce((sum, row) => sum + row.weight, 0);
    let cumulative = 0;
    for (const row of sorted) {
        cumulative += row.weight;
        if (cumulative >= total / 2) return row.value;
    }
    return sorted[sorted.length - 1]?.value ?? 0;
};

const correlationAtLag = (
    left: ReadonlyMap<number, number>,
    right: ReadonlyMap<number, number>,
    lag: number,
    minimumOverlap: number,
): CorrelationResult => {
    let overlap = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    left.forEach((x, year) => {
        const y = right.get(year + lag);
        if (y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return;
        overlap += 1;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
    });
    if (overlap < minimumOverlap) return { correlation: null, overlap };
    const numerator = sxy - sx * sy / overlap;
    const denominator = Math.sqrt(
        Math.max(0, sxx - sx * sx / overlap)
        * Math.max(0, syy - sy * sy / overlap),
    );
    return {
        correlation: denominator > 0 ? numerator / denominator : null,
        overlap,
    };
};

const lagProfile = (
    left: ReadonlyMap<number, number>,
    right: ReadonlyMap<number, number>,
    minimumOverlap = 30,
    lagRadius = 10,
) => {
    const zero = correlationAtLag(left, right, 0, minimumOverlap);
    let bestCorrelation = zero.correlation;
    let bestLag = 0;
    for (let lag = -lagRadius; lag <= lagRadius; lag += 1) {
        const current = correlationAtLag(left, right, lag, minimumOverlap);
        if (current.correlation !== null
            && (bestCorrelation === null || current.correlation > bestCorrelation)) {
            bestCorrelation = current.correlation;
            bestLag = lag;
        }
    }
    return {
        zeroCorrelation: zero.correlation,
        bestCorrelation,
        bestLag,
        zeroLagDeficit: zero.correlation !== null && bestCorrelation !== null
            ? bestCorrelation - zero.correlation
            : null,
        overlap: zero.overlap,
    };
};

const standardizeTree = (
    tree: RwlTreeData,
    normalizeResidual: boolean,
    splineImplementation: CofechaSplineImplementation,
    arImplementation: CofechaArImplementation,
    logImplementation: CofechaLogImplementation,
    preSplineResidualBlendWeight: number | null,
): Map<number, number> => {
    const generate = (implementation: CofechaLogImplementation) => (
        cofechaStyleStandardize(
            tree,
            COFECHA_REFERENCE_DEFAULT_OPTIONS,
            splineImplementation,
            arImplementation,
            1,
            "ratio",
            implementation,
        )
    );
    const normalize = (points: ReturnType<typeof generate>) => {
        if (points.length === 0) return new Map<number, number>();
        const values = points.map((point) => point.value);
        const average = mean(values);
        const scale = standardDeviation(values) || 1;
        return new Map(points.map((point) => [
            point.year,
            (point.value - average) / scale,
        ]));
    };
    if (preSplineResidualBlendWeight !== null) {
        const weight = clamp(preSplineResidualBlendWeight, 0, 1);
        const post = normalize(generate("post-ar"));
        const pre = normalize(generate("pre-spline-residual"));
        return new Map(Array.from(post).flatMap(([year, postValue]) => {
            const preValue = pre.get(year);
            return preValue === undefined
                ? []
                : [[year, (1 - weight) * postValue + weight * preValue] as const];
        }));
    }
    const points = generate(logImplementation);
    if (!normalizeResidual || points.length === 0) {
        return new Map(points.map((point) => [point.year, point.value]));
    }
    return normalize(points);
};

const aggregateUnweightedMedian = (series: readonly ResidualSeries[]) => {
    const valuesByYear = new Map<number, number[]>();
    series.forEach((row) => row.values.forEach((value, year) => {
        valuesByYear.set(year, [...valuesByYear.get(year) ?? [], value]);
    }));
    return new Map(Array.from(valuesByYear, ([year, values]) => [
        year,
        quantile(values, 0.5) ?? 0,
    ]));
};

const segmentProfiles = (
    target: ReadonlyMap<number, number>,
    reference: ReadonlyMap<number, number>,
) => {
    const years = Array.from(target.keys()).sort((left, right) => left - right);
    if (years.length === 0) return [];
    const profiles: ReturnType<typeof lagProfile>[] = [];
    for (let start = years[0]!; start + 49 <= years[years.length - 1]!; start += 25) {
        const segment = new Map(Array.from(target).filter(([year]) => (
            year >= start && year <= start + 49
        )));
        const profile = lagProfile(segment, reference, 25);
        if (profile.zeroCorrelation !== null) profiles.push(profile);
    }
    return profiles;
};

const summarizeCompatibility = (
    seriesId: string,
    values: ReadonlyMap<number, number>,
    preliminaryMaster: ReadonlyMap<number, number>,
    redundancyCount: number,
): InternalSeriesCompatibility => {
    const profile = lagProfile(values, preliminaryMaster);
    const segments = segmentProfiles(values, preliminaryMaster);
    const segmentZero = segments.flatMap((row) => (
        row.zeroCorrelation === null ? [] : [row.zeroCorrelation]
    ));
    const incompatibleSegments = segments.filter((row) => (
        row.bestLag !== 0 && (row.zeroLagDeficit ?? 0) >= 0.04
    )).length;
    const correlationQuality = profile.zeroCorrelation === null
        ? 0
        : clamp((profile.zeroCorrelation - 0.05) / 0.5, 0, 1);
    const lagPenalty = Math.exp(-12 * Math.max(0, (profile.zeroLagDeficit ?? 0) - 0.015));
    const segmentStability = segments.length > 0
        ? 1 - incompatibleSegments / segments.length
        : 0.5;
    const redundancyWeight = 1 / Math.sqrt(Math.max(1, redundancyCount));
    return {
        seriesId,
        ...profile,
        segmentZeroCorrelationMedian: quantile(segmentZero, 0.5),
        segmentIncompatibleFraction: segments.length > 0
            ? incompatibleSegments / segments.length
            : null,
        redundancyCount,
        referenceWeight: clamp(
            correlationQuality
            * lagPenalty
            * (0.35 + 0.65 * segmentStability)
            * redundancyWeight,
            0.02,
            1,
        ),
    };
};

const redundancyCounts = (series: readonly ResidualSeries[]) => new Map(
    series.map((left) => {
        const count = series.filter((right) => {
            if (left.seriesId === right.seriesId) return false;
            const profile = lagProfile(left.values, right.values, 50);
            return profile.zeroCorrelation !== null
                && profile.zeroCorrelation >= 0.8
                && (profile.zeroLagDeficit ?? Infinity) <= 0.02;
        }).length;
        return [left.seriesId, count + 1] as const;
    }),
);

const aggregateYear = (
    rows: Array<{ value: number; weight: number }>,
    method: InternalMasterMethod,
): number => {
    if (method === "mean") return mean(rows.map((row) => row.value));
    if (method === "median") return quantile(rows.map((row) => row.value), 0.5) ?? 0;
    if (method === "trimmed") {
        const sorted = rows.map((row) => row.value).sort((left, right) => left - right);
        const trim = sorted.length >= 10 ? Math.floor(sorted.length * 0.1) : 0;
        return mean(sorted.slice(trim, sorted.length - trim));
    }
    if (method === "weighted-mean") {
        const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
        return rows.reduce((sum, row) => sum + row.value * row.weight, 0)
            / Math.max(1e-9, totalWeight);
    }
    const center = weightedMedian(rows);
    const deviations = rows.map((row) => ({
        value: Math.abs(row.value - center),
        weight: row.weight,
    }));
    const scale = 1.4826 * weightedMedian(deviations);
    const limit = Math.max(1e-6, 1.5 * scale);
    const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
    return rows.reduce((sum, row) => (
        sum + clamp(row.value, center - limit, center + limit) * row.weight
    ), 0) / Math.max(1e-9, totalWeight);
};

const buildMasterPoints = (
    series: readonly ResidualSeries[],
    qualityById: ReadonlyMap<string, InternalSeriesCompatibility>,
    method: InternalMasterMethod,
): CofechaReferencePoint[] => {
    const valuesByYear = new Map<number, Array<{ value: number; weight: number }>>();
    series.forEach((row) => row.values.forEach((value, year) => {
        const weight = qualityById.get(row.seriesId)?.referenceWeight ?? 1;
        valuesByYear.set(year, [...valuesByYear.get(year) ?? [], { value, weight }]);
    }));
    const raw = Array.from(valuesByYear)
        .filter(([, values]) => values.length >= COFECHA_REFERENCE_DEFAULT_OPTIONS.minReplication)
        .sort(([left], [right]) => left - right)
        .map(([year, values]) => ({
            year,
            values,
            value: aggregateYear(values, method),
        }));
    const rawValues = raw.map((row) => row.value);
    const average = mean(rawValues);
    const standardizer = standardDeviation(rawValues) || 1;
    return raw.map((row) => {
        const values = row.values.map((entry) => entry.value);
        const sd = standardDeviation(values) / standardizer;
        return {
            year: row.year,
            value: (row.value - average) / standardizer,
            replication: row.values.length,
            sd,
            se: sd / Math.sqrt(row.values.length),
            weight: Math.min(
                1,
                row.values.reduce((sum, entry) => sum + entry.weight, 0)
                    / COFECHA_REFERENCE_DEFAULT_OPTIONS.targetReplication,
            ),
        };
    });
};

const targetFeatures = (
    target: ReadonlyMap<number, number>,
    master: ReadonlyMap<number, number>,
    references: readonly ResidualSeries[],
    sourceCompatibility: readonly InternalSeriesCompatibility[],
): InternalTargetCompatibilityFeatures => {
    const profile = lagProfile(target, master);
    const segments = segmentProfiles(target, master);
    const segmentZero = segments.flatMap((row) => (
        row.zeroCorrelation === null ? [] : [row.zeroCorrelation]
    ));
    const pairProfiles = references
        .map((row) => lagProfile(target, row.values, 30))
        .filter((row) => row.zeroCorrelation !== null);
    const pairZero = pairProfiles.map((row) => row.zeroCorrelation!);
    const incompatible = (row: ReturnType<typeof lagProfile>) => (
        row.bestLag !== 0 && (row.zeroLagDeficit ?? 0) >= 0.04
    );
    return {
        ...profile,
        segmentZeroCorrelationMedian: quantile(segmentZero, 0.5),
        segmentZeroCorrelationMinimum: segmentZero.length > 0 ? Math.min(...segmentZero) : null,
        segmentIncompatibleFraction: segments.length > 0
            ? segments.filter(incompatible).length / segments.length
            : null,
        segmentNonzeroLagFraction: segments.length > 0
            ? segments.filter((row) => row.bestLag !== 0).length / segments.length
            : null,
        perReferenceZeroCorrelationMedian: quantile(pairZero, 0.5),
        perReferenceZeroCorrelationQ25: quantile(pairZero, 0.25),
        perReferenceIncompatibleFraction: pairProfiles.length > 0
            ? pairProfiles.filter(incompatible).length / pairProfiles.length
            : null,
        perReferenceNonzeroLagFraction: pairProfiles.length > 0
            ? pairProfiles.filter((row) => row.bestLag !== 0).length / pairProfiles.length
            : null,
        referenceCount: references.length,
        meanReferenceWeight: mean(sourceCompatibility.map((row) => row.referenceWeight)),
    };
};

export const buildInternalReferenceModel = (input: {
    siteData: RwlSiteData;
    targetId: string;
    runId: string;
    rwlHash: string;
    method?: InternalMasterMethod;
    candidateTarget?: boolean;
    targetContribution?: InternalTargetContribution;
    normalizeSourceResiduals?: boolean;
    splineImplementation?: CofechaSplineImplementation;
    arImplementation?: CofechaArImplementation;
    logImplementation?: CofechaLogImplementation;
    preSplineResidualBlendWeight?: number | null;
    adaptivePreSplineResidualBlend?: boolean;
    computeSourceCompatibility?: boolean;
}): InternalReferenceModel | null => {
    if (input.adaptivePreSplineResidualBlend === true) {
        const shared = {
            ...input,
            adaptivePreSplineResidualBlend: false,
            preSplineResidualBlendWeight: null,
        };
        const post = buildInternalReferenceModel({
            ...shared,
            logImplementation: "post-ar",
        });
        const pre = buildInternalReferenceModel({
            ...shared,
            logImplementation: "pre-spline-residual",
        });
        if (!post || !pre) return post ?? pre;
        const audit = adjudicateAdaptiveInternalReferenceBlend(
            post.targetCompatibility,
            pre.targetCompatibility,
        );
        if (!audit.applied) return { ...post, adaptiveBlendAudit: audit };
        const blended = buildInternalReferenceModel({
            ...shared,
            logImplementation: "post-ar",
            preSplineResidualBlendWeight: audit.weight,
        });
        return blended ? { ...blended, adaptiveBlendAudit: audit } : post;
    }
    const targetTree = input.siteData.get(input.targetId);
    if (!targetTree) return null;
    const references = Array.from(input.siteData)
        .filter(([seriesId]) => seriesId !== input.targetId)
        .map(([seriesId, tree]) => ({
            seriesId,
            values: standardizeTree(
                tree,
                input.normalizeSourceResiduals === true,
                input.splineImplementation ?? "discrete-penalty",
                input.arImplementation ?? "current-aic",
                input.logImplementation ?? "post-ar",
                input.preSplineResidualBlendWeight ?? null,
            ),
        }))
        .filter((row) => row.values.size >= 30);
    if (references.length < 3) return null;
    const preliminaryMaster = aggregateUnweightedMedian(references);
    const redundancy = input.computeSourceCompatibility === false
        ? new Map(references.map((row) => [row.seriesId, 1]))
        : redundancyCounts(references);
    const sourceCompatibility = references.map((row) => summarizeCompatibility(
        row.seriesId,
        row.values,
        preliminaryMaster,
        redundancy.get(row.seriesId) ?? 1,
    ));
    const qualityById = new Map(sourceCompatibility.map((row) => [row.seriesId, row]));
    const targetResidual = standardizeTree(
        targetTree,
        input.normalizeSourceResiduals === true,
        input.splineImplementation ?? "discrete-penalty",
        input.arImplementation ?? "current-aic",
        input.logImplementation ?? "post-ar",
        input.preSplineResidualBlendWeight ?? null,
    );
    const targetSourceCompatibility = summarizeCompatibility(
        input.targetId,
        targetResidual,
        preliminaryMaster,
        1,
    );
    const targetContribution = input.targetContribution ?? "exclude";
    const masterSources = targetContribution === "exclude"
        ? references
        : [...references, { seriesId: input.targetId, values: targetResidual }];
    if (targetContribution === "include") {
        qualityById.set(input.targetId, {
            ...targetSourceCompatibility,
            referenceWeight: 1,
        });
    } else if (targetContribution === "compatibility-weighted") {
        qualityById.set(input.targetId, targetSourceCompatibility);
    }
    const points = buildMasterPoints(
        masterSources,
        qualityById,
        input.method ?? "weighted-huber",
    );
    if (points.length === 0) return null;
    const includedSeriesIds = masterSources.map((row) => row.seriesId);
    const candidateSeriesIds = input.candidateTarget === true ? [input.targetId] : [];
    const classification = classifyCofechaPart6Series(
        Array.from(input.siteData.keys()),
        candidateSeriesIds,
        input.runId,
    );
    const replications = points.map((point) => point.replication);
    const reference: CofechaPassReference = {
        id: `internal-reference-${input.runId}-${input.targetId}`,
        source: "pairwise_bootstrap",
        cofechaRunId: input.runId,
        includedSeriesIds,
        candidateSeriesIds,
        options: COFECHA_REFERENCE_DEFAULT_OPTIONS,
        points,
        summary: {
            includedCount: includedSeriesIds.length,
            candidateCount: candidateSeriesIds.length,
            startYear: points[0]?.year ?? null,
            endYear: points[points.length - 1]?.year ?? null,
            meanReplication: mean(replications),
            minReplication: Math.min(...replications),
            maxReplication: Math.max(...replications),
        },
    };
    const referenceConfig: ReferenceSeriesConfig = {
        selectedTrees: includedSeriesIds,
        minSampleDepth: COFECHA_REFERENCE_DEFAULT_OPTIONS.minReplication,
        method: "mean",
        updatedAt: new Date().toISOString(),
        mode: "dynamic",
        cofechaRunId: input.runId,
        rwlHash: input.rwlHash,
        isStale: false,
        classification: {
            ...classification,
            anchorPassIds: includedSeriesIds,
        },
        cofechaPassReference: reference,
    };
    return {
        referenceConfig,
        sourceCompatibility,
        targetCompatibility: targetFeatures(
            targetResidual,
            new Map(buildMasterPoints(
                references,
                qualityById,
                input.method ?? "weighted-huber",
            ).map((point) => [point.year, point.value])),
            references,
            sourceCompatibility,
        ),
    };
};
