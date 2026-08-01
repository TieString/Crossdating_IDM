import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ITRDB_ROOT = process.env.CROSSDATING_ITRDB_DIR
    ?? "D:/软件测试/数据/ITRDB/itrdb_download/measurements";
const auditRoots = [
    resolve(".tmp-window-ranker-broad"),
    resolve(".tmp-window-ranker"),
];
const offsets = Array.from({ length: 13 }, (_, index) => index);
const stopMarkers = new Set([999, -999, 9990, -9999]);

const auditPath = (offset) => {
    const name = `offset-${offset}-cases-25.json`;
    const path = auditRoots.map((root) => resolve(root, name)).find(existsSync);
    if (!path) throw new Error(`Missing audit ${name}`);
    return path;
};

const parseItrdb = (text) => {
    const byId = new Map();
    for (const raw of text.split(/\r?\n/)) {
        const tokens = raw.trim().split(/\s+/);
        if (tokens.length < 3) continue;
        const id = tokens[0];
        const decade = Number(tokens[1]);
        if (!Number.isFinite(decade) || decade < 1000 || decade > 2100) continue;
        const values = byId.get(id) ?? new Map();
        let year = decade;
        for (let index = 2; index < tokens.length; index += 1) {
            const value = Number(tokens[index]);
            if (!Number.isFinite(value)) continue;
            if (stopMarkers.has(value)) break;
            if (value < 0) continue;
            values.set(year, value);
            year += 1;
        }
        byId.set(id, values);
    }
    return new Map([...byId].filter(([, values]) => values.size >= 30));
};

const overlap = (left, right) => {
    let count = 0;
    for (const year of left.keys()) count += Number(right.has(year));
    return count;
};

const mean = (values) => (
    values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : Number.NaN
);

const median = (values) => {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

const standardize = (series) => {
    const values = [...series.values()];
    const center = mean(values);
    const variance = mean(values.map((value) => (value - center) ** 2));
    const scale = Math.sqrt(variance) || 1;
    return new Map([...series].map(([year, value]) => [year, (value - center) / scale]));
};

const firstDifference = (series) => {
    const years = [...series.keys()].sort((a, b) => a - b);
    const result = new Map();
    for (let index = 1; index < years.length; index += 1) {
        if (years[index] !== years[index - 1] + 1) continue;
        result.set(
            years[index],
            series.get(years[index]) - series.get(years[index - 1]),
        );
    }
    return standardize(result);
};

const referenceChronologies = (allSeries, targetId) => {
    const target = allSeries.get(targetId);
    if (!target) return null;
    const references = [...allSeries]
        .filter(([id, values]) => id !== targetId && overlap(values, target) >= 80)
        .sort((left, right) => overlap(right[1], target) - overlap(left[1], target))
        .slice(0, 24)
        .map(([id, values]) => ({ id, values: standardize(values) }));
    if (references.length < 5) return null;
    const byYear = new Map();
    for (const reference of references) {
        for (const [year, value] of reference.values) {
            const bucket = byYear.get(year) ?? [];
            bucket.push(value);
            byYear.set(year, bucket);
        }
    }
    const masterMean = new Map();
    const masterMedian = new Map();
    const masterScale = new Map();
    for (const [year, values] of byYear) {
        const center = mean(values);
        masterMean.set(year, center);
        masterMedian.set(year, median(values));
        const mad = median(values.map((value) => Math.abs(value - center)));
        masterScale.set(year, Math.max(0.25, mad * 1.4826));
    }
    return { references, masterMean, masterMedian, masterScale };
};

const missingCase = (correct, truthYear) => {
    const years = [...correct.keys()].sort((a, b) => a - b);
    const result = new Map();
    for (let year = years[0] + 1; year <= years.at(-1); year += 1) {
        const value = year > truthYear ? correct.get(year) : correct.get(year - 1);
        if (value !== undefined) result.set(year, value);
    }
    return result;
};

const falseValue = (correct, truthYear, mode) => {
    const neighborhood = [];
    for (let year = truthYear - 3; year <= truthYear + 3; year += 1) {
        const value = correct.get(year);
        if (value !== undefined) neighborhood.push(value);
    }
    const left = correct.get(truthYear - 1) ?? correct.get(truthYear) ?? 1;
    const right = correct.get(truthYear + 1) ?? correct.get(truthYear) ?? 1;
    if (mode === "average") return Math.round((left + right) / 2);
    if (mode === "moderate") return Math.round(median(neighborhood));
    return Math.max(1, Math.round(mean(neighborhood) * 0.45));
};

const falseCase = (correct, truthYear, mode) => {
    const years = [...correct.keys()].sort((a, b) => a - b);
    const result = new Map();
    for (let year = years[0] - 1; year <= years.at(-1); year += 1) {
        if (year > truthYear) {
            const value = correct.get(year);
            if (value !== undefined) result.set(year, value);
        } else if (year === truthYear) {
            result.set(year, falseValue(correct, truthYear, mode));
        } else {
            const value = correct.get(year + 1);
            if (value !== undefined) result.set(year, value);
        }
    }
    return result;
};

const correctAt = (corrupted, eventType, candidateYear) => {
    const corrected = new Map();
    if (eventType === "missingRing") {
        for (const [year, value] of corrupted) {
            corrected.set(year <= candidateYear ? year - 1 : year, value);
        }
    } else {
        for (const [year, value] of corrupted) {
            if (year === candidateYear) continue;
            corrected.set(year < candidateYear ? year + 1 : year, value);
        }
    }
    return corrected;
};

const paired = (left, right, startYear, endYear, scaleByYear = null) => {
    const rows = [];
    for (let year = startYear; year <= endYear; year += 1) {
        const leftValue = left.get(year);
        const rightValue = right.get(year);
        if (leftValue === undefined || rightValue === undefined) continue;
        rows.push({
            left: leftValue,
            right: rightValue,
            scale: scaleByYear?.get(year) ?? 1,
        });
    }
    return rows;
};

const correlation = (rows) => {
    if (rows.length < 4) return -1;
    const leftMean = mean(rows.map((row) => row.left));
    const rightMean = mean(rows.map((row) => row.right));
    let numerator = 0;
    let leftSum = 0;
    let rightSum = 0;
    for (const row of rows) {
        const left = row.left - leftMean;
        const right = row.right - rightMean;
        numerator += left * right;
        leftSum += left * left;
        rightSum += right * right;
    }
    const denominator = Math.sqrt(leftSum * rightSum);
    return denominator > 0 ? numerator / denominator : -1;
};

const negativeLoss = (rows, kind) => {
    if (rows.length < 2) return -100;
    const losses = rows.map((row) => {
        const residual = (row.left - row.right) / row.scale;
        if (kind === "absolute") return Math.abs(residual);
        if (kind === "huber") {
            const absolute = Math.abs(residual);
            return absolute <= 1.2
                ? 0.5 * absolute ** 2
                : 1.2 * (absolute - 0.6);
        }
        return residual ** 2;
    });
    return -mean(losses);
};

const fitAffine = (rows) => {
    if (rows.length < 10) return null;
    const xMean = mean(rows.map((row) => row.right));
    const yMean = mean(rows.map((row) => row.left));
    let numerator = 0;
    let denominator = 0;
    for (const row of rows) {
        numerator += (row.right - xMean) * (row.left - yMean);
        denominator += (row.right - xMean) ** 2;
    }
    const slope = denominator > 0 ? numerator / denominator : 0;
    return { intercept: yMean - slope * xMean, slope };
};

const calibratedLoss = (target, reference, candidateYear, halfWidth, flankWidth) => {
    const flank = [
        ...paired(
            target,
            reference,
            candidateYear - flankWidth,
            candidateYear - halfWidth - 1,
        ),
        ...paired(
            target,
            reference,
            candidateYear + halfWidth + 1,
            candidateYear + flankWidth,
        ),
    ];
    const model = fitAffine(flank);
    if (!model) return -100;
    const seam = paired(
        target,
        reference,
        candidateYear - halfWidth,
        candidateYear + halfWidth,
    ).map((row) => ({
        ...row,
        right: model.intercept + model.slope * row.right,
    }));
    return negativeLoss(seam, "huber");
};

const scoreCandidate = (
    corrupted,
    eventType,
    candidateYear,
    references,
) => {
    const corrected = standardize(correctAt(corrupted, eventType, candidateYear));
    const correctedDifference = firstDifference(corrected);
    const meanDifference = firstDifference(references.masterMean);
    const scores = {};
    for (const halfWidth of [1, 2, 3, 5]) {
        const start = candidateYear - halfWidth;
        const end = candidateYear + halfWidth;
        const meanRows = paired(corrected, references.masterMean, start, end);
        const medianRows = paired(corrected, references.masterMedian, start, end);
        const standardizedRows = paired(
            corrected,
            references.masterMean,
            start,
            end,
            references.masterScale,
        );
        const differenceRows = paired(correctedDifference, meanDifference, start, end);
        scores[`meanMse${halfWidth}`] = negativeLoss(meanRows, "squared");
        scores[`meanAbs${halfWidth}`] = negativeLoss(meanRows, "absolute");
        scores[`meanHuber${halfWidth}`] = negativeLoss(meanRows, "huber");
        scores[`medianMse${halfWidth}`] = negativeLoss(medianRows, "squared");
        scores[`scaledHuber${halfWidth}`] = negativeLoss(standardizedRows, "huber");
        scores[`differenceMse${halfWidth}`] = negativeLoss(differenceRows, "squared");
        scores[`rawCorrelation${halfWidth}`] = correlation(meanRows);
    }
    for (const halfWidth of [1, 2, 3]) {
        scores[`calibrated${halfWidth}`] = calibratedLoss(
            corrected,
            references.masterMean,
            candidateYear,
            halfWidth,
            20,
        );
    }
    const pairScores = references.references.map((reference) => (
        negativeLoss(
            paired(corrected, reference.values, candidateYear - 3, candidateYear + 3),
            "huber",
        )
    ));
    scores.referenceMean3 = mean(pairScores);
    scores.referenceMedian3 = median(pairScores);
    scores.referenceTrimmed3 = mean(
        [...pairScores].sort((a, b) => a - b)
            .slice(Math.floor(pairScores.length * 0.2), Math.ceil(pairScores.length * 0.8)),
    );
    return scores;
};

const cases = [];
for (const offset of offsets) {
    const payload = JSON.parse(readFileSync(auditPath(offset), "utf8"));
    for (const rankCase of payload.cases) {
        if (
            (rankCase.eventType !== "missingRing" && rankCase.eventType !== "falseRing")
            || !rankCase.currentRange
            || !Number.isFinite(rankCase.currentTopYear)
        ) {
            continue;
        }
        const [startYear, endYear] = rankCase.currentRange;
        if (rankCase.truthYear < startYear || rankCase.truthYear > endYear) continue;
        cases.push({
            offset,
            eventType: rankCase.eventType,
            file: rankCase.context.file,
            target: rankCase.context.target,
            truthYear: rankCase.truthYear,
            currentTopYear: rankCase.currentTopYear,
            startYear,
            endYear,
        });
    }
}

const grouped = new Map();
for (const row of cases) {
    const key = `${row.file}\t${row.target}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
}

const scoredCases = [];
for (const rows of grouped.values()) {
    const first = rows[0];
    const path = resolve(ITRDB_ROOT, `.${first.file}`);
    if (!existsSync(path)) continue;
    const allSeries = parseItrdb(readFileSync(path, "utf8"));
    const correct = allSeries.get(first.target);
    const references = referenceChronologies(allSeries, first.target);
    if (!correct || !references) continue;
    for (const row of rows) {
        const modes = row.eventType === "falseRing"
            ? ["average", "moderate", "splitLike"]
            : ["missing"];
        for (const mode of modes) {
            const corrupted = row.eventType === "missingRing"
                ? missingCase(correct, row.truthYear)
                : falseCase(correct, row.truthYear, mode);
            const candidateScores = [];
            for (let year = row.startYear; year <= row.endYear; year += 1) {
                candidateScores.push({
                    year,
                    scores: scoreCandidate(
                        corrupted,
                        row.eventType,
                        year,
                        references,
                    ),
                });
            }
            scoredCases.push({ ...row, mode, candidateScores });
        }
    }
}

const metric = (rows, selector) => {
    let exact = 0;
    let withinOne = 0;
    const byOffset = new Map();
    for (const row of rows) {
        const predictedYear = selector(row);
        exact += Number(predictedYear === row.truthYear);
        withinOne += Number(Math.abs(predictedYear - row.truthYear) <= 1);
        const fold = byOffset.get(row.offset) ?? { cases: 0, exact: 0, withinOne: 0 };
        fold.cases += 1;
        fold.exact += Number(predictedYear === row.truthYear);
        fold.withinOne += Number(Math.abs(predictedYear - row.truthYear) <= 1);
        byOffset.set(row.offset, fold);
    }
    return {
        cases: rows.length,
        exactRate: exact / Math.max(1, rows.length),
        withinOneRate: withinOne / Math.max(1, rows.length),
        byOffset: Object.fromEntries([...byOffset].map(([offset, fold]) => [
            offset,
            {
                cases: fold.cases,
                exactRate: fold.exact / fold.cases,
                withinOneRate: fold.withinOne / fold.cases,
            },
        ])),
    };
};

const selectFeature = (row, feature) => (
    [...row.candidateScores].sort((left, right) => (
        right.scores[feature] - left.scores[feature]
        || Math.abs(left.year - row.currentTopYear) - Math.abs(right.year - row.currentTopYear)
        || right.year - left.year
    ))[0]?.year ?? row.currentTopYear
);

const featureNames = Object.keys(scoredCases[0]?.candidateScores[0]?.scores ?? {});
const report = {};
for (const eventType of ["missingRing", "falseRing"]) {
    const rows = scoredCases.filter((row) => row.eventType === eventType);
    const baseline = metric(rows, (row) => row.currentTopYear);
    const features = featureNames.map((feature) => ({
        feature,
        ...metric(rows, (row) => selectFeature(row, feature)),
    })).sort((left, right) => (
        right.exactRate - left.exactRate
        || right.withinOneRate - left.withinOneRate
    ));
    report[eventType] = {
        baseline,
        features: features.slice(0, 15),
    };
}

console.log(JSON.stringify({
    sampling: "calendar-position-stratified-signal-independent",
    offsets,
    sourceCases: cases.length,
    scoredCases: scoredCases.length,
    report,
}, null, 2));
