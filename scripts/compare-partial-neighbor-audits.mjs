import { readFileSync } from "node:fs";
import { join } from "node:path";

const [newDirectory, earlyBaselineDirectory, lateBaselineDirectory] = process.argv.slice(2);
if (!newDirectory || !earlyBaselineDirectory || !lateBaselineDirectory) {
    throw new Error(
        "Usage: node scripts/compare-partial-neighbor-audits.mjs "
        + "<new-audit-dir> <baseline-offsets-0-7-dir> <baseline-offsets-8-12-dir>",
    );
}

const OFFSETS = Array.from({ length: 13 }, (_, index) => index);
const keyOf = (event) => [
    event.eventType,
    event.context.file,
    event.context.target,
    event.context.year,
].join("|");
const containsYear = (range, year) => (
    Array.isArray(range) && range.length === 2 && year >= range[0] && year <= range[1]
);

const emptyMetrics = () => ({
    cases: 0,
    answered: 0,
    operationCorrect: 0,
    windowHit: 0,
    exact: 0,
    withinOne: 0,
    absoluteError: 0,
    errorCases: 0,
});

const addPrediction = (metrics, event, topYear, range, shiftYears) => {
    const truthYear = event.context.year;
    const answered = Number.isFinite(topYear);
    const operationCorrect = answered && shiftYears === event.truthShiftYears;
    metrics.cases += 1;
    metrics.answered += Number(answered);
    metrics.operationCorrect += Number(operationCorrect);
    metrics.windowHit += Number(operationCorrect && containsYear(range, truthYear));
    metrics.exact += Number(operationCorrect && topYear === truthYear);
    metrics.withinOne += Number(operationCorrect && Math.abs(topYear - truthYear) <= 1);
    if (operationCorrect) {
        metrics.absoluteError += Math.abs(topYear - truthYear);
        metrics.errorCases += 1;
    }
};

const summarize = (metrics) => ({
    cases: metrics.cases,
    response: metrics.answered / Math.max(1, metrics.cases),
    operation: metrics.operationCorrect / Math.max(1, metrics.cases),
    window: metrics.windowHit / Math.max(1, metrics.cases),
    exact: metrics.exact / Math.max(1, metrics.cases),
    withinOne: metrics.withinOne / Math.max(1, metrics.cases),
    meanAbsoluteErrorWhenOperationCorrect: (
        metrics.absoluteError / Math.max(1, metrics.errorCases)
    ),
});

const emptyComparison = () => ({
    old: emptyMetrics(),
    next: emptyMetrics(),
    changed: 0,
    improved: 0,
    worsened: 0,
    unchanged: 0,
    unmatched: 0,
});

const addComparison = (comparison, event, baseline) => {
    if (!baseline) {
        comparison.unmatched += 1;
        return;
    }
    addPrediction(
        comparison.old,
        event,
        baseline.currentTopYear,
        baseline.currentRange,
        baseline.currentShiftYears,
    );
    addPrediction(
        comparison.next,
        event,
        event.primaryPredictionTopYear,
        event.primaryPredictionRange,
        event.primaryPredictionShiftYears,
    );

    const oldOperationCorrect = baseline.currentShiftYears === event.truthShiftYears;
    const newOperationCorrect = event.primaryPredictionShiftYears === event.truthShiftYears;
    const oldError = oldOperationCorrect && Number.isFinite(baseline.currentTopYear)
        ? Math.abs(baseline.currentTopYear - event.context.year)
        : Number.POSITIVE_INFINITY;
    const newError = newOperationCorrect && Number.isFinite(event.primaryPredictionTopYear)
        ? Math.abs(event.primaryPredictionTopYear - event.context.year)
        : Number.POSITIVE_INFINITY;
    comparison.changed += Number(
        baseline.currentTopYear !== event.primaryPredictionTopYear
        || baseline.currentShiftYears !== event.primaryPredictionShiftYears,
    );
    comparison.improved += Number(newError < oldError);
    comparison.worsened += Number(newError > oldError);
    comparison.unchanged += Number(newError === oldError);
};

const summarizeComparison = (comparison) => ({
    old: summarize(comparison.old),
    next: summarize(comparison.next),
    changed: comparison.changed,
    improved: comparison.improved,
    worsened: comparison.worsened,
    netImproved: comparison.improved - comparison.worsened,
    unchanged: comparison.unchanged,
    unmatched: comparison.unmatched,
});

const aggregate = emptyComparison();
const negative = emptyComparison();
const positive = emptyComparison();
const nonPartial = emptyComparison();
const byOffset = [];
let sourceTriggerCount = 0;

for (const offset of OFFSETS) {
    const fileName = `offset-${offset}-cases-25.json`;
    const current = JSON.parse(readFileSync(join(newDirectory, fileName), "utf8"));
    const baselineDirectory = offset < 8
        ? earlyBaselineDirectory
        : lateBaselineDirectory;
    const baseline = JSON.parse(readFileSync(join(baselineDirectory, fileName), "utf8"));
    const baselineByKey = new Map(baseline.cases.map((event) => [keyOf(event), event]));
    const offsetComparison = emptyComparison();

    for (const event of current.eventCaseOutcomes) {
        const previous = baselineByKey.get(keyOf(event));
        if (event.eventType !== "partialMove") {
            addComparison(nonPartial, event, previous);
            continue;
        }
        addComparison(aggregate, event, previous);
        addComparison(offsetComparison, event, previous);
        if (event.truthShiftYears < 0) addComparison(negative, event, previous);
        if (event.truthShiftYears > 0) addComparison(positive, event, previous);
    }

    sourceTriggerCount += current.rankingCases.filter((rankCase) => (
        rankCase.sources.includes("partial_neighbor_agreement_ranker")
    )).length;
    byOffset.push({ offset, ...summarizeComparison(offsetComparison) });
}

console.log(JSON.stringify({
    partialMove: summarizeComparison(aggregate),
    negativePartialMove: summarizeComparison(negative),
    positivePartialMove: summarizeComparison(positive),
    nonPartialEvents: summarizeComparison(nonPartial),
    sourceTriggerCount,
    byOffset,
}, null, 2));
