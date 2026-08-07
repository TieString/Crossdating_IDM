import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis/types";
import {
    deleteYearWithMode,
    insertMissingYearAtSide,
    moveSeriesTailByOffset,
} from "@/features/rwl/edit";
import type { RwlSeries, RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import {
    cloneSite,
    diagnoseTruthBlind,
    loadRwl,
    reopenFormattedSite,
    runCofecha,
    sha256Bytes,
    siteHash,
    snapshotsSemanticallyEqual,
} from "./legacy-generalization/evaluator";
import {
    deriveZslSeriesTruth,
    type ExpectedZslOperation,
    type ZslSeriesTruth,
} from "./zsl-operation-truth";

type ReplayMode = "whole-file-raw" | "isolated-crossdated-reference";

type EventPreview = {
    eventType: DiagnosisEvent["eventType"];
    shiftYears: number | null;
    startYear: number;
    endYear: number;
    topYear: number | null;
    confidenceLevel: DiagnosisEvent["confidenceLevel"];
    score: number;
    scoreMargin: number;
    lagBefore: number | null;
    lagAfter: number | null;
    sources: string[];
    notes: string[];
};

type ReplayStep = {
    mode: ReplayMode;
    seriesId: string;
    truthQuality: "exact-reconstruction" | "supplemental-non-exact";
    stepIndex: number;
    remainingOperationCount: number;
    previousAppliedType: ExpectedZslOperation["eventType"] | null;
    previousAppliedShiftYears: number | null;
    expected: ExpectedZslOperation | null;
    predicted: EventPreview | null;
    strict: EventPreview | null;
    response: boolean;
    operationCorrect: boolean | null;
    windowCovered: boolean | null;
    wholeMisclassifiedAsPartial: boolean;
    partialMisclassifiedAsMissing: boolean;
    saveReopenStable: boolean;
    serializedSiteStable: boolean;
    cofechaFlagged: boolean;
    referenceMode: string;
    referenceAnchorCount: number;
    reviewStatus: string | null;
    reviewReason: string | null;
    finalReason: string | null;
    candidates: Array<Record<string, unknown>>;
    diagnosisAudit: unknown;
    reviewDecisionDetail: unknown;
    stateHash: string;
    error: string | null;
};

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string): string | null => {
    const equals = args.find((argument) => argument.startsWith(`${name}=`));
    if (equals) return equals.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};

const rawPath = resolve(valueFor("--raw") ?? "D:/软件测试/ZSL/RAW.rwl");
const crossdatedPath = resolve(
    valueFor("--crossdated") ?? "D:/软件测试/ZSL/crossdated.rwl",
);
const outputRoot = resolve(
    valueFor("--output-dir") ?? "D:/软件测试/ZSL/window-coverage-results",
);
const runId = valueFor("--run-id")
    ?? `zsl-serial-operation-replay-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runDir = join(outputRoot, runId);
const cofechaExe = resolve(valueFor("--cofecha-exe") ?? fileURLToPath(new URL(
    "../src-tauri/bin/cofecha-x86_64-pc-windows-msvc.exe",
    import.meta.url,
)));
const timeoutSeconds = Math.max(10, Number(valueFor("--timeout-seconds") ?? 60));
const requestedMode = valueFor("--mode") ?? "both";
const requestedTarget = valueFor("--target");
const modes: ReplayMode[] = requestedMode === "both"
    ? ["whole-file-raw", "isolated-crossdated-reference"]
    : [requestedMode as ReplayMode];

if (!existsSync(rawPath)) throw new Error(`RAW missing: ${rawPath}`);
if (!existsSync(crossdatedPath)) throw new Error(`crossdated missing: ${crossdatedPath}`);
if (!existsSync(cofechaExe)) throw new Error(`COFECHA missing: ${cofechaExe}`);
if (existsSync(runDir)) throw new Error(`run directory already exists: ${runDir}`);
mkdirSync(runDir, { recursive: true });

const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    encoding: "utf8",
    windowsHide: true,
}).trim();
const rawHashBefore = sha256Bytes(readFileSync(rawPath));
const crossdatedHashBefore = sha256Bytes(readFileSync(crossdatedPath));
const rawLoaded = await loadRwl(rawPath);
const crossdatedLoaded = await loadRwl(crossdatedPath);
const sharedIds = [...rawLoaded.series.keys()]
    .filter((seriesId) => crossdatedLoaded.series.has(seriesId))
    .sort();

const seriesFromTree = (seriesId: string, valuesByYear: RwlTreeData): RwlSeries => {
    const observed = new Map(Array.from(valuesByYear).flatMap(([year, value]) => (
        typeof value === "number" && value !== -9999
            ? [[year, value] as [number, number]]
            : []
    )));
    const years = [...observed.keys()];
    return {
        id: seriesId,
        valuesByYear: observed,
        startYear: Math.min(...years),
        endYear: Math.max(...years),
        length: observed.size,
        nonZeroCount: [...observed.values()].filter((value) => value !== 0).length,
        zeroCount: [...observed.values()].filter((value) => value === 0).length,
    };
};

const currentTruth = (
    seriesId: string,
    current: RwlTreeData,
): ZslSeriesTruth => deriveZslSeriesTruth(
    seriesFromTree(seriesId, current),
    crossdatedLoaded.series.get(seriesId)!,
);

const operationCount = (truth: ZslSeriesTruth): number => (
    (truth.wholeSeriesMove ? 1 : 0)
    + truth.transitions.filter((transition) => (
        transition.operationType !== "offsetTransition"
    )).length
);

const treeRange = (tree: RwlTreeData): { startYear: number; endYear: number } => {
    const years = [...tree.keys()];
    return { startYear: Math.min(...years), endYear: Math.max(...years) };
};

const applyExpectedOperation = (
    tree: RwlTreeData,
    expected: ExpectedZslOperation,
): RwlTreeData => {
    const range = treeRange(tree);
    if (expected.eventType === "wholeSeriesMove") {
        return moveSeriesTailByOffset(
            tree,
            range.startYear,
            range.endYear,
            expected.shiftYears,
        );
    }
    if (expected.eventType === "missingRing") {
        return insertMissingYearAtSide(tree, expected.eventYear!, "right");
    }
    if (expected.eventType === "falseRing") {
        return deleteYearWithMode(tree, expected.eventYear!, "direct", "right");
    }
    return moveSeriesTailByOffset(
        tree,
        range.startYear,
        expected.firstFixedYear! - 1,
        expected.shiftYears,
    );
};

const effectiveShift = (event: DiagnosisEvent | null): number | null => {
    if (!event) return null;
    if (event.eventType === "missingRing") return -1;
    if (event.eventType === "falseRing") return 1;
    return event.shiftYears ?? event.evidence.lagBefore ?? null;
};

const preview = (event: DiagnosisEvent | null): EventPreview | null => event ? {
    eventType: event.eventType,
    shiftYears: effectiveShift(event),
    startYear: event.startYear,
    endYear: event.endYear,
    topYear: event.rankedYears[0]?.year ?? null,
    confidenceLevel: event.confidenceLevel,
    score: event.evidence.score,
    scoreMargin: event.evidence.scoreMargin,
    lagBefore: event.evidence.lagBefore,
    lagAfter: event.evidence.lagAfter,
    sources: event.evidence.algorithmSources,
    notes: event.evidence.notes,
} : null;

const operationMatches = (
    event: DiagnosisEvent | null,
    expected: ExpectedZslOperation,
): boolean => Boolean(
    event
    && event.eventType === expected.eventType
    && effectiveShift(event) === expected.shiftYears
);

const mapsEqual = (left: RwlTreeData, right: RwlTreeData): boolean => {
    const leftRows = [...left].filter(([, value]) => value !== -9999);
    const rightRows = [...right].filter(([, value]) => value !== -9999);
    return leftRows.length === rightRows.length
        && leftRows.every(([year, value]) => right.get(year) === value);
};

const inventory = sharedIds.map((seriesId) => {
    const truth = deriveZslSeriesTruth(
        rawLoaded.series.get(seriesId)!,
        crossdatedLoaded.series.get(seriesId)!,
    );
    return {
        seriesId,
        reconstructionMatchesRaw: truth.reconstructionMatchesRaw,
        initialOperationCount: operationCount(truth),
        wholeSeriesMove: truth.wholeSeriesMove,
        transitions: truth.transitions,
        unmatchedRaw: truth.unmatchedRaw,
        crossdatedZeroYears: truth.crossdatedZeroYears,
    };
});
const allReplayTargets = inventory.filter((row) => (
    row.initialOperationCount > 0
));
const replayTargets = requestedTarget
    ? allReplayTargets.filter((row) => (
        row.seriesId.trim().toUpperCase() === requestedTarget.trim().toUpperCase()
    ))
    : allReplayTargets;
if (requestedTarget && replayTargets.length === 0) {
    throw new Error(`target has no derived dating operation: ${requestedTarget}`);
}
const excludedTruthTargets = allReplayTargets.filter((row) => (
    !row.reconstructionMatchesRaw && row.initialOperationCount > 0
));

const steps: ReplayStep[] = [];
const finalStates: Array<{
    mode: ReplayMode;
    seriesId: string;
    truthQuality: "exact-reconstruction" | "supplemental-non-exact";
    finalExactValueMatch: boolean;
    finalDatingAlignmentResolved: boolean;
    remainingOperationCount: number;
    error: string | null;
}> = [];

for (const mode of modes) {
    for (const target of replayTargets) {
        const truthQuality = target.reconstructionMatchesRaw
            ? "exact-reconstruction"
            : "supplemental-non-exact";
        let site: RwlSiteData = mode === "whole-file-raw"
            ? cloneSite(rawLoaded.siteData)
            : cloneSite(crossdatedLoaded.siteData);
        site.set(target.seriesId, new Map(rawLoaded.siteData.get(target.seriesId)!));
        let previousApplied: ExpectedZslOperation | null = null;
        let error: string | null = null;
        const maximumSteps = target.initialOperationCount + 2;

        for (let stepIndex = 0; stepIndex <= maximumSteps; stepIndex += 1) {
            const tree = site.get(target.seriesId)!;
            const truth = currentTruth(target.seriesId, tree);
            const expected = truth.expectedFrontier;
            const remainingOperationCount = operationCount(truth);
            const label = `${mode}-${target.seriesId}-step-${String(stepIndex).padStart(2, "0")}`;
            try {
                const context = runCofecha({
                    siteData: site,
                    readResult: rawLoaded.readResult,
                    workDir: join(runDir, "states"),
                    label,
                    cofechaExe,
                    timeoutSeconds,
                });
                const before = diagnoseTruthBlind({
                    siteData: site,
                    targetId: target.seriesId,
                    context,
                    runId: label,
                });
                const reopened = await reopenFormattedSite(site, rawLoaded.readResult);
                const afterReopen = diagnoseTruthBlind({
                    siteData: reopened,
                    targetId: target.seriesId,
                    context,
                    runId: `${label}-reopen`,
                });
                const event = before.reviewEvent;
                const operationCorrect = expected ? operationMatches(event, expected) : null;
                const windowCovered = expected?.eventYear !== null && expected?.eventYear !== undefined
                    ? Boolean(operationCorrect && event
                        && expected.eventYear >= event.startYear
                        && expected.eventYear <= event.endYear)
                    : null;
                steps.push({
                    mode,
                    seriesId: target.seriesId,
                    truthQuality,
                    stepIndex,
                    remainingOperationCount,
                    previousAppliedType: previousApplied?.eventType ?? null,
                    previousAppliedShiftYears: previousApplied?.shiftYears ?? null,
                    expected,
                    predicted: preview(event),
                    strict: preview(before.strictEvent),
                    response: event !== null,
                    operationCorrect,
                    windowCovered,
                    wholeMisclassifiedAsPartial: expected?.eventType === "wholeSeriesMove"
                        && event?.eventType === "partialMove",
                    partialMisclassifiedAsMissing: expected?.eventType === "partialMove"
                        && event?.eventType === "missingRing",
                    saveReopenStable: snapshotsSemanticallyEqual(before, afterReopen),
                    serializedSiteStable: siteHash(site) === siteHash(reopened),
                    cofechaFlagged: context.flaggedIds.includes(target.seriesId),
                    referenceMode: before.referenceMode,
                    referenceAnchorCount: before.referenceAnchorCount,
                    reviewStatus: before.reviewDecision?.status ?? null,
                    reviewReason: before.reviewDecision?.reason ?? null,
                    finalReason: before.audit?.finalReason ?? null,
                    candidates: before.candidates,
                    diagnosisAudit: before.audit,
                    reviewDecisionDetail: before.reviewDecision,
                    stateHash: siteHash(site),
                    error: before.error ?? afterReopen.error,
                });
                if (!expected) {
                    site = reopened;
                    break;
                }

                const repairedTree = applyExpectedOperation(tree, expected);
                const nextSite = cloneSite(site);
                nextSite.set(target.seriesId, repairedTree);
                const nextTruth = currentTruth(target.seriesId, repairedTree);
                if (operationCount(nextTruth) >= remainingOperationCount) {
                    throw new Error(
                        `truth repair did not reduce operations: ${remainingOperationCount}`
                        + ` -> ${operationCount(nextTruth)}`,
                    );
                }
                site = await reopenFormattedSite(nextSite, rawLoaded.readResult);
                previousApplied = expected;
            } catch (caught) {
                error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
                steps.push({
                    mode,
                    seriesId: target.seriesId,
                    truthQuality,
                    stepIndex,
                    remainingOperationCount,
                    previousAppliedType: previousApplied?.eventType ?? null,
                    previousAppliedShiftYears: previousApplied?.shiftYears ?? null,
                    expected,
                    predicted: null,
                    strict: null,
                    response: false,
                    operationCorrect: expected ? false : null,
                    windowCovered: expected?.eventYear !== null ? false : null,
                    wholeMisclassifiedAsPartial: false,
                    partialMisclassifiedAsMissing: false,
                    saveReopenStable: false,
                    serializedSiteStable: false,
                    cofechaFlagged: false,
                    referenceMode: "error",
                    referenceAnchorCount: 0,
                    reviewStatus: null,
                    reviewReason: null,
                    finalReason: null,
                    candidates: [],
                    diagnosisAudit: null,
                    reviewDecisionDetail: null,
                    stateHash: siteHash(site),
                    error,
                });
                break;
            }
        }

        const finalTree = site.get(target.seriesId)!;
        finalStates.push({
            mode,
            seriesId: target.seriesId,
            truthQuality,
            finalExactValueMatch: mapsEqual(
                finalTree,
                crossdatedLoaded.siteData.get(target.seriesId)!,
            ),
            finalDatingAlignmentResolved:
                operationCount(currentTruth(target.seriesId, finalTree)) === 0,
            remainingOperationCount: operationCount(currentTruth(target.seriesId, finalTree)),
            error,
        });
        writeFileSync(
            join(runDir, "checkpoint.json"),
            `${JSON.stringify({ steps, finalStates }, null, 2)}\n`,
            "utf8",
        );
    }
}

const summarizeMode = (mode: ReplayMode) => {
    const rows = steps.filter((row) => row.mode === mode);
    const summarizeQuality = (
        truthQuality: ReplayStep["truthQuality"],
    ) => {
        const qualityRows = rows.filter((row) => row.truthQuality === truthQuality);
        const truthRows = qualityRows.filter((row) => row.expected !== null);
        const terminalRows = qualityRows.filter((row) => row.expected === null);
        const byType = ([
            "wholeSeriesMove",
            "partialMove",
            "missingRing",
            "falseRing",
        ] as const).map((eventType) => {
            const typeRows = truthRows.filter((row) => row.expected?.eventType === eventType);
            return {
                eventType,
                cases: typeRows.length,
                response: typeRows.filter((row) => row.response).length,
                operationCorrect: typeRows.filter((row) => row.operationCorrect).length,
                windowApplicable: typeRows.filter((row) => row.windowCovered !== null).length,
                windowCovered: typeRows.filter((row) => row.windowCovered).length,
            };
        });
        const qualityFinal = finalStates.filter((row) => (
            row.mode === mode && row.truthQuality === truthQuality
        ));
        return {
            replaySeries: new Set(qualityRows.map((row) => row.seriesId)).size,
            truthOperations: truthRows.length,
            response: truthRows.filter((row) => row.response).length,
            operationCorrect: truthRows.filter((row) => row.operationCorrect).length,
            windowApplicable: truthRows.filter((row) => row.windowCovered !== null).length,
            windowCovered: truthRows.filter((row) => row.windowCovered).length,
            wholeMisclassifiedAsPartial: truthRows.filter(
                (row) => row.wholeMisclassifiedAsPartial,
            ).length,
            partialMisclassifiedAsMissing: truthRows.filter(
                (row) => row.partialMisclassifiedAsMissing,
            ).length,
            saveReopenStable: qualityRows.filter((row) => row.saveReopenStable).length,
            saveReopenPairs: qualityRows.length,
            serializedSiteStable: qualityRows.filter(
                (row) => row.serializedSiteStable,
            ).length,
            terminalCleanCases: terminalRows.length,
            terminalFalsePositive: terminalRows.filter((row) => row.response).length,
            finalExactValueMatch: qualityFinal.filter(
                (row) => row.finalExactValueMatch,
            ).length,
            finalDatingAlignmentResolved: qualityFinal.filter(
                (row) => row.finalDatingAlignmentResolved,
            ).length,
            finalCases: qualityFinal.length,
            byType,
        };
    };
    const primary = summarizeQuality("exact-reconstruction");
    const supplemental = summarizeQuality("supplemental-non-exact");
    const truthRows = rows.filter((row) => row.expected !== null);
    const terminalRows = rows.filter((row) => row.expected === null);
    return {
        replaySeries: replayTargets.length,
        truthOperations: truthRows.length,
        response: truthRows.filter((row) => row.response).length,
        operationCorrect: truthRows.filter((row) => row.operationCorrect).length,
        windowApplicable: truthRows.filter((row) => row.windowCovered !== null).length,
        windowCovered: truthRows.filter((row) => row.windowCovered).length,
        wholeMisclassifiedAsPartial: truthRows.filter(
            (row) => row.wholeMisclassifiedAsPartial,
        ).length,
        partialMisclassifiedAsMissing: truthRows.filter(
            (row) => row.partialMisclassifiedAsMissing,
        ).length,
        saveReopenStable: rows.filter((row) => row.saveReopenStable).length,
        saveReopenPairs: rows.length,
        serializedSiteStable: rows.filter((row) => row.serializedSiteStable).length,
        terminalCleanCases: terminalRows.length,
        terminalFalsePositive: terminalRows.filter((row) => row.response).length,
        finalExactValueMatch: finalStates.filter((row) => (
            row.mode === mode && row.finalExactValueMatch
        )).length,
        finalDatingAlignmentResolved: finalStates.filter((row) => (
            row.mode === mode && row.finalDatingAlignmentResolved
        )).length,
        finalCases: finalStates.filter((row) => row.mode === mode).length,
        primaryExactReconstruction: primary,
        supplementalNonExact: supplemental,
    };
};

const summary = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    gitCommit,
    inputs: {
        rawPath,
        rawSha256: rawHashBefore,
        crossdatedPath,
        crossdatedSha256: crossdatedHashBefore,
        cofechaExe,
    },
    truthInventory: {
        sharedSeries: sharedIds.length,
        exactReconstructionSeries: inventory.filter(
            (row) => row.reconstructionMatchesRaw,
        ).length,
        availableReplaySeries: allReplayTargets.length,
        primaryReplaySeries: replayTargets.filter(
            (row) => row.reconstructionMatchesRaw,
        ).length,
        supplementalReplaySeries: replayTargets.filter(
            (row) => !row.reconstructionMatchesRaw,
        ).length,
        replaySeries: replayTargets.length,
        excludedNonExactTruthSeries: excludedTruthTargets.length,
        replayTruthOperations: replayTargets.reduce(
            (sum, row) => sum + row.initialOperationCount,
            0,
        ),
    },
    modes: modes.map((mode) => ({ mode, ...summarizeMode(mode) })),
    sourceIntegrity: {
        rawUnchanged: sha256Bytes(readFileSync(rawPath)) === rawHashBefore,
        crossdatedUnchanged:
            sha256Bytes(readFileSync(crossdatedPath)) === crossdatedHashBefore,
    },
};

const csvCell = (value: unknown): string => {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
};
const csvColumns: Array<keyof ReplayStep | "expectedType" | "expectedShiftYears"
    | "expectedYear" | "predictedType" | "predictedShiftYears" | "predictedTopYear"
> = [
    "mode", "seriesId", "stepIndex", "remainingOperationCount",
    "truthQuality",
    "previousAppliedType", "previousAppliedShiftYears", "expectedType",
    "expectedShiftYears", "expectedYear", "predictedType", "predictedShiftYears",
    "predictedTopYear", "response", "operationCorrect", "windowCovered",
    "wholeMisclassifiedAsPartial", "partialMisclassifiedAsMissing",
    "saveReopenStable", "serializedSiteStable", "cofechaFlagged", "referenceMode",
    "referenceAnchorCount", "reviewStatus", "reviewReason", "finalReason", "error",
];
const csvRows = steps.map((row) => {
    const flat: Record<string, unknown> = {
        ...row,
        expectedType: row.expected?.eventType ?? null,
        expectedShiftYears: row.expected?.shiftYears ?? null,
        expectedYear: row.expected?.eventYear ?? null,
        predictedType: row.predicted?.eventType ?? null,
        predictedShiftYears: row.predicted?.shiftYears ?? null,
        predictedTopYear: row.predicted?.topYear ?? null,
    };
    return csvColumns.map((column) => csvCell(flat[column])).join(",");
});

writeFileSync(join(runDir, "truth-inventory.json"), `${JSON.stringify({
    replayTargets,
    excludedTruthTargets,
    inventory,
}, null, 2)}\n`, "utf8");
writeFileSync(join(runDir, "steps.json"), `${JSON.stringify(steps, null, 2)}\n`, "utf8");
writeFileSync(join(runDir, "steps.csv"), `${csvColumns.join(",")}\n${csvRows.join("\n")}\n`, "utf8");
writeFileSync(join(runDir, "final-states.json"), `${JSON.stringify(finalStates, null, 2)}\n`, "utf8");
writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
writeFileSync(join(runDir, "canonical-snapshots.json"), `${JSON.stringify(
    steps.map((row) => ({
        mode: row.mode,
        seriesId: row.seriesId,
        stepIndex: row.stepIndex,
        prediction: row.predicted,
        expected: row.expected,
    })),
    null,
    2,
)}\n`, "utf8");

console.log(JSON.stringify({ runDir, ...summary }, null, 2));
