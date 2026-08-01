import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length === 0) {
    throw new Error(
        "Usage: node scripts/analyze-primary-window-edge-shift.mjs <audit.json> [...]",
    );
}

const eventTypes = ["missingRing", "falseRing", "partialMove"];
const audits = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
const ratio = (value, total) => value / Math.max(1, total);
const contains = (range, year) => year >= range[0] && year <= range[1];

const noteYearEntries = (notes) => (notes ?? []).flatMap((note) => {
    const match = /^([A-Za-z0-9_]+)_year=(-?\d+)$/.exec(note);
    return match ? [{ key: match[1], year: Number(match[2]) }] : [];
});

const familyFor = (key) => {
    if (key === "scan_top") return "scan";
    if (key === "raw_path_top") return "rawPath";
    if (key === "candidate_top") return "candidate";
    if (key === "profile_boundary") return "profile";
    if (key === "nominal_boundary") return "nominal";
    if (key === "paired_breakpoint") return "pairedBreakpoint";
    if (key === "direct_transition") return "directTransition";
    if (key === "reference_vote") return "referenceVote";
    if (key === "endpoint_residual_posterior_top") return "endpointPosterior";
    if (key === "endpoint_residual_top") return "endpointSelected";
    if (key === "endpoint_residual_previous_top") return "previousTop";
    if (key === "unit_local_raw_boundary") return "rawTransform";
    if (key.startsWith("partial_")) return "partial";
    if (!key.startsWith("unit_local_") && !key.startsWith("unit_window_")) {
        return key;
    }
    if (key.includes("difference")) return "differenceTransform";
    if (key.includes("whitened")) return "whitenedTransform";
    if (key.includes("combo") || key.includes("multiScale")) return "comboTransform";
    if (
        key.includes("pairMean")
        || key.includes("pairMedian")
        || key.includes("pairTrimmed")
        || key.includes("pairWeighted")
        || key.includes("bestReference")
        || key.includes("pairedCore")
    ) {
        return "referenceTransform";
    }
    if (key.includes("raw")) return "rawTransform";
    return "otherUnit";
};

const representativeYear = (years, currentTop) => {
    const counts = new Map();
    for (const year of years) counts.set(year, (counts.get(year) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => (
        right[1] - left[1]
        || Math.abs(left[0] - currentTop) - Math.abs(right[0] - currentTop)
        || right[0] - left[0]
    ))[0]?.[0] ?? currentTop;
};

const familyYears = (notes, currentTop) => {
    const grouped = new Map();
    for (const entry of noteYearEntries(notes)) {
        const family = familyFor(entry.key);
        const years = grouped.get(family) ?? [];
        years.push(entry.year);
        grouped.set(family, years);
    }
    return Object.fromEntries([...grouped.entries()].map(([family, years]) => [
        family,
        representativeYear(years, currentTop),
    ]));
};

const noteNumber = (notes, prefix) => {
    const note = [...(notes ?? [])]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const value = Number(note?.slice(prefix.length));
    return Number.isFinite(value) ? value : null;
};

const contextKey = (file, target, year) => `${file}\u0000${target}\u0000${year}`;
const outcomeKey = (file, target, eventType, year) => (
    `${contextKey(file, target, year)}\u0000${eventType}`
);

const metadataMatches = (failure, prediction) => (
    failure.eventType !== "partialMove"
    || (
        (prediction.locations?.[0]?.shiftYears ?? prediction.shiftYears)
            === -failure.injectedShift
        && (prediction.locations?.[0]?.shiftSide ?? prediction.shiftSide) === "older"
    )
);

const rows = [];
const totals = Object.fromEntries(eventTypes.map((eventType) => [eventType, 0]));
for (const audit of audits) {
    const contexts = new Map((audit.caseContexts ?? []).map((context) => [
        contextKey(context.file, context.target, context.year),
        context,
    ]));
    const seen = new Set();
    for (const eventType of eventTypes) {
        totals[eventType] += audit.summary[eventType].cases;
    }

    for (const rankCase of audit.rankingCases ?? []) {
        const topYear = rankCase.locations?.[0]?.topYear
            ?? rankCase.rankedYears?.[0]?.year;
        if (!Number.isFinite(topYear)) continue;
        const key = outcomeKey(
            rankCase.groupId,
            rankCase.seriesId,
            rankCase.eventType,
            rankCase.truthYear,
        );
        seen.add(key);
        rows.push({
            offset: audit.offset,
            file: rankCase.groupId,
            target: rankCase.seriesId,
            eventType: rankCase.eventType,
            truthYear: rankCase.truthYear,
            range: rankCase.locations?.[0]?.range ?? rankCase.range,
            topYear,
            notes: rankCase.notes ?? [],
            context: contexts.get(contextKey(
                rankCase.groupId,
                rankCase.seriesId,
                rankCase.truthYear,
            )) ?? {
                normalizedPosition: rankCase.normalizedPosition,
                signalStrength: rankCase.signalStrength,
            },
        });
    }

    for (const failure of audit.failures ?? []) {
        if (!eventTypes.includes(failure.eventType)) continue;
        const key = outcomeKey(
            failure.file,
            failure.target,
            failure.eventType,
            failure.truthYear,
        );
        if (seen.has(key)) continue;
        const prediction = failure.predictions?.find((candidate) => (
            candidate.type === failure.eventType && metadataMatches(failure, candidate)
        ));
        if (!prediction) continue;
        const location = prediction.locations?.[0];
        const topYear = location?.topYear ?? prediction.topYear;
        const range = location?.range ?? prediction.range;
        if (!Number.isFinite(topYear) || !Array.isArray(range)) continue;
        rows.push({
            offset: audit.offset,
            file: failure.file,
            target: failure.target,
            eventType: failure.eventType,
            truthYear: failure.truthYear,
            range,
            topYear,
            notes: prediction.notes ?? [],
            context: contexts.get(contextKey(
                failure.file,
                failure.target,
                failure.truthYear,
            )) ?? {},
        });
    }
}

for (const row of rows) {
    row.familyYears = familyYears(row.notes, row.topYear);
    row.endpointMass = noteNumber(row.notes, "endpoint_residual_window_mass=");
}

const familySets = {
    transforms: [
        "rawTransform",
        "differenceTransform",
        "whitenedTransform",
        "comboTransform",
        "referenceTransform",
    ],
    independent: [
        "scan",
        "rawPath",
        "candidate",
        "rawTransform",
        "differenceTransform",
        "whitenedTransform",
        "referenceTransform",
    ],
    broad: [
        "scan",
        "rawPath",
        "candidate",
        "profile",
        "nominal",
        "rawTransform",
        "differenceTransform",
        "whitenedTransform",
        "comboTransform",
        "referenceTransform",
        "referenceVote",
        "endpointPosterior",
    ],
    residualIndependent: [
        "scan",
        "candidate",
        "rawTransform",
        "differenceTransform",
        "whitenedTransform",
        "referenceTransform",
        "endpointPosterior",
    ],
};

const proposeShift = (row, config) => {
    const [start, end] = row.range;
    const center = (start + end) / 2;
    let direction = 0;
    if (row.topYear <= start + config.edgeDepth) direction = -1;
    if (row.topYear >= end - config.edgeDepth) direction = 1;
    if (direction === 0) return 0;

    const familyNames = familySets[config.familySet];
    const years = familyNames
        .map((family) => row.familyYears[family])
        .filter(Number.isFinite)
        .filter((year) => (
            config.maxTopDistance === Infinity
            || Math.abs(year - row.topYear) <= config.maxTopDistance
        ));
    const same = years.filter((year) => (
        direction < 0
            ? year <= center - config.deadzone
            : year >= center + config.deadzone
    )).length;
    const opposite = years.filter((year) => (
        direction < 0
            ? year >= center + config.deadzone
            : year <= center - config.deadzone
    )).length;
    return (
        same >= config.minSupport
        && same - opposite >= config.minMargin
    ) ? direction : 0;
};

const shiftedRange = (range, shift) => [range[0] + shift, range[1] + shift];
const evaluate = (eventRows, totalCases, config) => {
    const metrics = {
        cases: totalCases,
        typedPredictions: eventRows.length,
        baselineHits: 0,
        selectedHits: 0,
        switched: 0,
        gained: 0,
        lost: 0,
        baselineExact: 0,
        selectedExact: 0,
        baselineWithinOne: 0,
        selectedWithinOne: 0,
    };
    for (const row of eventRows) {
        const shift = config ? proposeShift(row, config) : 0;
        const selectedRange = shiftedRange(row.range, shift);
        const selectedTop = row.topYear + shift;
        const baselineHit = contains(row.range, row.truthYear);
        const selectedHit = contains(selectedRange, row.truthYear);
        metrics.baselineHits += Number(baselineHit);
        metrics.selectedHits += Number(selectedHit);
        metrics.switched += Number(shift !== 0);
        metrics.gained += Number(!baselineHit && selectedHit);
        metrics.lost += Number(baselineHit && !selectedHit);
        metrics.baselineExact += Number(row.topYear === row.truthYear);
        metrics.selectedExact += Number(selectedTop === row.truthYear);
        metrics.baselineWithinOne += Number(Math.abs(row.topYear - row.truthYear) <= 1);
        metrics.selectedWithinOne += Number(Math.abs(selectedTop - row.truthYear) <= 1);
    }
    return {
        ...metrics,
        baselineCoverage: ratio(metrics.baselineHits, totalCases),
        selectedCoverage: ratio(metrics.selectedHits, totalCases),
        baselineExactRate: ratio(metrics.baselineExact, totalCases),
        selectedExactRate: ratio(metrics.selectedExact, totalCases),
        baselineWithinOneRate: ratio(metrics.baselineWithinOne, totalCases),
        selectedWithinOneRate: ratio(metrics.selectedWithinOne, totalCases),
    };
};

const configurations = [];
for (const familySet of Object.keys(familySets)) {
    for (const edgeDepth of [0, 1, 2, 3]) {
        for (const deadzone of [0, 1, 2]) {
            for (const maxTopDistance of [1, 2, 3, 5, 8, Infinity]) {
                for (const minSupport of [1, 2, 3, 4, 5]) {
                    for (const minMargin of [0, 1, 2, 3]) {
                        configurations.push({
                            familySet,
                            edgeDepth,
                            deadzone,
                            maxTopDistance,
                            minSupport,
                            minMargin,
                        });
                    }
                }
            }
        }
    }
}

const summarizeFamilies = (eventRows) => {
    const names = [...new Set(eventRows.flatMap((row) => (
        Object.keys(row.familyYears)
    )))];
    return names.map((family) => {
        const available = eventRows.filter((row) => Number.isFinite(row.familyYears[family]));
        return {
            family,
            available: available.length,
            exact: ratio(
                available.filter((row) => row.familyYears[family] === row.truthYear).length,
                available.length,
            ),
            withinOne: ratio(
                available.filter((row) => (
                    Math.abs(row.familyYears[family] - row.truthYear) <= 1
                )).length,
                available.length,
            ),
            meanAbsoluteError: ratio(
                available.reduce((sum, row) => (
                    sum + Math.abs(row.familyYears[family] - row.truthYear)
                ), 0),
                available.length,
            ),
        };
    }).filter((entry) => entry.available >= 10)
        .sort((left, right) => (
            right.withinOne - left.withinOne
            || left.meanAbsoluteError - right.meanAbsoluteError
        ));
};

const evaluateTopSelector = (
    eventRows,
    totalCases,
    family,
    maxDistance,
    minimumMass,
) => {
    const metrics = {
        cases: totalCases,
        available: 0,
        switched: 0,
        baselineExact: 0,
        selectedExact: 0,
        exactGained: 0,
        exactLost: 0,
        baselineWithinOne: 0,
        selectedWithinOne: 0,
        withinOneGained: 0,
        withinOneLost: 0,
    };
    for (const row of eventRows) {
        const proposed = row.familyYears[family];
        const available = Number.isFinite(proposed)
            && contains(row.range, proposed)
            && Math.abs(proposed - row.topYear) <= maxDistance
            && (row.endpointMass ?? 0) >= minimumMass;
        const selected = available ? proposed : row.topYear;
        const baselineExact = row.topYear === row.truthYear;
        const selectedExact = selected === row.truthYear;
        const baselineWithinOne = Math.abs(row.topYear - row.truthYear) <= 1;
        const selectedWithinOne = Math.abs(selected - row.truthYear) <= 1;
        metrics.available += Number(available);
        metrics.switched += Number(available && selected !== row.topYear);
        metrics.baselineExact += Number(baselineExact);
        metrics.selectedExact += Number(selectedExact);
        metrics.exactGained += Number(!baselineExact && selectedExact);
        metrics.exactLost += Number(baselineExact && !selectedExact);
        metrics.baselineWithinOne += Number(baselineWithinOne);
        metrics.selectedWithinOne += Number(selectedWithinOne);
        metrics.withinOneGained += Number(!baselineWithinOne && selectedWithinOne);
        metrics.withinOneLost += Number(baselineWithinOne && !selectedWithinOne);
    }
    return {
        ...metrics,
        baselineExactRate: ratio(metrics.baselineExact, totalCases),
        selectedExactRate: ratio(metrics.selectedExact, totalCases),
        baselineWithinOneRate: ratio(metrics.baselineWithinOne, totalCases),
        selectedWithinOneRate: ratio(metrics.selectedWithinOne, totalCases),
    };
};

const topSelectorConfigurations = [1, 2, 3, 4, 6, Infinity].flatMap(
    (maxDistance) => (
        [0, 0.02, 0.04, 0.06, 0.08, 0.1].map((minimumMass) => ({
            maxDistance,
            minimumMass,
        }))
    ),
);

const selectBestTopSelector = (eventRows, totalCases, family) => (
    topSelectorConfigurations
        .map((config) => ({
            config,
            metrics: evaluateTopSelector(
                eventRows,
                totalCases,
                family,
                config.maxDistance,
                config.minimumMass,
            ),
        }))
        .sort((left, right) => (
            right.metrics.selectedExact - left.metrics.selectedExact
            || right.metrics.selectedWithinOne - left.metrics.selectedWithinOne
            || left.metrics.exactLost - right.metrics.exactLost
            || left.metrics.withinOneLost - right.metrics.withinOneLost
            || left.metrics.switched - right.metrics.switched
        ))[0]
);

const selectBest = (eventRows, totalCases) => configurations
    .map((config) => ({
        config,
        metrics: evaluate(eventRows, totalCases, config),
    }))
    .sort((left, right) => (
        right.metrics.selectedHits - left.metrics.selectedHits
        || right.metrics.selectedExact - left.metrics.selectedExact
        || right.metrics.selectedWithinOne - left.metrics.selectedWithinOne
        || left.metrics.lost - right.metrics.lost
        || left.metrics.switched - right.metrics.switched
    ))[0];

const eventReport = {};
for (const eventType of eventTypes) {
    const eventRows = rows.filter((row) => row.eventType === eventType);
    const trainRows = eventRows.filter((row) => row.offset <= 7);
    const tuneRows = eventRows.filter((row) => row.offset >= 8);
    const trainTotal = audits
        .filter((audit) => audit.offset <= 7)
        .reduce((sum, audit) => sum + audit.summary[eventType].cases, 0);
    const tuneTotal = audits
        .filter((audit) => audit.offset >= 8)
        .reduce((sum, audit) => sum + audit.summary[eventType].cases, 0);
    const selected = selectBest(trainRows, trainTotal);
    const selectedTop = selectBestTopSelector(
        trainRows,
        trainTotal,
        "endpointPosterior",
    );
    eventReport[eventType] = {
        cases: totals[eventType],
        familyQuality: summarizeFamilies(eventRows),
        baseline: evaluate(eventRows, totals[eventType], null),
        selectedOnOffsets0To7: selected,
        offsets8To12Holdout: evaluate(tuneRows, tuneTotal, selected.config),
        allOffsetsWithSelectedConfig: evaluate(eventRows, totals[eventType], selected.config),
        inSampleUpperCandidate: selectBest(eventRows, totals[eventType]),
        endpointTopSelector: {
            selectedOnOffsets0To7: selectedTop,
            offsets8To12Holdout: evaluateTopSelector(
                tuneRows,
                tuneTotal,
                "endpointPosterior",
                selectedTop.config.maxDistance,
                selectedTop.config.minimumMass,
            ),
            allOffsetsWithSelectedConfig: evaluateTopSelector(
                eventRows,
                totals[eventType],
                "endpointPosterior",
                selectedTop.config.maxDistance,
                selectedTop.config.minimumMass,
            ),
            inSampleUpperCandidate: selectBestTopSelector(
                eventRows,
                totals[eventType],
                "endpointPosterior",
            ),
        },
    };
}

console.log(JSON.stringify({
    offsets: audits.map((audit) => audit.offset),
    familySets,
    rows: rows.length,
    report: eventReport,
}, null, 2));
