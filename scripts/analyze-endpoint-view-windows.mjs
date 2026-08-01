import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length === 0) {
    throw new Error(
        "Usage: node scripts/analyze-endpoint-view-windows.mjs <audit.json> [...]",
    );
}

const eventTypes = ["missingRing", "falseRing"];
const viewNames = ["difference", "splineLog", "cofecha"];
const audits = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));

const noteWindow = (notes, prefix) => {
    const note = [...(notes ?? [])]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const match = note?.slice(prefix.length).match(/^(-?\d+)-(-?\d+)$/);
    return match ? [Number(match[1]), Number(match[2])] : null;
};

const contains = (range, year) => (
    range !== null && year >= range[0] && year <= range[1]
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
for (const audit of audits) {
    for (const rankCase of audit.rankingCases ?? []) {
        if (!eventTypes.includes(rankCase.eventType)) continue;
        rows.push({
            offset: audit.offset,
            eventType: rankCase.eventType,
            truthYear: rankCase.truthYear,
            current: rankCase.locations?.[0]?.range ?? rankCase.range,
            views: Object.fromEntries(viewNames.map((view) => [
                view,
                noteWindow(
                    rankCase.notes,
                    `endpoint_residual_${view}_range=`,
                ),
            ])),
        });
    }
    for (const failure of audit.failures ?? []) {
        if (!eventTypes.includes(failure.eventType)) continue;
        const prediction = failure.predictions?.find((candidate) => (
            candidate.type === failure.eventType && metadataMatches(failure, candidate)
        ));
        if (!prediction) continue;
        rows.push({
            offset: audit.offset,
            eventType: failure.eventType,
            truthYear: failure.truthYear,
            current: prediction.locations?.[0]?.range ?? prediction.range,
            views: Object.fromEntries(viewNames.map((view) => [
                view,
                noteWindow(
                    prediction.notes,
                    `endpoint_residual_${view}_range=`,
                ),
            ])),
        });
    }
}

const centeredWindow = (center, width = 7) => {
    const start = Math.round(center) - Math.floor(width / 2);
    return [start, start + width - 1];
};

const medianCenterWindow = (row) => {
    const centers = viewNames
        .map((view) => row.views[view])
        .filter(Boolean)
        .map((range) => (range[0] + range[1]) / 2)
        .sort((left, right) => left - right);
    return centers.length > 0
        ? centeredWindow(centers[Math.floor((centers.length - 1) / 2)])
        : row.current;
};

const densestCenterWindow = (row) => {
    const centers = viewNames
        .map((view) => row.views[view])
        .filter(Boolean)
        .map((range) => (range[0] + range[1]) / 2);
    if (centers.length === 0) return row.current;
    return centers
        .map((center) => {
            const range = centeredWindow(center);
            return {
                range,
                support: centers.filter((value) => contains(range, value)).length,
                currentOverlap: Math.max(
                    0,
                    Math.min(range[1], row.current[1])
                        - Math.max(range[0], row.current[0]) + 1,
                ),
            };
        })
        .sort((left, right) => (
            right.support - left.support
            || right.currentOverlap - left.currentOverlap
            || right.range[0] - left.range[0]
        ))[0].range;
};

const metrics = (typed, totalCases, selector) => {
    let available = 0;
    let hits = 0;
    for (const row of typed) {
        const selected = selector(row);
        if (!selected) continue;
        available += 1;
        hits += Number(contains(selected, row.truthYear));
    }
    return {
        cases: totalCases,
        available,
        hits,
        coverage: hits / Math.max(1, totalCases),
        conditionalCoverage: hits / Math.max(1, available),
    };
};

const report = {};
for (const eventType of eventTypes) {
    const typed = rows.filter((row) => row.eventType === eventType);
    const totalCases = audits.reduce(
        (sum, audit) => sum + audit.summary[eventType].cases,
        0,
    );
    report[eventType] = {
        current: metrics(typed, totalCases, (row) => row.current),
        views: Object.fromEntries(viewNames.map((view) => [
            view,
            metrics(typed, totalCases, (row) => row.views[view]),
        ])),
        medianCenter: metrics(typed, totalCases, medianCenterWindow),
        densestCenter: metrics(typed, totalCases, densestCenterWindow),
        currentOrAnyViewOracle: metrics(typed, totalCases, (row) => (
            [row.current, ...viewNames.map((view) => row.views[view])]
                .find((range) => contains(range, row.truthYear))
                ?? row.current
        )),
        anyViewOracle: metrics(typed, totalCases, (row) => (
            viewNames.map((view) => row.views[view])
                .find((range) => contains(range, row.truthYear))
                ?? row.views[viewNames[0]]
        )),
    };
}

console.log(JSON.stringify({
    offsets: audits.map((audit) => audit.offset),
    rows: rows.length,
    report,
}, null, 2));
