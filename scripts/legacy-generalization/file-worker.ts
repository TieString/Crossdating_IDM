import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareBootstrapReviewQueueCandidates } from "@/features/crossdating/diagnosis/bootstrapEvaluation";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis/types";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    applyConfirmedEvent,
    assertFrozenConfig,
    buildScenarioSite,
    canonicalEvent,
    canonicalSnapshot,
    cloneSite,
    computeFileInterseries,
    computeQualityMetrics,
    diagnoseTruthBlind,
    loadRwl,
    makeCaseRow,
    matchTruthAfterDiagnosis,
    reopenFormattedSite,
    runCofecha,
    sha256Bytes,
    siteHash,
    snapshotsSemanticallyEqual,
} from "./evaluator";
import type {
    LegacyCaseRow,
    LegacyConfig,
    LegacyDiagnosisSnapshot,
    LegacyEventRow,
    LegacyFileWorkerOutput,
    LegacyManifest,
    LegacyQualityMetrics,
    LegacyScenarioPlan,
    LegacySerialEventState,
    LegacySerialRound,
    LegacyTruthSpec,
} from "./types";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const hasFlag = (name: string): boolean => args.includes(name);
const configPath = resolve(valueFor("--config")
    ?? "docs/benchmarks/legacy-cross-file-generalization-config-v1.json");
const manifestPath = resolve(valueFor("--manifest")
    ?? "docs/benchmarks/legacy-cross-file-generalization-manifest-v1.json");
const fileId = valueFor("--file-id");
const phase = valueFor("--phase") as "single" | "serial" | null;
const outputPath = valueFor("--output");
const workDir = resolve(valueFor("--work-dir") ?? "legacy-generalization-worker-temp");
const quick = hasFlag("--quick");
const onlySeriesId = valueFor("--series-id");
const onlyScenarioKind = valueFor("--scenario-kind");
const maxRoundsOverride = Number(valueFor("--max-rounds"));
if (!fileId || !phase || !outputPath || !["single", "serial"].includes(phase)) {
    throw new Error("worker requires --file-id, --phase single|serial and --output");
}
const configBytes = readFileSync(configPath);
const config = JSON.parse(configBytes.toString("utf8")) as LegacyConfig;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as LegacyManifest;
assertFrozenConfig(config, manifest.configHash, configBytes);
const file = manifest.files.find((row) => row.fileId === fileId);
if (!file) throw new Error(`file not in manifest: ${fileId}`);
const cofechaExe = /^[A-Za-z]:[\\/]/.test(config.paths.cofechaSidecar)
    ? resolve(config.paths.cofechaSidecar)
    : resolve(repoRoot, config.paths.cofechaSidecar);
if (!existsSync(cofechaExe)) throw new Error(`COFECHA missing: ${cofechaExe}`);
mkdirSync(dirname(resolve(outputPath)), { recursive: true });
const workDirMarker = join(workDir, ".legacy-generalization-workdir");
if (existsSync(workDir) && !existsSync(workDirMarker)) {
    throw new Error(`refusing to replace unowned worker directory: ${workDir}`);
}
rmSync(workDir, { force: true, recursive: true });
mkdirSync(workDir, { recursive: true });
writeFileSync(workDirMarker, `${fileId}:${phase}\n`, "utf8");

const startedAt = new Date().toISOString();
const startedMs = Date.now();
const loaded = await loadRwl(file.path, file.rwlFormat);
if (loaded.sourceSha256 !== file.sha256) {
    throw new Error(`source hash mismatch: ${loaded.sourceSha256} != ${file.sha256}`);
}
const cases: LegacyCaseRow[] = [];
const events: LegacyEventRow[] = [];
const serialRounds: LegacySerialRound[] = [];
const errors: Array<{ scope: string; error: string }> = [];
let saveReopenDifferentialCount = 0;

const cleanContext = runCofecha({
    siteData: loaded.siteData,
    readResult: loaded.readResult,
    workDir,
    label: "clean",
    cofechaExe,
    timeoutSeconds: config.runtime.cofechaTimeoutSeconds,
});
const fileInterseries = computeFileInterseries(loaded.siteData);
const qualityByTarget: Record<string, LegacyQualityMetrics> = {};
const cleanSnapshotByTarget = new Map<string, LegacyDiagnosisSnapshot>();
for (const target of file.targets) {
    const snapshot = diagnoseTruthBlind({
        siteData: loaded.siteData,
        targetId: target.targetId,
        context: cleanContext,
        runId: `${file.fileId}-quality`,
    });
    cleanSnapshotByTarget.set(target.targetId, snapshot);
    qualityByTarget[target.targetId] = computeQualityMetrics({
        cleanSite: loaded.siteData,
        targetId: target.targetId,
        cleanSnapshot: snapshot,
        context: cleanContext,
        fileInterseries,
    });
}

const appendEventRows = (
    scenario: LegacyScenarioPlan,
    pair: "before-save" | "after-reopen",
    snapshot: LegacyDiagnosisSnapshot,
): void => {
    if (snapshot.strictEvent) events.push({
        caseId: `${scenario.scenarioId}:${pair}`,
        fileId: file.fileId,
        seriesId: scenario.targetId,
        scenarioId: scenario.scenarioId,
        scenarioPair: pair,
        sourceLayer: "strict",
        event: snapshot.strictEvent,
    });
    if (snapshot.reviewEvent) events.push({
        caseId: `${scenario.scenarioId}:${pair}`,
        fileId: file.fileId,
        seriesId: scenario.targetId,
        scenarioId: scenario.scenarioId,
        scenarioPair: pair,
        sourceLayer: "review",
        event: snapshot.reviewEvent,
    });
};

const snapshotWithoutPrimary = (
    snapshot: LegacyDiagnosisSnapshot,
): LegacyDiagnosisSnapshot => ({
    ...snapshot,
    strictEvent: null,
    reviewEvent: null,
});

const firstSiteDifference = (
    before: RwlSiteData,
    after: RwlSiteData,
): string => {
    const ids = Array.from(new Set([...before.keys(), ...after.keys()])).sort();
    for (const seriesId of ids) {
        const left = before.get(seriesId);
        const right = after.get(seriesId);
        if (!left || !right) return `${seriesId}:series_presence`;
        const years = Array.from(new Set([...left.keys(), ...right.keys()]))
            .sort((a, b) => a - b);
        for (const year of years) {
            if (left.get(year) !== right.get(year)) {
                return `${seriesId}:${year}:${String(left.get(year))}->${String(right.get(year))}`;
            }
        }
    }
    return "canonical_hash_only";
};

const appendScenarioCases = (input: {
    scenario: LegacyScenarioPlan;
    pair: "before-save" | "after-reopen";
    snapshot: LegacyDiagnosisSnapshot;
    stable: boolean;
    cofechaFlagged: boolean;
}): void => {
    const { scenario, snapshot } = input;
    if (scenario.truths.length === 0) {
        cases.push(makeCaseRow({
            file,
            scenario,
            pair: input.pair,
            snapshot,
            truth: null,
            quality: qualityByTarget[scenario.targetId],
            saveReopenStable: input.stable,
            cofechaFlagged: input.cofechaFlagged,
        }));
        return;
    }
    const matched = matchTruthAfterDiagnosis(snapshot.reviewEvent, scenario.truths);
    const assigned = matched ?? [...scenario.truths].sort((left, right) => (
        (right.year ?? -Infinity) - (left.year ?? -Infinity)
    ))[0];
    scenario.truths.forEach((truth) => {
        cases.push(makeCaseRow({
            file,
            scenario,
            pair: input.pair,
            snapshot: truth.truthId === assigned.truthId
                ? snapshot
                : snapshotWithoutPrimary(snapshot),
            truth,
            quality: qualityByTarget[scenario.targetId],
            saveReopenStable: input.stable,
            cofechaFlagged: input.cofechaFlagged,
        }));
    });
};

const runSingle = async (): Promise<void> => {
    const quickKinds = new Set([
        "clean",
        "singleMissingRing",
        "singleFalseRing",
        "singlePartialMove",
        "multiDiscreteMissing4",
    ]);
    for (const target of file.targets.filter((row) => (
        onlySeriesId === null || row.targetId === onlySeriesId
    ))) {
        const scenarios = target.scenarios.filter((scenario) => (
            (!quick || quickKinds.has(scenario.kind))
            && (onlyScenarioKind === null || scenario.kind === onlyScenarioKind)
        ));
        for (const scenario of scenarios) {
            try {
                const scenarioSite = buildScenarioSite(
                    loaded.siteData,
                    loaded.series,
                    scenario,
                );
                const context = scenario.kind === "clean"
                    ? cleanContext
                    : runCofecha({
                        siteData: scenarioSite,
                        readResult: loaded.readResult,
                        workDir,
                        label: `single-${createHash("sha256").update(scenario.scenarioId).digest("hex").slice(0, 12)}`,
                        cofechaExe,
                        timeoutSeconds: config.runtime.cofechaTimeoutSeconds,
                    });
                const before = scenario.kind === "clean"
                    ? cleanSnapshotByTarget.get(target.targetId)!
                    : diagnoseTruthBlind({
                        siteData: scenarioSite,
                        targetId: target.targetId,
                        context,
                        runId: `${file.fileId}-${scenario.kind}-before`,
                    });
                const reopenedSite = await reopenFormattedSite(
                    scenarioSite,
                    loaded.readResult,
                );
                if (siteHash(reopenedSite) !== siteHash(scenarioSite)) {
                    throw new Error(
                        `save/reopen changed scenario site data: ${firstSiteDifference(
                            scenarioSite,
                            reopenedSite,
                        )}`,
                    );
                }
                const after = diagnoseTruthBlind({
                    siteData: reopenedSite,
                    targetId: target.targetId,
                    context,
                    runId: `${file.fileId}-${scenario.kind}-after`,
                });
                const stable = snapshotsSemanticallyEqual(before, after);
                if (!stable) {
                    saveReopenDifferentialCount += 1;
                    errors.push({
                        scope: `${scenario.scenarioId}:save-reopen-differential`,
                        error: JSON.stringify({
                            before: canonicalSnapshot(before),
                            after: canonicalSnapshot(after),
                        }),
                    });
                }
                appendEventRows(scenario, "before-save", before);
                appendEventRows(scenario, "after-reopen", after);
                appendScenarioCases({
                    scenario,
                    pair: "before-save",
                    snapshot: before,
                    stable,
                    cofechaFlagged: context.flaggedIds.includes(target.targetId),
                });
                appendScenarioCases({
                    scenario,
                    pair: "after-reopen",
                    snapshot: after,
                    stable,
                    cofechaFlagged: context.flaggedIds.includes(target.targetId),
                });
            } catch (error) {
                errors.push({
                    scope: scenario.scenarioId,
                    error: error instanceof Error ? error.stack ?? error.message : String(error),
                });
            }
        }
    }
};

type MutableTruth = LegacyTruthSpec & {
    seriesId: string;
    scenarioId: string;
    originalYear: number | null;
};

const runSerial = async (): Promise<LegacySerialEventState[]> => {
    const serialStates: LegacySerialEventState[] = [];
    const scenarioKinds = quick
        ? config.injection.serialScenarioOrder.slice(0, 1)
        : config.injection.serialScenarioOrder;
    const configuredMaxRounds = Number.isFinite(maxRoundsOverride) && maxRoundsOverride > 0
        ? maxRoundsOverride
        : config.runtime.maxRounds;
    const maxRounds = quick ? Math.min(2, configuredMaxRounds) : configuredMaxRounds;
    for (const scenarioKind of scenarioKinds) {
        const scenarioBySeries = new Map(file.targets.flatMap((target) => {
            const scenario = target.scenarios.find((row) => row.kind === scenarioKind);
            return scenario ? [[target.targetId, scenario] as const] : [];
        }));
        let site = cloneSite(loaded.siteData);
        scenarioBySeries.forEach((scenario, seriesId) => {
            const one = buildScenarioSite(loaded.siteData, loaded.series, scenario);
            site.set(seriesId, one.get(seriesId)!);
        });
        const remaining = new Map<string, MutableTruth[]>();
        scenarioBySeries.forEach((scenario, seriesId) => {
            remaining.set(seriesId, scenario.truths.map((truth) => ({
                ...truth,
                seriesId,
                scenarioId: `${file.fileId}:serial:${scenarioKind}`,
                originalYear: truth.year,
            })));
        });
        const eventStates = new Map<string, LegacySerialEventState>();
        remaining.forEach((truths, seriesId) => truths.forEach((truth) => {
            const state: LegacySerialEventState = {
                truthId: truth.truthId,
                fileId: file.fileId,
                seriesId,
                scenarioId: truth.scenarioId,
                eventType: truth.eventType,
                truthYear: truth.originalYear,
                truthShiftYears: truth.shiftYears,
                firstResponseRound: null,
                firstResponseOperationCorrect: null,
                firstResponseWindowCovered: null,
                firstResponseTop1Exact: null,
                firstCorrectWindowRound: null,
                firstQueueRound: null,
                confirmedRound: null,
                responseCount: 0,
                directFrontierFailure: false,
                blockedByPriorEvent: false,
                top1AtConfirmation: null,
                windowWidthAtConfirmation: null,
                failureReason: null,
            };
            eventStates.set(truth.truthId, state);
        }));
        const queueRoundBySeries = new Map<string, number>();
        const queueTokenBySeries = new Map<string, string>();
        let recovered = 0;
        let finalStopReason = "max_rounds";
        for (let round = 1; round <= maxRounds; round += 1) {
            const roundStarted = Date.now();
            const stateHashBefore = siteHash(site);
            const activeSeries = Array.from(remaining).filter(([, truths]) => (
                truths.length > 0
            )).map(([seriesId]) => seriesId).sort();
            if (activeSeries.length === 0) {
                finalStopReason = "all_events_recovered";
                break;
            }
            const context = runCofecha({
                siteData: site,
                readResult: loaded.readResult,
                workDir,
                label: `serial-${scenarioKind}-${String(round).padStart(3, "0")}`,
                cofechaExe,
                timeoutSeconds: config.runtime.cofechaTimeoutSeconds,
            });
            const diagnosed = activeSeries.map((seriesId) => ({
                seriesId,
                snapshot: diagnoseTruthBlind({
                    siteData: site,
                    targetId: seriesId,
                    context,
                    runId: `${file.fileId}-${scenarioKind}-round-${round}`,
                }),
            }));
            const eligible: Array<{
                seriesId: string;
                truth: MutableTruth;
                event: DiagnosisEvent;
                snapshot: LegacyDiagnosisSnapshot;
                queueRound: number;
                top1Exact: boolean;
            }> = [];
            diagnosed.forEach(({ seriesId, snapshot }) => {
                const truths = remaining.get(seriesId)!;
                const event = snapshot.reviewEvent;
                const frontier = [...truths].sort((left, right) => (
                    (right.year ?? -Infinity) - (left.year ?? -Infinity)
                ))[0];
                const matched = matchTruthAfterDiagnosis(event, truths);
                const windowCovered = Boolean(event && matched && (
                    event.eventType === "wholeSeriesMove"
                    || (matched.year !== null
                        && matched.year >= event.startYear
                        && matched.year <= event.endYear)
                ));
                const top1Exact = Boolean(event && matched && matched.year !== null
                    && event.rankedYears[0]?.year === matched.year);
                if (event) {
                    const token = JSON.stringify(canonicalEvent(event));
                    if (queueTokenBySeries.get(seriesId) !== token) {
                        queueTokenBySeries.set(seriesId, token);
                        queueRoundBySeries.set(seriesId, round);
                    }
                    const responseTruth = matched ?? frontier;
                    const state = eventStates.get(responseTruth.truthId)!;
                    state.responseCount += 1;
                    if (state.firstResponseRound === null) {
                        state.firstResponseRound = round;
                        state.firstResponseOperationCorrect = matched !== null;
                        state.firstResponseWindowCovered = windowCovered;
                        state.firstResponseTop1Exact = top1Exact;
                    }
                    state.firstQueueRound ??= queueRoundBySeries.get(seriesId) ?? round;
                }
                if (!event || !matched) return;
                if (!windowCovered) return;
                const state = eventStates.get(matched.truthId)!;
                state.firstCorrectWindowRound ??= round;
                eligible.push({
                    seriesId,
                    truth: matched as MutableTruth,
                    event,
                    snapshot,
                    queueRound: queueRoundBySeries.get(seriesId) ?? round,
                    top1Exact,
                });
            });
            eligible.sort((left, right) => compareBootstrapReviewQueueCandidates({
                seriesId: left.seriesId,
                reviewQueueEnteredRound: left.queueRound,
                reviewStatus: left.snapshot.reviewDecision?.status ?? "refused",
                score: left.event.evidence.score,
            }, {
                seriesId: right.seriesId,
                reviewQueueEnteredRound: right.queueRound,
                reviewStatus: right.snapshot.reviewDecision?.status ?? "refused",
                score: right.event.evidence.score,
            }));
            const selected = eligible[0] ?? null;
            let stateHashAfter = stateHashBefore;
            let stopReason: string | null = null;
            if (selected) {
                const application = applyConfirmedEvent(site, selected.event, selected.truth);
                if (!application.applied) {
                    stopReason = application.reason ?? "application_failed";
                    finalStopReason = stopReason;
                } else {
                    site = await reopenFormattedSite(site, loaded.readResult);
                    stateHashAfter = siteHash(site);
                    const truths = remaining.get(selected.seriesId)!;
                    remaining.set(selected.seriesId, truths.filter((truth) => (
                        truth.truthId !== selected.truth.truthId
                    )));
                    if (selected.event.eventType === "wholeSeriesMove") {
                        remaining.get(selected.seriesId)?.forEach((truth) => {
                            if (truth.year !== null) truth.year += selected.truth.shiftYears;
                        });
                    }
                    const state = eventStates.get(selected.truth.truthId)!;
                    state.confirmedRound = round;
                    state.top1AtConfirmation = selected.top1Exact;
                    state.windowWidthAtConfirmation = selected.event.eventType === "wholeSeriesMove"
                        ? null
                        : selected.event.endYear - selected.event.startYear + 1;
                    recovered += 1;
                    queueRoundBySeries.delete(selected.seriesId);
                    queueTokenBySeries.delete(selected.seriesId);
                }
            } else {
                stopReason = "no_new_correct_review_window_after_full_sweep";
                finalStopReason = stopReason;
            }
            serialRounds.push({
                fileId: file.fileId,
                relativePath: file.relativePath,
                scenarioId: `${file.fileId}:serial:${scenarioKind}`,
                round,
                currentSeries: diagnosed[0]?.seriesId ?? null,
                currentTruthId: diagnosed[0]
                    ? [...(remaining.get(diagnosed[0].seriesId) ?? [])].sort((left, right) => (
                        (right.year ?? -Infinity) - (left.year ?? -Infinity)
                    ))[0]?.truthId ?? null
                    : null,
                remainingEvents: Array.from(remaining.values()).reduce(
                    (sum, truths) => sum + truths.length,
                    0,
                ),
                recoveredEvents: recovered,
                activeSeries: activeSeries.length,
                reviewQueueSize: queueRoundBySeries.size,
                selectedTruthId: selected?.truth.truthId ?? null,
                selectedSeriesId: selected?.seriesId ?? null,
                selectedQueueEnteredRound: selected?.queueRound ?? null,
                selectedOperationCorrect: selected ? true : null,
                selectedWindowCovered: selected ? true : null,
                selectedTop1Exact: selected?.top1Exact ?? null,
                cofechaFlaggedCount: context.flaggedIds.length,
                referenceAnchorCount: selected?.snapshot.referenceAnchorCount ?? null,
                durationMs: Date.now() - roundStarted,
                stateHashBefore,
                stateHashAfter,
                stopReason,
            });
            if (stopReason) break;
            if (Array.from(remaining.values()).every((truths) => truths.length === 0)) {
                finalStopReason = "all_events_recovered";
                break;
            }
        }
        remaining.forEach((truths) => [...truths].sort((left, right) => (
            (right.year ?? -Infinity) - (left.year ?? -Infinity)
        )).forEach((truth, index) => {
            const state = eventStates.get(truth.truthId)!;
            state.blockedByPriorEvent = index > 0;
            state.directFrontierFailure = index === 0;
            state.failureReason = state.directFrontierFailure
                ? finalStopReason
                : "blocked_by_prior_event";
        }));
        serialStates.push(...eventStates.values());
    }
    return serialStates;
};

let serialEvents: LegacySerialEventState[] = [];
try {
    if (phase === "single") await runSingle();
    else serialEvents = await runSerial();
} catch (error) {
    errors.push({
        scope: `${file.fileId}:${phase}`,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
}
const sourceSha256After = sha256Bytes(readFileSync(file.path));
const output: LegacyFileWorkerOutput = {
    schemaVersion: 1,
    phase,
    fileId: file.fileId,
    sourceSha256Before: loaded.sourceSha256,
    sourceSha256After,
    sourceMutationCount: sourceSha256After === loaded.sourceSha256 ? 0 : 1,
    qualityByTarget,
    cases,
    events,
    serialRounds,
    serialEvents,
    saveReopenDifferentialCount,
    errors,
    startedAt,
    completedAt: new Date().toISOString(),
    runtimeMs: Date.now() - startedMs,
};
writeFileSync(resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`, "utf8");
rmSync(workDir, { force: true, recursive: true });
console.log(`LEGACY_FILE_WORKER ${JSON.stringify({
    fileId,
    phase,
    cases: cases.length,
    rounds: serialRounds.length,
    recovered: serialEvents.filter((row) => row.confirmedRound !== null).length,
    sourceMutationCount: output.sourceMutationCount,
    errors: errors.length,
    outputPath: resolve(outputPath),
})}`);
if (errors.length > 0 || output.sourceMutationCount > 0) process.exitCode = 1;
