/** Evaluates isolated and composed ITRDB events through the production review-event pipeline. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis/types";
import { createPiecewiseLagMixedCase } from "@/features/crossdating/diagnosis/__tests__/rdmFixture";
import {
    cloneSite,
    diagnoseTruthBlind,
    loadRwl,
    reopenFormattedSite,
    runCofecha,
    sha256Bytes,
    snapshotsSemanticallyEqual,
} from "./legacy-generalization/evaluator";
import { buildCapabilityCases } from "./itrdb-operation-capability/scenarios";
import { summarizeClusteredMetric } from "./itrdb-operation-capability/clusteredStatistics";
import {
    countWorkflowSuggestionAttempts,
    diagnosisShiftYears,
    matchWorkflowSuggestion,
} from "./itrdb-operation-capability/workflowSuggestionMetric";
import type {
    CapabilityCase,
    CapabilityConfig,
    CapabilityFamily,
    CapabilityManifest,
    CapabilityOperation,
    CapabilityTruth,
} from "./itrdb-operation-capability/types";

type Interpretation = "primary" | "alternative";
type EventPreview = {
    eventType: CapabilityOperation;
    shiftYears: number;
    startYear: number;
    endYear: number;
    topYear: number | null;
    confidence: string;
    score: number;
    scoreMargin: number;
    sources: string[];
    notes: string[];
    reviewOnly: boolean;
};
type StepRow = {
    caseIndex: number;
    caseId: string;
    family: CapabilityFamily;
    scenarioId: string;
    fileId: string;
    targetId: string;
    evaluationMode: CapabilityCase["evaluationMode"];
    acceptanceTier: CapabilityCase["acceptanceTier"];
    step: number;
    remainingTruthsBefore: number;
    remainingTruthIds: string[];
    cofechaFlagged: boolean;
    referenceMode: string;
    referenceAnchorCount: number;
    response: boolean;
    primary: EventPreview | null;
    alternative: EventPreview | null;
    primaryOperationCorrect: boolean;
    alternativeOperationCorrect: boolean;
    primaryWindowCovered: boolean;
    alternativeWindowCovered: boolean;
    workflowEquivalentOperationCorrect: boolean;
    workflowEquivalentWindowCovered: boolean;
    workflowSuggestionCorrect: boolean;
    localWindowEvaluated: boolean;
    primaryLocalWindowCovered: boolean;
    workflowEquivalentLocalWindowCovered: boolean;
    outOfOrderEvent: boolean;
    partialMoveMisclassification: boolean;
    wholeSeriesMoveMisclassification: boolean;
    positiveWholeSeriesMoveOutput: boolean;
    acceptedInterpretation: Interpretation | null;
    acceptedTruthId: string | null;
    acceptedTruthType: CapabilityOperation | null;
    acceptedTruthYear: number | null;
    acceptedTruthShiftYears: number | null;
    top1Exact: boolean;
    windowWidth: number | null;
    allowedWindowWidth: boolean;
    saveReopenStable: boolean;
    refusalReason: string | null;
    stopReason: string | null;
    elapsedMs: number;
    error: string | null;
};
type CaseRow = {
    caseIndex: number;
    caseId: string;
    family: CapabilityFamily;
    scenarioId: string;
    fileId: string;
    targetId: string;
    evaluationMode: CapabilityCase["evaluationMode"];
    acceptanceTier: CapabilityCase["acceptanceTier"];
    seriesYears: number;
    masterCorrelation: number;
    problemSegments: number;
    spacingYears: number | null;
    partialShiftYears: number;
    wholeShiftYears: number;
    truthCount: number;
    localTruthCount: number;
    wholeTruthCount: number;
    recoveredTruths: number;
    recoveredLocalTruths: number;
    strictRecoveredLocalTruths: number;
    top1RecoveredLocalTruths: number;
    primaryRecoveries: number;
    alternativeRecoveries: number;
    complete: boolean;
    cleanFalsePositive: boolean | null;
    stopReason: string;
    attemptedSteps: number;
    saveReopenStable: boolean;
    elapsedMs: number;
    error: string | null;
};
type RunPlan = {
    schemaVersion: 1;
    configPath: string;
    manifestPath: string;
    configSha256: string;
    manifestSha256: string;
    families: CapabilityFamily[];
    caseIds: string[];
    workerCount: number;
    maxSteps: number | null;
    keepAllCofecha: boolean;
    executionGitCommit?: string;
};

const repoRoot = resolve(
    process.env.CROSSDATING_REPO_ROOT
    ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const scriptPath = fileURLToPath(import.meta.url);
const viteNodePath = join(repoRoot, "node_modules", "vite-node", "vite-node.mjs");
const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    if (index >= 0) return args[index + 1] ?? null;
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    return inline?.slice(name.length + 1) ?? null;
};
const hasFlag = (name: string): boolean => args.includes(name)
    || args.includes(`${name}=true`);
const keepDiagnosisAudits = hasFlag("--keep-diagnosis-audits");
const configPath = resolve(valueFor("--config")
    ?? "docs/benchmarks/itrdb-operation-capability-config-v1.json");
const manifestPath = resolve(valueFor("--manifest")
    ?? "docs/benchmarks/itrdb-operation-capability-manifest-v1.json");
const outputRoot = resolve(valueFor("--output-dir")
    ?? "D:/软件测试/itrdb-operation-capability/results");
const runId = valueFor("--run-id")
    ?? `capability-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runDir = resolve(valueFor("--run-dir") ?? join(outputRoot, runId));
const cofechaExe = resolve(valueFor("--cofecha-exe")
    ?? "src-tauri/bin/cofecha-x86_64-pc-windows-msvc.exe");
const workerIndexRaw = valueFor("--worker-index");
const workerIndex = workerIndexRaw === null ? null : Number(workerIndexRaw);
const planPath = resolve(valueFor("--plan") ?? join(runDir, "run-plan.json"));

const sha256 = (value: Buffer | string): string => createHash("sha256")
    .update(value).digest("hex");
const currentGitCommit = (): string => {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
    });
    if (result.status !== 0) throw new Error("unable to resolve execution git commit");
    return result.stdout.trim();
};
const stableHash = (value: string): number => Number.parseInt(
    createHash("sha256").update(value).digest("hex").slice(0, 12),
    16,
);
const preview = (event: DiagnosisEvent | null): EventPreview | null => event ? ({
    eventType: event.eventType,
    shiftYears: diagnosisShiftYears(event),
    startYear: event.startYear,
    endYear: event.endYear,
    topYear: event.rankedYears[0]?.year ?? null,
    confidence: event.confidenceLevel,
    score: event.evidence.score,
    scoreMargin: event.evidence.scoreMargin,
    sources: event.evidence.algorithmSources,
    notes: event.evidence.notes,
    reviewOnly: event.reviewOnly === true,
}) : null;
const operationMatches = (event: DiagnosisEvent, truth: CapabilityTruth): boolean => (
    event.eventType === truth.eventType
    && diagnosisShiftYears(event) === truth.shiftYears
);
const windowCovers = (event: DiagnosisEvent, truth: CapabilityTruth): boolean => (
    truth.eventType === "wholeSeriesMove"
    || (truth.year !== null && truth.year >= event.startYear && truth.year <= event.endYear)
);
const matchingTruth = (
    event: DiagnosisEvent | null,
    truths: readonly CapabilityTruth[],
    requireWindow: boolean,
): CapabilityTruth | null => {
    if (!event) return null;
    const matches = truths.filter((truth) => operationMatches(event, truth)
        && (!requireWindow || windowCovers(event, truth)));
    if (matches.length === 0) return null;
    const anchor = event.rankedYears[0]?.year
        ?? Math.round((event.startYear + event.endYear) / 2);
    return [...matches].sort((left, right) => (
        Math.abs((left.year ?? anchor) - anchor) - Math.abs((right.year ?? anchor) - anchor)
        || (right.year ?? -Infinity) - (left.year ?? -Infinity)
        || left.truthId.localeCompare(right.truthId)
    ))[0];
};

const currentFrontierTruths = (
    truths: readonly CapabilityTruth[],
): CapabilityTruth[] => {
    const whole = truths.filter((truth) => truth.eventType === "wholeSeriesMove");
    const local = truths.filter((truth) => truth.year !== null)
        .sort((left, right) => right.year! - left.year!)[0];
    return [...whole, ...(local ? [local] : [])];
};

const buildScenarioSite = async (
    inputPath: string,
    targetId: string,
    remainingTruths: readonly CapabilityTruth[],
    falseRingMode: CapabilityConfig["injection"]["falseRingMode"],
) => {
    const loaded = await loadRwl(inputPath, "tucson-auto");
    const source = loaded.series.get(targetId);
    if (!source) throw new Error(`target not found: ${targetId}`);
    const whole = remainingTruths.find((truth) => truth.eventType === "wholeSeriesMove");
    const local = remainingTruths.filter((truth) => truth.eventType !== "wholeSeriesMove")
        .map((truth) => ({
            eventType: truth.eventType as "missingRing" | "falseRing" | "partialMove",
            year: truth.year!,
            shiftYears: truth.shiftYears,
            falseMode: truth.eventType === "falseRing" ? falseRingMode : undefined,
        }));
    const target = remainingTruths.length === 0
        ? new Map(source.valuesByYear)
        : createPiecewiseLagMixedCase(source, local, whole?.shiftYears ?? 0).corrupted;
    const site = cloneSite(loaded.siteData);
    site.set(targetId, target);
    return { loaded, site };
};

const runCase = async (input: {
    spec: CapabilityCase;
    config: CapabilityConfig;
    manifest: CapabilityManifest;
    workerDir: string;
    maxSteps: number | null;
    keepAllCofecha: boolean;
}): Promise<{ row: CaseRow; steps: StepRow[] }> => {
    const started = Date.now();
    const file = input.manifest.files.find((item) => item.fileId === input.spec.fileId);
    if (!file) throw new Error(`manifest file missing: ${input.spec.fileId}`);
    const inputPath = resolve(input.manifest.itrdbRoot, file.relativePath);
    const sourceHash = sha256Bytes(readFileSync(inputPath));
    if (sourceHash !== file.sourceSha256) throw new Error(`source hash mismatch: ${file.fileId}`);
    const remaining = [...input.spec.truths];
    const steps: StepRow[] = [];
    let stopReason = input.spec.truths.length === 0 ? "clean_unchecked" : "truths_remaining";
    let primaryRecoveries = 0;
    let alternativeRecoveries = 0;
    const maximumSteps = input.maxSteps === null
        ? Math.max(1, input.spec.truths.length)
        : Math.max(1, Math.min(input.maxSteps, Math.max(1, input.spec.truths.length)));
    for (let step = 1; step <= maximumSteps; step += 1) {
        const stepStarted = Date.now();
        const { loaded, site } = await buildScenarioSite(
            inputPath,
            input.spec.targetId,
            remaining,
            input.config.injection.falseRingMode,
        );
        const reopened = await reopenFormattedSite(site, loaded.readResult);
        const context = runCofecha({
            siteData: reopened,
            readResult: loaded.readResult,
            workDir: input.workerDir,
            label: `case-${input.spec.index}-step-${step}`,
            cofechaExe,
            timeoutSeconds: input.config.runtime.cofechaTimeoutSeconds,
        });
        const before = diagnoseTruthBlind({
            siteData: site,
            targetId: input.spec.targetId,
            context,
            runId: `capability-before-${input.spec.index}-${step}`,
            includeOperationGrid: keepDiagnosisAudits,
        });
        const after = diagnoseTruthBlind({
            siteData: reopened,
            targetId: input.spec.targetId,
            context,
            runId: `capability-after-${input.spec.index}-${step}`,
            includeOperationGrid: keepDiagnosisAudits,
        });
        if (keepDiagnosisAudits) {
            writeFileSync(
                join(context.stateDir, "diagnosis-audit.json"),
                `${JSON.stringify({ before, after }, null, 2)}\n`,
                "utf8",
            );
        }
        const primary = after.reviewEvent;
        const alternative = primary?.interpretationAmbiguity?.alternative ?? null;
        const frontierTruths = currentFrontierTruths(remaining);
        const primaryOperationTruth = matchingTruth(primary, frontierTruths, false);
        const alternativeOperationTruth = matchingTruth(alternative, frontierTruths, false);
        const primaryCoveredTruth = matchingTruth(primary, frontierTruths, true);
        const alternativeCoveredTruth = matchingTruth(alternative, frontierTruths, true);
        const workflowSuggestion = matchWorkflowSuggestion(
            primary,
            alternative,
            frontierTruths,
        );
        const acceptedTruth = workflowSuggestion?.truth ?? null;
        const acceptedInterpretation: Interpretation | null =
            workflowSuggestion?.interpretation ?? null;
        const acceptedEvent = workflowSuggestion?.event ?? null;
        const width = acceptedEvent && acceptedEvent.eventType !== "wholeSeriesMove"
            ? acceptedEvent.endYear - acceptedEvent.startYear + 1
            : null;
        const isClean = input.spec.truths.length === 0;
        const matchesAnyRemaining = matchingTruth(primary, remaining, true) !== null
            || matchingTruth(alternative, remaining, true) !== null;
        const workflowEquivalentOperationCorrect = primaryOperationTruth !== null
            || alternativeOperationTruth !== null;
        const workflowEquivalentWindowCovered = acceptedTruth !== null;
        const localFrontierTruthPresent = frontierTruths.some((truth) => (
            truth.eventType !== "wholeSeriesMove"
        ));
        // A correctly accepted whole-series baseline is resolved before the local
        // frontier. The local event is evaluated on the next diagnostic pass.
        const localWindowEvaluated = localFrontierTruthPresent
            && acceptedTruth?.eventType !== "wholeSeriesMove";
        const primaryLocalWindowCovered = primaryCoveredTruth !== null
            && primaryCoveredTruth.eventType !== "wholeSeriesMove";
        const workflowEquivalentLocalWindowCovered = acceptedTruth !== null
            && acceptedTruth.eventType !== "wholeSeriesMove";
        const partialMoveMisclassification = primary?.eventType === "partialMove"
            && primaryOperationTruth === null;
        const wholeSeriesMoveMisclassification = primary?.eventType === "wholeSeriesMove"
            && primaryOperationTruth === null;
        const positiveWholeSeriesMoveOutput = primary?.eventType === "wholeSeriesMove"
            && diagnosisShiftYears(primary) > 0;
        if (isClean) {
            stopReason = primary ? "clean_false_positive" : "clean_pass";
        } else if (!primary) {
            stopReason = "refused";
        } else if (!acceptedTruth) {
            stopReason = matchesAnyRemaining
                ? "out_of_order_frontier"
                : primaryOperationTruth || alternativeOperationTruth
                    ? "window_miss"
                    : "wrong_operation";
        } else {
            stopReason = "accepted";
            if (acceptedInterpretation === "primary") primaryRecoveries += 1;
            else alternativeRecoveries += 1;
        }
        steps.push({
            caseIndex: input.spec.index,
            caseId: input.spec.caseId,
            family: input.spec.family,
            scenarioId: input.spec.scenarioId,
            fileId: input.spec.fileId,
            targetId: input.spec.targetId,
            evaluationMode: input.spec.evaluationMode,
            acceptanceTier: input.spec.acceptanceTier,
            step,
            remainingTruthsBefore: remaining.length,
            remainingTruthIds: remaining.map((truth) => truth.truthId),
            cofechaFlagged: context.flaggedIds.some((id) => (
                id.toLowerCase() === input.spec.targetId.toLowerCase()
            )),
            referenceMode: after.referenceMode,
            referenceAnchorCount: after.referenceAnchorCount,
            response: primary !== null,
            primary: preview(primary),
            alternative: preview(alternative),
            primaryOperationCorrect: primaryOperationTruth !== null,
            alternativeOperationCorrect: alternativeOperationTruth !== null,
            primaryWindowCovered: primaryCoveredTruth !== null,
            alternativeWindowCovered: alternativeCoveredTruth !== null,
            workflowEquivalentOperationCorrect,
            workflowEquivalentWindowCovered,
            workflowSuggestionCorrect: workflowSuggestion !== null,
            localWindowEvaluated,
            primaryLocalWindowCovered,
            workflowEquivalentLocalWindowCovered,
            outOfOrderEvent: stopReason === "out_of_order_frontier",
            partialMoveMisclassification,
            wholeSeriesMoveMisclassification,
            positiveWholeSeriesMoveOutput,
            acceptedInterpretation,
            acceptedTruthId: acceptedTruth?.truthId ?? null,
            acceptedTruthType: acceptedTruth?.eventType ?? null,
            acceptedTruthYear: acceptedTruth?.year ?? null,
            acceptedTruthShiftYears: acceptedTruth?.shiftYears ?? null,
            top1Exact: Boolean(acceptedTruth?.year !== null
                && acceptedEvent?.rankedYears[0]?.year === acceptedTruth?.year),
            windowWidth: width,
            allowedWindowWidth: width === null
                || input.config.injection.allowedWindowWidths.includes(width),
            saveReopenStable: snapshotsSemanticallyEqual(before, after),
            refusalReason: after.reviewDecision?.reason ?? after.audit?.finalReason ?? null,
            stopReason: stopReason === "accepted" ? null : stopReason,
            elapsedMs: Date.now() - stepStarted,
            error: before.error ?? after.error,
        });
        const preserve = input.keepAllCofecha || keepDiagnosisAudits || ![
            "accepted",
            "clean_pass",
        ].includes(stopReason);
        if (!preserve) rmSync(context.stateDir, { recursive: true, force: true });
        if (isClean || !acceptedTruth) break;
        const truthIndex = remaining.findIndex((truth) => truth.truthId === acceptedTruth.truthId);
        remaining.splice(truthIndex, 1);
        if (remaining.length === 0) {
            stopReason = "all_truths_recovered";
            break;
        }
        if (step === maximumSteps) stopReason = "step_limit";
    }
    return {
        row: {
            caseIndex: input.spec.index,
            caseId: input.spec.caseId,
            family: input.spec.family,
            scenarioId: input.spec.scenarioId,
            fileId: input.spec.fileId,
            targetId: input.spec.targetId,
            evaluationMode: input.spec.evaluationMode,
            acceptanceTier: input.spec.acceptanceTier,
            seriesYears: input.spec.seriesYears,
            masterCorrelation: input.spec.masterCorrelation,
            problemSegments: input.spec.problemSegments,
            spacingYears: input.spec.spacingYears,
            partialShiftYears: input.spec.partialShiftYears,
            wholeShiftYears: input.spec.wholeShiftYears,
            truthCount: input.spec.truths.length,
            localTruthCount: input.spec.truths.filter((truth) => (
                truth.eventType !== "wholeSeriesMove"
            )).length,
            wholeTruthCount: input.spec.truths.filter((truth) => (
                truth.eventType === "wholeSeriesMove"
            )).length,
            recoveredTruths: input.spec.truths.length - remaining.length,
            recoveredLocalTruths: steps.filter((stepRow) => (
                stepRow.acceptedTruthType !== null
                && stepRow.acceptedTruthType !== "wholeSeriesMove"
            )).length,
            strictRecoveredLocalTruths: steps.filter((stepRow) => (
                stepRow.acceptedTruthType !== null
                && stepRow.acceptedTruthType !== "wholeSeriesMove"
                && stepRow.acceptedInterpretation === "primary"
                && stepRow.primaryOperationCorrect
                && stepRow.primaryWindowCovered
            )).length,
            top1RecoveredLocalTruths: steps.filter((stepRow) => (
                stepRow.acceptedTruthType !== null
                && stepRow.acceptedTruthType !== "wholeSeriesMove"
                && stepRow.top1Exact
            )).length,
            primaryRecoveries,
            alternativeRecoveries,
            complete: input.spec.truths.length === 0
                ? stopReason === "clean_pass"
                : remaining.length === 0,
            cleanFalsePositive: input.spec.truths.length === 0
                ? stopReason === "clean_false_positive"
                : null,
            stopReason,
            attemptedSteps: steps.length,
            saveReopenStable: steps.every((stepRow) => stepRow.saveReopenStable),
            elapsedMs: Date.now() - started,
            error: steps.find((stepRow) => stepRow.error)?.error ?? null,
        },
        steps,
    };
};

const percentile = (values: number[], probability: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1)];
};
const rate = (count: number, total: number): number | null => total > 0
    ? count / total
    : null;
const summarize = (cases: CaseRow[], steps: StepRow[]) => {
    const eventCases = cases.filter((row) => row.truthCount > 0);
    const cleanCases = cases.filter((row) => row.truthCount === 0);
    const attemptedEventSteps = steps.filter((row) => (
        row.remainingTruthsBefore > 0
    ));
    const respondedSteps = attemptedEventSteps.filter((row) => row.response);
    const localOperationSteps = attemptedEventSteps.filter((row) => (
        row.workflowEquivalentOperationCorrect
        && (
            row.primaryOperationCorrect
                ? row.primary?.eventType
                : row.alternative?.eventType
        ) !== "wholeSeriesMove"
    ));
    const acceptedLocalSteps = attemptedEventSteps.filter((row) => (
        row.acceptedTruthType !== null && row.acceptedTruthType !== "wholeSeriesMove"
    ));
    const promptedLocalSteps = attemptedEventSteps.filter((row) => row.localWindowEvaluated);
    const workflowSuggestionCounts = countWorkflowSuggestionAttempts(
        attemptedEventSteps,
    );
    const widths = acceptedLocalSteps.map((row) => row.windowWidth)
        .filter((value): value is number => value !== null);
    const truthCount = eventCases.reduce((sum, row) => sum + row.truthCount, 0);
    const localTruthCount = eventCases.reduce((sum, row) => sum + row.localTruthCount, 0);
    const recovered = eventCases.reduce((sum, row) => sum + row.recoveredTruths, 0);
    const recoveredLocal = eventCases.reduce(
        (sum, row) => sum + row.recoveredLocalTruths,
        0,
    );
    const strictRecoveredLocal = eventCases.reduce(
        (sum, row) => sum + row.strictRecoveredLocalTruths,
        0,
    );
    const top1RecoveredLocal = eventCases.reduce(
        (sum, row) => sum + row.top1RecoveredLocalTruths,
        0,
    );
    return {
        cases: cases.length,
        eventCases: eventCases.length,
        cleanCases: cleanCases.length,
        truthEvents: truthCount,
        localTruthEvents: localTruthCount,
        recoveredTruthEvents: recovered,
        serialRecoveryRate: rate(recovered, truthCount),
        serialStrictMainWindowCoverage: rate(strictRecoveredLocal, localTruthCount),
        serialWorkflowEquivalentWindowCoverage: rate(recoveredLocal, localTruthCount),
        serialTop1: rate(top1RecoveredLocal, localTruthCount),
        completeCases: eventCases.filter((row) => row.complete).length,
        completeCaseRate: rate(eventCases.filter((row) => row.complete).length, eventCases.length),
        responseRate: rate(respondedSteps.length, attemptedEventSteps.length),
        refusalRate: rate(
            attemptedEventSteps.filter((row) => row.stopReason === "refused").length,
            attemptedEventSteps.length,
        ),
        strictOperationAccuracy: rate(
            attemptedEventSteps.filter((row) => row.primaryOperationCorrect).length,
            attemptedEventSteps.length,
        ),
        strictOperationAccuracyAnswered: rate(
            respondedSteps.filter((row) => row.primaryOperationCorrect).length,
            respondedSteps.length,
        ),
        workflowEquivalentOperationAccuracy: rate(
            attemptedEventSteps.filter((row) => row.workflowEquivalentOperationCorrect).length,
            attemptedEventSteps.length,
        ),
        workflowEquivalentOperationAccuracyAnswered: rate(
            respondedSteps.filter((row) => row.workflowEquivalentOperationCorrect).length,
            respondedSteps.length,
        ),
        workflowSuggestionCorrect: workflowSuggestionCounts.numerator,
        workflowSuggestionAttempts: workflowSuggestionCounts.denominator,
        workflowSuggestionAccuracy: rate(
            workflowSuggestionCounts.numerator,
            workflowSuggestionCounts.denominator,
        ),
        mainWindowCoverage: rate(
            attemptedEventSteps.filter((row) => row.primaryWindowCovered).length,
            attemptedEventSteps.length,
        ),
        workflowEquivalentWindowCoverage: rate(
            attemptedEventSteps.filter((row) => row.workflowEquivalentWindowCovered).length,
            attemptedEventSteps.length,
        ),
        promptedStrictLocalWindowCoverage: rate(
            promptedLocalSteps.filter((row) => row.primaryLocalWindowCovered).length,
            promptedLocalSteps.length,
        ),
        promptedWorkflowEquivalentLocalWindowCoverage: rate(
            promptedLocalSteps.filter((row) => (
                row.workflowEquivalentLocalWindowCovered
            )).length,
            promptedLocalSteps.length,
        ),
        conditionalLocalWindowCoverage: rate(acceptedLocalSteps.length, localOperationSteps.length),
        top1: rate(acceptedLocalSteps.filter((row) => row.top1Exact).length, acceptedLocalSteps.length),
        alternativeRecoveries: eventCases.reduce((sum, row) => sum + row.alternativeRecoveries, 0),
        wrongOperationRate: rate(
            attemptedEventSteps.filter((row) => row.stopReason === "wrong_operation").length,
            attemptedEventSteps.length,
        ),
        windowMissRate: rate(
            attemptedEventSteps.filter((row) => row.stopReason === "window_miss").length,
            attemptedEventSteps.length,
        ),
        outOfOrderFrontierRate: rate(
            attemptedEventSteps.filter((row) => row.outOfOrderEvent).length,
            attemptedEventSteps.length,
        ),
        partialMoveMisclassificationRate: rate(
            respondedSteps.filter((row) => row.partialMoveMisclassification).length,
            respondedSteps.length,
        ),
        wholeSeriesMoveMisclassificationRate: rate(
            respondedSteps.filter((row) => row.wholeSeriesMoveMisclassification).length,
            respondedSteps.length,
        ),
        positiveWholeSeriesMoveOutputs: respondedSteps.filter((row) => (
            row.positiveWholeSeriesMoveOutput
        )).length,
        cleanFalsePositiveRate: rate(
            cleanCases.filter((row) => row.cleanFalsePositive).length,
            cleanCases.length,
        ),
        cleanFalsePositives: cleanCases.filter((row) => row.cleanFalsePositive).length,
        medianWindowWidth: percentile(widths, 0.5),
        p90WindowWidth: percentile(widths, 0.9),
        illegalWindowWidths: acceptedLocalSteps.filter((row) => !row.allowedWindowWidth).length,
        saveReopenStableRate: rate(
            cases.filter((row) => row.saveReopenStable).length,
            cases.length,
        ),
        medianCaseSeconds: (() => {
            const value = percentile(cases.map((row) => row.elapsedMs), 0.5);
            return value === null ? null : value / 1000;
        })(),
    };
};
const grouped = <T extends string>(
    cases: CaseRow[],
    steps: StepRow[],
    key: (row: CaseRow) => T,
) => Object.fromEntries(Array.from(new Set(cases.map(key))).sort().map((value) => [
    value,
    summarize(
        cases.filter((row) => key(row) === value),
        steps.filter((row) => cases.some((item) => (
            item.caseId === row.caseId && key(item) === value
        ))),
    ),
]));

type ClusterMetricCount = { numerator: number; denominator: number };
type ClusterMetricName =
    | "responseRate"
    | "refusalRate"
    | "strictOperationAccuracy"
    | "workflowSuggestionAccuracy"
    | "serialRecoveryRate"
    | "serialStrictMainWindowCoverage"
    | "serialWorkflowEquivalentWindowCoverage"
    | "serialTop1"
    | "promptedStrictLocalWindowCoverage"
    | "promptedWorkflowEquivalentLocalWindowCoverage"
    | "saveReopenStableRate"
    | "cleanFalsePositiveRate";

const clusterMetricCounts = (
    cases: CaseRow[],
    steps: StepRow[],
): Record<ClusterMetricName, ClusterMetricCount> => {
    const eventCases = cases.filter((row) => row.truthCount > 0);
    const cleanCases = cases.filter((row) => row.truthCount === 0);
    const attempted = steps.filter((row) => row.remainingTruthsBefore > 0);
    const truthCount = eventCases.reduce((sum, row) => sum + row.truthCount, 0);
    const localTruthCount = eventCases.reduce((sum, row) => sum + row.localTruthCount, 0);
    const promptedLocal = attempted.filter((row) => row.localWindowEvaluated);
    const workflowSuggestionCounts = countWorkflowSuggestionAttempts(attempted);
    return {
        responseRate: {
            numerator: attempted.filter((row) => row.response).length,
            denominator: attempted.length,
        },
        refusalRate: {
            numerator: attempted.filter((row) => row.stopReason === "refused").length,
            denominator: attempted.length,
        },
        strictOperationAccuracy: {
            numerator: attempted.filter((row) => row.primaryOperationCorrect).length,
            denominator: attempted.length,
        },
        workflowSuggestionAccuracy: workflowSuggestionCounts,
        serialRecoveryRate: {
            numerator: eventCases.reduce((sum, row) => sum + row.recoveredTruths, 0),
            denominator: truthCount,
        },
        serialStrictMainWindowCoverage: {
            numerator: eventCases.reduce(
                (sum, row) => sum + row.strictRecoveredLocalTruths,
                0,
            ),
            denominator: localTruthCount,
        },
        serialWorkflowEquivalentWindowCoverage: {
            numerator: eventCases.reduce(
                (sum, row) => sum + row.recoveredLocalTruths,
                0,
            ),
            denominator: localTruthCount,
        },
        serialTop1: {
            numerator: eventCases.reduce(
                (sum, row) => sum + row.top1RecoveredLocalTruths,
                0,
            ),
            denominator: localTruthCount,
        },
        promptedStrictLocalWindowCoverage: {
            numerator: promptedLocal.filter((row) => row.primaryLocalWindowCovered).length,
            denominator: promptedLocal.length,
        },
        promptedWorkflowEquivalentLocalWindowCoverage: {
            numerator: promptedLocal.filter((row) => (
                row.workflowEquivalentLocalWindowCovered
            )).length,
            denominator: promptedLocal.length,
        },
        saveReopenStableRate: {
            numerator: cases.filter((row) => row.saveReopenStable).length,
            denominator: cases.length,
        },
        cleanFalsePositiveRate: {
            numerator: cleanCases.filter((row) => row.cleanFalsePositive).length,
            denominator: cleanCases.length,
        },
    };
};

const clusteredInference = (
    cases: CaseRow[],
    steps: StepRow[],
    statistics: NonNullable<CapabilityConfig["statistics"]>,
    family: CapabilityFamily,
) => {
    const familyCases = cases.filter((row) => row.family === family);
    const familyCaseIds = new Set(familyCases.map((row) => row.caseId));
    const familySteps = steps.filter((row) => familyCaseIds.has(row.caseId));
    const fileIds = Array.from(new Set(familyCases.map((row) => row.fileId))).sort();
    const byFile = new Map(fileIds.map((fileId) => {
        const selectedCases = familyCases.filter((row) => row.fileId === fileId);
        const selectedIds = new Set(selectedCases.map((row) => row.caseId));
        return [fileId, clusterMetricCounts(
            selectedCases,
            familySteps.filter((row) => selectedIds.has(row.caseId)),
        )];
    }));
    const allCounts = clusterMetricCounts(familyCases, familySteps);
    const metricNames = Object.keys(allCounts) as ClusterMetricName[];
    const targetMetrics = new Set<ClusterMetricName>([
        "workflowSuggestionAccuracy",
    ]);
    const metrics = Object.fromEntries(metricNames.map((metricName) => {
        const inference = summarizeClusteredMetric(fileIds.map((fileId) => ({
            clusterId: fileId,
            ...byFile.get(fileId)![metricName],
        })), {
            replicates: statistics.bootstrapReplicates,
            confidenceLevel: statistics.confidenceLevel,
            seed: `${statistics.seed}:${family}:${metricName}`,
        });
        const target = family !== "Clean" && targetMetrics.has(metricName)
            ? statistics.targetCoverage
            : null;
        return [metricName, {
            ...inference,
            target,
            observedTargetPassed: target === null || (
                inference.micro.estimate !== null && inference.micro.estimate >= target
                && inference.macro.estimate !== null && inference.macro.estimate >= target
            ),
            oneSidedLowerTargetPassed: target === null || (
                inference.micro.oneSidedLower !== null
                && inference.micro.oneSidedLower >= target
                && inference.macro.oneSidedLower !== null
                && inference.macro.oneSidedLower >= target
            ),
        }];
    }));
    return {
        family,
        clusterUnit: statistics.clusterUnit,
        clusters: fileIds.length,
        bootstrapReplicates: statistics.bootstrapReplicates,
        confidenceLevel: statistics.confidenceLevel,
        metrics,
    };
};

const csvCell = (value: unknown): string => {
    const text = Array.isArray(value) || value !== null && typeof value === "object"
        ? JSON.stringify(value)
        : value === null || value === undefined
            ? ""
            : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const writeCsv = (path: string, rows: Array<Record<string, unknown>>): void => {
    const headers = Object.keys(rows[0] ?? {});
    writeFileSync(path, [
        headers.join(","),
        ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
    ].join("\n") + "\n", "utf8");
};

const readInputs = () => {
    if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`);
    if (!existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
    const configBytes = readFileSync(configPath);
    const manifestBytes = readFileSync(manifestPath);
    const config = JSON.parse(configBytes.toString("utf8")) as CapabilityConfig;
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as CapabilityManifest;
    if (sha256(configBytes) !== manifest.configSha256) throw new Error("config hash mismatch");
    if (manifest.protocolVersion !== config.protocolVersion
        || manifest.scenarioGeneratorVersion !== config.scenarioGeneratorVersion) {
        throw new Error("capability protocol mismatch");
    }
    return { config, manifest, configBytes, manifestBytes };
};

const runWorker = async (): Promise<void> => {
    if (workerIndex === null || !Number.isInteger(workerIndex)) {
        throw new Error("valid worker index required");
    }
    const { config, manifest } = readInputs();
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as RunPlan;
    const allCases = buildCapabilityCases(config, manifest);
    const selectedIds = new Set(plan.caseIds);
    const selectedCases = allCases.filter((spec) => selectedIds.has(spec.caseId));
    const workerCases = selectedCases.filter((_, index) => index % plan.workerCount === workerIndex);
    const workerDir = join(runDir, "workers", `worker-${workerIndex}`);
    mkdirSync(workerDir, { recursive: true });
    const caseRows: CaseRow[] = [];
    const stepRows: StepRow[] = [];
    for (const [index, spec] of workerCases.entries()) {
        try {
            const result = await runCase({
                spec,
                config,
                manifest,
                workerDir,
                maxSteps: plan.maxSteps,
                keepAllCofecha: plan.keepAllCofecha,
            });
            caseRows.push(result.row);
            stepRows.push(...result.steps);
        } catch (error) {
            const message = error instanceof Error ? error.stack ?? error.message : String(error);
            caseRows.push({
                caseIndex: spec.index,
                caseId: spec.caseId,
                family: spec.family,
                scenarioId: spec.scenarioId,
                fileId: spec.fileId,
                targetId: spec.targetId,
                evaluationMode: spec.evaluationMode,
                acceptanceTier: spec.acceptanceTier,
                seriesYears: spec.seriesYears,
                masterCorrelation: spec.masterCorrelation,
                problemSegments: spec.problemSegments,
                spacingYears: spec.spacingYears,
                partialShiftYears: spec.partialShiftYears,
                wholeShiftYears: spec.wholeShiftYears,
                truthCount: spec.truths.length,
                localTruthCount: spec.truths.filter((truth) => (
                    truth.eventType !== "wholeSeriesMove"
                )).length,
                wholeTruthCount: spec.truths.filter((truth) => (
                    truth.eventType === "wholeSeriesMove"
                )).length,
                recoveredTruths: 0,
                recoveredLocalTruths: 0,
                strictRecoveredLocalTruths: 0,
                top1RecoveredLocalTruths: 0,
                primaryRecoveries: 0,
                alternativeRecoveries: 0,
                complete: false,
                cleanFalsePositive: spec.truths.length === 0 ? null : null,
                stopReason: "error",
                attemptedSteps: 0,
                saveReopenStable: false,
                elapsedMs: 0,
                error: message,
            });
        }
        if ((index + 1) % 10 === 0 || index + 1 === workerCases.length) {
            console.log(`CAPABILITY_WORKER worker=${workerIndex}`
                + ` cases=${index + 1}/${workerCases.length}`);
        }
    }
    writeFileSync(
        join(runDir, `cases.worker-${workerIndex}.jsonl`),
        caseRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
        "utf8",
    );
    writeFileSync(
        join(runDir, `steps.worker-${workerIndex}.jsonl`),
        stepRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
        "utf8",
    );
};

const assertSafeRunDir = (): void => {
    if (!isAbsolute(runDir)) throw new Error(`run directory must be absolute: ${runDir}`);
    const rel = relative(outputRoot, runDir);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`unsafe run directory: ${runDir}`);
    }
};
const runParent = async (): Promise<void> => {
    assertSafeRunDir();
    if (!existsSync(cofechaExe)) throw new Error(`COFECHA not found: ${cofechaExe}`);
    const { config, manifest, configBytes, manifestBytes } = readInputs();
    const mergeExisting = hasFlag("--merge-existing");
    const existingPlan = mergeExisting
        ? JSON.parse(readFileSync(planPath, "utf8")) as RunPlan
        : null;
    if (existingPlan
        && (existingPlan.configSha256 !== sha256(configBytes)
            || existingPlan.manifestSha256 !== sha256(manifestBytes))) {
        throw new Error("existing run plan input hash mismatch");
    }
    const requestedFamilies = existingPlan?.families
        ?? (valueFor("--families") ?? "Clean,A,B,C,D").split(",")
        .map((value): CapabilityFamily | null => {
            const normalized = value.trim().toLowerCase();
            if (normalized === "clean") return "Clean";
            const upper = normalized.toUpperCase();
            return upper === "A" || upper === "B" || upper === "C" || upper === "D"
                ? upper
                : null;
        })
        .filter((value): value is CapabilityFamily => value !== null);
    const requestedFileIds = new Set((valueFor("--file-ids") ?? "").split(",")
        .map((value) => value.trim().toLowerCase()).filter(Boolean));
    const scenarioIds = new Set((valueFor("--scenario-ids") ?? "").split(",")
        .map((value) => value.trim()).filter(Boolean));
    const requestedCaseIndices = new Set((valueFor("--case-indices") ?? "").split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map(Number)
        .filter((value) => Number.isInteger(value) && value >= 0));
    const maximumTargets = Number(valueFor("--max-targets-per-file"));
    const caseLimit = Number(valueFor("--case-limit"));
    const maximumStepsValue = Number(valueFor("--max-steps"));
    const maxSteps = existingPlan?.maxSteps ?? (Number.isInteger(maximumStepsValue)
        && maximumStepsValue > 0
        ? maximumStepsValue
        : null);
    const requestedWorkers = Number(valueFor("--workers"));
    const workerCount = existingPlan?.workerCount
        ?? (Number.isInteger(requestedWorkers) && requestedWorkers > 0
        ? requestedWorkers
        : Math.max(1, Math.min(
            config.runtime.workers,
            Math.floor(availableParallelism() * 0.75),
        )));
    const targetsByFile = new Map<string, Set<string>>();
    if (Number.isInteger(maximumTargets) && maximumTargets > 0) {
        manifest.files.forEach((file) => {
            targetsByFile.set(file.fileId, new Set([...file.eligibleTargets]
                .sort((left, right) => stableHash(`${config.seed}:${file.fileId}:${left.targetId}`)
                    - stableHash(`${config.seed}:${file.fileId}:${right.targetId}`))
                .slice(0, maximumTargets)
                .map((target) => target.targetId)));
        });
    }
    const existingCaseIds = new Set(existingPlan?.caseIds ?? []);
    let selectedCases = buildCapabilityCases(config, manifest).filter((spec) => existingPlan
        ? existingCaseIds.has(spec.caseId)
        : requestedFamilies.includes(spec.family)
            && (requestedFileIds.size === 0 || requestedFileIds.has(spec.fileId.toLowerCase()))
            && (scenarioIds.size === 0 || scenarioIds.has(spec.scenarioId))
            && (requestedCaseIndices.size === 0 || requestedCaseIndices.has(spec.index))
            && (!targetsByFile.has(spec.fileId)
                || targetsByFile.get(spec.fileId)!.has(spec.targetId)));
    if (Number.isInteger(caseLimit) && caseLimit > 0) selectedCases = selectedCases.slice(0, caseLimit);
    if (selectedCases.length === 0) throw new Error("no cases selected");
    const plan: RunPlan = existingPlan ?? {
        schemaVersion: 1,
        configPath,
        manifestPath,
        configSha256: sha256(configBytes),
        manifestSha256: sha256(manifestBytes),
        families: requestedFamilies,
        caseIds: selectedCases.map((spec) => spec.caseId),
        workerCount,
        maxSteps,
        keepAllCofecha: hasFlag("--keep-all-cofecha"),
        executionGitCommit: currentGitCommit(),
    };
    if (!existingPlan) {
        rmSync(runDir, { recursive: true, force: true });
        mkdirSync(runDir, { recursive: true });
        writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
        writeFileSync(
            join(runDir, "resolved-cases.json"),
            `${JSON.stringify(selectedCases, null, 2)}\n`,
            "utf8",
        );
        console.log(`CAPABILITY_PLAN ${JSON.stringify({
            runDir,
            workers: workerCount,
            families: requestedFamilies,
            cases: selectedCases.length,
            truths: selectedCases.reduce((sum, spec) => sum + spec.truths.length, 0),
            maxSteps,
        })}`);
    } else {
        console.log(`CAPABILITY_MERGE_EXISTING ${JSON.stringify({
            runDir,
            workers: workerCount,
            cases: selectedCases.length,
        })}`);
    }
    const workerPromises = existingPlan ? [] : Array.from(
        { length: workerCount },
        (_, index) => new Promise<void>((
        resolveWorker,
        rejectWorker,
    ) => {
        const workerArgs = [
            "--config", configPath,
            "--manifest", manifestPath,
            "--run-dir", runDir,
            "--output-dir", outputRoot,
            "--plan", planPath,
            "--worker-index", String(index),
            "--cofecha-exe", cofechaExe,
            ...(keepDiagnosisAudits ? ["--keep-diagnosis-audits"] : []),
        ];
        const child = spawn(process.execPath, scriptPath.endsWith(".mjs")
            ? [scriptPath, ...workerArgs]
            : [viteNodePath, scriptPath, "--", ...workerArgs], {
            cwd: repoRoot,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (chunk) => process.stdout.write(chunk));
        child.stderr.on("data", (chunk) => process.stderr.write(chunk));
        child.on("error", rejectWorker);
        child.on("exit", (code) => code === 0
            ? resolveWorker()
            : rejectWorker(new Error(`worker ${index} exited ${code}`)));
        }),
    );
    await Promise.all(workerPromises);
    const readJsonLines = <T>(path: string): T[] => readFileSync(path, "utf8")
        .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
    const cases = Array.from({ length: workerCount }, (_, index) => readJsonLines<CaseRow>(
        join(runDir, `cases.worker-${index}.jsonl`),
    )).flat().sort((left, right) => left.caseIndex - right.caseIndex);
    const steps = Array.from({ length: workerCount }, (_, index) => readJsonLines<StepRow>(
        join(runDir, `steps.worker-${index}.jsonl`),
    )).flat().sort((left, right) => left.caseIndex - right.caseIndex || left.step - right.step);
    const sourceMismatches = manifest.files.flatMap((file) => {
        const actual = sha256Bytes(readFileSync(resolve(manifest.itrdbRoot, file.relativePath)));
        return actual === file.sourceSha256 ? [] : [file.fileId];
    });
    const report = {
        schemaVersion: 1,
        protocolVersion: config.protocolVersion,
        createdAt: new Date().toISOString(),
        runDir,
        gitCommit: plan.executionGitCommit ?? manifest.gitCommit,
        executionGitCommit: plan.executionGitCommit ?? null,
        manifestGitCommit: manifest.gitCommit,
        configSha256: plan.configSha256,
        manifestSha256: plan.manifestSha256,
        sourceFilesUnchanged: sourceMismatches.length === 0,
        sourceMismatches,
        design: config.design ?? null,
        statistics: config.statistics ?? null,
        selectedFamilies: requestedFamilies,
        selectedCases: cases.length,
        errors: cases.filter((row) => row.error !== null).length,
        overall: summarize(cases, steps),
        byFamily: grouped(cases, steps, (row) => row.family),
        byAcceptanceTier: grouped(cases, steps, (row) => row.acceptanceTier),
        byScenario: grouped(cases, steps, (row) => row.scenarioId),
        byFile: grouped(cases, steps, (row) => row.fileId),
        byWholeShift: grouped(
            cases.filter((row) => row.wholeTruthCount > 0),
            steps,
            (row) => String(row.wholeShiftYears),
        ),
        clusteredInferenceByFamily: config.statistics
            ? Object.fromEntries(requestedFamilies.map((family) => [
                    family,
                    clusteredInference(cases, steps, config.statistics!, family),
                ]))
            : null,
        stopReasons: Object.fromEntries(Array.from(new Set(cases.map((row) => row.stopReason)))
            .sort().map((reason) => [reason, cases.filter((row) => row.stopReason === reason).length])),
    };
    writeFileSync(join(runDir, "cases.json"), `${JSON.stringify(cases, null, 2)}\n`, "utf8");
    writeFileSync(join(runDir, "steps.json"), `${JSON.stringify(steps, null, 2)}\n`, "utf8");
    writeCsv(join(runDir, "cases.csv"), cases as unknown as Array<Record<string, unknown>>);
    writeCsv(join(runDir, "steps.csv"), steps as unknown as Array<Record<string, unknown>>);
    writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`ITRDB_OPERATION_CAPABILITY_SUMMARY ${JSON.stringify(report)}`);
};

if (workerIndex === null) await runParent();
else await runWorker();
