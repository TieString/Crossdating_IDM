import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name, fallback = "") => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const valuesFor = (name) => args.flatMap((argument, index) => {
    if (argument.startsWith(`${name}=`)) return [argument.slice(name.length + 1)];
    return argument === name && args[index + 1] ? [args[index + 1]] : [];
});

const priorAnalysisPath = valueFor("--from-analysis");
const priorAnalysis = priorAnalysisPath
    ? JSON.parse(readFileSync(resolve(priorAnalysisPath), "utf8"))
    : null;
const baselinePath = resolve(
    valueFor("--baseline-rows") || priorAnalysis?.summary?.baselinePath,
);
const outputPath = resolve(valueFor("--output"));
const minimumConsensus = Math.max(2, Number(valueFor("--minimum-consensus", "2")));
const minimumSupportMargin = Math.max(0, Number(valueFor("--minimum-support-margin", "2")));
const maximumProtectedBaselineSupport = Math.max(
    0,
    Number(valueFor("--maximum-protected-baseline-support", "2")),
);
const refusalIncompatibilityThreshold = Number(valueFor(
    "--refusal-incompatibility-threshold",
    "1",
));
const explicitViewSpecs = valuesFor("--view").map((specification) => {
    const separator = specification.indexOf(":");
    if (separator <= 0) throw new Error(`invalid --view: ${specification}`);
    return {
        id: specification.slice(0, separator),
        path: resolve(specification.slice(separator + 1)),
    };
});
const viewSpecs = explicitViewSpecs.length > 0
    ? explicitViewSpecs
    : priorAnalysis?.summary?.viewSpecs ?? [];
if (viewSpecs.length === 0) throw new Error("at least one --view is required");

const readRows = (path) => JSON.parse(readFileSync(path, "utf8"));
const baselineRows = readRows(baselinePath);
const rowsByView = new Map();
viewSpecs.forEach(({ id, path }) => {
    const rows = rowsByView.get(id) ?? new Map();
    readRows(path).forEach((row) => rows.set(row.attemptId, row));
    rowsByView.set(id, rows);
});
const viewIds = [...rowsByView.keys()];

const isWhole = (row) => row?.predictedType === "wholeSeriesMove";
const hasPackage = (row) => Boolean(row?.response && row.predictedType);
const compatible = (left, right) => {
    if (!hasPackage(left) || !hasPackage(right)) return false;
    if (left.predictedType !== right.predictedType
        || left.predictedShiftYears !== right.predictedShiftYears) return false;
    if (isWhole(left)) return true;
    if (left.windowStart === null || left.windowEnd === null
        || right.windowStart === null || right.windowEnd === null) return false;
    return Math.max(left.windowStart, right.windowStart)
        <= Math.min(left.windowEnd, right.windowEnd);
};

const clusterRows = (rows) => {
    const clusters = [];
    rows.filter(({ row }) => hasPackage(row)).forEach((entry) => {
        const matching = clusters.find((cluster) => (
            cluster.entries.some((current) => compatible(current.row, entry.row))
        ));
        if (matching) matching.entries.push(entry);
        else clusters.push({ entries: [entry] });
    });
    return clusters.map((cluster) => {
        const locations = cluster.entries.flatMap((entry) => (
            entry.row.windowStart !== null && entry.row.windowEnd !== null
                ? [{
                    entry,
                    center: (entry.row.windowStart + entry.row.windowEnd) / 2,
                }]
                : []
        ));
        const sortedCenters = locations.map((location) => location.center)
            .sort((left, right) => left - right);
        const medianCenter = sortedCenters.length > 0
            ? sortedCenters[Math.floor((sortedCenters.length - 1) / 2)]
            : null;
        const baselineEntry = cluster.entries.find((entry) => (
            entry.viewId === "baseline"
        ));
        const representative = baselineEntry ?? (medianCenter === null
            ? cluster.entries.find((entry) => entry.viewId === "baseline")
                ?? cluster.entries[0]
            : [...locations].sort((left, right) => (
                Math.abs(left.center - medianCenter) - Math.abs(right.center - medianCenter)
                || Number(right.entry.viewId === "baseline")
                    - Number(left.entry.viewId === "baseline")
            ))[0].entry);
        return {
            ...cluster,
            support: new Set(cluster.entries.map((entry) => entry.viewId)).size,
            correctSupport: cluster.entries.filter((entry) => entry.row.workflowCorrect).length,
            medianCenter,
            representative,
        };
    }).sort((left, right) => (
        right.support - left.support
        || Number(right.entries.some((entry) => entry.viewId === "baseline"))
            - Number(left.entries.some((entry) => entry.viewId === "baseline"))
    ));
};

const attempts = baselineRows.map((baseline) => {
    const entries = [
        { viewId: "baseline", row: baseline },
        ...viewIds.flatMap((id) => {
            const row = rowsByView.get(id)?.get(baseline.attemptId);
            return row ? [{ viewId: id, row }] : [];
        }),
    ];
    const clusters = clusterRows(entries);
    const winner = clusters[0] ?? null;
    const baselineCluster = clusters.find((cluster) => (
        cluster.entries.some((entry) => entry.viewId === "baseline")
    )) ?? null;
    const winnerIncludesBaseline = winner?.entries.some((entry) => (
        entry.viewId === "baseline"
    )) ?? false;
    const supportMargin = (winner?.support ?? 0) - (baselineCluster?.support ?? 0);
    const responseGate = baseline.response
        ? supportMargin >= minimumSupportMargin
            || (baselineCluster?.support ?? 0) <= maximumProtectedBaselineSupport
        : (baseline.internalTargetIncompatibilityScore ?? 0)
            >= refusalIncompatibilityThreshold;
    const consensusEligible = winner !== null
        && winner.support >= minimumConsensus
        && (winnerIncludesBaseline || responseGate);
    const selected = consensusEligible ? winner.representative.row : baseline;
    return {
        attemptId: baseline.attemptId,
        fileId: baseline.fileId,
        family: baseline.family,
        targetId: baseline.targetId,
        truthType: baseline.truthType,
        truthYear: baseline.truthYear,
        baselineCorrect: baseline.workflowCorrect,
        selectedCorrect: selected.workflowCorrect,
        selectedView: consensusEligible ? winner.representative.viewId : "baseline",
        winnerSupport: winner?.support ?? 0,
        baselineSupport: baselineCluster?.support ?? 0,
        supportMargin,
        responseGate,
        winnerViews: winner?.entries.map((entry) => entry.viewId) ?? [],
        oracleCorrect: entries.some((entry) => entry.row.workflowCorrect),
        clusters: clusters.map((cluster) => ({
            support: cluster.support,
            correctSupport: cluster.correctSupport,
            views: cluster.entries.map((entry) => entry.viewId),
            eventType: cluster.representative.row.predictedType,
            shiftYears: cluster.representative.row.predictedShiftYears,
            windowStart: cluster.representative.row.windowStart,
            windowEnd: cluster.representative.row.windowEnd,
        })),
    };
});

const summarize = (selected) => ({
    attempts: selected.length,
    baselineCorrect: selected.filter((row) => row.baselineCorrect).length,
    consensusCorrect: selected.filter((row) => row.selectedCorrect).length,
    oracleCorrect: selected.filter((row) => row.oracleCorrect).length,
    corrected: selected.filter((row) => !row.baselineCorrect && row.selectedCorrect).length,
    regressed: selected.filter((row) => row.baselineCorrect && !row.selectedCorrect).length,
});
const summary = {
    schemaVersion: 1,
    baselinePath,
    viewSpecs,
    minimumConsensus,
    minimumSupportMargin,
    maximumProtectedBaselineSupport,
    refusalIncompatibilityThreshold,
    overall: summarize(attempts),
    byFamily: Object.fromEntries(["A", "B", "C", "D"].map((family) => [
        family,
        summarize(attempts.filter((row) => row.family === family)),
    ])),
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({ summary, attempts }, null, 2)}\n`);
console.log(`INTERNAL_REFERENCE_VIEW_ORACLE_COMPLETE ${JSON.stringify(summary)}`);
