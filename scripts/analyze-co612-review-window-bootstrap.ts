import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRwl } from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

type EventOutcome = {
    response: boolean;
    eventType: string | null;
    operationCorrect: boolean;
    windowCovered: boolean;
    top1Exact: boolean;
    topYear: number | null;
    windowStart: number | null;
    windowEnd: number | null;
    windowWidth: number | null;
    confidence: string | null;
    score: number | null;
    scoreMargin: number | null;
    reviewOnly: boolean;
};

type EventObservation = {
    round: number;
    eventId: string;
    seriesId: string;
    truthYear: number;
    absoluteIdentifiable: boolean;
    restoredOtherEvents: number;
    restoredOtherFraction: number;
    cofechaFlagged: boolean;
    cofechaFlaggedCount: number;
    referenceMode: string;
    referenceAnchorCount: number;
    referenceSourceCount: number;
    minimumReferenceDepth: number;
    medianReferenceDepth: number;
    globalZeroLagBestRate?: number;
    globalAbsoluteLagP90?: number;
    strictReason: string;
    reviewDecisionReason: string;
    reviewDecisionStatus: string;
    candidateCount: number;
    candidateModeCount: number;
    strict: EventOutcome;
    review: EventOutcome;
};

type ApplicationRow = {
    round: number;
    eventId: string;
    seriesId: string;
    truthYear: number;
    sourceStatus: string;
    recoveredBefore: number;
    recoveredAfter: number;
};

type LegacyObservation = {
    seriesId: string;
    truthYear: number;
    response: boolean;
};

type RunSummary = {
    inputPath: string;
    runDir: string;
    sourceSha256: string;
    sourceUnchanged: boolean;
    stopReason: string;
    totalTruthEvents: number;
    absoluteIdentifiableEvents: number;
    absoluteUnidentifiableYears: number[];
    recoveredEvents: number;
    remainingEvents: number;
    initialZeroCount: number;
    cleanOriginal: {
        cases: number;
        strictFalsePositiveRate: number;
        reviewFalsePositiveRate: number;
    };
    relativeAlignment: Record<string, {
        eligiblePairs: number;
        zeroLagBestPairs: number;
        zeroLagBestRate: number;
        meanAbsoluteBestLag: number;
        p90AbsoluteBestLag: number;
    }>;
};

type CaseRow = {
    eventId: string;
    seriesId: string;
    truthYear: number;
    absoluteIdentifiable: boolean;
    seriesLength: number;
    seriesStartYear: number;
    seriesEndYear: number;
    originalMissingCount: number;
    minimumMissingSpacing: number | null;
    olderEndpointDistance: number;
    newerEndpointDistance: number;
    firstObservationRound: number | null;
    observationCount: number;
    firstCofechaFlagged: boolean | null;
    firstReferenceDepth: number | null;
    lastReferenceDepth: number | null;
    firstReferenceSources: number | null;
    lastReferenceSources: number | null;
    firstGlobalZeroLagBestRate: number | null;
    lastGlobalZeroLagBestRate: number | null;
    firstGlobalAbsoluteLagP90: number | null;
    lastGlobalAbsoluteLagP90: number | null;
    initialStrictRefusalReason: string;
    firstStrict: EventOutcome | null;
    firstReview: EventOutcome | null;
    firstReviewResponse: EventOutcome | null;
    firstReviewResponseRound: number | null;
    firstCorrectReview: EventOutcome | null;
    firstCorrectReviewRound: number | null;
    firstCorrectReviewAttempt: number | null;
    firstCorrectRestoredOtherEvents: number | null;
    firstCorrectRestoredOtherFraction: number | null;
    cumulativeStrictRefusals: number;
    applicationRound: number | null;
    recovered: boolean;
    legacyObserved: boolean;
    legacyResponse: boolean;
    legacyRefusal: boolean;
    statePath: Array<{
        round: number;
        strictStatus: string;
        reviewStatus: string;
        strictReason: string;
        reviewReason: string;
        strictOperation: string | null;
        reviewOperation: string | null;
        strictWindowCovered: boolean;
        reviewWindowCovered: boolean;
        reviewTopYear: number | null;
        reviewWindowStart: number | null;
        reviewWindowEnd: number | null;
        score: number | null;
        margin: number | null;
        referenceDepth: number;
        referenceSources: number;
        cofechaFlagged: boolean;
        restoredOtherEvents: number;
        restoredOtherFraction: number;
        globalZeroLagBestRate: number | null;
        globalAbsoluteLagP90: number | null;
    }>;
};

const args = process.argv.slice(2);
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runDir = resolve(valueFor("--run-dir") ?? "");
if (!runDir || !existsSync(join(runDir, "run-summary.json"))) {
    throw new Error("--run-dir must contain run-summary.json");
}
const outputDir = resolve(valueFor("--output-dir") ?? join(runDir, "analysis"));
const legacyDir = resolve(valueFor("--legacy-dir") ?? (
    "D:/软件测试/co612-all-series-bootstrap-results/"
    + "task2-final-truth-assisted-v2-2026-08-06/truth-assisted"
));
mkdirSync(outputDir, { recursive: true });

const readJsonLines = <T>(path: string): T[] => {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
};

const summary = JSON.parse(
    readFileSync(join(runDir, "run-summary.json"), "utf8"),
) as RunSummary;
const observations = readJsonLines<EventObservation>(join(runDir, "observations.jsonl"));
const applications = readJsonLines<ApplicationRow>(join(runDir, "applications.jsonl"));
const legacyObservations = readJsonLines<LegacyObservation>(
    join(legacyDir, "observations.jsonl"),
);
const inputBytes = readFileSync(summary.inputPath);
const sourceSha256After = createHash("sha256").update(inputBytes).digest("hex");
if (sourceSha256After !== summary.sourceSha256) {
    throw new Error(`source SHA-256 changed: ${summary.sourceSha256} -> ${sourceSha256After}`);
}

const parsed = parseRwl(inputBytes.toString("utf8"));
const observationsByEvent = new Map<string, EventObservation[]>();
observations.forEach((observation) => {
    const group = observationsByEvent.get(observation.eventId) ?? [];
    group.push(observation);
    observationsByEvent.set(observation.eventId, group);
});
observationsByEvent.forEach((group) => group.sort((left, right) => left.round - right.round));
const applicationsByEvent = new Map(applications.map((row) => [row.eventId, row]));
const legacyByEvent = new Map(legacyObservations.map((row) => [
    `${row.seriesId}:${row.truthYear}`,
    row,
]));
const unidentifiableYears = new Set(summary.absoluteUnidentifiableYears);

const classifyRefusal = (
    observation: EventObservation | null,
    absoluteIdentifiable: boolean,
): string => {
    if (!absoluteIdentifiable) return "absolute_unidentifiable";
    if (!observation) return "not_reached";
    if (observation.strict.response) return "answered";
    const reason = observation.reviewDecisionReason;
    if (reason === "cofecha_target_unflagged") return "cofecha_target_unflagged";
    if (reason === "insufficient_reference_support") return "insufficient_reference_depth";
    if (reason === "lag_direction_conflict") return "operation_direction_conflict";
    if (reason === "operation_type_conflict") return "operation_type_conflict";
    if (reason === "competing_remote_modes") return "competing_remote_modes";
    if (reason === "endpoint_context_insufficient") return "endpoint_context_insufficient";
    if (reason === "no_unit_hypothesis") {
        return observation.candidateCount === 0
            ? "no_internal_candidate"
            : "other_event_or_reference_competition";
    }
    if (reason === "window_width_unsafe") return "window_width_unsafe";
    if (observation.strictReason === "no_internal_hypothesis") {
        return "no_internal_candidate";
    }
    return observation.strictReason || "unknown";
};

const rows: CaseRow[] = [];
parsed.forEach((series, seriesId) => {
    const entries = Array.from(series.valuesByYear);
    const years = entries.map(([year]) => year).sort((left, right) => left - right);
    const truthYears = entries
        .filter(([, value]) => value === 0)
        .map(([year]) => year)
        .sort((left, right) => right - left);
    const seriesStartYear = years[0];
    const seriesEndYear = years[years.length - 1];
    truthYears.forEach((truthYear) => {
        const eventId = `${seriesId}:${truthYear}`;
        const eventObservations = observationsByEvent.get(eventId) ?? [];
        const first = eventObservations[0] ?? null;
        const last = eventObservations[eventObservations.length - 1] ?? null;
        const firstReviewResponseObservation = eventObservations.find((row) => (
            row.review.response
        )) ?? null;
        const firstCorrectObservation = eventObservations.find((row) => (
            row.review.windowCovered
        )) ?? null;
        const firstCorrectAttempt = firstCorrectObservation
            ? eventObservations.indexOf(firstCorrectObservation) + 1
            : null;
        const spacing = truthYears
            .filter((year) => year !== truthYear)
            .map((year) => Math.abs(year - truthYear));
        const legacy = legacyByEvent.get(eventId) ?? null;
        rows.push({
            eventId,
            seriesId,
            truthYear,
            absoluteIdentifiable: !unidentifiableYears.has(truthYear),
            seriesLength: seriesEndYear - seriesStartYear + 1,
            seriesStartYear,
            seriesEndYear,
            originalMissingCount: truthYears.length,
            minimumMissingSpacing: spacing.length > 0 ? Math.min(...spacing) : null,
            olderEndpointDistance: truthYear - seriesStartYear,
            newerEndpointDistance: seriesEndYear - truthYear,
            firstObservationRound: first?.round ?? null,
            observationCount: eventObservations.length,
            firstCofechaFlagged: first?.cofechaFlagged ?? null,
            firstReferenceDepth: first?.medianReferenceDepth ?? null,
            lastReferenceDepth: last?.medianReferenceDepth ?? null,
            firstReferenceSources: first?.referenceSourceCount ?? null,
            lastReferenceSources: last?.referenceSourceCount ?? null,
            firstGlobalZeroLagBestRate: first?.globalZeroLagBestRate
                ?? summary.relativeAlignment.initial?.zeroLagBestRate
                ?? null,
            lastGlobalZeroLagBestRate: last?.globalZeroLagBestRate
                ?? summary.relativeAlignment.final?.zeroLagBestRate
                ?? null,
            firstGlobalAbsoluteLagP90: first?.globalAbsoluteLagP90
                ?? summary.relativeAlignment.initial?.p90AbsoluteBestLag
                ?? null,
            lastGlobalAbsoluteLagP90: last?.globalAbsoluteLagP90
                ?? summary.relativeAlignment.final?.p90AbsoluteBestLag
                ?? null,
            initialStrictRefusalReason: classifyRefusal(
                first,
                !unidentifiableYears.has(truthYear),
            ),
            firstStrict: first?.strict ?? null,
            firstReview: first?.review ?? null,
            firstReviewResponse: firstReviewResponseObservation?.review ?? null,
            firstReviewResponseRound: firstReviewResponseObservation?.round ?? null,
            firstCorrectReview: firstCorrectObservation?.review ?? null,
            firstCorrectReviewRound: firstCorrectObservation?.round ?? null,
            firstCorrectReviewAttempt: firstCorrectAttempt,
            firstCorrectRestoredOtherEvents:
                firstCorrectObservation?.restoredOtherEvents ?? null,
            firstCorrectRestoredOtherFraction:
                firstCorrectObservation?.restoredOtherFraction ?? null,
            cumulativeStrictRefusals: firstReviewResponseObservation
                ? eventObservations.slice(
                    0,
                    eventObservations.indexOf(firstReviewResponseObservation),
                ).filter((row) => !row.strict.response).length
                : eventObservations.filter((row) => !row.strict.response).length,
            applicationRound: applicationsByEvent.get(eventId)?.round ?? null,
            recovered: applicationsByEvent.has(eventId),
            legacyObserved: legacy !== null,
            legacyResponse: legacy?.response === true,
            legacyRefusal: legacy?.response !== true,
            statePath: eventObservations.map((row) => ({
                round: row.round,
                strictStatus: row.strict.response ? "response" : "refused",
                reviewStatus: row.reviewDecisionStatus,
                strictReason: row.strictReason,
                reviewReason: row.reviewDecisionReason,
                strictOperation: row.strict.eventType,
                reviewOperation: row.review.eventType,
                strictWindowCovered: row.strict.windowCovered,
                reviewWindowCovered: row.review.windowCovered,
                reviewTopYear: row.review.topYear,
                reviewWindowStart: row.review.windowStart,
                reviewWindowEnd: row.review.windowEnd,
                score: row.review.score,
                margin: row.review.scoreMargin,
                referenceDepth: row.medianReferenceDepth,
                referenceSources: row.referenceSourceCount,
                cofechaFlagged: row.cofechaFlagged,
                restoredOtherEvents: row.restoredOtherEvents,
                restoredOtherFraction: row.restoredOtherFraction,
                globalZeroLagBestRate: row.globalZeroLagBestRate ?? null,
                globalAbsoluteLagP90: row.globalAbsoluteLagP90 ?? null,
            })),
        });
    });
});
rows.sort((left, right) => (
    left.seriesId.localeCompare(right.seriesId) || right.truthYear - left.truthYear
));

const quantile = (values: number[], probability: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)];
};
const ratio = (numerator: number, denominator: number): number => (
    numerator / Math.max(1, denominator)
);

const summarizeOutcomes = (
    cases: CaseRow[],
    select: (row: CaseRow) => EventOutcome | null,
) => {
    const eligible = cases.filter((row) => row.absoluteIdentifiable);
    const outcomes = eligible.map(select);
    const responses = outcomes.filter((outcome): outcome is EventOutcome => (
        outcome?.response === true
    ));
    const operationCorrect = responses.filter((outcome) => outcome.operationCorrect);
    const covered = operationCorrect.filter((outcome) => outcome.windowCovered);
    const top1 = operationCorrect.filter((outcome) => outcome.top1Exact);
    const widths = responses.flatMap((outcome) => (
        outcome.windowWidth === null ? [] : [outcome.windowWidth]
    ));
    const partialMoves = responses.filter((outcome) => outcome.eventType === "partialMove");
    const invalidWidths = widths.filter((width) => ![5, 7, 9, 13].includes(width));
    return {
        cases: eligible.length,
        responseCount: responses.length,
        responseRate: ratio(responses.length, eligible.length),
        refusalCount: eligible.length - responses.length,
        refusalRate: ratio(eligible.length - responses.length, eligible.length),
        operationCorrectCount: operationCorrect.length,
        operationAccuracy: ratio(operationCorrect.length, responses.length),
        coveredCount: covered.length,
        primaryWindowCoverage: ratio(covered.length, eligible.length),
        conditionalWindowCoverage: ratio(covered.length, operationCorrect.length),
        top1Count: top1.length,
        top1Rate: ratio(top1.length, eligible.length),
        partialMoveMisclassificationCount: partialMoves.length,
        partialMoveMisclassificationRate: ratio(partialMoves.length, eligible.length),
        medianWindowWidth: quantile(widths, 0.5),
        p90WindowWidth: quantile(widths, 0.9),
        invalidWindowWidthCount: invalidWidths.length,
    };
};

const armStrictInitial = summarizeOutcomes(rows, (row) => row.firstStrict);
const armReviewInitial = summarizeOutcomes(rows, (row) => row.firstReview);
const armReviewRetryFirstResponse = summarizeOutcomes(
    rows,
    (row) => row.firstReviewResponse,
);
const eventualCorrectCount = rows.filter((row) => (
    row.absoluteIdentifiable && row.firstCorrectReview !== null
)).length;

const directStrictRefusals = rows.filter((row) => (
    row.absoluteIdentifiable && row.firstStrict !== null && !row.firstStrict.response
));
const directRefusalReidentified = directStrictRefusals.filter((row) => (
    row.firstReviewResponse !== null
));
const directRefusalFirstResponses = directRefusalReidentified.flatMap((row) => (
    row.firstReviewResponse ? [row.firstReviewResponse] : []
));
const directRefusalCorrectOperations = directRefusalFirstResponses.filter((outcome) => (
    outcome.operationCorrect
));
const directRefusalCovered = directRefusalCorrectOperations.filter((outcome) => (
    outcome.windowCovered
));
const directRefusalSameRound = directStrictRefusals.filter((row) => (
    row.firstReview?.response === true
));
const directRefusalLater = directStrictRefusals.filter((row) => (
    row.firstReview?.response !== true && row.firstReviewResponse !== null
));

const legacyRefusals = rows.filter((row) => (
    row.absoluteIdentifiable && row.legacyRefusal
));
const legacyRefusalResolution = legacyRefusals.map((row) => {
    const firstPath = row.statePath[0] ?? null;
    const firstCorrectPath = row.statePath.find((state) => state.reviewWindowCovered) ?? null;
    let resolution = "persistent";
    if (!row.absoluteIdentifiable) {
        resolution = "absolute_unidentifiable";
    } else if (row.firstStrict && !row.firstStrict.response && row.firstReview?.windowCovered) {
        resolution = "lower_display_gate_same_state";
    } else if (firstCorrectPath) {
        resolution = firstCorrectPath.restoredOtherEvents > 0
            ? "after_other_events_recovered"
            : "new_protocol_immediate";
    }
    return {
        eventId: row.eventId,
        seriesId: row.seriesId,
        truthYear: row.truthYear,
        legacyObserved: row.legacyObserved,
        legacyDirectRefusal: row.legacyObserved && !row.legacyResponse,
        legacyNotReached: !row.legacyObserved,
        resolution,
        firstNewRound: row.firstObservationRound,
        firstNewStrictResponse: row.firstStrict?.response ?? false,
        firstNewReviewResponse: row.firstReview?.response ?? false,
        firstCorrectRound: row.firstCorrectReviewRound,
        restoredOtherEventsAtFirstCorrect: row.firstCorrectRestoredOtherEvents,
        firstReason: row.initialStrictRefusalReason,
        initialScore: firstPath?.score ?? null,
        initialMargin: firstPath?.margin ?? null,
        initialReferenceDepth: firstPath?.referenceDepth ?? null,
        initialCofechaFlagged: firstPath?.cofechaFlagged ?? null,
    };
});

const maxRound = Math.max(
    0,
    ...observations.map((row) => row.round),
    ...applications.map((row) => row.round),
);
const identifiableCount = rows.filter((row) => row.absoluteIdentifiable).length;
const responseCurve = [0, 0.25, 0.5, 0.75, 1].map((requestedFraction) => {
    const requiredRecoveries = Math.ceil(identifiableCount * requestedFraction);
    const checkpointApplication = requestedFraction === 0
        ? null
        : applications.find((row) => row.recoveredAfter >= requiredRecoveries) ?? null;
    const available = requestedFraction === 0 || checkpointApplication !== null;
    const round = requestedFraction === 0
        ? Math.min(...observations.map((row) => row.round))
        : checkpointApplication?.round ?? maxRound;
    const recoveredByRound = applications.filter((row) => row.round <= round).length;
    const selectedOutcome = (row: CaseRow): EventOutcome | null => {
        const application = applicationsByEvent.get(row.eventId);
        if (application && application.round <= round) {
            return {
                response: true,
                eventType: "missingRing",
                operationCorrect: true,
                windowCovered: true,
                top1Exact: false,
                topYear: row.truthYear,
                windowStart: row.truthYear,
                windowEnd: row.truthYear,
                windowWidth: null,
                confidence: "confirmed",
                score: null,
                scoreMargin: null,
                reviewOnly: false,
            };
        }
        const eventObservations = observationsByEvent.get(row.eventId) ?? [];
        return [...eventObservations].reverse().find((item) => item.round <= round)?.review
            ?? null;
    };
    return {
        requestedRecoveredFraction: requestedFraction,
        available,
        round,
        recoveredEvents: recoveredByRound,
        achievedRecoveredFraction: ratio(recoveredByRound, identifiableCount),
        snapshot: summarizeOutcomes(rows, selectedOutcome),
    };
});

const bucket = (value: number, cuts: number[], labels: string[]): string => {
    const index = cuts.findIndex((cut) => value < cut);
    return labels[index < 0 ? labels.length - 1 : index];
};
const groupSummary = (groupRows: CaseRow[]) => ({
    ...summarizeOutcomes(groupRows, (row) => row.firstReviewResponse),
    eventualCorrectWindowCount: groupRows.filter((row) => (
        row.absoluteIdentifiable && row.firstCorrectReview !== null
    )).length,
    eventualCorrectWindowCoverage: ratio(
        groupRows.filter((row) => (
            row.absoluteIdentifiable && row.firstCorrectReview !== null
        )).length,
        groupRows.filter((row) => row.absoluteIdentifiable).length,
    ),
    persistentRefusalCount: groupRows.filter((row) => (
        row.absoluteIdentifiable && row.firstReviewResponse === null
    )).length,
});
const stratify = (
    label: string,
    key: (row: CaseRow) => string,
) => {
    const groups = new Map<string, CaseRow[]>();
    rows.forEach((row) => {
        const value = key(row);
        const group = groups.get(value) ?? [];
        group.push(row);
        groups.set(value, group);
    });
    return {
        dimension: label,
        groups: Array.from(groups, ([value, groupRows]) => ({
            value,
            ...groupSummary(groupRows),
        })).sort((left, right) => left.value.localeCompare(right.value)),
    };
};

const strata = [
    stratify("seriesId", (row) => row.seriesId),
    stratify("seriesLength", (row) => bucket(
        row.seriesLength,
        [200, 300, 400],
        ["<200", "200-299", "300-399", ">=400"],
    )),
    stratify("referenceDepth", (row) => row.firstReferenceDepth === null
        ? "not_reached"
        : bucket(
            row.firstReferenceDepth,
            [10, 20, 30],
            ["<10", "10-19", "20-29", ">=30"],
        )),
    stratify("originalMissingCount", (row) => bucket(
        row.originalMissingCount,
        [2, 5, 10],
        ["1", "2-4", "5-9", ">=10"],
    )),
    stratify("minimumMissingSpacing", (row) => row.minimumMissingSpacing === null
        ? "single"
        : bucket(
            row.minimumMissingSpacing,
            [6, 11, 26],
            ["<=5", "6-10", "11-25", ">=26"],
        )),
    stratify("olderEndpointDistance", (row) => bucket(
        row.olderEndpointDistance,
        [15, 30],
        ["0-14", "15-29", ">=30"],
    )),
    stratify("newerEndpointDistance", (row) => bucket(
        row.newerEndpointDistance,
        [15, 30],
        ["0-14", "15-29", ">=30"],
    )),
    stratify("firstCofechaFlagged", (row) => row.firstCofechaFlagged === null
        ? "not_reached"
        : String(row.firstCofechaFlagged)),
    stratify("initialRefusalReason", (row) => row.initialStrictRefusalReason),
    stratify("referenceConsistencyBefore", (row) => {
        const value = row.firstGlobalZeroLagBestRate;
        if (value === null) return "not_reached";
        return bucket(value, [0.4, 0.6, 0.8], ["<0.4", "0.4-0.59", "0.6-0.79", ">=0.8"]);
    }),
    stratify("referenceConsistencyChange", (row) => {
        if (row.firstGlobalZeroLagBestRate === null
            || row.lastGlobalZeroLagBestRate === null) return "not_reached";
        const change = row.lastGlobalZeroLagBestRate - row.firstGlobalZeroLagBestRate;
        return change > 0.02 ? "improved" : change < -0.02 ? "worsened" : "stable";
    }),
];

const firstCorrectAttempts = rows.flatMap((row) => (
    row.absoluteIdentifiable && row.firstCorrectReviewAttempt !== null
        ? [row.firstCorrectReviewAttempt]
        : []
));
const firstCorrectElapsedRounds = rows.flatMap((row) => (
    row.absoluteIdentifiable
    && row.firstCorrectReviewRound !== null
    && row.firstObservationRound !== null
        ? [row.firstCorrectReviewRound - row.firstObservationRound + 1]
        : []
));
const resolutionCounts = legacyRefusalResolution.reduce<Record<string, number>>(
    (counts, row) => ({
        ...counts,
        [row.resolution]: (counts[row.resolution] ?? 0) + 1,
    }),
    {},
);

const analysisSummary = {
    source: {
        inputPath: summary.inputPath,
        sourceSha256: summary.sourceSha256,
        sourceSha256After,
        sourceUnchanged: sourceSha256After === summary.sourceSha256,
        initialZeroCount: summary.initialZeroCount,
        totalTruthEvents: rows.length,
        absoluteIdentifiableEvents: identifiableCount,
        absoluteUnidentifiableEvents: rows.length - identifiableCount,
        absoluteUnidentifiableYears: summary.absoluteUnidentifiableYears,
    },
    run: {
        runDir,
        stopReason: summary.stopReason,
        rounds: maxRound,
        recoveredEvents: summary.recoveredEvents,
        remainingEvents: summary.remainingEvents,
    },
    controls: {
        strictGateFirstDiagnosis: armStrictInitial,
        lowerDisplayGateFirstDiagnosis: armReviewInitial,
        lowerDisplayGateWithRetryFirstResponse: armReviewRetryFirstResponse,
        lowerDisplayGateWithRetryEventualCorrectWindowCoverage:
            ratio(eventualCorrectCount, identifiableCount),
        isolatedDirectStrictRefusals: {
            cases: directStrictRefusals.length,
            sameRoundDisplayRecoveryCount: directRefusalSameRound.length,
            laterRetryRecoveryCount: directRefusalLater.length,
            persistentRefusalCount:
                directStrictRefusals.length - directRefusalReidentified.length,
            reidentificationRate: ratio(
                directRefusalReidentified.length,
                directStrictRefusals.length,
            ),
            reidentifiedOperationAccuracy: ratio(
                directRefusalCorrectOperations.length,
                directRefusalFirstResponses.length,
            ),
            reidentifiedWindowCoverage: ratio(
                directRefusalCovered.length,
                directRefusalCorrectOperations.length,
            ),
        },
    },
    retry: {
        firstDiagnosisReachedCount: rows.filter((row) => (
            row.absoluteIdentifiable && row.firstObservationRound !== null
        )).length,
        firstRoundActiveCases: observations.filter((row) => row.round === 1).length,
        firstRoundStrictResponseRate: ratio(
            observations.filter((row) => row.round === 1 && row.strict.response).length,
            observations.filter((row) => row.round === 1 && row.absoluteIdentifiable).length,
        ),
        firstRoundReviewResponseRate: ratio(
            observations.filter((row) => row.round === 1 && row.review.response).length,
            observations.filter((row) => row.round === 1 && row.absoluteIdentifiable).length,
        ),
        everReviewResponseCount: rows.filter((row) => (
            row.absoluteIdentifiable && row.firstReviewResponse !== null
        )).length,
        everReviewResponseRate: armReviewRetryFirstResponse.responseRate,
        initialDirectStrictRefusalCount: directStrictRefusals.length,
        initialNotReachedCount: rows.filter((row) => (
            row.absoluteIdentifiable && row.firstObservationRound === null
        )).length,
        finalPersistentRefusalCount: rows.filter((row) => (
            row.absoluteIdentifiable && row.firstReviewResponse === null
        )).length,
        finalPersistentRefusalRate: ratio(
            rows.filter((row) => (
                row.absoluteIdentifiable && row.firstReviewResponse === null
            )).length,
            identifiableCount,
        ),
        firstCorrectWindowAttemptMedian: quantile(firstCorrectAttempts, 0.5),
        firstCorrectWindowAttemptP90: quantile(firstCorrectAttempts, 0.9),
        firstCorrectWindowElapsedRoundsMedian: quantile(firstCorrectElapsedRounds, 0.5),
        firstCorrectWindowElapsedRoundsP90: quantile(firstCorrectElapsedRounds, 0.9),
    },
    legacyBaselineRefusals: {
        denominator: rows.length,
        refusalCount: legacyRefusals.length,
        refusalRate: ratio(legacyRefusals.length, rows.length),
        directlyDiagnosedButRefusedCount: legacyRefusals.filter((row) => (
            row.legacyObserved
        )).length,
        notReachedCount: legacyRefusals.filter((row) => !row.legacyObserved).length,
        resolutionCounts,
    },
    cleanOriginalFalsePositives: summary.cleanOriginal,
    relativeAlignment: summary.relativeAlignment,
    responseCurve,
};

const csvValue = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const writeCsv = (path: string, records: Array<Record<string, unknown>>) => {
    const columns = Array.from(new Set(records.flatMap((record) => Object.keys(record))));
    const lines = [
        columns.map(csvValue).join(","),
        ...records.map((record) => columns.map((column) => (
            csvValue(record[column])
        )).join(",")),
    ];
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
};

const flatCases = rows.map(({ statePath, firstStrict, firstReview, ...row }) => ({
    ...row,
    firstStrictResponse: firstStrict?.response ?? false,
    firstStrictOperation: firstStrict?.eventType ?? null,
    firstStrictWindowCovered: firstStrict?.windowCovered ?? false,
    firstStrictTop1Exact: firstStrict?.top1Exact ?? false,
    firstReviewResponseAtFirstDiagnosis: firstReview?.response ?? false,
    firstReviewOperation: firstReview?.eventType ?? null,
    firstReviewWindowCovered: firstReview?.windowCovered ?? false,
    firstReviewTop1Exact: firstReview?.top1Exact ?? false,
    statePath: statePath.map((state) => (
        `r${state.round}:${state.strictStatus}/${state.reviewStatus}`
        + `:${state.reviewOperation ?? "none"}`
        + `:${state.reviewWindowStart ?? "-"}-${state.reviewWindowEnd ?? "-"}`
        + `:${state.reviewWindowCovered ? "hit" : "miss"}`
    )).join(";"),
}));

writeFileSync(join(outputDir, "summary.json"), JSON.stringify(analysisSummary, null, 2));
writeFileSync(join(outputDir, "cases.json"), JSON.stringify(rows, null, 2));
writeCsv(join(outputDir, "cases.csv"), flatCases);
writeFileSync(join(outputDir, "strata.json"), JSON.stringify(strata, null, 2));
writeFileSync(
    join(outputDir, "original-refusal-resolution.json"),
    JSON.stringify(legacyRefusalResolution, null, 2),
);
writeCsv(join(outputDir, "original-refusal-resolution.csv"), legacyRefusalResolution);
writeFileSync(join(outputDir, "response-curve.json"), JSON.stringify(responseCurve, null, 2));
writeCsv(join(outputDir, "response-curve.csv"), responseCurve.map((row) => ({
    ...row,
    snapshot: JSON.stringify(row.snapshot),
})));

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
const report = `# co612 全部自然 0 同时删除：复核窗口与自举重诊断

## 数据隔离

- 输入：\`${summary.inputPath}\`
- SHA-256（前/后）：\`${summary.sourceSha256}\` / \`${sourceSha256After}\`
- 源文件未修改：${sourceSha256After === summary.sourceSha256 ? "是" : "否"}
- 初始诊断副本中的 0：${summary.initialZeroCount}
- 隐藏真值事件：${rows.length}；绝对可辨识：${identifiableCount}；absolute-unidentifiable：${rows.length - identifiableCount}
- 运行停止原因：\`${summary.stopReason}\`；恢复 ${summary.recoveredEvents}/${rows.length}

## 四组对照

| 方案 | 响应率 | 操作准确率 | 主窗口覆盖率 | 条件覆盖率 | Top1 | partialMove 误判 | 中位宽度 | P90 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 当前严格门槛，首次诊断 | ${percent(armStrictInitial.responseRate)} | ${percent(armStrictInitial.operationAccuracy)} | ${percent(armStrictInitial.primaryWindowCoverage)} | ${percent(armStrictInitial.conditionalWindowCoverage)} | ${percent(armStrictInitial.top1Rate)} | ${percent(armStrictInitial.partialMoveMisclassificationRate)} | ${armStrictInitial.medianWindowWidth ?? "-"} | ${armStrictInitial.p90WindowWidth ?? "-"} |
| 降低复核显示门槛，首次诊断 | ${percent(armReviewInitial.responseRate)} | ${percent(armReviewInitial.operationAccuracy)} | ${percent(armReviewInitial.primaryWindowCoverage)} | ${percent(armReviewInitial.conditionalWindowCoverage)} | ${percent(armReviewInitial.top1Rate)} | ${percent(armReviewInitial.partialMoveMisclassificationRate)} | ${armReviewInitial.medianWindowWidth ?? "-"} | ${armReviewInitial.p90WindowWidth ?? "-"} |
| 降低显示门槛并逐轮重试，首次出现的窗口 | ${percent(armReviewRetryFirstResponse.responseRate)} | ${percent(armReviewRetryFirstResponse.operationAccuracy)} | ${percent(armReviewRetryFirstResponse.primaryWindowCoverage)} | ${percent(armReviewRetryFirstResponse.conditionalWindowCoverage)} | ${percent(armReviewRetryFirstResponse.top1Rate)} | ${percent(armReviewRetryFirstResponse.partialMoveMisclassificationRate)} | ${armReviewRetryFirstResponse.medianWindowWidth ?? "-"} | ${armReviewRetryFirstResponse.p90WindowWidth ?? "-"} |

逐轮重试期间至少一次出现正确主窗口：${eventualCorrectCount}/${identifiableCount}（${percent(ratio(eventualCorrectCount, identifiableCount))}）。

## 拒答恢复

- 首次实际诊断的直接严格拒答：${directStrictRefusals.length}
- 同轮由低显示门槛恢复：${directRefusalSameRound.length}
- 等待其他事件恢复后首次出现窗口：${directRefusalLater.length}
- 最终持续拒答：${analysisSummary.retry.finalPersistentRefusalCount}
- 首次正确窗口所需诊断次数：中位 ${analysisSummary.retry.firstCorrectWindowAttemptMedian ?? "-"}，P90 ${analysisSummary.retry.firstCorrectWindowAttemptP90 ?? "-"}

旧基线的 ${legacyRefusals.length} 个“拒答”中，实际直接诊断后无响应 ${analysisSummary.legacyBaselineRefusals.directlyDiagnosedButRefusedCount} 个，因前序阻塞而从未到达 ${analysisSummary.legacyBaselineRefusals.notReachedCount} 个。解析结果：\`${JSON.stringify(resolutionCounts)}\`。

## 安全指标

- 原始已定年文件严格建议率：${percent(summary.cleanOriginal.strictFalsePositiveRate)}
- 原始已定年文件复核窗口建议率：${percent(summary.cleanOriginal.reviewFalsePositiveRate)}
- 非法窗口宽度：${armReviewRetryFirstResponse.invalidWindowWidthCount}
- 初始/最终样芯间零 lag 比例：${percent(summary.relativeAlignment.initial.zeroLagBestRate)} / ${percent(summary.relativeAlignment.final.zeroLagBestRate)}
- 初始/最终绝对 lag P90：${summary.relativeAlignment.initial.p90AbsoluteBestLag} / ${summary.relativeAlignment.final.p90AbsoluteBestLag}

逐案结果见 \`cases.csv\` / \`cases.json\`，旧拒答映射见 \`original-refusal-resolution.csv\`，分层结果见 \`strata.json\`，响应曲线见 \`response-curve.csv\`。
`;
writeFileSync(join(outputDir, "report.md"), report, "utf8");

console.log(`CO612_REVIEW_ANALYSIS ${JSON.stringify({
    outputDir,
    controls: analysisSummary.controls,
    retry: analysisSummary.retry,
    legacyBaselineRefusals: analysisSummary.legacyBaselineRefusals,
})}`);
