import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OFFSETS = Array.from({ length: 13 }, (_, index) => index);
const EVENT_TYPES = ["missingRing", "falseRing", "partialMove"];

const readAudit = (kind, offset) => {
    const relativePath = kind === "before"
        ? `.tmp-directional-review-baseline-audits/offset-${offset}-cases-25.json`
        : `.tmp-directional-review-audits/offset-${offset}-cases-25.json`;
    return JSON.parse(readFileSync(resolve(ROOT, relativePath), "utf8"));
};

const audits = Object.fromEntries(["before", "after"].map((kind) => [
    kind,
    OFFSETS.map((offset) => readAudit(kind, offset)),
]));

const outcomeKey = (row) => [
    row.context.groupId,
    row.context.target,
    row.context.year,
    row.eventType,
].join("|");

const rankingKey = (row) => [
    row.groupId,
    row.seriesId,
    row.truthYear,
    row.eventType,
].join("|");

const increment = (record, key) => {
    record[key] = (record[key] ?? 0) + 1;
};

const causalAudit = () => {
    const events = Object.fromEntries(EVENT_TYPES.map((eventType) => [
        eventType,
        {
            cases: 0,
            invariantMismatches: 0,
            primaryCoverageGained: 0,
            primaryCoverageLost: 0,
            selectableCoverageGained: 0,
            selectableCoverageLost: 0,
            widthDeltaHistogram: {},
            commonRankings: 0,
            primaryTopYearChanged: 0,
            coreRankingChanged: 0,
        },
    ]));
    let cleanMismatches = 0;
    const invariantFields = [
        "answered",
        "predictions",
        "totalPredictions",
        "operationMatched",
        "selectableOperationMatched",
        "operationRecoveryApplied",
        "operationChoices",
    ];

    for (let offsetIndex = 0; offsetIndex < OFFSETS.length; offsetIndex += 1) {
        const beforeAudit = audits.before[offsetIndex];
        const afterAudit = audits.after[offsetIndex];
        const afterOutcomes = new Map(
            afterAudit.eventCaseOutcomes.map((row) => [outcomeKey(row), row]),
        );
        for (const beforeRow of beforeAudit.eventCaseOutcomes) {
            const afterRow = afterOutcomes.get(outcomeKey(beforeRow));
            const result = events[beforeRow.eventType];
            result.cases += 1;
            if (!afterRow || invariantFields.some((field) => (
                JSON.stringify(beforeRow[field]) !== JSON.stringify(afterRow[field])
            ))) {
                result.invariantMismatches += 1;
                continue;
            }
            if (!beforeRow.primaryMatched && afterRow.primaryMatched) {
                result.primaryCoverageGained += 1;
            }
            if (beforeRow.primaryMatched && !afterRow.primaryMatched) {
                result.primaryCoverageLost += 1;
            }
            if (!beforeRow.matched && afterRow.matched) {
                result.selectableCoverageGained += 1;
            }
            if (beforeRow.matched && !afterRow.matched) {
                result.selectableCoverageLost += 1;
            }
            increment(
                result.widthDeltaHistogram,
                String(afterRow.width - beforeRow.width),
            );
        }

        const afterRankings = new Map(
            afterAudit.rankingCases.map((row) => [rankingKey(row), row]),
        );
        for (const beforeRow of beforeAudit.rankingCases) {
            const afterRow = afterRankings.get(rankingKey(beforeRow));
            if (!afterRow) continue;
            const result = events[beforeRow.eventType];
            result.commonRankings += 1;
            if (beforeRow.rankedYears[0]?.year !== afterRow.rankedYears[0]?.year) {
                result.primaryTopYearChanged += 1;
            }
            const coreRanking = (row) => row.rankedYears
                .filter((year) => !year.tags.includes("review_edge_year"))
                .map((year) => [year.year, year.score, year.tags]);
            if (JSON.stringify(coreRanking(beforeRow))
                !== JSON.stringify(coreRanking(afterRow))) {
                result.coreRankingChanged += 1;
            }
        }

        const afterClean = new Map(afterAudit.cleanCaseOutcomes.map((row) => [
            [
                row.context.groupId,
                row.context.target,
                row.context.year,
            ].join("|"),
            row,
        ]));
        for (const beforeRow of beforeAudit.cleanCaseOutcomes) {
            const key = [
                beforeRow.context.groupId,
                beforeRow.context.target,
                beforeRow.context.year,
            ].join("|");
            const afterRow = afterClean.get(key);
            if (!afterRow
                || beforeRow.falsePositive !== afterRow.falsePositive
                || beforeRow.predictions !== afterRow.predictions) {
                cleanMismatches += 1;
            }
        }
    }
    return { events, cleanMismatches };
};

const weightedRate = (rows, rateKey, denominatorKey = "cases") => {
    const denominator = rows.reduce((sum, row) => sum + row[denominatorKey], 0);
    const numerator = rows.reduce(
        (sum, row) => sum + row[rateKey] * row[denominatorKey],
        0,
    );
    return numerator / Math.max(1, denominator);
};

const aggregateEvent = (kind, eventType) => {
    const rows = audits[kind].map((audit) => audit.summary[eventType]);
    const cases = rows.reduce((sum, row) => sum + row.cases, 0);
    const matchedCases = rows.reduce(
        (sum, row) => sum + row.selectableRecall * row.cases,
        0,
    );
    const selectedExact = rows.reduce(
        (sum, row) => sum + row.selectedTop1ExactAll * row.cases,
        0,
    );
    const selectedWithinOne = rows.reduce(
        (sum, row) => sum + row.selectedTop1WithinOneAll * row.cases,
        0,
    );
    return {
        cases,
        responseRate: weightedRate(rows, "responseRate"),
        operationAccuracy: weightedRate(rows, "operationAccuracy"),
        selectableOperationAccuracy: weightedRate(rows, "selectableOperationAccuracy"),
        primaryWindowRecall: weightedRate(rows, "primaryWindowRecall"),
        selectableWindowRecall: weightedRate(rows, "selectableRecall"),
        precision: rows.reduce(
            (sum, row) => sum + row.precision * row.predictions,
            0,
        ) / Math.max(1, rows.reduce((sum, row) => sum + row.predictions, 0)),
        selectedTop1ExactAll: selectedExact / Math.max(1, cases),
        selectedTop1ExactCovered: selectedExact / Math.max(1, matchedCases),
        selectedTop1WithinOneAll: selectedWithinOne / Math.max(1, cases),
        selectedTop1WithinOneCovered: selectedWithinOne / Math.max(1, matchedCases),
        medianWidthsByOffset: rows.map((row) => row.medianWidth),
    };
};

const aggregateClean = (kind) => {
    const rows = audits[kind].map((audit) => audit.summary.clean);
    return {
        cases: rows.reduce((sum, row) => sum + row.cases, 0),
        falsePositiveRate: weightedRate(rows, "falsePositiveRate"),
    };
};

const aggregate = (kind) => ({
    events: Object.fromEntries(EVENT_TYPES.map((eventType) => [
        eventType,
        aggregateEvent(kind, eventType),
    ])),
    clean: aggregateClean(kind),
});

const before = aggregate("before");
const after = aggregate("after");
const deltas = Object.fromEntries(EVENT_TYPES.map((eventType) => [
    eventType,
    Object.fromEntries([
        "responseRate",
        "operationAccuracy",
        "selectableOperationAccuracy",
        "primaryWindowRecall",
        "selectableWindowRecall",
        "precision",
        "selectedTop1ExactAll",
        "selectedTop1ExactCovered",
        "selectedTop1WithinOneAll",
        "selectedTop1WithinOneCovered",
    ].map((key) => [
        key,
        after.events[eventType][key] - before.events[eventType][key],
    ])),
]));

console.log(JSON.stringify({
    sampling: "calendar-position-stratified-signal-independent",
    offsets: OFFSETS,
    before,
    after,
    deltas,
    causalAudit: causalAudit(),
    cleanFalsePositiveDelta: after.clean.falsePositiveRate - before.clean.falsePositiveRate,
}, null, 2));
