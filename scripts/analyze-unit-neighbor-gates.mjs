import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length < 2) {
    throw new Error(
        "Usage: node scripts/analyze-unit-neighbor-gates.mjs <offset-json> [...]",
    );
}

const featureNames = [
    "raw31",
    "difference31",
    "whitened31",
    "raw11",
    "difference11",
    "whitened11",
    "combo11",
    "combo21",
    "combo31",
    "combo41",
    "combo61",
    "multiScale",
    "rawHuber5",
    "rawHuber7",
    "rawHuber11",
    "rawHuber31",
    "differenceHuber5",
    "differenceHuber7",
    "differenceHuber11",
    "differenceHuber31",
    "whitenedHuber5",
    "whitenedHuber7",
    "whitenedHuber11",
    "whitenedHuber31",
    "huberCombo5",
    "huberCombo7",
    "huberCombo11",
    "huberCombo31",
    "huberMultiScale",
    "pairMean31",
    "pairMedian31",
    "pairTrimmed31",
    "pairWeighted31",
    "bestReference31",
    "pairedCore31",
    "currentTop",
    "distance",
    "signedDistance",
    "edge",
    "directProximity",
    "directSignedDistance",
    "pairedProximity",
    "pairedSignedDistance",
    "consensusProximity",
    "exactVoteCount",
    "withinOneVoteCount",
    "betweenIndependent",
];
const featureIndex = new Map(featureNames.map((name, index) => [name, index]));
const cases = paths.flatMap((path, offset) => (
    JSON.parse(readFileSync(path, "utf8")).map((rankCase) => ({ ...rankCase, offset }))
));
const thresholds = [0, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5];
const candidateFeatures = {
    missingRing: [
        "huberCombo11",
        "huberMultiScale",
        "combo21",
        "combo11",
        "consensusProximity",
        "withinOneVoteCount",
        "exactVoteCount",
    ],
    falseRing: [
        "difference31",
        "differenceHuber31",
        "huberCombo31",
        "whitened31",
        "combo31",
        "multiScale",
        "withinOneVoteCount",
    ],
};

const localPeak = (rankCase, feature, minimumMargin) => {
    const index = featureIndex.get(feature);
    const ranked = rankCase.rows
        .filter((row) => Math.abs(row.year - rankCase.currentTopYear) <= 1)
        .map((row) => ({ year: row.year, score: row.features[index] }))
        .sort((left, right) => right.score - left.score || right.year - left.year);
    if (ranked.length < 2) return null;
    const margin = ranked[0].score - ranked[1].score;
    return margin >= minimumMargin ? { year: ranked[0].year, margin } : null;
};

const predict = (rankCase, strategy) => {
    const first = localPeak(rankCase, strategy.first, strategy.firstMargin);
    if (!first || first.year === rankCase.currentTopYear) return rankCase.currentTopYear;
    if (!strategy.second) return first.year;
    const second = localPeak(rankCase, strategy.second, strategy.secondMargin);
    return second?.year === first.year ? first.year : rankCase.currentTopYear;
};

const empty = () => ({
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
const summarize = (metrics) => ({
    cases: metrics.cases,
    exact: metrics.exact / Math.max(1, metrics.cases),
    withinOne: metrics.withinOne / Math.max(1, metrics.cases),
    meanAbsoluteError: metrics.absoluteError / Math.max(1, metrics.cases),
    changed: metrics.changed,
    improved: metrics.improved,
    worsened: metrics.worsened,
    netImproved: metrics.improved - metrics.worsened,
});
const evaluate = (rows, strategy = null) => {
    const metrics = empty();
    rows.forEach((rankCase) => add(
        metrics,
        rankCase,
        strategy ? predict(rankCase, strategy) : rankCase.currentTopYear,
    ));
    return summarize(metrics);
};
const delta = (candidate, baseline) => ({
    exact: candidate.exact - baseline.exact,
    withinOne: candidate.withinOne - baseline.withinOne,
    meanAbsoluteError: candidate.meanAbsoluteError - baseline.meanAbsoluteError,
});

const analyze = (eventType) => {
    const typed = cases.filter((rankCase) => rankCase.eventType === eventType);
    const training = typed.filter((rankCase) => rankCase.offset <= 7);
    const validation = typed.filter((rankCase) => rankCase.offset >= 8);
    const baseline = {
        all: evaluate(typed),
        training: evaluate(training),
        validation: evaluate(validation),
    };
    const features = candidateFeatures[eventType];
    const singles = features.flatMap((first) => thresholds.map((firstMargin) => ({
        first,
        firstMargin,
        second: null,
        secondMargin: null,
    })));
    const agreements = features.flatMap((first, firstIndex) => (
        features.slice(firstIndex + 1).flatMap((second) => (
            thresholds.flatMap((firstMargin) => thresholds.map((secondMargin) => ({
                first,
                firstMargin,
                second,
                secondMargin,
            })))
        ))
    ));
    const strategies = [...singles, ...agreements].map((strategy) => {
        const all = evaluate(typed, strategy);
        const train = evaluate(training, strategy);
        const validate = evaluate(validation, strategy);
        const offsets = [...new Set(typed.map((rankCase) => rankCase.offset))].map((offset) => {
            const rows = typed.filter((rankCase) => rankCase.offset === offset);
            const before = evaluate(rows);
            const after = evaluate(rows, strategy);
            return { offset, ...delta(after, before), changed: after.changed };
        });
        return {
            ...strategy,
            all,
            training: train,
            validation: validate,
            delta: {
                all: delta(all, baseline.all),
                training: delta(train, baseline.training),
                validation: delta(validate, baseline.validation),
            },
            nondecreasingExactOffsets: offsets.filter((row) => row.exact >= 0).length,
            nondecreasingWithinOneOffsets: offsets.filter((row) => row.withinOne >= 0).length,
            worsenedOffsets: offsets.filter((row) => (
                row.exact < 0 || row.withinOne < 0
            )).map((row) => row.offset),
        };
    });
    const eligible = strategies.filter((row) => (
        row.delta.training.exact > 0
        && row.delta.validation.exact > 0
        && row.delta.training.withinOne >= 0
        && row.delta.validation.withinOne >= 0
        && row.delta.all.meanAbsoluteError <= 0
    ));
    eligible.sort((left, right) => (
        right.nondecreasingWithinOneOffsets - left.nondecreasingWithinOneOffsets
        || right.nondecreasingExactOffsets - left.nondecreasingExactOffsets
        || right.delta.validation.exact - left.delta.validation.exact
        || right.delta.all.exact - left.delta.all.exact
        || right.all.netImproved - left.all.netImproved
        || left.all.changed - right.all.changed
    ));
    return {
        cases: typed.length,
        baseline,
        eligibleStrategies: eligible.length,
        top: eligible.slice(0, 30),
    };
};

process.stdout.write(`${JSON.stringify({
    sampling: "calendar-position-stratified-signal-independent",
    offsets: paths.length,
    missingRing: analyze("missingRing"),
    falseRing: analyze("falseRing"),
}, null, 2)}\n`);
