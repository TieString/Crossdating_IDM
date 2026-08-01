import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OFFSETS = Array.from({ length: 13 }, (_, index) => index);
const EVENT_TYPES = ["missingRing", "falseRing", "partialMove"];

const auditPath = (offset) => resolve(
    ROOT,
    offset <= 7
        ? `.tmp-window-ranker-broad/offset-${offset}-cases-25.json`
        : `.tmp-window-ranker/offset-${offset}-cases-25.json`,
);

const cases = OFFSETS.flatMap((offset) => {
    const audit = JSON.parse(readFileSync(auditPath(offset), "utf8"));
    return audit.cases.map((row) => ({ ...row, offset }));
});

const median = (values) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) / 2)];
};

const quantile = (values, probability) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) * probability)];
};

const operationMatches = (row) => (
    row.currentRange !== null
    && (
        row.eventType !== "partialMove"
        || row.currentShiftYears === row.truthShiftYears
    )
);

const rangeWidth = ([startYear, endYear]) => endYear - startYear + 1;

const clampRange = (range, row) => {
    const firstYear = row.rows[0]?.year ?? range[0];
    const lastYear = row.rows.at(-1)?.year ?? range[1];
    return [
        Math.max(firstYear, range[0]),
        Math.min(lastYear, range[1]),
    ];
};

const padRange = (row, olderPadding, newerPadding = olderPadding) => {
    if (!row.currentRange) return null;
    return clampRange([
        row.currentRange[0] - olderPadding,
        row.currentRange[1] + newerPadding,
    ], row);
};

const contains = (range, year) => (
    range !== null && year >= range[0] && year <= range[1]
);

const missDistance = (range, year) => {
    if (!range || contains(range, year)) return 0;
    return year < range[0] ? range[0] - year : year - range[1];
};

const signalYear = (row, signal) => {
    const availableKey = `${signal}Available`;
    const distanceKey = `${signal}Distance`;
    const available = row.rows.some((candidate) => (
        candidate.features[availableKey] === 1
    ));
    if (!available) return null;
    return [...row.rows].sort((left, right) => (
        left.features[distanceKey] - right.features[distanceKey]
        || right.year - left.year
    ))[0]?.year ?? null;
};

const SIGNALS = [
    "profile",
    "scan",
    "rawPath",
    "candidate",
    "direct",
    "paired",
    "reference",
];

const signalYears = (row) => SIGNALS
    .map((signal) => signalYear(row, signal))
    .filter((year) => year !== null);

const directionalSignalPadding = (
    row,
    basePadding,
    extraPadding,
    voteThreshold,
    maximumSignalDistance,
) => {
    if (!row.currentRange) return null;
    const [startYear, endYear] = row.currentRange;
    const years = signalYears(row).filter((year) => (
        year >= startYear - maximumSignalDistance
        && year <= endYear + maximumSignalDistance
    ));
    const olderVotes = years.filter((year) => year < startYear).length;
    const newerVotes = years.filter((year) => year > endYear).length;
    const olderPadding = basePadding + (
        olderVotes >= voteThreshold && olderVotes > newerVotes ? extraPadding : 0
    );
    const newerPadding = basePadding + (
        newerVotes >= voteThreshold && newerVotes > olderVotes ? extraPadding : 0
    );
    return padRange(row, olderPadding, newerPadding);
};

const topEdgePadding = (row, basePadding, extraPadding, edgeDistance) => {
    if (!row.currentRange || row.currentTopYear === null) return null;
    const [startYear, endYear] = row.currentRange;
    const olderPadding = basePadding + (
        row.currentTopYear - startYear <= edgeDistance ? extraPadding : 0
    );
    const newerPadding = basePadding + (
        endYear - row.currentTopYear <= edgeDistance ? extraPadding : 0
    );
    return padRange(row, olderPadding, newerPadding);
};

const confidencePadding = (row, highPadding, otherPadding) => (
    padRange(row, row.currentConfidence === "high" ? highPadding : otherPadding)
);

const rangeFromSignalCenter = (row, maximumDistance, minimumVotes) => {
    if (!row.currentRange || row.currentTopYear === null) return null;
    const nearby = signalYears(row).filter((year) => (
        Math.abs(year - row.currentTopYear) <= maximumDistance
    ));
    const center = nearby.length >= minimumVotes
        ? median([...nearby, row.currentTopYear])
        : row.currentTopYear;
    const width = rangeWidth(row.currentRange);
    const startYear = center - Math.floor((width - 1) / 2);
    return clampRange([startYear, startYear + width - 1], row);
};

const rules = [
    ...[0, 1, 2, 3, 4].map((padding) => ({
        name: `fixed_pad_${padding}`,
        range: (row) => padRange(row, padding),
    })),
    ...[0, 1, 2].flatMap((edgeDistance) => [1, 2].map((extraPadding) => ({
        name: `top_edge_${edgeDistance}_base1_extra${extraPadding}`,
        range: (row) => topEdgePadding(row, 1, extraPadding, edgeDistance),
    }))),
    ...[0, 1].flatMap((highPadding) => [1, 2, 3].map((otherPadding) => ({
        name: `confidence_high${highPadding}_other${otherPadding}`,
        range: (row) => confidencePadding(row, highPadding, otherPadding),
    }))),
    ...[1, 2, 3].flatMap((voteThreshold) => (
        [1, 2].flatMap((extraPadding) => [3, 5, 8].map((maximumSignalDistance) => ({
            name: `signal_vote${voteThreshold}_base1_extra${extraPadding}_distance${maximumSignalDistance}`,
            range: (row) => directionalSignalPadding(
                row,
                1,
                extraPadding,
                voteThreshold,
                maximumSignalDistance,
            ),
        })))
    )),
    ...[2, 3, 4, 5].flatMap((maximumDistance) => [2, 3, 4].map((minimumVotes) => ({
        name: `signal_center_distance${maximumDistance}_votes${minimumVotes}`,
        range: (row) => rangeFromSignalCenter(row, maximumDistance, minimumVotes),
    }))),
];

const summarize = (rows, rule) => {
    const allCases = rows.length;
    const operationRows = rows.filter(operationMatches);
    const ranged = operationRows
        .map((row) => ({ row, range: rule.range(row) }))
        .filter(({ range }) => range !== null);
    const hits = ranged.filter(({ row, range }) => contains(range, row.truthYear));
    const widths = ranged.map(({ range }) => rangeWidth(range));
    return {
        cases: allCases,
        operationMatches: operationRows.length,
        allCaseCoverage: hits.length / Math.max(1, allCases),
        operationConditionalCoverage: hits.length / Math.max(1, operationRows.length),
        medianWidth: median(widths),
        p90Width: quantile(widths, 0.9),
    };
};

const scoreRule = (rule, selectedCases) => {
    const overall = Object.fromEntries(EVENT_TYPES.map((eventType) => [
        eventType,
        summarize(
            selectedCases.filter((row) => row.eventType === eventType),
            rule,
        ),
    ]));
    const byOffset = Object.fromEntries(OFFSETS.map((offset) => [
        offset,
        Object.fromEntries(EVENT_TYPES.map((eventType) => [
            eventType,
            summarize(
                selectedCases.filter((row) => (
                    row.offset === offset && row.eventType === eventType
                )),
                rule,
            ),
        ])),
    ]));
    const meanCoverage = EVENT_TYPES.reduce(
        (sum, eventType) => sum + overall[eventType].allCaseCoverage,
        0,
    ) / EVENT_TYPES.length;
    const worstOffsetCoverage = Math.min(...OFFSETS.flatMap((offset) => (
        EVENT_TYPES.map((eventType) => byOffset[offset][eventType].allCaseCoverage)
    )));
    const meanWidth = EVENT_TYPES.reduce(
        (sum, eventType) => sum + (overall[eventType].medianWidth ?? 0),
        0,
    ) / EVENT_TYPES.length;
    return {
        name: rule.name,
        meanCoverage,
        worstOffsetCoverage,
        meanWidth,
        overall,
        byOffset,
    };
};

const scored = rules.map((rule) => scoreRule(rule, cases));
const fixedPadOne = scored.find((row) => row.name === "fixed_pad_1");
const compact = (row, baseline) => ({
    name: row.name,
    meanCoverage: row.meanCoverage,
    worstOffsetCoverage: row.worstOffsetCoverage,
    meanWidth: row.meanWidth,
    overall: Object.fromEntries(EVENT_TYPES.map((eventType) => [
        eventType,
        {
            coverage: row.overall[eventType].allCaseCoverage,
            conditional: row.overall[eventType].operationConditionalCoverage,
            width: row.overall[eventType].medianWidth,
            p90Width: row.overall[eventType].p90Width,
        },
    ])),
    ...(baseline ? {
        stabilityAgainstFixedPad1: Object.fromEntries(EVENT_TYPES.map((eventType) => {
            const deltas = OFFSETS.map((offset) => (
                row.byOffset[offset][eventType].allCaseCoverage
                - baseline.byOffset[offset][eventType].allCaseCoverage
            ));
            return [eventType, {
                betterOffsets: deltas.filter((value) => value > 1e-12).length,
                tiedOffsets: deltas.filter((value) => Math.abs(value) <= 1e-12).length,
                worseOffsets: deltas.filter((value) => value < -1e-12).length,
                minimumDelta: Math.min(...deltas),
                maximumDelta: Math.max(...deltas),
            }];
        })),
    } : {}),
});

const eligible = cases.filter(operationMatches);
const coreMisses = eligible.filter((row) => (
    !contains(row.currentRange, row.truthYear)
));
const missDistribution = Object.fromEntries(EVENT_TYPES.map((eventType) => {
    const rows = coreMisses.filter((row) => row.eventType === eventType);
    const distances = rows.map((row) => missDistance(row.currentRange, row.truthYear));
    return [eventType, {
        misses: rows.length,
        byDistance: Object.fromEntries(
            [...new Set(distances)].sort((left, right) => left - right).map((distance) => [
                distance,
                distances.filter((value) => value === distance).length,
            ]),
        ),
        olderSide: rows.filter((row) => row.truthYear < row.currentRange[0]).length,
        newerSide: rows.filter((row) => row.truthYear > row.currentRange[1]).length,
        byPosition: Object.fromEntries([
            "olderEdge",
            "olderInterior",
            "middle",
            "newerInterior",
            "newerEdge",
        ].map((position) => [
            position,
            rows.filter((row) => row.context.positionStratum === position).length,
        ])),
    }];
}));

const pareto = scored
    .filter((candidate) => !scored.some((other) => (
        other.name !== candidate.name
        && other.meanCoverage >= candidate.meanCoverage
        && other.meanWidth <= candidate.meanWidth
        && (
            other.meanCoverage > candidate.meanCoverage
            || other.meanWidth < candidate.meanWidth
        )
    )))
    .sort((left, right) => (
        left.meanWidth - right.meanWidth
        || right.meanCoverage - left.meanCoverage
    ));

const selectedNames = new Set([
    "fixed_pad_0",
    "fixed_pad_1",
    "fixed_pad_2",
    "fixed_pad_3",
    ...pareto.map((row) => row.name),
]);

console.log(JSON.stringify({
    sampling: "calendar-position-stratified-signal-independent",
    offsets: OFFSETS,
    cases: cases.length,
    missDistribution,
    selectedRules: scored
        .filter((row) => selectedNames.has(row.name))
        .sort((left, right) => (
            left.meanWidth - right.meanWidth
            || right.meanCoverage - left.meanCoverage
        ))
        .map((row) => compact(row, fixedPadOne)),
    topCoverageAtMeanWidthAtMost11: scored
        .filter((row) => row.meanWidth <= 11)
        .sort((left, right) => (
            right.meanCoverage - left.meanCoverage
            || right.worstOffsetCoverage - left.worstOffsetCoverage
            || left.meanWidth - right.meanWidth
        ))
        .slice(0, 12)
        .map((row) => compact(row, fixedPadOne)),
}, null, 2));
