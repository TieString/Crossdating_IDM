import { createHash } from "node:crypto";

export type ClusterCount = {
    clusterId: string;
    numerator: number;
    denominator: number;
};

export type ClusterBootstrapOptions = {
    replicates: number;
    confidenceLevel: number;
    seed: string;
};

const stableHash = (value: string): number => Number.parseInt(
    createHash("sha256").update(value).digest("hex").slice(0, 12),
    16,
);

const percentile = (values: readonly number[], probability: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * probability) - 1),
    )];
};

const aggregate = (values: readonly ClusterCount[]): ClusterCount => values.reduce(
    (total, value) => ({
        clusterId: "aggregate",
        numerator: total.numerator + value.numerator,
        denominator: total.denominator + value.denominator,
    }),
    { clusterId: "aggregate", numerator: 0, denominator: 0 },
);

const ratio = (value: ClusterCount): number | null => value.denominator > 0
    ? value.numerator / value.denominator
    : null;

const macroRate = (values: readonly ClusterCount[]): number | null => {
    const rates = values.flatMap((value) => {
        const current = ratio(value);
        return current === null ? [] : [current];
    });
    return rates.length > 0
        ? rates.reduce((sum, value) => sum + value, 0) / rates.length
        : null;
};

export const summarizeClusteredMetric = (
    clusters: readonly ClusterCount[],
    options: ClusterBootstrapOptions,
) => {
    if (!Number.isInteger(options.replicates) || options.replicates < 1) {
        throw new Error("cluster bootstrap replicates must be a positive integer");
    }
    if (!(options.confidenceLevel > 0 && options.confidenceLevel < 1)) {
        throw new Error("cluster bootstrap confidence level must be between zero and one");
    }
    const usable = clusters.filter((cluster) => cluster.denominator > 0)
        .sort((left, right) => left.clusterId.localeCompare(right.clusterId));
    const point = aggregate(usable);
    const microBootstrap: number[] = [];
    const macroBootstrap: number[] = [];
    if (usable.length > 0) {
        for (let replicate = 0; replicate < options.replicates; replicate += 1) {
            const sampled = Array.from({ length: usable.length }, (_, draw) => {
                const index = stableHash(`${options.seed}:${replicate}:${draw}`) % usable.length;
                return usable[index];
            });
            const micro = ratio(aggregate(sampled));
            const macro = macroRate(sampled);
            if (micro !== null) microBootstrap.push(micro);
            if (macro !== null) macroBootstrap.push(macro);
        }
    }
    const alpha = 1 - options.confidenceLevel;
    return {
        clusters: usable.length,
        numerator: point.numerator,
        denominator: point.denominator,
        micro: {
            estimate: ratio(point),
            confidenceInterval: [
                percentile(microBootstrap, alpha / 2),
                percentile(microBootstrap, 1 - alpha / 2),
            ] as [number | null, number | null],
            oneSidedLower: percentile(microBootstrap, alpha),
        },
        macro: {
            estimate: macroRate(usable),
            confidenceInterval: [
                percentile(macroBootstrap, alpha / 2),
                percentile(macroBootstrap, 1 - alpha / 2),
            ] as [number | null, number | null],
            oneSidedLower: percentile(macroBootstrap, alpha),
        },
    };
};
