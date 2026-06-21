import { invoke } from "@tauri-apps/api/core";
import {
    cofechaStyleStandardize,
    type CofechaPassReference,
} from "@/features/crossdating/reference";
import { stopMarker } from "@/shared/constants";
import type { RwlTreeData } from "./types";

export type BayesianMcmcConfig = {
    iterations?: number;
    burnIn?: number;
    thin?: number;
    chains?: number;
    minOverlap?: number;
    kBeta?: number;
    au?: number;
    bu?: number;
    ae?: number;
    be?: number;
    priorStartYear?: number;
    priorEndYear?: number;
    seed?: number;
    maxReturnedCandidates?: number;
    useReferenceReplicationWeight?: boolean;
    candidateOverlapFractionOfBest?: number;
};

export type BayesianTargetPoint = {
    index: number;
    value: number;
    originalYear: number;
};

export type BayesianReferencePoint = {
    year: number;
    value: number;
    replication: number;
    weight: number;
};

export type BayesianDatingCandidate = {
    startYear: number;
    endYear: number;
    posterior: number;
    sampleCount: number;
    overlap: number;
    correlation: number | null;
    tValue: number | null;
    meanBeta: number;
    meanSigmaU2: number;
    meanSigmaE2: number;
};

export type BayesianParameterStats = {
    mean: number;
    sd: number;
    q025: number;
    median: number;
    q975: number;
};

export type BayesianParameterSummary = {
    beta: BayesianParameterStats;
    sigmaU2: BayesianParameterStats;
    sigmaE2: BayesianParameterStats;
    signalToNoise: BayesianParameterStats;
};

export type BayesianMcmcSummary = {
    iterations: number;
    burnIn: number;
    thin: number;
    chains: number;
    retainedSamples: number;
    retainedSamplesPerChain: number[];
};

export type BayesianChainDeltaTop = {
    startYear: number;
    posterior: number;
    sampleCount: number;
};

export type BayesianChainDiagnostics = {
    chainIndex: number;
    retainedSamples: number;
    bestStartYear: number | null;
    topDeltas: BayesianChainDeltaTop[];
};

export type BayesianDiagnostics = {
    chains: BayesianChainDiagnostics[];
    combinedBestStartYear: number | null;
    chainTopAgreement: boolean;
    discreteDeltaStable: boolean;
    rHat: {
        beta: number | null;
        sigmaU2: number | null;
        sigmaE2: number | null;
        signalToNoise: number | null;
    };
    warnings: string[];
};

export type BayesianDecision = {
    status: "accepted" | "ambiguous" | "rejected" | "unavailable";
    reason: string;
};

export type BayesianMcmcDatingResult = {
    targetSeriesId: string;
    targetLength: number;
    referenceStartYear: number;
    referenceEndYear: number;
    minOverlap: number;
    candidateCount: number;
    best: BayesianDatingCandidate | null;
    secondBest: BayesianDatingCandidate | null;
    hpd95: BayesianDatingCandidate[];
    candidates: BayesianDatingCandidate[];
    mcmcSummary: BayesianMcmcSummary;
    parameterSummary: BayesianParameterSummary;
    diagnostics: BayesianDiagnostics;
    decision: BayesianDecision;
};

export const DEFAULT_BAYESIAN_MCMC_CONFIG = {
    iterations: 15_000,
    burnIn: 3_000,
    thin: 6,
    chains: 3,
    minOverlap: 50,
    kBeta: 1000,
    au: 0.01,
    bu: 0.01,
    ae: 0.01,
    be: 0.01,
    maxReturnedCandidates: 30,
    useReferenceReplicationWeight: false,
    candidateOverlapFractionOfBest: 0.9,
} satisfies Required<Omit<BayesianMcmcConfig, "priorStartYear" | "priorEndYear" | "seed">>;

const mean = (values: readonly number[]) => (
    values.reduce((sum, value) => sum + value, 0) / values.length
);

const standardDeviation = (values: readonly number[]) => {
    if (values.length <= 1) return 0;
    const avg = mean(values);
    const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
};

const zScoreValues = <T extends { value: number }>(points: readonly T[]): T[] => {
    if (points.length === 0) return [];
    const values = points.map((point) => point.value);
    const avg = mean(values);
    const sd = standardDeviation(values);
    const scale = sd > 0 ? sd : 1;
    return points.map((point) => ({
        ...point,
        value: (point.value - avg) / scale,
    }));
};

export function buildBayesianDatingTarget(series: RwlTreeData, reference: CofechaPassReference): BayesianTargetPoint[] {
    const sourceStartYear = Array.from(series.entries())
        .filter(([, value]) => typeof value === "number" && value !== stopMarker.value)
        .map(([year]) => year)
        .sort((a, b) => a - b)[0];

    if (sourceStartYear === undefined) {
        return [];
    }

    return zScoreValues(cofechaStyleStandardize(series, reference.options))
        .sort((a, b) => a.year - b.year)
        .map((point) => {
            const index = point.year - sourceStartYear;
            return index < 0
                ? null
                : {
                    index,
                    value: point.value,
                    originalYear: point.year,
                };
        })
        .filter((point): point is BayesianTargetPoint => point !== null);
}

export function buildBayesianDatingReference(reference: CofechaPassReference): BayesianReferencePoint[] {
    return reference.points
        .filter((point) => Number.isFinite(point.year) && Number.isFinite(point.value))
        .map((point) => ({
            year: point.year,
            value: point.value,
            replication: point.replication,
            weight: point.weight,
        }));
}

export async function runBayesianDatingMcmc(params: {
    targetSeriesId: string;
    series: RwlTreeData;
    reference: CofechaPassReference;
    config?: BayesianMcmcConfig;
}): Promise<BayesianMcmcDatingResult> {
    const totalStarted = performance.now();
    const targetStarted = performance.now();
    const target = buildBayesianDatingTarget(params.series, params.reference);
    const targetBuildMs = performance.now() - targetStarted;
    const referenceStarted = performance.now();
    const reference = buildBayesianDatingReference(params.reference);
    const referenceBuildMs = performance.now() - referenceStarted;
    const config = {
        ...DEFAULT_BAYESIAN_MCMC_CONFIG,
        ...params.config,
    };

    console.groupCollapsed(`[Bayesian dating] ${params.targetSeriesId}`);
    console.log("input", {
        targetPoints: target.length,
        referencePoints: reference.length,
        config,
    });

    if (target.length === 0) {
        console.groupEnd();
        throw new Error("目标序列标准化后没有可用点");
    }
    if (reference.length === 0) {
        console.groupEnd();
        throw new Error("COFECHA-pass 参考序列没有可用点");
    }

    const invokeStarted = performance.now();
    try {
        const result = await invoke<BayesianMcmcDatingResult>("bayesian_date_series_mcmc", {
            input: {
                targetSeriesId: params.targetSeriesId,
                target,
                reference,
                ...config,
            },
        });
        const invokeRustMs = performance.now() - invokeStarted;
        const totalMs = performance.now() - totalStarted;
        console.table([
            { phase: "build target", ms: targetBuildMs.toFixed(1) },
            { phase: "build reference", ms: referenceBuildMs.toFixed(1) },
            { phase: "invoke rust + mcmc", ms: invokeRustMs.toFixed(1) },
            { phase: "total", ms: totalMs.toFixed(1) },
        ]);
        console.log("result", {
            bestStartYear: result.best?.startYear ?? null,
            bestEndYear: result.best?.endYear ?? null,
            bestPosterior: result.best?.posterior ?? null,
            secondStartYear: result.secondBest?.startYear ?? null,
            secondPosterior: result.secondBest?.posterior ?? null,
            candidateCount: result.candidateCount,
            retainedSamples: result.mcmcSummary.retainedSamples,
            decision: result.decision,
            warnings: result.diagnostics.warnings,
        });
        return result;
    } catch (error) {
        console.table([
            { phase: "build target", ms: targetBuildMs.toFixed(1) },
            { phase: "build reference", ms: referenceBuildMs.toFixed(1) },
            { phase: "invoke rust + mcmc before error", ms: (performance.now() - invokeStarted).toFixed(1) },
            { phase: "total before error", ms: (performance.now() - totalStarted).toFixed(1) },
        ]);
        console.error("Bayesian dating failed", error);
        throw error;
    } finally {
        console.groupEnd();
    }
}

export function rebuildTreeDataFromStartYear(series: RwlTreeData, startYear: number): RwlTreeData {
    const entries = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
    const sourceStartYear = entries.find(([, value]) => value !== stopMarker.value)?.[0] ?? entries[0]?.[0];

    const next = new Map<number, number | null>();
    if (sourceStartYear === undefined) {
        return next;
    }

    entries.forEach(([, value], index) => {
        const [year] = entries[index];
        next.set(startYear + (year - sourceStartYear), value);
    });
    return next;
}
