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
import type { DiagnosisEvent, DiagnosisEventAuditSnapshot } from "@/features/crossdating/diagnosis/types";
import {
    createEndAnchoredFalseRingCase,
    createWholeSeriesMoveCase,
    type FalseRingMode,
    type RwlSeries,
} from "@/features/crossdating/diagnosis/__tests__/rdmFixture";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    cloneSite,
    diagnoseTruthBlind,
    loadRwl,
    reopenFormattedSite,
    runCofecha,
    sha256Bytes,
    siteHash,
} from "./legacy-generalization/evaluator";
import type { LegacyDiagnosisSnapshot } from "./legacy-generalization/types";

type PositionStratum = "older" | "middle" | "newer";
type ScenarioKind = "clean" | "whole" | "false" | "whole-false";

type CaseSpec = {
    index: number;
    caseId: string;
    targetId: string;
    scenarioKind: ScenarioKind;
    wholeShiftYears: number;
    positionStratum: PositionStratum | null;
    finalFalseYear: number | null;
    displayedFalseYear: number | null;
    falseRingMode: FalseRingMode;
};

type CombinationSpec = {
    combinationId: string;
    targetId: string;
    wholeShiftYears: number;
    positionStratum: PositionStratum;
    finalFalseYear: number;
    displayedFalseYear: number;
    cleanCaseId: string;
    wholeCaseId: string;
    falseCaseId: string;
    compositeCaseId: string;
};

type Manifest = {
    schemaVersion: 1;
    createdAt: string;
    inputPath: string;
    sourceSha256: string;
    gitCommit: string;
    falseRingMode: FalseRingMode;
    wholeShifts: number[];
    positions: Array<{ stratum: PositionStratum; fraction: number }>;
    selection: {
        minimumSeriesLength: number;
        requireZeroFreeTarget: true;
        maximumTargets: number;
        selectedTargetIds: string[];
    };
    cases: CaseSpec[];
    combinations: CombinationSpec[];
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
};

type SnapshotPreview = {
    strict: EventPreview | null;
    review: EventPreview | null;
    reviewStatus: string | null;
    reviewReason: string | null;
    finalReason: string | null;
    referenceMode: string;
    referenceAnchorCount: number;
    detectedBeforeFusion: EventPreview[];
    detectedAfterFusion: EventPreview[];
    finalEvents: EventPreview[];
    error: string | null;
};

type CaseResult = {
    caseId: string;
    caseIndex: number;
    targetId: string;
    scenarioKind: ScenarioKind;
    wholeShiftYears: number;
    positionStratum: PositionStratum | null;
    finalFalseYear: number | null;
    displayedFalseYear: number | null;
    targetHash: string;
    residualMatchesFalseControl: boolean | null;
    cofechaFlagged: boolean;
    beforeSave: SnapshotPreview;
    afterReopen: SnapshotPreview;
    saveReopenStable: boolean;
    elapsedMs: number;
    error: string | null;
};

type CombinationRow = {
    combinationId: string;
    targetId: string;
    wholeShiftYears: number;
    positionStratum: PositionStratum;
    finalFalseYear: number;
    displayedFalseYear: number;
    pureWholeCorrect: boolean;
    pureFalseOperationCorrect: boolean;
    pureFalseWindowCovered: boolean;
    controlsBothCorrect: boolean;
    compositeResponse: boolean;
    compositePredictedType: DiagnosisEvent["eventType"] | null;
    compositePredictedShiftYears: number | null;
    compositeStrictWholeExact: boolean;
    compositeInternalWholeExact: boolean;
    reviewDemotedExactWhole: boolean;
    compositeWholeExact: boolean;
    compositeWholeBiasYears: number | null;
    compositeChoseOlderFalseState: boolean;
    wholeToPartialConfusion: boolean;
    wholeToUnitConfusion: boolean;
    interactionFailure: boolean;
    residualMatchesFalseControl: boolean;
    serialWholeThenFalseCorrect: boolean;
    saveReopenStable: boolean;
    cofechaFlagged: boolean;
    referenceAnchorCount: number;
    refusalReason: string | null;
};

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string): string | null => {
    const equals = args.find((argument) => argument.startsWith(`${name}=`));
    if (equals) return equals.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};

const inputPath = resolve(valueFor("--input") ?? "D:/软件测试/co612.rwl");
const outputDir = resolve(
    valueFor("--output-dir") ?? "D:/软件测试/co612-operation-composition-results",
);
const runId = valueFor("--run-id") ?? "whole-false-round1-baseline-2026-08-08";
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
const falseRingMode = (valueFor("--false-ring-mode") ?? "moderate") as FalseRingMode;
const wholeShifts = (valueFor("--whole-shifts") ?? "-5,-1,1,5")
    .split(",")
    .map(Number)
    .filter((value) => Number.isInteger(value) && value !== 0);
const cofechaExe = resolve(valueFor("--cofecha-exe") ?? fileURLToPath(new URL(
    "../src-tauri/bin/cofecha-x86_64-pc-windows-msvc.exe",
    import.meta.url,
)));
const positions: Manifest["positions"] = [
    { stratum: "older", fraction: 0.2 },
    { stratum: "middle", fraction: 0.5 },
    { stratum: "newer", fraction: 0.8 },
];

const assertSafeRunDir = (): void => {
    if (!isAbsolute(runDir)) throw new Error(`run directory must be absolute: ${runDir}`);
    const rel = relative(outputDir, runDir);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`unsafe run directory: ${runDir}`);
    }
};

const shiftMap = (values: Map<number, number>, shiftYears: number): Map<number, number> => (
    new Map(Array.from(values, ([year, value]) => [year + shiftYears, value]))
);

const mapsEqual = (left: Map<number, number>, right: Map<number, number>): boolean => {
    if (left.size !== right.size) return false;
    return Array.from(left).every(([year, value]) => right.get(year) === value);
};

const eventShift = (event: DiagnosisEvent | null): number | null => {
    if (!event) return null;
    if (event.eventType === "wholeSeriesMove") return event.evidence.lagBefore;
    if (event.eventType === "missingRing") return -1;
    if (event.eventType === "falseRing") return 1;
    return event.shiftYears ?? null;
};

const auditEventPreview = (event: DiagnosisEventAuditSnapshot): EventPreview => ({
    eventType: event.eventType,
    shiftYears: event.eventType === "wholeSeriesMove"
        ? event.lagBefore
        : event.eventType === "missingRing"
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
}) : null;

const snapshotPreview = (snapshot: LegacyDiagnosisSnapshot): SnapshotPreview => ({
    strict: eventPreview(snapshot.strictEvent),
    review: eventPreview(snapshot.reviewEvent),
    reviewStatus: snapshot.reviewDecision?.status ?? null,
    reviewReason: snapshot.reviewDecision?.reason ?? null,
    finalReason: snapshot.audit?.finalReason ?? null,
    referenceMode: snapshot.referenceMode,
    referenceAnchorCount: snapshot.referenceAnchorCount,
    detectedBeforeFusion: snapshot.audit?.detectedBeforeFusion.map(auditEventPreview) ?? [],
    detectedAfterFusion: snapshot.audit?.detectedAfterFusion.map(auditEventPreview) ?? [],
    finalEvents: snapshot.audit?.finalEvents.map(auditEventPreview) ?? [],
    error: snapshot.error,
});

const previewStable = (left: SnapshotPreview, right: SnapshotPreview): boolean => (
    JSON.stringify({
        strict: left.strict,
        review: left.review,
        reviewStatus: left.reviewStatus,
        reviewReason: left.reviewReason,
        finalReason: left.finalReason,
    }) === JSON.stringify({
        strict: right.strict,
        review: right.review,
        reviewStatus: right.reviewStatus,
        reviewReason: right.reviewReason,
        finalReason: right.finalReason,
    })
);

const targetForCase = (
    source: RwlSeries,
    spec: CaseSpec,
): { values: Map<number, number>; residualMatchesFalseControl: boolean | null } => {
    if (spec.scenarioKind === "clean") {
        return { values: new Map(source.valuesByYear), residualMatchesFalseControl: null };
    }
    if (spec.scenarioKind === "whole") {
        return {
            values: createWholeSeriesMoveCase(source, -spec.wholeShiftYears).corrupted,
            residualMatchesFalseControl: null,
        };
    }
    if (spec.finalFalseYear === null) throw new Error(`false year missing: ${spec.caseId}`);
    const falseControl = createEndAnchoredFalseRingCase(
        source,
        spec.finalFalseYear,
        spec.falseRingMode,
    ).corrupted;
    if (spec.scenarioKind === "false") {
        return { values: falseControl, residualMatchesFalseControl: null };
    }
    const composite = shiftMap(falseControl, -spec.wholeShiftYears);
    const residual = shiftMap(composite, spec.wholeShiftYears);
    return {
        values: composite,
        residualMatchesFalseControl: mapsEqual(residual, falseControl),
    };
};

const buildManifest = async (): Promise<Manifest> => {
    const loaded = await loadRwl(inputPath, "tucson-auto");
    const selected = Array.from(loaded.series.values())
        .filter((series) => series.zeroCount === 0 && series.length >= minimumSeriesLength)
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, maximumTargets);
    if (selected.length === 0) throw new Error("no zero-free co612 targets satisfy selection");

    const cases: CaseSpec[] = [];
    const combinations: CombinationSpec[] = [];
    const addCase = (spec: Omit<CaseSpec, "index">): string => {
        if (!cases.some((candidate) => candidate.caseId === spec.caseId)) {
            cases.push({ ...spec, index: cases.length });
        }
        return spec.caseId;
    };

    selected.forEach((series) => {
        const cleanCaseId = addCase({
            caseId: `${series.id}:clean`,
            targetId: series.id,
            scenarioKind: "clean",
            wholeShiftYears: 0,
            positionStratum: null,
            finalFalseYear: null,
            displayedFalseYear: null,
            falseRingMode,
        });
        const years = new Map(positions.map(({ stratum, fraction }) => [
            stratum,
            Math.round(series.startYear + (series.endYear - series.startYear) * fraction),
        ]));
        wholeShifts.forEach((wholeShiftYears) => {
            const wholeCaseId = addCase({
                caseId: `${series.id}:whole:${wholeShiftYears}`,
                targetId: series.id,
                scenarioKind: "whole",
                wholeShiftYears,
                positionStratum: null,
                finalFalseYear: null,
                displayedFalseYear: null,
                falseRingMode,
            });
            positions.forEach(({ stratum }) => {
                const finalFalseYear = years.get(stratum)!;
                const displayedFalseYear = finalFalseYear - wholeShiftYears;
                const falseCaseId = addCase({
                    caseId: `${series.id}:false:${stratum}`,
                    targetId: series.id,
                    scenarioKind: "false",
                    wholeShiftYears: 0,
                    positionStratum: stratum,
                    finalFalseYear,
                    displayedFalseYear: finalFalseYear,
                    falseRingMode,
                });
                const compositeCaseId = addCase({
                    caseId: `${series.id}:whole-false:${wholeShiftYears}:${stratum}`,
                    targetId: series.id,
                    scenarioKind: "whole-false",
                    wholeShiftYears,
                    positionStratum: stratum,
                    finalFalseYear,
                    displayedFalseYear,
                    falseRingMode,
                });
                combinations.push({
                    combinationId: `${series.id}:${wholeShiftYears}:${stratum}`,
                    targetId: series.id,
                    wholeShiftYears,
                    positionStratum: stratum,
                    finalFalseYear,
                    displayedFalseYear,
                    cleanCaseId,
                    wholeCaseId,
                    falseCaseId,
                    compositeCaseId,
                });
            });
        });
    });
    const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        encoding: "utf8",
        windowsHide: true,
    }).trim();
    return {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        inputPath,
        sourceSha256: loaded.sourceSha256,
        gitCommit,
        falseRingMode,
        wholeShifts,
        positions,
        selection: {
            minimumSeriesLength,
            requireZeroFreeTarget: true,
            maximumTargets,
            selectedTargetIds: selected.map((series) => series.id),
        },
        cases,
        combinations,
    };
};

const runWorker = async (): Promise<void> => {
    if (workerIndex === null) throw new Error("worker index required");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    const loaded = await loadRwl(manifest.inputPath, "tucson-auto");
    if (loaded.sourceSha256 !== manifest.sourceSha256) throw new Error("source hash changed");
    const workerDir = join(runDir, "workers", `worker-${workerIndex}`);
    mkdirSync(workerDir, { recursive: true });
    const results: CaseResult[] = [];
    for (const spec of manifest.cases.filter((item) => item.index % workerCount === workerIndex)) {
        const started = Date.now();
        try {
            const source = loaded.series.get(spec.targetId);
            if (!source) throw new Error(`target missing: ${spec.targetId}`);
            const generated = targetForCase(source, spec);
            const site = cloneSite(loaded.siteData);
            site.set(spec.targetId, generated.values);
            const reopened = await reopenFormattedSite(site, loaded.readResult);
            const context = runCofecha({
                siteData: reopened,
                readResult: loaded.readResult,
                workDir: workerDir,
                label: `case-${spec.index}`,
                cofechaExe,
                timeoutSeconds: 30,
            });
            const beforeSnapshot = diagnoseTruthBlind({
                siteData: site,
                targetId: spec.targetId,
                context,
                runId: `composition-before-${spec.index}`,
            });
            const afterSnapshot = diagnoseTruthBlind({
                siteData: reopened,
                targetId: spec.targetId,
                context,
                runId: `composition-after-${spec.index}`,
            });
            const beforeSave = snapshotPreview(beforeSnapshot);
            const afterReopen = snapshotPreview(afterSnapshot);
            results.push({
                caseId: spec.caseId,
                caseIndex: spec.index,
                targetId: spec.targetId,
                scenarioKind: spec.scenarioKind,
                wholeShiftYears: spec.wholeShiftYears,
                positionStratum: spec.positionStratum,
                finalFalseYear: spec.finalFalseYear,
                displayedFalseYear: spec.displayedFalseYear,
                targetHash: siteHash(new Map([[spec.targetId, generated.values]])),
                residualMatchesFalseControl: generated.residualMatchesFalseControl,
                cofechaFlagged: context.flaggedIds.some(
                    (id) => id.toLowerCase() === spec.targetId.toLowerCase(),
                ),
                beforeSave,
                afterReopen,
                saveReopenStable: previewStable(beforeSave, afterReopen),
                elapsedMs: Date.now() - started,
                error: beforeSnapshot.error ?? afterSnapshot.error,
            });
        } catch (error) {
            const empty: SnapshotPreview = {
                strict: null,
                review: null,
                reviewStatus: null,
                reviewReason: null,
                finalReason: null,
                referenceMode: "unavailable",
                referenceAnchorCount: 0,
                detectedBeforeFusion: [],
                detectedAfterFusion: [],
                finalEvents: [],
                error: error instanceof Error ? error.stack ?? error.message : String(error),
            };
            results.push({
                caseId: spec.caseId,
                caseIndex: spec.index,
                targetId: spec.targetId,
                scenarioKind: spec.scenarioKind,
                wholeShiftYears: spec.wholeShiftYears,
                positionStratum: spec.positionStratum,
                finalFalseYear: spec.finalFalseYear,
                displayedFalseYear: spec.displayedFalseYear,
                targetHash: "",
                residualMatchesFalseControl: null,
                cofechaFlagged: false,
                beforeSave: empty,
                afterReopen: empty,
                saveReopenStable: false,
                elapsedMs: Date.now() - started,
                error: empty.error,
            });
        }
        console.log(`worker=${workerIndex} case=${spec.index + 1}/${manifest.cases.length}`);
    }
    writeFileSync(
        join(runDir, `cases.worker-${workerIndex}-of-${workerCount}.jsonl`),
        `${results.map((row) => JSON.stringify(row)).join("\n")}\n`,
        "utf8",
    );
};

const rate = (count: number, total: number): number => total > 0 ? count / total : 0;
const histogram = (values: Array<string | number | null>): Record<string, number> => (
    Object.fromEntries(Array.from(new Set(values.map(String))).sort().map((key) => [
        key,
        values.filter((value) => String(value) === key).length,
    ]))
);

const summarizeCombinations = (rows: CombinationRow[]) => ({
    combinations: rows.length,
    pureWholeExact: rate(rows.filter((row) => row.pureWholeCorrect).length, rows.length),
    pureFalseOperationCorrect: rate(
        rows.filter((row) => row.pureFalseOperationCorrect).length,
        rows.length,
    ),
    pureFalseWindowCoverage: rate(
        rows.filter((row) => row.pureFalseWindowCovered).length,
        rows.length,
    ),
    compositeResponse: rate(rows.filter((row) => row.compositeResponse).length, rows.length),
    compositeWholeExact: rate(
        rows.filter((row) => row.compositeWholeExact).length,
        rows.length,
    ),
    compositeStrictWholeExact: rate(
        rows.filter((row) => row.compositeStrictWholeExact).length,
        rows.length,
    ),
    compositeInternalWholeExact: rate(
        rows.filter((row) => row.compositeInternalWholeExact).length,
        rows.length,
    ),
    reviewDemotedExactWholeRate: rate(
        rows.filter((row) => row.reviewDemotedExactWhole).length,
        rows.length,
    ),
    controlsBothCorrectCases: rows.filter((row) => row.controlsBothCorrect).length,
    interactionFailureRate: rate(
        rows.filter((row) => row.interactionFailure).length,
        rows.filter((row) => row.controlsBothCorrect).length,
    ),
    choseOlderFalseStateRate: rate(
        rows.filter((row) => row.compositeChoseOlderFalseState).length,
        rows.length,
    ),
    wholeToPartialConfusionRate: rate(
        rows.filter((row) => row.wholeToPartialConfusion).length,
        rows.length,
    ),
    wholeToUnitConfusionRate: rate(
        rows.filter((row) => row.wholeToUnitConfusion).length,
        rows.length,
    ),
    serialWholeThenFalseCorrect: rate(
        rows.filter((row) => row.serialWholeThenFalseCorrect).length,
        rows.length,
    ),
    saveReopenStable: rate(rows.filter((row) => row.saveReopenStable).length, rows.length),
    predictedTypeHistogram: histogram(rows.map((row) => row.compositePredictedType)),
    wholeBiasHistogram: histogram(rows.map((row) => row.compositeWholeBiasYears)),
});

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

const aggregate = async (manifest: Manifest): Promise<void> => {
    const results = Array.from({ length: workerCount }, (_, index) => {
        const path = join(runDir, `cases.worker-${index}-of-${workerCount}.jsonl`);
        return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)
            .map((line) => JSON.parse(line) as CaseResult);
    }).flat().sort((left, right) => left.caseIndex - right.caseIndex);
    const resultById = new Map(results.map((row) => [row.caseId, row]));
    if (results.length !== manifest.cases.length || resultById.size !== manifest.cases.length) {
        throw new Error(`case count mismatch: ${results.length}/${manifest.cases.length}`);
    }
    const rows: CombinationRow[] = manifest.combinations.map((combination) => {
        const whole = resultById.get(combination.wholeCaseId)!;
        const falseControl = resultById.get(combination.falseCaseId)!;
        const composite = resultById.get(combination.compositeCaseId)!;
        const wholeEvent = whole.afterReopen.review;
        const falseEvent = falseControl.afterReopen.review;
        const compositeEvent = composite.afterReopen.review;
        const compositeStrictEvent = composite.afterReopen.strict;
        const pureWholeCorrect = wholeEvent?.eventType === "wholeSeriesMove"
            && wholeEvent.shiftYears === combination.wholeShiftYears;
        const pureFalseOperationCorrect = falseEvent?.eventType === "falseRing"
            && falseEvent.shiftYears === 1;
        const pureFalseWindowCovered = Boolean(
            pureFalseOperationCorrect
            && falseEvent
            && combination.finalFalseYear >= falseEvent.startYear
            && combination.finalFalseYear <= falseEvent.endYear,
        );
        const compositeWholeExact = compositeEvent?.eventType === "wholeSeriesMove"
            && compositeEvent.shiftYears === combination.wholeShiftYears;
        const compositeStrictWholeExact = compositeStrictEvent?.eventType
            === "wholeSeriesMove"
            && compositeStrictEvent.shiftYears === combination.wholeShiftYears;
        const compositeInternalWholeExact = composite.afterReopen.finalEvents.some((event) => (
            event.eventType === "wholeSeriesMove"
            && event.shiftYears === combination.wholeShiftYears
        ));
        const controlsBothCorrect = pureWholeCorrect && pureFalseOperationCorrect
            && pureFalseWindowCovered;
        const compositeWholeBiasYears = compositeEvent?.eventType === "wholeSeriesMove"
            && compositeEvent.shiftYears !== null
            ? compositeEvent.shiftYears - combination.wholeShiftYears
            : null;
        return {
            combinationId: combination.combinationId,
            targetId: combination.targetId,
            wholeShiftYears: combination.wholeShiftYears,
            positionStratum: combination.positionStratum,
            finalFalseYear: combination.finalFalseYear,
            displayedFalseYear: combination.displayedFalseYear,
            pureWholeCorrect,
            pureFalseOperationCorrect,
            pureFalseWindowCovered,
            controlsBothCorrect,
            compositeResponse: compositeEvent !== null,
            compositePredictedType: compositeEvent?.eventType ?? null,
            compositePredictedShiftYears: compositeEvent?.shiftYears ?? null,
            compositeStrictWholeExact,
            compositeInternalWholeExact,
            reviewDemotedExactWhole: compositeInternalWholeExact && !compositeWholeExact,
            compositeWholeExact,
            compositeWholeBiasYears,
            compositeChoseOlderFalseState: compositeWholeBiasYears === 1,
            wholeToPartialConfusion: compositeEvent?.eventType === "partialMove",
            wholeToUnitConfusion: compositeEvent?.eventType === "missingRing"
                || compositeEvent?.eventType === "falseRing",
            interactionFailure: controlsBothCorrect && !compositeWholeExact,
            residualMatchesFalseControl: composite.residualMatchesFalseControl === true,
            serialWholeThenFalseCorrect: compositeWholeExact
                && composite.residualMatchesFalseControl === true
                && pureFalseOperationCorrect
                && pureFalseWindowCovered,
            saveReopenStable: whole.saveReopenStable
                && falseControl.saveReopenStable
                && composite.saveReopenStable,
            cofechaFlagged: composite.cofechaFlagged,
            referenceAnchorCount: composite.afterReopen.referenceAnchorCount,
            refusalReason: composite.afterReopen.reviewReason
                ?? composite.afterReopen.finalReason,
        };
    });
    const byWholeShift = Object.fromEntries(wholeShifts.map((shift) => [
        String(shift),
        summarizeCombinations(rows.filter((row) => row.wholeShiftYears === shift)),
    ]));
    const byPosition = Object.fromEntries(positions.map(({ stratum }) => [
        stratum,
        summarizeCombinations(rows.filter((row) => row.positionStratum === stratum)),
    ]));
    const sourceSha256After = sha256Bytes(readFileSync(manifest.inputPath));
    const cleanCases = results.filter((row) => row.scenarioKind === "clean");
    const wholeCases = results.filter((row) => row.scenarioKind === "whole");
    const falseCases = results.filter((row) => row.scenarioKind === "false");
    const wholeReviewExact = (row: CaseResult): boolean => (
        row.afterReopen.review?.eventType === "wholeSeriesMove"
        && row.afterReopen.review.shiftYears === row.wholeShiftYears
    );
    const wholeInternalExact = (row: CaseResult): boolean => (
        row.afterReopen.finalEvents.some((event) => (
            event.eventType === "wholeSeriesMove"
            && event.shiftYears === row.wholeShiftYears
        ))
    );
    const falseOperationCorrect = (row: CaseResult): boolean => (
        row.afterReopen.review?.eventType === "falseRing"
        && row.afterReopen.review.shiftYears === 1
    );
    const falseWindowCovered = (row: CaseResult): boolean => Boolean(
        falseOperationCorrect(row)
        && row.afterReopen.review
        && row.finalFalseYear !== null
        && row.finalFalseYear >= row.afterReopen.review.startYear
        && row.finalFalseYear <= row.afterReopen.review.endYear
    );
    const report = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        runDir,
        sourceSha256Before: manifest.sourceSha256,
        sourceSha256After,
        sourceUnchanged: sourceSha256After === manifest.sourceSha256,
        gitCommit: manifest.gitCommit,
        workers: workerCount,
        selectedTargets: manifest.selection.selectedTargetIds,
        uniqueDiagnosisCases: results.length,
        errors: results.filter((row) => row.error !== null).length,
        residualMapMismatches: results.filter((row) => (
            row.scenarioKind === "whole-false"
            && row.residualMatchesFalseControl !== true
        )).length,
        controls: {
            cleanCases: cleanCases.length,
            cleanStrictResponseRate: rate(
                cleanCases.filter((row) => row.afterReopen.strict !== null).length,
                cleanCases.length,
            ),
            cleanReviewFalsePositiveRate: rate(
                cleanCases.filter((row) => row.afterReopen.review !== null).length,
                cleanCases.length,
            ),
            wholeCases: wholeCases.length,
            wholeReviewExactRate: rate(
                wholeCases.filter(wholeReviewExact).length,
                wholeCases.length,
            ),
            wholeInternalExactRate: rate(
                wholeCases.filter(wholeInternalExact).length,
                wholeCases.length,
            ),
            falseCases: falseCases.length,
            falseOperationCorrectRate: rate(
                falseCases.filter(falseOperationCorrect).length,
                falseCases.length,
            ),
            falseWindowCoverageRate: rate(
                falseCases.filter(falseWindowCovered).length,
                falseCases.length,
            ),
            saveReopenStableRate: rate(
                results.filter((row) => row.saveReopenStable).length,
                results.length,
            ),
        },
        overall: summarizeCombinations(rows),
        byWholeShift,
        byPosition,
    };
    writeFileSync(join(runDir, "cases.json"), JSON.stringify(results, null, 2), "utf8");
    writeFileSync(join(runDir, "combinations.json"), JSON.stringify(rows, null, 2), "utf8");
    writeCsv(join(runDir, "combinations.csv"), rows as unknown as Array<Record<string, unknown>>);
    writeFileSync(join(runDir, "summary.json"), JSON.stringify(report, null, 2), "utf8");
    console.log(`CO612_OPERATION_COMPOSITION_SUMMARY ${JSON.stringify(report)}`);
};

const runParent = async (): Promise<void> => {
    assertSafeRunDir();
    if (!existsSync(inputPath)) throw new Error(`input missing: ${inputPath}`);
    if (!existsSync(cofechaExe)) throw new Error(`COFECHA missing: ${cofechaExe}`);
    if (!wholeShifts.length) throw new Error("at least one non-zero whole shift is required");
    if (!["average", "moderate", "splitLike"].includes(falseRingMode)) {
        throw new Error(`invalid false-ring mode: ${falseRingMode}`);
    }
    rmSync(runDir, { force: true, recursive: true });
    mkdirSync(runDir, { recursive: true });
    const manifest = await buildManifest();
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const viteNode = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../node_modules/vite-node/vite-node.mjs",
    );
    const scriptPath = fileURLToPath(import.meta.url);
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
            ], {
                cwd: resolve(dirname(scriptPath), ".."),
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
    await aggregate(manifest);
};

if (workerIndex === null) {
    await runParent();
} else {
    await runWorker();
}
