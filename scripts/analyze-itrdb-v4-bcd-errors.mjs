/** Audits B/C/D frontier failures from a completed operation-capability run. */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name, fallback = null) => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const requiredValue = (name) => {
    const value = valueFor(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const rate = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;
const percentile = (values, probability) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1)];
};
const countBy = (rows, keyFor) => Object.fromEntries([...rows.reduce((counts, row) => {
    const key = keyFor(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
}, new Map()).entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
const groupedMetrics = (rows, keyFor) => [...rows.reduce((groups, row) => {
    const key = keyFor(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
    return groups;
}, new Map()).entries()].map(([key, group]) => {
    const correct = group.filter((row) => row.workflowSuggestionCorrect).length;
    return {
        key,
        attempts: group.length,
        correct,
        accuracy: rate(correct, group.length),
        wrongOperation: group.filter((row) => row.stopReason === "wrong_operation").length,
        windowMiss: group.filter((row) => row.stopReason === "window_miss").length,
        refused: group.filter((row) => row.stopReason === "refused").length,
        outOfOrder: group.filter((row) => row.stopReason === "out_of_order_frontier").length,
    };
}).sort((left, right) => left.accuracy - right.accuracy || right.attempts - left.attempts);

const runDir = resolve(requiredValue("--run-dir"));
const manifestPath = resolve(requiredValue("--manifest"));
const outputPath = valueFor("--output");
const summary = readJson(join(runDir, "summary.json"));
const steps = readJson(join(runDir, "steps.json"));
const specs = readJson(join(runDir, "resolved-cases.json"));
const manifest = readJson(manifestPath);
const families = new Set(["B", "C", "D"]);
const attempted = steps.filter((step) => families.has(step.family) && step.remainingTruthsBefore > 0);
const specByCase = new Map(specs.map((spec) => [spec.caseId, spec]));
const targetByKey = new Map(manifest.files.flatMap((file) => file.eligibleTargets.map((target) => [
    `${file.fileId}|${target.targetId}`,
    target,
])));
const zeroCountFor = (step) => targetByKey.get(`${step.fileId}|${step.targetId}`)?.zeroCount ?? 0;
const zeroBin = (count) => count === 0 ? "0"
    : count <= 5 ? "1-5"
        : count <= 10 ? "6-10"
            : count <= 20 ? "11-20"
                : count <= 40 ? "21-40"
                    : "41+";
const diagnosisShift = (event) => event?.shiftYears ?? null;
const operationKey = (event) => event
    ? `${event.eventType}:${diagnosisShift(event)}`
    : "none";
const truthKey = (truth) => `${truth.eventType}:${truth.shiftYears}`;
const remainingTruths = (step) => {
    const spec = specByCase.get(step.caseId);
    const remainingIds = new Set(step.remainingTruthIds);
    return spec.truths.filter((truth) => remainingIds.has(truth.truthId));
};
const frontierTruths = (step) => {
    const remaining = remainingTruths(step);
    const whole = remaining.filter((truth) => truth.eventType === "wholeSeriesMove");
    const local = remaining.filter((truth) => truth.year !== null)
        .sort((left, right) => right.year - left.year)[0];
    return [...whole, ...(local ? [local] : [])];
};
const frontierKey = (step) => frontierTruths(step).map(truthKey).sort().join("|");
const eventMatchesTruth = (event, truth) => event
    && event.eventType === truth.eventType
    && diagnosisShift(event) === truth.shiftYears;
const eventCoversTruth = (event, truth) => eventMatchesTruth(event, truth)
    && (truth.eventType === "wholeSeriesMove"
        || (truth.year >= event.startYear && truth.year <= event.endYear));

const outcomeRows = Object.fromEntries(["B", "C", "D"].map((family) => {
    const rows = attempted.filter((step) => step.family === family);
    return [family, {
        attempts: rows.length,
        correct: rows.filter((step) => step.workflowSuggestionCorrect).length,
        accuracy: rate(rows.filter((step) => step.workflowSuggestionCorrect).length, rows.length),
        outcomes: countBy(rows, (step) => step.workflowSuggestionCorrect ? "correct" : step.stopReason),
    }];
}));

const wrongSteps = attempted.filter((step) => step.stopReason === "wrong_operation");
const confusion = groupedMetrics(wrongSteps, (step) => (
    `${step.family}|${frontierKey(step)} -> ${operationKey(step.primary)}`
));
const wrongEvidenceSources = countBy(
    wrongSteps.flatMap((step) => step.primary?.sources ?? []),
    (source) => source,
);
const wrongPredictionTypes = countBy(wrongSteps, (step) => `${step.family}|${operationKey(step.primary)}`);
const wrongPredictionOperationTypes = countBy(
    wrongSteps,
    (step) => `${step.family}|${step.primary?.eventType ?? "none"}`,
);
const wrongMismatchKind = countBy(wrongSteps, (step) => {
    const expected = frontierTruths(step);
    const sameType = expected.some((truth) => truth.eventType === step.primary?.eventType);
    return `${step.family}|${sameType ? "shift_mismatch" : "type_mismatch"}`;
});
const missingHistoryOverrides = wrongSteps.filter((step) => (
    step.primary?.eventType === "missingRing"
    && (step.primary.sources ?? []).some((source) => source.includes("sequential_missing"))
    && zeroCountFor(step) > 0
));
const largeHistoryOverrides = missingHistoryOverrides.filter((step) => {
    const transitionNote = (step.primary.notes ?? []).find((note) => (
        note.startsWith("sequential_missing_transition_count=")
    ));
    const count = Number(transitionNote?.split("=")[1] ?? 0);
    return count >= 4;
});

const windowMissRows = attempted.filter((step) => step.stopReason === "window_miss").flatMap((step) => {
    const event = step.primaryOperationCorrect ? step.primary : step.alternative;
    if (!event) return [];
    const anchor = event.topYear ?? Math.round((event.startYear + event.endYear) / 2);
    const truth = frontierTruths(step).filter((candidate) => eventMatchesTruth(event, candidate))
        .sort((left, right) => Math.abs(left.year - anchor) - Math.abs(right.year - anchor))[0];
    if (!truth || truth.year === null) return [];
    const signedDistance = truth.year < event.startYear
        ? truth.year - event.startYear
        : truth.year > event.endYear
            ? truth.year - event.endYear
            : 0;
    return [{ ...step, event, truth, signedDistance, distance: Math.abs(signedDistance) }];
});
const summarizeWindowMisses = (rows) => ({
    count: rows.length,
    medianDistance: percentile(rows.map((row) => row.distance), 0.5),
    p90Distance: percentile(rows.map((row) => row.distance), 0.9),
    within2Years: rows.filter((row) => row.distance <= 2).length,
    within4Years: rows.filter((row) => row.distance <= 4).length,
    truthOlderThanWindow: rows.filter((row) => row.signedDistance < 0).length,
    truthNewerThanWindow: rows.filter((row) => row.signedDistance > 0).length,
});

const outOfOrderRows = attempted.filter((step) => step.stopReason === "out_of_order_frontier")
    .flatMap((step) => {
        const remaining = remainingTruths(step);
        const newestLocal = remaining.filter((truth) => truth.year !== null)
            .sort((left, right) => right.year - left.year)[0];
        if (!newestLocal) return [];
        const matches = [step.primary, step.alternative].flatMap((event) => {
            if (!event) return [];
            const anchor = event.topYear ?? Math.round((event.startYear + event.endYear) / 2);
            return remaining.filter((truth) => eventCoversTruth(event, truth))
                .map((truth) => ({ event, truth, distance: Math.abs(truth.year - anchor) }));
        }).sort((left, right) => left.distance - right.distance);
        if (matches.length === 0 || matches[0].truth.year === null) return [];
        return [{
            ...step,
            matchedTruth: matches[0].truth,
            newestLocal,
            yearDelta: matches[0].truth.year - newestLocal.year,
        }];
    });
const summarizeOutOfOrder = (rows) => ({
    count: rows.length,
    selectedOlderEvent: rows.filter((row) => row.yearDelta < 0).length,
    selectedNewerEvent: rows.filter((row) => row.yearDelta > 0).length,
    medianYearsBehind: percentile(
        rows.filter((row) => row.yearDelta < 0).map((row) => Math.abs(row.yearDelta)),
        0.5,
    ),
    p90YearsBehind: percentile(
        rows.filter((row) => row.yearDelta < 0).map((row) => Math.abs(row.yearDelta)),
        0.9,
    ),
});

const operationDenominators = new Map();
for (const spec of specs.filter((item) => families.has(item.family))) {
    for (const truth of spec.truths) {
        const key = `${spec.family}|${truthKey(truth)}`;
        operationDenominators.set(key, (operationDenominators.get(key) ?? 0) + 1);
    }
}
const operationNumerators = new Map();
for (const step of attempted.filter((item) => item.acceptedTruthType !== null)) {
    const key = `${step.family}|${step.acceptedTruthType}:${step.acceptedTruthShiftYears}`;
    operationNumerators.set(key, (operationNumerators.get(key) ?? 0) + 1);
}
const operationRecovery = [...operationDenominators.entries()].map(([key, total]) => {
    const recovered = operationNumerators.get(key) ?? 0;
    return { key, total, recovered, recoveryRate: rate(recovered, total) };
}).sort((left, right) => left.recoveryRate - right.recoveryRate);

const result = {
    schemaVersion: 1,
    runDir,
    executionGitCommit: summary.executionGitCommit,
    selectedCases: summary.selectedCases,
    headline: Object.fromEntries(["B", "C", "D"].map((family) => [family, {
        workflowSuggestionAccuracy: summary.byFamily[family].workflowSuggestionAccuracy,
        serialRecoveryRate: summary.byFamily[family].serialRecoveryRate,
        responseRate: summary.byFamily[family].responseRate,
        strictOperationAccuracy: summary.byFamily[family].strictOperationAccuracy,
        workflowEquivalentOperationAccuracy: summary.byFamily[family].workflowEquivalentOperationAccuracy,
        conditionalLocalWindowCoverage: summary.byFamily[family].conditionalLocalWindowCoverage,
    }])),
    frontierOutcomes: outcomeRows,
    byScenario: groupedMetrics(attempted, (step) => `${step.family}|${step.scenarioId}`),
    byFile: groupedMetrics(attempted, (step) => step.fileId),
    byFamilyFile: groupedMetrics(attempted, (step) => `${step.family}|${step.fileId}`),
    byOriginalZeroCount: groupedMetrics(attempted, (step) => `${step.family}|${zeroBin(zeroCountFor(step))}`),
    byStep: groupedMetrics(attempted, (step) => `${step.family}|step-${step.step}`),
    byReferenceMode: groupedMetrics(attempted, (step) => `${step.family}|${step.referenceMode}`),
    byCofechaFlag: groupedMetrics(attempted, (step) => `${step.family}|flagged-${step.cofechaFlagged}`),
    byWholePresence: groupedMetrics(attempted, (step) => (
        `${step.family}|whole-${remainingTruths(step).some((truth) => truth.eventType === "wholeSeriesMove")}`
    )),
    operationRecovery,
    wrongOperation: {
        count: wrongSteps.length,
        predictionTypes: wrongPredictionTypes,
        predictionOperationTypes: wrongPredictionOperationTypes,
        mismatchKinds: wrongMismatchKind,
        topConfusions: confusion.slice(0, 30),
        evidenceSources: Object.fromEntries(Object.entries(wrongEvidenceSources).slice(0, 30)),
        sequentialMissingHistoryOverrides: missingHistoryOverrides.length,
        sequentialMissingHistoryOverridesByFamily: countBy(
            missingHistoryOverrides,
            (step) => step.family,
        ),
        sequentialMissingHistoryOverridesByScenario: Object.fromEntries(Object.entries(countBy(
            missingHistoryOverrides,
            (step) => `${step.family}|${step.scenarioId}`,
        )).slice(0, 20)),
        largeSequentialMissingHistoryOverrides: largeHistoryOverrides.length,
        largeSequentialMissingHistoryOverridesByFamily: countBy(
            largeHistoryOverrides,
            (step) => step.family,
        ),
        examples: wrongSteps.slice(0, 20).map((step) => ({
            caseId: step.caseId,
            family: step.family,
            scenarioId: step.scenarioId,
            step: step.step,
            originalZeroCount: zeroCountFor(step),
            frontier: frontierKey(step),
            primary: operationKey(step.primary),
            primaryWindow: step.primary ? [step.primary.startYear, step.primary.endYear] : null,
            sources: step.primary?.sources ?? [],
        })),
    },
    windowMisses: {
        overall: summarizeWindowMisses(windowMissRows),
        B: summarizeWindowMisses(windowMissRows.filter((row) => row.family === "B")),
        C: summarizeWindowMisses(windowMissRows.filter((row) => row.family === "C")),
        D: summarizeWindowMisses(windowMissRows.filter((row) => row.family === "D")),
    },
    outOfOrder: {
        overall: summarizeOutOfOrder(outOfOrderRows),
        B: summarizeOutOfOrder(outOfOrderRows.filter((row) => row.family === "B")),
        C: summarizeOutOfOrder(outOfOrderRows.filter((row) => row.family === "C")),
        D: summarizeOutOfOrder(outOfOrderRows.filter((row) => row.family === "D")),
        examples: outOfOrderRows.slice(0, 20).map((row) => ({
            caseId: row.caseId,
            family: row.family,
            scenarioId: row.scenarioId,
            step: row.step,
            selectedTruthYear: row.matchedTruth.year,
            frontierTruthYear: row.newestLocal.year,
            yearDelta: row.yearDelta,
            primary: operationKey(row.primary),
            primaryWindow: row.primary ? [row.primary.startYear, row.primary.endYear] : null,
        })),
    },
};

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) writeFileSync(resolve(outputPath), serialized, "utf8");
console.log(`ITRDB_V4_BCD_ERROR_AUDIT ${JSON.stringify({
    runDir,
    outputPath: outputPath ? resolve(outputPath) : null,
    wrongOperation: wrongSteps.length,
    windowMiss: windowMissRows.length,
})}`);
if (!outputPath) process.stdout.write(serialized);
