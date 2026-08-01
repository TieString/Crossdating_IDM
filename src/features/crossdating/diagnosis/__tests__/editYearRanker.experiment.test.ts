import { describe, expect, it } from "vitest";
import { getConfig } from "../config";
import { scoreEditYearsInRegion, type EditYearScanEvidence } from "../rangeMove";
import { diagnoseSeriesCore } from "../segments";
import {
    buildSyntheticSite,
    DATA_FOLDERS,
    loadDataFolder,
    reconstructMissingFromZero,
    zeroYearsOf,
    type RwlSeries,
} from "./rdmFixture";

const TRAIN_FOLDERS = new Set(["EBD", "EBM", "RDM", "RDU"]);
const TUNE_FOLDERS = new Set(["EBU", "ZSD"]);

type WindowRow = { centerYear: number; features: number[] };
type Case = { id: string; truthYear: number; rows: WindowRow[] };

const overlapWithOthers = (series: RwlSeries, others: RwlSeries[]): number => {
    let count = 0;
    others.forEach((other) => {
        if (other.id === series.id) return;
        let overlap = 0;
        series.valuesByYear.forEach((_, year) => {
            if (other.valuesByYear.has(year)) overlap += 1;
        });
        if (overlap >= 80) count += 1;
    });
    return count;
};

const rawFeatures = (row: EditYearScanEvidence): number[] => [
    -row.residualMisalignment,
    row.boundaryStrength,
    row.localContrast,
    row.boundarySharpness,
    row.markerStrength,
    row.narrowBonus,
    row.anomalyStrength,
    -row.boundaryDistance / 100,
    row.quality,
];

const mean = (values: number[]): number => (
    values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
);

const makeWindowRows = (evidence: EditYearScanEvidence[]): WindowRow[] => {
    const byYear = new Map(evidence.map((row) => [row.year, row]));
    const windows = evidence.map((row) => {
        const neighbors: EditYearScanEvidence[] = [];
        for (let year = row.year - 3; year <= row.year + 3; year += 1) {
            const neighbor = byYear.get(year);
            if (neighbor) neighbors.push(neighbor);
        }
        const vectors = neighbors.map(rawFeatures);
        const averaged = rawFeatures(row).map((_, index) => mean(vectors.map((vector) => vector[index])));
        const maxima = rawFeatures(row).map((_, index) => Math.max(...vectors.map((vector) => vector[index])));
        return { centerYear: row.year, features: [...averaged, ...maxima] };
    });
    if (windows.length === 0) return [];
    const featureCount = windows[0].features.length;
    for (let feature = 0; feature < featureCount; feature += 1) {
        const values = windows.map((row) => row.features[feature]);
        const center = mean(values);
        const variance = mean(values.map((value) => (value - center) ** 2));
        const sd = Math.sqrt(variance) || 1;
        windows.forEach((row) => {
            row.features[feature] = (row.features[feature] - center) / sd;
        });
    }
    return windows;
};

const loadCases = (folders: Set<string>): Case[] => {
    const cases: Case[] = [];
    DATA_FOLDERS.filter((folder) => folders.has(folder)).forEach((folder) => {
        const data = loadDataFolder(folder);
        if (!data) return;
        const all = Array.from(data.crossdated.values());
        all.forEach((series) => {
            const zeros = zeroYearsOf(series);
            if (zeros.length !== 1 || series.length < 120 || overlapWithOthers(series, all) < 5) return;
            const truthYear = zeros[0];
            if (truthYear - series.startYear < 15 || series.endYear - truthYear < 15) return;
            const corrupted = reconstructMissingFromZero(series.valuesByYear, truthYear);
            const built = buildSyntheticSite(data.crossdated, series.id, corrupted, {
                minReferences: 5,
                minOverlap: 80,
            });
            if (!built.site) return;
            const config = getConfig({ referenceConfig: null });
            const diagnosis = diagnoseSeriesCore(built.site, series.id, config);
            if (!diagnosis) return;
            const midpoint = Math.round(
                (diagnosis.targetRange.startYear + diagnosis.targetRange.endYear) / 2,
            );
            const evidence = scoreEditYearsInRegion(
                diagnosis,
                "insert",
                diagnosis.targetRange.startYear + 3,
                diagnosis.targetRange.endYear - 3,
                midpoint,
                config,
            );
            cases.push({
                id: `${folder}/${series.id}`,
                truthYear,
                rows: makeWindowRows(evidence),
            });
        });
    });
    return cases;
};

const dot = (a: number[], b: number[]): number => (
    a.reduce((sum, value, index) => sum + value * b[index], 0)
);

const evaluate = (cases: Case[], weights: number[]) => {
    let hits = 0;
    let distance = 0;
    const failures: string[] = [];
    cases.forEach((testCase) => {
        const top = [...testCase.rows]
            .sort((a, b) => dot(b.features, weights) - dot(a.features, weights))[0];
        const error = top ? Math.abs(top.centerYear - testCase.truthYear) : Infinity;
        if (error <= 3) hits += 1;
        else failures.push(`${testCase.id}@${testCase.truthYear}->${top?.centerYear ?? "none"}`);
        distance += Number.isFinite(error) ? Math.min(50, error) : 50;
    });
    return {
        hits,
        recall: hits / Math.max(1, cases.length),
        meanCappedDistance: distance / Math.max(1, cases.length),
        failures,
    };
};

const randomWeights = (count: number, seed: number): number[] => {
    let state = seed >>> 0;
    const next = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
    return Array.from({ length: count }, () => (next() * 2 - 1) * 2.5);
};

describe("expert missing-ring event-window ranker experiment", () => {
    it("fits only train folders and selects only with tune folders", () => {
        const train = loadCases(TRAIN_FOLDERS);
        const tune = loadCases(TUNE_FOLDERS);
        expect(train.length).toBeGreaterThanOrEqual(10);
        expect(tune.length).toBeGreaterThanOrEqual(5);
        const featureCount = train[0].rows[0].features.length;
        const candidates: Array<{ weights: number[]; train: ReturnType<typeof evaluate> }> = [];
        for (let index = 0; index < 30000; index += 1) {
            const weights = randomWeights(featureCount, index + 17);
            const result = evaluate(train, weights);
            candidates.push({ weights, train: result });
        }
        const finalists = candidates
            .sort((a, b) => (
                b.train.recall - a.train.recall
                || a.train.meanCappedDistance - b.train.meanCappedDistance
            ))
            .slice(0, 300);
        const selected = finalists
            .map((candidate) => ({
                ...candidate,
                tune: evaluate(tune, candidate.weights),
            }))
            .sort((a, b) => (
                b.tune.recall - a.tune.recall
                || a.tune.meanCappedDistance - b.tune.meanCappedDistance
                || b.train.recall - a.train.recall
            ))[0];
        const qualityOnly = Array.from({ length: featureCount }, (_, index) => (
            index === 8 || index === 17 ? 1 : 0
        ));
        // eslint-disable-next-line no-console
        console.log(`EDIT_YEAR_RANKER ${JSON.stringify({
            trainCases: train.length,
            tuneCases: tune.length,
            baselineTrain: evaluate(train, qualityOnly),
            baselineTune: evaluate(tune, qualityOnly),
            selected: {
                weights: selected.weights,
                train: selected.train,
                tune: selected.tune,
            },
        })}`);
    }, 300000);
});
