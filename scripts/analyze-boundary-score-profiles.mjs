import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const roots = [
    resolve(".tmp-window-ranker-broad"),
    resolve(".tmp-window-ranker"),
];
const offsets = Array.from({ length: 13 }, (_, index) => index);
const transforms = {
    value: (values, index) => values[index],
    previousGain: (values, index) => (
        index > 0 ? values[index] - values[index - 1] : Number.NaN
    ),
    nextGain: (values, index) => (
        index + 1 < values.length ? values[index] - values[index + 1] : Number.NaN
    ),
    centralSlope: (values, index) => (
        index > 0 && index + 1 < values.length
            ? (values[index + 1] - values[index - 1]) / 2
            : Number.NaN
    ),
    peakCurvature: (values, index) => (
        index > 0 && index + 1 < values.length
            ? values[index] * 2 - values[index - 1] - values[index + 1]
            : Number.NaN
    ),
    localPeakMargin: (values, index) => (
        index > 0 && index + 1 < values.length
            ? values[index] - Math.max(values[index - 1], values[index + 1])
            : Number.NaN
    ),
    leftRightContrast: (values, index) => {
        if (index < 2 || index + 2 >= values.length) return Number.NaN;
        const left = (values[index - 2] + values[index - 1]) / 2;
        const right = (values[index + 1] + values[index + 2]) / 2;
        return left - right;
    },
};

const locateOffsetFile = (offset) => {
    const name = `offset-${offset}-cases-25.json`;
    return roots.map((root) => resolve(root, name)).find(existsSync) ?? null;
};

const metricKey = (eventType, feature, transform, direction) => (
    `${eventType}\t${feature}\t${transform}\t${direction}`
);
const metrics = new Map();
const casesByType = new Map();

const record = (eventType, feature, transform, direction, predictedYear, truthYear) => {
    const key = metricKey(eventType, feature, transform, direction);
    const current = metrics.get(key) ?? { exact: 0, withinOne: 0, cases: 0, offsets: new Map() };
    current.cases += 1;
    current.exact += Number(predictedYear === truthYear);
    current.withinOne += Number(Math.abs(predictedYear - truthYear) <= 1);
    metrics.set(key, current);
};

for (const offset of offsets) {
    const path = locateOffsetFile(offset);
    if (!path) throw new Error(`Missing ranker audit for offset ${offset}`);
    const payload = JSON.parse(readFileSync(path, "utf8"));
    for (const rankCase of payload.cases) {
        if (!rankCase.currentRange || !Number.isFinite(rankCase.currentTopYear)) continue;
        const [startYear, endYear] = rankCase.currentRange;
        if (rankCase.truthYear < startYear || rankCase.truthYear > endYear) continue;
        const rows = rankCase.rows
            .filter((row) => (
                row.year >= startYear
                && row.year <= endYear
                && (
                    rankCase.eventType !== "partialMove"
                    || rankCase.currentShiftYears === null
                    || row.shiftYears === rankCase.currentShiftYears
                )
            ))
            .sort((left, right) => left.year - right.year);
        if (!rows.some((row) => row.year === rankCase.truthYear) || rows.length < 3) continue;
        casesByType.set(rankCase.eventType, (casesByType.get(rankCase.eventType) ?? 0) + 1);
        const featureNames = Object.keys(rows[0].features);
        for (const feature of featureNames) {
            const values = rows.map((row) => row.features[feature]);
            if (values.some((value) => !Number.isFinite(value))) continue;
            for (const [transformName, transform] of Object.entries(transforms)) {
                const transformed = rows
                    .map((row, index) => ({ year: row.year, score: transform(values, index) }))
                    .filter((row) => Number.isFinite(row.score));
                if (transformed.length === 0) continue;
                for (const direction of ["max", "min"]) {
                    const sign = direction === "max" ? 1 : -1;
                    const predicted = [...transformed].sort((left, right) => (
                        (right.score - left.score) * sign || right.year - left.year
                    ))[0];
                    record(
                        rankCase.eventType,
                        feature,
                        transformName,
                        direction,
                        predicted.year,
                        rankCase.truthYear,
                    );
                }
            }
        }
    }
}

const report = {};
for (const eventType of casesByType.keys()) {
    report[eventType] = Array.from(metrics.entries())
        .filter(([key]) => key.startsWith(`${eventType}\t`))
        .map(([key, value]) => {
            const [, feature, transform, direction] = key.split("\t");
            return {
                feature,
                transform,
                direction,
                cases: value.cases,
                exactRate: value.exact / value.cases,
                withinOneRate: value.withinOne / value.cases,
            };
        })
        .filter((row) => row.cases >= (casesByType.get(eventType) ?? 0) * 0.9)
        .sort((left, right) => (
            right.exactRate - left.exactRate
            || right.withinOneRate - left.withinOneRate
            || left.feature.localeCompare(right.feature)
        ))
        .slice(0, 30);
}

console.log(JSON.stringify({
    offsets,
    casesByType: Object.fromEntries(casesByType),
    report,
}, null, 2));
