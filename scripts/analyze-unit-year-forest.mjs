import { readFileSync } from "node:fs";

const dataPaths = process.argv.slice(2);
if (dataPaths.length === 0) {
    throw new Error("Usage: node scripts/analyze-unit-year-forest.mjs <rank-cases.json> [...]");
}

const caseMap = new Map();
dataPaths.flatMap((dataPath) => JSON.parse(readFileSync(dataPath, "utf8")))
    .forEach((rankCase) => {
        const key = [rankCase.groupId, rankCase.eventType, rankCase.truthYear].join(":");
        if (!caseMap.has(key)) caseMap.set(key, rankCase);
    });
const cases = Array.from(caseMap.values());

const hash = (value) => Array.from(value).reduce(
    (result, character) => ((result * 31) + character.charCodeAt(0)) | 0,
    0,
);
const foldFor = (rankCase) => Math.abs(hash(rankCase.groupId)) % 5;

const makeRandom = (seed) => {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
};

const leaf = (rows) => {
    const positive = rows.reduce((sum, row) => sum + (row.label ? row.weight : 0), 0);
    const negative = rows.reduce((sum, row) => sum + (row.label ? 0 : row.weight), 0);
    return { probability: (positive + 0.5) / (positive + negative + 1) };
};

const impurity = (positive, negative) => {
    const total = positive + negative;
    if (total <= 0) return 0;
    const rate = positive / total;
    return total * 2 * rate * (1 - rate);
};

const shuffledFeatureSubset = (featureCount, count, random) => {
    const features = Array.from({ length: featureCount }, (_, index) => index);
    for (let index = features.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [features[index], features[other]] = [features[other], features[index]];
    }
    return features.slice(0, count);
};

const buildTree = (rows, depth, config, random, importance) => {
    const positiveCount = rows.filter((row) => row.label).length;
    if (depth >= config.maxDepth
        || rows.length < config.minRows * 2
        || positiveCount === 0
        || positiveCount === rows.length) {
        return leaf(rows);
    }

    const featureCount = rows[0].features.length;
    const features = shuffledFeatureSubset(
        featureCount,
        Math.min(featureCount, config.featuresPerSplit),
        random,
    );
    let best = null;
    for (const feature of features) {
        const ordered = [...rows].sort((a, b) => a.features[feature] - b.features[feature]);
        let leftPositive = 0;
        let leftNegative = 0;
        let rightPositive = ordered.reduce(
            (sum, row) => sum + (row.label ? row.weight : 0),
            0,
        );
        let rightNegative = ordered.reduce(
            (sum, row) => sum + (row.label ? 0 : row.weight),
            0,
        );
        const parentImpurity = impurity(rightPositive, rightNegative);
        for (let index = 0; index < ordered.length - 1; index += 1) {
            const row = ordered[index];
            if (row.label) {
                leftPositive += row.weight;
                rightPositive -= row.weight;
            } else {
                leftNegative += row.weight;
                rightNegative -= row.weight;
            }
            if (index + 1 < config.minRows
                || ordered.length - index - 1 < config.minRows
                || ordered[index].features[feature] === ordered[index + 1].features[feature]) {
                continue;
            }
            const gain = parentImpurity
                - impurity(leftPositive, leftNegative)
                - impurity(rightPositive, rightNegative);
            if (!best || gain > best.gain) {
                best = {
                    feature,
                    threshold: (ordered[index].features[feature]
                        + ordered[index + 1].features[feature]) / 2,
                    gain,
                };
            }
        }
    }
    if (!best || best.gain <= 1e-9) return leaf(rows);
    const leftRows = rows.filter((row) => row.features[best.feature] <= best.threshold);
    const rightRows = rows.filter((row) => row.features[best.feature] > best.threshold);
    if (leftRows.length < config.minRows || rightRows.length < config.minRows) return leaf(rows);
    importance[best.feature] = (importance[best.feature] ?? 0) + best.gain;
    return {
        feature: best.feature,
        threshold: best.threshold,
        left: buildTree(leftRows, depth + 1, config, random, importance),
        right: buildTree(rightRows, depth + 1, config, random, importance),
    };
};

const predictTree = (tree, features) => {
    if ("probability" in tree) return tree.probability;
    return predictTree(
        features[tree.feature] <= tree.threshold ? tree.left : tree.right,
        features,
    );
};

const trainForest = (trainingCases, config, seed) => {
    const random = makeRandom(seed);
    const trees = [];
    const importance = [];
    for (let treeIndex = 0; treeIndex < config.trees; treeIndex += 1) {
        const rows = [];
        for (let index = 0; index < trainingCases.length; index += 1) {
            const rankCase = trainingCases[Math.floor(random() * trainingCases.length)];
            rankCase.rows.forEach((row) => rows.push({
                features: row.features,
                label: row.year === rankCase.truthYear,
                weight: row.year === rankCase.truthYear ? config.positiveWeight : 1,
            }));
        }
        trees.push(buildTree(rows, 0, config, random, importance));
    }
    return { trees, importance };
};

const predictForest = (forest, features) => forest.trees.reduce(
    (sum, tree) => sum + predictTree(tree, features),
    0,
) / forest.trees.length;

const evaluate = (testCases, forest, gate) => {
    let exact = 0;
    let withinOne = 0;
    let switched = 0;
    for (const rankCase of testCases) {
        const ranked = rankCase.rows.map((row) => ({
            year: row.year,
            score: predictForest(forest, row.features),
        })).sort((a, b) => b.score - a.score || b.year - a.year);
        const margin = ranked[0].score - (ranked[1]?.score ?? ranked[0].score);
        const useForest = margin >= gate.minMargin
            && Math.abs(ranked[0].year - rankCase.currentTopYear) <= gate.maxDistance;
        const selectedYear = useForest ? ranked[0].year : rankCase.currentTopYear;
        if (selectedYear !== rankCase.currentTopYear) switched += 1;
        if (selectedYear === rankCase.truthYear) exact += 1;
        if (Math.abs(selectedYear - rankCase.truthYear) <= 1) withinOne += 1;
    }
    return { exact, withinOne, switched };
};

const configs = [2, 3, 4, 5].flatMap((maxDepth) => (
    [3, 5, 8].flatMap((minRows) => (
        [3, 6, 10].map((positiveWeight) => ({
            maxDepth,
            minRows,
            positiveWeight,
            trees: 61,
        }))
    ))
));
const gates = [0, 0.01, 0.02, 0.04, 0.08, 0.12].flatMap((minMargin) => (
    [1, 2, 3, 5].map((maxDistance) => ({ minMargin, maxDistance }))
));

for (const eventType of ["missingRing", "falseRing"]) {
    const typedCases = cases.filter((rankCase) => rankCase.eventType === eventType);
    const featureCount = typedCases[0].rows[0].features.length;
    const reports = [];
    for (const config of configs) {
        const actualConfig = {
            ...config,
            featuresPerSplit: Math.max(4, Math.round(Math.sqrt(featureCount))),
        };
        const byGate = gates.map((gate) => ({ ...gate, exact: 0, withinOne: 0, switched: 0 }));
        for (let fold = 0; fold < 5; fold += 1) {
            const training = typedCases.filter((rankCase) => foldFor(rankCase) !== fold);
            const validation = typedCases.filter((rankCase) => foldFor(rankCase) === fold);
            const forest = trainForest(training, actualConfig, 1709 + fold * 101);
            for (const gateReport of byGate) {
                const result = evaluate(validation, forest, gateReport);
                gateReport.exact += result.exact;
                gateReport.withinOne += result.withinOne;
                gateReport.switched += result.switched;
            }
        }
        byGate.forEach((gate) => reports.push({ ...actualConfig, ...gate }));
    }
    reports.sort((a, b) => (
        b.exact - a.exact
        || b.withinOne - a.withinOne
        || a.switched - b.switched
        || a.maxDepth - b.maxDepth
    ));
    const baseline = typedCases.reduce((result, rankCase) => ({
        exact: result.exact + Number(rankCase.currentTopYear === rankCase.truthYear),
        withinOne: result.withinOne
            + Number(Math.abs(rankCase.currentTopYear - rankCase.truthYear) <= 1),
    }), { exact: 0, withinOne: 0 });
    console.log(JSON.stringify({
        eventType,
        cases: typedCases.length,
        baseline,
        best: reports.slice(0, 12),
    }, null, 2));
}
