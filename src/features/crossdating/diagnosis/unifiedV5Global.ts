import { correlation, quantile } from "./unifiedV5Math";
import { directMoments, V5_SHIFTS, type V5EvidenceContext } from "./unifiedV5Operations";
import { buildV5Paths, V5_LAG_COUNT, V5_VIEWS, V5_ZERO, type V5Path } from "./unifiedV5Path";

const WIDTHS = [1, 3, 5, 8, 13, 21, 34, 55, 89];
const GEOMETRY = ["lastJump", "latestObservations", "latestCalendarYears", "priorObservations",
    "latestLlrMean", "latestGainMean", "latestGainSum", "hasTransition", "lastPenalty"];
export const V5_GLOBAL_COLUMNS = [
    ...WIDTHS.flatMap(w => ["masterLlr50", "masterLlr70", "referenceLlrMedian", "referenceLlrQ25",
        "referenceCorrelationMedian", "referenceCoverageMedian"].map(s => `end${w}_${s}`)),
    ...V5_VIEWS.map(({ name }) => `${name}_freeOlderPathLlrMean`),
    ...V5_VIEWS.flatMap(({ name }) => GEOMETRY.map(s => `${name}_${s}`)),
].map(name => `global_${name}`);

function geometry(path: V5Path, change: number): number[][] {
    const { history, values, nulls, years } = path, size = V5_LAG_COUNT, n = years.length;
    const last = new Int32Array(n * size).fill(-1), cumulative = new Float64Array((n + 1) * size);
    for (let t = 0; t < n; t++) for (let s = 0; s < size; s++) {
        const at = t * size + s;
        cumulative[at + size] = cumulative[at]! + values[at]!;
        if (t > 0) last[at] = history[at]! > history[at - size]! + values[at]! ? t : last[at - size]!;
    }
    return V5_SHIFTS.map(shift => {
        const s = shift + V5_ZERO, at = last[(n - 1) * size + s]!;
        if (at < 0) return [0, n, years[n - 1]! - years[0]! + 1, 0, cumulative[n * size + s]! / n, 0, 0, 0, 0];
        const previous = (at - 1) * size;
        let source = s, best = history[previous + s]!, penalty = 0;
        if (s >= 2) {
            let winner = Math.max(0, s - 100);
            for (let j = winner + 1; j < s - 1; j++) if (history[previous + j]! > history[previous + winner]!) winner = j;
            const score = history[previous + winner]! - change;
            if (score > best) { source = winner; best = score; penalty = change; }
        }
        if (s > 0) {
            const score = history[previous + s - 1]! - 0.5 * change;
            if (score > best) { source = s - 1; best = score; penalty = 0.5 * change; }
        }
        if (s + 1 < size) {
            const score = history[previous + s + 1]! - 0.75 * change + (nulls[at - 1]! - values[previous + s + 1]!);
            if (score > best) { source = s + 1; penalty = 0.75 * change; }
        }
        const prior = last[previous + source]!, count = n - at;
        const matched = cumulative[n * size + s]! - cumulative[at * size + s]!;
        const old = cumulative[n * size + source]! - cumulative[at * size + source]!;
        return [source - s, count, years[n - 1]! - years[at]! + 1, at - Math.max(0, prior),
            matched / count, (matched - old) / count, matched - old, 1, penalty];
    });
}

export function buildV5GlobalEvidence(context: V5EvidenceContext): { features: Float32Array[]; paths: V5Path[] } {
    const { sample, years, target, references } = context, n = years.length;
    const rows = V5_SHIFTS.map((): number[] => []);
    function llrMean(ref: Map<number, number>, first: number, shift: number, beta: number): number {
        let count = 0, sum = 0;
        const variance = 1 - beta * beta;
        for (let t = first; t < n; t++) {
            const x = target[t]!, y = ref.get(years[t]! + shift);
            if (y === undefined || !Number.isFinite(y)) continue;
            sum += -0.5 * ((x - beta * y) ** 2 / variance - x ** 2 + Math.log(variance)); count++;
        }
        return count ? sum / count : NaN;
    }
    for (const width of WIDTHS) {
        const first = Math.max(0, n - width);
        V5_SHIFTS.forEach((shift, i) => {
            const scores = references.map(ref => llrMean(ref, first, shift, 0.7));
            const moments = references.map(ref => directMoments(years, target, ref, first, n, shift));
            rows[i]!.push(llrMean(sample.master, first, shift, 0.5), llrMean(sample.master, first, shift, 0.7),
                quantile(scores), quantile(scores, 0.25), quantile(moments.map(m => correlation(...m))),
                quantile(moments.map(m => m[0] / (n - first))));
        });
    }
    const paths = buildV5Paths(sample, true);
    paths.forEach(path => V5_SHIFTS.forEach((shift, i) => rows[i]!.push(path.history[(n - 1) * V5_LAG_COUNT + V5_ZERO + shift]! / n)));
    paths.forEach((path, view) => geometry(path, V5_VIEWS[view]!.change).forEach((features, i) => rows[i]!.push(...features)));
    return { features: rows.map(row => Float32Array.from(row)), paths };
}
