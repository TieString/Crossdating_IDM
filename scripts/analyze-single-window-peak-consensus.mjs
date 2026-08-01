import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const roots = [
    resolve(".tmp-window-ranker-broad"),
    resolve(".tmp-window-ranker"),
];
const offsets = Array.from({ length: 13 }, (_, index) => index);
const widths = [7, 9];
const topCounts = [1, 2, 3, 5, 8];

const locateOffsetFile = (offset) => {
    const name = `offset-${offset}-cases-25.json`;
    return roots.map((root) => resolve(root, name)).find(existsSync) ?? null;
};

const cases = offsets.flatMap((offset) => {
    const path = locateOffsetFile(offset);
    if (!path) throw new Error(`Missing ranker audit for offset ${offset}`);
    return JSON.parse(readFileSync(path, "utf8")).cases.map((row) => ({ ...row, offset }));
});

const contrastFeatures = [
    "cumulativeContrast",
    "cumulativeRawContrast",
    "cumulativeDifferenceContrast",
    "cumulativeWhitenedContrast",
    "cumulativeCofechaContrast",
    "cumulativeReferenceMedianContrast",
    "cumulativeReferenceMeanContrast",
    "cumulativeReferenceVoteContrast",
];

for (const rankCase of cases) {
    for (const row of rankCase.rows) {
        const position = Math.max(
            1e-6,
            Math.min(1 - 1e-6, row.features.normalizedPosition),
        );
        const sqrtBalance = Math.sqrt(position * (1 - position));
        const linearBalance = position * (1 - position);
        for (const feature of contrastFeatures) {
            const value = row.features[feature];
            if (!Number.isFinite(value)) continue;
            row.features[`cusumSqrt:${feature}`] = value * sqrtBalance;
            row.features[`cusumLinear:${feature}`] = value * linearBalance;
        }
    }
}

const finiteFeatureNames = (rows) => {
    const names = new Set();
    for (const row of rows) {
        for (const [name, value] of Object.entries(row.features)) {
            if (Number.isFinite(value)) names.add(name);
        }
    }
    return [...names].filter((name) => rows.some((row) => Number.isFinite(row.features[name])));
};

const boundedWindow = (center, width, minYear, maxYear) => {
    let start = center - Math.floor((width - 1) / 2);
    start = Math.max(minYear, Math.min(start, maxYear - width + 1));
    return [start, start + width - 1];
};

const bestMassWindow = (points, width, minYear, maxYear) => {
    if (points.length === 0) return null;
    const candidates = new Set();
    for (const point of points) {
        for (let offset = 0; offset < width; offset += 1) {
            candidates.add(Math.max(minYear, Math.min(point.year - offset, maxYear - width + 1)));
        }
    }
    return [...candidates]
        .map((start) => {
            const end = start + width - 1;
            const mass = points.reduce((sum, point) => (
                point.year >= start && point.year <= end ? sum + point.weight : sum
            ), 0);
            const topDistance = Math.min(...points
                .filter((point) => point.rank === 1)
                .map((point) => (
                    point.year < start ? start - point.year : point.year > end ? point.year - end : 0
                )));
            return { start, end, mass, topDistance };
        })
        .sort((left, right) => (
            right.mass - left.mass
            || left.topDistance - right.topDistance
            || right.start - left.start
        ))[0];
};

const massSelection = (rankCase, feature, topCount, width) => {
    const points = featurePoints(rankCase, feature, topCount);
    if (points.length === 0) return null;
    const years = rankCase.rows.map((row) => row.year);
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    const window = bestMassWindow(points, width, minYear, maxYear);
    if (!window) return null;
    const topRow = rankCase.rows
        .filter((row) => row.year >= window.start && row.year <= window.end)
        .filter((row) => (
            rankCase.eventType !== "partialMove"
            || rankCase.currentShiftYears === null
            || row.shiftYears === rankCase.currentShiftYears
        ))
        .sort((left, right) => (
            right.features[feature] - left.features[feature]
            || right.year - left.year
        ))[0];
    return {
        ...window,
        topYear: topRow?.year ?? points[0].year,
        shiftYears: rankCase.currentShiftYears,
        selectedMass: window.mass,
        totalMass: points.reduce((sum, point) => sum + point.weight, 0),
        pointSpan: Math.max(...points.map((point) => point.year))
            - Math.min(...points.map((point) => point.year)),
    };
};

const featurePoints = (rankCase, feature, topCount) => {
    const rows = rankCase.rows
        .filter((row) => (
            Number.isFinite(row.features[feature])
            && (
                rankCase.eventType !== "partialMove"
                || rankCase.currentShiftYears === null
                || row.shiftYears === rankCase.currentShiftYears
            )
        ))
        .sort((left, right) => (
            right.features[feature] - left.features[feature] || right.year - left.year
        ))
        .slice(0, topCount);
    return rows.map((row, index) => ({
        year: row.year,
        rank: index + 1,
        weight: 1 / (index + 1),
    }));
};

const consensusPoints = (rankCase, features, topCount) => features.flatMap((feature) => (
    featurePoints(rankCase, feature, topCount).map((point) => ({
        ...point,
        weight: point.weight / Math.max(1, topCount),
    }))
));

const evaluate = (eventCases, selector) => {
    let hits = 0;
    let exact = 0;
    let withinOne = 0;
    let shiftHits = 0;
    let jointHits = 0;
    let predictions = 0;
    for (const rankCase of eventCases) {
        const selected = selector(rankCase);
        if (!selected) continue;
        predictions += 1;
        const hit = rankCase.truthYear >= selected.start && rankCase.truthYear <= selected.end;
        const topError = Math.abs(selected.topYear - rankCase.truthYear);
        const shiftHit = rankCase.eventType !== "partialMove"
            || rankCase.currentShiftYears === selected.shiftYears;
        hits += Number(hit);
        exact += Number(topError === 0);
        withinOne += Number(topError <= 1);
        shiftHits += Number(shiftHit);
        jointHits += Number(hit && shiftHit);
    }
    return {
        cases: eventCases.length,
        predictions,
        coverage: hits / eventCases.length,
        exact: exact / eventCases.length,
        withinOne: withinOne / eventCases.length,
        shiftAccuracy: shiftHits / eventCases.length,
        joint: jointHits / eventCases.length,
    };
};

const report = {};
for (const eventType of ["missingRing", "falseRing", "partialMove"]) {
    const eventCases = cases.filter((row) => row.eventType === eventType);
    const featureNames = finiteFeatureNames(eventCases.flatMap((row) => row.rows));
    const rows = [];
    for (const width of widths) {
        for (const feature of featureNames) {
            for (const topCount of topCounts) {
                const metrics = evaluate(eventCases, (rankCase) => {
                    return massSelection(rankCase, feature, topCount, width);
                });
                rows.push({ strategy: "singleFeatureMass", width, feature, topCount, ...metrics });
            }
        }
        for (const topCount of [1, 2, 3]) {
            const metrics = evaluate(eventCases, (rankCase) => {
                const points = consensusPoints(rankCase, featureNames, topCount);
                if (points.length === 0) return null;
                const years = rankCase.rows.map((row) => row.year);
                const window = bestMassWindow(
                    points,
                    width,
                    Math.min(...years),
                    Math.max(...years),
                );
                if (!window) return null;
                const yearVotes = new Map();
                points
                    .filter((point) => point.year >= window.start && point.year <= window.end)
                    .forEach((point) => {
                        yearVotes.set(point.year, (yearVotes.get(point.year) ?? 0) + point.weight);
                    });
                const topYear = [...yearVotes.entries()]
                    .sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]?.[0]
                    ?? Math.round((window.start + window.end) / 2);
                return {
                    ...window,
                    topYear,
                    shiftYears: rankCase.currentShiftYears,
                };
            });
            rows.push({
                strategy: "allFeatureVote",
                width,
                feature: "*",
                topCount,
                ...metrics,
            });
        }
    }
    report[eventType] = rows.sort((left, right) => (
        right.joint - left.joint
        || right.coverage - left.coverage
        || right.exact - left.exact
    )).slice(0, 20);
}

const contains = (selection, year) => (
    selection !== null && year >= selection.start && year <= selection.end
);

const currentSelection = (rankCase) => rankCase.currentRange
    ? {
        start: rankCase.currentRange[0],
        end: rankCase.currentRange[1],
        topYear: rankCase.currentTopYear,
        shiftYears: rankCase.currentShiftYears,
    }
    : null;

const selectorRows = (eventType, feature) => cases
    .filter((row) => row.eventType === eventType)
    .map((rankCase) => {
        const current = currentSelection(rankCase);
        const mass = massSelection(rankCase, feature, 8, 9);
        if (!current || !mass) return null;
        const currentCenter = (current.start + current.end) / 2;
        const massCenter = (mass.start + mass.end) / 2;
        const source = (name) => Number(rankCase.currentSources.includes(name));
        return {
            offset: rankCase.offset,
            truthYear: rankCase.truthYear,
            current,
            mass,
            currentHit: contains(current, rankCase.truthYear),
            massHit: contains(mass, rankCase.truthYear),
            features: {
                disagreement: Math.abs(currentCenter - massCenter),
                signedDisagreement: massCenter - currentCenter,
                overlap: Math.max(
                    0,
                    Math.min(current.end, mass.end) - Math.max(current.start, mass.start) + 1,
                ),
                topDistance: Math.abs(current.topYear - mass.topYear),
                signedTopDistance: mass.topYear - current.topYear,
                currentWidth: current.end - current.start + 1,
                currentScore: rankCase.currentScore,
                currentMargin: rankCase.currentMargin,
                signalStrength: rankCase.context?.signalStrength ?? -1,
                referenceCount: rankCase.context?.referenceCount ?? 0,
                normalizedPosition: rankCase.context?.normalizedPosition ?? 0.5,
                massFraction: mass.selectedMass / Math.max(1e-9, mass.totalMass),
                massPointSpan: mass.pointSpan,
                massContainsCurrentTop: Number(contains(mass, current.topYear)),
                currentContainsMassTop: Number(contains(current, mass.topYear)),
                sourceGainRecovery: source("gain_gated_event_recovery"),
                sourceLocalRaw: source("local_counterfactual_raw_year"),
                sourcePairedCore: source("paired_core_counterfactual_year"),
                sourcePath: source("piecewise_lag_path"),
                sourceCumulative: Number(rankCase.currentSources.some((name) => (
                    name.startsWith("cumulative_")
                ))),
            },
        };
    })
    .filter(Boolean);

const hitRateForChoice = (rows, chooseMass) => (
    rows.reduce((sum, row) => sum + Number(
        chooseMass(row) ? row.massHit : row.currentHit,
    ), 0) / Math.max(1, rows.length)
);

const trainStump = (rows) => {
    const featureNames = Object.keys(rows[0]?.features ?? {});
    let best = {
        feature: "constant",
        threshold: 0,
        massWhenAbove: true,
        rate: Math.max(
            hitRateForChoice(rows, () => false),
            hitRateForChoice(rows, () => true),
        ),
        constantMass: hitRateForChoice(rows, () => true)
            > hitRateForChoice(rows, () => false),
    };
    for (const feature of featureNames) {
        const values = [...new Set(rows.map((row) => row.features[feature]))]
            .filter(Number.isFinite)
            .sort((left, right) => left - right);
        const thresholds = values.length <= 40
            ? values
            : Array.from({ length: 40 }, (_, index) => (
                values[Math.floor(index * (values.length - 1) / 39)]
            ));
        for (const threshold of thresholds) {
            for (const massWhenAbove of [false, true]) {
                const rate = hitRateForChoice(rows, (row) => (
                    (row.features[feature] >= threshold) === massWhenAbove
                ));
                if (rate > best.rate) {
                    best = {
                        feature,
                        threshold,
                        massWhenAbove,
                        rate,
                        constantMass: false,
                    };
                }
            }
        }
    }
    return best;
};

const applyStump = (stump, row) => stump.feature === "constant"
    ? stump.constantMass
    : (row.features[stump.feature] >= stump.threshold) === stump.massWhenAbove;

const hybridReport = {};
for (const [eventType, feature] of [
    ["missingRing", "cumulativeCombined"],
    ["falseRing", "differenceFull"],
]) {
    const rows = selectorRows(eventType, feature);
    const folds = offsets.map((heldOutOffset) => {
        const training = rows.filter((row) => row.offset !== heldOutOffset);
        const validation = rows.filter((row) => row.offset === heldOutOffset);
        const stump = trainStump(training);
        return {
            heldOutOffset,
            cases: validation.length,
            stump,
            current: hitRateForChoice(validation, () => false),
            mass: hitRateForChoice(validation, () => true),
            selected: hitRateForChoice(validation, (row) => applyStump(stump, row)),
            oracle: validation.reduce((sum, row) => (
                sum + Number(row.currentHit || row.massHit)
            ), 0) / Math.max(1, validation.length),
        };
    });
    hybridReport[eventType] = {
        cases: rows.length,
        current: hitRateForChoice(rows, () => false),
        mass: hitRateForChoice(rows, () => true),
        oracle: rows.reduce((sum, row) => (
            sum + Number(row.currentHit || row.massHit)
        ), 0) / Math.max(1, rows.length),
        leaveOneOffsetOut: folds.reduce((sum, fold) => (
            sum + fold.selected * fold.cases
        ), 0) / Math.max(1, rows.length),
        folds,
    };
}

const featureOracleReport = {};
for (const eventType of ["missingRing", "falseRing", "partialMove"]) {
    const eventCases = cases.filter((row) => row.eventType === eventType);
    const features = [
        "rawFull",
        "differenceFull",
        "whitenedFull",
        "comboFull",
        "cumulativeCombined",
        "cumulativeDifference",
        "cumulativeWhitened",
        "cumulativeReferenceMean",
    ];
    let anyFeatureHit = 0;
    let currentOrFeatureHit = 0;
    let nearestCurrentHit = 0;
    let nearestCurrentCenterHit = 0;
    const hitCounts = Object.fromEntries(features.map((feature) => [feature, 0]));
    for (const rankCase of eventCases) {
        const current = currentSelection(rankCase);
        const hits = features.map((feature) => {
            const selected = massSelection(rankCase, feature, 8, 9);
            const hit = contains(selected, rankCase.truthYear);
            hitCounts[feature] += Number(hit);
            return hit;
        });
        const selections = features
            .map((feature) => ({
                feature,
                selection: massSelection(rankCase, feature, 8, 9),
            }))
            .filter((row) => row.selection !== null);
        const nearestTop = [...selections].sort((left, right) => (
            Math.abs(left.selection.topYear - rankCase.currentTopYear)
                - Math.abs(right.selection.topYear - rankCase.currentTopYear)
            || features.indexOf(left.feature) - features.indexOf(right.feature)
        ))[0]?.selection ?? null;
        const currentCenter = rankCase.currentRange
            ? (rankCase.currentRange[0] + rankCase.currentRange[1]) / 2
            : rankCase.currentTopYear;
        const nearestCenter = [...selections].sort((left, right) => (
            Math.abs(
                (left.selection.start + left.selection.end) / 2 - currentCenter,
            )
                - Math.abs(
                    (right.selection.start + right.selection.end) / 2 - currentCenter,
                )
            || features.indexOf(left.feature) - features.indexOf(right.feature)
        ))[0]?.selection ?? null;
        nearestCurrentHit += Number(contains(nearestTop, rankCase.truthYear));
        nearestCurrentCenterHit += Number(contains(nearestCenter, rankCase.truthYear));
        anyFeatureHit += Number(hits.some(Boolean));
        currentOrFeatureHit += Number(
            contains(current, rankCase.truthYear) || hits.some(Boolean),
        );
    }
    featureOracleReport[eventType] = {
        cases: eventCases.length,
        byFeature: Object.fromEntries(features.map((feature) => [
            feature,
            hitCounts[feature] / eventCases.length,
        ])),
        anyFeatureOracle: anyFeatureHit / eventCases.length,
        currentOrAnyFeatureOracle: currentOrFeatureHit / eventCases.length,
        nearestCurrentTop: nearestCurrentHit / eventCases.length,
        nearestCurrentCenter: nearestCurrentCenterHit / eventCases.length,
    };
}

console.log(JSON.stringify(
    process.env.CONSENSUS_SUMMARY === "1"
        ? {
            sampling: "calendar-position-stratified-signal-independent",
            offsets,
            hybridReport,
            featureOracleReport,
        }
        : {
            sampling: "calendar-position-stratified-signal-independent",
            offsets,
            report,
            hybridReport,
            featureOracleReport,
        },
    null,
    2,
));
