import { execFileSync, spawn } from "node:child_process";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
    extractPart6FlaggedASeriesIds,
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import { getConfig } from "@/features/crossdating/diagnosis/config";
import {
    createLagPathCache,
    locateSequentialMissingHead,
    locateTwoStepMissingStaircase,
} from "@/features/crossdating/diagnosis/eventPath";
import { scoreFullIntervalShiftEvidence } from "@/features/crossdating/diagnosis/fullIntervalUnitEditEvidence";
import { comparePartialMoveWithMissingStaircase } from "@/features/crossdating/diagnosis/discreteMissingStaircaseCompetition";
import { preprocessSeries } from "@/features/crossdating/diagnosis/series";
import { diagnoseSeriesCore } from "@/features/crossdating/diagnosis/segments";
import type {
    DiagnosisEvent,
    SharedZeroMarkerMode,
} from "@/features/crossdating/diagnosis/types";
import {
    cofechaStyleStandardize,
    createCofechaMasterReferenceConfig,
} from "@/features/crossdating/reference";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    applyInsertRestore,
    buildMultiMissingCorrupted,
    parseRwl,
    sameSeries,
    type RwlSeries,
} from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

type Plan = {
    targetIndex: number;
    target: RwlSeries;
    truthYears: number[];
};

type EventPreview = {
    type: DiagnosisEvent["eventType"];
    startYear: number;
    endYear: number;
    width: number;
    topYear: number | null;
    shiftYears: number | null;
    lagBefore: number | null;
    lagAfter: number | null;
    score: number;
    sources: string[];
    notes: string[];
};

type MissingCandidatePreview = {
    year: number;
    rangeStart: number | null;
    rangeEnd: number | null;
    rank: number;
    score: number;
    probabilityLike: number;
    strength: string;
    hardGatePassed: boolean | null;
};

type UnitEvidencePreview = Record<
    | "combinedCorrelation"
    | "differenceCorrelation"
    | "sideStepScore"
    | "localSideStepScore11"
    | "localSideStepScore21"
    | "localSideStepScore31",
    number | null
>;

type SequentialHeadPreview = {
    year: number;
    gainOverDirect: number;
    transitionCount: number;
    headRunYears: number;
    headMeanAdvantage: number;
    fixedTailMeanAdvantage: number;
    pathStartLag: number;
};

type TwoStepStaircasePreview = {
    olderBoundaryYear: number;
    newerBoundaryYear: number;
    staircaseGain: number;
    middleMeanAdvantage: number;
    middleSamplePairs: number;
    referenceSupport: number;
    referenceCount: number;
    referenceMedianAdvantage: number;
};

type ExplicitStaircasePreview = NonNullable<ReturnType<
    typeof comparePartialMoveWithMissingStaircase
>>;

type CaseRow = {
    caseId: string;
    seriesId: string;
    step: number;
    originalMissingCount: number;
    remainingMissingCount: number;
    truthYear: number;
    nextOlderTruthYear: number | null;
    distanceToNextOlderTruth: number | null;
    seriesStartYear: number;
    seriesEndYear: number;
    elapsedMs: number;
    cofechaProblemCount: number | null;
    cofechaTargetFlagged: boolean;
    error: string | null;
    response: boolean;
    predictionCount: number;
    primaryType: DiagnosisEvent["eventType"] | null;
    operationCorrect: boolean;
    windowCovered: boolean;
    top1Exact: boolean;
    topYear: number | null;
    windowStart: number | null;
    windowEnd: number | null;
    windowWidth: number | null;
    truthRank: number | null;
    missDistance: number | null;
    partialMoveMisclassification: boolean;
    bestMissingCandidateYear: number | null;
    bestMissingCandidateExact: boolean;
    bestMissingCandidateCovered: boolean;
    anyMissingCandidateCovered: boolean;
    missingCandidates: MissingCandidatePreview[];
    unitEvidenceTopYears: UnitEvidencePreview;
    sequentialHeads: Record<string, SequentialHeadPreview | null>;
    constrainedSequentialHeads: Record<string, SequentialHeadPreview | null>;
    twoStepStaircase: TwoStepStaircasePreview | null;
    explicitStaircase: ExplicitStaircasePreview | null;
    predictions: EventPreview[];
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const viteNodePath = join(repoRoot, "node_modules", "vite-node", "vite-node.mjs");
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
const hasFlag = (name: string): boolean => args.includes(name);
const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const inputPath = resolve(valueFor("--input") ?? "D:/软件测试/co612.rwl");
const outputDir = resolve(
    valueFor("--output-dir") ?? "D:/软件测试/co612-multi-missing-results",
);
const runId = valueFor("--run-id") ?? `run-${timestamp()}`;
const runDir = resolve(valueFor("--run-dir") ?? join(outputDir, runId));
const requestedWorkers = Number(valueFor("--workers"));
const workers = Number.isInteger(requestedWorkers) && requestedWorkers > 0
    ? requestedWorkers
    : Math.max(1, Math.min(6, Math.floor(availableParallelism() / 2)));
const workerIndexRaw = valueFor("--worker-index");
const workerIndex = workerIndexRaw === null ? null : Number(workerIndexRaw);
const workerCount = Number(valueFor("--worker-count") ?? workers);
const selectedSeries = valueFor("--series")
    ?.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean) ?? null;
const resume = hasFlag("--resume");
const statsOnly = hasFlag("--stats-only");
const aggregateOnly = hasFlag("--aggregate-only");
const includeProbes = hasFlag("--include-probes");
const sharedZeroMarkerModeRaw = valueFor("--shared-zero-mode") ?? "local2";
if (!["none", "local2", "legacy6"].includes(sharedZeroMarkerModeRaw)) {
    throw new Error(`invalid --shared-zero-mode: ${sharedZeroMarkerModeRaw}`);
}
const sharedZeroMarkerMode = sharedZeroMarkerModeRaw as SharedZeroMarkerMode;

const assertSafeRunDirectory = (): void => {
    const rel = relative(outputDir, runDir);
    if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`)) {
        throw new Error(`unsafe result directory: ${runDir}`);
    }
};

if (!existsSync(inputPath)) throw new Error(`RWL not found: ${inputPath}`);
if (!existsSync(cofechaExe)) throw new Error(`COFECHA executable not found: ${cofechaExe}`);
assertSafeRunDirectory();

const parsed = parseRwl(readFileSync(inputPath, "utf8"));
const cleanSite: RwlSiteData = new Map(
    Array.from(parsed, ([seriesId, series]) => [
        seriesId,
        new Map(series.valuesByYear),
    ]),
);
const plans: Plan[] = Array.from(parsed.values())
    .map((target, targetIndex) => ({
        targetIndex,
        target,
        truthYears: Array.from(target.valuesByYear)
            .filter(([, value]) => value === 0)
            .map(([year]) => year)
            .sort((left, right) => right - left),
    }))
    .filter((plan) => plan.truthYears.length > 0)
    .filter((plan) => !selectedSeries || selectedSeries.includes(plan.target.id.toLowerCase()));

const workerOwners = (() => {
    const loads = Array.from({ length: workerCount }, () => 0);
    const owners = new Map<string, number>();
    [...plans]
        .sort((left, right) => (
            right.truthYears.length - left.truthYears.length
            || left.targetIndex - right.targetIndex
        ))
        .forEach((plan) => {
            const owner = loads.reduce((best, load, index) => (
                load < loads[best] ? index : best
            ), 0);
            owners.set(plan.target.id, owner);
            loads[owner] += plan.truthYears.length;
        });
    return owners;
})();

const previewEvent = (event: DiagnosisEvent): EventPreview => ({
    type: event.eventType,
    startYear: event.startYear,
    endYear: event.endYear,
    width: event.endYear - event.startYear + 1,
    topYear: [...event.rankedYears].sort((left, right) => left.rank - right.rank)[0]?.year ?? null,
    shiftYears: event.shiftYears ?? null,
    lagBefore: event.evidence.lagBefore,
    lagAfter: event.evidence.lagAfter,
    score: event.evidence.score,
    sources: event.evidence.algorithmSources,
    notes: event.evidence.notes,
});

const runCofecha = (siteData: RwlSiteData): string => {
    const workDir = mkdtempSync(join(tmpdir(), "co612-all-missing-"));
    try {
        writeFileSync(join(workDir, "INPUT.RWL"), formatTucson(siteData, false), "utf8");
        execFileSync(cofechaExe, [], {
            cwd: workDir,
            input: "very\nINPUT.RWL\n\n\n\n\n\n\n",
            timeout: 30_000,
            stdio: ["pipe", "ignore", "pipe"],
        });
        return readFileSync(join(workDir, "VERYCOF.OUT"), "utf8");
    } finally {
        rmSync(workDir, { force: true, recursive: true });
    }
};

const quantile = (values: number[], probability: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) * probability)] ?? null;
};

const rate = (count: number, total: number): number => total > 0 ? count / total : 0;
const histogram = (values: Array<string | number | null>) => Object.fromEntries(
    Array.from(new Set(values.map((value) => String(value))))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
        .map((value) => [value, values.filter((candidate) => String(candidate) === value).length]),
);

const executeCase = (
    plan: Plan,
    valuesByYear: Map<number, number>,
    truthYear: number,
    step: number,
): CaseRow => {
    const started = performance.now();
    const base = {
        caseId: `${plan.target.id}:${step}:${truthYear}`,
        seriesId: plan.target.id,
        step,
        originalMissingCount: plan.truthYears.length,
        remainingMissingCount: plan.truthYears.length - step + 1,
        truthYear,
        nextOlderTruthYear: plan.truthYears[step] ?? null,
        distanceToNextOlderTruth: plan.truthYears[step] === undefined
            ? null
            : truthYear - plan.truthYears[step],
        seriesStartYear: plan.target.startYear,
        seriesEndYear: plan.target.endYear,
    };
    try {
        const siteData = new Map(cleanSite);
        siteData.set(plan.target.id, new Map(valuesByYear));
        const outText = runCofecha(siteData);
        const result = parseCofechaResult(outText);
        const parts = splitReportByParts(outText);
        const flaggedIds = extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? "");
        const referenceConfig = createCofechaMasterReferenceConfig({
            siteData,
            flaggedAIds: flaggedIds,
            cofechaRunId: base.caseId,
            rwlHash: base.caseId,
            masterDatingSeries: result.masterDatingSeries,
        });
        let unitEvidenceTopYears: UnitEvidencePreview = {
            combinedCorrelation: null,
            differenceCorrelation: null,
            sideStepScore: null,
            localSideStepScore11: null,
            localSideStepScore21: null,
            localSideStepScore31: null,
        };
        let sequentialHeads: Record<string, SequentialHeadPreview | null> = {};
        let constrainedSequentialHeads: Record<string, SequentialHeadPreview | null> = {};
        let twoStepStaircase: TwoStepStaircasePreview | null = null;
        let explicitStaircase: ExplicitStaircasePreview | null = null;
        let cofechaDiagnosis: ReturnType<typeof diagnoseSeriesCore> = null;
        let effectiveConfig: ReturnType<typeof getConfig> | null = null;
        if (includeProbes) {
            effectiveConfig = getConfig({ referenceConfig });
            cofechaDiagnosis = diagnoseSeriesCore(
                siteData,
                plan.target.id,
                effectiveConfig,
                (series) => new Map(cofechaStyleStandardize(series).map(
                    (point) => [point.year, point.value],
                )),
            );
            const rawDiagnosis = diagnoseSeriesCore(
                siteData,
                plan.target.id,
                effectiveConfig,
                preprocessSeries,
            );
            const evidenceRows = cofechaDiagnosis
                ? scoreFullIntervalShiftEvidence(cofechaDiagnosis, -1, 4)
                : rawDiagnosis
                    ? scoreFullIntervalShiftEvidence(rawDiagnosis, -1, 4)
                    : [];
            const evidenceMetrics = [
                "combinedCorrelation",
                "differenceCorrelation",
                "sideStepScore",
                "localSideStepScore11",
                "localSideStepScore21",
                "localSideStepScore31",
            ] as const;
            unitEvidenceTopYears = Object.fromEntries(evidenceMetrics.map((metric) => [
                metric,
                evidenceRows.slice().sort((left, right) => (
                    right[metric] - left[metric] || right.year - left.year
                ))[0]?.year ?? null,
            ])) as UnitEvidencePreview;
            const pathCache = createLagPathCache();
            sequentialHeads = Object.fromEntries([
                0,
                0.25,
                0.5,
                1,
                2,
                4,
            ].map((penalty) => {
                const head = cofechaDiagnosis
                    ? locateSequentialMissingHead(
                            cofechaDiagnosis,
                            siteData,
                            { minLag: effectiveConfig.lagMin },
                            pathCache,
                            penalty,
                        )
                    : null;
                return [String(penalty), head ? {
                    year: head.year,
                    gainOverDirect: head.gainOverDirect,
                    transitionCount: head.transitionCount,
                    headRunYears: head.headRunYears,
                    headMeanAdvantage: head.headMeanAdvantage,
                    fixedTailMeanAdvantage: head.fixedTailMeanAdvantage,
                    pathStartLag: head.pathStartLag,
                } : null];
            }));
        }
        const events = diagnoseCrossdating(siteData, {
            referenceConfig,
            targetTrees: [plan.target.id],
            cofechaText: outText,
            sharedZeroMarkerMode,
        });
        const ownEvents = events.events.filter((event) => event.seriesId === plan.target.id);
        if (includeProbes && cofechaDiagnosis && effectiveConfig) {
            const primaryPartial = ownEvents.find((event) => (
                event.eventType === "partialMove"
                && (event.shiftYears ?? 0) <= -2
            ));
            const cumulativeLag = primaryPartial?.shiftYears ?? null;
            if (cumulativeLag !== null) {
                const constrainedCache = createLagPathCache();
                constrainedSequentialHeads = Object.fromEntries([
                    0,
                    0.05,
                    0.1,
                    0.25,
                    0.5,
                ].map((penalty) => {
                    const head = locateSequentialMissingHead(
                        cofechaDiagnosis!,
                        siteData,
                        {
                            minLag: cumulativeLag,
                            maxPartialGapYears: Math.abs(cumulativeLag),
                        },
                        constrainedCache,
                        penalty,
                    );
                    return [String(penalty), head ? {
                        year: head.year,
                        gainOverDirect: head.gainOverDirect,
                        transitionCount: head.transitionCount,
                        headRunYears: head.headRunYears,
                        headMeanAdvantage: head.headMeanAdvantage,
                        fixedTailMeanAdvantage: head.fixedTailMeanAdvantage,
                        pathStartLag: head.pathStartLag,
                    } : null];
                }));
                explicitStaircase = comparePartialMoveWithMissingStaircase(
                    cofechaDiagnosis,
                    siteData,
                    primaryPartial!,
                    true,
                    constrainedSequentialHeads["0"]?.year ?? null,
                );
                if (cumulativeLag === -2) {
                    const staircase = locateTwoStepMissingStaircase(
                        cofechaDiagnosis,
                        siteData,
                        primaryPartial!,
                        {
                            minLag: cumulativeLag,
                            maxPartialGapYears: Math.abs(cumulativeLag),
                        },
                        constrainedCache,
                    );
                    twoStepStaircase = staircase ? {
                        olderBoundaryYear: staircase.olderBoundaryYear,
                        newerBoundaryYear: staircase.newerBoundaryYear,
                        staircaseGain: staircase.staircaseGain,
                        middleMeanAdvantage: staircase.middleMeanAdvantage,
                        middleSamplePairs: staircase.middleSamplePairs,
                        referenceSupport: staircase.referenceSupport,
                        referenceCount: staircase.referenceCount,
                        referenceMedianAdvantage: staircase.referenceMedianAdvantage,
                    } : null;
                }
            }
        }
        const missingCandidates = events.candidates
            .filter((candidate) => (
                candidate.targetTree === plan.target.id
                && candidate.operationType === "INSERT_MISSING_RING"
                && candidate.targetYear !== undefined
            ))
            .sort((left, right) => left.rank - right.rank)
            .map((candidate): MissingCandidatePreview => ({
                year: candidate.targetYear!,
                rangeStart: candidate.suggestedRange?.startYear ?? null,
                rangeEnd: candidate.suggestedRange?.endYear ?? null,
                rank: candidate.rank,
                score: candidate.score,
                probabilityLike: candidate.probabilityLike,
                strength: candidate.candidateStrength,
                hardGatePassed: candidate.evidence.evaluationDelta?.hardGatePassed ?? null,
            }));
        const bestMissingCandidate = missingCandidates[0] ?? null;
        const candidateCovers = (candidate: MissingCandidatePreview): boolean => (
            candidate.year === truthYear
            || (
                candidate.rangeStart !== null
                && candidate.rangeEnd !== null
                && truthYear >= candidate.rangeStart
                && truthYear <= candidate.rangeEnd
            )
        );
        const predictions = ownEvents.map(previewEvent);
        const primary = predictions[0] ?? null;
        const truthRank = ownEvents[0]?.rankedYears.find((row) => row.year === truthYear)?.rank ?? null;
        const operationCorrect = primary?.type === "missingRing";
        const windowCovered = operationCorrect
            && truthYear >= primary.startYear
            && truthYear <= primary.endYear;
        const top1Exact = operationCorrect && primary.topYear === truthYear;
        const missDistance = operationCorrect && !windowCovered
            ? truthYear < primary.startYear
                ? primary.startYear - truthYear
                : truthYear - primary.endYear
            : null;
        return {
            ...base,
            elapsedMs: performance.now() - started,
            cofechaProblemCount: result.possibleProblemsCount,
            cofechaTargetFlagged: Array.from(flaggedIds).some((id) => (
                id.toLowerCase() === plan.target.id.toLowerCase()
            )),
            error: null,
            response: primary !== null,
            predictionCount: predictions.length,
            primaryType: primary?.type ?? null,
            operationCorrect,
            windowCovered,
            top1Exact,
            topYear: operationCorrect ? primary.topYear : null,
            windowStart: operationCorrect ? primary.startYear : null,
            windowEnd: operationCorrect ? primary.endYear : null,
            windowWidth: operationCorrect ? primary.width : null,
            truthRank,
            missDistance,
            partialMoveMisclassification: primary?.type === "partialMove",
            bestMissingCandidateYear: bestMissingCandidate?.year ?? null,
            bestMissingCandidateExact: bestMissingCandidate?.year === truthYear,
            bestMissingCandidateCovered: bestMissingCandidate
                ? candidateCovers(bestMissingCandidate)
                : false,
            anyMissingCandidateCovered: missingCandidates.some(candidateCovers),
            missingCandidates,
            unitEvidenceTopYears,
            sequentialHeads,
            constrainedSequentialHeads,
            twoStepStaircase,
            explicitStaircase,
            predictions,
        };
    } catch (error) {
        return {
            ...base,
            elapsedMs: performance.now() - started,
            cofechaProblemCount: null,
            cofechaTargetFlagged: false,
            error: error instanceof Error ? error.stack ?? error.message : String(error),
            response: false,
            predictionCount: 0,
            primaryType: null,
            operationCorrect: false,
            windowCovered: false,
            top1Exact: false,
            topYear: null,
            windowStart: null,
            windowEnd: null,
            windowWidth: null,
            truthRank: null,
            missDistance: null,
            partialMoveMisclassification: false,
            bestMissingCandidateYear: null,
            bestMissingCandidateExact: false,
            bestMissingCandidateCovered: false,
            anyMissingCandidateCovered: false,
            missingCandidates: [],
            unitEvidenceTopYears: {
                combinedCorrelation: null,
                differenceCorrelation: null,
                sideStepScore: null,
                localSideStepScore11: null,
                localSideStepScore21: null,
                localSideStepScore31: null,
            },
            sequentialHeads: {},
            constrainedSequentialHeads: {},
            twoStepStaircase: null,
            explicitStaircase: null,
            predictions: [],
        };
    }
};

const runWorker = (): void => {
    if (workerIndex === null) throw new Error("worker index is required");
    mkdirSync(runDir, { recursive: true });
    const outputPath = join(runDir, `cases.worker-${workerIndex}-of-${workerCount}.jsonl`);
    const completedIds = resume && existsSync(outputPath)
        ? new Set(readFileSync(outputPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => (
            (JSON.parse(line) as CaseRow).caseId
        )))
        : new Set<string>();
    if (!resume) writeFileSync(outputPath, "", "utf8");
    let buffer = "";
    let completed = 0;
    plans.filter((plan) => workerOwners.get(plan.target.id) === workerIndex).forEach((plan) => {
        let current = buildMultiMissingCorrupted(plan.target.valuesByYear, plan.truthYears);
        plan.truthYears.forEach((truthYear, index) => {
            const caseId = `${plan.target.id}:${index + 1}:${truthYear}`;
            if (!completedIds.has(caseId)) {
                const row = executeCase(plan, current, truthYear, index + 1);
                buffer += `${JSON.stringify(row)}\n`;
                completed += 1;
                if (completed % 5 === 0) {
                    appendFileSync(outputPath, buffer, "utf8");
                    buffer = "";
                    console.log(`progress cases=${completed} series=${plan.target.id} year=${truthYear}`);
                }
            }
            current = applyInsertRestore(current, truthYear);
        });
        if (!sameSeries(current, plan.target.valuesByYear)) {
            throw new Error(`truth reconstruction failed for ${plan.target.id}`);
        }
    });
    if (buffer) appendFileSync(outputPath, buffer, "utf8");
    console.log(`complete cases=${completed} output=${outputPath}`);
};

const summarize = (rows: CaseRow[]) => {
    const responses = rows.filter((row) => row.response);
    const correct = rows.filter((row) => row.operationCorrect);
    const covered = rows.filter((row) => row.windowCovered);
    const widths = correct.flatMap((row) => row.windowWidth === null ? [] : [row.windowWidth]);
    const elapsed = rows.map((row) => row.elapsedMs);
    const wrongTop1Rows = rows.filter((row) => (
        row.operationCorrect
        && row.topYear !== null
        && row.topYear !== row.truthYear
    ));
    const wrongTop1Counts = wrongTop1Rows.reduce((counts, row) => {
        counts.set(row.topYear!, (counts.get(row.topYear!) ?? 0) + 1);
        return counts;
    }, new Map<number, number>());
    const repeatedAttractorYears = new Set(Array.from(wrongTop1Counts)
        .filter(([, count]) => count >= 3)
        .map(([year]) => year));
    const repeatedAttractionRows = wrongTop1Rows.filter((row) => (
        repeatedAttractorYears.has(row.topYear!)
    ));
    return {
        cases: rows.length,
        errors: rows.filter((row) => row.error !== null).length,
        responseRate: rate(responses.length, rows.length),
        refusalRate: rate(rows.length - responses.length, rows.length),
        operationAccuracy: rate(correct.length, rows.length),
        primaryWindowCoverage: rate(covered.length, rows.length),
        windowCoverageGivenMissingResponse: rate(covered.length, correct.length),
        top1Exact: rate(rows.filter((row) => row.top1Exact).length, rows.length),
        partialMoveMisclassificationRate: rate(
            rows.filter((row) => row.partialMoveMisclassification).length,
            rows.length,
        ),
        bestMissingCandidateResponseRate: rate(
            rows.filter((row) => row.bestMissingCandidateYear !== null).length,
            rows.length,
        ),
        bestMissingCandidateExactRate: rate(
            rows.filter((row) => row.bestMissingCandidateExact).length,
            rows.length,
        ),
        bestMissingCandidateCoverage: rate(
            rows.filter((row) => row.bestMissingCandidateCovered).length,
            rows.length,
        ),
        anyMissingCandidateCoverage: rate(
            rows.filter((row) => row.anyMissingCandidateCovered).length,
            rows.length,
        ),
        medianWindowWidth: quantile(widths, 0.5),
        p90WindowWidth: quantile(widths, 0.9),
        widthHistogram: histogram(widths),
        primaryTypeHistogram: histogram(rows.map((row) => row.primaryType)),
        missDistanceHistogram: histogram(rows.filter((row) => (
            row.operationCorrect && !row.windowCovered
        )).map((row) => row.missDistance)),
        fixedWrongTop1Attraction: {
            repeatedAttractorYears: repeatedAttractorYears.size,
            cases: repeatedAttractionRows.length,
            rate: rate(repeatedAttractionRows.length, rows.length),
            distantCases: repeatedAttractionRows.filter((row) => (
                Math.abs(row.topYear! - row.truthYear) > 2
            )).length,
            topYears: Array.from(wrongTop1Counts)
                .sort((left, right) => right[1] - left[1] || right[0] - left[0])
                .slice(0, 12)
                .map(([year, count]) => ({ year, count })),
        },
        medianElapsedMs: quantile(elapsed, 0.5),
        p90ElapsedMs: quantile(elapsed, 0.9),
    };
};

const csvEscape = (value: unknown): string => {
    const text = value === null || value === undefined
        ? ""
        : typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const aggregate = () => {
    const rows = readdirSync(runDir)
        .filter((name) => /^cases\.worker-\d+-of-\d+\.jsonl$/.test(name))
        .flatMap((name) => readFileSync(join(runDir, name), "utf8")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as CaseRow));
    rows.sort((left, right) => (
        left.seriesId.localeCompare(right.seriesId)
        || left.step - right.step
    ));
    const expectedCases = plans.reduce((sum, plan) => sum + plan.truthYears.length, 0);
    const duplicateCases = rows.length - new Set(rows.map((row) => row.caseId)).size;
    const bySeries = Object.fromEntries(plans.map((plan) => {
        const seriesRows = rows.filter((row) => row.seriesId === plan.target.id);
        return [plan.target.id, {
            ...summarize(seriesRows),
            allWindowsCovered: seriesRows.length === plan.truthYears.length
                && seriesRows.every((row) => row.windowCovered),
            allTop1Exact: seriesRows.length === plan.truthYears.length
                && seriesRows.every((row) => row.top1Exact),
        }];
    }));
    const summary = {
        generatedAt: new Date().toISOString(),
        inputPath,
        runId,
        configuration: {
            workflow: "remove all expert zero years; restore newest-to-oldest",
            referenceMode: "fresh bundled COFECHA master after every truth repair",
            sharedZeroMarkerMode,
            workers,
            selectedSeries,
            includeProbes,
        },
        source: {
            totalSeries: parsed.size,
            seriesWithZeros: plans.length,
            expectedCases,
            completedCases: rows.length,
            duplicateCases,
        },
        overall: summarize(rows),
        completeSeries: {
            allWindowsCovered: Object.values(bySeries).filter((value) => value.allWindowsCovered).length,
            allTop1Exact: Object.values(bySeries).filter((value) => value.allTop1Exact).length,
            total: plans.length,
        },
        byOriginalMissingCount: Object.fromEntries(
            Array.from(new Set(rows.map((row) => row.originalMissingCount)))
                .sort((left, right) => left - right)
                .map((count) => [count, summarize(rows.filter((row) => (
                    row.originalMissingCount === count
                )))]),
        ),
        byRemainingMissingCount: Object.fromEntries(
            Array.from(new Set(rows.map((row) => row.remainingMissingCount)))
                .sort((left, right) => left - right)
                .map((count) => [count, summarize(rows.filter((row) => (
                    row.remainingMissingCount === count
                )))]),
        ),
        bySeries,
        failures: rows.filter((row) => !row.windowCovered),
    };
    writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    const columns = Object.keys(rows[0] ?? {}) as Array<keyof CaseRow>;
    writeFileSync(join(runDir, "cases.csv"), [
        columns.join(","),
        ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
    ].join("\r\n") + "\r\n", "utf8");
    console.log(`CO612_MULTI_MISSING_SUMMARY ${JSON.stringify({
        source: summary.source,
        overall: summary.overall,
        completeSeries: summary.completeSeries,
    })}`);
    console.log(`summary=${join(runDir, "summary.json")}`);
    console.log(`cases=${join(runDir, "cases.csv")}`);
    if (rows.length !== expectedCases || duplicateCases !== 0) {
        throw new Error(
            `incomplete run: expected=${expectedCases} rows=${rows.length} duplicates=${duplicateCases}`,
        );
    }
};

const pipeLines = (stream: NodeJS.ReadableStream, prefix: string, error = false) => {
    let pending = "";
    stream.on("data", (chunk) => {
        pending += String(chunk);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        lines.filter(Boolean).forEach((line) => (error ? console.error : console.log)(`${prefix}${line}`));
    });
    stream.on("end", () => {
        if (pending) (error ? console.error : console.log)(`${prefix}${pending}`);
    });
};

const runParent = async (): Promise<void> => {
    if (!resume) rmSync(runDir, { force: true, recursive: true });
    mkdirSync(runDir, { recursive: true });
    const commonArgs = [
        "--input", inputPath,
        "--output-dir", outputDir,
        "--run-id", runId,
        "--run-dir", runDir,
        "--worker-count", String(workers),
        "--workers", String(workers),
        "--shared-zero-mode", sharedZeroMarkerMode,
        ...(selectedSeries ? ["--series", selectedSeries.join(",")] : []),
        ...(resume ? ["--resume"] : []),
        ...(includeProbes ? ["--include-probes"] : []),
    ];
    await Promise.all(Array.from({ length: workers }, (_, index) => new Promise<void>((done, fail) => {
        const child = spawn(process.execPath, [
            viteNodePath,
            scriptPath,
            "--",
            ...commonArgs,
            "--worker-index", String(index),
        ], {
            cwd: repoRoot,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        pipeLines(child.stdout, `[worker ${index}] `);
        pipeLines(child.stderr, `[worker ${index}] `, true);
        child.on("error", fail);
        child.on("exit", (code) => code === 0 ? done() : fail(new Error(`worker ${index} exited ${code}`)));
    })));
    aggregate();
};

console.log(`BENCHMARK_STATS ${JSON.stringify({
    inputPath,
    totalSeries: parsed.size,
    seriesWithZeros: plans.length,
    totalMissingYears: plans.reduce((sum, plan) => sum + plan.truthYears.length, 0),
    workers,
    sharedZeroMarkerMode,
    runDir,
})}`);
if (statsOnly) {
    // Nothing else to do.
} else if (aggregateOnly) {
    aggregate();
} else if (workerIndex !== null) {
    runWorker();
} else {
    await runParent();
}
