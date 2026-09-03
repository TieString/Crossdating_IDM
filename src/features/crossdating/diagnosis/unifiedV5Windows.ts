import { logSumExp, lowerBound, quantile, roundEven } from "./unifiedV5Math";
import { V5_BASE_COLUMNS, V5_IDENTITIES, type V5EvidenceContext } from "./unifiedV5Operations";
import { v5BoundaryScores, V5_VIEWS } from "./unifiedV5Path";

export const V5_LOCAL_COLUMNS = ["hasWindow", "windowAge", "windowAgeFraction", "positiveFraction", "zeroFraction", "calendarCoverage",
    ...V5_VIEWS.flatMap(({ name }) => ["Offset", "AbsoluteOffset", "Overlap"].map(s => name + s)),
    ...[5, 15, 35].flatMap(w => ["GainMedian", "GainQ25", "Positive", "BeforeMedian", "AfterMedian", "NewerMedian", "ReferenceCount"].map(s => `local${w}${s}`)),
];
export const V5_PROFILE_COLUMNS = [
    ...V5_VIEWS.flatMap(({ name }) => ["LocalGain", "LocalLogMass", "LocalPeakDelta", "LeftEdgeFraction", "RightEdgeFraction", "OlderMass", "NewerMass"].map(s => name + s)),
    "newerSuffixCorrelationMedian", "newerSuffixCorrelationQ25", "newerSuffixMseMedian", "newerSuffixPairsMedian",
];
export type V5ProposalSpec = { top_k: number; stride: number; reference_count: number };
export const V5_PROPOSAL_SPEC: V5ProposalSpec = { top_k: 5, stride: 13, reference_count: 8 };
export type V5Windows = { features: Float32Array[]; codes: Int16Array; starts: Int32Array };

export function buildV5Windows(context: V5EvidenceContext, rawEntries: ReadonlyArray<readonly [number, number | null]>,
    spec: V5ProposalSpec = V5_PROPOSAL_SPEC): V5Windows {
    if (JSON.stringify(spec) !== JSON.stringify(V5_PROPOSAL_SPEC)) throw new Error("Frozen v5 proposal specification mismatch");
    const raw = new Map(rawEntries.filter(([, value]) => value !== null && value !== -9999));
    const rawYears = [...raw.keys()].sort((a, b) => a - b), zeros = rawYears.filter(y => raw.get(y) === 0);
    const first = rawYears[0]!, last = rawYears[rawYears.length - 1]!;
    if (!(last - first >= 12)) throw new Error("A 13-year window needs a 13-year calendar span");
    const { base, years, prefixes } = context;
    const selected = new Set(V5_IDENTITIES.flatMap(([op], i) => op === "none" || op === "missing" || op === "false" ? [i] : []));
    for (const family of ["whole", "partial"]) for (const { name } of V5_VIEWS) {
        const column = V5_BASE_COLUMNS.indexOf(name + "Gain");
        V5_IDENTITIES.flatMap(([op], i) => op === family ? [i] : [])
            .sort((a, b) => base[b]![column]! - base[a]![column]!).slice(0, spec.top_k).forEach(i => selected.add(i));
    }
    const grid = new Set<number>([last - 12]);
    for (let start = first; start < last - 11; start += spec.stride) grid.add(start);
    const codes: number[] = [], starts: number[] = [], output: Float32Array[] = [];
    for (const identity of [...selected].sort((a, b) => a - b)) {
        const [operation, shift] = V5_IDENTITIES[identity]!;
        const local = operation !== "none" && operation !== "whole";
        const modes = V5_VIEWS.map(({ name }) => roundEven(years[years.length - 1]! - 6 - base[identity]![V5_BASE_COLUMNS.indexOf(name + "Distance")]!));
        const proposed = local ? [...new Set([...grid, ...modes.flatMap(mode => [-6, -3, 0, 3, 6].map(offset => Math.max(first, Math.min(mode + offset, last - 12))))])].sort((a, b) => a - b) : [0];
        for (const start of proposed) {
            const extra = new Float32Array(V5_LOCAL_COLUMNS.length).fill(NaN);
            extra[0] = Number(local);
            if (local) {
                const center = start + 6;
                extra[1] = last - center; extra[2] = (last - center) / Math.max(1, last - first);
                extra[3] = (lowerBound(years, start + 13) - lowerBound(years, start)) / 13;
                extra[4] = (lowerBound(zeros, start + 13) - lowerBound(zeros, start)) / 13;
                extra[5] = (lowerBound(rawYears, start + 13) - lowerBound(rawYears, start)) / 13;
                modes.forEach((mode, view) => {
                    const difference = start - mode;
                    extra.set([Math.max(-50, Math.min(50, difference / 13)), Math.min(50, Math.abs(difference) / 13), Math.max(0, 13 - Math.abs(difference)) / 13], 6 + view * 3);
                });
                const older = lowerBound(years, center, operation === "missing"), newer = lowerBound(years, center, operation !== "partial");
                [5, 15, 35].forEach((width, index) => {
                    const before = prefixes.map(p => p.corr(Math.max(0, older - width), older, 0));
                    const after = prefixes.map(p => p.corr(Math.max(0, older - width), older, shift));
                    const fixed = prefixes.map(p => p.corr(newer, Math.min(years.length, newer + width), 0));
                    const gain = before.map((v, i) => Number.isFinite(v) && Number.isFinite(after[i]) ? after[i]! - v : NaN);
                    const count = gain.filter(Number.isFinite).length;
                    extra.set([quantile(gain), quantile(gain, 0.25), gain.filter(v => v > 0).length / Math.max(1, count),
                        quantile(before), quantile(after), quantile(fixed), count], 15 + index * 7);
                });
            }
            const combined = new Float32Array(base[identity]!.length + extra.length);
            combined.set(base[identity]!); combined.set(extra, base[identity]!.length);
            codes.push(identity); starts.push(start); output.push(combined);
        }
    }
    return { features: output, codes: Int16Array.from(codes), starts: Int32Array.from(starts) };
}

export function buildV5Profiles(context: V5EvidenceContext, windows: V5Windows): Float32Array[] {
    const { codes, starts } = windows, { years, prefixes } = context;
    const result = Array.from(codes, () => new Float32Array(V5_PROFILE_COLUMNS.length).fill(NaN));
    const localIds = [...new Set(codes)].filter(id => !["none", "whole"].includes(V5_IDENTITIES[id]![0]));
    V5_VIEWS.forEach(({ change }, view) => {
        const path = context.paths[view]!;
        for (const identity of localIds) {
            const [operation, shift] = V5_IDENTITIES[identity]!;
            if (operation === "none" || operation === "whole") continue;
            const { years: boundary, scores } = v5BoundaryScores(path, operation, shift, change, true);
            const total = logSumExp(scores), peak = Math.max(...scores), cumulative = new Float64Array(scores.length + 1);
            for (let t = 0; t < scores.length; t++) cumulative[t + 1] = cumulative[t]! + Math.exp(scores[t]! - peak);
            const totalMass = cumulative[cumulative.length - 1]!;
            for (let row = 0; row < codes.length; row++) {
                if (codes[row] !== identity) continue;
                const start = starts[row]!, first = lowerBound(boundary, start), last = lowerBound(boundary, start + 13);
                if (first === last) continue;
                const normalizer = logSumExp(scores, first, last);
                let localPeak = -Infinity, left = 0, right = 0;
                for (let t = first; t < last; t++) {
                    localPeak = Math.max(localPeak, scores[t]!);
                    const probability = Math.exp(scores[t]! - normalizer);
                    if (boundary[t]! < start + 3) left += probability;
                    if (boundary[t]! >= start + 10) right += probability;
                }
                result[row]!.set([(normalizer - path.suffix[0]!) / Math.sqrt(years.length), normalizer - total, localPeak - peak,
                    left, right, cumulative[first]! / totalMass, (totalMass - cumulative[last]!) / totalMass], view * 7);
            }
        }
    });
    for (let row = 0; row < codes.length; row++) {
        if (!localIds.includes(codes[row]!)) continue;
        const begin = lowerBound(years, starts[row]! + 13);
        const correlations = prefixes.map(p => p.corr(begin, years.length, 0));
        const moments = prefixes.map(p => p.moments(begin, years.length, 0));
        const mse = moments.map(([n, , , xx, yy, xy]) => n > 0 ? (xx + 0.49 * yy - 1.4 * xy) / n : NaN);
        result[row]!.set([quantile(correlations), quantile(correlations, 0.25), quantile(mse), quantile(moments.map(m => m[0]))], 21);
    }
    return result;
}
