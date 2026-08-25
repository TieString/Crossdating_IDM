import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name, fallback = "") => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const rowsPath = resolve(valueFor("--rows"));
const outputPath = resolve(valueFor("--output"));
const rows = JSON.parse(readFileSync(rowsPath, "utf8"));

const shiftFor = (eventType, value) => {
    if (eventType === "missingRing") return -1;
    if (eventType === "falseRing") return 1;
    const shift = Number(value);
    return Number.isFinite(shift) ? shift : null;
};

const identityMatches = (candidate, row) => {
    const eventType = candidate?.eventType ?? candidate?.operationType;
    return eventType === row.truthType
        && shiftFor(eventType, candidate?.shiftYears) === Number(row.truthShiftYears);
};

const locationMatches = (candidate, row) => {
    if (row.truthType === "wholeSeriesMove") return true;
    const truthYear = Number(row.truthYear);
    if (!Number.isFinite(truthYear)) return false;
    const startYear = Number(candidate?.startYear);
    const endYear = Number(candidate?.endYear);
    if (Number.isFinite(startYear) && Number.isFinite(endYear)) {
        return truthYear >= startYear && truthYear <= endYear;
    }
    const point = Number(
        candidate?.bestYear
        ?? candidate?.topYear
        ?? candidate?.targetYear
        ?? candidate?.rankedYears?.[0]?.year,
    );
    return Number.isFinite(point) && Math.abs(point - truthYear) <= 6;
};

const eventsFromPath = (path) => path?.events ?? [];
const pathCollections = (grid) => Object.entries(grid ?? {}).flatMap(([name, value]) => {
    if (name === "rawPathEvents" || name === "cofechaPathEvents") {
        return [{ source: name, events: Array.isArray(value) ? value : [] }];
    }
    if (name.startsWith("bounded") && value && typeof value === "object") {
        return [{ source: name, events: eventsFromPath(value) }];
    }
    return [];
});

const auditCollections = (audit) => [
    "candidateProjectedEvents",
    "detectedBeforeFusion",
    "detectedAfterFusion",
    "retainedAfterEndpointGuard",
    "displayedBeforeLocator",
    "finalEvents",
].map((name) => ({
    source: name,
    events: Array.isArray(audit?.[name]) ? audit[name] : [],
}));

const stablePathEvents = (audit) => {
    const stable = audit?.stableBoundedPathEvidence;
    if (!stable) return [];
    return [
        ["stable_recovered_frontier", [stable.recoveredFrontier]],
        ["stable_newest_path_event", [stable.newestPathEvent]],
        ["stable_selected_path_event", [stable.selectedPathEvent]],
        ["stable_near_stronger", stable.nearPathProbes?.stronger?.events ?? []],
        ["stable_near_regularized", stable.nearPathProbes?.regularized?.events ?? []],
        ["stable_conservative_stronger", stable.conservativeStrongerPath?.events ?? []],
        ["stable_conservative_regularized", stable.conservativeRegularizedPath?.events ?? []],
    ].flatMap(([source, events]) => events
        .filter(Boolean)
        .map((event) => ({ source, event })));
};

const summaries = rows.map((row) => {
    const grid = row.operationGrid ?? {};
    const operations = [...(grid.operations ?? [])].sort((left, right) => (
        Number(right.dynamicScore) - Number(left.dynamicScore)
    ));
    const truthOperationIndex = operations.findIndex((operation) => (
        identityMatches(operation, row)
    ));
    const truthOperation = truthOperationIndex >= 0 ? operations[truthOperationIndex] : null;
    const jointHypotheses = grid.jointDecision?.hypotheses ?? [];
    const paths = pathCollections(grid);
    const auditStages = auditCollections(row.eventDecisionAudit);
    const stableEvents = stablePathEvents(row.eventDecisionAudit);
    const candidateEvents = row.candidates ?? [];
    const completeSources = [
        ...jointHypotheses.filter((event) => identityMatches(event, row)
            && locationMatches(event, row)).map(() => "joint_hypothesis"),
        ...paths.flatMap((collection) => collection.events
            .filter((event) => identityMatches(event, row) && locationMatches(event, row))
            .map(() => collection.source)),
        ...auditStages.flatMap((collection) => collection.events
            .filter((event) => identityMatches(event, row) && locationMatches(event, row))
            .map(() => collection.source)),
        ...stableEvents.filter(({ event }) => identityMatches(event, row)
            && locationMatches(event, row)).map(({ source }) => source),
        ...candidateEvents.filter((event) => identityMatches(event, row)
            && locationMatches(event, row)).map(() => "candidate"),
    ];
    const allEvidenceEvents = [
        ...jointHypotheses,
        ...paths.flatMap((collection) => collection.events),
        ...auditStages.flatMap((collection) => collection.events),
        ...stableEvents.map(({ event }) => event),
        ...candidateEvents,
    ];
    return {
        attemptId: row.attemptId,
        fileId: row.fileId,
        family: row.family,
        truthType: row.truthType,
        truthShiftYears: row.truthShiftYears,
        truthYear: row.truthYear,
        predictedType: row.predictedType,
        predictedShiftYears: row.predictedShiftYears,
        refused: !row.response,
        gridIdentityExists: truthOperation !== null,
        gridIdentityRank: truthOperationIndex >= 0 ? truthOperationIndex + 1 : null,
        gridIdentityLocationHit: truthOperation !== null
            && locationMatches(truthOperation, row),
        gridDynamicSelectionCorrect: identityMatches(grid.dynamicSelection, row),
        gridUnitSelectionCorrect: identityMatches(grid.unitSelection, row),
        jointIdentityExists: jointHypotheses.some((event) => identityMatches(event, row)),
        jointCompleteExists: jointHypotheses.some((event) => identityMatches(event, row)
            && locationMatches(event, row)),
        pathIdentityExists: paths.some((collection) => collection.events.some(
            (event) => identityMatches(event, row),
        )),
        pathCompleteExists: paths.some((collection) => collection.events.some(
            (event) => identityMatches(event, row) && locationMatches(event, row),
        )),
        stableRecoveredComplete: identityMatches(
            row.eventDecisionAudit?.stableBoundedPathEvidence?.recoveredFrontier,
            row,
        ) && locationMatches(
            row.eventDecisionAudit?.stableBoundedPathEvidence?.recoveredFrontier,
            row,
        ),
        anyIdentityExists: allEvidenceEvents.some((event) => identityMatches(event, row)),
        anyLocationExists: allEvidenceEvents.some((event) => locationMatches(event, row)),
        anyCompleteExists: completeSources.length > 0,
        completeSources: [...new Set(completeSources)],
    };
});

const summarize = (selected) => ({
    failures: selected.length,
    refused: selected.filter((row) => row.refused).length,
    gridIdentityExists: selected.filter((row) => row.gridIdentityExists).length,
    gridIdentityTop1: selected.filter((row) => row.gridIdentityRank === 1).length,
    gridIdentityTop3: selected.filter((row) => (
        row.gridIdentityRank !== null && row.gridIdentityRank <= 3
    )).length,
    gridIdentityLocationHit: selected.filter((row) => row.gridIdentityLocationHit).length,
    jointIdentityExists: selected.filter((row) => row.jointIdentityExists).length,
    jointCompleteExists: selected.filter((row) => row.jointCompleteExists).length,
    pathIdentityExists: selected.filter((row) => row.pathIdentityExists).length,
    pathCompleteExists: selected.filter((row) => row.pathCompleteExists).length,
    stableRecoveredComplete: selected.filter((row) => row.stableRecoveredComplete).length,
    anyIdentityExists: selected.filter((row) => row.anyIdentityExists).length,
    anyLocationExists: selected.filter((row) => row.anyLocationExists).length,
    anyCompleteExists: selected.filter((row) => row.anyCompleteExists).length,
});

const output = {
    schemaVersion: 1,
    rowsPath,
    overall: summarize(summaries),
    byFamily: Object.fromEntries(["A", "B", "C", "D"].map((family) => [
        family,
        summarize(summaries.filter((row) => row.family === family)),
    ])),
    rows: summaries,
};
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`INTERNAL_FAILURE_GRID_ANALYSIS_COMPLETE ${JSON.stringify({
    outputPath,
    overall: output.overall,
    byFamily: output.byFamily,
})}`);
