/** Numeric primitives shared by the frozen v5 evidence port. */
export const lowerBound = (values: ArrayLike<number>, value: number, right = false): number => {
    let lo = 0, hi = values.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (values[mid]! < value || (right && values[mid] === value)) lo = mid + 1;
        else hi = mid;
    }
    return lo;
};

export const quantile = (values: ArrayLike<number>, q = 0.5): number => {
    const sorted = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return NaN;
    const at = (sorted.length - 1) * q, lo = Math.floor(at), fraction = at - lo;
    // Match NumPy's lerp branch to avoid a needless rounding difference.
    const a = sorted[lo]!, b = sorted[Math.ceil(at)]!;
    return fraction < 0.5 ? a + (b - a) * fraction : b - (b - a) * (1 - fraction);
};

/** NumPy's contiguous float64 reduction order (eight lanes, 128-value blocks). */
export const pairwiseSum = (values: ArrayLike<number>, first = 0, last = values.length): number => {
    const length = last - first;
    if (length < 8) {
        let sum = -0;
        for (let i = first; i < last; i++) sum += values[i]!;
        return sum;
    }
    if (length <= 128) {
        const lanes = Array.from({ length: 8 }, (_, i) => values[first + i]!);
        let i = first + 8;
        for (; i < last - length % 8; i += 8) for (let j = 0; j < 8; j++) lanes[j] = lanes[j]! + values[i + j]!;
        let sum = ((lanes[0]! + lanes[1]!) + (lanes[2]! + lanes[3]!)) + ((lanes[4]! + lanes[5]!) + (lanes[6]! + lanes[7]!));
        for (; i < last; i++) sum += values[i]!;
        return sum;
    }
    let half = Math.floor(length / 2); half -= half % 8;
    return pairwiseSum(values, first, first + half) + pairwiseSum(values, first + half, last);
};

export const logSumExp = (values: ArrayLike<number>, first = 0, last = values.length): number => {
    if (first === last) return -Infinity;
    let peak = -Infinity;
    for (let i = first; i < last; i++) peak = Math.max(peak, values[i]!);
    // Frozen SciPy separates all maxima before log1p. The conventional
    // peak+log(sum(exp(...))) can break ties in the family-rank feature.
    const exponentials = new Float64Array(last - first);
    let maxima = 0;
    for (let i = first; i < last; i++) {
        if (values[i] === peak) maxima++;
        else exponentials[i - first] = Math.exp(values[i]! - peak);
    }
    return Math.log1p(pairwiseSum(exponentials) / maxima) + Math.log(maxima) + peak;
};

export const roundEven = (value: number): number => {
    const lo = Math.floor(value), fraction = value - lo;
    return fraction === 0.5 ? lo + (lo % 2 === 0 ? 0 : 1) : Math.round(value);
};

export const correlation = (n: number, sx: number, sy: number, xx: number, yy: number, xy: number,
    minimum = 3, missing = NaN): number => {
    const count = Math.max(n, 1);
    const scale = Math.sqrt(Math.max(0, (xx - sx * sx / count) * (yy - sy * sy / count)));
    return n >= minimum && scale > 1e-12 ? (xy - sx * sy / count) / scale : missing;
};

export const referenceQuality = (reference: Map<number, number>, master: Map<number, number>): number => {
    const pairs = [...reference].filter(([year]) => master.has(year));
    if (pairs.length < 20) return -1;
    const n = pairs.length;
    const mx = pairs.reduce((s, [, x]) => s + x, 0) / n;
    const my = pairs.reduce((s, [y]) => s + master.get(y)!, 0) / n;
    let xx = 0, yy = 0, xy = 0;
    for (const [year, value] of pairs) {
        const x = value - mx, y = master.get(year)! - my;
        xx += x * x; yy += y * y; xy += x * y;
    }
    return Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy)));
};

/** Prefixes use the exact observed target rows, not interpolated calendar rows. */
export class MomentPrefix {
    private readonly values: Float64Array;
    private readonly indexes: Map<number, number>;
    constructor(years: readonly number[], target: readonly number[], reference: Map<number, number>, shifts: number[]) {
        this.indexes = new Map(shifts.map((shift, index) => [shift, index]));
        this.values = new Float64Array((years.length + 1) * shifts.length * 6);
        for (let t = 0; t < years.length; t++) for (let l = 0; l < shifts.length; l++) {
            const before = (t * shifts.length + l) * 6, after = before + shifts.length * 6;
            const x = target[t]!, y = reference.get(years[t]! + shifts[l]!);
            const terms = y !== undefined && Number.isFinite(y) ? [1, x, y, x * x, y * y, x * y] : [0, 0, 0, 0, 0, 0];
            for (let k = 0; k < 6; k++) this.values[after + k] = this.values[before + k]! + terms[k]!;
        }
    }
    moments(first: number, last: number, shift: number): [number, number, number, number, number, number] {
        const l = this.indexes.get(shift);
        if (l === undefined) throw new Error(`Uncomputed lag ${shift}`);
        const a = (first * this.indexes.size + l) * 6, b = (last * this.indexes.size + l) * 6;
        return [0, 1, 2, 3, 4, 5].map(k => this.values[b + k]! - this.values[a + k]!) as [number, number, number, number, number, number];
    }
    corr(first: number, last: number, shift: number, minimum = 3, missing = NaN): number {
        return correlation(...this.moments(first, last, shift), minimum, missing);
    }
}
