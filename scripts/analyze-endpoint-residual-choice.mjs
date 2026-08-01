import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length === 0) {
    throw new Error(
        "Usage: node scripts/analyze-endpoint-residual-choice.mjs <audit.json> [...]",
    );
}

const noteValue = (notes, prefix) => {
    const note = [...notes].reverse().find((value) => value.startsWith(prefix));
    if (!note) return null;
    const value = Number(note.slice(prefix.length));
    return Number.isFinite(value) ? value : null;
};

const windowValue = (notes, prefix) => {
    const note = [...notes].reverse().find((value) => value.startsWith(prefix));
    const match = note?.slice(prefix.length).match(/^(-?\d+)-(-?\d+)$/);
    return match ? [Number(match[1]), Number(match[2])] : null;
};

const rows = paths.flatMap((path) => {
    const audit = JSON.parse(readFileSync(path, "utf8"));
    return audit.missingRefinementCases.flatMap((row) => {
        const mass = noteValue(row.notes, "endpoint_residual_window_mass=");
        const previousTop = noteValue(
            row.notes,
            "endpoint_residual_previous_top_year=",
        );
        const posteriorTop = noteValue(
            row.notes,
            "endpoint_residual_posterior_top_year=",
        );
        const referenceCount = noteValue(
            row.notes,
            "endpoint_residual_reference_count=",
        );
        const previous = windowValue(
            row.notes,
            "endpoint_residual_previous_range=",
        );
        const core = windowValue(row.notes, "endpoint_residual_core_range=");
        if (
            mass === null
            || previousTop === null
            || posteriorTop === null
            || referenceCount === null
            || previous === null
            || core === null
        ) {
            return [];
        }
        const beforeCenter = (row.before[0] + row.before[1]) / 2;
        const afterCenter = (row.after[0] + row.after[1]) / 2;
        const overlap = Math.max(
            0,
            Math.min(row.before[1], row.after[1])
                - Math.max(row.before[0], row.after[0])
                + 1,
        );
        return [{
            offset: audit.offset,
            beforeHit: row.beforeHit,
            afterHit: row.afterHit,
            features: {
                mass,
                score: row.score,
                margin: row.margin,
                highConfidence: Number(row.confidence === "high"),
                referenceCount,
                topDisplacement: Math.abs(posteriorTop - previousTop),
                signedTopDisplacement: posteriorTop - previousTop,
                centerDisplacement: Math.abs(afterCenter - beforeCenter),
                signedCenterDisplacement: afterCenter - beforeCenter,
                overlap,
                previousWidth: previous[1] - previous[0] + 1,
                coreDisplacement: Math.abs(
                    (core[0] + core[1]) / 2 - (previous[0] + previous[1]) / 2,
                ),
                sourcePairedCore: Number(
                    row.sources.includes("paired_core_counterfactual_year"),
                ),
                sourceLocalRaw: Number(
                    row.sources.includes("local_counterfactual_raw_year"),
                ),
                sourceEdgeGuard: Number(
                    row.sources.includes("edge_rank_guard"),
                ),
                sourcePath: Number(row.sources.includes("piecewise_lag_path")),
            },
        }];
    });
});

const hitCount = (data, chooseBefore) => data.reduce(
    (sum, row) => sum + Number(
        chooseBefore(row) ? row.beforeHit : row.afterHit,
    ),
    0,
);

const trainStump = (data) => {
    let best = {
        feature: "constant",
        threshold: 0,
        beforeWhenAbove: false,
        hits: hitCount(data, () => false),
    };
    const featureNames = Object.keys(data[0]?.features ?? {});
    for (const feature of featureNames) {
        const values = [...new Set(data.map((row) => row.features[feature]))]
            .sort((left, right) => left - right);
        const thresholds = values.flatMap((value, index) => (
            index === 0 ? [value] : [(values[index - 1] + value) / 2]
        ));
        for (const threshold of thresholds) {
            for (const beforeWhenAbove of [false, true]) {
                const hits = hitCount(data, (row) => (
                    (row.features[feature] >= threshold) === beforeWhenAbove
                ));
                if (hits > best.hits) {
                    best = { feature, threshold, beforeWhenAbove, hits };
                }
            }
        }
    }
    return best;
};

const applyStump = (stump, row) => (
    stump.feature !== "constant"
    && (row.features[stump.feature] >= stump.threshold) === stump.beforeWhenAbove
);

const offsets = [...new Set(rows.map((row) => row.offset))]
    .sort((left, right) => left - right);
let crossValidatedHits = 0;
const folds = offsets.map((heldOutOffset) => {
    const training = rows.filter((row) => row.offset !== heldOutOffset);
    const validation = rows.filter((row) => row.offset === heldOutOffset);
    const stump = trainStump(training);
    const hits = hitCount(validation, (row) => applyStump(stump, row));
    crossValidatedHits += hits;
    return {
        heldOutOffset,
        cases: validation.length,
        stump,
        baselineAfter: hitCount(validation, () => false),
        selected: hits,
        oracle: hitCount(validation, (row) => row.beforeHit && !row.afterHit),
    };
});

const baselineAfter = hitCount(rows, () => false);
const baselineBefore = hitCount(rows, () => true);
const fitted = trainStump(rows);
const oracle = hitCount(rows, (row) => row.beforeHit && !row.afterHit);

console.log(JSON.stringify({
    cases: rows.length,
    offsets,
    baselineAfter: {
        hits: baselineAfter,
        rate: baselineAfter / Math.max(1, rows.length),
    },
    baselineBefore: {
        hits: baselineBefore,
        rate: baselineBefore / Math.max(1, rows.length),
    },
    fitted: {
        ...fitted,
        rate: fitted.hits / Math.max(1, rows.length),
    },
    leaveOneOffsetOut: {
        hits: crossValidatedHits,
        rate: crossValidatedHits / Math.max(1, rows.length),
        folds,
    },
    oracle: {
        hits: oracle,
        rate: oracle / Math.max(1, rows.length),
    },
}, null, 2));
