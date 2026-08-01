/**
 * Sharp fixed-side/shifted-side evidence around one physical-gap breakpoint.
 *
 * Broad correlations form long plateaus because adjacent breakpoints exchange only one value.
 * These rows instead compare the two lag hypotheses separately on each side of firstFixedYear:
 * the older side must prefer `shiftYears`, while the newer side must prefer lag 0.
 */
import {
    ar1WhitenSeries,
    preprocessSeries,
} from "./series";
import type { NumericSeries, SeriesCoreDiagnosis } from "./types";

export type BoundaryLocalCounterfactualRow = {
    year: number;
    olderAdvantage3: number;
    newerAdvantage3: number;
    stepMinimum3: number;
    stepMean3: number;
    olderAdvantage5: number;
    newerAdvantage5: number;
    stepMinimum5: number;
    stepMean5: number;
    olderAdvantage9: number;
    newerAdvantage9: number;
    stepMinimum9: number;
    stepMean9: number;
};

type PreparedView = {
    target: NumericSeries;
    master: NumericSeries;
    weight: number;
};

type Preference = {
    value: number;
    weight: number;
};

const CACHE = new WeakMap<
    SeriesCoreDiagnosis,
    Map<number, BoundaryLocalCounterfactualRow[]>
>();

const mean = (values: readonly number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = [...series.entries()].sort((left, right) => left[0] - right[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) {
            result.set(year, value - previousValue);
        }
    }
    return preprocessSeries(result);
};

const huberLoss = (residual: number, transition = 1.5): number => {
    const absolute = Math.abs(residual);
    return absolute <= transition
        ? 0.5 * residual * residual
        : transition * (absolute - transition * 0.5);
};

const prepareViews = (diagnosis: SeriesCoreDiagnosis): PreparedView[] => {
    const rawTarget = preprocessSeries(diagnosis.rawTarget);
    const rawMaster = preprocessSeries(diagnosis.master.data);
    return [
        {
            target: rawTarget,
            master: rawMaster,
            weight: 0.25,
        },
        {
            target: firstDifferences(diagnosis.rawTarget),
            master: firstDifferences(diagnosis.master.data),
            weight: 0.4,
        },
        {
            target: ar1WhitenSeries(diagnosis.rawTarget),
            master: ar1WhitenSeries(diagnosis.master.data),
            weight: 0.35,
        },
    ];
};

const shiftedPreference = (
    views: readonly PreparedView[],
    year: number,
    shiftYears: number,
): Preference | null => {
    let weighted = 0;
    let availableWeight = 0;
    views.forEach((view) => {
        const target = view.target.get(year);
        const fixed = view.master.get(year);
        const shifted = view.master.get(year + shiftYears);
        if (
            target === undefined
            || fixed === undefined
            || shifted === undefined
        ) {
            return;
        }
        weighted += (
            huberLoss(target - fixed) - huberLoss(target - shifted)
        ) * view.weight;
        availableWeight += view.weight;
    });
    return availableWeight >= 0.6
        ? { value: weighted / availableWeight, weight: availableWeight }
        : null;
};

const sideAdvantage = (
    preferences: ReadonlyMap<number, Preference>,
    startYear: number,
    endYear: number,
    sign: 1 | -1,
    minimumYears: number,
): number | null => {
    const rows = Array.from(
        { length: Math.max(0, endYear - startYear + 1) },
        (_, index) => preferences.get(startYear + index),
    ).filter((row): row is Preference => row !== undefined);
    if (rows.length < minimumYears) return null;
    const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
    return rows.reduce(
        (sum, row) => sum + row.value * row.weight * sign,
        0,
    ) / Math.max(1e-9, totalWeight);
};

const scoreRadius = (
    preferences: ReadonlyMap<number, Preference>,
    firstFixedYear: number,
    radius: number,
): {
    older: number;
    newer: number;
    minimum: number;
    average: number;
} | null => {
    const minimumYears = Math.max(2, Math.ceil(radius * 0.6));
    const older = sideAdvantage(
        preferences,
        firstFixedYear - radius,
        firstFixedYear - 1,
        1,
        minimumYears,
    );
    const newer = sideAdvantage(
        preferences,
        firstFixedYear,
        firstFixedYear + radius - 1,
        -1,
        minimumYears,
    );
    if (older === null || newer === null) return null;
    return {
        older,
        newer,
        minimum: Math.min(older, newer),
        average: mean([older, newer]),
    };
};

export const scoreBoundaryLocalCounterfactual = (
    diagnosis: SeriesCoreDiagnosis,
    shiftYears: number,
): BoundaryLocalCounterfactualRow[] => {
    if (!Number.isInteger(shiftYears) || shiftYears >= -1) return [];
    const byShift = CACHE.get(diagnosis) ?? new Map();
    const cached = byShift.get(shiftYears);
    if (cached) return cached;

    const views = prepareViews(diagnosis);
    const preferences = new Map<number, Preference>();
    for (
        let year = diagnosis.targetRange.startYear;
        year <= diagnosis.targetRange.endYear;
        year += 1
    ) {
        const preference = shiftedPreference(views, year, shiftYears);
        if (preference) preferences.set(year, preference);
    }
    const rows: BoundaryLocalCounterfactualRow[] = [];
    for (
        let year = diagnosis.targetRange.startYear + 9;
        year <= diagnosis.targetRange.endYear - 8;
        year += 1
    ) {
        const radius3 = scoreRadius(preferences, year, 3);
        const radius5 = scoreRadius(preferences, year, 5);
        const radius9 = scoreRadius(preferences, year, 9);
        if (!radius3 || !radius5 || !radius9) continue;
        rows.push({
            year,
            olderAdvantage3: radius3.older,
            newerAdvantage3: radius3.newer,
            stepMinimum3: radius3.minimum,
            stepMean3: radius3.average,
            olderAdvantage5: radius5.older,
            newerAdvantage5: radius5.newer,
            stepMinimum5: radius5.minimum,
            stepMean5: radius5.average,
            olderAdvantage9: radius9.older,
            newerAdvantage9: radius9.newer,
            stepMinimum9: radius9.minimum,
            stepMean9: radius9.average,
        });
    }
    byShift.set(shiftYears, rows);
    CACHE.set(diagnosis, byShift);
    return rows;
};
