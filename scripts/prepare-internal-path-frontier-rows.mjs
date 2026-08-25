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
const sourceRows = JSON.parse(readFileSync(rowsPath, "utf8"));

const eventShift = (event) => {
    const eventType = event?.eventType ?? event?.operationType;
    if (eventType === "missingRing") return -1;
    if (eventType === "falseRing") return 1;
    const value = Number(event?.shiftYears);
    return Number.isFinite(value) ? value : null;
};

const eventTopYear = (event) => {
    const value = Number(
        event?.topYear
        ?? event?.bestYear
        ?? event?.targetYear
        ?? event?.rankedYears?.[0]?.year,
    );
    if (Number.isFinite(value)) return value;
    const start = Number(event?.startYear);
    const end = Number(event?.endYear);
    return Number.isFinite(start) && Number.isFinite(end) ? (start + end) / 2 : null;
};

const eventIdentityMatches = (left, right) => (
    left && right
    && (left.eventType ?? left.operationType) === (right.eventType ?? right.operationType)
    && eventShift(left) === eventShift(right)
);

const eventLocationMatches = (event, truth) => {
    if (truth.truthType === "wholeSeriesMove") return true;
    const year = Number(truth.truthYear);
    if (!Number.isFinite(year)) return false;
    const start = Number(event?.startYear);
    const end = Number(event?.endYear);
    if (Number.isFinite(start) && Number.isFinite(end)) {
        return year >= start && year <= end;
    }
    const top = eventTopYear(event);
    return top !== null && Math.abs(top - year) <= 6;
};

const stableCorrect = (event, row) => {
    if (!event || !row.truthId) return false;
    return (event.eventType ?? event.operationType) === row.truthType
        && eventShift(event) === Number(row.truthShiftYears)
        && eventLocationMatches(event, row);
};

const pathCollections = (grid) => Object.entries(grid ?? {}).flatMap(([name, value]) => {
    if (name === "rawPathEvents" || name === "cofechaPathEvents") {
        return [{ name, events: Array.isArray(value) ? value : [] }];
    }
    if (name.startsWith("bounded") && value && typeof value === "object") {
        return [{ name, events: value.events ?? [] }];
    }
    return [];
});

const overlap = (left, right) => {
    const leftStart = Number(left?.startYear);
    const leftEnd = Number(left?.endYear);
    const rightStart = Number(right?.startYear);
    const rightEnd = Number(right?.endYear);
    if (![leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite)) return 0;
    const intersection = Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart) + 1);
    const union = Math.max(leftEnd, rightEnd) - Math.min(leftStart, rightStart) + 1;
    return union > 0 ? intersection / union : 0;
};

const finite = (value, fallback = 0) => Number.isFinite(Number(value))
    ? Number(value)
    : fallback;

const typeCode = (eventType) => ({
    missingRing: -1,
    falseRing: 1,
    partialMove: -2,
    wholeSeriesMove: -3,
}[eventType] ?? 0);

const rows = sourceRows.map((row) => {
    const audit = row.eventDecisionAudit;
    const stableEvidence = audit?.stableBoundedPathEvidence;
    const stable = stableEvidence?.recoveredFrontier ?? null;
    const product = audit?.finalEvents?.[0] ?? (row.response ? {
        eventType: row.predictedType,
        shiftYears: row.predictedShiftYears,
        startYear: row.windowStart,
        endYear: row.windowEnd,
    } : null);
    const grid = row.operationGrid ?? {};
    const operations = [...(grid.operations ?? [])].sort((left, right) => (
        finite(right.dynamicScore, -Infinity) - finite(left.dynamicScore, -Infinity)
    ));
    const stableOperationIndex = stable ? operations.findIndex((operation) => (
        eventIdentityMatches(operation, stable)
    )) : -1;
    const productOperationIndex = product ? operations.findIndex((operation) => (
        eventIdentityMatches(operation, product)
    )) : -1;
    const stableOperation = stableOperationIndex >= 0 ? operations[stableOperationIndex] : null;
    const productOperation = productOperationIndex >= 0 ? operations[productOperationIndex] : null;
    const paths = pathCollections(grid);
    const stablePathSupport = stable ? paths.filter((collection) => collection.events.some(
        (event) => eventIdentityMatches(event, stable) && overlap(event, stable) > 0,
    )).length : 0;
    const stableExactPathSupport = stable ? paths.filter((collection) => collection.events.some(
        (event) => eventIdentityMatches(event, stable)
            && Math.abs(finite(eventTopYear(event), -9999) - finite(eventTopYear(stable), 9999)) <= 2,
    )).length : 0;
    const jointHypotheses = grid.jointDecision?.hypotheses ?? [];
    const stableJointSupport = stable ? jointHypotheses.filter((event) => (
        eventIdentityMatches(event, stable) && overlap(event, stable) > 0
    )).length : 0;
    const stableTop = eventTopYear(stable);
    const productTop = eventTopYear(product);
    const targetRange = audit?.targetRange;
    const targetSpan = Math.max(
        1,
        finite(targetRange?.endYear) - finite(targetRange?.startYear) + 1,
    );
    const compatibility = row.internalTargetCompatibility ?? {};
    const stableShift = eventShift(stable);
    const stableLagDelta = stable
        ? finite(stable.lagBefore) - finite(stable.lagAfter)
        : 0;
    const productSources = new Set(product?.algorithmSources ?? product?.evidence?.algorithmSources ?? []);
    const features = {
        stableExists: stable ? 1 : 0,
        stableTypeCode: typeCode(stable?.eventType),
        stableShift: finite(stableShift),
        stableShiftMagnitude: Math.abs(finite(stableShift)),
        stableScore: finite(stable?.score),
        stableMargin: finite(stable?.scoreMargin),
        stableCorrelationGain: finite(stable?.correlationGain),
        stableSamplePairsLog: Math.log1p(Math.max(0, finite(stable?.samplePairs))),
        stableLagBefore: finite(stable?.lagBefore),
        stableLagAfter: finite(stable?.lagAfter),
        stableLagDelta,
        stableLagDeltaMatchesShift: stableShift === stableLagDelta ? 1 : 0,
        stableTopRelativeToEnd: stableTop === null
            ? 0
            : (stableTop - finite(targetRange?.startYear)) / targetSpan,
        stableTransitionCount: finite(stableEvidence?.transitionCount),
        stableAggregateShift: finite(stableEvidence?.aggregateShiftYears),
        stableFinalAuthority: stableEvidence?.finalAuthority ? 1 : 0,
        stableIndependentOperationSupport: stableEvidence?.independentOperationSupport ? 1 : 0,
        stableRepeatedOperationSupport: stableEvidence?.repeatedOperationSupport ? 1 : 0,
        stableNearExactPartial: stableEvidence?.nearExactPartialCheckpoint ? 1 : 0,
        stableTerminalPartial: stableEvidence?.terminalOperationAnchoredPartialCheckpoint ? 1 : 0,
        stableCollapsedPartial: stableEvidence?.collapsedMissingFalsePartialCheckpoint ? 1 : 0,
        stablePathSupport,
        stableExactPathSupport,
        stableJointSupport,
        stableOperationRank: stableOperationIndex >= 0 ? stableOperationIndex + 1 : 999,
        stableOperationScore: finite(stableOperation?.dynamicScore),
        stableOperationRawGain: finite(stableOperation?.bestRawGain),
        stableOperationDifferenceGain: finite(stableOperation?.bestDifferenceGain),
        stableOperationRemoteMargin: finite(stableOperation?.remoteDifferenceMargin),
        productExists: product ? 1 : 0,
        productTypeCode: typeCode(product?.eventType),
        productShift: finite(eventShift(product)),
        productScore: finite(product?.score ?? product?.evidence?.score),
        productMargin: finite(product?.scoreMargin ?? product?.evidence?.scoreMargin),
        productOperationRank: productOperationIndex >= 0 ? productOperationIndex + 1 : 999,
        productOperationScore: finite(productOperation?.dynamicScore),
        stableProductSameIdentity: eventIdentityMatches(stable, product) ? 1 : 0,
        stableProductWindowOverlap: overlap(stable, product),
        stableProductYearDelta: stableTop !== null && productTop !== null
            ? (stableTop - productTop) / targetSpan
            : 0,
        productHasSequentialSource: productSources.has("sequential_missing_staircase_head") ? 1 : 0,
        productHasJointSource: [...productSources].some((source) => String(source).includes("joint")) ? 1 : 0,
        globalBestLag: finite(grid.coreGlobalSlidingMatch?.bestGlobalLag),
        globalBestCorrelation: finite(grid.coreGlobalSlidingMatch?.bestGlobalR),
        globalZeroCorrelation: finite(grid.coreGlobalSlidingMatch?.zeroLagR),
        targetZeroCorrelation: finite(compatibility.zeroCorrelation, -0.2),
        targetZeroLagDeficit: finite(compatibility.zeroLagDeficit, 1),
        targetSegmentBad: finite(compatibility.segmentIncompatibleFraction, 1),
        targetPairBad: finite(compatibility.perReferenceIncompatibleFraction, 1),
        referenceCountLog: Math.log1p(Math.max(0, finite(compatibility.referenceCount))),
    };
    const candidateCorrect = stableCorrect(stable, row);
    const productCorrect = Boolean(row.workflowCorrect);
    const samePackage = eventIdentityMatches(stable, product)
        && overlap(stable, product) > 0.5;
    const eligibleOverride = stable !== null && !samePackage;
    return {
        attemptId: row.attemptId,
        fileId: row.fileId,
        family: row.family,
        isClean: row.truthId === null,
        productCorrect,
        candidateCorrect,
        eligibleOverride,
        beneficialOverride: eligibleOverride && !productCorrect && candidateCorrect,
        harmfulOverride: eligibleOverride && productCorrect && !candidateCorrect,
        neutralBoth: eligibleOverride && productCorrect && candidateCorrect,
        neutralNeither: eligibleOverride && !productCorrect && !candidateCorrect,
        productResponse: Boolean(row.response),
        candidateEvent: stable,
        features,
    };
});

const featureNames = Object.keys(rows[0]?.features ?? {});
const output = {
    schemaVersion: 1,
    rowsPath,
    featureNames,
    forbiddenFeatures: ["fileId", "family", "attemptId", "truthYear", "truthType"],
    summary: {
        attempts: rows.length,
        eligibleOverrides: rows.filter((row) => row.eligibleOverride).length,
        beneficialOverrides: rows.filter((row) => row.beneficialOverride).length,
        harmfulOverrides: rows.filter((row) => row.harmfulOverride).length,
        neutralBoth: rows.filter((row) => row.neutralBoth).length,
        neutralNeither: rows.filter((row) => row.neutralNeither).length,
        cleanCandidates: rows.filter((row) => row.isClean && row.candidateEvent).length,
    },
    rows,
};
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`INTERNAL_PATH_FRONTIER_ROWS_COMPLETE ${JSON.stringify({
    outputPath,
    ...output.summary,
    featureCount: featureNames.length,
})}`);
