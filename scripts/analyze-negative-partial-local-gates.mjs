import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length < 2) {
    throw new Error(
        "Usage: node scripts/analyze-negative-partial-local-gates.mjs <rank-data.json> [...]",
    );
}

const featureNames = [
    "raw31",
    "difference31",
    "whitened31",
    "combo31",
    "combo41",
    "combo61",
    "multiScale",
];
const productionWeights = [
    0.709878, -0.006797, 0.174039, 0.286984, 0.223884, 0.221359, 0.298197,
    0.401502, 0.179308, 0.090044, 0.108214,
];
const cases = paths.flatMap((path, offset) => (
    JSON.parse(readFileSync(path, "utf8"))
        .filter((rankCase) => rankCase.eventType === "partialMove")
        .map((rankCase) => ({ ...rankCase, offset }))
));

const dot = (values, weights) => values.reduce(
    (sum, value, index) => sum + value * weights[index],
    0,
);
const scoreFunctions = Object.fromEntries([
    ...featureNames.map((name, index) => [
        name,
        (row) => row.features[index],
    ]),
    [
        "multiScaleCombo41",
        (row) => row.features[6] * 0.7 + row.features[4] * 0.3,
    ],
    [
        "productionLinear",
        (row) => dot(row.features, productionWeights),
    ],
]);

const configurations = Object.keys(scoreFunctions).flatMap((feature) => (
    ["local", "global"].flatMap((scope) => (
        [1, 2].flatMap((maximumMove) => (
            [0, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5].map((minimumMargin) => ({
                feature,
                scope,
                maximumMove,
                minimumMargin,
            }))
        ))
    ))
)).concat([
    {
        feature: "rawComboAgreement",
        scope: "local",
        maximumMove: 1,
        minimumMargin: 0,
    },
    {
        feature: "rawBlendAgreement",
        scope: "local",
        maximumMove: 1,
        minimumMargin: 0,
    },
    {
        feature: "comboBlendAgreement",
        scope: "local",
        maximumMove: 1,
        minimumMargin: 0,
    },
    {
        feature: "productionThenAgreement",
        scope: "local",
        maximumMove: 1,
        minimumMargin: 0,
    },
]);

const predictScored = (
    rankCase,
    configuration,
    currentTopYear = rankCase.currentTopYear,
) => {
    const score = scoreFunctions[configuration.feature];
    const current = rankCase.rows.find((row) => row.year === currentTopYear);
    if (!current) return currentTopYear;
    const eligible = configuration.scope === "local"
        ? rankCase.rows.filter((row) => (
            Math.abs(row.year - currentTopYear) <= configuration.maximumMove
        ))
        : rankCase.rows;
    const ranked = eligible
        .map((row) => ({ row, score: score(row) }))
        .sort((left, right) => (
            right.score - left.score || right.row.year - left.row.year
        ));
    const selected = ranked[0];
    const runnerUp = ranked[1];
    if (!selected || !runnerUp) return currentTopYear;
    if (Math.abs(selected.row.year - currentTopYear) > configuration.maximumMove) {
        return currentTopYear;
    }
    return selected.score - runnerUp.score >= configuration.minimumMargin
        ? selected.row.year
        : currentTopYear;
};

const predict = (rankCase, configuration) => {
    if (configuration.feature === "productionThenAgreement") {
        const production = predictScored(rankCase, {
            feature: "productionLinear",
            scope: "global",
            maximumMove: 1,
            minimumMargin: 0.05,
        });
        const raw = predictScored(rankCase, {
            feature: "raw31",
            scope: "local",
            maximumMove: 1,
            minimumMargin: 0.1,
        }, production);
        const combo = predictScored(rankCase, {
            feature: "combo41",
            scope: "local",
            maximumMove: 1,
            minimumMargin: 0.05,
        }, production);
        return raw === combo ? raw : production;
    }
    if (configuration.feature === "rawComboAgreement") {
        const raw = predictScored(rankCase, {
            feature: "raw31",
            scope: "local",
            maximumMove: 1,
            minimumMargin: 0.1,
        });
        const combo = predictScored(rankCase, {
            feature: "combo41",
            scope: "local",
            maximumMove: 1,
            minimumMargin: 0.05,
        });
        return raw === combo ? raw : rankCase.currentTopYear;
    }
    if (configuration.feature === "rawBlendAgreement") {
        const raw = predictScored(rankCase, {
            feature: "raw31",
            scope: "local",
            maximumMove: 1,
            minimumMargin: 0.1,
        });
        const blend = predictScored(rankCase, {
            feature: "multiScaleCombo41",
            scope: "local",
            maximumMove: 1,
            minimumMargin: 0.1,
        });
        return raw === blend ? raw : rankCase.currentTopYear;
    }
    if (configuration.feature === "comboBlendAgreement") {
        const combo = predictScored(rankCase, {
            feature: "combo41",
            scope: "local",
            maximumMove: 1,
            minimumMargin: 0.05,
        });
        const blend = predictScored(rankCase, {
            feature: "multiScaleCombo41",
            scope: "local",
            maximumMove: 1,
            minimumMargin: 0.1,
        });
        return combo === blend ? combo : rankCase.currentTopYear;
    }
    return predictScored(rankCase, configuration);
};

const emptyMetrics = () => ({
    cases: 0,
    exact: 0,
    withinOne: 0,
    absoluteError: 0,
    changed: 0,
    improved: 0,
    worsened: 0,
});
const add = (metrics, rankCase, predictedYear) => {
    const before = Math.abs(rankCase.currentTopYear - rankCase.truthYear);
    const after = Math.abs(predictedYear - rankCase.truthYear);
    metrics.cases += 1;
    metrics.exact += Number(after === 0);
    metrics.withinOne += Number(after <= 1);
    metrics.absoluteError += after;
    metrics.changed += Number(predictedYear !== rankCase.currentTopYear);
    metrics.improved += Number(after < before);
    metrics.worsened += Number(after > before);
};
const rates = (metrics) => ({
    cases: metrics.cases,
    exact: metrics.exact / Math.max(1, metrics.cases),
    withinOne: metrics.withinOne / Math.max(1, metrics.cases),
    meanAbsoluteError: metrics.absoluteError / Math.max(1, metrics.cases),
    changeRate: metrics.changed / Math.max(1, metrics.cases),
    improved: metrics.improved,
    worsened: metrics.worsened,
    netImproved: metrics.improved - metrics.worsened,
});
const evaluate = (evaluationCases, configuration) => {
    const metrics = emptyMetrics();
    evaluationCases.forEach((rankCase) => add(
        metrics,
        rankCase,
        configuration ? predict(rankCase, configuration) : rankCase.currentTopYear,
    ));
    return rates(metrics);
};
const compare = (left, right) => (
    right.metrics.exact - left.metrics.exact
    || right.metrics.withinOne - left.metrics.withinOne
    || left.metrics.meanAbsoluteError - right.metrics.meanAbsoluteError
    || right.metrics.netImproved - left.metrics.netImproved
    || left.metrics.changeRate - right.metrics.changeRate
);

const rankedConfigurations = configurations.map((configuration) => ({
    ...configuration,
    metrics: evaluate(cases, configuration),
})).sort(compare);

const offsets = [...new Set(cases.map((rankCase) => rankCase.offset))].sort(
    (left, right) => left - right,
);
const crossValidatedMetrics = emptyMetrics();
const folds = offsets.map((heldOutOffset) => {
    const training = cases.filter((rankCase) => rankCase.offset !== heldOutOffset);
    const validation = cases.filter((rankCase) => rankCase.offset === heldOutOffset);
    const selected = configurations.map((configuration) => ({
        ...configuration,
        metrics: evaluate(training, configuration),
    })).sort(compare)[0];
    validation.forEach((rankCase) => add(
        crossValidatedMetrics,
        rankCase,
        predict(rankCase, selected),
    ));
    return {
        heldOutOffset,
        validationCases: validation.length,
        selected: {
            feature: selected.feature,
            scope: selected.scope,
            maximumMove: selected.maximumMove,
            minimumMargin: selected.minimumMargin,
        },
        validation: evaluate(validation, selected),
    };
});

const fixed = rankedConfigurations[0];
const byOffset = (configuration) => Object.fromEntries(offsets.map((offset) => {
    const offsetCases = cases.filter((rankCase) => rankCase.offset === offset);
    return [offset, {
        baseline: evaluate(offsetCases, null),
        candidate: evaluate(offsetCases, configuration),
    }];
}));
const fixedByOffset = byOffset(fixed);

const productionConfiguration = {
    feature: "productionLinear",
    scope: "global",
    maximumMove: 1,
    minimumMargin: 0.05,
};

process.stdout.write(`${JSON.stringify({
    cases: cases.length,
    offsets,
    baseline: evaluate(cases, null),
    currentProductionGate: evaluate(cases, productionConfiguration),
    productionThenAgreement: {
        metrics: evaluate(cases, {
            feature: "productionThenAgreement",
            scope: "local",
            maximumMove: 1,
            minimumMargin: 0,
        }),
        byOffset: byOffset({
            feature: "productionThenAgreement",
            scope: "local",
            maximumMove: 1,
            minimumMargin: 0,
        }),
    },
    conservativeAgreement: {
        metrics: evaluate(cases, {
            feature: "rawComboAgreement",
            scope: "local",
            maximumMove: 1,
            minimumMargin: 0,
        }),
        byOffset: byOffset({
            feature: "rawComboAgreement",
            scope: "local",
            maximumMove: 1,
            minimumMargin: 0,
        }),
    },
    topConfigurations: rankedConfigurations.slice(0, 20),
    bestFixedByOffset: fixedByOffset,
    leaveOneOffsetOut: {
        metrics: rates(crossValidatedMetrics),
        folds,
    },
}, null, 2)}\n`);
