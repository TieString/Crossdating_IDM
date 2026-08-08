import { execFileSync, spawn } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
    DiagnosisEvent,
    DiagnosisEventAuditSnapshot,
} from "@/features/crossdating/diagnosis/types";
import {
    createPiecewiseLagMixedCase,
    type PiecewiseLagEventSpec,
    type RwlSeries,
} from "@/features/crossdating/diagnosis/__tests__/rdmFixture";
import {
    deleteYearWithMode,
    insertMissingYearAtSide,
} from "@/features/rwl/edit";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    cloneSite,
    diagnoseTruthBlind,
    loadRwl,
    reopenFormattedSite,
    runCofecha,
    sha256Bytes,
    siteHash,
    snapshotsSemanticallyEqual,
    type CofechaContext,
} from "./legacy-generalization/evaluator";
import type { LegacyDiagnosisSnapshot } from "./legacy-generalization/types";

type UnitEventType = "missingRing" | "falseRing";
type Orientation = "missingThenFalse" | "falseThenMissing";
type PositionStratum = "older" | "middle" | "newer";
type TruthSide = "older" | "newer";

type TruthSpec = {
    truthId: string;
    side: TruthSide;
    eventType: UnitEventType;
    year: number;
    shiftYears: -1 | 1;
};

type ControlSpec = {
    controlId: string;
    targetId: string;
    truth: TruthSpec;
};

type ScenarioSpec = {
    scenarioId: string;
    targetId: string;
    orientation: Orientation;
    spacingYears: number;
    positionStratum: PositionStratum;
    truths: [TruthSpec, TruthSpec];
    controlIds: [string, string];
};

type WorkItem = {
    workIndex: number;
    kind: "clean" | "control" | "scenario";
    itemId: string;
};

type Manifest = {
    schemaVersion: 1;
    createdAt: string;
    inputPath: string;
    sourceSha256: string;
    gitCommit: string;
    truthRoundTripVerified: true;
    falseRingMode: "moderate";
    spacings: number[];
    positions: Array<{ stratum: PositionStratum; fraction: number }>;
    selection: {
        minimumSeriesLength: number;
        requireZeroFreeTarget: true;
        maximumTargets: number;
        selectedTargetIds: string[];
        cleanTargetIds: string[];
    };
    controls: ControlSpec[];
    scenarios: ScenarioSpec[];
    workItems: WorkItem[];
};

type EventPreview = {
    eventType: DiagnosisEvent["eventType"];
    shiftYears: number | null;
    startYear: number;
    endYear: number;
    topYear: number | null;
    lagBefore: number | null;
    lagAfter: number | null;
    score: number;
    scoreMargin: number;
    sources: string[];
    notes: string[];
};

type SnapshotPreview = {
    strict: EventPreview | null;
    review: EventPreview | null;
    reviewStatus: string | null;
    reviewReason: string | null;
    finalReason: string | null;
    referenceMode: string;
    referenceAnchorCount: number;
    candidates: Array<Record<string, unknown>>;
    detectedBeforeFusion: EventPreview[];
    detectedAfterFusion: EventPreview[];
    finalEvents: EventPreview[];
    error: string | null;
};

type SavedStateResult = {
    label: string;
    targetHashBeforeSave: string;
    targetHashAfterReopen: string;
    serializedDataStable: boolean;
    beforeSave: SnapshotPreview;
    afterReopen: SnapshotPreview;
    diagnosisStable: boolean;
    cofechaFlagged: boolean;
    error: string | null;
};

type EventEvaluation = {
    response: boolean;
    operationMatchesAny: boolean;
    windowCoversAny: boolean;
    top1Exact: boolean;
    matchedTruthId: string | null;
    matchedSide: TruthSide | null;
    predictedType: DiagnosisEvent["eventType"] | null;
    predictedShiftYears: number | null;
    windowStart: number | null;
    windowEnd: number | null;
    topYear: number | null;
    partialMisclassification: boolean;
    wholeMisclassification: boolean;
    wrongUnitDirection: boolean;
};

type CleanResult = {
    kind: "clean";
    targetId: string;
    state: SavedStateResult;
};

type ControlResult = {
    kind: "control";
    controlId: string;
    targetId: string;
    truth: TruthSpec;
    state: SavedStateResult;
    evaluation: EventEvaluation;
};

type SerialStepResult = {
    stepIndex: number;
    remainingTruthsBefore: TruthSpec[];
    state: SavedStateResult;
    evaluation: EventEvaluation;
    appliedTruth: TruthSpec | null;
    targetHashAfterApply: string | null;
};

type ScenarioResult = {
    kind: "scenario";
    scenarioId: string;
    targetId: string;
    orientation: Orientation;
    spacingYears: number;
    positionStratum: PositionStratum;
    initialTruths: TruthSpec[];
    controlIds: [string, string];
    steps: SerialStepResult[];
    finalState: SavedStateResult | null;
    recoveredCount: number;
    serialComplete: boolean;
    stopReason: string;
    error: string | null;
};

type WorkerOutput = {
    clean: CleanResult[];
    controls: ControlResult[];
    scenarios: ScenarioResult[];
};

type ExecutedState = {
    result: SavedStateResult;
    reopenedSite: RwlSiteData;
    reviewEvent: DiagnosisEvent | null;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string): string | null => {
    const equals = args.find((argument) => argument.startsWith(`${name}=`));
    if (equals) return equals.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};

const inputPath = resolve(valueFor("--input") ?? "D:/软件测试/co612.rwl");
const outputDir = resolve(
    valueFor("--output-dir")
        ?? "D:/软件测试/co612-operation-composition-results",
);
const runId = valueFor("--run-id") ?? "unit-pulse-composition-baseline";
const runDir = resolve(valueFor("--run-dir") ?? join(outputDir, runId));
const manifestPath = resolve(valueFor("--manifest") ?? join(runDir, "manifest.json"));
const workerIndexValue = valueFor("--worker-index");
const workerIndex = workerIndexValue === null ? null : Number(workerIndexValue);
const workerCountValue = Number(valueFor("--worker-count") ?? valueFor("--workers") ?? 8);
const workerCount = Number.isInteger(workerCountValue) && workerCountValue > 0
    ? workerCountValue
    : 8;
const maximumTargetsValue = Number(valueFor("--max-targets") ?? 10);
const maximumTargets = Number.isInteger(maximumTargetsValue) && maximumTargetsValue > 0
    ? maximumTargetsValue
    : 10;
const minimumSeriesLength = Number(valueFor("--minimum-series-length") ?? 180);
const spacings = (valueFor("--spacings") ?? "2,9,21")
    .split(",")
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 2);
const positions: Manifest["positions"] = [
    { stratum: "older", fraction: 0.25 },
    { stratum: "middle", fraction: 0.5 },
    { stratum: "newer", fraction: 0.75 },
];
const cofechaExe = resolve(valueFor("--cofecha-exe") ?? fileURLToPath(new URL(
    "../src-tauri/bin/cofecha-x86_64-pc-windows-msvc.exe",
    import.meta.url,
)));
const timeoutSeconds = Math.max(10, Number(valueFor("--timeout-seconds") ?? 30));

const assertSafeRunDir = (): void => {
    if (!isAbsolute(runDir)) throw new Error(`run directory must be absolute: ${runDir}`);
    const rel = relative(outputDir, runDir);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`unsafe run directory: ${runDir}`);
    }
};

const eventShift = (event: DiagnosisEvent | null): number | null => {
    if (!event) return null;
    if (event.eventType === "missingRing") return -1;
    if (event.eventType === "falseRing") return 1;
    return event.shiftYears ?? null;
};

const auditEventPreview = (event: DiagnosisEventAuditSnapshot): EventPreview => ({
    eventType: event.eventType,
    shiftYears: event.eventType === "missingRing"
        ? -1
        : event.eventType === "falseRing"
            ? 1
            : event.shiftYears,
    startYear: event.startYear,
    endYear: event.endYear,
    topYear: event.topYear,
    lagBefore: event.lagBefore,
    lagAfter: event.lagAfter,
    score: event.score,
    scoreMargin: event.scoreMargin,
    sources: event.algorithmSources,
    notes: event.notes,
});

const eventPreview = (event: DiagnosisEvent | null): EventPreview | null => event ? ({
    eventType: event.eventType,
    shiftYears: eventShift(event),
    startYear: event.startYear,
    endYear: event.endYear,
    topYear: event.rankedYears[0]?.year ?? null,
    lagBefore: event.evidence.lagBefore,
    lagAfter: event.evidence.lagAfter,
    score: event.evidence.score,
    scoreMargin: event.evidence.scoreMargin,
    sources: event.evidence.algorithmSources,
    notes: event.evidence.notes,
}) : null;

const snapshotPreview = (snapshot: LegacyDiagnosisSnapshot): SnapshotPreview => ({
    strict: eventPreview(snapshot.strictEvent),
    review: eventPreview(snapshot.reviewEvent),
    reviewStatus: snapshot.reviewDecision?.status ?? null,
    reviewReason: snapshot.reviewDecision?.reason ?? null,
    finalReason: snapshot.audit?.finalReason ?? null,
    referenceMode: snapshot.referenceMode,
    referenceAnchorCount: snapshot.referenceAnchorCount,
    candidates: snapshot.candidates,
    detectedBeforeFusion: snapshot.audit?.detectedBeforeFusion.map(auditEventPreview) ?? [],
    detectedAfterFusion: snapshot.audit?.detectedAfterFusion.map(auditEventPreview) ?? [],
    finalEvents: snapshot.audit?.finalEvents.map(auditEventPreview) ?? [],
    error: snapshot.error,
});

const targetHash = (site: RwlSiteData, targetId: string): string => siteHash(
    new Map([[targetId, new Map(site.get(targetId) ?? [])]]),
);

const makeSavedStateResult = (input: {
    label: string;
    site: RwlSiteData;
    reopenedSite: RwlSiteData;
    targetId: string;
    context: CofechaContext;
    beforeSnapshot: LegacyDiagnosisSnapshot;
    afterSnapshot: LegacyDiagnosisSnapshot;
}): SavedStateResult => {
    const beforeHash = targetHash(input.site, input.targetId);
    const afterHash = targetHash(input.reopenedSite, input.targetId);
    return {
        label: input.label,
        targetHashBeforeSave: beforeHash,
        targetHashAfterReopen: afterHash,
        serializedDataStable: beforeHash === afterHash,
        beforeSave: snapshotPreview(input.beforeSnapshot),
        afterReopen: snapshotPreview(input.afterSnapshot),
        diagnosisStable: snapshotsSemanticallyEqual(
            input.beforeSnapshot,
            input.afterSnapshot,
        ),
        cofechaFlagged: input.context.flaggedIds.some(
            (id) => id.toLowerCase() === input.targetId.toLowerCase(),
        ),
        error: input.beforeSnapshot.error ?? input.afterSnapshot.error,
    };
};

const executeState = async (input: {
    site: RwlSiteData;
    targetId: string;
    label: string;
    workDir: string;
    readResult: Awaited<ReturnType<typeof loadRwl>>["readResult"];
}): Promise<ExecutedState> => {
    const reopenedSite = await reopenFormattedSite(input.site, input.readResult);
    const context = runCofecha({
        siteData: reopenedSite,
        readResult: input.readResult,
        workDir: input.workDir,
        label: input.label,
        cofechaExe,
        timeoutSeconds,
    });
    const beforeSnapshot = diagnoseTruthBlind({
        siteData: input.site,
        targetId: input.targetId,
        context,
        runId: `${input.label}-before`,
    });
    const afterSnapshot = diagnoseTruthBlind({
        siteData: reopenedSite,
        targetId: input.targetId,
        context,
        runId: `${input.label}-after`,
    });
    return {
        result: makeSavedStateResult({
            ...input,
            reopenedSite,
            context,
            beforeSnapshot,
            afterSnapshot,
        }),
        reopenedSite,
        reviewEvent: afterSnapshot.reviewEvent,
    };
};

const evaluateEvent = (
    event: DiagnosisEvent | null,
    truths: readonly TruthSpec[],
): EventEvaluation => {
    const sameOperation = event
        ? truths.filter((truth) => truth.eventType === event.eventType)
        : [];
    const covered = event
        ? sameOperation.filter((truth) => (
            truth.year >= event.startYear && truth.year <= event.endYear
        ))
        : [];
    const topYear = event?.rankedYears[0]?.year ?? null;
    const matched = covered.slice().sort((left, right) => (
        Math.abs(left.year - (topYear ?? left.year))
            - Math.abs(right.year - (topYear ?? right.year))
        || left.year - right.year
    ))[0] ?? null;
    return {
        response: event !== null,
        operationMatchesAny: sameOperation.length > 0,
        windowCoversAny: matched !== null,
        top1Exact: matched !== null && topYear === matched.year,
        matchedTruthId: matched?.truthId ?? null,
        matchedSide: matched?.side ?? null,
        predictedType: event?.eventType ?? null,
        predictedShiftYears: eventShift(event),
        windowStart: event?.startYear ?? null,
        windowEnd: event?.endYear ?? null,
        topYear,
        partialMisclassification: event?.eventType === "partialMove",
        wholeMisclassification: event?.eventType === "wholeSeriesMove",
        wrongUnitDirection: event !== null
            && (event.eventType === "missingRing" || event.eventType === "falseRing")
            && sameOperation.length === 0,
    };
};

const fixtureEvents = (truths: readonly TruthSpec[]): PiecewiseLagEventSpec[] => (
    truths.map((truth) => ({
        eventType: truth.eventType,
        year: truth.year,
        shiftYears: truth.shiftYears,
        falseMode: truth.eventType === "falseRing" ? "moderate" : undefined,
    }))
);

const applyConfirmedTruth = (
    site: RwlSiteData,
    targetId: string,
    truth: TruthSpec,
): RwlSiteData => {
    const next = cloneSite(site);
    const current = next.get(targetId);
    if (!current) throw new Error(`target missing while applying ${truth.truthId}`);
    next.set(targetId, truth.eventType === "missingRing"
        ? insertMissingYearAtSide(current, truth.year, "right")
        : deleteYearWithMode(current, truth.year, "direct", "right"));
    return next;
};

const transformRemainingTruths = (
    truths: readonly TruthSpec[],
    applied: TruthSpec,
): TruthSpec[] => truths
    .filter((truth) => truth.truthId !== applied.truthId)
    .map((truth) => ({
        ...truth,
        year: truth.year < applied.year
            ? truth.year + (applied.eventType === "missingRing" ? -1 : 1)
            : truth.year,
    }));

const assertTruthRoundTrip = (
    source: RwlSeries,
    truths: readonly TruthSpec[],
): void => {
    const verifyOrder = (truthIds: string[]): void => {
        const observedSource = new Map(Array.from(source.valuesByYear).filter(([, value]) => (
            value !== -9999
        )));
        let site: RwlSiteData = new Map([[
            source.id,
            createPiecewiseLagMixedCase(source, fixtureEvents(truths)).corrupted,
        ]]);
        let remaining = truths.map((truth) => ({ ...truth }));
        truthIds.forEach((truthId) => {
            const truth = remaining.find((candidate) => candidate.truthId === truthId);
            if (!truth) throw new Error(`round-trip truth missing: ${truthId}`);
            site = applyConfirmedTruth(site, source.id, truth);
            remaining = transformRemainingTruths(remaining, truth);
        });
        const final = site.get(source.id);
        if (!final || remaining.length !== 0 || final.size !== observedSource.size) {
            const finalYears = final ? Array.from(final.keys()) : [];
            throw new Error([
                `round-trip shape mismatch: ${source.id}`,
                `order=${truthIds.join(",")}`,
                `sourceSize=${observedSource.size}`,
                `finalSize=${final?.size ?? 0}`,
                `sourceRange=${source.startYear}-${source.endYear}`,
                `finalRange=${Math.min(...finalYears)}-${Math.max(...finalYears)}`,
                `remaining=${remaining.length}`,
            ].join(" "));
        }
        const zeros = Array.from(final).filter(([, value]) => value === 0);
        if (zeros.length !== 1) {
            throw new Error(`round-trip zero mismatch: ${source.id}:${zeros.length}`);
        }
        const mismatch = Array.from(final).find(([year, value]) => (
            value !== 0 && observedSource.get(year) !== value
        ));
        if (mismatch) {
            throw new Error(`round-trip value mismatch: ${source.id}:${mismatch[0]}`);
        }
    };
    verifyOrder(["older", "newer"]);
    verifyOrder(["newer", "older"]);
};

const buildManifest = async (): Promise<Manifest> => {
    const loaded = await loadRwl(inputPath, "tucson-auto");
    const allTargets = Array.from(loaded.series.values())
        .sort((left, right) => left.id.localeCompare(right.id));
    const selected = allTargets
        .filter((series) => series.zeroCount === 0 && series.length >= minimumSeriesLength)
        .slice(0, maximumTargets);
    if (selected.length === 0) throw new Error("no zero-free targets satisfy selection");

    const controlById = new Map<string, ControlSpec>();
    const scenarios: ScenarioSpec[] = [];
    const addControl = (targetId: string, truth: TruthSpec): string => {
        const controlId = `${targetId}:${truth.eventType}:${truth.year}`;
        if (!controlById.has(controlId)) {
            controlById.set(controlId, { controlId, targetId, truth });
        }
        return controlId;
    };

    selected.forEach((series) => {
        positions.forEach(({ stratum, fraction }) => {
            spacings.forEach((spacingYears) => {
                const center = Math.round(
                    series.startYear + (series.endYear - series.startYear) * fraction,
                );
                const olderYear = center - Math.floor(spacingYears / 2);
                const newerYear = olderYear + spacingYears;
                if (olderYear < series.startYear + 30
                    || newerYear > series.endYear - 30
                    || !series.valuesByYear.has(olderYear)
                    || !series.valuesByYear.has(newerYear)) return;
                (["missingThenFalse", "falseThenMissing"] as const).forEach((orientation) => {
                    const olderType: UnitEventType = orientation === "missingThenFalse"
                        ? "missingRing"
                        : "falseRing";
                    const newerType: UnitEventType = orientation === "missingThenFalse"
                        ? "falseRing"
                        : "missingRing";
                    const truths: [TruthSpec, TruthSpec] = [{
                        truthId: "older",
                        side: "older",
                        eventType: olderType,
                        year: olderYear,
                        shiftYears: olderType === "missingRing" ? -1 : 1,
                    }, {
                        truthId: "newer",
                        side: "newer",
                        eventType: newerType,
                        year: newerYear,
                        shiftYears: newerType === "missingRing" ? -1 : 1,
                    }];
                    const controlIds = truths.map((truth) => (
                        addControl(series.id, truth)
                    )) as [string, string];
                    assertTruthRoundTrip(series, truths);
                    scenarios.push({
                        scenarioId: [
                            series.id,
                            orientation,
                            `gap${spacingYears}`,
                            stratum,
                        ].join(":"),
                        targetId: series.id,
                        orientation,
                        spacingYears,
                        positionStratum: stratum,
                        truths,
                        controlIds,
                    });
                });
            });
        });
    });

    const controls = Array.from(controlById.values()).sort((left, right) => (
        left.controlId.localeCompare(right.controlId)
    ));
    let workIndex = 0;
    const workItems: WorkItem[] = [
        ...allTargets.map((series) => ({
            workIndex: workIndex++,
            kind: "clean" as const,
            itemId: series.id,
        })),
        ...controls.map((control) => ({
            workIndex: workIndex++,
            kind: "control" as const,
            itemId: control.controlId,
        })),
        ...scenarios.map((scenario) => ({
            workIndex: workIndex++,
            kind: "scenario" as const,
            itemId: scenario.scenarioId,
        })),
    ];
    const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
    }).trim();
    return {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        inputPath,
        sourceSha256: loaded.sourceSha256,
        gitCommit,
        truthRoundTripVerified: true,
        falseRingMode: "moderate",
        spacings,
        positions,
        selection: {
            minimumSeriesLength,
            requireZeroFreeTarget: true,
            maximumTargets,
            selectedTargetIds: selected.map((series) => series.id),
            cleanTargetIds: allTargets.map((series) => series.id),
        },
        controls,
        scenarios,
        workItems,
    };
};

const executeWithSharedContext = (input: {
    site: RwlSiteData;
    reopenedSite: RwlSiteData;
    targetId: string;
    label: string;
    context: CofechaContext;
}): ExecutedState => {
    const beforeSnapshot = diagnoseTruthBlind({
        siteData: input.site,
        targetId: input.targetId,
        context: input.context,
        runId: `${input.label}-before`,
    });
    const afterSnapshot = diagnoseTruthBlind({
        siteData: input.reopenedSite,
        targetId: input.targetId,
        context: input.context,
        runId: `${input.label}-after`,
    });
    return {
        result: makeSavedStateResult({
            ...input,
            beforeSnapshot,
            afterSnapshot,
        }),
        reopenedSite: input.reopenedSite,
        reviewEvent: afterSnapshot.reviewEvent,
    };
};

const runWorker = async (): Promise<void> => {
    if (workerIndex === null) throw new Error("worker index required");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    const loaded = await loadRwl(manifest.inputPath, "tucson-auto");
    if (loaded.sourceSha256 !== manifest.sourceSha256) throw new Error("source hash changed");
    const workerDir = join(runDir, "workers", `worker-${workerIndex}`);
    mkdirSync(workerDir, { recursive: true });
    const assigned = manifest.workItems.filter((item) => (
        item.workIndex % workerCount === workerIndex
    ));
    const output: WorkerOutput = { clean: [], controls: [], scenarios: [] };
    const controlById = new Map(manifest.controls.map((item) => [item.controlId, item]));
    const scenarioById = new Map(manifest.scenarios.map((item) => [item.scenarioId, item]));

    const cleanItems = assigned.filter((item) => item.kind === "clean");
    if (cleanItems.length > 0) {
        const cleanReopened = await reopenFormattedSite(loaded.siteData, loaded.readResult);
        const cleanContext = runCofecha({
            siteData: cleanReopened,
            readResult: loaded.readResult,
            workDir: workerDir,
            label: "clean-shared",
            cofechaExe,
            timeoutSeconds,
        });
        cleanItems.forEach((item) => {
            const state = executeWithSharedContext({
                site: loaded.siteData,
                reopenedSite: cleanReopened,
                targetId: item.itemId,
                label: `clean-${item.workIndex}`,
                context: cleanContext,
            });
            output.clean.push({ kind: "clean", targetId: item.itemId, state: state.result });
            console.log(`worker=${workerIndex} work=${item.workIndex + 1}/${manifest.workItems.length}`);
        });
    }

    for (const item of assigned.filter((candidate) => candidate.kind !== "clean")) {
        if (item.kind === "control") {
            const spec = controlById.get(item.itemId);
            if (!spec) throw new Error(`control missing: ${item.itemId}`);
            const source = loaded.series.get(spec.targetId);
            if (!source) throw new Error(`target missing: ${spec.targetId}`);
            const site = cloneSite(loaded.siteData);
            site.set(spec.targetId, createPiecewiseLagMixedCase(
                source,
                fixtureEvents([spec.truth]),
            ).corrupted);
            const state = await executeState({
                site,
                targetId: spec.targetId,
                label: `control-${item.workIndex}`,
                workDir: workerDir,
                readResult: loaded.readResult,
            });
            output.controls.push({
                kind: "control",
                controlId: spec.controlId,
                targetId: spec.targetId,
                truth: spec.truth,
                state: state.result,
                evaluation: evaluateEvent(state.reviewEvent, [spec.truth]),
            });
        } else {
            const spec = scenarioById.get(item.itemId);
            if (!spec) throw new Error(`scenario missing: ${item.itemId}`);
            const source = loaded.series.get(spec.targetId);
            if (!source) throw new Error(`target missing: ${spec.targetId}`);
            let currentSite = cloneSite(loaded.siteData);
            currentSite.set(spec.targetId, createPiecewiseLagMixedCase(
                source,
                fixtureEvents(spec.truths),
            ).corrupted);
            let remainingTruths = spec.truths.map((truth) => ({ ...truth }));
            const steps: SerialStepResult[] = [];
            let finalState: SavedStateResult | null = null;
            let stopReason = "complete";
            let error: string | null = null;
            try {
                for (let stepIndex = 0; stepIndex < spec.truths.length; stepIndex += 1) {
                    const state = await executeState({
                        site: currentSite,
                        targetId: spec.targetId,
                        label: `scenario-${item.workIndex}-step-${stepIndex}`,
                        workDir: workerDir,
                        readResult: loaded.readResult,
                    });
                    const evaluation = evaluateEvent(state.reviewEvent, remainingTruths);
                    const appliedTruth = remainingTruths.find(
                        (truth) => truth.truthId === evaluation.matchedTruthId,
                    ) ?? null;
                    let targetHashAfterApply: string | null = null;
                    steps.push({
                        stepIndex,
                        remainingTruthsBefore: remainingTruths.map((truth) => ({ ...truth })),
                        state: state.result,
                        evaluation,
                        appliedTruth,
                        targetHashAfterApply,
                    });
                    if (!appliedTruth) {
                        stopReason = !evaluation.response
                            ? `step${stepIndex}:refused`
                            : evaluation.operationMatchesAny
                                ? `step${stepIndex}:window_miss`
                                : `step${stepIndex}:operation_mismatch`;
                        break;
                    }
                    currentSite = applyConfirmedTruth(
                        state.reopenedSite,
                        spec.targetId,
                        appliedTruth,
                    );
                    targetHashAfterApply = targetHash(currentSite, spec.targetId);
                    steps[steps.length - 1].targetHashAfterApply = targetHashAfterApply;
                    remainingTruths = transformRemainingTruths(
                        remainingTruths,
                        appliedTruth,
                    );
                }
                if (remainingTruths.length === 0) {
                    const final = await executeState({
                        site: currentSite,
                        targetId: spec.targetId,
                        label: `scenario-${item.workIndex}-final`,
                        workDir: workerDir,
                        readResult: loaded.readResult,
                    });
                    finalState = final.result;
                }
            } catch (caught) {
                error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
                stopReason = "error";
            }
            output.scenarios.push({
                kind: "scenario",
                scenarioId: spec.scenarioId,
                targetId: spec.targetId,
                orientation: spec.orientation,
                spacingYears: spec.spacingYears,
                positionStratum: spec.positionStratum,
                initialTruths: spec.truths,
                controlIds: spec.controlIds,
                steps,
                finalState,
                recoveredCount: spec.truths.length - remainingTruths.length,
                serialComplete: remainingTruths.length === 0,
                stopReason,
                error,
            });
        }
        console.log(`worker=${workerIndex} work=${item.workIndex + 1}/${manifest.workItems.length}`);
    }
    writeFileSync(
        join(runDir, `results.worker-${workerIndex}-of-${workerCount}.json`),
        JSON.stringify(output, null, 2),
        "utf8",
    );
};

const rate = (count: number, total: number): number | null => total > 0
    ? count / total
    : null;

const histogram = (values: unknown[]): Record<string, number> => {
    const keys = values.map((value) => String(value));
    return Object.fromEntries(Array.from(new Set(keys)).sort().map((key) => [
        key,
        keys.filter((value) => value === key).length,
    ]));
};

const csvEscape = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const writeCsv = (path: string, rows: Array<Record<string, unknown>>): void => {
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    writeFileSync(path, [
        columns.join(","),
        ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
    ].join("\n"), "utf8");
};

type ScenarioRow = {
    scenarioId: string;
    targetId: string;
    orientation: Orientation;
    spacingYears: number;
    positionStratum: PositionStratum;
    controlsBothCorrect: boolean;
    initialResponse: boolean;
    initialOperationCorrect: boolean;
    initialWindowCovered: boolean;
    initialTop1: boolean;
    initialMatchedSide: TruthSide | null;
    initialPredictedType: DiagnosisEvent["eventType"] | null;
    initialPartialMisclassification: boolean;
    initialWholeMisclassification: boolean;
    initialWrongUnitDirection: boolean;
    secondEligible: boolean;
    secondOperationCorrect: boolean;
    secondWindowCovered: boolean;
    secondTop1: boolean;
    serialComplete: boolean;
    recoveredCount: number;
    finalResidualResponse: boolean | null;
    allSaveReopenStable: boolean;
    stopReason: string;
    error: string | null;
};

const summarizeRows = (rows: ScenarioRow[]) => {
    const controlsBoth = rows.filter((row) => row.controlsBothCorrect);
    const secondEligible = rows.filter((row) => row.secondEligible);
    const completed = rows.filter((row) => row.serialComplete);
    return {
        scenarios: rows.length,
        controlsBothCorrect: controlsBoth.length,
        initialResponseRate: rate(rows.filter((row) => row.initialResponse).length, rows.length),
        initialOperationCorrectRate: rate(
            rows.filter((row) => row.initialOperationCorrect).length,
            rows.length,
        ),
        initialWindowCoverageRate: rate(
            rows.filter((row) => row.initialWindowCovered).length,
            rows.length,
        ),
        initialTop1Rate: rate(rows.filter((row) => row.initialTop1).length, rows.length),
        interactionFailureRate: rate(
            controlsBoth.filter((row) => !row.initialWindowCovered).length,
            controlsBoth.length,
        ),
        initialPartialMisclassificationRate: rate(
            rows.filter((row) => row.initialPartialMisclassification).length,
            rows.length,
        ),
        initialWholeMisclassificationRate: rate(
            rows.filter((row) => row.initialWholeMisclassification).length,
            rows.length,
        ),
        initialWrongUnitDirectionRate: rate(
            rows.filter((row) => row.initialWrongUnitDirection).length,
            rows.length,
        ),
        firstMatchedSideHistogram: histogram(rows.map((row) => row.initialMatchedSide)),
        initialPredictedTypeHistogram: histogram(
            rows.map((row) => row.initialPredictedType),
        ),
        secondEligible: secondEligible.length,
        secondWindowCoverageRate: rate(
            secondEligible.filter((row) => row.secondWindowCovered).length,
            secondEligible.length,
        ),
        serialCompleteRate: rate(completed.length, rows.length),
        serialCompleteWhenControlsBothCorrectRate: rate(
            controlsBoth.filter((row) => row.serialComplete).length,
            controlsBoth.length,
        ),
        finalResidualResponseRate: rate(
            completed.filter((row) => row.finalResidualResponse).length,
            completed.length,
        ),
        saveReopenStableRate: rate(
            rows.filter((row) => row.allSaveReopenStable).length,
            rows.length,
        ),
        stopReasonHistogram: histogram(rows.map((row) => row.stopReason)),
        errors: rows.filter((row) => row.error !== null).length,
    };
};

const aggregate = (manifest: Manifest): void => {
    const outputs = Array.from({ length: workerCount }, (_, index) => (
        JSON.parse(readFileSync(
            join(runDir, `results.worker-${index}-of-${workerCount}.json`),
            "utf8",
        )) as WorkerOutput
    ));
    const clean = outputs.flatMap((output) => output.clean)
        .sort((left, right) => left.targetId.localeCompare(right.targetId));
    const controls = outputs.flatMap((output) => output.controls)
        .sort((left, right) => left.controlId.localeCompare(right.controlId));
    const scenarios = outputs.flatMap((output) => output.scenarios)
        .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId));
    if (clean.length !== manifest.selection.cleanTargetIds.length) {
        throw new Error(`clean count mismatch: ${clean.length}`);
    }
    if (controls.length !== manifest.controls.length) {
        throw new Error(`control count mismatch: ${controls.length}`);
    }
    if (scenarios.length !== manifest.scenarios.length) {
        throw new Error(`scenario count mismatch: ${scenarios.length}`);
    }
    const controlById = new Map(controls.map((control) => [control.controlId, control]));
    const rows: ScenarioRow[] = scenarios.map((scenario) => {
        const initial = scenario.steps[0]?.evaluation;
        const second = scenario.steps[1]?.evaluation;
        const controlResults = scenario.controlIds.map((id) => controlById.get(id));
        const controlsBothCorrect = controlResults.every((control) => (
            control?.evaluation.windowCoversAny === true
        ));
        const stateResults = [
            ...scenario.steps.map((step) => step.state),
            ...(scenario.finalState ? [scenario.finalState] : []),
        ];
        return {
            scenarioId: scenario.scenarioId,
            targetId: scenario.targetId,
            orientation: scenario.orientation,
            spacingYears: scenario.spacingYears,
            positionStratum: scenario.positionStratum,
            controlsBothCorrect,
            initialResponse: initial?.response ?? false,
            initialOperationCorrect: initial?.operationMatchesAny ?? false,
            initialWindowCovered: initial?.windowCoversAny ?? false,
            initialTop1: initial?.top1Exact ?? false,
            initialMatchedSide: initial?.matchedSide ?? null,
            initialPredictedType: initial?.predictedType ?? null,
            initialPartialMisclassification: initial?.partialMisclassification ?? false,
            initialWholeMisclassification: initial?.wholeMisclassification ?? false,
            initialWrongUnitDirection: initial?.wrongUnitDirection ?? false,
            secondEligible: scenario.steps.length >= 2,
            secondOperationCorrect: second?.operationMatchesAny ?? false,
            secondWindowCovered: second?.windowCoversAny ?? false,
            secondTop1: second?.top1Exact ?? false,
            serialComplete: scenario.serialComplete,
            recoveredCount: scenario.recoveredCount,
            finalResidualResponse: scenario.finalState
                ? scenario.finalState.afterReopen.review !== null
                : null,
            allSaveReopenStable: stateResults.every((state) => (
                state.serializedDataStable && state.diagnosisStable
            )),
            stopReason: scenario.stopReason,
            error: scenario.error,
        };
    });
    const sourceSha256After = sha256Bytes(readFileSync(manifest.inputPath));
    const report = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        runDir,
        sourceSha256Before: manifest.sourceSha256,
        sourceSha256After,
        sourceUnchanged: sourceSha256After === manifest.sourceSha256,
        gitCommit: manifest.gitCommit,
        truthRoundTripVerified: manifest.truthRoundTripVerified,
        workers: workerCount,
        selectedTargets: manifest.selection.selectedTargetIds,
        spacings: manifest.spacings,
        positions: manifest.positions,
        uniqueDiagnosisStates: clean.length
            + controls.length
            + scenarios.reduce((sum, scenario) => (
                sum + scenario.steps.length + (scenario.finalState ? 1 : 0)
            ), 0),
        clean: {
            cases: clean.length,
            reviewFalsePositiveRate: rate(
                clean.filter((row) => row.state.afterReopen.review !== null).length,
                clean.length,
            ),
            saveReopenStableRate: rate(
                clean.filter((row) => (
                    row.state.serializedDataStable && row.state.diagnosisStable
                )).length,
                clean.length,
            ),
        },
        controls: {
            cases: controls.length,
            operationCorrectRate: rate(
                controls.filter((row) => row.evaluation.operationMatchesAny).length,
                controls.length,
            ),
            windowCoverageRate: rate(
                controls.filter((row) => row.evaluation.windowCoversAny).length,
                controls.length,
            ),
            top1Rate: rate(
                controls.filter((row) => row.evaluation.top1Exact).length,
                controls.length,
            ),
            partialMisclassificationRate: rate(
                controls.filter((row) => row.evaluation.partialMisclassification).length,
                controls.length,
            ),
        },
        overall: summarizeRows(rows),
        byOrientation: Object.fromEntries(
            (["missingThenFalse", "falseThenMissing"] as const).map((orientation) => [
                orientation,
                summarizeRows(rows.filter((row) => row.orientation === orientation)),
            ]),
        ),
        bySpacing: Object.fromEntries(manifest.spacings.map((spacing) => [
            String(spacing),
            summarizeRows(rows.filter((row) => row.spacingYears === spacing)),
        ])),
        byPosition: Object.fromEntries(manifest.positions.map(({ stratum }) => [
            stratum,
            summarizeRows(rows.filter((row) => row.positionStratum === stratum)),
        ])),
    };
    writeFileSync(join(runDir, "clean.json"), JSON.stringify(clean, null, 2), "utf8");
    writeFileSync(join(runDir, "controls.json"), JSON.stringify(controls, null, 2), "utf8");
    writeFileSync(join(runDir, "scenarios.json"), JSON.stringify(scenarios, null, 2), "utf8");
    writeFileSync(join(runDir, "scenario-rows.json"), JSON.stringify(rows, null, 2), "utf8");
    writeCsv(join(runDir, "scenario-rows.csv"), rows as unknown as Array<Record<string, unknown>>);
    writeFileSync(join(runDir, "summary.json"), JSON.stringify(report, null, 2), "utf8");
    console.log(`CO612_UNIT_PULSE_SUMMARY ${JSON.stringify(report)}`);
};

const runParent = async (): Promise<void> => {
    assertSafeRunDir();
    if (!existsSync(inputPath)) throw new Error(`input missing: ${inputPath}`);
    if (!existsSync(cofechaExe)) throw new Error(`COFECHA missing: ${cofechaExe}`);
    if (spacings.length === 0) throw new Error("at least one spacing is required");
    rmSync(runDir, { force: true, recursive: true });
    mkdirSync(runDir, { recursive: true });
    const manifest = await buildManifest();
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const viteNode = resolve(repoRoot, "node_modules/vite-node/vite-node.mjs");
    await Promise.all(Array.from({ length: workerCount }, (_, index) => (
        new Promise<void>((resolveWorker, rejectWorker) => {
            const child = spawn(process.execPath, [
                viteNode,
                scriptPath,
                "--",
                "--manifest", manifestPath,
                "--run-dir", runDir,
                "--worker-index", String(index),
                "--worker-count", String(workerCount),
                "--cofecha-exe", cofechaExe,
                "--timeout-seconds", String(timeoutSeconds),
            ], {
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
        })
    )));
    aggregate(manifest);
};

if (workerIndex === null) {
    await runParent();
} else {
    await runWorker();
}
