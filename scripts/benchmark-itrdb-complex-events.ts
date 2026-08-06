import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findAbsoluteUnidentifiableTruthYears } from "@/features/crossdating/diagnosis/bootstrapEvaluation";
import { planDiagnosisEventEdit } from "@/features/crossdating/diagnosis/eventApply";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis/types";
import {
    ITRDB_VALIDATION_PROTOCOL,
    itrdbDatasetGroup,
    itrdbEndpointStratum,
    itrdbEventSpacingStratum,
    itrdbReferenceDepthStratum,
    itrdbSeriesLengthStratum,
    type ItrdbValidationSplit,
} from "@/features/crossdating/diagnosis/__tests__/itrdbValidationProtocol";
import {
    diagnoseTargetEvents,
} from "@/features/crossdating/diagnosis/__tests__/targetDiagnosis";
import {
    applyInsertRestore,
    buildMultiMissingCorrupted,
    createEndAnchoredFalseRingCase,
    createEndAnchoredMissingRingCase,
    parseRwl,
    sameSeries,
    type RwlSeries,
} from "@/features/crossdating/diagnosis/__tests__/rdmFixture";
import {
    deleteYearWithMode,
    getSeriesMoveConflicts,
    insertMissingYearAtSide,
    moveSeriesTailByOffset,
} from "@/features/rwl/edit";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";

type TargetDescriptor = {
    target: string;
    seriesLength: number;
    startYear: number;
    endYear: number;
    referenceCount: number;
};

type NaturalSingleCase = TargetDescriptor & {
    caseId: string;
    kind: "naturalSingle";
    file: string;
    truthYears: [number];
};

type SingleInjectedCase = TargetDescriptor & {
    caseId: string;
    kind: "singleInjected";
    file: string;
    truthYears: [number];
    falseRingMode: "average" | "moderate" | "splitLike";
};

type MultiCase = TargetDescriptor & {
    caseId: string;
    kind: "separatedMulti" | "adjacentMulti";
    file: string;
    truthYears: number[];
};

type CrossSeriesCase = {
    caseId: string;
    kind: "crossSeries";
    file: string;
    targets: Array<TargetDescriptor & { truthYears: [number] }>;
};

type NaturalBootstrapCase = {
    caseId: string;
    kind: "naturalBootstrap";
    file: string;
    targets: Array<TargetDescriptor & {
        truthYears: number[];
        scoredTruthYears: number[];
    }>;
};

type ManifestCase = SingleInjectedCase
    | NaturalSingleCase
    | MultiCase
    | CrossSeriesCase
    | NaturalBootstrapCase;

type ValidationManifest = {
    schemaVersion: number;
    protocol: typeof ITRDB_VALIDATION_PROTOCOL;
    datasetRoot: string;
    fileSha256: Record<string, string>;
    splits: Record<ItrdbValidationSplit, { cases: ManifestCase[] }>;
};

type EventRow = {
    split: ItrdbValidationSplit;
    caseId: string;
    scenario: ManifestCase["kind"];
    mode: "direct" | "truth-assisted-bootstrap" | "automatic-bootstrap";
    file: string;
    datasetGroup: string;
    target: string;
    step: number;
    truthEventType: "missingRing" | "falseRing";
    truthYear: number;
    absoluteIdentifiable: boolean;
    missingCount: number;
    eventSpacing: string;
    seriesLength: number;
    seriesLengthStratum: string;
    referenceCount: number;
    referenceDepthStratum: string;
    olderContextYears: number;
    newerContextYears: number;
    endpointStratum: string;
    baselineFlagged: boolean | null;
    elapsedMs: number;
    response: boolean;
    refusal: boolean;
    primaryType: DiagnosisEvent["eventType"] | null;
    primaryShiftYears: number | null;
    operationCorrect: boolean;
    windowCovered: boolean;
    top1Exact: boolean;
    partialMoveMisclassification: boolean;
    topYear: number | null;
    windowStart: number | null;
    windowEnd: number | null;
    windowWidth: number | null;
    error: string | null;
};

type CleanRow = {
    split: ItrdbValidationSplit;
    caseId: string;
    file: string;
    datasetGroup: string;
    target: string;
    seriesLengthStratum: string;
    referenceDepthStratum: string;
    falsePositive: boolean;
    predictionCount: number;
    primaryType: DiagnosisEvent["eventType"] | null;
    elapsedMs: number;
    error: string | null;
};

type BootstrapRun = {
    split: ItrdbValidationSplit;
    caseId: string;
    file: string;
    mode: "truth-assisted-bootstrap" | "automatic-bootstrap";
    totalTruths: number;
    scoredTruths: number;
    absoluteUnidentifiableTruths: number;
    iterations: number;
    wrongApplications: number;
    applied: number;
    remainingTruths: number;
    recoveredSeries: number;
    totalTargetSeries: number;
    complete: boolean;
    stopReason: string;
};

type WorkerOutput = {
    rows: EventRow[];
    cleanRows: CleanRow[];
    bootstrapRuns: BootstrapRun[];
    errors: Array<{ caseId: string; error: string }>;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const viteNodePath = join(repoRoot, "node_modules", "vite-node", "vite-node.mjs");
const args = process.argv.slice(2);
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const manifestPath = resolve(
    valueFor("--manifest")
        ?? `${repoRoot}/docs/benchmarks/itrdb-validation-v1-manifest.json`,
);
const splitRaw = valueFor("--split") ?? "development";
if (!["development", "calibration", "final"].includes(splitRaw)) {
    throw new Error(`invalid --split: ${splitRaw}`);
}
const split = splitRaw as ItrdbValidationSplit;
const outputRoot = resolve(
    valueFor("--output-dir") ?? "D:/软件测试/ITRDB-js-validation-results",
);
const runId = valueFor("--run-id") ?? `${split}-v1`;
const runDir = resolve(valueFor("--run-dir") ?? join(outputRoot, runId));
const requestedWorkers = Number(valueFor("--workers"));
const workers = Number.isInteger(requestedWorkers) && requestedWorkers > 0
    ? requestedWorkers
    : Math.max(1, Math.min(6, Math.floor(availableParallelism() / 2)));
const workerIndexRaw = valueFor("--worker-index");
const workerIndex = workerIndexRaw === null ? null : Number(workerIndexRaw);
const workerCount = Number(valueFor("--worker-count") ?? workers);
const requestedCaseLimit = Number(valueFor("--case-limit"));
const caseLimit = Number.isInteger(requestedCaseLimit) && requestedCaseLimit > 0
    ? requestedCaseLimit
    : Infinity;
const scenarioRaw = valueFor("--scenario");
const scenario = scenarioRaw === null ? null : scenarioRaw as ManifestCase["kind"];
if (scenario !== null && ![
    "singleInjected",
    "naturalSingle",
    "separatedMulti",
    "adjacentMulti",
    "crossSeries",
    "naturalBootstrap",
].includes(scenario)) throw new Error(`invalid --scenario: ${scenario}`);

if (!existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ValidationManifest;
if (manifest.protocol.protocolVersion !== ITRDB_VALIDATION_PROTOCOL.protocolVersion) {
    throw new Error(`protocol mismatch: ${manifest.protocol.protocolVersion}`);
}
mkdirSync(runDir, { recursive: true });

const cloneSite = (series: Map<string, RwlSeries>): RwlSiteData => new Map(
    Array.from(series, ([id, value]) => [id, new Map(value.valuesByYear)]),
);

const rangeFor = (data: RwlTreeData): { startYear: number; endYear: number } => {
    const years = Array.from(data.keys());
    return { startYear: Math.min(...years), endYear: Math.max(...years) };
};

const applyEvent = (
    site: RwlSiteData,
    event: DiagnosisEvent,
    selectedYear: number,
): { applied: boolean; error: string | null } => {
    const current = site.get(event.seriesId);
    if (!current) return { applied: false, error: "series_missing" };
    const range = rangeFor(current);
    const plan = planDiagnosisEventEdit(
        event,
        selectedYear,
        range.startYear,
        range.endYear,
    );
    if (!plan) return { applied: false, error: "event_not_executable" };
    if (plan.operationType === "INSERT_MISSING_RING") {
        site.set(event.seriesId, insertMissingYearAtSide(current, plan.targetYear, plan.side));
        return { applied: true, error: null };
    }
    if (plan.operationType === "DELETE_FALSE_RING") {
        site.set(
            event.seriesId,
            deleteYearWithMode(current, plan.targetYear, "direct", plan.shift),
        );
        return { applied: true, error: null };
    }
    const conflicts = getSeriesMoveConflicts(
        current,
        plan.startYear,
        plan.endYear,
        plan.shiftYears,
    );
    if (conflicts.length > 0) {
        return { applied: false, error: `move_conflict:${conflicts.join(",")}` };
    }
    site.set(event.seriesId, moveSeriesTailByOffset(
        current,
        plan.startYear,
        plan.endYear,
        plan.shiftYears,
    ));
    return { applied: true, error: null };
};

const diagnose = (site: RwlSiteData, target: string): {
    events: DiagnosisEvent[];
    elapsedMs: number;
    error: string | null;
} => {
    const started = performance.now();
    try {
        return {
            events: diagnoseTargetEvents(site, target),
            elapsedMs: Math.round(performance.now() - started),
            error: null,
        };
    } catch (error) {
        return {
            events: [],
            elapsedMs: Math.round(performance.now() - started),
            error: error instanceof Error ? error.message : String(error),
        };
    }
};

const makeRow = (options: {
    descriptor: TargetDescriptor;
    caseId: string;
    scenario: ManifestCase["kind"];
    mode: EventRow["mode"];
    file: string;
    step: number;
    truthEventType: EventRow["truthEventType"];
    truthYear: number;
    truthYears: number[];
    absoluteIdentifiable?: boolean;
    baselineFlagged?: boolean | null;
    diagnosis: ReturnType<typeof diagnose>;
}): EventRow => {
    const event = options.diagnosis.events[0] ?? null;
    const topYear = event?.rankedYears[0]?.year ?? null;
    const operationCorrect = event?.eventType === options.truthEventType;
    const windowCovered = Boolean(
        operationCorrect
        && event
        && options.truthYear >= event.startYear
        && options.truthYear <= event.endYear,
    );
    const olderContextYears = options.truthYear - options.descriptor.startYear;
    const newerContextYears = options.descriptor.endYear - options.truthYear;
    return {
        split,
        caseId: options.caseId,
        scenario: options.scenario,
        mode: options.mode,
        file: options.file,
        datasetGroup: itrdbDatasetGroup(options.file),
        target: options.descriptor.target,
        step: options.step,
        truthEventType: options.truthEventType,
        truthYear: options.truthYear,
        absoluteIdentifiable: options.absoluteIdentifiable ?? true,
        missingCount: options.truthYears.length,
        eventSpacing: itrdbEventSpacingStratum(options.truthYears),
        seriesLength: options.descriptor.seriesLength,
        seriesLengthStratum: itrdbSeriesLengthStratum(options.descriptor.seriesLength),
        referenceCount: options.descriptor.referenceCount,
        referenceDepthStratum: itrdbReferenceDepthStratum(options.descriptor.referenceCount),
        olderContextYears,
        newerContextYears,
        endpointStratum: itrdbEndpointStratum(olderContextYears, newerContextYears),
        baselineFlagged: options.baselineFlagged ?? null,
        elapsedMs: options.diagnosis.elapsedMs,
        response: event !== null,
        refusal: event === null,
        primaryType: event?.eventType ?? null,
        primaryShiftYears: event?.shiftYears ?? null,
        operationCorrect,
        windowCovered,
        top1Exact: operationCorrect && topYear === options.truthYear,
        partialMoveMisclassification: event?.eventType === "partialMove",
        topYear,
        windowStart: event?.startYear ?? null,
        windowEnd: event?.endYear ?? null,
        windowWidth: event ? event.endYear - event.startYear + 1 : null,
        error: options.diagnosis.error,
    };
};

const descriptorFor = (
    item: TargetDescriptor,
    parsed: Map<string, RwlSeries>,
): TargetDescriptor => {
    const current = parsed.get(item.target);
    if (!current) throw new Error(`target missing: ${item.target}`);
    return {
        ...item,
        startYear: current.startYear,
        endYear: current.endYear,
        seriesLength: current.length,
    };
};

const runSingleInjectedCase = (
    item: SingleInjectedCase,
    parsed: Map<string, RwlSeries>,
): { rows: EventRow[]; cleanRow: CleanRow } => {
    const target = parsed.get(item.target);
    if (!target) throw new Error(`target missing: ${item.target}`);
    const descriptor = descriptorFor(item, parsed);
    const truthYear = item.truthYears[0];
    const cleanResult = diagnose(cloneSite(parsed), item.target);
    const baselineFlagged = cleanResult.events.length > 0;
    const missingSite = cloneSite(parsed);
    missingSite.set(
        item.target,
        createEndAnchoredMissingRingCase(target, truthYear).corrupted,
    );
    const falseSite = cloneSite(parsed);
    falseSite.set(
        item.target,
        createEndAnchoredFalseRingCase(
            target,
            truthYear,
            item.falseRingMode,
        ).corrupted,
    );
    return {
        rows: [
            makeRow({
                descriptor,
                caseId: item.caseId,
                scenario: item.kind,
                mode: "direct",
                file: item.file,
                step: 1,
                truthEventType: "missingRing",
                truthYear,
                truthYears: item.truthYears,
                baselineFlagged,
                diagnosis: diagnose(missingSite, item.target),
            }),
            makeRow({
                descriptor,
                caseId: item.caseId,
                scenario: item.kind,
                mode: "direct",
                file: item.file,
                step: 1,
                truthEventType: "falseRing",
                truthYear,
                truthYears: item.truthYears,
                baselineFlagged,
                diagnosis: diagnose(falseSite, item.target),
            }),
        ],
        cleanRow: {
            split,
            caseId: item.caseId,
            file: item.file,
            datasetGroup: itrdbDatasetGroup(item.file),
            target: item.target,
            seriesLengthStratum: itrdbSeriesLengthStratum(descriptor.seriesLength),
            referenceDepthStratum: itrdbReferenceDepthStratum(descriptor.referenceCount),
            falsePositive: baselineFlagged,
            predictionCount: cleanResult.events.length,
            primaryType: cleanResult.events[0]?.eventType ?? null,
            elapsedMs: cleanResult.elapsedMs,
            error: cleanResult.error,
        },
    };
};

const runSimpleMissingCase = (
    item: NaturalSingleCase | MultiCase,
    parsed: Map<string, RwlSeries>,
): EventRow[] => {
    const target = parsed.get(item.target);
    if (!target) throw new Error(`target missing: ${item.target}`);
    const site = cloneSite(parsed);
    site.set(item.target, buildMultiMissingCorrupted(target.valuesByYear, item.truthYears));
    const descriptor = descriptorFor(item, parsed);
    const remaining = [...item.truthYears].sort((a, b) => a - b);
    const rows: EventRow[] = [];
    while (remaining.length > 0) {
        const truthYear = remaining[remaining.length - 1];
        const result = diagnose(site, item.target);
        rows.push(makeRow({
            descriptor,
            caseId: item.caseId,
            scenario: item.kind,
            mode: "direct",
            file: item.file,
            step: rows.length + 1,
            truthEventType: "missingRing",
            truthYear,
            truthYears: item.truthYears,
            diagnosis: result,
        }));
        site.set(item.target, applyInsertRestore(site.get(item.target)!, truthYear));
        remaining.pop();
    }
    return rows;
};

const runCrossSeriesCase = (
    item: CrossSeriesCase,
    parsed: Map<string, RwlSeries>,
): EventRow[] => {
    const site = cloneSite(parsed);
    item.targets.forEach((descriptor) => {
        const target = parsed.get(descriptor.target);
        if (!target) throw new Error(`target missing: ${descriptor.target}`);
        site.set(
            descriptor.target,
            buildMultiMissingCorrupted(target.valuesByYear, descriptor.truthYears),
        );
    });
    return item.targets.map((descriptor, index) => makeRow({
        descriptor: descriptorFor(descriptor, parsed),
        caseId: item.caseId,
        scenario: item.kind,
        mode: "direct",
        file: item.file,
        step: index + 1,
        truthEventType: "missingRing",
        truthYear: descriptor.truthYears[0],
        truthYears: descriptor.truthYears,
        diagnosis: diagnose(site, descriptor.target),
    }));
};

const buildBootstrapSite = (
    item: NaturalBootstrapCase,
    parsed: Map<string, RwlSeries>,
): RwlSiteData => {
    const site = cloneSite(parsed);
    item.targets.forEach((descriptor) => {
        const target = parsed.get(descriptor.target);
        if (!target) throw new Error(`target missing: ${descriptor.target}`);
        site.set(
            descriptor.target,
            buildMultiMissingCorrupted(target.valuesByYear, descriptor.truthYears),
        );
    });
    return site;
};

const runTruthAssistedBootstrap = (
    item: NaturalBootstrapCase,
    parsed: Map<string, RwlSeries>,
): { rows: EventRow[]; summary: BootstrapRun } => {
    const site = buildBootstrapSite(item, parsed);
    const truthBySeries = new Map(item.targets.map((target) => [
        target.target,
        target.truthYears,
    ]));
    const unidentifiable = findAbsoluteUnidentifiableTruthYears(
        cloneSite(parsed),
        truthBySeries,
    );
    const remaining = new Map(item.targets.map((target) => [
        target.target,
        [...target.truthYears].sort((a, b) => a - b),
    ]));
    const rows: EventRow[] = [];
    let iterations = 0;
    while (Array.from(remaining.values()).some((years) => years.length > 0)) {
        for (const targetPlan of item.targets) {
            const years = remaining.get(targetPlan.target)!;
            if (years.length === 0) continue;
            const truthYear = years[years.length - 1];
            iterations += 1;
            rows.push(makeRow({
                descriptor: descriptorFor(targetPlan, parsed),
                caseId: item.caseId,
                scenario: item.kind,
                mode: "truth-assisted-bootstrap",
                file: item.file,
                step: iterations,
                truthEventType: "missingRing",
                truthYear,
                truthYears: targetPlan.truthYears,
                absoluteIdentifiable: targetPlan.scoredTruthYears.includes(truthYear)
                    && !unidentifiable.has(truthYear),
                diagnosis: diagnose(site, targetPlan.target),
            }));
            site.set(
                targetPlan.target,
                applyInsertRestore(site.get(targetPlan.target)!, truthYear),
            );
            years.pop();
        }
    }
    const recoveredSeries = item.targets.filter((target) => sameSeries(
        site.get(target.target)!,
        parsed.get(target.target)!.valuesByYear,
    )).length;
    return {
        rows,
        summary: {
            split,
            caseId: item.caseId,
            file: item.file,
            mode: "truth-assisted-bootstrap",
            totalTruths: item.targets.reduce((sum, target) => sum + target.truthYears.length, 0),
            scoredTruths: item.targets.reduce(
                (sum, target) => sum + target.scoredTruthYears.length,
                0,
            ),
            absoluteUnidentifiableTruths: unidentifiable.size,
            iterations,
            wrongApplications: 0,
            applied: iterations,
            remainingTruths: 0,
            recoveredSeries,
            totalTargetSeries: item.targets.length,
            complete: recoveredSeries === item.targets.length,
            stopReason: "truths_exhausted",
        },
    };
};

const runAutomaticBootstrap = (
    item: NaturalBootstrapCase,
    parsed: Map<string, RwlSeries>,
): { rows: EventRow[]; summary: BootstrapRun } => {
    const site = buildBootstrapSite(item, parsed);
    const truthBySeries = new Map(item.targets.map((target) => [
        target.target,
        target.truthYears,
    ]));
    const unidentifiable = findAbsoluteUnidentifiableTruthYears(
        cloneSite(parsed),
        truthBySeries,
    );
    const remaining = new Map(item.targets.map((target) => [
        target.target,
        [...target.truthYears].sort((a, b) => a - b),
    ]));
    const descriptorById = new Map(item.targets.map((target) => [target.target, target]));
    const rows: EventRow[] = [];
    let wrongApplications = 0;
    let applied = 0;
    let stopReason = "iteration_limit";
    const totalTruths = item.targets.reduce((sum, target) => sum + target.truthYears.length, 0);
    const maxIterations = totalTruths
        + ITRDB_VALIDATION_PROTOCOL.supplementary.maximumAutomaticWrongApplications;
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        const activeTargets = item.targets.filter((target) => (
            (remaining.get(target.target)?.length ?? 0) > 0
        ));
        if (activeTargets.length === 0) {
            stopReason = "truths_exhausted";
            break;
        }
        const diagnosed = activeTargets.map((target) => ({
            target,
            result: diagnose(site, target.target),
        }));
        const choices = diagnosed.flatMap(({ target, result }) => (
            result.events[0] ? [{ target, result, event: result.events[0] }] : []
        )).sort((left, right) => (
            right.event.evidence.score - left.event.evidence.score
            || right.event.evidence.scoreMargin - left.event.evidence.scoreMargin
        ));
        const selected = choices[0] ?? null;
        if (!selected) {
            stopReason = "no_suggestion";
            const fallback = diagnosed[0];
            const fallbackTruths = remaining.get(fallback.target.target)!;
            const truthYear = fallbackTruths[fallbackTruths.length - 1];
            rows.push(makeRow({
                descriptor: descriptorFor(fallback.target, parsed),
                caseId: item.caseId,
                scenario: item.kind,
                mode: "automatic-bootstrap",
                file: item.file,
                step: iteration,
                truthEventType: "missingRing",
                truthYear,
                truthYears: fallback.target.truthYears,
                absoluteIdentifiable: fallback.target.scoredTruthYears.includes(truthYear)
                    && !unidentifiable.has(truthYear),
                diagnosis: fallback.result,
            }));
            break;
        }
        const selectedTruths = remaining.get(selected.target.target)!;
        const truthYear = selectedTruths[selectedTruths.length - 1];
        const row = makeRow({
            descriptor: descriptorFor(selected.target, parsed),
            caseId: item.caseId,
            scenario: item.kind,
            mode: "automatic-bootstrap",
            file: item.file,
            step: iteration,
            truthEventType: "missingRing",
            truthYear,
            truthYears: selected.target.truthYears,
            absoluteIdentifiable: selected.target.scoredTruthYears.includes(truthYear)
                && !unidentifiable.has(truthYear),
            diagnosis: selected.result,
        });
        rows.push(row);
        const selectedYear = selected.event.rankedYears[0]?.year;
        const exact = selected.event.eventType === "missingRing" && selectedYear === truthYear;
        if (exact) {
            site.set(
                selected.target.target,
                applyInsertRestore(site.get(selected.target.target)!, truthYear),
            );
            selectedTruths.pop();
            applied += 1;
        } else if (selectedYear !== undefined) {
            const application = applyEvent(site, selected.event, selectedYear);
            if (!application.applied) {
                stopReason = application.error ?? "application_failed";
                break;
            }
            applied += 1;
            wrongApplications += 1;
        } else {
            stopReason = "suggestion_without_ranked_year";
            break;
        }
        if (wrongApplications
            >= ITRDB_VALIDATION_PROTOCOL.supplementary.maximumAutomaticWrongApplications) {
            stopReason = "wrong_application_limit";
            break;
        }
        if (iteration === maxIterations) stopReason = "iteration_limit";
    }
    const remainingTruths = Array.from(remaining.values()).reduce(
        (sum, years) => sum + years.length,
        0,
    );
    const recoveredSeries = item.targets.filter((target) => sameSeries(
        site.get(target.target)!,
        parsed.get(target.target)!.valuesByYear,
    )).length;
    return {
        rows,
        summary: {
            split,
            caseId: item.caseId,
            file: item.file,
            mode: "automatic-bootstrap",
            totalTruths,
            scoredTruths: item.targets.reduce(
                (sum, target) => sum + target.scoredTruthYears.length,
                0,
            ),
            absoluteUnidentifiableTruths: unidentifiable.size,
            iterations: rows.length,
            wrongApplications,
            applied,
            remainingTruths,
            recoveredSeries,
            totalTargetSeries: item.targets.length,
            complete: remainingTruths === 0 && recoveredSeries === item.targets.length,
            stopReason,
        },
    };
};

const percentile = (values: number[], probability: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1)];
};

const summarizeRows = (rows: EventRow[]) => {
    const scored = rows.filter((row) => row.absoluteIdentifiable);
    const responded = scored.filter((row) => row.response);
    const operationCorrect = scored.filter((row) => row.operationCorrect);
    const covered = scored.filter((row) => row.windowCovered);
    const widths = responded
        .map((row) => row.windowWidth)
        .filter((value): value is number => value !== null);
    return {
        cases: scored.length,
        excludedAbsoluteUnidentifiable: rows.length - scored.length,
        responseRate: responded.length / Math.max(1, scored.length),
        operationAccuracy: operationCorrect.length / Math.max(1, scored.length),
        operationAccuracyAnswered: operationCorrect.length / Math.max(1, responded.length),
        primaryWindowCoverage: covered.length / Math.max(1, scored.length),
        conditionalWindowCoverage: covered.length / Math.max(1, operationCorrect.length),
        top1: scored.filter((row) => row.top1Exact).length / Math.max(1, scored.length),
        refusalRate: scored.filter((row) => row.refusal).length / Math.max(1, scored.length),
        partialMoveMisclassificationRate: scored.filter(
            (row) => row.partialMoveMisclassification,
        ).length / Math.max(1, scored.length),
        medianWindowWidth: percentile(widths, 0.5),
        p90WindowWidth: percentile(widths, 0.9),
        medianElapsedMs: percentile(scored.map((row) => row.elapsedMs), 0.5),
        p90ElapsedMs: percentile(scored.map((row) => row.elapsedMs), 0.9),
    };
};

const summarizeCleanRows = (rows: CleanRow[]) => ({
    cases: rows.length,
    falsePositiveRate: rows.filter((row) => row.falsePositive).length
        / Math.max(1, rows.length),
    predictions: rows.reduce((sum, row) => sum + row.predictionCount, 0),
    medianElapsedMs: percentile(rows.map((row) => row.elapsedMs), 0.5),
    p90ElapsedMs: percentile(rows.map((row) => row.elapsedMs), 0.9),
});

const groupSummary = (rows: EventRow[], key: (row: EventRow) => string) => (
    Object.fromEntries(Array.from(new Set(rows.map(key))).sort().map((value) => [
        value,
        summarizeRows(rows.filter((row) => key(row) === value)),
    ]))
);

const csvValue = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const writeCsv = (path: string, rows: EventRow[]): void => {
    const headers = Object.keys(rows[0] ?? {}) as Array<keyof EventRow>;
    const lines = [
        headers.join(","),
        ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(",")),
    ];
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
};

const runWorker = (): void => {
    const output: WorkerOutput = {
        rows: [],
        cleanRows: [],
        bootstrapRuns: [],
        errors: [],
    };
    const parsedCache = new Map<string, Map<string, RwlSeries>>();
    const selectedCases = manifest.splits[split].cases
        .filter((item) => scenario === null || item.kind === scenario)
        .slice(0, caseLimit);
    const cases = selectedCases.filter((_, index) => (
        index % workerCount === workerIndex
    ));
    for (const item of cases) {
        try {
            const sourcePath = resolve(manifest.datasetRoot, item.file);
            const bytes = readFileSync(sourcePath);
            const actualHash = createHash("sha256").update(bytes).digest("hex");
            if (actualHash !== manifest.fileSha256[item.file]) {
                throw new Error(`source hash mismatch: ${item.file}`);
            }
            let parsed = parsedCache.get(item.file);
            if (!parsed) {
                parsed = parseRwl(bytes.toString("utf8"));
                parsedCache.set(item.file, parsed);
            }
            if (item.kind === "singleInjected") {
                const result = runSingleInjectedCase(item, parsed);
                output.rows.push(...result.rows);
                output.cleanRows.push(result.cleanRow);
            } else if (item.kind === "naturalSingle"
                || item.kind === "separatedMulti"
                || item.kind === "adjacentMulti") {
                output.rows.push(...runSimpleMissingCase(item, parsed));
            } else if (item.kind === "crossSeries") {
                output.rows.push(...runCrossSeriesCase(item, parsed));
            } else {
                const truthAssisted = runTruthAssistedBootstrap(item, parsed);
                const automatic = runAutomaticBootstrap(item, parsed);
                output.rows.push(...truthAssisted.rows, ...automatic.rows);
                output.bootstrapRuns.push(truthAssisted.summary, automatic.summary);
            }
        } catch (error) {
            output.errors.push({
                caseId: item.caseId,
                error: error instanceof Error ? error.stack ?? error.message : String(error),
            });
        }
    }
    writeFileSync(
        join(runDir, `worker-${workerIndex}.json`),
        JSON.stringify(output),
        "utf8",
    );
};

const runMain = async (): Promise<void> => {
    const children = Array.from({ length: workers }, (_, index) => new Promise<void>((done, fail) => {
        const child = spawn(process.execPath, [
            viteNodePath,
            scriptPath,
            "--",
            "--manifest",
            manifestPath,
            "--split",
            split,
            "--run-dir",
            runDir,
            "--worker-index",
            String(index),
            "--worker-count",
            String(workers),
            ...(Number.isFinite(caseLimit) ? ["--case-limit", String(caseLimit)] : []),
            ...(scenario ? ["--scenario", scenario] : []),
        ], {
            cwd: repoRoot,
            stdio: "inherit",
            windowsHide: true,
        });
        child.on("error", fail);
        child.on("exit", (code) => (
            code === 0 ? done() : fail(new Error(`worker ${index} exited ${code}`))
        ));
    }));
    await Promise.all(children);
    const outputs = Array.from({ length: workers }, (_, index) => JSON.parse(
        readFileSync(join(runDir, `worker-${index}.json`), "utf8"),
    ) as WorkerOutput);
    const rows = outputs.flatMap((output) => output.rows);
    const cleanRows = outputs.flatMap((output) => output.cleanRows);
    const bootstrapRuns = outputs.flatMap((output) => output.bootstrapRuns);
    const errors = outputs.flatMap((output) => output.errors);
    const summary = {
        schemaVersion: 1,
        protocolVersion: ITRDB_VALIDATION_PROTOCOL.protocolVersion,
        split,
        manifestPath,
        workers,
        manifestCases: Math.min(
            manifest.splits[split].cases.filter(
                (item) => scenario === null || item.kind === scenario,
            ).length,
            caseLimit,
        ),
        eventRows: rows.length,
        errors,
        overall: summarizeRows(rows),
        clean: summarizeCleanRows(cleanRows),
        byTruthEventType: groupSummary(rows, (row) => row.truthEventType),
        byScenario: groupSummary(rows, (row) => row.scenario),
        byMode: groupSummary(rows, (row) => row.mode),
        byDataset: groupSummary(rows, (row) => row.datasetGroup),
        bySeriesLength: groupSummary(rows, (row) => row.seriesLengthStratum),
        byReferenceDepth: groupSummary(rows, (row) => row.referenceDepthStratum),
        byMissingCount: groupSummary(rows, (row) => String(row.missingCount)),
        byEventSpacing: groupSummary(rows, (row) => row.eventSpacing),
        byEndpointDistance: groupSummary(rows, (row) => row.endpointStratum),
        byBaselineStatus: {
            clean: summarizeRows(rows.filter((row) => row.baselineFlagged === false)),
            flagged: summarizeRows(rows.filter((row) => row.baselineFlagged === true)),
            notMeasured: summarizeRows(rows.filter((row) => row.baselineFlagged === null)),
        },
        cleanByDataset: Object.fromEntries(Array.from(new Set(
            cleanRows.map((row) => row.datasetGroup),
        )).sort().map((datasetGroup) => [
            datasetGroup,
            summarizeCleanRows(cleanRows.filter((row) => row.datasetGroup === datasetGroup)),
        ])),
        bootstrapRuns,
    };
    writeFileSync(join(runDir, "cases.json"), JSON.stringify(rows, null, 2), "utf8");
    writeCsv(join(runDir, "cases.csv"), rows);
    writeFileSync(
        join(runDir, "clean-cases.json"),
        JSON.stringify(cleanRows, null, 2),
        "utf8",
    );
    writeFileSync(
        join(runDir, "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
        "utf8",
    );
    // eslint-disable-next-line no-console
    console.log(`ITRDB_COMPLEX_EVENT_SUMMARY ${JSON.stringify(summary)}`);
};

if (workerIndex === null) await runMain();
else runWorker();
