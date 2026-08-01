import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error("Pass one or more rank-cases JSON files");

const byKey = new Map();
paths.flatMap((path) => JSON.parse(readFileSync(path, "utf8"))).forEach((rankCase) => {
    const key = [rankCase.groupId, rankCase.eventType, rankCase.truthYear].join(":");
    if (!byKey.has(key)) byKey.set(key, rankCase);
});
const allCases = Array.from(byKey.values());

const hash = (value) => Array.from(value).reduce(
    (result, character) => ((result * 31) + character.charCodeAt(0)) | 0,
    0,
);
const foldFor = (rankCase) => Math.abs(hash(rankCase.groupId)) % 5;

const expand = (features, mode) => {
    if (mode === "linear") return features;
    if (mode === "squared") return [...features, ...features.map((value) => value * value)];
    const anchorIndices = [0, 8, 29, 31, 32, 34, 35, 39, 41, 43, 44, 45];
    const interactions = [];
    for (let left = 0; left < anchorIndices.length; left += 1) {
        for (let right = left + 1; right < anchorIndices.length; right += 1) {
            interactions.push(features[anchorIndices[left]] * features[anchorIndices[right]]);
        }
    }
    return [
        ...features,
        ...features.map((value) => value * value),
        ...interactions,
    ];
};

const solve = (matrix, vector) => {
    const size = vector.length;
    const augmented = matrix.map((row, index) => [...row, vector[index]]);
    for (let pivot = 0; pivot < size; pivot += 1) {
        let best = pivot;
        for (let row = pivot + 1; row < size; row += 1) {
            if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[best][pivot])) best = row;
        }
        [augmented[pivot], augmented[best]] = [augmented[best], augmented[pivot]];
        const divisor = augmented[pivot][pivot];
        if (Math.abs(divisor) < 1e-12) return null;
        for (let column = pivot; column <= size; column += 1) {
            augmented[pivot][column] /= divisor;
        }
        for (let row = 0; row < size; row += 1) {
            if (row === pivot) continue;
            const factor = augmented[row][pivot];
            if (factor === 0) continue;
            for (let column = pivot; column <= size; column += 1) {
                augmented[row][column] -= factor * augmented[pivot][column];
            }
        }
    }
    return augmented.map((row) => row[size]);
};

const fit = (cases, mode, regularization, positiveWeight) => {
    const featureCount = expand(cases[0].rows[0].features, mode).length;
    const matrix = Array.from({ length: featureCount }, () => new Float64Array(featureCount));
    const vector = new Float64Array(featureCount);
    for (const rankCase of cases) {
        for (const row of rankCase.rows) {
            const features = expand(row.features, mode);
            const label = Number(row.year === rankCase.truthYear);
            const weight = label ? positiveWeight : 1;
            for (let left = 0; left < featureCount; left += 1) {
                vector[left] += features[left] * label * weight;
                for (let right = 0; right <= left; right += 1) {
                    matrix[left][right] += features[left] * features[right] * weight;
                }
            }
        }
    }
    for (let left = 0; left < featureCount; left += 1) {
        for (let right = 0; right < left; right += 1) matrix[right][left] = matrix[left][right];
        matrix[left][left] += regularization;
    }
    return solve(matrix.map((row) => Array.from(row)), Array.from(vector));
};

const dot = (left, right) => left.reduce(
    (sum, value, index) => sum + value * right[index],
    0,
);

const evaluate = (cases, weights, mode, gate) => {
    let exact = 0;
    let withinOne = 0;
    let switched = 0;
    for (const rankCase of cases) {
        const ranked = rankCase.rows.map((row) => ({
            year: row.year,
            score: dot(expand(row.features, mode), weights),
        })).sort((a, b) => b.score - a.score || b.year - a.year);
        const margin = ranked[0].score - (ranked[1]?.score ?? ranked[0].score);
        const selected = margin >= gate.minMargin
            && Math.abs(ranked[0].year - rankCase.currentTopYear) <= gate.maxDistance
            ? ranked[0].year
            : rankCase.currentTopYear;
        exact += Number(selected === rankCase.truthYear);
        withinOne += Number(Math.abs(selected - rankCase.truthYear) <= 1);
        switched += Number(selected !== rankCase.currentTopYear);
    }
    return { exact, withinOne, switched };
};

const configs = ["linear", "squared", "interactions"].flatMap((mode) => (
    [0.01, 0.1, 1, 10, 100].flatMap((regularization) => (
        [1, 3, 6, 10].map((positiveWeight) => ({ mode, regularization, positiveWeight }))
    ))
));
const gates = [0, 0.005, 0.01, 0.02, 0.04, 0.08, 0.12, 0.2].flatMap((minMargin) => (
    [1, 2, 3, 5].map((maxDistance) => ({ minMargin, maxDistance }))
));

for (const eventType of ["missingRing", "falseRing"]) {
    const cases = allCases.filter((rankCase) => rankCase.eventType === eventType);
    const reports = [];
    for (const config of configs) {
        const byGate = gates.map((gate) => ({ ...gate, exact: 0, withinOne: 0, switched: 0 }));
        for (let fold = 0; fold < 5; fold += 1) {
            const training = cases.filter((rankCase) => foldFor(rankCase) !== fold);
            const validation = cases.filter((rankCase) => foldFor(rankCase) === fold);
            const weights = fit(
                training,
                config.mode,
                config.regularization,
                config.positiveWeight,
            );
            if (!weights) continue;
            for (const report of byGate) {
                const result = evaluate(validation, weights, config.mode, report);
                report.exact += result.exact;
                report.withinOne += result.withinOne;
                report.switched += result.switched;
            }
        }
        byGate.forEach((gate) => reports.push({ ...config, ...gate }));
    }
    reports.sort((a, b) => (
        b.exact - a.exact
        || b.withinOne - a.withinOne
        || a.switched - b.switched
        || a.regularization - b.regularization
    ));
    const baseline = cases.reduce((result, rankCase) => ({
        exact: result.exact + Number(rankCase.currentTopYear === rankCase.truthYear),
        withinOne: result.withinOne
            + Number(Math.abs(rankCase.currentTopYear - rankCase.truthYear) <= 1),
    }), { exact: 0, withinOne: 0 });
    console.log(JSON.stringify({ eventType, cases: cases.length, baseline, best: reports.slice(0, 15) }, null, 2));
}
