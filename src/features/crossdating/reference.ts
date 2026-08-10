import { stopMarker } from "@/shared/constants";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import { normalizeCofechaSeriesId } from "@/features/cofecha/seriesId";

export const REFERENCE_SERIES_LABEL = "Reference / Master-like series";
export const COFECHA_PASS_REFERENCE_LABEL = "COFECHA-pass 参考序列";
export const REFERENCE_SERIES_ID = "__crossdating_reference__";

export type ReferenceSeriesMethod = "mean";
export type ReferenceSeriesMode = "manual" | "dynamic";

export type SeriesStatus =
    | "anchor_pass"
    | "candidate_flagged"
    | "unknown";

export type CofechaPart6Classification = {
    cofechaRunId: string;
    anchorPassIds: string[];
    candidateFlaggedIds: string[];
    flaggedAIds: string[];
    allSeriesIds: string[];
};

export type CofechaReferenceOptions = {
    splineRigidityYears: number;
    splineFrequencyResponse: number;
    useAutoregressiveModel: boolean;
    useLogTransform: boolean;
    useFirstDifference: boolean;
    omitAbsentRingsFromMaster: boolean;
    minReplication: number;
    targetReplication: number;
};

export type IndexedPoint = {
    year: number;
    value: number;
};

export type CofechaReferencePoint = {
    year: number;
    value: number;
    replication: number;
    sd: number;
    se: number;
    weight: number;
};

export type CofechaPassReference = {
    id: string;
    source: "cofecha_pass_anchor" | "cofecha_master_series" | "pairwise_bootstrap";
    cofechaRunId: string;
    includedSeriesIds: string[];
    candidateSeriesIds: string[];
    options: CofechaReferenceOptions;
    points: CofechaReferencePoint[];
    summary: {
        includedCount: number;
        candidateCount: number;
        startYear: number | null;
        endYear: number | null;
        meanReplication: number | null;
        minReplication: number | null;
        maxReplication: number | null;
    };
};

export type OffsetCheckInput = {
    targetSeriesId: string;
    targetSeries: RwlTreeData;
    reference: CofechaPassReference;
    offsetRange: {
        min: number;
        max: number;
    };
};

export type OffsetCheckTargetSet = {
    candidateSeriesIds: string[];
    reference: CofechaPassReference;
};

export type ReferenceSeriesConfig = {
    selectedTrees: string[];
    minSampleDepth: number;
    method: ReferenceSeriesMethod;
    updatedAt: string;
    mode?: ReferenceSeriesMode;
    cofechaRunId?: string;
    rwlHash?: string;
    isStale?: boolean;
    classification?: CofechaPart6Classification;
    cofechaPassReference?: CofechaPassReference | null;
    unavailableReason?: string;
};

export type ReferenceSeries = {
    label: string;
    data: Map<number, number>;
    sampleDepth: Map<number, number>;
    selectedTrees: string[];
    minSampleDepth: number;
    method: ReferenceSeriesMethod;
    updatedAt: string;
    pointCount: number;
    mode: ReferenceSeriesMode;
    isStale: boolean;
    cofechaRunId?: string;
    candidateSeriesIds?: string[];
    sdByYear?: Map<number, number>;
    seByYear?: Map<number, number>;
    weightByYear?: Map<number, number>;
    summary?: CofechaPassReference["summary"];
};

const DEFAULT_MIN_SAMPLE_DEPTH = 2;
const MIN_COFECHA_PASS_ANCHOR_COUNT = 5;

// COFECHA 默认参考序列参数。
// 这些值对应 COFECHA 手册里的默认流程：
// 1. 32 年刚度的 cubic smoothing spline；
// 2. 在 32 年波长处保留 50% 频率响应；
// 3. 启用 autoregressive modeling 去除 persistence；
// 4. 启用 log transform，但不默认 first difference；
// 5. absent ring / 0 值默认不进入 master chronology。
export const COFECHA_REFERENCE_DEFAULT_OPTIONS: CofechaReferenceOptions = {
    splineRigidityYears: 32,
    splineFrequencyResponse: 0.5,
    useAutoregressiveModel: true,
    useLogTransform: true,
    useFirstDifference: false,
    omitAbsentRingsFromMaster: true,
    minReplication: 3,
    targetReplication: 10,
};

const isUsableWidth = (
    value: number | null | undefined,
    options: Pick<CofechaReferenceOptions, "omitAbsentRingsFromMaster"> = COFECHA_REFERENCE_DEFAULT_OPTIONS,
): value is number => (
    typeof value === "number"
    && Number.isFinite(value)
    && (value > 0 || (!options.omitAbsentRingsFromMaster && value === 0))
    && value !== stopMarker.value
);

const mean = (values: readonly number[]) => (
    values.reduce((sum, value) => sum + value, 0) / values.length
);

const standardDeviation = (values: readonly number[]) => {
    if (values.length <= 1) return 0;
    const avg = mean(values);
    const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
};

export function createReferenceSeriesConfig(selectedTrees: string[]): ReferenceSeriesConfig | null {
    const uniqueTrees = Array.from(new Set(selectedTrees.filter(Boolean)));
    if (uniqueTrees.length === 0) {
        return null;
    }

    return {
        selectedTrees: uniqueTrees,
        minSampleDepth: DEFAULT_MIN_SAMPLE_DEPTH,
        method: "mean",
        mode: "manual",
        updatedAt: new Date().toISOString(),
    };
}

export function classifyCofechaPart6Series(
    allSeriesIds: readonly string[],
    flaggedAIds: Iterable<string>,
    cofechaRunId: string,
): CofechaPart6Classification {
    const uniqueAllSeriesIds = Array.from(new Set(allSeriesIds.filter(Boolean)));
    const flaggedSet = new Set(Array.from(flaggedAIds, normalizeCofechaSeriesId));
    const flaggedAIdSet = new Set<string>();
    const anchorPassIds: string[] = [];
    const candidateFlaggedIds: string[] = [];

    uniqueAllSeriesIds.forEach((seriesId) => {
        if (flaggedSet.has(normalizeCofechaSeriesId(seriesId))) {
            candidateFlaggedIds.push(seriesId);
            flaggedAIdSet.add(seriesId);
        } else {
            anchorPassIds.push(seriesId);
        }
    });

    return {
        cofechaRunId,
        anchorPassIds,
        candidateFlaggedIds,
        flaggedAIds: Array.from(flaggedAIdSet),
        allSeriesIds: uniqueAllSeriesIds,
    };
}

const varianceAroundZero = (values: readonly number[]) => (
    values.length === 0
        ? 0
        : values.reduce((sum, value) => sum + value ** 2, 0) / values.length
);

const smoothingLambdaForFrequencyResponse = (
    rigidityYears: number,
    frequencyResponse: number,
) => {
    const period = Math.max(3, Math.floor(rigidityYears));
    const response = Math.min(Math.max(frequencyResponse, 0.01), 0.99);
    const secondDifferenceEigenvalue = 16 * Math.sin(Math.PI / period) ** 4;

    // COFECHA / ARSTAN 一类树轮程序不直接暴露 spline 的 lambda，
    // 而是让用户指定“某个波长处保留多少频率响应”。这里把这种
    // 树轮领域参数换算成离散二阶差分 smoothing spline 的惩罚强度。
    //
    // A cubic smoothing spline is conventionally specified in tree-ring software
    // by its 50% frequency-response wavelength, not by a raw roughness penalty.
    // For the discrete second-difference spline smoother used here:
    //   response(period) = 1 / (1 + lambda * 16 * sin(pi / period)^4)
    // Solving that equation gives the lambda that makes a 32-year wave retain
    // 50% amplitude under the COFECHA default settings.
    return ((1 / response) - 1) / Math.max(secondDifferenceEigenvalue, 1e-12);
};

const applyCubicSmoothingSplineMatrix = (length: number, lambda: number, vector: readonly number[]) => {
    const result = vector.slice();

    // D'D for the second-difference roughness penalty can be applied without
    // materializing a matrix: for each local curvature term
    //   d_i = z_i - 2 z_{i+1} + z_{i+2}
    // add [d_i, -2d_i, d_i] back into the normal equations.
    for (let index = 0; index <= length - 3; index += 1) {
        const curvature = vector[index] - 2 * vector[index + 1] + vector[index + 2];
        result[index] += lambda * curvature;
        result[index + 1] -= 2 * lambda * curvature;
        result[index + 2] += lambda * curvature;
    }

    return result;
};

/**
 * Solves `(I + lambda * D'D) trend = values` in O(n). `D'D` is symmetric
 * pentadiagonal, so a bandwidth-two Cholesky factor is sufficient and avoids
 * repeating full-array conjugate-gradient passes for every reference core.
 */
const solveCubicSmoothingSplineBanded = (
    values: readonly number[],
    lambda: number,
): number[] | null => {
    const length = values.length;
    const diagonal = new Array<number>(length).fill(1);
    const lowerOne = new Array<number>(length).fill(0);
    const lowerTwo = new Array<number>(length).fill(0);

    for (let index = 0; index <= length - 3; index += 1) {
        diagonal[index] += lambda;
        diagonal[index + 1] += 4 * lambda;
        diagonal[index + 2] += lambda;
        lowerOne[index + 1] -= 2 * lambda;
        lowerOne[index + 2] -= 2 * lambda;
        lowerTwo[index + 2] += lambda;
    }

    const factorDiagonal = new Array<number>(length).fill(0);
    const factorLowerOne = new Array<number>(length).fill(0);
    const factorLowerTwo = new Array<number>(length).fill(0);
    for (let row = 0; row < length; row += 1) {
        if (row >= 2) {
            factorLowerTwo[row] = lowerTwo[row] / factorDiagonal[row - 2];
        }
        if (row >= 1) {
            const overlap = row >= 2
                ? factorLowerTwo[row] * factorLowerOne[row - 1]
                : 0;
            factorLowerOne[row] = (lowerOne[row] - overlap) / factorDiagonal[row - 1];
        }
        const pivot = diagonal[row]
            - factorLowerOne[row] ** 2
            - factorLowerTwo[row] ** 2;
        if (!Number.isFinite(pivot) || pivot <= 1e-18) return null;
        factorDiagonal[row] = Math.sqrt(pivot);
    }

    const forward = new Array<number>(length).fill(0);
    for (let row = 0; row < length; row += 1) {
        forward[row] = (
            values[row]
            - (row >= 1 ? factorLowerOne[row] * forward[row - 1] : 0)
            - (row >= 2 ? factorLowerTwo[row] * forward[row - 2] : 0)
        ) / factorDiagonal[row];
    }

    const result = new Array<number>(length).fill(0);
    for (let row = length - 1; row >= 0; row -= 1) {
        result[row] = (
            forward[row]
            - (row + 1 < length ? factorLowerOne[row + 1] * result[row + 1] : 0)
            - (row + 2 < length ? factorLowerTwo[row + 2] * result[row + 2] : 0)
        ) / factorDiagonal[row];
    }
    return result;
};

const solveCubicSmoothingSplineTrend = (
    values: readonly number[],
    options: CofechaReferenceOptions,
) => {
    if (values.length <= 2 || options.splineRigidityYears < 0) {
        return values.slice();
    }

    const lambda = smoothingLambdaForFrequencyResponse(
        options.splineRigidityYears,
        options.splineFrequencyResponse,
    );
    const bandedSolution = solveCubicSmoothingSplineBanded(values, lambda);
    if (bandedSolution) {
        return bandedSolution.map((value) => Math.max(1e-6, value));
    }

    // The matrix is positive definite for valid options, so this is only a
    // defensive fallback for unexpected numerical input.
    const maxIterations = Math.max(40, Math.min(2500, values.length * 8));
    const tolerance = 1e-10 * Math.max(1, varianceAroundZero(values));

    let estimate = values.slice();
    let appliedEstimate = applyCubicSmoothingSplineMatrix(values.length, lambda, estimate);
    let residual = values.map((value, index) => value - appliedEstimate[index]);
    let direction = residual.slice();
    let residualNorm = varianceAroundZero(residual) * residual.length;

    // 这里求解的是 spline trend，而不是移动平均。
    // 目标函数可以理解为：
    //   拟合误差 + lambda * 曲率惩罚
    // 曲率惩罚越强，趋势线越硬；32 年 50% response 是 COFECHA 默认硬度。
    //
    // Conjugate gradient keeps the spline solve light even for long RWL files.
    // The system is symmetric positive definite:
    //   (I + lambda * D'D) trend = rawWidth
    // where D is the second-difference operator that penalizes curvature.
    for (let iteration = 0; iteration < maxIterations && residualNorm > tolerance; iteration += 1) {
        const applied = applyCubicSmoothingSplineMatrix(values.length, lambda, direction);
        const denominator = direction.reduce((sum, value, index) => sum + value * applied[index], 0);
        if (Math.abs(denominator) < 1e-18) break;

        const alpha = residualNorm / denominator;
        estimate = estimate.map((value, index) => value + alpha * direction[index]);
        const nextResidual = residual.map((value, index) => value - alpha * applied[index]);
        const nextNorm = varianceAroundZero(nextResidual) * nextResidual.length;
        if (nextNorm <= tolerance) {
            residual = nextResidual;
            break;
        }

        const beta = nextNorm / residualNorm;
        direction = nextResidual.map((value, index) => value + beta * direction[index]);
        residual = nextResidual;
        residualNorm = nextNorm;
    }

    return estimate.map((value) => Math.max(1e-6, value));
};

const solveLinearSystem = (matrix: number[][], rhs: number[]) => {
    const size = rhs.length;
    const a = matrix.map((row) => row.slice());
    const b = rhs.slice();

    for (let pivot = 0; pivot < size; pivot += 1) {
        let bestRow = pivot;
        for (let row = pivot + 1; row < size; row += 1) {
            if (Math.abs(a[row][pivot]) > Math.abs(a[bestRow][pivot])) {
                bestRow = row;
            }
        }

        if (Math.abs(a[bestRow][pivot]) < 1e-12) return null;

        if (bestRow !== pivot) {
            [a[pivot], a[bestRow]] = [a[bestRow], a[pivot]];
            [b[pivot], b[bestRow]] = [b[bestRow], b[pivot]];
        }

        for (let row = pivot + 1; row < size; row += 1) {
            const factor = a[row][pivot] / a[pivot][pivot];
            if (factor === 0) continue;
            a[row][pivot] = 0;
            for (let col = pivot + 1; col < size; col += 1) {
                a[row][col] -= factor * a[pivot][col];
            }
            b[row] -= factor * b[pivot];
        }
    }

    const solution = Array(size).fill(0);
    for (let row = size - 1; row >= 0; row -= 1) {
        let total = b[row];
        for (let col = row + 1; col < size; col += 1) {
            total -= a[row][col] * solution[col];
        }
        solution[row] = total / a[row][row];
    }

    return solution;
};

const fitAutoregressiveModel = (values: readonly number[], maxOrder: number) => {
    if (values.length < 8 || maxOrder < 1) {
        return { order: 0, coefficients: [] as number[], meanValue: mean(values) };
    }

    const avg = mean(values);
    const centered = values.map((value) => value - avg);
    const maxUsableOrder = Math.min(maxOrder, Math.floor(values.length / 3));
    let best = { order: 0, coefficients: [] as number[], meanValue: avg, aic: Number.POSITIVE_INFINITY };

    // COFECHA 会用 AR modeling 去掉 spline 之后仍残留的自相关。
    // 这里用 Yule-Walker 方程拟合 AR(p)，并用 AIC 在 1..5 阶中选阶；
    // p=0 等价于关闭预白化。这样后续相关检查更偏向同步的年际高频信号。
    for (let order = 1; order <= maxUsableOrder; order += 1) {
        const autocovariances = Array(order + 1).fill(0);
        for (let lag = 0; lag <= order; lag += 1) {
            for (let index = lag; index < centered.length; index += 1) {
                autocovariances[lag] += centered[index] * centered[index - lag];
            }
            autocovariances[lag] /= centered.length;
        }

        const matrix = Array.from({ length: order }, (_, row) => (
            Array.from({ length: order }, (_, col) => autocovariances[Math.abs(row - col)])
        ));
        const coefficients = solveLinearSystem(matrix, autocovariances.slice(1));
        if (!coefficients) continue;

        let rss = 0;
        let count = 0;
        for (let index = order; index < centered.length; index += 1) {
            const predicted = coefficients.reduce((sum, coefficient, lagIndex) => (
                sum + coefficient * centered[index - lagIndex - 1]
            ), 0);
            rss += (centered[index] - predicted) ** 2;
            count += 1;
        }

        if (count === 0 || rss <= 0) continue;
        const aic = count * Math.log(rss / count) + 2 * order;
        if (aic < best.aic) {
            best = { order, coefficients, meanValue: avg, aic };
        }
    }

    return {
        order: best.order,
        coefficients: best.coefficients,
        meanValue: best.meanValue,
    };
};

export function cofechaStyleStandardize(
    series: RwlTreeData,
    options: CofechaReferenceOptions = COFECHA_REFERENCE_DEFAULT_OPTIONS,
): IndexedPoint[] {
    const rawPoints = Array.from(series.entries())
        .filter((entry): entry is [number, number] => isUsableWidth(entry[1], options))
        .map(([year, value]) => ({ year, value: Math.max(value, 1e-6) }))
        .sort((a, b) => a.year - b.year);

    if (rawPoints.length === 0) return [];

    const rawWidths = rawPoints.map((point) => point.value);
    const trend = solveCubicSmoothingSplineTrend(rawWidths, options);

    // Step 1: spline detrending
    // 原始宽度除以趋势宽度，得到 mean 约为 1 的 dimensionless index。
    // 这一步是 COFECHA reference 不能直接平均 raw width 的关键原因。
    // COFECHA first removes low-frequency growth trend per core. The result is
    // dimensionless ring-width index: actual width divided by the 32-year,
    // 50%-response spline estimate for that same year.
    let transformed = rawPoints.map((point, index) => {
        return {
            year: point.year,
            value: point.value / trend[index],
        };
    });

    if (options.useAutoregressiveModel && transformed.length >= 8) {
        const values = transformed.map((point) => point.value);
        const model = fitAutoregressiveModel(values, 5);

        // Step 2: AR prewhitening
        // 每条样芯单独预白化，避免一条序列自己的生长惯性被误当成
        // 与其它样芯同步的 crossdating 信号。
        //
        // COFECHA's AR modeling removes persistence that remains after spline
        // filtering. We keep the residual centered near the original mean so the
        // following log transform still represents proportional departures.
        transformed = transformed.slice(model.order).map((point, index) => {
            const sourceIndex = index + model.order;
            const predictedDeviation = model.coefficients.reduce((sum, coefficient, lagIndex) => (
                sum + coefficient * (values[sourceIndex - lagIndex - 1] - model.meanValue)
            ), 0);
            return {
                year: point.year,
                value: model.meanValue + (values[sourceIndex] - model.meanValue) - predictedDeviation,
            };
        });
    }

    if (options.useLogTransform && transformed.length > 0) {
        const values = transformed.map((point) => point.value);
        const avg = mean(values);
        const cofechaConstant = avg / 6;
        const minValue = Math.min(...values);
        const positivityShift = minValue + cofechaConstant <= 0
            ? Math.abs(minValue + cofechaConstant) + 1e-6
            : 0;

        // Step 3: log transform
        // COFECHA 默认对转换后的序列取对数，并先加均值的 1/6。
        // 若 AR residual 使局部值落到非正区间，则只加最小必要 shift，
        // 保证数学定义有效，同时尽量不改变相对年际形态。
        //
        // COFECHA adds one-sixth of the series mean before taking logs. This
        // keeps locally absent or very narrow rings from becoming log(0), while
        // preserving the proportional weighting that makes log transforms useful
        // for ring-width indices.
        transformed = transformed.map((point) => ({
            year: point.year,
            value: Math.log(point.value + cofechaConstant + positivityShift),
        }));
    }

    if (options.useFirstDifference && transformed.length >= 2) {
        // Step 4: optional first difference
        // COFECHA 允许用户启用 first differencing，但它不是默认行为；
        // 因此默认配置保持 false，只在明确打开时才做。
        transformed = transformed.slice(1).map((point, index) => ({
            year: point.year,
            value: point.value - transformed[index].value,
        }));
    }

    return transformed;
}

export function buildCofechaPassReference(
    siteData: RwlSiteData,
    classification: CofechaPart6Classification,
    options: CofechaReferenceOptions = COFECHA_REFERENCE_DEFAULT_OPTIONS,
): CofechaPassReference | null {
    if (classification.anchorPassIds.length < MIN_COFECHA_PASS_ANCHOR_COUNT) {
        return null;
    }

    const valuesByYear = new Map<number, number[]>();

    // 只把 COFECHA PART 6 中没有 A flag 的样芯放入 reference。
    // 有 A flag 的 candidate_flagged 序列保留给后续 offset 检查，
    // 不能反过来参与构造检查它自己的参考序列。
    classification.anchorPassIds.forEach((seriesId) => {
        const series = siteData.get(seriesId);
        if (!series) return;

        cofechaStyleStandardize(series, options).forEach((point) => {
            const values = valuesByYear.get(point.year);
            if (values) {
                values.push(point.value);
            } else {
                valuesByYear.set(point.year, [point.value]);
            }
        });
    });

    const rawMasterPoints: Array<{ year: number; values: number[]; value: number }> = [];

    Array.from(valuesByYear.entries()).sort((a, b) => a[0] - b[0]).forEach(([year, values]) => {
        if (values.length < options.minReplication) return;
        rawMasterPoints.push({
            year,
            value: mean(values),
            values,
        });
    });

    const masterValues = rawMasterPoints.map((point) => point.value);
    const masterMean = masterValues.length > 0 ? mean(masterValues) : 0;
    const masterSd = standardDeviation(masterValues);
    const standardizer = masterSd > 0 ? masterSd : 1;

    // Step 5: accumulated series / counter series
    // 上面 rawMasterPoints 已完成 COFECHA 的 accumulator / counter 逻辑：
    // 每年把所有转换后样芯值累加，再除以该年的 replication 得到算术平均。
    //
    // Step 6: Part 3 residual master standardization
    // COFECHA PART 3 输出的 master dating series 是 mean=0、sd=1 的 residual chronology。
    // 所以最终 reference value 必须是标准化后的 R(t)，不是 raw width，也不是 mean≈1 的 index。
    //
    // Part 3's master dating series is a residual chronology standardized to
    // mean 0 and sd 1. Keep per-year sd/se in that same final scale so tooltip
    // evidence and future Bayesian checks do not mix transformed units.
    const points: CofechaReferencePoint[] = rawMasterPoints.map((point) => {
        const sd = standardDeviation(point.values) / standardizer;
        return {
            year: point.year,
            value: (point.value - masterMean) / standardizer,
            replication: point.values.length,
            sd,
            se: sd / Math.sqrt(point.values.length),
            weight: Math.min(1, point.values.length / options.targetReplication),
        };
    });

    const replications = points.map((point) => point.replication);

    return {
        id: `cofecha-pass-reference-${classification.cofechaRunId}`,
        source: "cofecha_pass_anchor",
        cofechaRunId: classification.cofechaRunId,
        includedSeriesIds: classification.anchorPassIds,
        candidateSeriesIds: classification.candidateFlaggedIds,
        options,
        points,
        summary: {
            includedCount: classification.anchorPassIds.length,
            candidateCount: classification.candidateFlaggedIds.length,
            startYear: points[0]?.year ?? null,
            endYear: points[points.length - 1]?.year ?? null,
            meanReplication: replications.length > 0 ? mean(replications) : null,
            minReplication: replications.length > 0 ? Math.min(...replications) : null,
            maxReplication: replications.length > 0 ? Math.max(...replications) : null,
        },
    };
}

export function createCofechaPassReferenceConfig(params: {
    siteData: RwlSiteData;
    flaggedAIds: Iterable<string>;
    cofechaRunId: string;
    rwlHash: string;
    options?: CofechaReferenceOptions;
}): ReferenceSeriesConfig {
    const classification = classifyCofechaPart6Series(
        Array.from(params.siteData.keys()),
        params.flaggedAIds,
        params.cofechaRunId,
    );
    const options = params.options ?? COFECHA_REFERENCE_DEFAULT_OPTIONS;
    const cofechaPassReference = buildCofechaPassReference(params.siteData, classification, options);

    return {
        selectedTrees: classification.anchorPassIds,
        minSampleDepth: options.minReplication,
        method: "mean",
        mode: "dynamic",
        updatedAt: new Date().toISOString(),
        cofechaRunId: params.cofechaRunId,
        rwlHash: params.rwlHash,
        isStale: false,
        classification,
        cofechaPassReference,
        unavailableReason: cofechaPassReference
            ? undefined
            : "COFECHA 无 A 样芯数量不足，无法生成稳定参考序列。",
    };
}

export function createCofechaMasterReferenceConfig(params: {
    siteData: RwlSiteData;
    flaggedAIds: Iterable<string>;
    cofechaRunId: string;
    rwlHash: string;
    masterDatingSeries: Map<number, number>;
    options?: CofechaReferenceOptions;
}): ReferenceSeriesConfig {
    const classification = classifyCofechaPart6Series(
        Array.from(params.siteData.keys()),
        params.flaggedAIds,
        params.cofechaRunId,
    );
    const options = params.options ?? COFECHA_REFERENCE_DEFAULT_OPTIONS;
    const sortedMasterEntries = Array.from(params.masterDatingSeries.entries())
        .filter((entry): entry is [number, number] => (
            Number.isFinite(entry[0]) && Number.isFinite(entry[1])
        ))
        .sort((a, b) => a[0] - b[0]);

    const replicationForYear = (year: number) => (
        classification.allSeriesIds.reduce((count, seriesId) => {
            const value = params.siteData.get(seriesId)?.get(year);
            return isUsableWidth(value, options) ? count + 1 : count;
        }, 0)
    );

    const points: CofechaReferencePoint[] = sortedMasterEntries.map(([year, value]) => {
        const replication = replicationForYear(year);
        return {
            year,
            value,
            replication,
            sd: 0,
            se: 0,
            weight: Math.min(1, replication / options.targetReplication),
        };
    });
    const replications = points.map((point) => point.replication);
    const cofechaPassReference: CofechaPassReference | null = points.length > 0
        ? {
            id: `cofecha-master-reference-${params.cofechaRunId}`,
            source: "cofecha_master_series",
            cofechaRunId: params.cofechaRunId,
            includedSeriesIds: classification.allSeriesIds,
            candidateSeriesIds: classification.candidateFlaggedIds,
            options,
            points,
            summary: {
                includedCount: classification.allSeriesIds.length,
                candidateCount: classification.candidateFlaggedIds.length,
                startYear: points[0]?.year ?? null,
                endYear: points[points.length - 1]?.year ?? null,
                meanReplication: replications.length > 0 ? mean(replications) : null,
                minReplication: replications.length > 0 ? Math.min(...replications) : null,
                maxReplication: replications.length > 0 ? Math.max(...replications) : null,
            },
        }
        : null;

    return {
        selectedTrees: classification.allSeriesIds,
        minSampleDepth: options.minReplication,
        method: "mean",
        mode: "dynamic",
        updatedAt: new Date().toISOString(),
        cofechaRunId: params.cofechaRunId,
        rwlHash: params.rwlHash,
        isStale: false,
        classification,
        cofechaPassReference,
        unavailableReason: cofechaPassReference
            ? undefined
            : "COFECHA master series 为空，无法生成临时参考序列。",
    };
}

export function getOffsetCheckTargetSet(config: ReferenceSeriesConfig | null | undefined): OffsetCheckTargetSet | null {
    if (!config?.cofechaPassReference || !config.classification) return null;
    return {
        candidateSeriesIds: config.classification.candidateFlaggedIds,
        reference: config.cofechaPassReference,
    };
}

export function normalizeReferenceSeriesConfig(
    config: ReferenceSeriesConfig | null | undefined,
    siteData: RwlSiteData,
): ReferenceSeriesConfig | null {
    if (!config || !Array.isArray(config.selectedTrees)) {
        return null;
    }

    const mode: ReferenceSeriesMode = config.mode === "dynamic" ? "dynamic" : "manual";
    const selectedTrees = Array.from(new Set(
        config.selectedTrees.filter((tree) => siteData.has(tree)),
    ));

    if (mode === "manual" && selectedTrees.length === 0) {
        return null;
    }

    const classification = config.classification
        ? {
            ...config.classification,
            allSeriesIds: config.classification.allSeriesIds.filter((tree) => siteData.has(tree)),
            anchorPassIds: config.classification.anchorPassIds.filter((tree) => siteData.has(tree)),
            candidateFlaggedIds: config.classification.candidateFlaggedIds.filter((tree) => siteData.has(tree)),
            flaggedAIds: config.classification.flaggedAIds.filter((tree) => siteData.has(tree)),
        }
        : undefined;

    return {
        selectedTrees,
        minSampleDepth: Math.max(1, Math.floor(config.minSampleDepth || DEFAULT_MIN_SAMPLE_DEPTH)),
        method: config.method === "mean" ? "mean" : "mean",
        mode,
        updatedAt: config.updatedAt || new Date().toISOString(),
        cofechaRunId: config.cofechaRunId,
        rwlHash: config.rwlHash,
        isStale: Boolean(config.isStale),
        classification,
        cofechaPassReference: config.cofechaPassReference ?? null,
        unavailableReason: config.unavailableReason,
    };
}

function buildManualReferenceSeries(siteData: RwlSiteData, normalized: ReferenceSeriesConfig): ReferenceSeries | null {
    const years = new Set<number>();
    normalized.selectedTrees.forEach((tree) => {
        siteData.get(tree)?.forEach((value, year) => {
            if (isUsableWidth(value)) {
                years.add(year);
            }
        });
    });

    const data = new Map<number, number>();
    const sampleDepth = new Map<number, number>();

    Array.from(years).sort((a, b) => a - b).forEach((year) => {
        const values: number[] = [];

        normalized.selectedTrees.forEach((tree) => {
            const value = siteData.get(tree)?.get(year);
            if (isUsableWidth(value)) {
                values.push(value);
            }
        });

        sampleDepth.set(year, values.length);
        if (values.length >= normalized.minSampleDepth) {
            data.set(year, mean(values));
        }
    });

    return {
        label: REFERENCE_SERIES_LABEL,
        data,
        sampleDepth,
        selectedTrees: normalized.selectedTrees,
        minSampleDepth: normalized.minSampleDepth,
        method: normalized.method,
        updatedAt: normalized.updatedAt,
        pointCount: data.size,
        mode: "manual",
        isStale: false,
    };
}

function buildDynamicReferenceSeries(normalized: ReferenceSeriesConfig): ReferenceSeries | null {
    const reference = normalized.cofechaPassReference;
    if (!reference || reference.points.length === 0) {
        return null;
    }

    const data = new Map<number, number>();
    const sampleDepth = new Map<number, number>();
    const sdByYear = new Map<number, number>();
    const seByYear = new Map<number, number>();
    const weightByYear = new Map<number, number>();

    reference.points.forEach((point) => {
        data.set(point.year, point.value);
        sampleDepth.set(point.year, point.replication);
        sdByYear.set(point.year, point.sd);
        seByYear.set(point.year, point.se);
        weightByYear.set(point.year, point.weight);
    });

    return {
        label: reference.source === "cofecha_master_series" ? "COFECHA master series" : COFECHA_PASS_REFERENCE_LABEL,
        data,
        sampleDepth,
        selectedTrees: normalized.selectedTrees,
        minSampleDepth: normalized.minSampleDepth,
        method: normalized.method,
        updatedAt: normalized.updatedAt,
        pointCount: data.size,
        mode: "dynamic",
        isStale: Boolean(normalized.isStale),
        cofechaRunId: normalized.cofechaRunId,
        candidateSeriesIds: reference.candidateSeriesIds,
        sdByYear,
        seByYear,
        weightByYear,
        summary: reference.summary,
    };
}

export function buildReferenceSeries(
    siteData: RwlSiteData,
    config: ReferenceSeriesConfig | null | undefined,
): ReferenceSeries | null {
    const normalized = normalizeReferenceSeriesConfig(config, siteData);
    if (!normalized) {
        return null;
    }

    if (normalized.mode === "dynamic") {
        return buildDynamicReferenceSeries(normalized);
    }

    return buildManualReferenceSeries(siteData, normalized);
}

export function hashRwlSiteData(siteData: RwlSiteData): string {
    let hash = 2166136261;
    const update = (text: string) => {
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
    };

    Array.from(siteData.entries()).sort(([a], [b]) => a.localeCompare(b)).forEach(([tree, treeData]) => {
        update(tree);
        Array.from(treeData.entries()).sort((a, b) => a[0] - b[0]).forEach(([year, value]) => {
            update(`${year}:${value ?? "null"};`);
        });
    });

    return (hash >>> 0).toString(16);
}
