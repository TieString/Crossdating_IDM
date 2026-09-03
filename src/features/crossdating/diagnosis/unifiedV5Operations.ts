import type { UnifiedV5Sample } from "./unifiedV5Types";
import { correlation, logSumExp, lowerBound, MomentPrefix, quantile, referenceQuality } from "./unifiedV5Math";
import { buildV5Paths, v5BoundaryScores, V5_LAG_COUNT, V5_VIEWS, V5_ZERO, v5WindowStart, type V5Path } from "./unifiedV5Path";

export type V5Operation = "none" | "whole" | "missing" | "false" | "partial";
export type V5Identity = readonly [V5Operation, number];
export const V5_IDENTITIES: V5Identity[] = [
    ["none", 0], ...Array.from({ length: 201 }, (_, i): V5Identity => ["whole", i - 100]).filter(([, s]) => s !== 0),
    ["missing", -1], ["false", 1], ...Array.from({ length: 99 }, (_, i): V5Identity => ["partial", i - 100]),
];
export const V5_SHIFTS = Array.from({ length: 201 }, (_, i) => i - 100);
const FAMILIES: V5Operation[] = ["none", "whole", "missing", "false", "partial"];
const CONSTANT_WIDTHS = [5, 10, 15, 25, 50, 100, null];
export const V5_BASE_COLUMNS = ["shift", "absShift", ...FAMILIES.map(name => `is_${name}`),
    ...V5_VIEWS.flatMap(({ name }) => ["Gain", "GlobalDelta", "FamilyDelta", "FamilyRank", "WindowMass", "Distance"].map(s => name + s)),
    ...[20, 40].flatMap(w => ["BeforeMedian", "BeforeQ25", "AfterMedian", "AfterQ25", "GainMedian", "GainQ25", "Positive", "Count"].map(s => `ref${w}${s}`)),
].sort().concat(CONSTANT_WIDTHS.flatMap(w => ["Corr", "Pairs", "Delta"].map(s => `constant${s}${w ?? "Full"}`)));

export type V5EvidenceContext = {
    sample: UnifiedV5Sample; years: number[]; target: number[]; references: Map<number, number>[];
    prefixes: MomentPrefix[]; paths: V5Path[]; base: Float32Array[]; windows: Int32Array;
};

export function directMoments(years: readonly number[], target: readonly number[], reference: Map<number, number>,
    first: number, last: number, shift: number): [number, number, number, number, number, number] {
    let n = 0, sx = 0, sy = 0, xx = 0, yy = 0, xy = 0;
    for (let t = first; t < last; t++) {
        const x = target[t]!, y = reference.get(years[t]! + shift);
        if (y === undefined || !Number.isFinite(y)) continue;
        n++; sx += x; sy += y; xx += x * x; yy += y * y; xy += x * y;
    }
    return [n, sx, sy, xx, yy, xy];
}

export function buildV5OperationEvidence(sample: UnifiedV5Sample): V5EvidenceContext {
    const paths = buildV5Paths(sample), { years, target } = paths[0]!;
    if (years.length < 2 || sample.references.length === 0) throw new Error("Insufficient v5 evidence");
    const references = sample.references.map(ref => ({ ref, quality: referenceQuality(ref, sample.master) }))
        .sort((a, b) => b.quality - a.quality).slice(0, 8).map(({ ref }) => ref);
    const prefixes = references.map(ref => new MomentPrefix(years, target, ref, V5_SHIFTS));
    const records = V5_IDENTITIES.map(([operation, shift]) => Object.fromEntries([
        ["shift", shift], ["absShift", Math.abs(shift)], ...FAMILIES.map(name => [`is_${name}`, Number(operation === name)]),
    ]) as Record<string, number>);
    let windows = new Int32Array(records.length);
    V5_VIEWS.forEach(({ name, change }, view) => {
        const path = paths[view]!, none = path.suffix[0]!, scores: number[] = [], masses: number[] = [], starts: number[] = [];
        for (const [operation, shift] of V5_IDENTITIES) {
            if (operation === "none" || operation === "whole") {
                scores.push(operation === "none" ? none : path.history[(years.length - 1) * V5_LAG_COUNT + V5_ZERO + shift]! - change);
                masses.push(1); starts.push(0);
            } else {
                const boundary = v5BoundaryScores(path, operation, shift, change, false);
                const start = v5WindowStart(boundary.years, boundary.scores), score = logSumExp(boundary.scores);
                const first = lowerBound(boundary.years, start), last = lowerBound(boundary.years, start + 13);
                scores.push(score); starts.push(start); masses.push(Math.exp(logSumExp(boundary.scores, first, last) - score));
            }
        }
        const best = Math.max(...scores);
        records.forEach((record, i) => {
            const operation = V5_IDENTITIES[i]![0];
            const family = scores.filter((_, index) => V5_IDENTITIES[index]![0] === operation);
            Object.assign(record, {
                [`${name}Gain`]: (scores[i]! - none) / Math.sqrt(years.length),
                [`${name}GlobalDelta`]: scores[i]! - best,
                [`${name}FamilyDelta`]: scores[i]! - Math.max(...family),
                [`${name}FamilyRank`]: family.filter(score => score <= scores[i]!).length / family.length,
                [`${name}WindowMass`]: masses[i],
                [`${name}Distance`]: operation === "none" || operation === "whole" ? 0 : years[years.length - 1]! - starts[i]! - 6,
            });
        });
        if (name === "p70c6") windows = Int32Array.from(starts);
    });
    records.forEach((record, i) => {
        const [operation, shift] = V5_IDENTITIES[i]!;
        const split = operation === "none" || operation === "whole" ? years.length : lowerBound(years, windows[i]! + 6);
        for (const width of [20, 40]) {
            const first = Math.max(0, split - width);
            const pairs = prefixes.map(p => [p.corr(first, split, 0, 9, -1), p.corr(first, split, shift, 9, -1)])
                .filter(([before, after]) => before! > -0.999 && after! > -0.999);
            for (const [name, values] of [
                ["Before", pairs.map(([a]) => a!)], ["After", pairs.map(([, b]) => b!)], ["Gain", pairs.map(([a, b]) => b! - a!)],
            ] as const) {
                record[`ref${width}${name}Median`] = pairs.length ? quantile(values) : -1;
                record[`ref${width}${name}Q25`] = pairs.length ? quantile(values, 0.25) : -1;
            }
            record[`ref${width}Positive`] = pairs.filter(([a, b]) => b! > a!).length / Math.max(1, pairs.length);
            record[`ref${width}Count`] = pairs.length;
        }
    });
    // The historical 41-field block used finite sentinels before appending the
    // exact constant-lag block. Preserve that boundary, not a global imputer.
    for (const record of records) for (const key of Object.keys(record)) {
        const value = record[key]!;
        record[key] = Math.fround(Number.isNaN(value) ? -1e6 : value === Infinity ? 1e6 : value === -Infinity ? -1e6 : value);
    }
    for (const width of CONSTANT_WIDTHS) {
        const first = width === null ? 0 : lowerBound(years, years[years.length - 1]! - width + 1);
        const moments = V5_SHIFTS.map(shift => directMoments(years, target, sample.master, first, years.length, shift));
        const correlations = moments.map(m => correlation(...m));
        const available = correlations.filter(Number.isFinite), best = available.length ? Math.max(...available) : NaN;
        records.forEach((record, i) => {
            const at = V5_IDENTITIES[i]![1] + 100;
            record[`constantCorr${width ?? "Full"}`] = correlations[at]!;
            record[`constantPairs${width ?? "Full"}`] = moments[at]![0];
            record[`constantDelta${width ?? "Full"}`] = correlations[at]! - best;
        });
    }
    return { sample, years, target, references, prefixes, paths, windows,
        base: records.map(record => Float32Array.from(V5_BASE_COLUMNS.map(name => record[name]!))) };
}
