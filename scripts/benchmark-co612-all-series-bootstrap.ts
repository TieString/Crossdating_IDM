import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    compareBootstrapEvents,
    findAbsoluteUnidentifiableTruthYears,
    selectAutomaticBootstrapApplication,
} from "@/features/crossdating/diagnosis/bootstrapEvaluation";
import {
    extractPart6FlaggedASeriesIds,
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import { parseCofechaHints } from "@/features/crossdating/diagnosis/cofechaHints";
import { planDiagnosisEventEdit } from "@/features/crossdating/diagnosis/eventApply";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis/types";
import {
    cofechaStyleStandardize,
    createCofechaMasterReferenceConfig,
    createCofechaPassReferenceConfig,
} from "@/features/crossdating/reference";
import {
    deleteYearWithMode,
    getSeriesMoveConflicts,
    insertMissingYearAtSide,
    moveSeriesTailByOffset,
} from "@/features/rwl/edit";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import {
    buildMultiMissingCorrupted,
    parseRwl,
    type RwlSeries,
} from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

type Mode = "truth-assisted" | "automatic";

type SeriesTruthState = {
    series: RwlSeries;
    truthYears: number[];
    remainingTruthYears: number[];
    tainted: boolean;
    wrongApplications: number;
};

type Observation = {
    mode: Mode;
    iteration: number;
    seriesId: string;
    truthYear: number;
    absoluteIdentifiable: boolean;
    response: boolean;
    eventType: DiagnosisEvent["eventType"] | null;
    operationCorrect: boolean;
    windowCovered: boolean;
    top1Exact: boolean;
    topYear: number | null;
    windowStart: number | null;
    windowEnd: number | null;
    confidence: DiagnosisEvent["confidenceLevel"] | null;
    score: number | null;
};

type Application = {
    mode: Mode;
    iteration: number;
    seriesId: string;
    eventType: DiagnosisEvent["eventType"];
    selectedYear: number;
    expectedTruthYear: number | null;
    exactTruthOperation: boolean;
    applied: boolean;
    distanceBefore: number;
    distanceAfter: number;
    seriesRecovered: boolean;
    error: string | null;
};

type IterationAudit = {
    iteration: number;
    durationMs: number;
    referenceMode: "cofecha-pass" | "pairwise-leave-batch-out";
    cofechaFlaggedCount: number;
    referenceAnchorCount: number;
    diagnosedTargetCount: number;
    emittedEventCount: number;
    selectedSeriesId: string | null;
    selectedEventType: DiagnosisEvent["eventType"] | null;
    stopReason: string | null;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cofechaExe = join(
    repoRoot,
    "src-tauri",
    "bin",
    "cofecha-x86_64-pc-windows-msvc.exe",
);
const args = process.argv.slice(2);
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const inputPath = resolve(valueFor("--input") ?? "D:/软件测试/co612.rwl");
const outputRoot = resolve(
    valueFor("--output-dir") ?? "D:/软件测试/co612-all-series-bootstrap-results",
);
const runId = valueFor("--run-id")
    ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runDir = join(outputRoot, runId);
const requestedMode = valueFor("--mode") ?? "both";
const maxIterations = Math.max(1, Number(valueFor("--max-iterations") ?? 400));
const targetLimit = Math.max(1, Number(valueFor("--target-limit") ?? 12));
const maxWrongApplications = Math.max(
    1,
    Number(valueFor("--max-wrong-applications") ?? 20),
);

if (!existsSync(inputPath)) throw new Error(`RWL not found: ${inputPath}`);
if (!existsSync(cofechaExe)) throw new Error(`COFECHA not found: ${cofechaExe}`);
mkdirSync(runDir, { recursive: true });

const sourceBytes = readFileSync(inputPath);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
const parsed = parseRwl(sourceBytes.toString("utf8"));
const originalSite: RwlSiteData = new Map(Array.from(parsed, ([seriesId, series]) => [
    seriesId,
    new Map(series.valuesByYear),
]));
const seriesIdByNormalized = new Map(Array.from(originalSite.keys(), (seriesId) => [
    seriesId.trim().toUpperCase(),
    seriesId,
]));
const canonicalSeriesId = (seriesId: string): string | null => (
    seriesIdByNormalized.get(seriesId.trim().toUpperCase()) ?? null
);
const plans = Array.from(parsed.values()).map((series) => ({
    series,
    truthYears: Array.from(series.valuesByYear)
        .filter(([, value]) => value === 0)
        .map(([year]) => year)
        .sort((left, right) => right - left),
})).filter((plan) => plan.truthYears.length > 0);
const initialSite: RwlSiteData = new Map(Array.from(originalSite, ([seriesId, data]) => [
    seriesId,
    new Map(data),
]));
plans.forEach(({ series, truthYears }) => {
    initialSite.set(
        series.id,
        buildMultiMissingCorrupted(series.valuesByYear, truthYears),
    );
});

writeFileSync(join(runDir, "source-copy.rwl"), formatTucson(originalSite, false), "utf8");
writeFileSync(join(runDir, "initial-all-missing.rwl"), formatTucson(initialSite, false), "utf8");

const rangeFor = (data: RwlTreeData): { startYear: number; endYear: number } => {
    const years = Array.from(data.keys());
    return {
        startYear: Math.min(...years),
        endYear: Math.max(...years),
    };
};

const runCofecha = (siteData: RwlSiteData, mode: Mode, iteration: number): string => {
    const workDir = join(runDir, `cofecha-${mode}-${iteration}`);
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "INPUT.RWL"), formatTucson(siteData, false), "utf8");
    execFileSync(cofechaExe, [], {
        cwd: workDir,
        input: "very\nINPUT.RWL\n\n\n\n\n\n\n",
        timeout: 30_000,
        stdio: ["pipe", "ignore", "pipe"],
    });
    return readFileSync(join(workDir, "VERYCOF.OUT"), "utf8");
};

const pearsonAtLag = (
    left: Map<number, number>,
    right: Map<number, number>,
    lag: number,
): number | null => {
    let count = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    left.forEach((x, year) => {
        const y = right.get(year + lag);
        if (y === undefined) return;
        count += 1;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
    });
    if (count < 50) return null;
    const numerator = sxy - sx * sy / count;
    const denominator = Math.sqrt(
        Math.max(0, sxx - sx * sx / count)
        * Math.max(0, syy - sy * sy / count),
    );
    return denominator > 0 ? numerator / denominator : null;
};

const standardizedSiteSeries = (siteData: RwlSiteData) => (
    Array.from(siteData, ([seriesId, data]) => ({
        seriesId,
        residual: new Map(cofechaStyleStandardize(new Map(Array.from(data).flatMap(
            ([year, value]) => typeof value === "number" ? [[year, value] as [number, number]] : [],
        ))).map((point) => [point.year, point.value])),
    })).filter((row) => row.residual.size >= 50)
);

/** Largest zero-lag connected component used only if COFECHA leaves too few anchors. */
const selectPairwiseBootstrapCluster = (siteData: RwlSiteData): string[] => {
    const series = standardizedSiteSeries(siteData);
    const adjacency = new Map(series.map((row) => [row.seriesId, new Set<string>()]));
    for (let leftIndex = 0; leftIndex < series.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < series.length; rightIndex += 1) {
            const left = series[leftIndex];
            const right = series[rightIndex];
            const rows = Array.from({ length: 21 }, (_, index) => {
                const lag = index - 10;
                return { lag, correlation: pearsonAtLag(left.residual, right.residual, lag) };
            }).filter((row): row is { lag: number; correlation: number } => (
                row.correlation !== null
            )).sort((a, b) => b.correlation - a.correlation);
            const best = rows[0];
            const zero = rows.find((row) => row.lag === 0)?.correlation ?? -1;
            if (!best || zero < 0.30 || best.correlation - zero > 0.03) continue;
            adjacency.get(left.seriesId)?.add(right.seriesId);
            adjacency.get(right.seriesId)?.add(left.seriesId);
        }
    }
    const visited = new Set<string>();
    const components: string[][] = [];
    adjacency.forEach((_, start) => {
        if (visited.has(start)) return;
        const queue = [start];
        const component: string[] = [];
        visited.add(start);
        while (queue.length > 0) {
            const current = queue.shift()!;
            component.push(current);
            adjacency.get(current)?.forEach((neighbor) => {
                if (visited.has(neighbor)) return;
                visited.add(neighbor);
                queue.push(neighbor);
            });
        }
        components.push(component);
    });
    return components.sort((left, right) => right.length - left.length)[0] ?? [];
};

type PairwiseAlignmentSummary = {
    eligiblePairs: number;
    zeroLagBestPairs: number;
    zeroLagBestRate: number;
    meanAbsoluteBestLag: number;
    p90AbsoluteBestLag: number;
};

/** Calendar-free relative alignment score; it never sees hidden zero-year truth. */
const summarizePairwiseAlignment = (siteData: RwlSiteData): PairwiseAlignmentSummary => {
    const series = standardizedSiteSeries(siteData);
    const absoluteBestLags: number[] = [];
    for (let leftIndex = 0; leftIndex < series.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < series.length; rightIndex += 1) {
            const left = series[leftIndex];
            const right = series[rightIndex];
            const rows = Array.from({ length: 21 }, (_, index) => {
                const lag = index - 10;
                return { lag, correlation: pearsonAtLag(left.residual, right.residual, lag) };
            }).filter((row): row is { lag: number; correlation: number } => (
                row.correlation !== null
            )).sort((a, b) => (
                b.correlation - a.correlation
                || Math.abs(a.lag) - Math.abs(b.lag)
            ));
            if (rows[0]) absoluteBestLags.push(Math.abs(rows[0].lag));
        }
    }
    absoluteBestLags.sort((left, right) => left - right);
    const zeroLagBestPairs = absoluteBestLags.filter((lag) => lag === 0).length;
    const p90Index = Math.max(0, Math.ceil(absoluteBestLags.length * 0.9) - 1);
    return {
        eligiblePairs: absoluteBestLags.length,
        zeroLagBestPairs,
        zeroLagBestRate: zeroLagBestPairs / Math.max(1, absoluteBestLags.length),
        meanAbsoluteBestLag: absoluteBestLags.reduce((sum, lag) => sum + lag, 0)
            / Math.max(1, absoluteBestLags.length),
        p90AbsoluteBestLag: absoluteBestLags[p90Index] ?? 0,
    };
};

const truthBySeries = new Map(plans.map((plan) => [plan.series.id, plan.truthYears]));
const commonTruthYears = findAbsoluteUnidentifiableTruthYears(
    originalSite,
    truthBySeries,
);

const pairwiseCluster = selectPairwiseBootstrapCluster(initialSite);
const originalPairwiseAlignment = summarizePairwiseAlignment(originalSite);
const initialPairwiseAlignment = summarizePairwiseAlignment(initialSite);

const seriesDistance = (current: RwlTreeData, expected: RwlTreeData): number => {
    const years = new Set([...current.keys(), ...expected.keys()]);
    let mismatches = 0;
    years.forEach((year) => {
        if (current.get(year) !== expected.get(year)) mismatches += 1;
    });
    return mismatches;
};

const sameSeries = (current: RwlTreeData, expected: RwlTreeData): boolean => (
    seriesDistance(current, expected) === 0
);

const applyEvent = (
    siteData: RwlSiteData,
    event: DiagnosisEvent,
    selectedYear: number,
): { applied: boolean; error: string | null } => {
    const current = siteData.get(event.seriesId);
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
        siteData.set(event.seriesId, insertMissingYearAtSide(current, plan.targetYear, plan.side));
        return { applied: true, error: null };
    }
    if (plan.operationType === "DELETE_FALSE_RING") {
        siteData.set(
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
    siteData.set(event.seriesId, moveSeriesTailByOffset(
        current,
        plan.startYear,
        plan.endYear,
        plan.shiftYears,
    ));
    return { applied: true, error: null };
};

const targetPriority = (outText: string, flaggedIds: Set<string>): string[] => {
    const hints = parseCofechaHints(outText);
    const scores = new Map<string, number>();
    hints.segments.forEach((segment) => {
        if (!segment.seriesId || segment.highLag === 0) return;
        const seriesId = canonicalSeriesId(segment.seriesId);
        if (!seriesId) return;
        const zero = segment.correlationsByLag[0] ?? -1;
        const best = segment.starredR ?? segment.correlationsByLag[segment.highLag] ?? zero;
        scores.set(
            seriesId,
            (scores.get(seriesId) ?? 0)
                + 10 + Math.abs(segment.highLag) + Math.max(0, best - zero) * 10,
        );
    });
    return Array.from(flaggedIds).sort((left, right) => (
        (scores.get(right) ?? 0) - (scores.get(left) ?? 0)
        || left.localeCompare(right)
    ));
};

const modes: Mode[] = requestedMode === "both"
    ? ["truth-assisted", "automatic"]
    : [requestedMode as Mode];

const runMode = (mode: Mode) => {
    const modeDir = join(runDir, mode);
    mkdirSync(modeDir, { recursive: true });
    const siteData: RwlSiteData = new Map(Array.from(initialSite, ([seriesId, data]) => [
        seriesId,
        new Map(data),
    ]));
    const states = new Map(Array.from(parsed.values(), (series) => {
        const years = truthBySeries.get(series.id) ?? [];
        return [series.id, {
            series,
            truthYears: [...years],
            remainingTruthYears: [...years],
            tainted: false,
            wrongApplications: 0,
        } satisfies SeriesTruthState] as const;
    }));
    const observations: Observation[] = [];
    const applications: Application[] = [];
    const iterations: IterationAudit[] = [];
    const observedTruths = new Set<string>();
    const diagnosisCounts = new Map(Array.from(siteData.keys(), (seriesId) => [seriesId, 0]));
    const noActionDiagnosedIds = new Set<string>();
    const writeCheckpoint = () => {
        writeFileSync(
            join(modeDir, "checkpoint-observations.jsonl"),
            observations.map((row) => JSON.stringify(row)).join("\n") + "\n",
            "utf8",
        );
        writeFileSync(
            join(modeDir, "checkpoint-applications.jsonl"),
            applications.map((row) => JSON.stringify(row)).join("\n") + "\n",
            "utf8",
        );
        writeFileSync(
            join(modeDir, "checkpoint-iterations.jsonl"),
            iterations.map((row) => JSON.stringify(row)).join("\n") + "\n",
            "utf8",
        );
        writeFileSync(
            join(modeDir, "checkpoint-current.rwl"),
            formatTucson(siteData, false),
            "utf8",
        );
    };
    let stopReason: string | null = "max_iterations";

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        const iterationStartedAt = Date.now();
        const outText = runCofecha(siteData, mode, iteration);
        const result = parseCofechaResult(outText);
        const parts = splitReportByParts(outText);
        const cofechaFlagged = new Set(
            extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? "")
                .map(canonicalSeriesId)
                .filter((seriesId): seriesId is string => seriesId !== null),
        );
        const passCount = siteData.size - cofechaFlagged.size;
        const usePairwiseBootstrap = passCount < 3;
        const targetPool = usePairwiseBootstrap
            ? new Set(siteData.keys())
            : cofechaFlagged;
        const severityOrder = targetPriority(outText, targetPool);
        const severityRank = new Map(severityOrder.map((seriesId, index) => [seriesId, index]));
        const targetIds = [...severityOrder].sort((left, right) => (
            (diagnosisCounts.get(left) ?? 0) - (diagnosisCounts.get(right) ?? 0)
            || (severityRank.get(left) ?? Infinity) - (severityRank.get(right) ?? Infinity)
        )).slice(0, targetLimit);
        if (targetIds.length === 0) {
            stopReason = "no_flagged_series";
            iterations.push({
                iteration,
                durationMs: Date.now() - iterationStartedAt,
                referenceMode: usePairwiseBootstrap
                    ? "pairwise-leave-batch-out"
                    : "cofecha-pass",
                cofechaFlaggedCount: cofechaFlagged.size,
                referenceAnchorCount: 0,
                diagnosedTargetCount: 0,
                emittedEventCount: 0,
                selectedSeriesId: null,
                selectedEventType: null,
                stopReason,
            });
            writeCheckpoint();
            break;
        }
        const targetSet = new Set(targetIds);
        const effectiveFlagged = usePairwiseBootstrap
            ? new Set(Array.from(siteData.keys()).filter((seriesId) => (
                !pairwiseCluster.includes(seriesId) || targetSet.has(seriesId)
            )))
            : cofechaFlagged;
        let referenceConfig = createCofechaPassReferenceConfig({
            siteData,
            flaggedAIds: effectiveFlagged,
            cofechaRunId: `${mode}-${iteration}`,
            rwlHash: `${mode}-${iteration}`,
        });
        if (!referenceConfig.cofechaPassReference) {
            referenceConfig = createCofechaMasterReferenceConfig({
                siteData,
                flaggedAIds: effectiveFlagged,
                cofechaRunId: `${mode}-${iteration}`,
                rwlHash: `${mode}-${iteration}`,
                masterDatingSeries: result.masterDatingSeries,
            });
        }
        const diagnosis = diagnoseCrossdating(siteData, {
            referenceConfig,
            targetTrees: targetIds,
            cofechaText: outText,
        });
        targetIds.forEach((seriesId) => {
            diagnosisCounts.set(seriesId, (diagnosisCounts.get(seriesId) ?? 0) + 1);
        });
        const eventsBySeries = new Map<string, DiagnosisEvent[]>();
        diagnosis.events.forEach((event) => {
            const group = eventsBySeries.get(event.seriesId) ?? [];
            group.push(event);
            eventsBySeries.set(event.seriesId, group);
        });
        eventsBySeries.forEach((events) => events.sort(compareBootstrapEvents));

        targetIds.forEach((seriesId) => {
            const state = states.get(seriesId)!;
            const truthYear = state.remainingTruthYears[0];
            if (truthYear === undefined || state.tainted) return;
            const key = `${seriesId}:${truthYear}`;
            if (observedTruths.has(key)) return;
            observedTruths.add(key);
            const event = eventsBySeries.get(seriesId)?.[0] ?? null;
            const operationCorrect = event?.eventType === "missingRing";
            const windowCovered = Boolean(
                operationCorrect
                && truthYear >= event!.startYear
                && truthYear <= event!.endYear,
            );
            observations.push({
                mode,
                iteration,
                seriesId,
                truthYear,
                absoluteIdentifiable: !commonTruthYears.has(truthYear),
                response: event !== null,
                eventType: event?.eventType ?? null,
                operationCorrect,
                windowCovered,
                top1Exact: operationCorrect && event?.rankedYears[0]?.year === truthYear,
                topYear: event?.rankedYears[0]?.year ?? null,
                windowStart: event?.startYear ?? null,
                windowEnd: event?.endYear ?? null,
                confidence: event?.confidenceLevel ?? null,
                score: event?.evidence.score ?? null,
            });
        });

        const emitted = Array.from(eventsBySeries.values()).flatMap((events) => events);
        const truthAssistedSelection = emitted.filter((event) => {
            const state = states.get(event.seriesId);
            const truthYear = state?.remainingTruthYears[0];
            return !state?.tainted
                && truthYear !== undefined
                && event.eventType === "missingRing"
                && truthYear >= event.startYear
                && truthYear <= event.endYear;
        }).sort(compareBootstrapEvents)[0] ?? null;
        const automaticSelection = selectAutomaticBootstrapApplication(emitted, siteData);
        const selected = mode === "truth-assisted"
            ? truthAssistedSelection
            : automaticSelection?.event ?? null;
        if (!selected) {
            targetIds.forEach((seriesId) => noActionDiagnosedIds.add(seriesId));
            const exhaustedTargetSweep = severityOrder.every((seriesId) => (
                noActionDiagnosedIds.has(seriesId)
            ));
            stopReason = exhaustedTargetSweep
                ? mode === "truth-assisted"
                    ? "no_truth_covered_suggestion_after_full_sweep"
                    : "no_executable_suggestion_after_full_sweep"
                : null;
            iterations.push({
                iteration,
                durationMs: Date.now() - iterationStartedAt,
                referenceMode: usePairwiseBootstrap
                    ? "pairwise-leave-batch-out"
                    : "cofecha-pass",
                cofechaFlaggedCount: cofechaFlagged.size,
                referenceAnchorCount: referenceConfig.classification?.anchorPassIds.length ?? 0,
                diagnosedTargetCount: targetIds.length,
                emittedEventCount: emitted.length,
                selectedSeriesId: null,
                selectedEventType: null,
                stopReason: exhaustedTargetSweep ? stopReason : null,
            });
            writeCheckpoint();
            if (exhaustedTargetSweep) break;
            stopReason = "max_iterations";
            continue;
        }
        noActionDiagnosedIds.clear();
        const state = states.get(selected.seriesId)!;
        const expectedTruthYear = state.tainted ? null : state.remainingTruthYears[0] ?? null;
        const selectedYear = mode === "truth-assisted"
            ? expectedTruthYear!
            : automaticSelection!.selectedYear;
        const exactTruthOperation = selected.eventType === "missingRing"
            && expectedTruthYear !== null
            && selectedYear === expectedTruthYear;
        const current = siteData.get(selected.seriesId)!;
        const expected = originalSite.get(selected.seriesId)!;
        const distanceBefore = seriesDistance(current, expected);
        const applied = applyEvent(siteData, selected, selectedYear);
        const distanceAfter = seriesDistance(siteData.get(selected.seriesId)!, expected);
        if (applied.applied && exactTruthOperation) {
            state.remainingTruthYears.shift();
        } else if (applied.applied) {
            state.tainted = true;
            state.wrongApplications += 1;
        }
        const recovered = sameSeries(siteData.get(selected.seriesId)!, expected);
        if (recovered) {
            state.remainingTruthYears = [];
            state.tainted = false;
        }
        applications.push({
            mode,
            iteration,
            seriesId: selected.seriesId,
            eventType: selected.eventType,
            selectedYear,
            expectedTruthYear,
            exactTruthOperation,
            applied: applied.applied,
            distanceBefore,
            distanceAfter,
            seriesRecovered: recovered,
            error: applied.error,
        });
        iterations.push({
            iteration,
            durationMs: Date.now() - iterationStartedAt,
            referenceMode: usePairwiseBootstrap
                ? "pairwise-leave-batch-out"
                : "cofecha-pass",
            cofechaFlaggedCount: cofechaFlagged.size,
            referenceAnchorCount: referenceConfig.classification?.anchorPassIds.length ?? 0,
            diagnosedTargetCount: targetIds.length,
            emittedEventCount: emitted.length,
            selectedSeriesId: selected.seriesId,
            selectedEventType: selected.eventType,
            stopReason: null,
        });
        writeCheckpoint();
        if (!applied.applied) {
            stopReason = applied.error ?? "application_failed";
            break;
        }
        if (applications.filter((row) => !row.exactTruthOperation).length >= maxWrongApplications) {
            stopReason = "wrong_application_limit";
            break;
        }
        if (mode === "truth-assisted" && plans.every(({ series }) => (
            sameSeries(siteData.get(series.id)!, originalSite.get(series.id)!)
        ))) {
            stopReason = "all_series_recovered";
            break;
        }
    }

    const totalTruth = plans.reduce((sum, plan) => sum + plan.truthYears.length, 0);
    const identifiableTruth = plans.reduce((sum, plan) => (
        sum + plan.truthYears.filter((year) => !commonTruthYears.has(year)).length
    ), 0);
    const identifiableObservations = observations.filter((row) => row.absoluteIdentifiable);
    const responses = identifiableObservations.filter((row) => row.response);
    const operationCorrect = identifiableObservations.filter((row) => row.operationCorrect);
    const covered = identifiableObservations.filter((row) => row.windowCovered);
    const top1 = identifiableObservations.filter((row) => row.top1Exact);
    const widths = covered.map((row) => row.windowEnd! - row.windowStart! + 1)
        .sort((left, right) => left - right);
    const exactApplicationRows = applications.filter((row) => (
        row.applied && row.exactTruthOperation
    ));
    const exactApplications = exactApplicationRows.length;
    const absoluteExactApplications = exactApplicationRows.filter((row) => (
        row.expectedTruthYear !== null && !commonTruthYears.has(row.expectedTruthYear)
    )).length;
    const recoveredSeries = plans.filter(({ series }) => (
        sameSeries(siteData.get(series.id)!, originalSite.get(series.id)!)
    )).length;
    const remainingEvents = plans.reduce((sum, { series }) => (
        sum + (states.get(series.id)?.remainingTruthYears.length ?? 0)
    ), 0);
    const finalPairwiseAlignment = summarizePairwiseAlignment(siteData);
    const p90WidthIndex = Math.max(0, Math.ceil(widths.length * 0.9) - 1);
    const summary = {
        mode,
        stopReason,
        source: {
            sourceSha256,
            totalSeries: parsed.size,
            seriesWithNaturalZeros: plans.length,
            totalTruthEvents: totalTruth,
            absoluteIdentifiableEvents: identifiableTruth,
            relativeOnlyEvents: totalTruth - identifiableTruth,
            pairwiseBootstrapClusterSize: pairwiseCluster.length,
            initialRemainingZeroValues: Array.from(initialSite.values()).reduce((sum, data) => (
                sum + Array.from(data.values()).filter((value) => value === 0).length
            ), 0),
        },
        metrics: {
            responseRate: responses.length / Math.max(1, identifiableTruth),
            operationAccuracy: operationCorrect.length / Math.max(1, responses.length),
            primaryWindowCoverage: covered.length / Math.max(1, identifiableTruth),
            conditionalWindowCoverage: covered.length / Math.max(1, operationCorrect.length),
            top1: top1.length / Math.max(1, identifiableTruth),
            refusalRate: 1 - responses.length / Math.max(1, identifiableTruth),
            errorApplications: applications.filter((row) => (
                row.applied && !row.exactTruthOperation
            )).length,
            correctApplications: exactApplications,
            absoluteCorrectApplications: absoluteExactApplications,
            recoveryCompletionRate: exactApplications / Math.max(1, totalTruth),
            absoluteRecoveryCompletionRate: absoluteExactApplications
                / Math.max(1, identifiableTruth),
            recoveredSeriesRate: recoveredSeries / Math.max(1, plans.length),
            recoveredSeries,
            iterationsRun: iterations.length,
            applicationsAttempted: applications.length,
            applicationsApplied: applications.filter((row) => row.applied).length,
            totalDurationSeconds: iterations.reduce((sum, row) => sum + row.durationMs, 0)
                / 1000,
            meanIterationSeconds: iterations.reduce((sum, row) => sum + row.durationMs, 0)
                / Math.max(1, iterations.length) / 1000,
            remainingEvents,
            observedActionableEvents: observations.length,
            observedAbsoluteEvents: identifiableObservations.length,
            unobservedEvents: totalTruth - observations.length,
            medianWindowWidth: widths[Math.floor(widths.length / 2)] ?? null,
            p90WindowWidth: widths[p90WidthIndex] ?? null,
        },
        anchors: {
            minimum: iterations.length > 0
                ? Math.min(...iterations.map((row) => row.referenceAnchorCount))
                : 0,
            maximum: Math.max(...iterations.map((row) => row.referenceAnchorCount), 0),
            mean: iterations.reduce((sum, row) => sum + row.referenceAnchorCount, 0)
                / Math.max(1, iterations.length),
        },
        relativeAlignment: {
            policy: "common missing years are excluded from absolute dating metrics",
            original: originalPairwiseAlignment,
            initial: initialPairwiseAlignment,
            final: finalPairwiseAlignment,
            zeroLagBestRateChangeFromInitial:
                finalPairwiseAlignment.zeroLagBestRate - initialPairwiseAlignment.zeroLagBestRate,
        },
    };
    writeFileSync(
        join(modeDir, "observations.jsonl"),
        observations.map((row) => JSON.stringify(row)).join("\n") + "\n",
        "utf8",
    );
    writeFileSync(
        join(modeDir, "applications.jsonl"),
        applications.map((row) => JSON.stringify(row)).join("\n") + "\n",
        "utf8",
    );
    writeFileSync(
        join(modeDir, "iterations.jsonl"),
        iterations.map((row) => JSON.stringify(row)).join("\n") + "\n",
        "utf8",
    );
    writeFileSync(join(modeDir, "final.rwl"), formatTucson(siteData, false), "utf8");
    writeFileSync(join(modeDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
    console.log(`BOOTSTRAP_MODE_SUMMARY ${JSON.stringify(summary)}`);
    return summary;
};

const summaries = modes.map(runMode);
const sourceSha256After = createHash("sha256")
    .update(readFileSync(inputPath))
    .digest("hex");
if (sourceSha256After !== sourceSha256) {
    throw new Error(`source RWL changed during benchmark: ${sourceSha256} -> ${sourceSha256After}`);
}
const finalSummary = {
    inputPath,
    runDir,
    sourceSha256,
    sourceUnchanged: true,
    commonTruthYears: Array.from(commonTruthYears).sort((left, right) => left - right),
    pairwiseBootstrapCluster: pairwiseCluster,
    modes: summaries,
};
writeFileSync(join(runDir, "summary.json"), JSON.stringify(finalSummary, null, 2), "utf8");
console.log(`CO612_ALL_SERIES_BOOTSTRAP ${JSON.stringify(finalSummary)}`);
