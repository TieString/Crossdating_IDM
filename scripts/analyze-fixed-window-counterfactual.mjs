import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length < 2) {
    throw new Error(
        "Usage: node scripts/analyze-fixed-window-counterfactual.mjs <audit.json> [...]",
    );
}

const eventTypes = ["missingRing", "falseRing", "partialMove"];
const records = [];

for (const path of paths) {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    const offset = payload.offset;
    for (const counterfactualCase of payload.fixedWindowCounterfactualCases ?? []) {
        const ranking = payload.rankingCases.find((rankCase) => (
            rankCase.groupId === counterfactualCase.file
            && rankCase.seriesId === counterfactualCase.target
            && rankCase.eventType === counterfactualCase.eventType
            && rankCase.truthYear === counterfactualCase.truthYear
        ));
        if (!ranking?.matchedLocationRange || !ranking.matchedLocationRankedYears?.length) {
            continue;
        }
        const [startYear, endYear] = ranking.matchedLocationRange;
        const window = counterfactualCase.windows
            .filter((candidate) => (
                candidate.startYear === startYear
                && candidate.endYear === endYear
            ))
            .sort((left, right) => (
                left.eventRank - right.eventRank
                || left.locationRank - right.locationRank
            ))[0];
        if (!window?.rows?.length) continue;
        const currentScores = ranking.matchedLocationRankedYears
            .map((row) => row.score)
            .filter(Number.isFinite);
        const currentRange = currentScores.length > 1
            ? Math.max(...currentScores) - Math.min(...currentScores)
            : 0;
        const currentMargin = currentScores.length > 1
            ? currentScores[0] - currentScores[1]
            : 0;
        records.push({
            offset,
            eventType: counterfactualCase.eventType,
            shiftYears: counterfactualCase.olderLag,
            truthYear: counterfactualCase.truthYear,
            currentTopYear: ranking.matchedLocationRankedYears[0].year,
            currentNormalizedMargin: currentRange > 0 ? currentMargin / currentRange : 0,
            startYear,
            endYear,
            rows: window.rows,
        });
    }
}

const featureNames = [...new Set(
    records.flatMap((record) => record.rows.flatMap((row) => Object.keys(row.features))),
)].sort();

const emptyMetrics = () => ({
    cases: 0,
    exact: 0,
    withinOne: 0,
    absoluteError: 0,
    switched: 0,
    improvements: 0,
    regressions: 0,
});

const add = (metrics, record, selectedYear) => {
    const error = Math.abs(selectedYear - record.truthYear);
    const currentError = Math.abs(record.currentTopYear - record.truthYear);
    metrics.cases += 1;
    metrics.exact += Number(error === 0);
    metrics.withinOne += Number(error <= 1);
    metrics.absoluteError += error;
    metrics.switched += Number(selectedYear !== record.currentTopYear);
    metrics.improvements += Number(error < currentError);
    metrics.regressions += Number(error > currentError);
};

const summarize = (metrics) => ({
    cases: metrics.cases,
    exact: metrics.exact / Math.max(1, metrics.cases),
    withinOne: metrics.withinOne / Math.max(1, metrics.cases),
    meanAbsoluteError: metrics.absoluteError / Math.max(1, metrics.cases),
    switched: metrics.switched,
    improvements: metrics.improvements,
    regressions: metrics.regressions,
});

const predict = (record, config) => {
    const ranked = [...record.rows].sort((left, right) => (
        config.direction * (
            Number(right.features[config.feature] ?? 0)
            - Number(left.features[config.feature] ?? 0)
        )
        || right.year - left.year
    ));
    return Math.max(
        record.startYear,
        Math.min(record.endYear, ranked[0].year + config.yearCorrection),
    );
};

const evaluate = (evaluationRecords, config) => {
    const metrics = emptyMetrics();
    evaluationRecords.forEach((record) => add(metrics, record, predict(record, config)));
    return summarize(metrics);
};

const compare = (left, right) => (
    right.exact - left.exact
    || right.withinOne - left.withinOne
    || left.meanAbsoluteError - right.meanAbsoluteError
    || left.regressions - right.regressions
    || right.improvements - left.improvements
);

const configurations = featureNames.flatMap((feature) => (
    [-1, 1].flatMap((direction) => (
        [-2, -1, 0, 1, 2].map((yearCorrection) => ({
            feature,
            direction,
            yearCorrection,
        }))
    ))
));

const baseline = (evaluationRecords) => {
    const metrics = emptyMetrics();
    evaluationRecords.forEach((record) => add(metrics, record, record.currentTopYear));
    return summarize(metrics);
};

const percentileRanks = (values) => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const ranks = new Float64Array(values.length);
    let start = 0;
    while (start < ordered.length) {
        let end = start + 1;
        while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1;
        const rank = ordered.length <= 1
            ? 0.5
            : ((start + end - 1) / 2) / (ordered.length - 1);
        for (let index = start; index < end; index += 1) {
            ranks[ordered[index].index] = rank;
        }
        start = end;
    }
    return ranks;
};

const consensusPrediction = (record, features) => {
    const scores = new Float64Array(record.rows.length);
    const votes = new Uint16Array(record.rows.length);
    features.forEach((feature) => {
        const ranks = percentileRanks(record.rows.map((row) => (
            Number(row.features[feature] ?? 0)
        )));
        ranks.forEach((rank, index) => {
            scores[index] += rank / features.length;
        });
        const maximum = Math.max(...ranks);
        ranks.forEach((rank, index) => {
            if (rank === maximum) votes[index] += 1;
        });
    });
    const order = record.rows
        .map((row, index) => ({ row, index, score: scores[index], votes: votes[index] }))
        .sort((left, right) => (
            right.score - left.score
            || right.votes - left.votes
            || right.row.year - left.row.year
        ));
    const top = order[0];
    const runner = order[1] ?? top;
    const voteRunner = [...order]
        .sort((left, right) => right.votes - left.votes || right.score - left.score)[1]
        ?? top;
    return {
        year: top.row.year,
        margin: top.score - runner.score,
        votes: top.votes,
        voteLead: top.votes - voteRunner.votes,
    };
};

const gatedConfigurations = [
    [1, 2, 3, Number.POSITIVE_INFINITY],
    [0, 0.01, 0.025, 0.05, 0.1],
    [1, 2, 3, 4],
    [0, 1, 2],
    [0.02, 0.05, 0.1, 0.2, Number.POSITIVE_INFINITY],
].reduce((configs, values, index) => {
    if (index === 0) return values.map((maxDistance) => ({ maxDistance }));
    if (index === 1) {
        return configs.flatMap((config) => values.map((minMargin) => ({
            ...config,
            minMargin,
        })));
    }
    if (index === 2) {
        return configs.flatMap((config) => values.map((minimumVotes) => ({
            ...config,
            minimumVotes,
        })));
    }
    if (index === 3) {
        return configs.flatMap((config) => values.map((minimumVoteLead) => ({
            ...config,
            minimumVoteLead,
        })));
    }
    return configs.flatMap((config) => values.map((maximumCurrentMargin) => ({
        ...config,
        maximumCurrentMargin,
    })));
}, []);

const gatedPredict = (record, features, gate) => {
    const proposal = consensusPrediction(record, features);
    const useProposal = (
        Math.abs(proposal.year - record.currentTopYear) <= gate.maxDistance
        && proposal.margin >= gate.minMargin
        && proposal.votes >= gate.minimumVotes
        && proposal.voteLead >= gate.minimumVoteLead
        && record.currentNormalizedMargin <= gate.maximumCurrentMargin
    );
    return useProposal ? proposal.year : record.currentTopYear;
};

const analyzeGatedConsensus = (typedRecords, features) => {
    const scoreConfigs = (training) => gatedConfigurations.map((gate) => {
        const metrics = emptyMetrics();
        training.forEach((record) => add(
            metrics,
            record,
            gatedPredict(record, features, gate),
        ));
        return { gate, metrics: summarize(metrics) };
    }).sort((left, right) => compare(left.metrics, right.metrics));
    const offsets = [...new Set(typedRecords.map((record) => record.offset))].sort();
    const crossValidated = emptyMetrics();
    const folds = offsets.map((heldOutOffset) => {
        const training = typedRecords.filter((record) => record.offset !== heldOutOffset);
        const validation = typedRecords.filter((record) => record.offset === heldOutOffset);
        const selected = scoreConfigs(training)[0];
        validation.forEach((record) => add(
            crossValidated,
            record,
            gatedPredict(record, features, selected.gate),
        ));
        const validationMetrics = emptyMetrics();
        validation.forEach((record) => add(
            validationMetrics,
            record,
            gatedPredict(record, features, selected.gate),
        ));
        return {
            heldOutOffset,
            gate: selected.gate,
            training: selected.metrics,
            validation: summarize(validationMetrics),
        };
    });
    return {
        features,
        baseline: baseline(typedRecords),
        leaveOneOffsetOut: summarize(crossValidated),
        folds,
        fitted: scoreConfigs(typedRecords).slice(0, 8),
    };
};

const analyze = (typedRecords) => {
    const fitted = configurations.map((config) => ({
        config,
        metrics: evaluate(typedRecords, config),
    })).sort((left, right) => compare(left.metrics, right.metrics));
    const offsets = [...new Set(typedRecords.map((record) => record.offset))].sort();
    const crossValidated = emptyMetrics();
    const folds = offsets.map((heldOutOffset) => {
        const training = typedRecords.filter((record) => record.offset !== heldOutOffset);
        const validation = typedRecords.filter((record) => record.offset === heldOutOffset);
        const selected = configurations.map((config) => ({
            config,
            metrics: evaluate(training, config),
        })).sort((left, right) => compare(left.metrics, right.metrics))[0];
        validation.forEach((record) => add(
            crossValidated,
            record,
            predict(record, selected.config),
        ));
        return {
            heldOutOffset,
            selected: selected.config,
            training: selected.metrics,
            validation: evaluate(validation, selected.config),
        };
    });
    return {
        baseline: baseline(typedRecords),
        leaveOneOffsetOut: summarize(crossValidated),
        folds,
        fitted: fitted.slice(0, 12),
    };
};

const report = {
    conditioning: "truth-covered selectable window with operation-compatible partial shift",
    offsets: [...new Set(records.map((record) => record.offset))].sort(),
    records: records.length,
    featureCount: featureNames.length,
    ...Object.fromEntries(eventTypes.map((eventType) => [
        eventType,
        analyze(records.filter((record) => record.eventType === eventType)),
    ])),
    partialMoveNegativeShift: analyze(records.filter((record) => (
        record.eventType === "partialMove" && record.shiftYears < 0
    ))),
    partialMovePositiveShift: analyze(records.filter((record) => (
        record.eventType === "partialMove" && record.shiftYears > 0
    ))),
    missingRingGatedConsensus: analyzeGatedConsensus(
        records.filter((record) => record.eventType === "missingRing"),
        [
            "rawReferenceMeanR21",
            "rawReferenceWeightedR21",
            "rawReferenceTrimmedR21",
            "rawReferenceMeanR31",
            "rawReferenceWeightedR31",
            "rawReferenceTrimmedR31",
        ],
    ),
    falseRingGatedConsensus: analyzeGatedConsensus(
        records.filter((record) => record.eventType === "falseRing"),
        [
            "whitenedMasterHuber21",
            "whitenedMasterHuber31",
            "whitenedMasterHuber61",
            "differenceMasterHuber21",
            "differenceMasterHuber31",
            "differenceMasterHuber61",
        ],
    ),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
