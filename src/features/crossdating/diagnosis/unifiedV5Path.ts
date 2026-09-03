import type { UnifiedV5Sample } from "./unifiedV5Types";
import { quantile } from "./unifiedV5Math";

export const V5_LAG_MIN = -340;
export const V5_LAG_COUNT = 461;
export const V5_ZERO = 340;
export const V5_VIEWS = [
    { name: "p50c6", beta: 0.5, change: 6 },
    { name: "p70c6", beta: 0.7, change: 6 },
    { name: "p70c12", beta: 0.7, change: 12 },
] as const;
export type V5Path = {
    years: number[]; target: number[]; values: Float64Array; nulls: Float64Array;
    history: Float64Array; suffix: Float64Array;
};

export function v5Emissions(sample: UnifiedV5Sample, beta: number, censored: boolean) {
    const entries = [...sample.target].sort(([a], [b]) => a - b);
    const years = entries.map(([y]) => y), target = entries.map(([, v]) => v);
    const values = new Float64Array(years.length * V5_LAG_COUNT), nulls = new Float64Array(years.length);
    const variance = 1 - beta * beta;
    for (let t = 0; t < years.length; t++) {
        const x = target[t]!, row = values.subarray(t * V5_LAG_COUNT, (t + 1) * V5_LAG_COUNT);
        for (let lag = 0; lag < V5_LAG_COUNT; lag++) {
            const reference = sample.master.get(years[t]! + V5_LAG_MIN + lag);
            const valid = reference !== undefined && Number.isFinite(reference);
            row[lag] = valid ? (censored
                ? -0.5 * ((x - beta * reference) ** 2 / variance - x ** 2 + Math.log(variance))
                : -0.5 * (x - beta * reference) ** 2 / variance) : (censored ? 0 : -12);
        }
        if (!censored) {
            const center = quantile(row);
            for (let lag = 0; lag < row.length; lag++) row[lag] = row[lag]! - center;
            nulls[t] = -0.5 * x ** 2 - center;
        }
    }
    return { years, target, values, nulls };
}

/** Bounded 2..100 partial transitions; deterministic stay/partial/missing/false ties. */
export function v5Forward(values: Float64Array, nulls: Float64Array, change: number): Float64Array {
    const size = V5_LAG_COUNT, history = new Float64Array(values.length);
    history.set(values.subarray(0, size));
    const deque = new Int32Array(size);
    for (let t = 1; t < nulls.length; t++) {
        const previous = (t - 1) * size, current = t * size;
        let head = 0, tail = 0;
        for (let state = 0; state < size; state++) {
            const incoming = state - 2;
            if (incoming >= 0) {
                while (tail > head && history[previous + deque[tail - 1]!]! < history[previous + incoming]!) tail--;
                deque[tail++] = incoming;
            }
            while (head < tail && deque[head]! < state - 100) head++;
            const partial = state >= 2 ? history[previous + deque[head]!]! - change : -1e30;
            const missing = state > 0 ? history[previous + state - 1]! - change * 0.5 : -1e30;
            const falseRing = state + 1 < size ? history[previous + state + 1]! - change * 0.75
                + (nulls[t - 1]! - values[previous + state + 1]!) : -1e30;
            history[current + state] = values[current + state]! + Math.max(history[previous + state]!, partial, missing, falseRing);
        }
    }
    return history;
}

export function buildV5Paths(sample: UnifiedV5Sample, censored = false): V5Path[] {
    const byBeta = new Map<number, ReturnType<typeof v5Emissions>>();
    return V5_VIEWS.map(({ beta, change }) => {
        if (!byBeta.has(beta)) byBeta.set(beta, v5Emissions(sample, beta, censored));
        const base = byBeta.get(beta)!;
        const history = v5Forward(base.values, base.nulls, change), suffix = new Float64Array(base.years.length + 1);
        for (let t = base.years.length - 1; t >= 0; t--) suffix[t] = suffix[t + 1]! + base.values[t * V5_LAG_COUNT + V5_ZERO]!;
        return { ...base, history, suffix };
    });
}

export function v5BoundaryScores(path: V5Path, operation: "missing" | "false" | "partial", shift: number,
    change: number, includeTerminal: boolean): { years: number[]; scores: Float64Array } {
    const count = path.years.length - (operation === "partial" || !includeTerminal ? 1 : 0);
    const years: number[] = [], scores = new Float64Array(count);
    const penalty = change * (operation === "missing" ? 0.5 : operation === "false" ? 0.75 : 1);
    for (let i = 0; i < count; i++) {
        const at = i * V5_LAG_COUNT + V5_ZERO + shift;
        years.push(path.years[i + (operation === "partial" ? 1 : 0)]!);
        scores[i] = path.history[at]! + path.suffix[i + 1]! - penalty;
        if (operation === "false") scores[i] += path.nulls[i]! - path.values[at]!;
    }
    return { years, scores };
}

export function v5WindowStart(years: readonly number[], scores: Float64Array): number {
    const first = years[0]!, last = years[years.length - 1]!;
    if (last - first < 12) return first;
    let peak = -Infinity;
    for (const score of scores) peak = Math.max(peak, score);
    const mass = new Float64Array(last - first + 1);
    years.forEach((year, index) => { mass[year - first] = Math.exp(Math.max(-60, Math.min(0, scores[index]! - peak))); });
    let winner = 0, best = -Infinity;
    for (let start = 0; start + 12 < mass.length; start++) {
        let sum = 0;
        for (let offset = 0; offset < 13; offset++) sum += mass[start + offset]!;
        if (sum > best) { best = sum; winner = start; }
    }
    return first + winner;
}
