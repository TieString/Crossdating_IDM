/**
 * ITRDB 大规模真实数据缺轮检测基准（gated RUN_ITRDB_BENCH=1）。
 *
 * 国际树轮库（笔记/数据/itrdb/measurements）数据已交叉定年，0 = 真实专家确认的缺轮。
 * 对每条单缺轮序列：移除该 0 重建缺轮序列 → 对同文件其它（已定年）序列诊断 → 看是否在 0 处建议插入。
 * 大规模、多物种/地区，检验"高质量数据上 top1 是否更高"。默认测基线（无 COFECHA）。
 *
 * 运行：RUN_ITRDB_BENCH=1 npx vitest run itrdbBenchmark
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diagnoseCrossdating } from "../engine";
import { getConfig } from "../config";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import { cofechaStyleStandardize } from "../../reference";
import {
    applyInsertRestore,
    buildLeaveOneOutMaster,
    buildMultiMissingCorrupted,
    buildSyntheticSite,
    createEndAnchoredFalseRingCase,
    createEndAnchoredMissingRingCase,
    createPartialRangeMoveCase,
    measureLocalSignalStrength,
    pickStratifiedCalendarYear,
    reconstructMissingFromZero,
    sameSeries,
    type BenchmarkPositionStratum,
    type RwlSeries as FixtureSeries,
} from "./rdmFixture";
import { matchDiagnosisEvents, type TruthEvent } from "./eventMetrics";
import { diagnoseTargetBundle, diagnoseTargetEvents } from "./targetDiagnosis";
import {
    scoreLagTransitionHypotheses,
    type EventPathConfig,
} from "../eventPath";
import { INTERNAL_EVENT_PATH_CONFIG } from "../eventEnsemble";
import { locateReturnToZeroEvents } from "../transitionScan";
import { diagnoseSeriesCore } from "../segments";
import { preprocessSeries } from "../series";
import {
    scoreReferenceConsensusChangePoints,
    scorePiecewiseChangePoints,
    type PiecewiseChangePointScore,
    type ReferenceConsensusChangePointScore,
} from "../piecewiseChangePoint";
import { scoreCumulativeLagChangePoints } from "../cumulativeLagChangePoint";
import { scoreReferenceTransitionConsensus } from "../referenceTransitionConsensus";
import { scoreFullIntervalReferenceEditEvidence } from "../fullIntervalReferenceEditEvidence";
import {
    firstFixedYearFromLastMovedYear,
    getAutomaticEventShiftCandidates,
    getAutomaticPartialShiftCandidates,
} from "../partialMoveSemantics";
import {
    getJointCounterfactualOperationScores,
    scoreJointCounterfactualOperations,
} from "../jointCounterfactualOperation";
import { scoreJointCounterfactualPath } from "../jointCounterfactualPath";
import {
    scoreDynamicJointOperation,
    summarizeJointOperationRegion,
} from "../jointOperationSelector";
import {
    scorePerReferenceCounterfactualEvidence,
    summarizePerReferenceCounterfactualRows,
} from "../perReferenceCounterfactualEvidence";
import {
    observeCounterfactualLocator,
    type CounterfactualLocatorAuditRow,
} from "../counterfactualEventLocator";
import { locateSegmentedLagEvents } from "../segmentedEventPath";
import {
    scoreGainGatedRecoveryHypotheses,
    type GainGatedRecoveryHypothesis,
} from "../gainGatedEventRecovery";
import { voteForAdjacentUnitPairLocalized } from "../eventReferenceVoting";
import { scoreFixedContextTransitions } from "../fixedContextTransition";
import type { DiagnosisEvent, NumericSeries, SeriesCoreDiagnosis } from "../types";
import {
    scoreUnitBoundaries,
    type UnitBreakpointScore,
} from "../unitBreakpointRefinement";
import {
    scoreNegativePartialMoveBoundaries,
    type GapBoundaryScore,
} from "../partialBreakpointRefinement";
import {
    scorePairedCoreUnitBoundaries,
    type PairedCoreBreakpointScore,
} from "./pairedCoreBreakpoint.experiment";
import {
    bestExhaustiveScore,
    exhaustiveRemoteMargin,
    bestLocalizedScore,
    bestPairwiseScore,
    pairwiseRemoteMargin,
    scanExhaustivePartialMove,
    scanExhaustiveUnitEdit,
    scanLocalizedPartialMove,
    scanLocalizedUnitEdit,
    scanPairwisePartialMove,
    scanPairwiseUnitEdit,
    scoreExhaustiveSeries,
    type ExhaustiveScoreName,
    type LocalizedScoreName,
    type PairwiseScoreName,
} from "./exhaustiveEditScan.experiment";
import {
    buildFixedWindowCounterfactualContext,
    scoreFixedWindowCounterfactual,
} from "./fixedWindowCounterfactual.experiment";

const ITRDB_DIR_CANDIDATES = [
    process.env.CROSSDATING_ITRDB_DIR,
    "D:/软件测试/数据/ITRDB/itrdb_download/measurements",
    fileURLToPath(new URL("../../../../../笔记/数据/itrdb/measurements/", import.meta.url)),
].filter((candidate): candidate is string => Boolean(candidate));
const ITRDB_DIR = ITRDB_DIR_CANDIDATES.find((candidate) => existsSync(candidate))
    ?? ITRDB_DIR_CANDIDATES[ITRDB_DIR_CANDIDATES.length - 1];
const COF_EXE = process.env.COFECHA_EXE?.trim() ?? "";
const COF_DIR = COF_EXE ? dirname(COF_EXE) : "";
const COF_INPUT = COF_DIR ? join(COF_DIR, "_bench.rwl") : "";
const COF_OUTPUT = COF_DIR ? join(COF_DIR, "TESTCOF.OUT") : "";
// 全量跑（用上全部 ITRDB 文件）远超默认 10 分钟，单个 it 超时按需放大（默认仍 10 分钟）。
const BENCH_TIMEOUT = Number(process.env.ITRDB_TIMEOUT ?? 600000);
const cofechaBenchmarkPreprocess = (series: NumericSeries): NumericSeries => new Map(
    cofechaStyleStandardize(series).map((point) => [point.year, point.value]),
);

const runCofecha = (site: RwlSiteData): string | null => {
    try {
        writeFileSync(COF_INPUT, formatTucson(site, false), "utf8");
        execFileSync(COF_EXE, [], { cwd: COF_DIR, input: "test\n_bench.rwl\n\n\n\n\n\n", timeout: 30000, stdio: ["pipe", "ignore", "ignore"] });
        return existsSync(COF_OUTPUT) ? readFileSync(COF_OUTPUT, "utf8") : null;
    } catch { return null; }
};
const STOP_MARKERS = new Set([999, -999, 9990, -9999]);

type Series = { id: string; valuesByYear: Map<number, number>; startYear: number; endYear: number; zeros: number[] };

/** 解析 ITRDB/Tucson 文件：每行 `id decade v...`；999/-9999=停止；0=缺轮（保留）；过滤头部 junk。 */
const parseItrdb = (text: string): Map<string, Series> => {
    const byId = new Map<string, Map<number, number>>();
    text.split(/\r?\n/).forEach((raw) => {
        const line = raw.trimEnd();
        if (!line.trim()) return;
        const tokens = line.trim().split(/\s+/);
        if (tokens.length < 3) return;
        const id = tokens[0];
        const decade = Number(tokens[1]);
        if (!Number.isFinite(decade) || decade < 1000 || decade > 2100) return; // 跳过头部行（小序号）
        const map = byId.get(id) ?? new Map<number, number>();
        let year = decade;
        for (let i = 2; i < tokens.length; i += 1) {
            const v = Number(tokens[i]);
            if (!Number.isFinite(v)) continue;
            if (STOP_MARKERS.has(v)) break;
            if (v < 0) continue;
            map.set(year, v);
            year += 1;
        }
        byId.set(id, map);
    });
    const out = new Map<string, Series>();
    byId.forEach((valuesByYear, id) => {
        if (valuesByYear.size < 30) return;
        const years = Array.from(valuesByYear.keys()).sort((a, b) => a - b);
        const startYear = years[0];
        const endYear = years[years.length - 1];
        if (startYear < 1000 || endYear > 2100) return;
        const zeros = years.filter((y) => valuesByYear.get(y) === 0);
        out.set(id, { id, valuesByYear, startYear, endYear, zeros });
    });
    return out;
};

const collectFiles = (dir: string, acc: string[]) => {
    for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        const st = statSync(full);
        if (st.isDirectory()) collectFiles(full, acc);
        else if (entry.toLowerCase().endsWith(".rwl")) acc.push(full);
    }
};

const sampleFiles = (
    allFiles: string[],
    sampleCount: number,
    offset = 0,
    skipCount = 0,
): string[] => {
    const stride = Math.max(1, Math.floor(allFiles.length / sampleCount));
    const normalizedOffset = ((Math.floor(offset) % stride) + stride) % stride;
    return allFiles
        .filter((_, index) => index >= normalizedOffset && (index - normalizedOffset) % stride === 0)
        .slice(
            Math.max(0, Math.floor(skipCount)),
            Math.max(0, Math.floor(skipCount)) + sampleCount,
        );
};

type BenchmarkFileSplit = "train" | "calibration" | "validation";

const stablePathHash = (value: string): number => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
};

const inBenchmarkFileSplit = (
    file: string,
    split: BenchmarkFileSplit,
): boolean => {
    const relativePath = file.startsWith(ITRDB_DIR)
        ? file.slice(ITRDB_DIR.length)
        : file;
    const bucket = stablePathHash(
        relativePath.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase(),
    ) % 10;
    if (split === "train") return bucket <= 5;
    // Keep model fitting, calibration, and final validation file-disjoint.
    if (split === "calibration") return bucket >= 6 && bucket <= 7;
    return bucket >= 8;
};

const normalizedBenchmarkRelativePath = (file: string): string => (
    (file.startsWith(ITRDB_DIR) ? file.slice(ITRDB_DIR.length) : file)
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .toLowerCase()
);

const readFrozenFileManifest = (manifestPath: string | undefined): Set<string> | null => {
    if (!manifestPath) return null;
    const text = readFileSync(manifestPath, "utf8");
    const trimmed = text.trim();
    const values = trimmed.startsWith("[")
        ? JSON.parse(trimmed) as unknown
        : trimmed.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
        throw new Error("ITRDB_FROZEN_FILE_MANIFEST must contain a JSON string array or one path per line");
    }
    return new Set(values.map((value) => normalizedBenchmarkRelativePath(value)));
};

const overlap = (a: Series, b: Series): number => {
    let n = 0;
    a.valuesByYear.forEach((_, y) => { if (b.valuesByYear.has(y)) n += 1; });
    return n;
};


const enabled = process.env.RUN_ITRDB_BENCH === "1" && existsSync(ITRDB_DIR);
const d = enabled ? describe : describe.skip;

d("ITRDB 大规模缺轮基准", () => {
    it("真实缺轮 top5/top1（基线，无 COFECHA）", () => {
        const allFiles: string[] = [];
        collectFiles(ITRDB_DIR, allFiles);
        allFiles.sort();
        // 跨地区均匀步进采样，限规模。
        const sampleCount = Number(process.env.ITRDB_FILES ?? 200);
        const files = sampleFiles(allFiles, sampleCount);

        let attempted = 0;
        let top5 = 0;
        let top1 = 0;
        let exact = 0;
        // 不同容差下的 top1（首位建议落在真值 ±tol 内）：区域/段级识别口径。
        const top1Tol: Record<number, number> = { 1: 0, 2: 0, 3: 0, 5: 0 };
        const top5Tol: Record<number, number> = { 1: 0, 2: 0, 3: 0, 5: 0 };
        const maxCasesPerFile = 3;
        const maxCases = Number(process.env.ITRDB_CASES ?? 500);

        for (const file of files) {
            if (attempted >= maxCases) break;
            let parsed: Map<string, Series>;
            try { parsed = parseItrdb(readFileSync(file, "utf8")); } catch { continue; }
            const series = Array.from(parsed.values());
            if (series.length < 6) continue;
            const singleZero = series.filter((s) => (
                s.zeros.length === 1
                && s.valuesByYear.size >= 120
                && s.zeros[0] - s.startYear >= 15
                && s.endYear - s.zeros[0] >= 15
            ));
            let casesThisFile = 0;
            for (const target of singleZero) {
                if (casesThisFile >= maxCasesPerFile || attempted >= maxCases) break;
                const refs = series.filter((s) => s.id !== target.id && overlap(s, target) >= 80);
                if (refs.length < 5) continue;
                const zeroYear = target.zeros[0];
                const corrupted = reconstructMissingFromZero(target.valuesByYear, zeroYear);
                const site: RwlSiteData = new Map();
                series.forEach((s) => { if (s.id !== target.id) site.set(s.id, new Map(s.valuesByYear) as RwlTreeData); });
                site.set(target.id, corrupted as RwlTreeData);

                let cands;
                try {
                    cands = diagnoseCrossdating(site, { referenceConfig: null }).candidates.filter((c) => c.targetTree === target.id);
                } catch { continue; }
                attempted += 1;
                casesThisFile += 1;
                const inserts = cands.filter((c) => c.operationType === "INSERT_MISSING_RING");
                if (inserts.some((c) => Math.abs((c.targetYear ?? 0) - zeroYear) <= 1)) top5 += 1;
                const t = cands[0];
                const topIsInsert = t?.operationType === "INSERT_MISSING_RING";
                const topDist = topIsInsert ? Math.abs((t.targetYear ?? 0) - zeroYear) : Infinity;
                if (topDist <= 1) top1 += 1;
                if (topIsInsert && t.targetYear === zeroYear) exact += 1;
                [1, 2, 3, 5].forEach((tol) => {
                    if (topDist <= tol) top1Tol[tol] += 1;
                    if (inserts.some((c) => Math.abs((c.targetYear ?? 0) - zeroYear) <= tol)) top5Tol[tol] += 1;
                });

            }
        }

        const pct = (n: number) => attempted ? (n / attempted).toFixed(3) : "-";
        // eslint-disable-next-line no-console
        console.log(`ITRDB BASELINE files=${files.length} attempted=${attempted}`);
        // eslint-disable-next-line no-console
        console.log(`  缺轮 top5(±1)=${pct(top5)} (${top5}) top1(±1)=${pct(top1)} (${top1}) exact(±0)=${pct(exact)} (${exact})`);
        // eslint-disable-next-line no-console
        console.log(`  top1 多容差: ±1=${pct(top1Tol[1])} ±2=${pct(top1Tol[2])} ±3=${pct(top1Tol[3])} ±5=${pct(top1Tol[5])}`);
        // eslint-disable-next-line no-console
        console.log(`  top5 多容差: ±1=${pct(top5Tol[1])} ±2=${pct(top5Tol[2])} ±3=${pct(top5Tol[3])} ±5=${pct(top5Tol[5])}`);
    }, BENCH_TIMEOUT);

    it("真实缺轮事件窗口：响应、覆盖、精确率与年份排名", () => {
        const allFiles: string[] = [];
        collectFiles(ITRDB_DIR, allFiles);
        allFiles.sort();
        const sampleCount = Number(process.env.ITRDB_EVENT_FILES ?? 200);
        const offset = Number(process.env.ITRDB_EVENT_OFFSET ?? 0);
        const sampledFiles = sampleFiles(allFiles, sampleCount, offset);
        const fileFilter = process.env.ITRDB_EVENT_FILE_FILTER?.toLowerCase();
        const files = fileFilter
            ? sampledFiles.filter((file) => file.toLowerCase().includes(fileFilter))
            : sampledFiles;
        const maxCases = Number(process.env.ITRDB_EVENT_CASES ?? 500);
        const maxCasesPerFile = 3;

        let attempted = 0;
        let answered = 0;
        let selectableAnswered = 0;
        let primaryMatched = 0;
        let locationMatched = 0;
        let selectableMatched = 0;
        let predictions = 0;
        let topYearWithinOne = 0;
        let selectedTopYearWithinOne = 0;
        const widths: number[] = [];
        const truthRanks: number[] = [];
        const primaryMissDistances: number[] = [];
        const locationMissDistances: number[] = [];
        const selectableMissDistances: number[] = [];

        for (const file of files) {
            if (attempted >= maxCases) break;
            let parsed: Map<string, Series>;
            try { parsed = parseItrdb(readFileSync(file, "utf8")); } catch { continue; }
            const series = Array.from(parsed.values());
            if (series.length < 6) continue;
            const targets = series.filter((candidate) => (
                candidate.zeros.length === 1
                && candidate.valuesByYear.size >= 120
                && candidate.zeros[0] - candidate.startYear >= 15
                && candidate.endYear - candidate.zeros[0] >= 15
            ));
            let casesThisFile = 0;
            for (const target of targets) {
                if (casesThisFile >= maxCasesPerFile || attempted >= maxCases) break;
                const references = series.filter((candidate) => (
                    candidate.id !== target.id && overlap(candidate, target) >= 80
                ));
                if (references.length < 5) continue;

                const zeroYear = target.zeros[0];
                const site: RwlSiteData = new Map();
                series.forEach((candidate) => {
                    if (candidate.id !== target.id) {
                        site.set(candidate.id, new Map(candidate.valuesByYear) as RwlTreeData);
                    }
                });
                site.set(
                    target.id,
                    reconstructMissingFromZero(target.valuesByYear, zeroYear) as RwlTreeData,
                );

                let diagnosisEvents;
                try {
                    diagnosisEvents = diagnoseTargetEvents(site, target.id, {
                        ...(process.env.ITRDB_EVENT_MAX_LOCATION_ALTERNATIVES
                            ? {
                                eventOperationRecoveryConfig: {
                                    maximumLocationAlternatives: Number(
                                        process.env
                                            .ITRDB_EVENT_MAX_LOCATION_ALTERNATIVES,
                                    ),
                                    ...(process.env.ITRDB_EVENT_LOCATIONS_PER_SIGNAL
                                        ? {
                                            locationsPerSignal: Number(
                                                process.env
                                                    .ITRDB_EVENT_LOCATIONS_PER_SIGNAL,
                                            ),
                                        }
                                        : {}),
                                },
                            }
                            : process.env.ITRDB_EVENT_LOCATIONS_PER_SIGNAL
                                ? {
                                    eventOperationRecoveryConfig: {
                                        ...(process.env.ITRDB_EVENT_LOCATIONS_PER_SIGNAL
                                            ? {
                                                locationsPerSignal: Number(
                                                    process.env
                                                        .ITRDB_EVENT_LOCATIONS_PER_SIGNAL,
                                                ),
                                            }
                                            : {}),
                                    },
                                }
                            : {}),
                    });
                } catch {
                    continue;
                }
                const missingEvents = diagnosisEvents
                    .filter((event) => event.eventType === "missingRing");
                const selectableMissingEvents = diagnosisEvents.flatMap((event) => [
                    event,
                    ...(event.operationAlternatives ?? []),
                ]).filter((event) => event.eventType === "missingRing");
                attempted += 1;
                casesThisFile += 1;
                if (missingEvents.length > 0) answered += 1;
                if (selectableMissingEvents.length > 0) selectableAnswered += 1;
                predictions += missingEvents.length;
                const windowDistance = (
                    event: Pick<DiagnosisEvent, "startYear" | "endYear">,
                ) => zeroYear < event.startYear
                    ? event.startYear - zeroYear
                    : zeroYear > event.endYear
                        ? zeroYear - event.endYear
                        : 0;
                const minimumDistance = (
                    events: DiagnosisEvent[],
                    includeLocations: boolean,
                ): number => Math.min(
                    ...events.flatMap((event) => [
                        windowDistance(event),
                        ...(includeLocations
                            ? (event.locationAlternatives ?? []).map(windowDistance)
                            : []),
                    ]),
                );
                const recordMissDistance = (
                    rows: number[],
                    events: DiagnosisEvent[],
                    includeLocations: boolean,
                ) => {
                    if (events.length === 0) return;
                    const distance = minimumDistance(events, includeLocations);
                    if (distance > 0 && Number.isFinite(distance)) rows.push(distance);
                };
                recordMissDistance(primaryMissDistances, missingEvents, false);
                recordMissDistance(locationMissDistances, missingEvents, true);
                recordMissDistance(
                    selectableMissDistances,
                    selectableMissingEvents,
                    true,
                );

                const truth: TruthEvent = {
                    id: `${target.id}-expert-missing`,
                    seriesId: target.id,
                    eventType: "missingRing",
                    year: zeroYear,
                };
                const locationResult = matchDiagnosisEvents([truth], missingEvents);
                const selectableResult = matchDiagnosisEvents(
                    [truth],
                    selectableMissingEvents,
                );
                const match = locationResult.matches[0] ?? null;
                if (match) {
                    locationMatched += 1;
                    if (match.locationRank === 0) primaryMatched += 1;
                    const selectedLocation = match.locationRank === 0
                        ? match.prediction
                        : match.prediction.locationAlternatives?.find(
                            (alternative) => alternative.rank === match.locationRank,
                        ) ?? null;
                    if (selectedLocation) {
                        widths.push(
                            selectedLocation.endYear - selectedLocation.startYear + 1,
                        );
                        const truthRank = selectedLocation.rankedYears.find(
                            (row) => row.year === zeroYear,
                        )?.rank;
                        if (truthRank !== undefined) truthRanks.push(truthRank);
                        const selectedTopYear = selectedLocation.rankedYears[0]?.year;
                        if (selectedTopYear !== undefined
                            && Math.abs(selectedTopYear - zeroYear) <= 1) {
                            selectedTopYearWithinOne += 1;
                        }
                    }
                }
                selectableMatched += selectableResult.matchedCount;
                const topEvent = [...missingEvents]
                    .sort((a, b) => b.evidence.score - a.evidence.score)[0];
                const topYear = topEvent?.rankedYears[0]?.year;
                if (topYear !== undefined && Math.abs(topYear - zeroYear) <= 1) {
                    topYearWithinOne += 1;
                }
            }
        }

        const rate = (count: number, denominator = attempted) => (
            denominator > 0 ? (count / denominator).toFixed(3) : "-"
        );
        const median = (values: number[]) => {
            if (values.length === 0) return 0;
            const sorted = [...values].sort((a, b) => a - b);
            return sorted[Math.floor((sorted.length - 1) / 2)];
        };
        const distanceSummary = (values: number[]) => ({
            missesWithPrediction: values.length,
            distance1: values.filter((distance) => distance === 1).length,
            distanceAtMost2: values.filter((distance) => distance <= 2).length,
            distanceAtMost3: values.filter((distance) => distance <= 3).length,
            median: median(values),
        });
        // eslint-disable-next-line no-console
        console.log(`ITRDB EVENT WINDOWS files=${files.length} offset=${offset} attempted=${attempted} response=${rate(answered)} selectableResponse=${rate(selectableAnswered)} abstention=${attempted ? (1 - answered / attempted).toFixed(3) : "-"} primaryRecall=${rate(primaryMatched)} anyLocationRecall=${rate(locationMatched)} selectableRecall=${rate(selectableMatched)} primaryPrecision=${rate(primaryMatched, predictions)} anyLocationPrecision=${rate(locationMatched, predictions)} predictions=${predictions} primaryTopYear±1=${rate(topYearWithinOne)} selectedTopYear±1=${rate(selectedTopYearWithinOne)} medianWidth=${median(widths)} medianTruthRank=${median(truthRanks)} missDistances=${JSON.stringify({
            primary: distanceSummary(primaryMissDistances),
            anyLocation: distanceSummary(locationMissDistances),
            selectable: distanceSummary(selectableMissDistances),
        })}`);
    }, BENCH_TIMEOUT);

    it("frozen-event holdout：单缺轮、伪轮、局部移动与干净负例", () => {
        const allFiles: string[] = [];
        collectFiles(ITRDB_DIR, allFiles);
        allFiles.sort();
        const sampleCount = Number(process.env.ITRDB_FROZEN_FILES ?? 200);
        const offset = Number(process.env.ITRDB_FROZEN_OFFSET ?? 8);
        const configuredFileSplit = process.env.ITRDB_FROZEN_FILE_SPLIT;
        const fileSplit = (
            configuredFileSplit === "train"
            || configuredFileSplit === "calibration"
            || configuredFileSplit === "validation"
        ) ? configuredFileSplit : null;
        const splitFiles = fileSplit
            ? allFiles.filter((file) => inBenchmarkFileSplit(file, fileSplit))
            : allFiles;
        const frozenFileManifestPath = process.env.ITRDB_FROZEN_FILE_MANIFEST;
        const frozenFileManifest = readFrozenFileManifest(frozenFileManifestPath);
        const eligibleFiles = frozenFileManifest
            ? splitFiles.filter((file) => (
                    frozenFileManifest.has(normalizedBenchmarkRelativePath(file))
                ))
            : splitFiles;
        const sampledFiles = sampleFiles(
            eligibleFiles,
            sampleCount,
            offset,
            Number(process.env.ITRDB_FROZEN_FILE_SKIP ?? 0),
        );
        const fileFilter = process.env.ITRDB_FROZEN_FILE_FILTER?.toLowerCase();
        const files = fileFilter
            ? sampledFiles.filter((file) => file.toLowerCase().includes(fileFilter))
            : sampledFiles;
        const maxCases = Number(process.env.ITRDB_FROZEN_CASES ?? 120);
        const minimumContextYears = Number(
            process.env.ITRDB_FROZEN_MIN_CONTEXT_YEARS ?? 18,
        );
        const minimumOlderContextYears = Number(
            process.env.ITRDB_FROZEN_MIN_OLDER_CONTEXT_YEARS
                ?? minimumContextYears,
        );
        const minimumNewerContextYears = Number(
            process.env.ITRDB_FROZEN_MIN_NEWER_CONTEXT_YEARS
                ?? minimumContextYears,
        );
        const skipPartialTruth =
            process.env.ITRDB_SKIP_PARTIAL_TRUTH === "1";
        const configuredPartialGaps = (
            process.env.ITRDB_PARTIAL_GAPS ?? "2,3,4,5,6,8"
        )
            .split(",")
            .map((value) => Math.floor(Number(value.trim())))
            .filter((value) => Number.isFinite(value) && value >= 2 && value <= 100);
        const partialGapYears = configuredPartialGaps.length > 0
            ? Array.from(new Set(configuredPartialGaps))
            : [2, 3, 4, 5, 6, 8];

        type Aggregate = {
            cases: number;
            answered: number;
            predictions: number;
            matched: number;
            primaryMatched: number;
            alternativeRecovered: number;
            complete: number;
            selectableMatched: number;
            selectableComplete: number;
            operationAlternativeRecovered: number;
            operationMatched: number;
            selectableOperationMatched: number;
            operationRecoveryApplied: number;
            multiplePredictionCases: number;
            widths: number[];
            ranks: number[];
            locationRanks: number[];
            top1Exact: number;
            top1WithinOne: number;
            topYearErrors: number[];
            selectedTop1Exact: number;
            selectedTop1WithinOne: number;
            selectedTopYearErrors: number[];
        };
        const empty = (): Aggregate => ({
            cases: 0,
            answered: 0,
            predictions: 0,
            matched: 0,
            primaryMatched: 0,
            alternativeRecovered: 0,
            complete: 0,
            selectableMatched: 0,
            selectableComplete: 0,
            operationAlternativeRecovered: 0,
            operationMatched: 0,
            selectableOperationMatched: 0,
            operationRecoveryApplied: 0,
            multiplePredictionCases: 0,
            widths: [],
            ranks: [],
            locationRanks: [],
            top1Exact: 0,
            top1WithinOne: 0,
            topYearErrors: [],
            selectedTop1Exact: 0,
            selectedTop1WithinOne: 0,
            selectedTopYearErrors: [],
        });
        const aggregates = {
            missingRing: empty(),
            falseRing: empty(),
            partialMove: empty(),
        };
        type BenchmarkCaseContext = {
            groupId: string;
            file: string;
            datasetGroup: string;
            target: string;
            year: number;
            seriesLength: number;
            naturalZeroCount: number;
            positionStratum: BenchmarkPositionStratum;
            normalizedPosition: number;
            olderContextYears: number;
            newerContextYears: number;
            signalStrength: number | null;
            referenceCount: number;
            referenceSupportAtYear: number;
            referenceObservableAtYear: boolean;
            referenceContextYearCount: number;
            baselineEventCount?: number;
            baselineFlagged?: boolean;
        };
        type EventCaseOutcome = {
            context: BenchmarkCaseContext;
            eventType: "missingRing" | "falseRing" | "partialMove";
            systemResponded: boolean;
            answered: boolean;
            primaryEventType: DiagnosisEvent["eventType"] | null;
            primaryEventShiftYears: number | null;
            partialMoveMisclassification: boolean;
            predictions: number;
            totalPredictions: number;
            matched: boolean;
            primaryMatched: boolean;
            operationMatched: boolean;
            selectableOperationMatched: boolean;
            operationRecoveryApplied: boolean;
            operationChoices: string[];
            locationRank: number | null;
            complete: boolean;
            width: number | null;
            top1Exact: boolean;
            top1WithinOne: boolean;
            selectedTop1Exact: boolean;
            selectedTop1WithinOne: boolean;
            truthShiftYears: number | null;
            primaryPredictionTopYear: number | null;
            primaryPredictionRange: [number, number] | null;
            primaryPredictionShiftYears: number | null;
            matchedPrimaryTopYear: number | null;
            selectedTopYear: number | null;
            primaryTruthRank: number | null;
            primaryTopYearError: number | null;
            primaryTopYearCenterOffset: number | null;
        };
        type CleanCaseOutcome = {
            context: BenchmarkCaseContext;
            falsePositive: boolean;
            predictions: number;
        };
        const caseContexts: BenchmarkCaseContext[] = [];
        const eventCaseOutcomes: EventCaseOutcome[] = [];
        const cleanCaseOutcomes: CleanCaseOutcome[] = [];
        type WindowRankRow = {
            year: number;
            shiftYears?: number;
            features: Record<string, number>;
        };
        type ResidualWindowRankRow = {
            year: number;
            shiftYears?: number;
            features: Record<string, number>;
        };
        type WindowRankCase = {
            groupId: string;
            eventType: EventCaseOutcome["eventType"];
            truthYear: number;
            truthShiftYears?: number;
            currentTopYear: number | null;
            currentRange: [number, number] | null;
            currentShiftYears: number | null;
            currentScore: number | null;
            currentMargin: number | null;
            currentConfidence: DiagnosisEvent["confidenceLevel"] | null;
            currentSources: DiagnosisEvent["evidence"]["algorithmSources"];
            context: BenchmarkCaseContext;
            rows: WindowRankRow[];
            residualRows?: ResidualWindowRankRow[];
        };
        const windowRankDataPath = process.env.ITRDB_WINDOW_RANK_DATA_PATH;
        const collectWindowRankData = Boolean(windowRankDataPath);
        const collectWindowRankResiduals = process.env.ITRDB_WINDOW_RANK_RESIDUALS === "1";
        const windowRankCases: WindowRankCase[] = [];
        type RecoveryGateAuditCase = {
            caseType: "injected" | "clean";
            truthEventType: EventCaseOutcome["eventType"] | null;
            truthYear: number | null;
            truthShiftYears: number | null;
            context: BenchmarkCaseContext;
            currentEvents: Array<{
                eventType: DiagnosisEvent["eventType"];
                startYear: number;
                endYear: number;
                shiftYears: number | null;
                confidenceLevel: DiagnosisEvent["confidenceLevel"];
                score: number;
                scoreMargin: number;
                lagBefore: number | null;
                lagAfter: number | null;
                correlationGain: number | null;
                candidateCount: number;
                algorithmSources: string[];
                notes: string[];
            }>;
            hypotheses: GainGatedRecoveryHypothesis[];
        };
        const collectRecoveryGateAudit = process.env.ITRDB_RECOVERY_GATE_AUDIT === "1";
        const recoveryGateAuditCases: RecoveryGateAuditCase[] = [];
        const collectJointOperationAudit =
            process.env.ITRDB_JOINT_OPERATION_AUDIT === "1";
        const compactJointOperationAudit =
            process.env.ITRDB_JOINT_OPERATION_FULL_ROWS !== "1";
        const jointOperationAuditTypes = new Set(
            (process.env.ITRDB_JOINT_OPERATION_TYPES ?? "")
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
        );
        const jointOperationAuditBaselineCleanOnly =
            process.env.ITRDB_JOINT_OPERATION_BASELINE_CLEAN_ONLY === "1";
        const collectReferenceOperationAudit =
            process.env.ITRDB_REFERENCE_OPERATION_AUDIT === "1";
        const referenceOperationUnitOnly =
            process.env.ITRDB_REFERENCE_OPERATION_UNIT_ONLY === "1";
        const referenceOperationStageCount = Math.max(
            4,
            Number(process.env.ITRDB_REFERENCE_OPERATION_STAGE_COUNT ?? 12),
        );
        const jointOperationAuditCases: unknown[] = [];
        const collectCounterfactualLocatorAudit =
            process.env.ITRDB_COUNTERFACTUAL_LOCATOR_AUDIT === "1";
        const counterfactualLocatorCases: unknown[] = [];
        const pairedPulseLocalizedAudit: unknown[] = [];
        const collectPairedPulseLocalizedAudit = (
            process.env.ITRDB_PAIRED_PULSE_LOCALIZED_AUDIT === "1"
        );
        let cleanCases = 0;
        let cleanFalsePositives = 0;
        let attempted = 0;
        const failures: unknown[] = [];
        type AuditedLocation = {
            rank: number;
            range: [number, number];
            topYear: number | null;
            shiftYears: number | null;
            shiftSide: DiagnosisEvent["shiftSide"] | null;
            evidenceScore: number;
            locationScoreMargin: number;
            yearScoreMargin: number;
            algorithmSource: string;
        };
        type RankingCase = {
            groupId: string;
            seriesId: string;
            eventType: TruthEvent["eventType"];
            truthYear: number;
            range: [number, number];
            rankedYears: Array<{ year: number; score: number; tags: string[] }>;
            confidence: DiagnosisEvent["confidenceLevel"];
            sources: DiagnosisEvent["evidence"]["algorithmSources"];
            notes: string[];
            matchedLocationRank: number;
            matchedLocationRange: [number, number];
            matchedLocationRankedYears: DiagnosisEvent["rankedYears"];
            locations: AuditedLocation[];
            positionStratum: BenchmarkPositionStratum;
            normalizedPosition: number;
            signalStrength: number | null;
        };
        const rankingCases: RankingCase[] = [];
        const exhaustiveScoreNames: ExhaustiveScoreName[] = [
            "raw",
            "difference",
            "whitened",
            "combo",
        ];
        const exhaustiveHits = {
            missingRing: Object.fromEntries(exhaustiveScoreNames.map((name) => [name, 0])),
            falseRing: Object.fromEntries(exhaustiveScoreNames.map((name) => [name, 0])),
            partialMove: Object.fromEntries(exhaustiveScoreNames.map((name) => [name, 0])),
        };
        const exhaustiveTopKHits = Object.fromEntries(
            (["missingRing", "falseRing", "partialMove"] as const).map((eventType) => [
                eventType,
                Object.fromEntries(exhaustiveScoreNames.map((name) => [name, {
                    top1: 0,
                    top2: 0,
                    top3: 0,
                    top5: 0,
                }])),
            ]),
        );
        const separatedExhaustivePeaks = (
            scores: ReturnType<typeof scanExhaustiveUnitEdit>,
            scoreName: ExhaustiveScoreName,
            exclusionYears: number,
            shiftYears?: number,
        ) => {
            const selected: typeof scores = [];
            [...scores]
                .filter((row) => shiftYears === undefined || row.shiftYears === shiftYears)
                .sort((a, b) => b[scoreName] - a[scoreName] || b.year - a.year)
                .forEach((row) => {
                    if (selected.length >= 5) return;
                    if (selected.every((other) => (
                        Math.abs(other.year - row.year) > exclusionYears
                    ))) selected.push(row);
                });
            return selected;
        };
        const tallyExhaustiveTopK = (
            eventType: keyof typeof exhaustiveTopKHits,
            scores: ReturnType<typeof scanExhaustiveUnitEdit>,
            truthYear: number,
            tolerance: number,
            shiftYears?: number,
        ) => {
            exhaustiveScoreNames.forEach((scoreName) => {
                const peaks = separatedExhaustivePeaks(
                    scores,
                    scoreName,
                    tolerance * 2 + 1,
                    shiftYears,
                );
                ([1, 2, 3, 5] as const).forEach((k) => {
                    if (peaks.slice(0, k).some((row) => (
                        Math.abs(row.year - truthYear) <= tolerance
                    ))) exhaustiveTopKHits[eventType][scoreName][`top${k}`] += 1;
                });
            });
        };
        const exhaustivePeakAudit = (
            scores: ReturnType<typeof scanExhaustiveUnitEdit>,
            tolerance: number,
            shiftYears?: number,
        ) => Object.fromEntries(exhaustiveScoreNames.map((scoreName) => [
            scoreName,
            separatedExhaustivePeaks(
                scores,
                scoreName,
                tolerance * 2 + 1,
                shiftYears,
            ).map((row) => ({
                year: row.year,
                ...(row.shiftYears === undefined ? {} : { shiftYears: row.shiftYears }),
                score: row[scoreName],
            })),
        ]));
        const exhaustiveOverlap = Object.fromEntries(
            (["missingRing", "falseRing", "partialMove"] as const).map((eventType) => [
                eventType,
                Object.fromEntries(exhaustiveScoreNames.map((name) => [name, {
                    both: 0,
                    currentOnly: 0,
                    exhaustiveOnly: 0,
                    neither: 0,
                }])),
            ]),
        );
        const exhaustiveCases: unknown[] = [];
        const localizedScoreNames: LocalizedScoreName[] = [
            "differenceGain21",
            "differenceGain31",
            "differenceGain41",
            "differenceGain61",
            "whitenedGain31",
            "whitenedGain61",
        ];
        const localizedHits = {
            missingRing: Object.fromEntries(localizedScoreNames.map((name) => [name, 0])),
            falseRing: Object.fromEntries(localizedScoreNames.map((name) => [name, 0])),
            partialMove: Object.fromEntries(localizedScoreNames.map((name) => [name, 0])),
        };
        const pairwiseScoreNames: PairwiseScoreName[] = [
            "differenceMean",
            "differenceMedian",
            "differenceTrimmed",
            "differenceWeighted",
            "whitenedMean",
            "whitenedMedian",
        ];
        const pairwiseHits = {
            missingRing: Object.fromEntries(pairwiseScoreNames.map((name) => [name, 0])),
            falseRing: Object.fromEntries(pairwiseScoreNames.map((name) => [name, 0])),
            partialMove: Object.fromEntries(pairwiseScoreNames.map((name) => [name, 0])),
        };
        const makeOverlapByScore = () => Object.fromEntries(pairwiseScoreNames.map((name) => [name, {
            both: 0,
            currentOnly: 0,
            pairwiseOnly: 0,
            neither: 0,
        }]));
        const pairwiseOverlap = {
            missingRing: makeOverlapByScore(),
            falseRing: makeOverlapByScore(),
            partialMove: makeOverlapByScore(),
        };
        const makeEvidenceOverlapByScore = () => Object.fromEntries(pairwiseScoreNames.map((name) => [name, {
            both: 0,
            exhaustiveOnly: 0,
            pairwiseOnly: 0,
            neither: 0,
        }]));
        const pairwiseExhaustiveOverlap = {
            missingRing: makeEvidenceOverlapByScore(),
            falseRing: makeEvidenceOverlapByScore(),
            partialMove: makeEvidenceOverlapByScore(),
        };
        const pairwiseCases: unknown[] = [];
        const cleanPairwiseCases: unknown[] = [];
        const abstainedClassificationCases: unknown[] = [];
        const classifyAbstained = (
            diagnosis: SeriesCoreDiagnosis,
            site: RwlSiteData,
        ) => {
            const missingScores = scanPairwiseUnitEdit(diagnosis, site, "insert");
            const falseScores = scanPairwiseUnitEdit(diagnosis, site, "delete");
            const partialScores = scanPairwisePartialMove(diagnosis, site);
            const missingBest = bestPairwiseScore(missingScores, "differenceMean");
            const falseBest = bestPairwiseScore(falseScores, "whitenedMedian");
            const partialBest = bestPairwiseScore(partialScores, "differenceTrimmed");
            const rows = [
                missingBest ? {
                    eventType: "missingRing" as const,
                    year: missingBest.year,
                    gain: missingBest.differenceMeanGain,
                    threshold: 0.01,
                } : null,
                falseBest ? {
                    eventType: "falseRing" as const,
                    year: falseBest.year,
                    gain: falseBest.whitenedMedianGain,
                    threshold: 0.05,
                } : null,
                partialBest ? {
                    eventType: "partialMove" as const,
                    year: partialBest.year,
                    shiftYears: partialBest.shiftYears,
                    gain: partialBest.differenceTrimmedGain,
                    threshold: 0.019,
                } : null,
            ].filter((row): row is NonNullable<typeof row> => row !== null);
            const eligibleRows = rows.filter((row) => row.gain >= row.threshold);
            return {
                rows,
                byGain: [...eligibleRows].sort((a, b) => b.gain - a.gain)[0] ?? null,
                byThresholdRatio: [...eligibleRows]
                    .sort((a, b) => b.gain / b.threshold - a.gain / a.threshold)[0] ?? null,
            };
        };
        const tallyPairwise = (
            eventType: keyof typeof pairwiseHits,
            scoreName: PairwiseScoreName,
            currentHit: boolean,
            exhaustiveHit: boolean,
            pairwiseHit: boolean,
        ) => {
            if (pairwiseHit) pairwiseHits[eventType][scoreName] += 1;
            const currentBucket = pairwiseOverlap[eventType][scoreName];
            if (currentHit && pairwiseHit) currentBucket.both += 1;
            else if (currentHit) currentBucket.currentOnly += 1;
            else if (pairwiseHit) currentBucket.pairwiseOnly += 1;
            else currentBucket.neither += 1;
            const evidenceBucket = pairwiseExhaustiveOverlap[eventType][scoreName];
            if (exhaustiveHit && pairwiseHit) evidenceBucket.both += 1;
            else if (exhaustiveHit) evidenceBucket.exhaustiveOnly += 1;
            else if (pairwiseHit) evidenceBucket.pairwiseOnly += 1;
            else evidenceBucket.neither += 1;
        };
        const useExhaustive = process.env.ITRDB_EXHAUSTIVE === "1";
        const useLocalized = process.env.ITRDB_LOCALIZED === "1";
        const usePairwise = process.env.ITRDB_PAIRWISE === "1";
        const usePairwiseClean = process.env.ITRDB_PAIRWISE_CLEAN === "1";
        const useFixedContext = process.env.ITRDB_FIXED_CONTEXT === "1";
        const fixedContextCases: unknown[] = [];
        const fixedContextCleanCases: unknown[] = [];
        const useFixedWindowCounterfactual =
            process.env.ITRDB_FIXED_WINDOW_COUNTERFACTUAL === "1";
        const fixedWindowCounterfactualCases: unknown[] = [];
        const useDirectTransition = process.env.ITRDB_DIRECT_TRANSITION === "1";
        const usePiecewiseChangePoint = process.env.ITRDB_PIECEWISE_CHANGE_POINT === "1";
        type PiecewiseScoreName = keyof Pick<PiecewiseChangePointScore,
            | "combinedObjective"
            | "combinedGain"
            | "rawObjective"
            | "cofechaObjective"
            | "whitenedObjective"
            | "differenceObjective"
            | "rawGain"
            | "cofechaGain"
            | "whitenedGain"
            | "differenceGain"
        >;
        const piecewiseScoreNames: PiecewiseScoreName[] = [
            "combinedObjective",
            "combinedGain",
            "rawObjective",
            "cofechaObjective",
            "whitenedObjective",
            "differenceObjective",
            "rawGain",
            "cofechaGain",
            "whitenedGain",
            "differenceGain",
        ];
        type PiecewiseAuditRow = {
            caseType: "injected" | "clean";
            file: string;
            target: string;
            eventType: "missingRing" | "falseRing" | "partialMove";
            truthYear: number | null;
            expectedLag: number;
            currentHit: boolean;
            tops: Record<PiecewiseScoreName, {
                year: number;
                score: number;
                exact: boolean;
                withinOne: boolean;
                windowHit: boolean;
                remoteMargin: number;
            } | null>;
        };
        const piecewiseChangePointCases: PiecewiseAuditRow[] = [];
        const auditPiecewiseChangePoint = (
            caseType: PiecewiseAuditRow["caseType"],
            file: string,
            target: string,
            eventType: PiecewiseAuditRow["eventType"],
            truthYear: number | null,
            expectedLag: number,
            diagnosis: SeriesCoreDiagnosis | null,
            cofechaDiagnosis: SeriesCoreDiagnosis | null,
            currentHit: boolean,
        ) => {
            if (!usePiecewiseChangePoint || !diagnosis) return;
            const scores = scorePiecewiseChangePoints(
                diagnosis,
                cofechaDiagnosis,
                { lags: [expectedLag] },
            );
            const tolerance = eventType === "partialMove" ? 4 : 3;
            const tops = Object.fromEntries(piecewiseScoreNames.map((scoreName) => {
                const top = [...scores]
                    .filter((row) => row.olderLag === expectedLag)
                    .sort((a, b) => b[scoreName] - a[scoreName] || b.year - a.year)[0]
                    ?? null;
                if (!top) return [scoreName, null];
                const remote = scores
                    .filter((row) => (
                        row.olderLag === expectedLag
                        && Math.abs(row.year - top.year) > tolerance * 2 + 1
                    ))
                    .sort((a, b) => b[scoreName] - a[scoreName])[0];
                return [scoreName, {
                    year: top.year,
                    score: top[scoreName],
                    exact: truthYear !== null && top.year === truthYear,
                    withinOne: truthYear !== null && Math.abs(top.year - truthYear) <= 1,
                    windowHit: truthYear !== null && Math.abs(top.year - truthYear) <= tolerance,
                    remoteMargin: top[scoreName] - (remote?.[scoreName] ?? top[scoreName]),
                }];
            })) as PiecewiseAuditRow["tops"];
            piecewiseChangePointCases.push({
                caseType,
                file: file.slice(ITRDB_DIR.length),
                target,
                eventType,
                truthYear,
                expectedLag,
                currentHit,
                tops,
            });
        };
        const useReferenceChangePoint = process.env.ITRDB_REFERENCE_CHANGE_POINT === "1";
        type ReferenceChangePointScoreName = keyof Pick<ReferenceConsensusChangePointScore,
            | "meanPercentile"
            | "medianPercentile"
            | "meanStandardizedObjective"
            | "supportFraction"
            | "weightedSupport"
            | "meanGain"
            | "positiveGainFraction"
        >;
        const referenceChangePointScoreNames: ReferenceChangePointScoreName[] = [
            "meanPercentile",
            "medianPercentile",
            "meanStandardizedObjective",
            "supportFraction",
            "weightedSupport",
            "meanGain",
            "positiveGainFraction",
        ];
        type ReferenceChangePointAuditRow = {
            caseType: "injected" | "clean";
            file: string;
            target: string;
            eventType: "missingRing" | "falseRing" | "partialMove";
            truthYear: number | null;
            expectedLag: number;
            currentHit: boolean;
            tops: Record<ReferenceChangePointScoreName, {
                year: number;
                score: number;
                referenceCount: number;
                exact: boolean;
                withinOne: boolean;
                windowHit: boolean;
                remoteMargin: number;
            } | null>;
        };
        const referenceChangePointCases: ReferenceChangePointAuditRow[] = [];
        const auditReferenceChangePoint = (
            caseType: ReferenceChangePointAuditRow["caseType"],
            file: string,
            target: string,
            eventType: ReferenceChangePointAuditRow["eventType"],
            truthYear: number | null,
            expectedLag: number,
            diagnosis: SeriesCoreDiagnosis | null,
            site: RwlSiteData | null,
            currentHit: boolean,
        ) => {
            if (!useReferenceChangePoint || !diagnosis || !site) return;
            const scores = scoreReferenceConsensusChangePoints(diagnosis, site, {
                lags: [expectedLag],
                maximumReferences: Number(process.env.ITRDB_REFERENCE_CHANGE_POINT_MAX_REFS ?? 16),
            });
            const tolerance = eventType === "partialMove" ? 4 : 3;
            const tops = Object.fromEntries(referenceChangePointScoreNames.map((scoreName) => {
                const top = [...scores]
                    .sort((a, b) => b[scoreName] - a[scoreName] || b.year - a.year)[0]
                    ?? null;
                if (!top) return [scoreName, null];
                const remote = scores
                    .filter((row) => Math.abs(row.year - top.year) > tolerance * 2 + 1)
                    .sort((a, b) => b[scoreName] - a[scoreName])[0];
                return [scoreName, {
                    year: top.year,
                    score: top[scoreName],
                    referenceCount: top.referenceCount,
                    exact: truthYear !== null && top.year === truthYear,
                    withinOne: truthYear !== null && Math.abs(top.year - truthYear) <= 1,
                    windowHit: truthYear !== null && Math.abs(top.year - truthYear) <= tolerance,
                    remoteMargin: top[scoreName] - (remote?.[scoreName] ?? top[scoreName]),
                }];
            })) as ReferenceChangePointAuditRow["tops"];
            referenceChangePointCases.push({
                caseType,
                file: file.slice(ITRDB_DIR.length),
                target,
                eventType,
                truthYear,
                expectedLag,
                currentHit,
                tops,
            });
        };
        type DirectTransitionAuditRow = {
            caseType: "injected" | "clean";
            file: string;
            target: string;
            eventType: "missingRing" | "falseRing" | "partialMove";
            truthYear: number | null;
            truthShiftYears?: number;
            currentHit: boolean;
            currentAnswered: boolean;
            direct: {
                range: [number, number];
                topYear: number | null;
                gain: number;
                margin: number;
                shiftYears?: number;
                windowHit: boolean;
                completeHit: boolean;
            } | null;
        };
        const directTransitionCases: DirectTransitionAuditRow[] = [];
        const auditDirectTransition = (
            caseType: DirectTransitionAuditRow["caseType"],
            file: string,
            target: string,
            eventType: DirectTransitionAuditRow["eventType"],
            truthYear: number | null,
            truthShiftYears: number | undefined,
            diagnosis: SeriesCoreDiagnosis | null,
            currentEvents: DiagnosisEvent[],
            currentHit: boolean,
        ) => {
            if (!useDirectTransition || !diagnosis) return;
            const direct = locateReturnToZeroEvents(diagnosis, {
                minGain: Number.NEGATIVE_INFINITY,
            }).find((event) => event.eventType === eventType) ?? null;
            const windowHit = direct !== null
                && truthYear !== null
                && truthYear >= direct.startYear
                && truthYear <= direct.endYear;
            const completeHit = windowHit && (eventType !== "partialMove"
                || direct?.shiftYears === truthShiftYears);
            directTransitionCases.push({
                caseType,
                file: file.slice(ITRDB_DIR.length),
                target,
                eventType,
                truthYear,
                ...(truthShiftYears === undefined ? {} : { truthShiftYears }),
                currentHit,
                currentAnswered: currentEvents.some((event) => event.eventType === eventType),
                direct: direct ? {
                    range: [direct.startYear, direct.endYear],
                    topYear: direct.rankedYears[0]?.year ?? null,
                    gain: direct.evidence.score,
                    margin: direct.evidence.scoreMargin,
                    ...(direct.shiftYears === undefined ? {} : { shiftYears: direct.shiftYears }),
                    windowHit,
                    completeHit,
                } : null,
            });
        };
        const usePairedBreakpoint = process.env.ITRDB_PAIRED_BREAKPOINT === "1";
        const pairedScoreNames: Array<keyof Omit<PairedCoreBreakpointScore, "year">> = [
            "rawFull",
            "differenceFull",
            "whitenedFull",
            "standardizedFull",
            "comboFull",
            "comboFullGain",
            "combo31",
            "combo31Gain",
            "combo61",
            "combo61Gain",
            "multiScaleGain",
            "rawHuberFull",
            "differenceHuberFull",
            "whitenedHuberFull",
            "standardizedHuberFull",
            "huberComboFull",
        ];
        type PairedBreakpointAuditRow = {
            caseType: "injected" | "clean";
            file: string;
            target: string;
            eventType: "missingRing" | "falseRing";
            truthYear: number | null;
            currentHit: boolean;
            current: {
                range: [number, number];
                topYear: number | null;
                confidence: DiagnosisEvent["confidenceLevel"];
                score: number;
                margin: number;
                sources: string[];
                notes: string[];
            } | null;
            referenceCount: number;
            tops: Record<string, {
                year: number;
                score: number;
                remoteMargin: number;
                windowHit: boolean;
                exact: boolean;
                withinOne: boolean;
            } | null>;
        };
        const pairedBreakpointCases: PairedBreakpointAuditRow[] = [];
        const auditPairedBreakpoint = (
            caseType: PairedBreakpointAuditRow["caseType"],
            file: string,
            target: string,
            eventType: PairedBreakpointAuditRow["eventType"],
            truthYear: number | null,
            diagnosis: SeriesCoreDiagnosis | null,
            site: RwlSiteData | null,
            currentEvents: DiagnosisEvent[],
            currentHit: boolean,
        ) => {
            if (!usePairedBreakpoint || !diagnosis || !site) return;
            const result = scorePairedCoreUnitBoundaries(diagnosis, site, eventType);
            const current = currentEvents
                .filter((event) => event.eventType === eventType)
                .sort((a, b) => b.evidence.score - a.evidence.score)[0] ?? null;
            const tops = Object.fromEntries(pairedScoreNames.map((scoreName) => {
                const top = [...result.scores]
                    .sort((a, b) => b[scoreName] - a[scoreName] || b.year - a.year)[0] ?? null;
                if (!top) return [scoreName, null];
                const remote = result.scores
                    .filter((row) => Math.abs(row.year - top.year) > 7)
                    .sort((a, b) => b[scoreName] - a[scoreName] || b.year - a.year)[0];
                return [scoreName, {
                    year: top.year,
                    score: top[scoreName],
                    remoteMargin: top[scoreName] - (remote?.[scoreName] ?? top[scoreName]),
                    windowHit: truthYear !== null && Math.abs(top.year - truthYear) <= 3,
                    exact: truthYear !== null && top.year === truthYear,
                    withinOne: truthYear !== null && Math.abs(top.year - truthYear) <= 1,
                }];
            }));
            pairedBreakpointCases.push({
                caseType,
                file: file.slice(ITRDB_DIR.length),
                target,
                eventType,
                truthYear,
                currentHit,
                current: current ? {
                    range: [current.startYear, current.endYear],
                    topYear: current.rankedYears[0]?.year ?? null,
                    confidence: current.confidenceLevel,
                    score: current.evidence.score,
                    margin: current.evidence.scoreMargin,
                    sources: current.evidence.algorithmSources,
                    notes: current.evidence.notes,
                } : null,
                referenceCount: result.referenceCount,
                tops,
            });
        };
        const missingRefinementAudit = {
            older: { gained: 0, lost: 0, retained: 0, missed: 0 },
            newer: { gained: 0, lost: 0, retained: 0, missed: 0 },
        };
        const missingRefinementCases: unknown[] = [];
        const referenceRecoveryCases: unknown[] = [];
        const recordReferenceRecoveries = (
            caseType: "missingRing" | "falseRing" | "partialMove" | "clean",
            file: string,
            target: string,
            truthYear: number | null,
            predictions: DiagnosisEvent[],
        ) => {
            const recovered = predictions.filter((event) => (
                event.evidence.notes.includes("manual_review_only_no_executable_candidate")
            ));
            if (recovered.length === 0) return;
            referenceRecoveryCases.push({
                caseType,
                file: file.slice(ITRDB_DIR.length),
                target,
                truthYear,
                predictions: recovered.map((event) => ({
                    type: event.eventType,
                    range: [event.startYear, event.endYear],
                    shiftYears: event.shiftYears,
                    confidence: event.confidenceLevel,
                    score: event.evidence.score,
                    margin: event.evidence.scoreMargin,
                    notes: event.evidence.notes,
                })),
            });
        };
        const auditMissingRefinement = (truthYear: number, events: DiagnosisEvent[]) => {
            events
                .filter((event) => event.eventType === "missingRing")
                .forEach((event) => {
                    const beforeNote = event.evidence.notes.find((note) => (
                        note.startsWith("window_before=")
                    ));
                    if (!beforeNote) return;
                    const match = /window_before=(-?\d+)-(-?\d+)/.exec(beforeNote);
                    if (!match) return;
                    const before = { startYear: Number(match[1]), endYear: Number(match[2]) };
                    const direction = event.startYear < before.startYear ? "older" : "newer";
                    const beforeHit = truthYear >= before.startYear && truthYear <= before.endYear;
                    const afterHit = truthYear >= event.startYear && truthYear <= event.endYear;
                    missingRefinementCases.push({
                        truthYear,
                        before: [before.startYear, before.endYear],
                        after: [event.startYear, event.endYear],
                        beforeHit,
                        afterHit,
                        confidence: event.confidenceLevel,
                        score: event.evidence.score,
                        margin: event.evidence.scoreMargin,
                        sources: event.evidence.algorithmSources,
                        notes: event.evidence.notes,
                    });
                    const bucket = missingRefinementAudit[direction];
                    if (!beforeHit && afterHit) bucket.gained += 1;
                    else if (beforeHit && !afterHit) bucket.lost += 1;
                    else if (beforeHit) bucket.retained += 1;
                    else bucket.missed += 1;
                });
        };
        const numericOverride = (name: string): number | undefined => {
            const raw = process.env[name];
            if (raw === undefined) return undefined;
            const value = Number(raw);
            return Number.isFinite(value) ? value : undefined;
        };
        const eventPathConfig = Object.fromEntries([
            ["robustMasterWeight", numericOverride("ITRDB_PATH_ROBUST_WEIGHT")],
            ["individualMasterWeight", numericOverride("ITRDB_PATH_INDIVIDUAL_WEIGHT")],
            ["minLag", numericOverride("ITRDB_PATH_MIN_LAG")],
            ["maxLag", numericOverride("ITRDB_PATH_MAX_LAG")],
            ["minRunYears", numericOverride("ITRDB_PATH_MIN_RUN_YEARS")],
            ["minTransitionGain", numericOverride("ITRDB_PATH_MIN_TRANSITION_GAIN")],
            ["transitionPenaltyUnit", numericOverride("ITRDB_PATH_UNIT_PENALTY")],
            ["transitionPenaltyBig", numericOverride("ITRDB_PATH_BIG_PENALTY")],
            ["missingBoundaryYearAdjustment", numericOverride("ITRDB_PATH_MISSING_ADJUSTMENT")],
            ["falseBoundaryYearAdjustment", numericOverride("ITRDB_PATH_FALSE_ADJUSTMENT")],
            ["partialBoundaryYearAdjustment", numericOverride("ITRDB_PATH_PARTIAL_ADJUSTMENT")],
        ].filter((entry): entry is [keyof EventPathConfig, number] => entry[1] !== undefined));
        const collectTransitionScanAudit =
            process.env.ITRDB_TRANSITION_SCAN_AUDIT === "1";
        const transitionScanCases: unknown[] = [];
        const auditTransitionScan = (
            eventType: "missingRing" | "falseRing" | "partialMove",
            truthYear: number,
            truthShiftYears: number,
            context: BenchmarkCaseContext,
            run: {
                cofechaDiagnosis: SeriesCoreDiagnosis | null;
                site: RwlSiteData | null;
            },
        ) => {
            if (!collectTransitionScanAudit
                || !run.cofechaDiagnosis
                || !run.site) return;
            const result = scoreLagTransitionHypotheses(
                run.cofechaDiagnosis,
                run.site,
                {
                    ...INTERNAL_EVENT_PATH_CONFIG,
                    ...eventPathConfig,
                },
            );
            const referenceConsensus = scoreReferenceTransitionConsensus(
                run.cofechaDiagnosis,
                run.site,
                { correctionYears: [truthShiftYears] },
            );
            const exactReferenceEdit = eventType === "partialMove"
                ? []
                : scoreFullIntervalReferenceEditEvidence(
                    run.cofechaDiagnosis,
                    run.site,
                    eventType === "missingRing" ? "insert" : "delete",
                );
            transitionScanCases.push({
                eventType,
                truthYear,
                truthShiftYears,
                context,
                newestLag: result.newestLag,
                newestLagMargin: result.newestLagMargin,
                newestLagPairs: result.newestLagPairs,
                hypotheses: result.hypotheses.filter(
                    (hypothesis) => hypothesis.correctionYears === truthShiftYears,
                ),
                referenceConsensus,
                exactReferenceEdit,
            });
        };
        const fixedContextLagAudit = (
            diagnosis: SeriesCoreDiagnosis,
            olderLag: number,
            rows = scoreFixedContextTransitions(diagnosis, olderLag),
        ) => {
            const tolerance = Math.abs(olderLag) === 1 ? 3 : 4;
            const selected: typeof rows = [];
            rows.forEach((row) => {
                if (selected.length >= 5) return;
                if (selected.every((other) => (
                    Math.abs(other.year - row.year) > tolerance * 2 + 1
                ))) selected.push(row);
            });
            const mean = rows.reduce((sum, row) => sum + row.score, 0)
                / Math.max(1, rows.length);
            const variance = rows.reduce((sum, row) => (
                sum + (row.score - mean) ** 2
            ), 0) / Math.max(1, rows.length);
            const scale = Math.sqrt(variance) || 1;
            return {
                olderLag,
                peaks: selected,
                scoreMean: mean,
                scoreScale: scale,
                topZ: selected[0] ? (selected[0].score - mean) / scale : null,
            };
        };
        const auditFixedContext = (
            eventType: "missingRing" | "falseRing" | "partialMove",
            file: string,
            target: string,
            truthYear: number,
            olderLag: number,
            diagnosis: SeriesCoreDiagnosis | null,
            currentHit: boolean,
            currentEvents: DiagnosisEvent[],
        ) => {
            if (!useFixedContext || !diagnosis) return;
            const fixedRows = scoreFixedContextTransitions(diagnosis, olderLag);
            const primary = fixedContextLagAudit(diagnosis, olderLag, fixedRows);
            const compatibleEvents = currentEvents.flatMap((event) => [
                event,
                ...(event.operationAlternatives ?? []),
            ]).filter((event) => (
                event.eventType === eventType
                && (
                    eventType !== "partialMove"
                    || event.shiftYears === olderLag
                )
            ));
            const windowPeaks = compatibleEvents.flatMap((event, eventRank) => [
                {
                    eventRank,
                    locationRank: 0,
                    startYear: event.startYear,
                    endYear: event.endYear,
                },
                ...(event.locationAlternatives ?? []).map((location) => ({
                    eventRank,
                    locationRank: location.rank,
                    startYear: location.startYear,
                    endYear: location.endYear,
                })),
            ]).map((window) => ({
                ...window,
                peak: fixedRows.find((row) => (
                    row.year >= window.startYear
                    && row.year <= window.endYear
                )) ?? null,
            }));
            fixedContextCases.push({
                file: file.slice(ITRDB_DIR.length),
                target,
                eventType,
                truthYear,
                olderLag,
                currentHit,
                peaks: primary.peaks,
                scoreMean: primary.scoreMean,
                scoreScale: primary.scoreScale,
                topZ: primary.topZ,
                windowPeaks,
                currentEvents: currentEvents.map((event) => ({
                    eventType: event.eventType,
                    shiftYears: event.shiftYears ?? null,
                    startYear: event.startYear,
                    endYear: event.endYear,
                })),
                ...(!currentHit ? {
                    allLags: getAutomaticEventShiftCandidates().map((lag) => (
                        lag === olderLag ? primary : fixedContextLagAudit(diagnosis, lag)
                    )),
                } : {}),
            });
        };
        const auditFixedContextClean = (
            file: string,
            target: string,
            diagnosis: SeriesCoreDiagnosis | null,
        ) => {
            if (!useFixedContext || !diagnosis) return;
            const byLag = getAutomaticEventShiftCandidates().map((olderLag) => {
                return fixedContextLagAudit(diagnosis, olderLag);
            });
            fixedContextCleanCases.push({
                file: file.slice(ITRDB_DIR.length),
                target,
                byLag,
            });
        };
        const auditFixedWindowCounterfactual = (
            eventType: "missingRing" | "falseRing" | "partialMove",
            file: string,
            target: string,
            truthYear: number,
            olderLag: number,
            diagnosis: SeriesCoreDiagnosis | null,
            site: RwlSiteData | null,
            currentEvents: DiagnosisEvent[],
            locatorAudits: CounterfactualLocatorAuditRow[],
        ) => {
            if (!useFixedWindowCounterfactual || !diagnosis || !site) return;
            const scoringContext = buildFixedWindowCounterfactualContext(
                diagnosis,
                site,
            );
            const compatibleEvents = currentEvents.flatMap((event) => [
                event,
                ...(event.operationAlternatives ?? []),
            ]).filter((event) => (
                event.eventType === eventType
                && (
                    eventType !== "partialMove"
                    || event.shiftYears === olderLag
                )
            ));
            const coarseWindowFrom = (event: DiagnosisEvent) => {
                const note = event.evidence.notes.find((value) => (
                    value.startsWith("counterfactual_coarse_window=")
                ));
                const matched = note?.match(/=(\-?\d+)-(\-?\d+)$/);
                if (!matched) return null;
                return {
                    startYear: Number(matched[1]),
                    endYear: Number(matched[2]),
                };
            };
            const observedCoarseWindows = locatorAudits
                .filter((row) => (
                    row.eventType === eventType
                    && row.correctionYears === olderLag
                ))
                .map((row) => row.coarseWindow);
            const windows = compatibleEvents.flatMap((event, eventRank) => {
                const coarse = coarseWindowFrom(event);
                return [
                    {
                        eventRank,
                        locationRank: 0,
                        source: "event",
                        startYear: event.startYear,
                        endYear: event.endYear,
                    },
                    ...(coarse ? [{
                        eventRank,
                        locationRank: -1,
                        source: "counterfactual_coarse",
                        ...coarse,
                    }] : []),
                    ...observedCoarseWindows.map((observed) => ({
                        eventRank,
                        locationRank: -2,
                        source: "observed_counterfactual_coarse",
                        ...observed,
                    })),
                    ...(event.locationAlternatives ?? []).map((location) => ({
                        eventRank,
                        locationRank: location.rank,
                        source: "location_alternative",
                        startYear: location.startYear,
                        endYear: location.endYear,
                    })),
                ];
            }).filter((window, index, all) => (
                all.findIndex((candidate) => (
                    candidate.startYear === window.startYear
                    && candidate.endYear === window.endYear
                )) === index
            )).map((window) => ({
                ...window,
                rows: scoreFixedWindowCounterfactual(
                    scoringContext,
                    eventType,
                    olderLag,
                    window,
                    {
                        includeBoundaryLocal:
                            process.env.ITRDB_FIXED_WINDOW_BOUNDARY_LOCAL !== "0",
                    },
                ),
            }));
            fixedWindowCounterfactualCases.push({
                file: file.slice(ITRDB_DIR.length),
                target,
                eventType,
                truthYear,
                olderLag,
                windows,
            });
        };
        const tallyExhaustive = (
            eventType: keyof typeof exhaustiveHits,
            scoreName: ExhaustiveScoreName,
            currentHit: boolean,
            exhaustiveHit: boolean,
        ) => {
            if (exhaustiveHit) exhaustiveHits[eventType][scoreName] += 1;
            const bucket = exhaustiveOverlap[eventType][scoreName];
            if (currentHit && exhaustiveHit) bucket.both += 1;
            else if (currentHit) bucket.currentOnly += 1;
            else if (exhaustiveHit) bucket.exhaustiveOnly += 1;
            else bucket.neither += 1;
        };

        const auditLocations = (event: DiagnosisEvent): AuditedLocation[] => [
            {
                rank: 0,
                range: [event.startYear, event.endYear] as [number, number],
                topYear: event.rankedYears[0]?.year ?? null,
                shiftYears: event.shiftYears ?? null,
                shiftSide: event.shiftSide ?? null,
                evidenceScore: event.evidence.score,
                locationScoreMargin: event.evidence.scoreMargin,
                yearScoreMargin: (event.rankedYears[0]?.score ?? 0)
                    - (event.rankedYears[1]?.score ?? event.rankedYears[0]?.score ?? 0),
                algorithmSource: "primary_event",
            },
            ...(event.locationAlternatives ?? []).map((location) => ({
                rank: location.rank,
                range: [location.startYear, location.endYear] as [number, number],
                topYear: location.rankedYears[0]?.year ?? null,
                shiftYears: location.shiftYears ?? event.shiftYears ?? null,
                shiftSide: location.shiftSide ?? event.shiftSide ?? null,
                evidenceScore: location.evidenceScore,
                locationScoreMargin: location.scoreMargin,
                yearScoreMargin: (location.rankedYears[0]?.score ?? 0)
                    - (location.rankedYears[1]?.score
                        ?? location.rankedYears[0]?.score
                        ?? 0),
                algorithmSource: location.algorithmSource,
            })),
        ];
        const auditOperationAlternatives = (event: DiagnosisEvent) => (
            (event.operationAlternatives ?? []).map((alternative) => ({
                type: alternative.eventType,
                shiftYears: alternative.shiftYears ?? null,
                shiftSide: alternative.shiftSide ?? null,
                locations: auditLocations(alternative),
            }))
        );

        const add = (
            aggregate: Aggregate,
            truth: TruthEvent,
            predictions: ReturnType<typeof diagnoseTargetEvents>,
            context: BenchmarkCaseContext,
        ) => {
            const typedPredictions = predictions.filter((event) => event.eventType === truth.eventType);
            const primaryPrediction = [...typedPredictions]
                .sort((left, right) => (
                    right.evidence.score - left.evidence.score
                    || right.endYear - left.endYear
                ))[0] ?? null;
            const result = matchDiagnosisEvents([truth], typedPredictions);
            const selectablePredictions = predictions.flatMap((event) => [
                event,
                ...(event.operationAlternatives ?? []),
            ]).filter((event) => event.eventType === truth.eventType);
            const selectableResult = matchDiagnosisEvents(
                [truth],
                selectablePredictions,
            );
            const operationCompatible = (event: DiagnosisEvent) => (
                event.seriesId === truth.seriesId
                && event.eventType === truth.eventType
                && (
                    truth.eventType !== "partialMove"
                    || (
                        event.shiftYears === truth.shiftYears
                        && event.shiftSide === truth.shiftSide
                    )
                )
            );
            const operationMatched = predictions.some(operationCompatible);
            const selectableOperationMatched =
                selectablePredictions.some(operationCompatible);
            const operationRecoveryApplied = predictions.some((event) => (
                event.evidence.algorithmSources.includes(
                    "gain_gated_event_recovery",
                )
            ));
            aggregate.cases += 1;
            aggregate.answered += typedPredictions.length > 0 ? 1 : 0;
            aggregate.predictions += result.predictionCount;
            aggregate.matched += result.matchedCount;
            aggregate.complete += result.completeCaseSuccess ? 1 : 0;
            aggregate.selectableMatched += selectableResult.matchedCount;
            // Operation alternatives are mutually exclusive user choices, not extra
            // simultaneous predictions. A case is selectable-complete when every
            // injected truth has at least one matching choice.
            aggregate.selectableComplete += selectableResult.matchedCount === 1 ? 1 : 0;
            if (result.matchedCount === 0 && selectableResult.matchedCount > 0) {
                aggregate.operationAlternativeRecovered += 1;
            }
            aggregate.operationMatched += operationMatched ? 1 : 0;
            aggregate.selectableOperationMatched += selectableOperationMatched ? 1 : 0;
            aggregate.operationRecoveryApplied += operationRecoveryApplied ? 1 : 0;
            aggregate.multiplePredictionCases += predictions.length > 1 ? 1 : 0;
            aggregate.widths.push(...result.widths);
            aggregate.ranks.push(...result.ranks);
            const match = result.matches[0] ?? null;
            const primaryTopYear = match?.prediction.rankedYears[0]?.year;
            const matchedAlternative = match && match.locationRank > 0
                ? match.prediction.locationAlternatives?.find(
                    (alternative) => alternative.rank === match.locationRank,
                ) ?? null
                : null;
            const selectedTopYear = matchedAlternative?.rankedYears[0]?.year
                ?? (match?.locationRank === 0 ? primaryTopYear : undefined);
            const primaryMatched = match?.locationRank === 0;
            const primaryTruthRank = primaryMatched
                ? match.prediction.rankedYears.find(
                        (row) => row.year === truth.year,
                    )?.rank ?? null
                : null;
            if (primaryMatched) aggregate.primaryMatched += 1;
            if (match && match.locationRank > 0) aggregate.alternativeRecovered += 1;
            if (match) aggregate.locationRanks.push(match.locationRank);
            eventCaseOutcomes.push({
                context,
                eventType: truth.eventType as EventCaseOutcome["eventType"],
                systemResponded: predictions.length > 0,
                answered: typedPredictions.length > 0,
                primaryEventType: predictions[0]?.eventType ?? null,
                primaryEventShiftYears: predictions[0]?.shiftYears ?? null,
                partialMoveMisclassification: truth.eventType !== "partialMove"
                    && predictions[0]?.eventType === "partialMove",
                predictions: result.predictionCount,
                totalPredictions: predictions.length,
                matched: result.matchedCount > 0,
                primaryMatched,
                operationMatched,
                selectableOperationMatched,
                operationRecoveryApplied,
                operationChoices: predictions.flatMap((event) => [
                    `${event.eventType}:${event.shiftYears ?? 0}`,
                    ...(event.operationAlternatives ?? []).map(
                        (alternative) => (
                            `${alternative.eventType}:${alternative.shiftYears ?? 0}`
                        ),
                    ),
                ]),
                locationRank: match?.locationRank ?? null,
                complete: result.completeCaseSuccess,
                width: result.widths[0] ?? null,
                top1Exact: primaryMatched && primaryTopYear === truth.year,
                top1WithinOne: primaryMatched
                    && primaryTopYear !== undefined
                    && Math.abs(primaryTopYear - truth.year) <= 1,
                selectedTop1Exact: selectedTopYear === truth.year,
                selectedTop1WithinOne: selectedTopYear !== undefined
                    && Math.abs(selectedTopYear - truth.year) <= 1,
                truthShiftYears: truth.shiftYears ?? null,
                primaryPredictionTopYear:
                    primaryPrediction?.rankedYears[0]?.year ?? null,
                primaryPredictionRange: primaryPrediction
                    ? [primaryPrediction.startYear, primaryPrediction.endYear]
                    : null,
                primaryPredictionShiftYears: primaryPrediction?.shiftYears ?? null,
                matchedPrimaryTopYear: primaryTopYear ?? null,
                selectedTopYear: selectedTopYear ?? null,
                primaryTruthRank,
                primaryTopYearError: primaryPrediction?.rankedYears[0]
                    ? primaryPrediction.rankedYears[0].year - truth.year
                    : null,
                primaryTopYearCenterOffset: primaryPrediction?.rankedYears[0]
                    ? primaryPrediction.rankedYears[0].year
                        - (primaryPrediction.startYear + primaryPrediction.endYear) / 2
                    : null,
            });
            result.matches.forEach((match) => {
                const primaryTopYear = match.prediction.rankedYears[0]?.year;
                const alternative = match.locationRank > 0
                    ? match.prediction.locationAlternatives?.find(
                        (candidate) => candidate.rank === match.locationRank,
                    ) ?? null
                    : null;
                const selectedTopYear = alternative?.rankedYears[0]?.year
                    ?? (match.locationRank === 0 ? primaryTopYear : undefined);
                if (match.locationRank === 0) {
                    if (primaryTopYear === match.truth.year) aggregate.top1Exact += 1;
                    if (primaryTopYear !== undefined
                        && Math.abs(primaryTopYear - match.truth.year) <= 1) {
                        aggregate.top1WithinOne += 1;
                    }
                    if (primaryTopYear !== undefined) {
                        aggregate.topYearErrors.push(primaryTopYear - match.truth.year);
                    }
                }
                if (selectedTopYear === match.truth.year) aggregate.selectedTop1Exact += 1;
                if (selectedTopYear !== undefined
                    && Math.abs(selectedTopYear - match.truth.year) <= 1) {
                    aggregate.selectedTop1WithinOne += 1;
                }
                if (selectedTopYear !== undefined) {
                    aggregate.selectedTopYearErrors.push(selectedTopYear - match.truth.year);
                }
                rankingCases.push({
                    groupId: context.groupId,
                    seriesId: match.truth.seriesId,
                    eventType: match.truth.eventType,
                    truthYear: match.truth.year,
                    range: [match.prediction.startYear, match.prediction.endYear],
                    rankedYears: match.prediction.rankedYears.map((row) => ({
                        year: row.year,
                        score: row.score,
                        tags: row.evidenceTags,
                    })),
                    confidence: match.prediction.confidenceLevel,
                    sources: match.prediction.evidence.algorithmSources,
                    notes: match.prediction.evidence.notes,
                    matchedLocationRank: match.locationRank,
                    matchedLocationRange: alternative
                        ? [alternative.startYear, alternative.endYear]
                        : [match.prediction.startYear, match.prediction.endYear],
                    matchedLocationRankedYears: alternative
                        ? alternative.rankedYears
                        : match.prediction.rankedYears,
                    locations: auditLocations(match.prediction),
                    positionStratum: context.positionStratum,
                    normalizedPosition: context.normalizedPosition,
                    signalStrength: context.signalStrength,
                });
            });
            return result;
        };
        const median = (values: number[]) => {
            if (values.length === 0) return 0;
            const sorted = [...values].sort((a, b) => a - b);
            return sorted[Math.floor((sorted.length - 1) / 2)];
        };
        const percentile = (values: number[], probability: number) => {
            if (values.length === 0) return 0;
            const sorted = [...values].sort((a, b) => a - b);
            return sorted[Math.min(
                sorted.length - 1,
                Math.ceil(sorted.length * probability) - 1,
            )];
        };
        const collectWindowRankCase = (
            eventType: WindowRankCase["eventType"],
            truthYear: number,
            truthShiftYears: number | undefined,
            context: BenchmarkCaseContext,
            run: {
                events: DiagnosisEvent[];
                diagnosis: SeriesCoreDiagnosis | null;
                cofechaDiagnosis: SeriesCoreDiagnosis | null;
                site: RwlSiteData | null;
            },
        ) => {
            if (!collectWindowRankData || !run.diagnosis || !run.site) return;
            const diagnosis = run.diagnosis;
            const site = run.site;
            const expectedLag = eventType === "missingRing"
                ? -1
                : eventType === "falseRing"
                    ? 1
                    : truthShiftYears;
            if (expectedLag === undefined) return;
            const current = run.events
                .filter((event) => event.eventType === eventType)
                .sort((a, b) => b.evidence.score - a.evidence.score)[0] ?? null;
            const localized = eventType === "partialMove"
                ? scanLocalizedPartialMove(diagnosis)
                : scanLocalizedUnitEdit(
                    diagnosis,
                    eventType === "missingRing" ? "insert" : "delete",
                );
            const pairwise = eventType === "partialMove"
                ? scanPairwisePartialMove(diagnosis, site)
                : scanPairwiseUnitEdit(
                    diagnosis,
                    site,
                    eventType === "missingRing" ? "insert" : "delete",
                );
            const piecewise = scorePiecewiseChangePoints(
                diagnosis,
                run.cofechaDiagnosis,
                {
                    lags: eventType === "partialMove"
                        ? getAutomaticPartialShiftCandidates()
                        : [expectedLag],
                },
            );
            const cumulative = scoreCumulativeLagChangePoints(
                diagnosis,
                run.cofechaDiagnosis,
                {
                    lags: eventType === "partialMove"
                        ? getAutomaticPartialShiftCandidates()
                        : [expectedLag],
                    siteData: site,
                },
            );
            const keyFor = (year: number, shiftYears?: number) => (
                `${year}:${shiftYears ?? expectedLag}`
            );
            const publicYear = (year: number): number => (
                eventType === "partialMove"
                    ? firstFixedYearFromLastMovedYear(year)
                    : year
            );
            const pairwiseByKey = new Map(pairwise.map((row) => [
                keyFor(row.year, row.shiftYears),
                row,
            ]));
            const piecewiseByKey = new Map(piecewise.map((row) => [
                keyFor(publicYear(row.year), row.olderLag),
                row,
            ]));
            const cumulativeByKey = new Map(cumulative.map((row) => [
                keyFor(publicYear(row.year), row.olderLag),
                row,
            ]));
            const noteYear = (prefix: string): number | null => {
                const note = current?.evidence.notes.find((value) => value.startsWith(prefix));
                if (!note) return null;
                const value = Number(note.slice(prefix.length));
                return Number.isFinite(value) ? value : null;
            };
            const signalYears = {
                profile: noteYear("profile_boundary_year="),
                scan: noteYear("scan_top_year="),
                rawPath: noteYear("raw_path_top_year="),
                candidate: noteYear("candidate_top_year="),
                direct: noteYear("direct_breakpoint_year="),
                paired: noteYear("paired_breakpoint_year="),
                reference: noteYear("reference_vote_year="),
            };
            const span = Math.max(
                1,
                diagnosis.targetRange.endYear - diagnosis.targetRange.startYear,
            );
            const rows = localized.map((row) => {
                    const shiftYears = "shiftYears" in row ? row.shiftYears : undefined;
                    const candidateLag = shiftYears ?? expectedLag;
                    const pair = pairwiseByKey.get(keyFor(row.year, shiftYears));
                    const changePoint = piecewiseByKey.get(keyFor(row.year, shiftYears));
                    const cumulativeChangePoint = cumulativeByKey.get(
                        keyFor(row.year, shiftYears),
                    );
                    const currentTopYear = current?.rankedYears[0]?.year ?? null;
                    const features: Record<string, number> = {
                        rawFull: row.raw,
                        differenceFull: row.difference,
                        whitenedFull: row.whitened,
                        comboFull: row.combo,
                        differenceGain21: row.differenceGain21,
                        differenceGain31: row.differenceGain31,
                        differenceGain41: row.differenceGain41,
                        differenceGain61: row.differenceGain61,
                        whitenedGain31: row.whitenedGain31,
                        whitenedGain61: row.whitenedGain61,
                        pairDifferenceMean: pair?.differenceMean ?? 0,
                        pairDifferenceMedian: pair?.differenceMedian ?? 0,
                        pairDifferenceTrimmed: pair?.differenceTrimmed ?? 0,
                        pairDifferenceWeighted: pair?.differenceWeighted ?? 0,
                        pairWhitenedMean: pair?.whitenedMean ?? 0,
                        pairWhitenedMedian: pair?.whitenedMedian ?? 0,
                        pairDifferenceMeanGain: pair?.differenceMeanGain ?? 0,
                        pairDifferenceTrimmedGain: pair?.differenceTrimmedGain ?? 0,
                        pairWhitenedMeanGain: pair?.whitenedMeanGain ?? 0,
                        piecewiseCombinedObjective: changePoint?.combinedObjective ?? 0,
                        piecewiseCombinedGain: changePoint?.combinedGain ?? 0,
                        piecewiseCofechaObjective: changePoint?.cofechaObjective ?? 0,
                        piecewiseWhitenedObjective: changePoint?.whitenedObjective ?? 0,
                        piecewiseDifferenceObjective: changePoint?.differenceObjective ?? 0,
                        cumulativeCombined: cumulativeChangePoint?.combinedCumulative ?? 0,
                        cumulativeContrast: cumulativeChangePoint?.combinedContrast ?? 0,
                        cumulativeLocal31: cumulativeChangePoint?.combinedLocal31 ?? 0,
                        cumulativeLocal61: cumulativeChangePoint?.combinedLocal61 ?? 0,
                        cumulativeRaw: cumulativeChangePoint?.rawCumulative ?? 0,
                        cumulativeRawContrast: cumulativeChangePoint?.rawContrast ?? 0,
                        cumulativeDifference:
                            cumulativeChangePoint?.differenceCumulative ?? 0,
                        cumulativeDifferenceContrast:
                            cumulativeChangePoint?.differenceContrast ?? 0,
                        cumulativeWhitened:
                            cumulativeChangePoint?.whitenedCumulative ?? 0,
                        cumulativeWhitenedContrast:
                            cumulativeChangePoint?.whitenedContrast ?? 0,
                        cumulativeCofecha:
                            cumulativeChangePoint?.cofechaCumulative ?? 0,
                        cumulativeCofechaContrast:
                            cumulativeChangePoint?.cofechaContrast ?? 0,
                        cumulativeReferenceMedian:
                            cumulativeChangePoint?.referenceMedianCumulative ?? 0,
                        cumulativeReferenceMedianContrast:
                            cumulativeChangePoint?.referenceMedianContrast ?? 0,
                        cumulativeReferenceMean:
                            cumulativeChangePoint?.referenceMeanCumulative ?? 0,
                        cumulativeReferenceMeanContrast:
                            cumulativeChangePoint?.referenceMeanContrast ?? 0,
                        cumulativeReferenceVote:
                            cumulativeChangePoint?.referenceVoteCumulative ?? 0,
                        cumulativeReferenceVoteContrast:
                            cumulativeChangePoint?.referenceVoteContrast ?? 0,
                        normalizedPosition: (
                            row.year - diagnosis.targetRange.startYear
                        ) / span,
                        olderContext: (
                            row.year - diagnosis.targetRange.startYear
                        ) / span,
                        newerContext: (
                            diagnosis.targetRange.endYear - row.year
                        ) / span,
                        candidateLag,
                        candidateLagAbs: Math.abs(candidateLag),
                        candidateLagDirection: Math.sign(candidateLag),
                        referenceCount: context.referenceCount,
                        hasCurrentEvent: current ? 1 : 0,
                        currentTopDistance: currentTopYear === null
                            ? 1
                            : Math.abs(row.year - currentTopYear) / span,
                        currentTopSignedDistance: currentTopYear === null
                            ? 0
                            : (row.year - currentTopYear) / span,
                        insideCurrentWindow: current
                            && row.year >= current.startYear
                            && row.year <= current.endYear
                            ? 1
                            : 0,
                    };
                    Object.entries(signalYears).forEach(([name, signalYear]) => {
                        features[`${name}Available`] = signalYear === null ? 0 : 1;
                        features[`${name}Distance`] = signalYear === null
                            ? 1
                            : Math.abs(row.year - signalYear) / span;
                        features[`${name}SignedDistance`] = signalYear === null
                            ? 0
                            : (row.year - signalYear) / span;
                    });
                    return {
                        year: row.year,
                        ...(shiftYears === undefined ? {} : { shiftYears }),
                        features,
                    };
                });
            const residualRows = collectWindowRankResiduals
                ? (() => {
                    const tolerance = eventType === "partialMove" ? 4 : 3;
                    const localizedForLag = localized.filter((row) => (
                        eventType !== "partialMove" || row.shiftYears === expectedLag
                    ));
                    const pairwiseForLag = pairwise.filter((row) => (
                        eventType !== "partialMove" || row.shiftYears === expectedLag
                    ));
                    const piecewiseForLag = piecewise.filter((row) => (
                        row.olderLag === expectedLag
                    ));
                    const signals: Array<Array<{ year: number; score: number }>> = [
                        localizedForLag.map((row) => ({ year: row.year, score: row.raw })),
                        localizedForLag.map((row) => ({ year: row.year, score: row.difference })),
                        localizedForLag.map((row) => ({ year: row.year, score: row.whitened })),
                        localizedForLag.map((row) => ({ year: row.year, score: row.combo })),
                        localizedForLag.map((row) => ({
                            year: row.year,
                            score: row.differenceGain31,
                        })),
                        localizedForLag.map((row) => ({
                            year: row.year,
                            score: row.differenceGain61,
                        })),
                        pairwiseForLag.map((row) => ({
                            year: row.year,
                            score: row.differenceMean,
                        })),
                        pairwiseForLag.map((row) => ({
                            year: row.year,
                            score: row.differenceTrimmed,
                        })),
                        pairwiseForLag.map((row) => ({
                            year: row.year,
                            score: row.whitenedMean,
                        })),
                        piecewiseForLag.map((row) => ({
                            year: row.year,
                            score: row.combinedObjective,
                        })),
                        piecewiseForLag.map((row) => ({
                            year: row.year,
                            score: row.cofechaObjective,
                        })),
                    ];
                    const candidateYears = new Set<number>();
                    signals.forEach((signal) => {
                        const selected: number[] = [];
                        [...signal]
                            .sort((a, b) => b.score - a.score || b.year - a.year)
                            .forEach((row) => {
                                if (selected.length >= 3) return;
                                if (selected.every((year) => (
                                    Math.abs(year - row.year) > tolerance * 2 + 1
                                ))) {
                                    selected.push(row.year);
                                    candidateYears.add(row.year);
                                }
                            });
                    });
                    const currentTopYear = current?.rankedYears[0]?.year;
                    if (currentTopYear !== undefined) candidateYears.add(currentTopYear);
                    if (current) {
                        candidateYears.add(Math.round((current.startYear + current.endYear) / 2));
                    }
                    const summarizeCore = (core: SeriesCoreDiagnosis) => {
                        const correlations = core.segments
                            .map((segment) => segment.r0)
                            .filter((value): value is number => value !== null);
                        const meanR = correlations.length > 0
                            ? correlations.reduce((sum, value) => sum + value, 0)
                                / correlations.length
                            : -1;
                        const meanAbsLag = core.segments.length > 0
                            ? core.segments.reduce(
                                (sum, segment) => sum + Math.abs(segment.bestLag),
                                0,
                            ) / core.segments.length
                            : 0;
                        return {
                            meanR,
                            minimumR: correlations.length > 0
                                ? Math.min(...correlations)
                                : -1,
                            flagged: core.segments.filter((segment) => segment.flagged).length,
                            bLike: core.segments.filter((segment) => segment.flag === "B_like").length,
                            aLike: core.segments.filter((segment) => segment.flag === "A_like").length,
                            nonzeroLag: core.segments.filter((segment) => segment.bestLag !== 0).length,
                            meanAbsLag,
                            propagation: core.propagationPatterns.length,
                            propagationConfidence: core.propagationPatterns.reduce(
                                (best, pattern) => Math.max(best, pattern.confidence),
                                0,
                            ),
                            currentR: core.globalSlidingMatch.currentR ?? -1,
                            bestR: core.globalSlidingMatch.bestGlobalR ?? -1,
                            bestLagAbs: Math.abs(core.globalSlidingMatch.bestGlobalLag),
                            unresolvedA: core.unresolvedA,
                            unresolvedB: core.unresolvedB,
                        };
                    };
                    const before = summarizeCore(diagnosis);
                    const correctAt = (candidateYear: number): NumericSeries => {
                        const corrected: NumericSeries = new Map();
                        diagnosis.rawTarget.forEach((value, year) => {
                            if (eventType === "missingRing") {
                                corrected.set(year <= candidateYear ? year - 1 : year, value);
                            } else if (eventType === "falseRing") {
                                if (year !== candidateYear) {
                                    corrected.set(year < candidateYear ? year + 1 : year, value);
                                }
                            } else {
                                corrected.set(
                                    year <= candidateYear ? year + expectedLag : year,
                                    value,
                                );
                            }
                        });
                        return corrected;
                    };
                    const config = getConfig({ referenceConfig: null });
                    return [...candidateYears]
                        .sort((a, b) => a - b)
                        .flatMap((candidateYear): ResidualWindowRankRow[] => {
                            const correctedSite: RwlSiteData = new Map(site);
                            correctedSite.set(
                                diagnosis.targetTree,
                                correctAt(candidateYear) as RwlTreeData,
                            );
                            const afterDiagnosis = diagnoseSeriesCore(
                                correctedSite,
                                diagnosis.targetTree,
                                config,
                                preprocessSeries,
                                undefined,
                                diagnosis.master,
                            );
                            if (!afterDiagnosis) return [];
                            const after = summarizeCore(afterDiagnosis);
                            return [{
                                year: candidateYear,
                                ...(eventType === "partialMove"
                                    ? { shiftYears: expectedLag }
                                    : {}),
                                features: {
                                    meanRDelta: after.meanR - before.meanR,
                                    minimumRDelta: after.minimumR - before.minimumR,
                                    flaggedResolved: before.flagged - after.flagged,
                                    bLikeResolved: before.bLike - after.bLike,
                                    aLikeResolved: before.aLike - after.aLike,
                                    nonzeroLagResolved: before.nonzeroLag - after.nonzeroLag,
                                    meanAbsLagReduction: before.meanAbsLag - after.meanAbsLag,
                                    propagationResolved: before.propagation - after.propagation,
                                    propagationConfidenceReduction:
                                        before.propagationConfidence
                                        - after.propagationConfidence,
                                    currentRDelta: after.currentR - before.currentR,
                                    bestRDelta: after.bestR - before.bestR,
                                    afterMeanR: after.meanR,
                                    afterMinimumR: after.minimumR,
                                    afterFlagged: after.flagged,
                                    afterBLike: after.bLike,
                                    afterALike: after.aLike,
                                    afterNonzeroLag: after.nonzeroLag,
                                    afterMeanAbsLag: after.meanAbsLag,
                                    afterPropagation: after.propagation,
                                    afterCurrentR: after.currentR,
                                    afterBestR: after.bestR,
                                    afterBestLagAbs: after.bestLagAbs,
                                    afterUnresolvedA: after.unresolvedA,
                                    afterUnresolvedB: after.unresolvedB,
                                },
                            }];
                        });
                })()
                : undefined;
            windowRankCases.push({
                groupId: `${context.file}:${context.target}`,
                eventType,
                truthYear,
                ...(truthShiftYears === undefined ? {} : { truthShiftYears }),
                currentTopYear: current?.rankedYears[0]?.year ?? null,
                currentRange: current ? [current.startYear, current.endYear] : null,
                currentShiftYears: current?.shiftYears ?? null,
                currentScore: current?.evidence.score ?? null,
                currentMargin: current?.evidence.scoreMargin ?? null,
                currentConfidence: current?.confidenceLevel ?? null,
                currentSources: current?.evidence.algorithmSources ?? [],
                context,
                rows,
                ...(residualRows === undefined ? {} : { residualRows }),
            });
        };
        const collectRecoveryGateCase = (
            caseType: RecoveryGateAuditCase["caseType"],
            truthEventType: RecoveryGateAuditCase["truthEventType"],
            truthYear: number | null,
            truthShiftYears: number | null,
            context: BenchmarkCaseContext,
            run: {
                events: DiagnosisEvent[];
                diagnosis: SeriesCoreDiagnosis | null;
                cofechaDiagnosis: SeriesCoreDiagnosis | null;
                site: RwlSiteData | null;
            },
        ) => {
            const jointAuditLabel = caseType === "clean"
                ? "clean"
                : truthEventType ?? "unknown";
            const collectThisJointOperation = collectJointOperationAudit
                && (
                    jointOperationAuditTypes.size === 0
                    || jointOperationAuditTypes.has(jointAuditLabel)
                )
                && (
                    !jointOperationAuditBaselineCleanOnly
                    || context.baselineFlagged !== true
                );
            if ((!collectRecoveryGateAudit && !collectThisJointOperation)
                || !run.diagnosis
                || !run.site) return;
            if (collectRecoveryGateAudit) {
                recoveryGateAuditCases.push({
                    caseType,
                    truthEventType,
                    truthYear,
                    truthShiftYears,
                    context,
                    currentEvents: run.events.map((event) => ({
                        eventType: event.eventType,
                        startYear: event.startYear,
                        endYear: event.endYear,
                        shiftYears: event.shiftYears ?? null,
                        confidenceLevel: event.confidenceLevel,
                        score: event.evidence.score,
                        scoreMargin: event.evidence.scoreMargin,
                        lagBefore: event.evidence.lagBefore,
                        lagAfter: event.evidence.lagAfter,
                        correlationGain: event.evidence.correlationGain,
                        candidateCount: event.evidence.candidateIds.length,
                        algorithmSources: event.evidence.algorithmSources,
                        notes: event.evidence.notes,
                    })),
                    hypotheses: scoreGainGatedRecoveryHypotheses(
                        run.diagnosis,
                        run.cofechaDiagnosis,
                        run.site,
                        {
                            verifyLocationCorrections:
                                process.env.ITRDB_RECOVERY_VERIFY_LOCATIONS === "1",
                        },
                    ),
                });
            }
            if (collectThisJointOperation) {
                const transitionScan = !compactJointOperationAudit
                    && run.cofechaDiagnosis
                    ? scoreLagTransitionHypotheses(
                        run.cofechaDiagnosis,
                        run.site,
                        eventPathConfig,
                    )
                    : null;
                const jointOperationEdgeYears = numericOverride(
                    "ITRDB_JOINT_OPERATION_EDGE_YEARS",
                ) ?? 20;
                const jointOperationBaselineLag = numericOverride(
                    "ITRDB_JOINT_OPERATION_BASELINE_LAG",
                );
                const operations = jointOperationEdgeYears === 15
                    && jointOperationBaselineLag === undefined
                    ? getJointCounterfactualOperationScores(
                        run.diagnosis,
                        jointOperationEdgeYears,
                        process.env.ITRDB_UNIT_EVENTS_ONLY === "1"
                            ? 1
                            : undefined,
                    )
                    : scoreJointCounterfactualOperations(
                        run.diagnosis,
                        jointOperationEdgeYears,
                        undefined,
                        jointOperationBaselineLag,
                    );
                const operationScore = (
                    operation: ReturnType<
                        typeof scoreJointCounterfactualOperations
                    >[number],
                ): number => scoreDynamicJointOperation(
                    operation,
                    operations,
                );
                const referenceOperationCandidates = referenceOperationUnitOnly
                    ? operations.filter((operation) => (
                        (
                            operation.eventType === "missingRing"
                            && operation.shiftYears === -1
                        )
                        || (
                            operation.eventType === "falseRing"
                            && operation.shiftYears === 1
                        )
                    ))
                    : operations;
                const stagedReferenceOperations = collectReferenceOperationAudit
                    ? [...new Map([
                        ...referenceOperationCandidates
                            .slice()
                            .sort((left, right) => (
                                operationScore(right) - operationScore(left)
                            ))
                            .slice(0, referenceOperationStageCount),
                        ...referenceOperationCandidates
                            .slice()
                            .sort((left, right) => (
                                right.topThreeSideStepScore
                                    - left.topThreeSideStepScore
                                || right.bestSideStepScore
                                    - left.bestSideStepScore
                            ))
                            .slice(0, referenceOperationStageCount),
                    ].map((operation) => [
                        operation.shiftYears,
                        operation,
                    ])).values()]
                    : [];
                const referenceOperationScores = stagedReferenceOperations.map(
                    (operation) => ({
                        eventType: operation.eventType,
                        shiftYears: operation.shiftYears,
                        masterScore: operationScore(operation),
                        sideStepScore: operation.topThreeSideStepScore,
                        summary: summarizePerReferenceCounterfactualRows(
                            scorePerReferenceCounterfactualEvidence(
                                run.diagnosis!,
                                run.site!,
                                operation.shiftYears,
                                {
                                    edgeYears: jointOperationEdgeYears,
                                    maximumReferences: 12,
                                    baselineLagCenter:
                                        operation.baselineLag,
                                },
                            ),
                        ),
                    }),
                );
                const jointPairPath = process.env.ITRDB_JOINT_PAIR_AUDIT === "1"
                    ? scoreJointCounterfactualPath(run.diagnosis, operations)
                    : null;
                const contextualEvent = run.events
                    .filter((event) => event.eventType !== "wholeSeriesMove")
                    .sort((left, right) => (
                        right.evidence.score - left.evidence.score
                        || right.evidence.scoreMargin - left.evidence.scoreMargin
                    ))[0];
                const contextualCenterYear = contextualEvent
                    ? contextualEvent.rankedYears[0]?.year
                        ?? Math.round(
                            (contextualEvent.startYear + contextualEvent.endYear) / 2,
                        )
                    : null;
                const contextualWindows = contextualCenterYear === null
                    ? []
                    : [13, 25, 29, 41].map((width) => {
                        const maximumStart =
                            run.diagnosis!.targetRange.endYear - width + 1;
                        const startYear = Math.max(
                            run.diagnosis!.targetRange.startYear,
                            Math.min(
                                contextualCenterYear - Math.floor(width / 2),
                                maximumStart,
                            ),
                        );
                        return {
                            width,
                            startYear,
                            endYear: startYear + width - 1,
                        };
                    });
                const segmentedPathEvents = process.env.ITRDB_JOINT_SEGMENTED_AUDIT === "1"
                    && run.cofechaDiagnosis
                    ? locateSegmentedLagEvents(run.cofechaDiagnosis, {
                        minRunYears:
                            numericOverride("ITRDB_JOINT_SEGMENTED_MIN_RUN") ?? 8,
                        maxSegments:
                            numericOverride("ITRDB_JOINT_SEGMENTED_MAX_SEGMENTS") ?? 6,
                        transitionPenalty:
                            numericOverride("ITRDB_JOINT_SEGMENTED_UNIT_PENALTY") ?? 7,
                        largeTransitionPenalty:
                            numericOverride("ITRDB_JOINT_SEGMENTED_BIG_PENALTY") ?? 8,
                        minLocalGain:
                            numericOverride("ITRDB_JOINT_SEGMENTED_MIN_GAIN") ?? 0,
                    })
                    : [];
                jointOperationAuditCases.push({
                    caseType,
                    truthEventType,
                    truthYear,
                    truthShiftYears,
                    context,
                    currentEvents: run.events.map((event) => ({
                        eventType: event.eventType,
                        startYear: event.startYear,
                        endYear: event.endYear,
                        shiftYears: event.shiftYears ?? null,
                        score: event.evidence.score,
                        scoreMargin: event.evidence.scoreMargin,
                        lagBefore: event.evidence.lagBefore,
                        lagAfter: event.evidence.lagAfter,
                        algorithmSources: event.evidence.algorithmSources,
                    })),
                    operations: operations.map((operation) => {
                        if (compactJointOperationAudit) {
                            const bestRow = operation.rows.find(
                                (row) => row.year === operation.bestYear,
                            );
                            return {
                                eventType: operation.eventType,
                                shiftYears: operation.shiftYears,
                                bestYear: operation.bestYear,
                                bestRawGain: operation.bestRawGain,
                                bestDifferenceGain: operation.bestDifferenceGain,
                                bestCombinedGain: operation.bestCombinedGain,
                                topThreeDifferenceGain:
                                    operation.topThreeDifferenceGain,
                                remoteDifferenceMargin:
                                    operation.remoteDifferenceMargin,
                                sideStepBestYear:
                                    operation.sideStepBestYear,
                                bestSideStepScore:
                                    operation.bestSideStepScore,
                                topThreeSideStepScore:
                                    operation.topThreeSideStepScore,
                                bestSideMinimumAdvantage:
                                    operation.bestSideMinimumAdvantage,
                                bestCorrectedSideSupport:
                                    operation.bestCorrectedSideSupport,
                                sideStepRemoteMargin:
                                    operation.sideStepRemoteMargin,
                                baselineLag: operation.baselineLag,
                                rowCount: operation.rows.length,
                                bestSamplePairs: bestRow?.samplePairs ?? null,
                                bestDifferencePairs:
                                    bestRow?.differencePairs ?? null,
                                contextualRegions: contextualWindows.map((window) => ({
                                    width: window.width,
                                    ...summarizeJointOperationRegion(
                                        operation,
                                        window.startYear,
                                        window.endYear,
                                        contextualCenterYear ?? undefined,
                                    ),
                                })),
                            };
                        }
                        const transition = transitionScan?.hypotheses.find(
                            (hypothesis) => (
                                hypothesis.correctionYears === operation.shiftYears
                            ),
                        );
                        const transitionByYear = new Map(
                            transition?.rows.map((row) => [
                                operation.eventType === "partialMove"
                                    ? firstFixedYearFromLastMovedYear(row.year)
                                    : row.year,
                                row,
                            ]) ?? [],
                        );
                        return {
                            ...operation,
                            rows: operation.rows.map((row) => {
                                const path = transitionByYear.get(row.year);
                                return {
                                    ...row,
                                    transitionSplitGain: path?.splitGain ?? null,
                                    transitionNormalizedSplitGain:
                                        path?.normalizedSplitGain ?? null,
                                    transitionBalancedAdvantage:
                                        path?.balancedAdvantage ?? null,
                                    transitionLocalGain31:
                                        path?.localGain31 ?? null,
                                    transitionLocalBalancedAdvantage31:
                                        path?.localBalancedAdvantage31 ?? null,
                                };
                            }),
                        };
                    }),
                    ...(collectReferenceOperationAudit
                        ? { referenceOperationScores }
                        : {}),
                    transitionState: transitionScan ? {
                        newestLag: transitionScan.newestLag,
                        newestLagMargin: transitionScan.newestLagMargin,
                        newestLagPairs: transitionScan.newestLagPairs,
                    } : null,
                    contextualOperationCenterYear: contextualCenterYear,
                    jointPairPath,
                    segmentedPathEvents: segmentedPathEvents.map((event) => ({
                        eventType: event.eventType,
                        startYear: event.startYear,
                        endYear: event.endYear,
                        shiftYears: event.shiftYears ?? null,
                        score: event.evidence.score,
                        scoreMargin: event.evidence.scoreMargin,
                        lagBefore: event.evidence.lagBefore,
                        lagAfter: event.evidence.lagAfter,
                    })),
                });
            }
        };

        for (let fileIndex = 0; fileIndex < files.length && attempted < maxCases; fileIndex += 1) {
            if (fileFilter && !files[fileIndex].toLowerCase().includes(fileFilter)) continue;
            let parsed: Map<string, Series>;
            try { parsed = parseItrdb(readFileSync(files[fileIndex], "utf8")); } catch { continue; }
            const fixtureSeries = new Map<string, FixtureSeries>();
            parsed.forEach((series, id) => {
                const valuesByYear = new Map(series.valuesByYear);
                fixtureSeries.set(id, {
                    id,
                    valuesByYear,
                    startYear: series.startYear,
                    endYear: series.endYear,
                    length: valuesByYear.size,
                    zeroCount: series.zeros.length,
                    nonZeroCount: valuesByYear.size - series.zeros.length,
                });
            });
            const injectedShift =
                partialGapYears[attempted % partialGapYears.length] ?? 2;
            const eligible = Array.from(fixtureSeries.values()).filter((series) => (
                series.zeroCount === 0
                && series.length >= 150
                && series.endYear - series.startYear + 1 >= 150
                && series.length >= (
                    injectedShift * 2 + minimumContextYears * 2
                )
                && Array.from(fixtureSeries.values()).filter((reference) => (
                    reference.id !== series.id
                    && overlap(parsed.get(reference.id)!, parsed.get(series.id)!) >= 80
                )).length >= 5
            ));
            if (eligible.length === 0) continue;
            const target = eligible[fileIndex % eligible.length];
            const master = buildLeaveOneOutMaster(fixtureSeries, target.id);
            if (master.skipped) continue;
            const relativeFile = files[fileIndex].slice(ITRDB_DIR.length);
            const selection = pickStratifiedCalendarYear(
                target,
                attempted,
                `${offset}:${relativeFile}:${target.id}`,
                minimumContextYears,
                {
                    olderContextYears: minimumOlderContextYears,
                    newerContextYears: minimumNewerContextYears,
                },
            );
            const partialSelection = skipPartialTruth
                ? selection
                : pickStratifiedCalendarYear(
                        target,
                        attempted,
                        `${offset}:${relativeFile}:${target.id}:partial:${injectedShift}`,
                        minimumContextYears,
                        {
                            olderContextYears:
                                minimumOlderContextYears + injectedShift,
                            newerContextYears: minimumNewerContextYears,
                        },
                    );
            if (!selection || !partialSelection) continue;
            const year = selection.year;
            const referenceCount = Array.from(fixtureSeries.values()).filter((reference) => (
                reference.id !== target.id
                && overlap(parsed.get(reference.id)!, parsed.get(target.id)!) >= 80
            )).length;
            const makeContext = (
                selected: typeof selection,
            ): BenchmarkCaseContext => {
                const selectedYear = selected.year;
                const referenceSupportAtYear =
                    master.referenceSeriesIds.filter((referenceId) => (
                        fixtureSeries.get(referenceId)?.valuesByYear.has(
                            selectedYear,
                        )
                    )).length;
                const referenceContextYearCount = Array.from(
                    master.masterValuesByYear.keys(),
                ).filter((referenceYear) => (
                    Math.abs(referenceYear - selectedYear) <= 15
                )).length;
                return {
                    groupId: relativeFile,
                    file: relativeFile,
                    datasetGroup: relativeFile.replace(/\\/g, "/").includes("/")
                        ? relativeFile.replace(/\\/g, "/").split("/").filter(Boolean)[0]
                        : "root",
                    target: target.id,
                    seriesLength: target.length,
                    naturalZeroCount: target.zeroCount,
                    ...selected,
                    signalStrength: measureLocalSignalStrength(
                        target,
                        master.masterValuesByYear,
                        selectedYear,
                    ),
                    referenceCount,
                    referenceSupportAtYear,
                    referenceObservableAtYear: referenceSupportAtYear > 0,
                    referenceContextYearCount,
                };
            };
            const context = makeContext(selection);
            const partialContext = makeContext(partialSelection);
            caseContexts.push(context);

            const run = (
                corrupted: Map<number, number>,
                lightweight = false,
                timingLabel = "case",
            ) => {
                const timingEnabled = process.env.ITRDB_STAGE_TIMING === "1";
                const runStarted = performance.now();
                if (timingEnabled) {
                    // eslint-disable-next-line no-console
                    console.log(
                        `ITRDB TIMING start label=${timingLabel} target=${target.id}`,
                    );
                }
                const site = buildSyntheticSite(fixtureSeries, target.id, corrupted).site;
                const genericEdgeMaximumShift = numericOverride("ITRDB_GENERIC_EDGE_SHIFT");
                const corroboratedEdgeMaximumShift = numericOverride(
                    "ITRDB_CORROBORATED_EDGE_SHIFT",
                );
                const locatorAudits: CounterfactualLocatorAuditRow[] = [];
                const stopObserving = collectCounterfactualLocatorAudit
                    ? observeCounterfactualLocator(
                            (row) => locatorAudits.push(row),
                            {
                                includeCoarseCandidateCounterfactuals:
                                    process.env.ITRDB_COARSE_CANDIDATE_CF_AUDIT
                                        === "1",
                            },
                        )
                    : null;
                const bundleStarted = performance.now();
                const bundle = (() => {
                    try {
                        return site ? diagnoseTargetBundle(site, target.id, {
                            ...(process.env.ITRDB_UNIT_EVENTS_ONLY === "1" ? {
                                diagnosisOptions: {
                                    lagMin: -1,
                                    maxPartialGapYears: 1,
                                },
                            } : {}),
                            eventPathConfig,
                            enableDecisiveJointOperationFusion: !lightweight,
                            enableCounterfactualEventLocator: !lightweight,
                            enableMissingWindowRefinement:
                                process.env.ITRDB_MISSING_REFINEMENT !== "0",
                            enableIndependentBreakpointConsensus:
                                process.env.ITRDB_INDEPENDENT_BREAKPOINT !== "0",
                            enableTargetedPathVerification:
                                process.env.ITRDB_TARGETED_PATH_VERIFY === "1",
                            enableCumulativeLocationAlternatives:
                                process.env.ITRDB_CUMULATIVE_LOCATION_ALTERNATIVES === "1",
                            enableGainGatedOperationRecovery:
                                process.env.ITRDB_GAIN_GATED_OPERATION_RECOVERY === "1",
                            enableMixedReferenceSupplement:
                                process.env.ITRDB_MIXED_REFERENCE_SUPPLEMENT !== "0",
                            enableIncoherentPartialPruning:
                                process.env.ITRDB_INCOHERENT_PARTIAL_PRUNING !== "0",
                            enableLearnedWindowRanking:
                                process.env.ITRDB_LEARNED_WINDOW_RANKING !== "0",
                            enableUnitNeighborRanking:
                                process.env.ITRDB_UNIT_NEIGHBOR_RANKING !== "0",
                            enableEndpointResidualWindow:
                                process.env.ITRDB_ENDPOINT_RESIDUAL_WINDOW !== "0",
                            reviewWindowPaddingYears:
                                numericOverride("ITRDB_REVIEW_WINDOW_PADDING"),
                            reviewWindowDirectionalExtraYears:
                                numericOverride("ITRDB_REVIEW_WINDOW_DIRECTIONAL_EXTRA"),
                            ...((
                        process.env.ITRDB_RECOVERY_MIN_SIDE
                        || process.env.ITRDB_RECOVERY_EXISTING_MIN_GAIN
                        || process.env.ITRDB_RECOVERY_FALLBACK_MIN_GAIN
                        || process.env.ITRDB_RECOVERY_HYPOTHESIS_COUNT
                        || process.env.ITRDB_RECOVERY_DECISION_HYPOTHESIS_COUNT
                        || process.env.ITRDB_RECOVERY_LOCATION_COUNT
                        || process.env.ITRDB_RECOVERY_LOCATIONS_PER_SIGNAL
                        || process.env.ITRDB_RECOVERY_OPERATION_ALTERNATIVES
                        || process.env.ITRDB_RECOVERY_MAX_LOCATION_ALTERNATIVES
                         || process.env.ITRDB_RECOVERY_SINGLE_MAIN
                         || process.env.ITRDB_DYNAMIC_JOINT_MIN_SCORE
                         || process.env.ITRDB_UNIT_EVENTS_ONLY === "1"
                     ) ? {
                         eventOperationRecoveryConfig: {
                            ...(process.env.ITRDB_UNIT_EVENTS_ONLY === "1"
                                ? { maxPartialGapYears: 1 }
                                : {}),
                            ...(process.env.ITRDB_RECOVERY_MIN_SIDE
                                ? {
                                    minimumSideYears: Number(
                                        process.env.ITRDB_RECOVERY_MIN_SIDE,
                                    ),
                                }
                                : {}),
                            ...(process.env.ITRDB_RECOVERY_EXISTING_MIN_GAIN
                                ? {
                                    existingEventMinimumGain: Number(
                                        process.env.ITRDB_RECOVERY_EXISTING_MIN_GAIN,
                                    ),
                                }
                                : {}),
                            ...(process.env.ITRDB_RECOVERY_FALLBACK_MIN_GAIN
                                ? {
                                    emptyEventFallbackMinimumGain: Number(
                                        process.env.ITRDB_RECOVERY_FALLBACK_MIN_GAIN,
                                    ),
                                }
                                : {}),
                            ...(process.env.ITRDB_RECOVERY_HYPOTHESIS_COUNT
                                ? {
                                    verificationHypothesisCount: Number(
                                        process.env.ITRDB_RECOVERY_HYPOTHESIS_COUNT,
                                    ),
                                }
                                : {}),
                            ...(process.env.ITRDB_RECOVERY_DECISION_HYPOTHESIS_COUNT
                                ? {
                                    primaryDecisionHypothesisCount: Number(
                                        process.env
                                            .ITRDB_RECOVERY_DECISION_HYPOTHESIS_COUNT,
                                    ),
                                }
                                : {}),
                            ...(process.env.ITRDB_RECOVERY_LOCATION_COUNT
                                ? {
                                    verificationLocationCount: Number(
                                        process.env.ITRDB_RECOVERY_LOCATION_COUNT,
                                    ),
                                }
                                : {}),
                            ...(process.env.ITRDB_RECOVERY_LOCATIONS_PER_SIGNAL
                                ? {
                                    locationsPerSignal: Number(
                                        process.env.ITRDB_RECOVERY_LOCATIONS_PER_SIGNAL,
                                    ),
                                }
                                : {}),
                            ...(process.env.ITRDB_RECOVERY_OPERATION_ALTERNATIVES
                                ? {
                                    maximumOperationAlternatives: Number(
                                        process.env.ITRDB_RECOVERY_OPERATION_ALTERNATIVES,
                                    ),
                                }
                                : {}),
                            ...(process.env.ITRDB_RECOVERY_MAX_LOCATION_ALTERNATIVES
                                ? {
                                    maximumLocationAlternatives: Number(
                                        process.env
                                            .ITRDB_RECOVERY_MAX_LOCATION_ALTERNATIVES,
                                    ),
                                }
                                : {}),
                            ...(process.env.ITRDB_RECOVERY_SINGLE_MAIN
                                ? {
                                    outputSingleMainWindow:
                                        process.env.ITRDB_RECOVERY_SINGLE_MAIN === "1",
                                }
                                : {}),
                            ...(process.env.ITRDB_DYNAMIC_JOINT_MIN_SCORE
                                ? {
                                    dynamicJointMinimumScore: Number(
                                        process.env.ITRDB_DYNAMIC_JOINT_MIN_SCORE,
                                    ),
                                }
                                : {}),
                        },
                            } : {}),
                            unitWindowRefinementConfig: {
                                ...(genericEdgeMaximumShift === undefined
                                    ? {}
                                    : { genericEdgeMaximumShift }),
                                ...(corroboratedEdgeMaximumShift === undefined
                                    ? {}
                                    : { corroboratedEdgeMaximumShift }),
                            },
                        }) : null;
                    } finally {
                        stopObserving?.();
                    }
                })();
                if (timingEnabled) {
                    // eslint-disable-next-line no-console
                    console.log(
                        `ITRDB TIMING bundle label=${timingLabel} ms=${
                            Math.round(performance.now() - bundleStarted)
                        } events=${bundle?.events.length ?? 0}`,
                    );
                }
                const cofechaStarted = performance.now();
                const cofechaDiagnosis = (
                    usePiecewiseChangePoint
                    || collectWindowRankData
                    || collectRecoveryGateAudit
                    || (collectJointOperationAudit && !lightweight)
                    || collectTransitionScanAudit
                ) && site
                    ? diagnoseSeriesCore(
                        site,
                        target.id,
                        getConfig({ referenceConfig: null }),
                        cofechaBenchmarkPreprocess,
                    )
                    : null;
                if (timingEnabled) {
                    // eslint-disable-next-line no-console
                    console.log(
                        `ITRDB TIMING complete label=${timingLabel} totalMs=${
                            Math.round(performance.now() - runStarted)
                        } cofechaMs=${
                            Math.round(performance.now() - cofechaStarted)
                        }`,
                    );
                }
                (bundle?.events ?? []).forEach((event) => {
                    if (event.eventType === "partialMove") {
                        expect(event.shiftYears).toBeLessThan(0);
                    }
                });
                return {
                    events: bundle?.events ?? [],
                    diagnosis: bundle?.diagnosis ?? null,
                    cofechaDiagnosis,
                    site,
                    locatorAudits,
                };
            };
            // Establish the untouched-series stratum before collecting injected audits.
            // The previous late assignment made BASELINE_CLEAN_ONLY ineffective during
            // collection even though the serialized context looked correctly labelled.
            const partialGridOnly =
                process.env.ITRDB_PARTIAL_GRID_ONLY === "1";
            const unitEventsOnly =
                process.env.ITRDB_UNIT_EVENTS_ONLY === "1";
            const falseOnly = process.env.ITRDB_FALSE_ONLY === "1";
            const missingOnly = process.env.ITRDB_MISSING_ONLY === "1";
            const cleanRun = run(target.valuesByYear, partialGridOnly, "clean");
            const skippedRun: ReturnType<typeof run> = {
                events: [],
                diagnosis: null,
                cofechaDiagnosis: null,
                site: null,
                locatorAudits: [],
            };
            context.baselineEventCount = cleanRun.events.length;
            context.baselineFlagged = cleanRun.events.length > 0;
            partialContext.baselineEventCount = cleanRun.events.length;
            partialContext.baselineFlagged = cleanRun.events.length > 0;
            const missing = createEndAnchoredMissingRingCase(target, year);
            const missingTruth: TruthEvent = {
                id: `${target.id}-missing`,
                seriesId: target.id,
                eventType: "missingRing",
                year,
            };
            const missingRun = partialGridOnly || falseOnly
                ? skippedRun
                : run(missing.corrupted);
            if (collectCounterfactualLocatorAudit) {
                counterfactualLocatorCases.push(
                    ...missingRun.locatorAudits
                        .filter((row) => (
                            row.eventType === "missingRing"
                            && row.correctionYears === -1
                        ))
                        .map((row) => ({
                            context,
                            truthYear: year,
                            truthCorrectionYears: -1,
                            ...row,
                        })),
                );
            }
            auditTransitionScan(
                "missingRing",
                year,
                -1,
                context,
                missingRun,
            );
            collectRecoveryGateCase(
                "injected",
                "missingRing",
                year,
                -1,
                context,
                missingRun,
            );
            const missingPredictions = missingRun.events;
            recordReferenceRecoveries(
                "missingRing",
                files[fileIndex],
                target.id,
                year,
                missingPredictions,
            );
            if (usePairwise
                && missingPredictions.length === 0
                && missingRun.diagnosis
                && missingRun.site) {
                abstainedClassificationCases.push({
                    file: files[fileIndex].slice(ITRDB_DIR.length),
                    target: target.id,
                    truthEventType: "missingRing",
                    truthYear: year,
                    ...classifyAbstained(missingRun.diagnosis, missingRun.site),
                });
            }
            auditMissingRefinement(year, missingPredictions);
            const missingResult = add(
                aggregates.missingRing,
                missingTruth,
                missingPredictions,
                context,
            );
            auditFixedContext(
                "missingRing",
                files[fileIndex],
                target.id,
                year,
                -1,
                missingRun.diagnosis,
                missingResult.matchedCount > 0,
                missingPredictions,
            );
            auditFixedWindowCounterfactual(
                "missingRing",
                files[fileIndex],
                target.id,
                year,
                -1,
                missingRun.diagnosis,
                missingRun.site,
                missingPredictions,
                missingRun.locatorAudits,
            );
            collectWindowRankCase(
                "missingRing",
                year,
                undefined,
                context,
                missingRun,
            );
            auditPiecewiseChangePoint(
                "injected",
                files[fileIndex],
                target.id,
                "missingRing",
                year,
                -1,
                missingRun.diagnosis,
                missingRun.cofechaDiagnosis,
                missingResult.matchedCount > 0,
            );
            auditReferenceChangePoint(
                "injected",
                files[fileIndex],
                target.id,
                "missingRing",
                year,
                -1,
                missingRun.diagnosis,
                missingRun.site,
                missingResult.matchedCount > 0,
            );
            auditDirectTransition(
                "injected",
                files[fileIndex],
                target.id,
                "missingRing",
                year,
                undefined,
                missingRun.diagnosis,
                missingPredictions,
                missingResult.matchedCount > 0,
            );
            auditPairedBreakpoint(
                "injected",
                files[fileIndex],
                target.id,
                "missingRing",
                year,
                missingRun.diagnosis,
                missingRun.site,
                missingPredictions,
                missingResult.matchedCount > 0,
            );
            if (useExhaustive && missingRun.diagnosis) {
                const scores = scanExhaustiveUnitEdit(missingRun.diagnosis, "insert");
                tallyExhaustiveTopK("missingRing", scores, year, 3);
                const baseline = scoreExhaustiveSeries(
                    missingRun.diagnosis.rawTarget,
                    missingRun.diagnosis,
                );
                exhaustiveScoreNames.forEach((name) => {
                    const best = bestExhaustiveScore(scores, name);
                    tallyExhaustive(
                        "missingRing",
                        name,
                        missingResult.matchedCount > 0,
                        Boolean(best && Math.abs(best.year - year) <= 3),
                    );
                });
                const best = bestExhaustiveScore(scores, "difference");
                const current = missingPredictions
                    .filter((event) => event.eventType === "missingRing")
                    .sort((a, b) => b.evidence.score - a.evidence.score)[0];
                exhaustiveCases.push({
                    file: files[fileIndex].slice(ITRDB_DIR.length),
                    target: target.id,
                    eventType: "missingRing",
                    truthYear: year,
                    current: current ? {
                        range: [current.startYear, current.endYear],
                        topYear: current.rankedYears[0]?.year,
                        score: current.evidence.score,
                        margin: current.evidence.scoreMargin,
                        confidence: current.confidenceLevel,
                        sources: current.evidence.algorithmSources,
                    } : null,
                    currentHit: missingResult.matchedCount > 0,
                    peaks: exhaustivePeakAudit(scores, 3),
                    exhaustive: best ? {
                        year: best.year,
                        score: best.difference,
                        gain: best.difference - baseline.difference,
                        remoteMargin: exhaustiveRemoteMargin(scores, best, "difference", 7),
                        hit: Math.abs(best.year - year) <= 3,
                    } : null,
                });
                if (useLocalized) {
                    const localScores = scanLocalizedUnitEdit(missingRun.diagnosis, "insert");
                    localizedScoreNames.forEach((name) => {
                        const localBest = bestLocalizedScore(localScores, name);
                        if (localBest && Math.abs(localBest.year - year) <= 3) {
                            localizedHits.missingRing[name] += 1;
                        }
                    });
                }
                if (usePairwise && missingRun.site) {
                    const pairwiseScores = scanPairwiseUnitEdit(
                        missingRun.diagnosis,
                        missingRun.site,
                        "insert",
                    );
                    pairwiseScoreNames.forEach((name) => {
                        const pairwiseBest = bestPairwiseScore(pairwiseScores, name);
                        const pairwiseHit = Boolean(
                            pairwiseBest && Math.abs(pairwiseBest.year - year) <= 3,
                        );
                        tallyPairwise(
                            "missingRing",
                            name,
                            missingResult.matchedCount > 0,
                            Boolean(best && Math.abs(best.year - year) <= 3),
                            pairwiseHit,
                        );
                    });
                    const pairwiseBest = bestPairwiseScore(pairwiseScores, "differenceMean");
                    pairwiseCases.push({
                        file: files[fileIndex].slice(ITRDB_DIR.length),
                        target: target.id,
                        eventType: "missingRing",
                        truthYear: year,
                        current: current ? {
                            range: [current.startYear, current.endYear],
                            topYear: current.rankedYears[0]?.year,
                            score: current.evidence.score,
                            confidence: current.confidenceLevel,
                        } : null,
                        currentHit: missingResult.matchedCount > 0,
                        pairwise: pairwiseBest ? {
                            year: pairwiseBest.year,
                            score: pairwiseBest.differenceMean,
                            gain: pairwiseBest.differenceMeanGain,
                            remoteMargin: pairwiseRemoteMargin(
                                pairwiseScores,
                                pairwiseBest,
                                "differenceMean",
                                7,
                            ),
                            hit: Math.abs(pairwiseBest.year - year) <= 3,
                        } : null,
                    });
                }
            }
            if (!missingResult.completeCaseSuccess) failures.push({
                file: files[fileIndex].slice(ITRDB_DIR.length),
                target: target.id,
                eventType: "missingRing",
                truthYear: year,
                predictions: missingPredictions.map((event) => ({
                    type: event.eventType,
                    range: [event.startYear, event.endYear],
                    topYear: event.rankedYears[0]?.year,
                    lags: [event.evidence.lagBefore, event.evidence.lagAfter],
                    score: event.evidence.score,
                    margin: event.evidence.scoreMargin,
                    confidence: event.confidenceLevel,
                    sources: event.evidence.algorithmSources,
                    notes: event.evidence.notes,
                    locations: auditLocations(event),
                    operationAlternatives: auditOperationAlternatives(event),
                })),
            });

            const falseRing = createEndAnchoredFalseRingCase(
                target,
                year,
                (["average", "moderate", "splitLike"] as const)[fileIndex % 3],
            );
            const falseTruth: TruthEvent = {
                id: `${target.id}-false`,
                seriesId: target.id,
                eventType: "falseRing",
                year,
            };
            const falseRun = partialGridOnly || missingOnly
                ? skippedRun
                : run(falseRing.corrupted);
            if (collectCounterfactualLocatorAudit) {
                counterfactualLocatorCases.push(
                    ...falseRun.locatorAudits
                        .filter((row) => (
                            row.eventType === "falseRing"
                            && row.correctionYears === 1
                        ))
                        .map((row) => ({
                            context,
                            truthYear: year,
                            truthCorrectionYears: 1,
                            ...row,
                            falseRingMode: falseRing.mode,
                        })),
                );
            }
            auditTransitionScan(
                "falseRing",
                year,
                1,
                context,
                falseRun,
            );
            collectRecoveryGateCase(
                "injected",
                "falseRing",
                year,
                1,
                context,
                falseRun,
            );
            const falsePredictions = falseRun.events;
            recordReferenceRecoveries(
                "falseRing",
                files[fileIndex],
                target.id,
                year,
                falsePredictions,
            );
            if (usePairwise
                && falsePredictions.length === 0
                && falseRun.diagnosis
                && falseRun.site) {
                abstainedClassificationCases.push({
                    file: files[fileIndex].slice(ITRDB_DIR.length),
                    target: target.id,
                    truthEventType: "falseRing",
                    truthYear: year,
                    ...classifyAbstained(falseRun.diagnosis, falseRun.site),
                });
            }
            const falseResult = add(
                aggregates.falseRing,
                falseTruth,
                falsePredictions,
                context,
            );
            auditFixedContext(
                "falseRing",
                files[fileIndex],
                target.id,
                year,
                1,
                falseRun.diagnosis,
                falseResult.matchedCount > 0,
                falsePredictions,
            );
            auditFixedWindowCounterfactual(
                "falseRing",
                files[fileIndex],
                target.id,
                year,
                1,
                falseRun.diagnosis,
                falseRun.site,
                falsePredictions,
                falseRun.locatorAudits,
            );
            collectWindowRankCase(
                "falseRing",
                year,
                undefined,
                context,
                falseRun,
            );
            auditPiecewiseChangePoint(
                "injected",
                files[fileIndex],
                target.id,
                "falseRing",
                year,
                1,
                falseRun.diagnosis,
                falseRun.cofechaDiagnosis,
                falseResult.matchedCount > 0,
            );
            auditReferenceChangePoint(
                "injected",
                files[fileIndex],
                target.id,
                "falseRing",
                year,
                1,
                falseRun.diagnosis,
                falseRun.site,
                falseResult.matchedCount > 0,
            );
            auditDirectTransition(
                "injected",
                files[fileIndex],
                target.id,
                "falseRing",
                year,
                undefined,
                falseRun.diagnosis,
                falsePredictions,
                falseResult.matchedCount > 0,
            );
            auditPairedBreakpoint(
                "injected",
                files[fileIndex],
                target.id,
                "falseRing",
                year,
                falseRun.diagnosis,
                falseRun.site,
                falsePredictions,
                falseResult.matchedCount > 0,
            );
            if (useExhaustive && falseRun.diagnosis) {
                const scores = scanExhaustiveUnitEdit(falseRun.diagnosis, "delete");
                tallyExhaustiveTopK("falseRing", scores, year, 3);
                const baseline = scoreExhaustiveSeries(
                    falseRun.diagnosis.rawTarget,
                    falseRun.diagnosis,
                );
                exhaustiveScoreNames.forEach((name) => {
                    const best = bestExhaustiveScore(scores, name);
                    tallyExhaustive(
                        "falseRing",
                        name,
                        falseResult.matchedCount > 0,
                        Boolean(best && Math.abs(best.year - year) <= 3),
                    );
                });
                const best = bestExhaustiveScore(scores, "difference");
                const current = falsePredictions
                    .filter((event) => event.eventType === "falseRing")
                    .sort((a, b) => b.evidence.score - a.evidence.score)[0];
                exhaustiveCases.push({
                    file: files[fileIndex].slice(ITRDB_DIR.length),
                    target: target.id,
                    eventType: "falseRing",
                    mode: falseRing.mode,
                    truthYear: year,
                    current: current ? {
                        range: [current.startYear, current.endYear],
                        topYear: current.rankedYears[0]?.year,
                        score: current.evidence.score,
                        margin: current.evidence.scoreMargin,
                        confidence: current.confidenceLevel,
                        sources: current.evidence.algorithmSources,
                    } : null,
                    currentHit: falseResult.matchedCount > 0,
                    peaks: exhaustivePeakAudit(scores, 3),
                    exhaustive: best ? {
                        year: best.year,
                        score: best.difference,
                        gain: best.difference - baseline.difference,
                        remoteMargin: exhaustiveRemoteMargin(scores, best, "difference", 7),
                        hit: Math.abs(best.year - year) <= 3,
                    } : null,
                });
                if (useLocalized) {
                    const localScores = scanLocalizedUnitEdit(falseRun.diagnosis, "delete");
                    localizedScoreNames.forEach((name) => {
                        const localBest = bestLocalizedScore(localScores, name);
                        if (localBest && Math.abs(localBest.year - year) <= 3) {
                            localizedHits.falseRing[name] += 1;
                        }
                    });
                }
                if (usePairwise && falseRun.site) {
                    const pairwiseScores = scanPairwiseUnitEdit(
                        falseRun.diagnosis,
                        falseRun.site,
                        "delete",
                    );
                    pairwiseScoreNames.forEach((name) => {
                        const pairwiseBest = bestPairwiseScore(pairwiseScores, name);
                        const pairwiseHit = Boolean(
                            pairwiseBest && Math.abs(pairwiseBest.year - year) <= 3,
                        );
                        tallyPairwise(
                            "falseRing",
                            name,
                            falseResult.matchedCount > 0,
                            Boolean(best && Math.abs(best.year - year) <= 3),
                            pairwiseHit,
                        );
                    });
                    const pairwiseBest = bestPairwiseScore(pairwiseScores, "whitenedMedian");
                    pairwiseCases.push({
                        file: files[fileIndex].slice(ITRDB_DIR.length),
                        target: target.id,
                        eventType: "falseRing",
                        mode: falseRing.mode,
                        truthYear: year,
                        current: current ? {
                            range: [current.startYear, current.endYear],
                            topYear: current.rankedYears[0]?.year,
                            score: current.evidence.score,
                            confidence: current.confidenceLevel,
                        } : null,
                        currentHit: falseResult.matchedCount > 0,
                        pairwise: pairwiseBest ? {
                            year: pairwiseBest.year,
                            score: pairwiseBest.whitenedMedian,
                            gain: pairwiseBest.whitenedMedianGain,
                            remoteMargin: pairwiseRemoteMargin(
                                pairwiseScores,
                                pairwiseBest,
                                "whitenedMedian",
                                7,
                            ),
                            hit: Math.abs(pairwiseBest.year - year) <= 3,
                        } : null,
                    });
                }
            }
            if (!falseResult.completeCaseSuccess) failures.push({
                file: files[fileIndex].slice(ITRDB_DIR.length),
                target: target.id,
                eventType: "falseRing",
                mode: falseRing.mode,
                truthYear: year,
                predictions: falsePredictions.map((event) => ({
                    type: event.eventType,
                    alternativeTypes: event.alternativeTypes,
                    range: [event.startYear, event.endYear],
                    topYear: event.rankedYears[0]?.year,
                    lags: [event.evidence.lagBefore, event.evidence.lagAfter],
                    score: event.evidence.score,
                    margin: event.evidence.scoreMargin,
                    confidence: event.confidenceLevel,
                    sources: event.evidence.algorithmSources,
                    notes: event.evidence.notes,
                    locations: auditLocations(event),
                    operationAlternatives: auditOperationAlternatives(event),
                })),
            });

            if (!unitEventsOnly && !skipPartialTruth) {
            const year = partialSelection.year;
            const context = partialContext;
            const partial = createPartialRangeMoveCase(target, year, injectedShift);
            const partialTruth: TruthEvent = {
                id: `${target.id}-partial`,
                seriesId: target.id,
                eventType: "partialMove",
                year,
                shiftYears: -injectedShift,
                shiftSide: "older",
            };
            const partialRun = run(partial.corrupted, false, "partialMove");
            if (collectCounterfactualLocatorAudit) {
                counterfactualLocatorCases.push(
                    ...partialRun.locatorAudits
                        .filter((row) => (
                            row.eventType === "partialMove"
                            && row.correctionYears === -injectedShift
                        ))
                        .map((row) => ({
                            context,
                            truthYear: year,
                            truthCorrectionYears: -injectedShift,
                            ...row,
                        })),
                );
            }
            auditTransitionScan(
                "partialMove",
                year,
                -injectedShift,
                context,
                partialRun,
            );
            collectRecoveryGateCase(
                "injected",
                "partialMove",
                year,
                -injectedShift,
                context,
                partialRun,
            );
            const partialPredictions = partialRun.events;
            recordReferenceRecoveries(
                "partialMove",
                files[fileIndex],
                target.id,
                year,
                partialPredictions,
            );
            if (usePairwise
                && partialPredictions.length === 0
                && partialRun.diagnosis
                && partialRun.site) {
                abstainedClassificationCases.push({
                    file: files[fileIndex].slice(ITRDB_DIR.length),
                    target: target.id,
                    truthEventType: "partialMove",
                    truthYear: year,
                    truthShiftYears: -injectedShift,
                    ...classifyAbstained(partialRun.diagnosis, partialRun.site),
                });
            }
            const partialResult = add(
                aggregates.partialMove,
                partialTruth,
                partialPredictions,
                context,
            );
            auditFixedContext(
                "partialMove",
                files[fileIndex],
                target.id,
                year,
                -injectedShift,
                partialRun.diagnosis,
                partialResult.matchedCount > 0,
                partialPredictions,
            );
            auditFixedWindowCounterfactual(
                "partialMove",
                files[fileIndex],
                target.id,
                year,
                -injectedShift,
                partialRun.diagnosis,
                partialRun.site,
                partialPredictions,
                partialRun.locatorAudits,
            );
            collectWindowRankCase(
                "partialMove",
                year,
                -injectedShift,
                context,
                partialRun,
            );
            auditPiecewiseChangePoint(
                "injected",
                files[fileIndex],
                target.id,
                "partialMove",
                year,
                -injectedShift,
                partialRun.diagnosis,
                partialRun.cofechaDiagnosis,
                partialResult.matchedCount > 0,
            );
            auditReferenceChangePoint(
                "injected",
                files[fileIndex],
                target.id,
                "partialMove",
                year,
                -injectedShift,
                partialRun.diagnosis,
                partialRun.site,
                partialResult.matchedCount > 0,
            );
            auditDirectTransition(
                "injected",
                files[fileIndex],
                target.id,
                "partialMove",
                year,
                -injectedShift,
                partialRun.diagnosis,
                partialPredictions,
                partialResult.matchedCount > 0,
            );
            if (useExhaustive && partialRun.diagnosis) {
                const scores = scanExhaustivePartialMove(partialRun.diagnosis);
                tallyExhaustiveTopK(
                    "partialMove",
                    scores,
                    year,
                    4,
                    -injectedShift,
                );
                const baseline = scoreExhaustiveSeries(
                    partialRun.diagnosis.rawTarget,
                    partialRun.diagnosis,
                );
                exhaustiveScoreNames.forEach((name) => {
                    const best = bestExhaustiveScore(scores, name);
                    const exhaustiveHit = Boolean(best
                        && Math.abs(best.year - year) <= 4
                        && best.shiftYears === -injectedShift);
                    tallyExhaustive(
                        "partialMove",
                        name,
                        partialResult.matchedCount > 0,
                        exhaustiveHit,
                    );
                });
                const best = bestExhaustiveScore(scores, "difference");
                const current = partialPredictions
                    .filter((event) => event.eventType === "partialMove")
                    .sort((a, b) => b.evidence.score - a.evidence.score)[0];
                exhaustiveCases.push({
                    file: files[fileIndex].slice(ITRDB_DIR.length),
                    target: target.id,
                    eventType: "partialMove",
                    truthYear: year,
                    truthShiftYears: -injectedShift,
                    current: current ? {
                        range: [current.startYear, current.endYear],
                        topYear: current.rankedYears[0]?.year,
                        shiftYears: current.shiftYears,
                        score: current.evidence.score,
                        margin: current.evidence.scoreMargin,
                        confidence: current.confidenceLevel,
                        sources: current.evidence.algorithmSources,
                    } : null,
                    currentHit: partialResult.matchedCount > 0,
                    peaks: exhaustivePeakAudit(scores, 4, -injectedShift),
                    exhaustive: best ? {
                        year: best.year,
                        shiftYears: best.shiftYears,
                        score: best.difference,
                        gain: best.difference - baseline.difference,
                        remoteMargin: exhaustiveRemoteMargin(scores, best, "difference", 9),
                        hit: Math.abs(best.year - year) <= 4
                            && best.shiftYears === -injectedShift,
                    } : null,
                });
                if (useLocalized) {
                    const localScores = scanLocalizedPartialMove(partialRun.diagnosis);
                    localizedScoreNames.forEach((name) => {
                        const localBest = bestLocalizedScore(localScores, name);
                        if (localBest
                            && Math.abs(localBest.year - year) <= 4
                            && localBest.shiftYears === -injectedShift) {
                            localizedHits.partialMove[name] += 1;
                        }
                    });
                }
                if (usePairwise && partialRun.site) {
                    const pairwiseScores = scanPairwisePartialMove(
                        partialRun.diagnosis,
                        partialRun.site,
                    );
                    pairwiseScoreNames.forEach((name) => {
                        const pairwiseBest = bestPairwiseScore(pairwiseScores, name);
                        const pairwiseHit = Boolean(pairwiseBest
                            && Math.abs(pairwiseBest.year - year) <= 4
                            && pairwiseBest.shiftYears === -injectedShift);
                        tallyPairwise(
                            "partialMove",
                            name,
                            partialResult.matchedCount > 0,
                            Boolean(best
                                && Math.abs(best.year - year) <= 4
                                && best.shiftYears === -injectedShift),
                            pairwiseHit,
                        );
                    });
                    const pairwiseBest = bestPairwiseScore(pairwiseScores, "differenceTrimmed");
                    pairwiseCases.push({
                        file: files[fileIndex].slice(ITRDB_DIR.length),
                        target: target.id,
                        eventType: "partialMove",
                        truthYear: year,
                        truthShiftYears: -injectedShift,
                        current: current ? {
                            range: [current.startYear, current.endYear],
                            topYear: current.rankedYears[0]?.year,
                            shiftYears: current.shiftYears,
                            score: current.evidence.score,
                            confidence: current.confidenceLevel,
                        } : null,
                        currentHit: partialResult.matchedCount > 0,
                        pairwise: pairwiseBest ? {
                            year: pairwiseBest.year,
                            shiftYears: pairwiseBest.shiftYears,
                            score: pairwiseBest.differenceTrimmed,
                            gain: pairwiseBest.differenceTrimmedGain,
                            remoteMargin: pairwiseRemoteMargin(
                                pairwiseScores,
                                pairwiseBest,
                                "differenceTrimmed",
                                9,
                            ),
                            hit: Math.abs(pairwiseBest.year - year) <= 4
                                && pairwiseBest.shiftYears === -injectedShift,
                        } : null,
                        exhaustive: best ? {
                            year: best.year,
                            shiftYears: best.shiftYears,
                            gain: best.difference - baseline.difference,
                            remoteMargin: exhaustiveRemoteMargin(
                                scores,
                                best,
                                "difference",
                                9,
                            ),
                            hit: Math.abs(best.year - year) <= 4
                                && best.shiftYears === -injectedShift,
                        } : null,
                    });
                }
            }
            if (!partialResult.completeCaseSuccess) failures.push({
                file: files[fileIndex].slice(ITRDB_DIR.length),
                target: target.id,
                eventType: "partialMove",
                injectedShift,
                truthYear: year,
                predictions: partialPredictions.map((event) => ({
                    type: event.eventType,
                    range: [event.startYear, event.endYear],
                    topYear: event.rankedYears[0]?.year,
                    shiftYears: event.shiftYears,
                    shiftSide: event.shiftSide,
                    lags: [event.evidence.lagBefore, event.evidence.lagAfter],
                    score: event.evidence.score,
                    margin: event.evidence.scoreMargin,
                    confidence: event.confidenceLevel,
                    sources: event.evidence.algorithmSources,
                    notes: event.evidence.notes,
                    locations: auditLocations(event),
                    operationAlternatives: auditOperationAlternatives(event),
                })),
            });
            }

            collectRecoveryGateCase(
                "clean",
                null,
                null,
                null,
                context,
                cleanRun,
            );
            const cleanPredictions = cleanRun.events;
            auditFixedContextClean(files[fileIndex], target.id, cleanRun.diagnosis);
            if (collectPairedPulseLocalizedAudit && cleanRun.diagnosis && cleanRun.site) {
                const pulseEvent = cleanPredictions.find((event) => (
                    event.evidence.algorithmSources.includes("bounded_lag_pulse")
                ));
                const orientationNote = pulseEvent?.evidence.notes.find((note) => (
                    note.startsWith("reference_pair_orientation=")
                ));
                const yearsNote = pulseEvent?.evidence.notes.find((note) => (
                    note.startsWith("reference_pair_years=")
                ));
                const orientation = orientationNote?.slice(
                    "reference_pair_orientation=".length,
                );
                const years = yearsNote?.slice("reference_pair_years=".length)
                    .split("-")
                    .map(Number);
                if ((orientation === "missingThenFalse" || orientation === "falseThenMissing")
                    && years?.length === 2
                    && years.every(Number.isFinite)) {
                    const vote = voteForAdjacentUnitPairLocalized(
                        cleanRun.diagnosis,
                        cleanRun.site,
                        {
                            orientation,
                            olderYear: years[0],
                            newerYear: years[1],
                            maximumDistance: 4,
                        },
                    );
                    pairedPulseLocalizedAudit.push({
                        file: files[fileIndex].slice(ITRDB_DIR.length),
                        target: target.id,
                        orientation,
                        hintedYears: years,
                        vote: vote ? {
                            olderYear: vote.olderYear,
                            newerYear: vote.newerYear,
                            gain: vote.gain,
                            remoteMargin: vote.remoteMargin,
                            referenceCount: vote.referenceCount,
                            positiveReferenceFraction: vote.positiveReferenceFraction,
                            medianReferenceGain: vote.medianReferenceGain,
                            lowerQuartileReferenceGain: vote.lowerQuartileReferenceGain,
                            masterRemoteMargin: vote.masterRemoteMargin,
                        } : null,
                    });
                }
            }
            auditPiecewiseChangePoint(
                "clean",
                files[fileIndex],
                target.id,
                "missingRing",
                null,
                -1,
                cleanRun.diagnosis,
                cleanRun.cofechaDiagnosis,
                false,
            );
            auditReferenceChangePoint(
                "clean",
                files[fileIndex],
                target.id,
                "missingRing",
                null,
                -1,
                cleanRun.diagnosis,
                cleanRun.site,
                false,
            );
            auditPiecewiseChangePoint(
                "clean",
                files[fileIndex],
                target.id,
                "falseRing",
                null,
                1,
                cleanRun.diagnosis,
                cleanRun.cofechaDiagnosis,
                false,
            );
            auditReferenceChangePoint(
                "clean",
                files[fileIndex],
                target.id,
                "falseRing",
                null,
                1,
                cleanRun.diagnosis,
                cleanRun.site,
                false,
            );
            auditPiecewiseChangePoint(
                "clean",
                files[fileIndex],
                target.id,
                "partialMove",
                null,
                -injectedShift,
                cleanRun.diagnosis,
                cleanRun.cofechaDiagnosis,
                false,
            );
            auditReferenceChangePoint(
                "clean",
                files[fileIndex],
                target.id,
                "partialMove",
                null,
                -injectedShift,
                cleanRun.diagnosis,
                cleanRun.site,
                false,
            );
            (["missingRing", "falseRing", "partialMove"] as const).forEach((eventType) => {
                auditDirectTransition(
                    "clean",
                    files[fileIndex],
                    target.id,
                    eventType,
                    null,
                    undefined,
                    cleanRun.diagnosis,
                    cleanPredictions,
                    false,
                );
            });
            (["missingRing", "falseRing"] as const).forEach((eventType) => {
                auditPairedBreakpoint(
                    "clean",
                    files[fileIndex],
                    target.id,
                    eventType,
                    null,
                    cleanRun.diagnosis,
                    cleanRun.site,
                    cleanPredictions,
                    false,
                );
            });
            recordReferenceRecoveries(
                "clean",
                files[fileIndex],
                target.id,
                null,
                cleanPredictions,
            );
            if (usePairwiseClean && cleanRun.diagnosis && cleanRun.site) {
                const missingScores = scanPairwiseUnitEdit(
                    cleanRun.diagnosis,
                    cleanRun.site,
                    "insert",
                );
                const falseScores = scanPairwiseUnitEdit(
                    cleanRun.diagnosis,
                    cleanRun.site,
                    "delete",
                );
                const partialScores = scanPairwisePartialMove(
                    cleanRun.diagnosis,
                    cleanRun.site,
                );
                const missingBest = bestPairwiseScore(missingScores, "differenceMean");
                const falseBest = bestPairwiseScore(falseScores, "whitenedMedian");
                const partialBest = bestPairwiseScore(partialScores, "differenceTrimmed");
                cleanPairwiseCases.push({
                    file: files[fileIndex].slice(ITRDB_DIR.length),
                    target: target.id,
                    productionEvents: cleanPredictions.length,
                    missing: missingBest ? {
                        year: missingBest.year,
                        score: missingBest.differenceMean,
                        gain: missingBest.differenceMeanGain,
                        remoteMargin: pairwiseRemoteMargin(
                            missingScores,
                            missingBest,
                            "differenceMean",
                            7,
                        ),
                    } : null,
                    falseRing: falseBest ? {
                        year: falseBest.year,
                        score: falseBest.whitenedMedian,
                        gain: falseBest.whitenedMedianGain,
                        remoteMargin: pairwiseRemoteMargin(
                            falseScores,
                            falseBest,
                            "whitenedMedian",
                            7,
                        ),
                    } : null,
                    partialMove: partialBest ? {
                        year: partialBest.year,
                        shiftYears: partialBest.shiftYears,
                        score: partialBest.differenceTrimmed,
                        gain: partialBest.differenceTrimmedGain,
                        remoteMargin: pairwiseRemoteMargin(
                            partialScores,
                            partialBest,
                            "differenceTrimmed",
                            9,
                        ),
                    } : null,
                });
            }
            cleanCases += 1;
            cleanCaseOutcomes.push({
                context,
                falsePositive: cleanPredictions.length > 0,
                predictions: cleanPredictions.length,
            });
            if (cleanPredictions.length > 0) {
                cleanFalsePositives += 1;
                failures.push({
                    file: files[fileIndex].slice(ITRDB_DIR.length),
                    target: target.id,
                    eventType: "clean",
                    predictions: cleanPredictions.map((event) => ({
                        type: event.eventType,
                        range: [event.startYear, event.endYear],
                        topYear: event.rankedYears[0]?.year,
                        lags: [event.evidence.lagBefore, event.evidence.lagAfter],
                        score: event.evidence.score,
                        sources: event.evidence.algorithmSources,
                        notes: event.evidence.notes,
                    })),
                });
            }
            attempted += 1;
        }

        const summarize = (aggregate: Aggregate) => ({
            cases: aggregate.cases,
            responseRate: aggregate.answered / Math.max(1, aggregate.cases),
            abstentionRate: 1 - aggregate.answered / Math.max(1, aggregate.cases),
            recall: aggregate.matched / Math.max(1, aggregate.cases),
            primaryWindowRecall: aggregate.primaryMatched / Math.max(1, aggregate.cases),
            alternativeRecoveryRate: aggregate.alternativeRecovered
                / Math.max(1, aggregate.cases),
            alternativeRecoveryShare: aggregate.alternativeRecovered
                / Math.max(1, aggregate.matched),
            precision: aggregate.matched / Math.max(1, aggregate.predictions),
            complete: aggregate.complete / Math.max(1, aggregate.cases),
            selectableRecall: aggregate.selectableMatched
                / Math.max(1, aggregate.cases),
            selectableComplete: aggregate.selectableComplete
                / Math.max(1, aggregate.cases),
            operationAlternativeRecoveryRate:
                aggregate.operationAlternativeRecovered
                / Math.max(1, aggregate.cases),
            operationAccuracy: aggregate.operationMatched
                / Math.max(1, aggregate.cases),
            selectableOperationAccuracy: aggregate.selectableOperationMatched
                / Math.max(1, aggregate.cases),
            operationRecoveryApplyRate: aggregate.operationRecoveryApplied
                / Math.max(1, aggregate.cases),
            multiplePredictionRate: aggregate.multiplePredictionCases
                / Math.max(1, aggregate.cases),
            predictions: aggregate.predictions,
            medianWidth: median(aggregate.widths),
            medianTruthRank: median(aggregate.ranks),
            locationRankHistogram: Object.fromEntries(
                Array.from(new Set(aggregate.locationRanks))
                    .sort((a, b) => a - b)
                    .map((rank) => [
                        rank,
                        aggregate.locationRanks.filter((value) => value === rank).length,
                    ]),
            ),
            primaryTop1ExactAll: aggregate.top1Exact / Math.max(1, aggregate.cases),
            primaryTop1ExactCovered: aggregate.top1Exact
                / Math.max(1, aggregate.primaryMatched),
            primaryTop1WithinOneAll: aggregate.top1WithinOne / Math.max(1, aggregate.cases),
            primaryTop1WithinOneCovered: aggregate.top1WithinOne
                / Math.max(1, aggregate.primaryMatched),
            selectedTop1ExactAll: aggregate.selectedTop1Exact / Math.max(1, aggregate.cases),
            selectedTop1ExactCovered: aggregate.selectedTop1Exact
                / Math.max(1, aggregate.matched),
            selectedTop1WithinOneAll: aggregate.selectedTop1WithinOne
                / Math.max(1, aggregate.cases),
            selectedTop1WithinOneCovered: aggregate.selectedTop1WithinOne
                / Math.max(1, aggregate.matched),
            top1ExactCovered: aggregate.top1Exact / Math.max(1, aggregate.primaryMatched),
            top1WithinOneCovered: aggregate.top1WithinOne
                / Math.max(1, aggregate.primaryMatched),
            medianTopYearError: median(aggregate.topYearErrors),
            medianSelectedTopYearError: median(aggregate.selectedTopYearErrors),
            topYearErrorHistogram: Object.fromEntries(
                Array.from(new Set(aggregate.topYearErrors))
                    .sort((a, b) => a - b)
                    .map((error) => [
                        error,
                        aggregate.topYearErrors.filter((value) => value === error).length,
                    ]),
            ),
            selectedTopYearErrorHistogram: Object.fromEntries(
                Array.from(new Set(aggregate.selectedTopYearErrors))
                    .sort((a, b) => a - b)
                    .map((error) => [
                        error,
                        aggregate.selectedTopYearErrors.filter((value) => value === error).length,
                    ]),
            ),
        });
        const cleanFalsePositiveRate =
            cleanFalsePositives / Math.max(1, cleanCases);
        const summarizePartialMoveByShift = (
            include: (row: EventCaseOutcome) => boolean,
        ) => Object.fromEntries(
            partialGapYears.map((gapYears) => -gapYears).map((truthShiftYears) => {
                const rows = eventCaseOutcomes.filter((row) => (
                    row.eventType === "partialMove"
                    && row.truthShiftYears === truthShiftYears
                    && include(row)
                ));
                const answered = rows.filter((row) => row.answered);
                const shiftCorrect = rows.filter((row) => (
                    row.primaryPredictionShiftYears === truthShiftYears
                ));
                const windowCovered = shiftCorrect.filter((row) => (
                    row.primaryPredictionRange !== null
                    && row.context.year >= row.primaryPredictionRange[0]
                    && row.context.year <= row.primaryPredictionRange[1]
                ));
                const top1 = shiftCorrect.filter((row) => (
                    row.primaryPredictionTopYear === row.context.year
                ));
                const widths = rows.flatMap((row) => (
                    row.primaryPredictionRange
                        ? [
                            row.primaryPredictionRange[1]
                            - row.primaryPredictionRange[0]
                            + 1,
                        ]
                        : []
                ));
                return [String(truthShiftYears), {
                    cases: rows.length,
                    answered: answered.length,
                    responseRate: answered.length / Math.max(1, rows.length),
                    abstentionRate:
                        1 - answered.length / Math.max(1, rows.length),
                    shiftAccuracyAll:
                        shiftCorrect.length / Math.max(1, rows.length),
                    shiftAccuracyAnswered:
                        shiftCorrect.length / Math.max(1, answered.length),
                    breakpointWindowCoverageAll:
                        windowCovered.length / Math.max(1, rows.length),
                    breakpointWindowCoverageAnswered:
                        windowCovered.length / Math.max(1, answered.length),
                    top1All: top1.length / Math.max(1, rows.length),
                    top1Covered:
                        top1.length / Math.max(1, windowCovered.length),
                    medianMainWindowWidth: median(widths),
                }];
            }),
        );
        const partialMoveByShift = summarizePartialMoveByShift(() => true);
        const baselineCleanPartialMoveByShift =
            summarizePartialMoveByShift(
                (row) => row.context.baselineFlagged === false,
            );
        const positionStrata: BenchmarkPositionStratum[] = [
            "olderEdge",
            "olderInterior",
            "middle",
            "newerInterior",
            "newerEdge",
        ];
        type SignalStratum = "weak" | "medium" | "strong" | "unavailable";
        const signalValues = caseContexts
            .map((context) => context.signalStrength)
            .filter((value): value is number => value !== null && Number.isFinite(value))
            .sort((a, b) => a - b);
        const valueAtQuantile = (values: number[], probability: number): number | null => {
            if (values.length === 0) return null;
            return values[Math.min(
                values.length - 1,
                Math.floor((values.length - 1) * probability),
            )];
        };
        const signalThresholds = {
            weakMaximum: valueAtQuantile(signalValues, 1 / 3),
            mediumMaximum: valueAtQuantile(signalValues, 2 / 3),
        };
        const signalStratumFor = (context: BenchmarkCaseContext): SignalStratum => {
            const signal = context.signalStrength;
            if (signal === null
                || signalThresholds.weakMaximum === null
                || signalThresholds.mediumMaximum === null) {
                return "unavailable";
            }
            if (signal <= signalThresholds.weakMaximum) return "weak";
            if (signal <= signalThresholds.mediumMaximum) return "medium";
            return "strong";
        };
        const summarizeOutcomeRows = (rows: EventCaseOutcome[]) => {
            const respondedRows = rows.filter((row) => row.systemResponded);
            const answeredRows = rows.filter((row) => row.answered);
            const matchedRows = rows.filter((row) => row.matched);
            const primaryMatchedRows = rows.filter((row) => row.primaryMatched);
            const operationMatchedRows = rows.filter((row) => row.operationMatched);
            const alternativeRecoveredRows = rows.filter((row) => (
                row.locationRank !== null && row.locationRank > 0
            ));
            const predictionCount = rows.reduce((sum, row) => sum + row.predictions, 0);
            const primaryTruthRanks = primaryMatchedRows
                .map((row) => row.primaryTruthRank)
                .filter((rank): rank is number => rank !== null);
            const primaryTopYearCenterOffsets = answeredRows
                .map((row) => row.primaryTopYearCenterOffset)
                .filter((offset): offset is number => offset !== null);
            const widths = rows
                .map((row) => row.width)
                .filter((width): width is number => width !== null);
            return {
                cases: rows.length,
                responded: respondedRows.length,
                answered: answeredRows.length,
                responseRate: respondedRows.length / Math.max(1, rows.length),
                abstentionRate: 1 - respondedRows.length / Math.max(1, rows.length),
                typedResponseRate: answeredRows.length / Math.max(1, rows.length),
                recall: matchedRows.length / Math.max(1, rows.length),
                primaryWindowRecall: primaryMatchedRows.length / Math.max(1, rows.length),
                conditionalPrimaryWindowCoverage: primaryMatchedRows.length
                    / Math.max(1, operationMatchedRows.length),
                alternativeRecoveryRate: alternativeRecoveredRows.length
                    / Math.max(1, rows.length),
                precision: matchedRows.length / Math.max(1, predictionCount),
                complete: rows.filter((row) => row.complete).length / Math.max(1, rows.length),
                completeAnswered: rows.filter((row) => row.complete).length
                    / Math.max(1, answeredRows.length),
                operationAccuracy: rows.filter((row) => row.operationMatched).length
                    / Math.max(1, rows.length),
                operationAccuracyAnswered: operationMatchedRows.length
                    / Math.max(1, respondedRows.length),
                partialMoveMisclassificationRate: rows.filter(
                    (row) => row.partialMoveMisclassification,
                ).length / Math.max(1, rows.length),
                selectableOperationAccuracy: rows
                    .filter((row) => row.selectableOperationMatched).length
                    / Math.max(1, rows.length),
                operationRecoveryApplyRate: rows
                    .filter((row) => row.operationRecoveryApplied).length
                    / Math.max(1, rows.length),
                multiplePredictionRate: rows.filter((row) => row.totalPredictions > 1).length
                    / Math.max(1, rows.length),
                predictions: predictionCount,
                medianWidth: median(widths),
                p90Width: percentile(widths, 0.9),
                widthHistogram: Object.fromEntries(
                    Array.from(new Set(rows
                        .map((row) => row.width)
                        .filter((width): width is number => width !== null)))
                        .sort((left, right) => left - right)
                        .map((width) => [
                            width,
                            rows.filter((row) => row.width === width).length,
                        ]),
                ),
                primaryTop1ExactAll: primaryMatchedRows.filter((row) => row.top1Exact).length
                    / Math.max(1, rows.length),
                primaryTop1ExactCovered: primaryMatchedRows.filter((row) => row.top1Exact).length
                    / Math.max(1, primaryMatchedRows.length),
                selectedTop1ExactAll: matchedRows.filter((row) => row.selectedTop1Exact).length
                    / Math.max(1, rows.length),
                selectedTop1ExactCovered: matchedRows.filter((row) => row.selectedTop1Exact).length
                    / Math.max(1, matchedRows.length),
                primaryTop1WithinOneAll: primaryMatchedRows
                    .filter((row) => row.top1WithinOne).length / Math.max(1, rows.length),
                primaryTop1WithinOneCovered: primaryMatchedRows
                    .filter((row) => row.top1WithinOne).length
                    / Math.max(1, primaryMatchedRows.length),
                primaryTop3All: primaryTruthRanks.filter((rank) => rank <= 3).length
                    / Math.max(1, rows.length),
                primaryTop3Covered: primaryTruthRanks.filter((rank) => rank <= 3).length
                    / Math.max(1, primaryMatchedRows.length),
                primaryMedianTruthRankCovered: median(primaryTruthRanks),
                primaryMrrAll: primaryTruthRanks.reduce(
                    (sum, rank) => sum + 1 / rank,
                    0,
                ) / Math.max(1, rows.length),
                primaryMrrCovered: primaryTruthRanks.reduce(
                    (sum, rank) => sum + 1 / rank,
                    0,
                ) / Math.max(1, primaryMatchedRows.length),
                primaryMeanTopYearCenterOffset: primaryTopYearCenterOffsets.reduce(
                    (sum, offset) => sum + offset,
                    0,
                ) / Math.max(1, primaryTopYearCenterOffsets.length),
                selectedTop1WithinOneAll: matchedRows
                    .filter((row) => row.selectedTop1WithinOne).length
                    / Math.max(1, rows.length),
                selectedTop1WithinOneCovered: matchedRows
                    .filter((row) => row.selectedTop1WithinOne).length
                    / Math.max(1, matchedRows.length),
            };
        };
        const summarizeCleanRows = (rows: CleanCaseOutcome[]) => ({
            cases: rows.length,
            falsePositiveRate: rows.filter((row) => row.falsePositive).length
                / Math.max(1, rows.length),
            predictions: rows.reduce((sum, row) => sum + row.predictions, 0),
        });
        const baselineCleanContexts = caseContexts.filter(
            (context) => context.baselineFlagged === false,
        );
        const baselineCleanEventOutcomes = eventCaseOutcomes.filter(
            (row) => row.context.baselineFlagged === false,
        );
        const baselineCleanCleanOutcomes = cleanCaseOutcomes.filter(
            (row) => row.context.baselineFlagged === false,
        );
        const formalEventSummary = (eventType: EventCaseOutcome["eventType"]) => (
            summarizeOutcomeRows(baselineCleanEventOutcomes.filter(
                (row) => row.eventType === eventType,
            ))
        );
        const formalCleanSummary = summarizeCleanRows(baselineCleanCleanOutcomes);
        const allSampledAuditSummary = {
            attempted,
            missingRing: summarize(aggregates.missingRing),
            falseRing: summarize(aggregates.falseRing),
            partialMove: summarize(aggregates.partialMove),
            partialMoveByShift,
            clean: {
                cases: cleanCases,
                falsePositiveRate: cleanFalsePositiveRate,
            },
        };
        const eventTypes: EventCaseOutcome["eventType"][] = [
            "missingRing",
            "falseRing",
            "partialMove",
        ];
        const summarizeStratum = (
            contextPredicate: (context: BenchmarkCaseContext) => boolean,
        ) => ({
            cases: caseContexts.filter(contextPredicate).length,
            events: Object.fromEntries(eventTypes.map((eventType) => [
                eventType,
                summarizeOutcomeRows(eventCaseOutcomes.filter((row) => (
                    row.eventType === eventType && contextPredicate(row.context)
                ))),
            ])),
            clean: summarizeCleanRows(cleanCaseOutcomes.filter((row) => (
                contextPredicate(row.context)
            ))),
        });
        const signalStrata: SignalStratum[] = [
            "weak",
            "medium",
            "strong",
            "unavailable",
        ];
        const datasetGroups = Array.from(new Set(
            caseContexts.map((context) => context.datasetGroup),
        )).sort();
        const endpointStratumFor = (context: BenchmarkCaseContext) => {
            if (context.newerContextYears <= 14) return "newer_2_14";
            if (context.newerContextYears <= 29) return "newer_15_29";
            if (context.olderContextYears <= 29) return "older_14_29";
            return "interior_30_plus";
        };
        const stratifiedBenchmarkSummary = {
            selection: {
                method: "value-independent deterministic five-stratum calendar sampling",
                minimumContextYears,
                minimumOlderContextYears,
                minimumNewerContextYears,
                selectedCases: caseContexts.length,
                normalizedPositionRange: caseContexts.length > 0
                    ? [
                        Math.min(...caseContexts.map((context) => context.normalizedPosition)),
                        Math.max(...caseContexts.map((context) => context.normalizedPosition)),
                    ]
                    : null,
            },
            signal: {
                metric: "31-year local Pearson correlation measured only after year selection",
                thresholds: signalThresholds,
                availableCases: signalValues.length,
            },
            byPosition: Object.fromEntries(positionStrata.map((stratum) => [
                stratum,
                summarizeStratum((context) => context.positionStratum === stratum),
            ])),
            bySignal: Object.fromEntries(signalStrata.map((stratum) => [
                stratum,
                summarizeStratum((context) => signalStratumFor(context) === stratum),
            ])),
            byDataset: Object.fromEntries(datasetGroups.map((datasetGroup) => [
                datasetGroup,
                summarizeStratum((context) => context.datasetGroup === datasetGroup),
            ])),
            bySeriesLength: {
                years_150_199: summarizeStratum((context) => context.seriesLength < 200),
                years_200_399: summarizeStratum((context) => (
                    context.seriesLength >= 200 && context.seriesLength < 400
                )),
                years_400_plus: summarizeStratum((context) => context.seriesLength >= 400),
            },
            byReferenceDepth: {
                refs_5_9: summarizeStratum((context) => context.referenceCount < 10),
                refs_10_19: summarizeStratum((context) => (
                    context.referenceCount >= 10 && context.referenceCount < 20
                )),
                refs_20_plus: summarizeStratum((context) => context.referenceCount >= 20),
            },
            byEndpointDistance: Object.fromEntries([
                "older_14_29",
                "interior_30_plus",
                "newer_15_29",
                "newer_2_14",
            ].map((stratum) => [
                stratum,
                summarizeStratum((context) => endpointStratumFor(context) === stratum),
            ])),
            byBaselineStatus: {
                clean: summarizeStratum((context) => context.baselineFlagged === false),
                flagged: summarizeStratum((context) => context.baselineFlagged === true),
            },
            byReferenceAvailability: {
                observableAtTruthYear: summarizeStratum(
                    (context) => context.referenceObservableAtYear,
                ),
                unavailableAtTruthYear: summarizeStratum(
                    (context) => !context.referenceObservableAtYear,
                ),
            },
        };
        const piecewiseChangePointSummary = usePiecewiseChangePoint
            ? Object.fromEntries(eventTypes.map((eventType) => {
                const injected = piecewiseChangePointCases.filter((row) => (
                    row.caseType === "injected" && row.eventType === eventType
                ));
                const clean = piecewiseChangePointCases.filter((row) => (
                    row.caseType === "clean" && row.eventType === eventType
                ));
                return [eventType, Object.fromEntries(piecewiseScoreNames.map((scoreName) => {
                    const available = injected.filter((row) => row.tops[scoreName] !== null);
                    const hits = available.filter((row) => row.tops[scoreName]?.windowHit);
                    const piecewiseOnly = hits.filter((row) => !row.currentHit).length;
                    const currentAtRisk = available.filter((row) => (
                        row.currentHit && !row.tops[scoreName]?.windowHit
                    )).length;
                    const injectedScores = available
                        .map((row) => row.tops[scoreName]?.score)
                        .filter((value): value is number => value !== undefined);
                    const cleanScores = clean
                        .map((row) => row.tops[scoreName]?.score)
                        .filter((value): value is number => value !== undefined);
                    const injectedMargins = available
                        .map((row) => row.tops[scoreName]?.remoteMargin)
                        .filter((value): value is number => value !== undefined);
                    const cleanMargins = clean
                        .map((row) => row.tops[scoreName]?.remoteMargin)
                        .filter((value): value is number => value !== undefined);
                    const distribution = (values: number[]) => ({
                        p10: valueAtQuantile([...values].sort((a, b) => a - b), 0.1),
                        median: valueAtQuantile([...values].sort((a, b) => a - b), 0.5),
                        p90: valueAtQuantile([...values].sort((a, b) => a - b), 0.9),
                    });
                    return [scoreName, {
                        cases: available.length,
                        hits: hits.length,
                        recall: hits.length / Math.max(1, available.length),
                        exact: available.filter((row) => row.tops[scoreName]?.exact).length,
                        withinOne: available
                            .filter((row) => row.tops[scoreName]?.withinOne).length,
                        piecewiseOnly,
                        currentAtRisk,
                        oracleUnionHits: aggregates[eventType].matched + piecewiseOnly,
                        scoreDistribution: {
                            injected: distribution(injectedScores),
                            clean: distribution(cleanScores),
                        },
                        marginDistribution: {
                            injected: distribution(injectedMargins),
                            clean: distribution(cleanMargins),
                        },
                    }];
                }))];
            }))
            : null;
        const referenceChangePointSummary = useReferenceChangePoint
            ? Object.fromEntries(eventTypes.map((eventType) => {
                const injected = referenceChangePointCases.filter((row) => (
                    row.caseType === "injected" && row.eventType === eventType
                ));
                const clean = referenceChangePointCases.filter((row) => (
                    row.caseType === "clean" && row.eventType === eventType
                ));
                return [eventType, Object.fromEntries(
                    referenceChangePointScoreNames.map((scoreName) => {
                        const available = injected.filter((row) => (
                            row.tops[scoreName] !== null
                        ));
                        const hits = available.filter((row) => (
                            row.tops[scoreName]?.windowHit
                        ));
                        const piecewiseOnly = hits.filter((row) => !row.currentHit).length;
                        const scoreDistribution = (
                            rows: ReferenceChangePointAuditRow[],
                            field: "score" | "remoteMargin",
                        ) => {
                            const values = rows
                                .map((row) => row.tops[scoreName]?.[field])
                                .filter((value): value is number => value !== undefined)
                                .sort((a, b) => a - b);
                            return {
                                p10: valueAtQuantile(values, 0.1),
                                median: valueAtQuantile(values, 0.5),
                                p90: valueAtQuantile(values, 0.9),
                            };
                        };
                        return [scoreName, {
                            cases: available.length,
                            hits: hits.length,
                            recall: hits.length / Math.max(1, available.length),
                            exact: available.filter((row) => row.tops[scoreName]?.exact).length,
                            withinOne: available.filter((row) => (
                                row.tops[scoreName]?.withinOne
                            )).length,
                            referenceOnly: piecewiseOnly,
                            oracleUnionHits: aggregates[eventType].matched + piecewiseOnly,
                            scoreDistribution: {
                                injected: scoreDistribution(available, "score"),
                                clean: scoreDistribution(clean, "score"),
                            },
                            marginDistribution: {
                                injected: scoreDistribution(available, "remoteMargin"),
                                clean: scoreDistribution(clean, "remoteMargin"),
                            },
                        }];
                    }),
                )];
            }))
            : null;
        const rankingSignalSummary = (() => {
            const signals = {
                profile: "profile_boundary_year=",
                scan: "scan_top_year=",
                rawPath: "raw_path_top_year=",
                candidate: "candidate_top_year=",
                referenceVote: "reference_vote_year=",
            } as const;
            const noteValue = (row: RankingCase, prefix: string): number | null => {
                const note = row.notes.find((value) => value.startsWith(prefix));
                if (!note) return null;
                const value = Number(note.slice(prefix.length));
                return Number.isFinite(value) ? value : null;
            };
            const eventTypes: RankingCase["eventType"][] = [
                "missingRing",
                "falseRing",
                "partialMove",
            ];
            return Object.fromEntries(eventTypes.map((eventType) => {
                const rows = rankingCases.filter((row) => row.eventType === eventType);
                return [eventType, Object.fromEntries(Object.entries(signals).map(([name, prefix]) => {
                    const comparisons = rows.flatMap((row) => {
                        const signalYear = noteValue(row, prefix);
                        const currentYear = row.rankedYears[0]?.year;
                        if (signalYear === null || currentYear === undefined) return [];
                        return [{
                            signalError: signalYear - row.truthYear,
                            currentError: currentYear - row.truthYear,
                            inside: signalYear >= row.range[0] && signalYear <= row.range[1],
                        }];
                    });
                    const inside = comparisons.filter((row) => row.inside);
                    return [name, {
                        available: comparisons.length,
                        insideWindow: inside.length,
                        exactInside: inside.filter((row) => row.signalError === 0).length,
                        withinOneInside: inside.filter((row) => Math.abs(row.signalError) <= 1).length,
                        improvesToExact: inside.filter((row) => (
                            row.currentError !== 0 && row.signalError === 0
                        )).length,
                        losesExact: inside.filter((row) => (
                            row.currentError === 0 && row.signalError !== 0
                        )).length,
                        improvesAbsoluteError: inside.filter((row) => (
                            Math.abs(row.signalError) < Math.abs(row.currentError)
                        )).length,
                        worsensAbsoluteError: inside.filter((row) => (
                            Math.abs(row.signalError) > Math.abs(row.currentError)
                        )).length,
                        improvesToWithinOne: inside.filter((row) => (
                            Math.abs(row.currentError) > 1 && Math.abs(row.signalError) <= 1
                        )).length,
                        losesWithinOne: inside.filter((row) => (
                            Math.abs(row.currentError) <= 1 && Math.abs(row.signalError) > 1
                        )).length,
                    }];
                }))];
            }));
        })();
        const missingCandidateRuleSearch = (() => {
            const rows = rankingCases.filter((row) => row.eventType === "missingRing");
            const noteValue = (row: RankingCase, prefix: string): number | null => {
                const note = row.notes.find((value) => value.startsWith(prefix));
                if (!note) return null;
                const value = Number(note.slice(prefix.length));
                return Number.isFinite(value) ? value : null;
            };
            const confidenceValue = (row: RankingCase): string | null => {
                const prefix = "candidate_top_confidence=";
                return row.notes.find((value) => value.startsWith(prefix))?.slice(prefix.length)
                    ?? null;
            };
            const baselineExact = rows.filter((row) => (
                row.rankedYears[0]?.year === row.truthYear
            )).length;
            const baselineWithinOne = rows.filter((row) => (
                Math.abs((row.rankedYears[0]?.year ?? Infinity) - row.truthYear) <= 1
            )).length;
            const configs = [-Infinity, 0, 5, 10, 15, 20, 30]
                .flatMap((minScore) => [-Infinity, 0, 2, 5, 10].flatMap((minMargin) => (
                    [1, 2, 3, 6].flatMap((maxDistance) => [false, true].flatMap((excludeLow) => (
                        [false, true].flatMap((excludeReferenceVote) => (
                            [0.02, 0.05, 0.1, 0.2, 0.5, 1, Infinity].map((maxCurrentMargin) => ({
                                minScore,
                                minMargin,
                                maxDistance,
                                excludeLow,
                                excludeReferenceVote,
                                maxCurrentMargin,
                            }))
                        ))
                    )))
                )));
            return configs.map((config) => {
                let selected = 0;
                let exact = 0;
                let withinOne = 0;
                rows.forEach((row) => {
                    const currentYear = row.rankedYears[0]?.year;
                    const candidateYear = noteValue(row, "candidate_top_year=");
                    const score = noteValue(row, "candidate_top_score=");
                    const margin = noteValue(row, "candidate_top_margin=");
                    const confidence = confidenceValue(row);
                    const currentMargin = row.rankedYears.length < 2
                        ? Infinity
                        : row.rankedYears[0].score - row.rankedYears[1].score;
                    const candidateInside = candidateYear !== null
                        && candidateYear >= row.range[0]
                        && candidateYear <= row.range[1];
                    const useCandidate = currentYear !== undefined
                        && candidateInside
                        && score !== null && score >= config.minScore
                        && margin !== null && margin >= config.minMargin
                        && currentMargin <= config.maxCurrentMargin
                        && Math.abs(candidateYear - currentYear) <= config.maxDistance
                        && (!config.excludeLow || confidence !== "low")
                        && (!config.excludeReferenceVote
                            || !row.sources.includes("reference_core_voting"));
                    const selectedYear = useCandidate ? candidateYear : currentYear;
                    if (useCandidate) selected += 1;
                    if (selectedYear === row.truthYear) exact += 1;
                    if (selectedYear !== undefined
                        && selectedYear !== null
                        && Math.abs(selectedYear - row.truthYear) <= 1) withinOne += 1;
                });
                return {
                    ...config,
                    selected,
                    exact,
                    withinOne,
                    exactDelta: exact - baselineExact,
                    withinOneDelta: withinOne - baselineWithinOne,
                };
            })
                .filter((row) => row.selected > 0)
                .sort((a, b) => (
                    b.exact - a.exact
                    || b.withinOne - a.withinOne
                    || a.selected - b.selected
                ))
                .slice(0, 12);
        })();
        const cleanPairwiseSummary = (() => {
            const thresholds = [0.01, 0.02, 0.05, 0.1];
            const summarizeType = (key: "missing" | "falseRing" | "partialMove") => {
                const rows = cleanPairwiseCases
                    .map((row) => (row as Record<string, { gain?: number } | null>)[key]?.gain)
                    .filter((gain): gain is number => typeof gain === "number");
                return {
                    cases: rows.length,
                    maxGain: rows.length > 0 ? Math.max(...rows) : null,
                    triggers: Object.fromEntries(thresholds.map((threshold) => [
                        threshold.toString(),
                        rows.filter((gain) => gain >= threshold).length,
                    ])),
                };
            };
            return {
                missingRing: summarizeType("missing"),
                falseRing: summarizeType("falseRing"),
                partialMove: summarizeType("partialMove"),
            };
        })();
        const pairwiseSelectorSummary = (() => {
            type SelectorRow = {
                eventType: "missingRing" | "falseRing" | "partialMove";
                truthYear: number;
                truthShiftYears?: number;
                current: {
                    confidence?: string;
                    topYear?: number;
                    shiftYears?: number;
                } | null;
                currentHit: boolean;
                pairwise: {
                    year: number;
                    shiftYears?: number;
                    gain: number;
                    remoteMargin: number;
                    hit: boolean;
                } | null;
                exhaustive?: {
                    year: number;
                    shiftYears?: number;
                    gain: number;
                    remoteMargin: number;
                    hit: boolean;
                } | null;
            };
            const rows = pairwiseCases as SelectorRow[];
            const summarizeSelector = (eventType: SelectorRow["eventType"]) => {
                const typedRows = rows.filter((row) => row.eventType === eventType);
                let answered = 0;
                let matched = 0;
                let usedPairwise = 0;
                let usedFusion = 0;
                typedRows.forEach((row) => {
                    const evidence = row.pairwise;
                    const hasGain = Boolean(evidence && evidence.gain >= (
                        eventType === "missingRing"
                            ? 0.01
                            : eventType === "partialMove" ? 0.019 : 0.05
                    ));
                    const usePairwise = hasGain && (row.current === null
                        || (eventType === "missingRing" && evidence!.remoteMargin >= 0.01)
                        || (eventType === "falseRing"
                            && row.current.confidence !== "high"
                            && evidence!.remoteMargin >= (
                                row.current.confidence === "low" ? 0.002 : 0.005
                            ))
                        || (eventType === "partialMove"
                            && ((row.current.confidence === "high"
                                && evidence!.remoteMargin >= 0.022)
                                || (row.current.confidence === "low"
                                    && evidence!.remoteMargin <= 0.002))));
                    if (usePairwise) usedPairwise += 1;
                    const exhaustive = row.exhaustive;
                    const useFusion = !usePairwise
                        && eventType === "partialMove"
                        && row.current?.confidence === "high"
                        && row.current.topYear !== undefined
                        && row.current.shiftYears !== undefined
                        && evidence !== null
                        && evidence.shiftYears === row.current.shiftYears
                        && Math.abs(evidence.year - row.current.topYear) <= 2
                        && exhaustive !== null
                        && exhaustive !== undefined
                        && exhaustive.shiftYears === row.current.shiftYears
                        && exhaustive.year - row.current.topYear >= 8
                        && exhaustive.year - row.current.topYear <= 12
                        && exhaustive.gain >= evidence.gain + 0.05;
                    if (useFusion) usedFusion += 1;
                    const fusionCenter = useFusion
                        ? Math.round((row.current!.topYear! + exhaustive!.year) / 2)
                        : null;
                    const selectedHit = useFusion
                        ? Math.abs(fusionCenter! - row.truthYear) <= 4
                            && row.current!.shiftYears === row.truthShiftYears
                        : usePairwise ? evidence!.hit : row.currentHit;
                    const selectedAnswered = usePairwise || row.current !== null;
                    if (selectedAnswered) answered += 1;
                    if (selectedHit) matched += 1;
                });
                return {
                    cases: typedRows.length,
                    answered,
                    responseRate: answered / Math.max(1, typedRows.length),
                    matched,
                    recall: matched / Math.max(1, typedRows.length),
                    approximatePrecision: matched / Math.max(1, answered),
                    usedPairwise,
                    usedFusion,
                };
            };
            return {
                missingRing: summarizeSelector("missingRing"),
                falseRing: summarizeSelector("falseRing"),
                partialMove: summarizeSelector("partialMove"),
            };
        })();
        const directTransitionSummary = (() => {
            const thresholds = [-1000, -10, -5, 0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 40];
            const quantiles = (values: number[]) => {
                const sorted = [...values].sort((a, b) => a - b);
                const at = (fraction: number) => sorted.length > 0
                    ? sorted[Math.round((sorted.length - 1) * fraction)]
                    : null;
                return { count: sorted.length, p10: at(0.1), median: at(0.5), p90: at(0.9) };
            };
            const summarizeType = (eventType: DirectTransitionAuditRow["eventType"]) => {
                const injected = directTransitionCases.filter((row) => (
                    row.caseType === "injected" && row.eventType === eventType
                ));
                const clean = directTransitionCases.filter((row) => (
                    row.caseType === "clean" && row.eventType === eventType
                ));
                const currentHits = injected.filter((row) => row.currentHit).length;
                const thresholdRows = thresholds.map((threshold) => {
                    const triggered = injected.filter((row) => (
                        row.direct !== null && row.direct.gain >= threshold
                    ));
                    const directHits = triggered.filter((row) => row.direct?.completeHit).length;
                    const directOnly = triggered.filter((row) => (
                        !row.currentHit && row.direct?.completeHit
                    )).length;
                    const currentAtRisk = triggered.filter((row) => (
                        row.currentHit && !row.direct?.completeHit
                    )).length;
                    const exact = triggered.filter((row) => (
                        row.direct?.completeHit
                        && row.direct.topYear === row.truthYear
                    )).length;
                    const withinOne = triggered.filter((row) => (
                        row.direct?.completeHit
                        && row.direct.topYear !== null
                        && row.truthYear !== null
                        && Math.abs(row.direct.topYear - row.truthYear) <= 1
                    )).length;
                    return {
                        threshold,
                        triggered: triggered.length,
                        directHits,
                        directPrecision: directHits / Math.max(1, triggered.length),
                        directOnly,
                        currentAtRisk,
                        oracleUnionHits: currentHits + directOnly,
                        exact,
                        withinOne,
                        cleanTriggers: clean.filter((row) => (
                            row.direct !== null && row.direct.gain >= threshold
                        )).length,
                    };
                });
                return {
                    injectedCases: injected.length,
                    cleanCases: clean.length,
                    currentHits,
                    directGain: {
                        hit: quantiles(injected
                            .filter((row) => row.direct?.completeHit)
                            .map((row) => row.direct!.gain)),
                        miss: quantiles(injected
                            .filter((row) => row.direct !== null && !row.direct.completeHit)
                            .map((row) => row.direct!.gain)),
                        clean: quantiles(clean
                            .filter((row) => row.direct !== null)
                            .map((row) => row.direct!.gain)),
                    },
                    directMargin: {
                        hit: quantiles(injected
                            .filter((row) => row.direct?.completeHit)
                            .map((row) => row.direct!.margin)),
                        miss: quantiles(injected
                            .filter((row) => row.direct !== null && !row.direct.completeHit)
                            .map((row) => row.direct!.margin)),
                        clean: quantiles(clean
                            .filter((row) => row.direct !== null)
                            .map((row) => row.direct!.margin)),
                    },
                    thresholds: thresholdRows,
                };
            };
            return {
                missingRing: summarizeType("missingRing"),
                falseRing: summarizeType("falseRing"),
                partialMove: summarizeType("partialMove"),
            };
        })();
        const pairedBreakpointSummary = (() => {
            const summarizeType = (eventType: PairedBreakpointAuditRow["eventType"]) => {
                const injected = pairedBreakpointCases.filter((row) => (
                    row.caseType === "injected" && row.eventType === eventType
                ));
                const clean = pairedBreakpointCases.filter((row) => (
                    row.caseType === "clean" && row.eventType === eventType
                ));
                const currentHits = injected.filter((row) => row.currentHit).length;
                return {
                    injectedCases: injected.length,
                    availableCases: injected.filter((row) => row.referenceCount > 0).length,
                    cleanAvailableCases: clean.filter((row) => row.referenceCount > 0).length,
                    currentHits,
                    byScore: Object.fromEntries(pairedScoreNames.map((scoreName) => {
                        const available = injected.filter((row) => row.tops[scoreName] !== null);
                        const hits = available.filter((row) => row.tops[scoreName]?.windowHit).length;
                        const pairedOnly = available.filter((row) => (
                            !row.currentHit && row.tops[scoreName]?.windowHit
                        )).length;
                        const currentAtRisk = available.filter((row) => (
                            row.currentHit && !row.tops[scoreName]?.windowHit
                        )).length;
                        return [scoreName, {
                            available: available.length,
                            hits,
                            exact: available.filter((row) => row.tops[scoreName]?.exact).length,
                            withinOne: available.filter((row) => row.tops[scoreName]?.withinOne).length,
                            pairedOnly,
                            currentAtRisk,
                            oracleUnionHits: currentHits + pairedOnly,
                        }];
                    })),
                };
            };
            return {
                missingRing: summarizeType("missingRing"),
                falseRing: summarizeType("falseRing"),
            };
        })();
        // eslint-disable-next-line no-console
        console.log(`ITRDB FROZEN EVENT HOLDOUT ${JSON.stringify({
            benchmarkClass: "formal_arbitrary_year",
            sampling: "calendar-position-stratified-signal-independent",
            selectionUsesSignal: false,
            minimumContextYears,
            minimumOlderContextYears,
            minimumNewerContextYears,
            skipPartialTruth,
            partialGapYears,
            files: files.length,
            fileSplit,
            splitPoolFiles: splitFiles.length,
            offset,
            attempted: baselineCleanContexts.length,
            excludedBaselineFlaggedCases: attempted - baselineCleanContexts.length,
            missingRing: formalEventSummary("missingRing"),
            falseRing: formalEventSummary("falseRing"),
            partialMove: formalEventSummary("partialMove"),
            partialMoveByShift: baselineCleanPartialMoveByShift,
            baselineCleanPartialMoveByShift,
            clean: formalCleanSummary,
            allSampledAudit: allSampledAuditSummary,
            stratifiedBenchmarkSummary,
            ...(piecewiseChangePointSummary ? { piecewiseChangePointSummary } : {}),
            ...(referenceChangePointSummary ? { referenceChangePointSummary } : {}),
            eventPathConfig,
            missingRefinementAudit,
            rankingSignalSummary,
            missingCandidateRuleSearch,
            ...(usePairwiseClean ? { cleanPairwiseSummary } : {}),
            ...(usePairwise ? { pairwiseSelectorSummary } : {}),
            ...(useDirectTransition ? { directTransitionSummary } : {}),
            ...(usePairedBreakpoint ? { pairedBreakpointSummary } : {}),
            ...(useExhaustive ? {
                exhaustiveHits,
                exhaustiveTopKHits,
                exhaustiveOverlap,
                ...(useLocalized ? { localizedHits } : {}),
                ...(usePairwise ? {
                    pairwiseHits,
                    pairwiseOverlap,
                    pairwiseExhaustiveOverlap,
                } : {}),
            } : {}),
        })}`);
        if (process.env.PRINT_ITRDB_FROZEN_FAILURES === "1") {
            // eslint-disable-next-line no-console
            console.log(`ITRDB FROZEN FAILURES ${JSON.stringify(failures)}`);
        }
        if (process.env.PRINT_ITRDB_RANKING_CASES === "1") {
            // eslint-disable-next-line no-console
            console.log(`ITRDB RANKING CASES ${JSON.stringify(rankingCases)}`);
        }
        if (process.env.PRINT_ITRDB_MISSING_REFINEMENT === "1") {
            // eslint-disable-next-line no-console
            console.log(`ITRDB MISSING REFINEMENT ${JSON.stringify(missingRefinementCases)}`);
        }
        if (process.env.PRINT_ITRDB_REFERENCE_RECOVERIES === "1") {
            // eslint-disable-next-line no-console
            console.log(`ITRDB REFERENCE RECOVERIES ${JSON.stringify(referenceRecoveryCases)}`);
        }
        if (process.env.PRINT_ITRDB_EXHAUSTIVE_CASES === "1") {
            // eslint-disable-next-line no-console
            console.log(`ITRDB EXHAUSTIVE DISAGREEMENTS ${JSON.stringify(exhaustiveCases.filter((row) => {
                const typed = row as { currentHit?: boolean; exhaustive?: { hit?: boolean } | null };
                return typed.currentHit !== Boolean(typed.exhaustive?.hit);
            }))}`);
        }
        if (process.env.PRINT_ITRDB_PAIRWISE_CASES === "1") {
            // eslint-disable-next-line no-console
            console.log(`ITRDB PAIRWISE DISAGREEMENTS ${JSON.stringify(pairwiseCases.filter((row) => {
                const typed = row as { currentHit?: boolean; pairwise?: { hit?: boolean } | null };
                return typed.currentHit !== Boolean(typed.pairwise?.hit);
            }))}`);
        }
        if (process.env.PRINT_ITRDB_PAIRWISE_CLEAN === "1") {
            // eslint-disable-next-line no-console
            console.log(`ITRDB PAIRWISE CLEAN ${JSON.stringify(cleanPairwiseCases)}`);
        }
        if (process.env.PRINT_ITRDB_PARTIAL_CASES === "1") {
            // eslint-disable-next-line no-console
            console.log(`ITRDB PARTIAL DISAGREEMENTS ${JSON.stringify(pairwiseCases.filter((row) => {
                const typed = row as {
                    eventType?: string;
                    currentHit?: boolean;
                    pairwise?: { hit?: boolean } | null;
                    exhaustive?: { hit?: boolean } | null;
                };
                return typed.eventType === "partialMove"
                    && new Set([
                        typed.currentHit,
                        Boolean(typed.pairwise?.hit),
                        Boolean(typed.exhaustive?.hit),
                    ]).size > 1;
            }))}`);
        }
        if (process.env.PRINT_ITRDB_ABSTAINED_CLASSIFICATION === "1") {
            // eslint-disable-next-line no-console
            console.log(`ITRDB ABSTAINED CLASSIFICATION ${JSON.stringify(abstainedClassificationCases)}`);
        }
        if (process.env.PRINT_ITRDB_DIRECT_TRANSITION === "1") {
            // eslint-disable-next-line no-console
            console.log(`ITRDB DIRECT TRANSITION ${JSON.stringify(directTransitionCases)}`);
        }
        if (process.env.PRINT_ITRDB_PAIRED_BREAKPOINT === "1") {
            // eslint-disable-next-line no-console
            console.log(`ITRDB PAIRED BREAKPOINT ${JSON.stringify(pairedBreakpointCases)}`);
        }
        if (windowRankDataPath) {
            writeFileSync(windowRankDataPath, JSON.stringify({
                schemaVersion: 1,
                benchmarkClass: "formal_arbitrary_year",
                sampling: "calendar-position-stratified-signal-independent",
                selectionUsesSignal: false,
                minimumContextYears,
                minimumOlderContextYears,
                minimumNewerContextYears,
                skipPartialTruth,
                partialGapYears,
                fileSplit,
                splitPoolFiles: splitFiles.length,
                eligiblePoolFiles: eligibleFiles.length,
                ...(frozenFileManifestPath
                    ? { frozenFileManifestPath }
                    : {}),
                offset,
                attempted: baselineCleanContexts.length,
                excludedBaselineFlaggedCases: attempted - baselineCleanContexts.length,
                cases: windowRankCases.filter(
                    (row) => row.context.baselineFlagged === false,
                ),
            }), "utf8");
        }
        if (process.env.ITRDB_AUDIT_DATA_PATH) {
            writeFileSync(process.env.ITRDB_AUDIT_DATA_PATH, JSON.stringify({
                schemaVersion: 1,
                benchmarkClass: "formal_arbitrary_year",
                sampling: "calendar-position-stratified-signal-independent",
                selectionUsesSignal: false,
                minimumContextYears,
                minimumOlderContextYears,
                minimumNewerContextYears,
                skipPartialTruth,
                fileSplit,
                splitPoolFiles: splitFiles.length,
                offset,
                files: files.length,
                attempted: baselineCleanContexts.length,
                excludedBaselineFlaggedCases: attempted - baselineCleanContexts.length,
                summary: {
                    missingRing: formalEventSummary("missingRing"),
                    falseRing: formalEventSummary("falseRing"),
                    partialMove: formalEventSummary("partialMove"),
                    partialMoveByShift: baselineCleanPartialMoveByShift,
                    clean: formalCleanSummary,
                },
                allSampledSummary: allSampledAuditSummary,
                failures,
                rankingCases,
                caseContexts,
                eventCaseOutcomes,
                cleanCaseOutcomes,
                formalEventCaseOutcomes: baselineCleanEventOutcomes,
                formalCleanCaseOutcomes: baselineCleanCleanOutcomes,
                stratifiedBenchmarkSummary,
                ...(usePiecewiseChangePoint
                    ? { piecewiseChangePointCases, piecewiseChangePointSummary }
                    : {}),
                ...(useReferenceChangePoint
                    ? { referenceChangePointCases, referenceChangePointSummary }
                    : {}),
                ...(useExhaustive ? { exhaustiveTopKHits, exhaustiveCases } : {}),
                ...(useFixedContext ? { fixedContextCases, fixedContextCleanCases } : {}),
                ...(useFixedWindowCounterfactual
                    ? { fixedWindowCounterfactualCases }
                    : {}),
                missingRefinementCases,
                referenceRecoveryCases,
                ...(collectRecoveryGateAudit ? { recoveryGateAuditCases } : {}),
                ...(collectJointOperationAudit ? { jointOperationAuditCases } : {}),
                ...(collectCounterfactualLocatorAudit
                    ? { counterfactualLocatorCases }
                    : {}),
                ...(collectPairedPulseLocalizedAudit ? { pairedPulseLocalizedAudit } : {}),
                ...(useDirectTransition ? { directTransitionCases } : {}),
                ...(usePairedBreakpoint ? { pairedBreakpointCases } : {}),
                ...(usePairwise ? { pairwiseCases, abstainedClassificationCases } : {}),
                ...(usePairwiseClean ? { cleanPairwiseCases } : {}),
                ...(collectTransitionScanAudit ? { transitionScanCases } : {}),
            }, null, 2));
        }
        expect(attempted).toBeGreaterThan(0);
    }, BENCH_TIMEOUT);

    it("existing-zero stress：已有缺轮附近再叠加单事件", () => {
        if (process.env.RUN_ITRDB_ZERO_STRESS !== "1") return;

        const allFiles: string[] = [];
        collectFiles(ITRDB_DIR, allFiles);
        allFiles.sort();
        const offset = Number(process.env.ITRDB_ZERO_STRESS_OFFSET ?? 8);
        const files = sampleFiles(
            allFiles,
            Number(process.env.ITRDB_ZERO_STRESS_FILES ?? 240),
            offset,
        );
        const maxCases = Number(process.env.ITRDB_ZERO_STRESS_CASES ?? 20);
        type EventType = "missingRing" | "falseRing" | "partialMove";
        type StressAggregate = {
            cases: number;
            answered: number;
            operationMatched: number;
            selectableOperationMatched: number;
            primaryWindowMatched: number;
            selectableWindowMatched: number;
            top1Exact: number;
            top1WithinOne: number;
            widths: number[];
        };
        const emptyStress = (): StressAggregate => ({
            cases: 0,
            answered: 0,
            operationMatched: 0,
            selectableOperationMatched: 0,
            primaryWindowMatched: 0,
            selectableWindowMatched: 0,
            top1Exact: 0,
            top1WithinOne: 0,
            widths: [],
        });
        const aggregates: Record<EventType, StressAggregate> = {
            missingRing: emptyStress(),
            falseRing: emptyStress(),
            partialMove: emptyStress(),
        };
        const contexts: Array<{
            file: string;
            target: string;
            injectedYear: number;
            nearestExistingZeroDistance: number;
            existingZeroCount: number;
        }> = [];
        const eventOutcomes: Array<{
            file: string;
            target: string;
            eventType: EventType;
            truthYear: number;
            truthShiftYears: number | null;
            answered: boolean;
            operationMatched: boolean;
            selectableOperationMatched: boolean;
            primaryWindowMatched: boolean;
            selectableWindowMatched: boolean;
            matchedLocationRank: number | null;
            matchedRange: [number, number] | null;
            nearestSelectableWindowDistance: number | null;
            nearestSelectableRange: [number, number] | null;
            nearestSelectableCoreRange: [number, number] | null;
            nearestSelectableTopYear: number | null;
            selectedTopYear: number | null;
            selectedTopError: number | null;
            selectedTopIsExistingZero: boolean;
            truthRank: number | null;
            rankedYears: number[];
            algorithmSources: string[];
            nearestExistingZeroYear: number;
            nearestExistingZeroDistance: number;
        }> = [];
        const failures: unknown[] = [];
        let attempted = 0;

        const compatibleOperation = (truth: TruthEvent, event: DiagnosisEvent): boolean => (
            event.eventType === truth.eventType
            && (truth.eventType !== "partialMove"
                || (event.shiftYears === truth.shiftYears && event.shiftSide === truth.shiftSide))
        );
        const locations = (event: DiagnosisEvent) => [
            {
                rank: 0,
                startYear: event.startYear,
                endYear: event.endYear,
                reviewCoreRange: event.reviewCoreRange,
                rankedYears: event.rankedYears,
            },
            ...(event.locationAlternatives ?? []).map((location) => ({
                rank: location.rank,
                startYear: location.startYear,
                endYear: location.endYear,
                reviewCoreRange: location.reviewCoreRange,
                rankedYears: location.rankedYears,
            })),
        ];
        const summarizeStress = (aggregate: StressAggregate) => ({
            cases: aggregate.cases,
            responseRate: aggregate.answered / Math.max(1, aggregate.cases),
            operationAccuracy: aggregate.operationMatched / Math.max(1, aggregate.cases),
            selectableOperationAccuracy:
                aggregate.selectableOperationMatched / Math.max(1, aggregate.cases),
            primaryWindowRecall:
                aggregate.primaryWindowMatched / Math.max(1, aggregate.cases),
            selectableWindowRecall:
                aggregate.selectableWindowMatched / Math.max(1, aggregate.cases),
            top1Exact: aggregate.top1Exact / Math.max(1, aggregate.cases),
            top1WithinOne: aggregate.top1WithinOne / Math.max(1, aggregate.cases),
            medianWidth: aggregate.widths.length > 0
                ? [...aggregate.widths].sort((a, b) => a - b)[
                    Math.floor((aggregate.widths.length - 1) / 2)
                ]
                : 0,
        });

        for (let fileIndex = 0; fileIndex < files.length && attempted < maxCases; fileIndex += 1) {
            let parsed: Map<string, Series>;
            try {
                parsed = parseItrdb(readFileSync(files[fileIndex], "utf8"));
            } catch {
                continue;
            }
            const fixtureSeries = new Map<string, FixtureSeries>();
            parsed.forEach((series, id) => {
                const valuesByYear = new Map(series.valuesByYear);
                fixtureSeries.set(id, {
                    id,
                    valuesByYear,
                    startYear: series.startYear,
                    endYear: series.endYear,
                    length: valuesByYear.size,
                    zeroCount: series.zeros.length,
                    nonZeroCount: valuesByYear.size - series.zeros.length,
                });
            });
            const eligible = Array.from(fixtureSeries.values()).filter((series) => {
                const source = parsed.get(series.id);
                return Boolean(
                    source
                    && source.zeros.length > 0
                    && source.zeros.length <= Math.max(8, Math.floor(series.length * 0.05))
                    && series.length >= 150
                    && series.endYear - series.startYear + 1 >= 150
                    && Array.from(fixtureSeries.values()).filter((reference) => (
                        reference.id !== series.id
                        && overlap(parsed.get(reference.id)!, source) >= 80
                    )).length >= 5
                );
            });
            if (eligible.length === 0) continue;
            const target = eligible[(fileIndex + offset) % eligible.length];
            const source = parsed.get(target.id)!;
            const existingZero = source.zeros[(fileIndex + offset) % source.zeros.length];
            const olderFirst = (fileIndex + offset) % 2 === 0;
            const ranges = olderFirst
                ? [[existingZero - 10, existingZero - 3], [existingZero + 3, existingZero + 10]]
                : [[existingZero + 3, existingZero + 10], [existingZero - 10, existingZero - 3]];
            let year: number | null = null;
            for (const [rangeStart, rangeEnd] of ranges) {
                const candidates = Array.from(target.valuesByYear.keys())
                    .filter((candidateYear) => (
                        candidateYear >= Math.max(target.startYear + 18, rangeStart)
                        && candidateYear <= Math.min(target.endYear - 18, rangeEnd)
                        && target.valuesByYear.get(candidateYear) !== 0
                    ))
                    .sort((a, b) => a - b);
                if (candidates.length > 0) {
                    year = candidates[(fileIndex * 31 + offset) % candidates.length];
                    break;
                }
            }
            if (year === null) continue;

            const diagnose = (corrupted: Map<number, number>): DiagnosisEvent[] => {
                const site = buildSyntheticSite(fixtureSeries, target.id, corrupted).site;
                return site ? diagnoseTargetEvents(site, target.id, {
                    enableGainGatedOperationRecovery: false,
                    enableMixedReferenceSupplement: true,
                }) : [];
            };
            const injectedShift = ([2, 3, 4, 5, 6, 8] as const)[fileIndex % 6];
            const cases: Array<{ truth: TruthEvent; predictions: DiagnosisEvent[] }> = [
                {
                    truth: {
                        id: `${target.id}-zero-stress-missing`,
                        seriesId: target.id,
                        eventType: "missingRing",
                        year,
                    },
                    predictions: diagnose(createEndAnchoredMissingRingCase(target, year).corrupted),
                },
                {
                    truth: {
                        id: `${target.id}-zero-stress-false`,
                        seriesId: target.id,
                        eventType: "falseRing",
                        year,
                    },
                    predictions: diagnose(createEndAnchoredFalseRingCase(
                        target,
                        year,
                        (["average", "moderate", "splitLike"] as const)[fileIndex % 3],
                    ).corrupted),
                },
                {
                    truth: {
                        id: `${target.id}-zero-stress-partial`,
                        seriesId: target.id,
                        eventType: "partialMove",
                        year,
                        shiftYears: -injectedShift,
                        shiftSide: "older",
                    },
                    predictions: diagnose(createPartialRangeMoveCase(
                        target,
                        year,
                        injectedShift,
                    ).corrupted),
                },
            ];
            cases.forEach(({ truth, predictions }) => {
                const aggregate = aggregates[truth.eventType as EventType];
                aggregate.cases += 1;
                if (predictions.length > 0) aggregate.answered += 1;
                const primaryOperations = predictions.filter((event) => (
                    compatibleOperation(truth, event)
                ));
                const selectableOperations = predictions.flatMap((event) => (
                    [event, ...(event.operationAlternatives ?? [])]
                )).filter((event) => compatibleOperation(truth, event));
                const selectableLocations = selectableOperations.flatMap((event) => (
                    locations(event).map((location) => ({ event, location }))
                ));
                if (primaryOperations.length > 0) aggregate.operationMatched += 1;
                if (selectableOperations.length > 0) aggregate.selectableOperationMatched += 1;
                const primaryHit = primaryOperations.find((event) => (
                    truth.year >= event.startYear && truth.year <= event.endYear
                ));
                const selectableHit = selectableLocations.find(({ location }) => (
                    truth.year >= location.startYear && truth.year <= location.endYear
                ));
                const nearestSelectable = [...selectableLocations].sort((left, right) => {
                    const distance = (location: {
                        startYear: number;
                        endYear: number;
                    }) => (
                        truth.year < location.startYear
                            ? location.startYear - truth.year
                            : truth.year > location.endYear
                                ? truth.year - location.endYear
                                : 0
                    );
                    return distance(left.location) - distance(right.location)
                        || left.location.rank - right.location.rank;
                })[0] ?? null;
                const nearestSelectableWindowDistance = nearestSelectable
                    ? truth.year < nearestSelectable.location.startYear
                        ? nearestSelectable.location.startYear - truth.year
                        : truth.year > nearestSelectable.location.endYear
                            ? truth.year - nearestSelectable.location.endYear
                            : 0
                    : null;
                if (primaryHit) {
                    aggregate.primaryWindowMatched += 1;
                    aggregate.widths.push(primaryHit.endYear - primaryHit.startYear + 1);
                }
                if (selectableHit) {
                    aggregate.selectableWindowMatched += 1;
                    const topYear = selectableHit.location.rankedYears[0]?.year;
                    if (topYear === truth.year) aggregate.top1Exact += 1;
                    if (topYear !== undefined && Math.abs(topYear - truth.year) <= 1) {
                        aggregate.top1WithinOne += 1;
                    }
                }
                const selectedTopYear = selectableHit?.location.rankedYears[0]?.year ?? null;
                const nearestExistingZeroYear = source.zeros.reduce((nearest, zeroYear) => (
                    Math.abs(zeroYear - truth.year) < Math.abs(nearest - truth.year)
                        ? zeroYear
                        : nearest
                ), source.zeros[0]);
                eventOutcomes.push({
                    file: files[fileIndex].slice(ITRDB_DIR.length),
                    target: target.id,
                    eventType: truth.eventType as EventType,
                    truthYear: truth.year,
                    truthShiftYears: truth.shiftYears ?? null,
                    answered: predictions.length > 0,
                    operationMatched: primaryOperations.length > 0,
                    selectableOperationMatched: selectableOperations.length > 0,
                    primaryWindowMatched: primaryHit !== undefined,
                    selectableWindowMatched: selectableHit !== undefined,
                    matchedLocationRank: selectableHit?.location.rank ?? null,
                    matchedRange: selectableHit
                        ? [selectableHit.location.startYear, selectableHit.location.endYear]
                        : null,
                    nearestSelectableWindowDistance,
                    nearestSelectableRange: nearestSelectable
                        ? [
                            nearestSelectable.location.startYear,
                            nearestSelectable.location.endYear,
                        ]
                        : null,
                    nearestSelectableCoreRange: nearestSelectable?.location.reviewCoreRange
                        ? [
                            nearestSelectable.location.reviewCoreRange.startYear,
                            nearestSelectable.location.reviewCoreRange.endYear,
                        ]
                        : null,
                    nearestSelectableTopYear:
                        nearestSelectable?.location.rankedYears[0]?.year ?? null,
                    selectedTopYear,
                    selectedTopError: selectedTopYear === null
                        ? null
                        : selectedTopYear - truth.year,
                    selectedTopIsExistingZero: selectedTopYear !== null
                        && target.valuesByYear.get(selectedTopYear) === 0,
                    truthRank: selectableHit?.location.rankedYears.find(
                        (row) => row.year === truth.year,
                    )?.rank ?? null,
                    rankedYears: selectableHit?.location.rankedYears
                        .slice(0, 8)
                        .map((row) => row.year) ?? [],
                    algorithmSources: selectableHit?.event.evidence.algorithmSources ?? [],
                    nearestExistingZeroYear,
                    nearestExistingZeroDistance: Math.abs(nearestExistingZeroYear - truth.year),
                });
                if (!selectableHit && failures.length < 30) {
                    failures.push({
                        file: files[fileIndex].slice(ITRDB_DIR.length),
                        target: target.id,
                        existingZeros: source.zeros,
                        eventType: truth.eventType,
                        truthYear: truth.year,
                        predictions: predictions.map((event) => ({
                            type: event.eventType,
                            range: [event.startYear, event.endYear],
                            shiftYears: event.shiftYears,
                            sources: event.evidence.algorithmSources,
                        })),
                    });
                }
            });
            contexts.push({
                file: files[fileIndex].slice(ITRDB_DIR.length),
                target: target.id,
                injectedYear: year,
                nearestExistingZeroDistance: Math.min(
                    ...source.zeros.map((zeroYear) => Math.abs(zeroYear - year!)),
                ),
                existingZeroCount: source.zeros.length,
            });
            attempted += 1;
        }

        const report = {
            offset,
            attempted,
            sampling: {
                method: "deterministic nonzero calendar year 3-10 years from an existing zero",
                signalConditionedSelection: false,
                correlationInspectedBeforeSelection: false,
            },
            missingRing: summarizeStress(aggregates.missingRing),
            falseRing: summarizeStress(aggregates.falseRing),
            partialMove: summarizeStress(aggregates.partialMove),
            contexts,
            eventOutcomes,
        };
        // Keep detailed outcomes on disk without flooding the test console.
        const { eventOutcomes: _eventOutcomes, ...consoleReport } = report;
        // eslint-disable-next-line no-console
        console.log(`ITRDB EXISTING ZERO STRESS ${JSON.stringify(consoleReport)}`);
        if (process.env.ITRDB_AUDIT_DATA_PATH) {
            writeFileSync(process.env.ITRDB_AUDIT_DATA_PATH, JSON.stringify({
                ...report,
                failures,
            }, null, 2));
        }
        expect(attempted).toBeGreaterThan(0);
    }, BENCH_TIMEOUT);

    it("开发集窗口内单位事件线性排序器", () => {
        if (process.env.RUN_UNIT_RANKER_EXPERIMENT !== "1") return;

        const featureNames: Array<keyof Omit<UnitBreakpointScore, "year">> = [
            "raw31",
            "difference31",
            "whitened31",
            "raw11",
            "difference11",
            "whitened11",
            "combo11",
            "combo21",
            "combo31",
            "combo41",
            "combo61",
            "multiScale",
            "rawHuber5",
            "rawHuber7",
            "rawHuber11",
            "rawHuber31",
            "differenceHuber5",
            "differenceHuber7",
            "differenceHuber11",
            "differenceHuber31",
            "whitenedHuber5",
            "whitenedHuber7",
            "whitenedHuber11",
            "whitenedHuber31",
            "huberCombo5",
            "huberCombo7",
            "huberCombo11",
            "huberCombo31",
            "huberMultiScale",
            "pairMean31",
            "pairMedian31",
            "pairTrimmed31",
            "pairWeighted31",
            "bestReference31",
            "pairedCore31",
        ];
        const partialFeatureNames: Array<keyof Omit<GapBoundaryScore, "year">> = [
            "raw31",
            "difference31",
            "whitened31",
            "combo31",
            "combo41",
            "combo61",
            "multiScale",
        ];
        const independentFeatureNames = [
            "directProximity",
            "directSignedDistance",
            "pairedProximity",
            "pairedSignedDistance",
            "consensusProximity",
            "exactVoteCount",
            "withinOneVoteCount",
            "betweenIndependent",
        ];
        type RankCase = {
            groupId: string;
            eventType: "missingRing" | "falseRing" | "partialMove";
            truthYear: number;
            currentTopYear: number;
            rows: Array<{ year: number; features: number[] }>;
        };
        type RankRun = {
            events: DiagnosisEvent[];
            diagnosis: SeriesCoreDiagnosis | null;
            site: RwlSiteData | null;
            groupId: string;
        };
        const rankCases: RankCase[] = [];
        const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0)
            / Math.max(1, values.length);
        const evidenceYear = (event: DiagnosisEvent, prefix: string): number | null => {
            const note = event.evidence.notes.find((value) => value.startsWith(prefix));
            if (!note) return null;
            const value = Number(note.slice(prefix.length));
            return Number.isFinite(value) ? value : null;
        };
        const vectorize = (
            scores: UnitBreakpointScore[],
            event: DiagnosisEvent,
        ): RankCase["rows"] => {
            const currentTopYear = event.rankedYears[0]?.year
                ?? Math.round((event.startYear + event.endYear) / 2);
            const stats = featureNames.map((name) => {
                const values = scores.map((row) => row[name]);
                const center = mean(values);
                const variance = mean(values.map((value) => (value - center) ** 2));
                return { center, scale: Math.sqrt(variance) || 1 };
            });
            const directYear = evidenceYear(event, "direct_transition_year=");
            const pairedYear = evidenceYear(event, "paired_breakpoint_year=");
            const voters = [currentTopYear, directYear, pairedYear]
                .filter((year): year is number => year !== null);
            const sortedVoters = [...voters].sort((a, b) => a - b);
            const consensusYear = sortedVoters[Math.floor(sortedVoters.length / 2)]
                ?? currentTopYear;
            return scores.map((row) => ({
                year: row.year,
                features: [
                    ...featureNames.map((name, index) => (
                        (row[name] - stats[index].center) / stats[index].scale
                    )),
                    row.year === currentTopYear ? 1 : 0,
                    -Math.abs(row.year - currentTopYear) / 3,
                    (row.year - currentTopYear) / 3,
                    Math.min(
                        row.year - event.startYear,
                        event.endYear - row.year,
                    ) / 3,
                    directYear === null ? 0 : -Math.abs(row.year - directYear) / 8,
                    directYear === null ? 0 : (row.year - directYear) / 8,
                    pairedYear === null ? 0 : -Math.abs(row.year - pairedYear) / 8,
                    pairedYear === null ? 0 : (row.year - pairedYear) / 8,
                    -Math.abs(row.year - consensusYear) / 8,
                    voters.filter((year) => year === row.year).length / voters.length,
                    voters.filter((year) => Math.abs(year - row.year) <= 1).length
                        / voters.length,
                    directYear === null || pairedYear === null
                        ? 0
                        : -Math.max(
                            0,
                            Math.min(directYear, pairedYear) - row.year,
                            row.year - Math.max(directYear, pairedYear),
                        ) / 8,
                ],
            }));
        };
        const addRankCase = (
            eventType: "missingRing" | "falseRing",
            truthYear: number,
            run: RankRun,
        ) => {
            if (!run.diagnosis || !run.site) return;
            const event = run.events.find((candidate) => (
                candidate.eventType === eventType
                && truthYear >= candidate.startYear
                && truthYear <= candidate.endYear
            ));
            if (!event
                || event.evidence.algorithmSources.includes("paired_core_counterfactual_year")) {
                return;
            }
            const scores = scoreUnitBoundaries(event, run.diagnosis, run.site)
                .filter((row) => row.year >= event.startYear && row.year <= event.endYear);
            if (!scores.some((row) => row.year === truthYear)) return;
            rankCases.push({
                groupId: run.groupId,
                eventType,
                truthYear,
                currentTopYear: event.rankedYears[0]?.year
                    ?? Math.round((event.startYear + event.endYear) / 2),
                rows: vectorize(scores, event),
            });
        };
        const addPartialRankCase = (
            truthYear: number,
            expectedShiftYears: number,
            run: RankRun,
        ) => {
            if (!run.diagnosis || !run.site || expectedShiftYears >= -1) return;
            const event = run.events.find((candidate) => (
                candidate.eventType === "partialMove"
                && candidate.shiftYears === expectedShiftYears
                && truthYear >= candidate.startYear
                && truthYear <= candidate.endYear
            ));
            if (!event) return;
            const scores = scoreNegativePartialMoveBoundaries(
                run.diagnosis,
                expectedShiftYears,
            ).filter((row) => row.year >= event.startYear && row.year <= event.endYear);
            if (!scores.some((row) => row.year === truthYear)) return;
            const currentTopYear = event.rankedYears[0]?.year
                ?? Math.round((event.startYear + event.endYear) / 2);
            const stats = partialFeatureNames.map((name) => {
                const values = scores.map((row) => row[name]);
                const center = mean(values);
                const variance = mean(values.map((value) => (value - center) ** 2));
                return { center, scale: Math.sqrt(variance) || 1 };
            });
            rankCases.push({
                groupId: run.groupId,
                eventType: "partialMove",
                truthYear,
                currentTopYear,
                rows: scores.map((row) => ({
                    year: row.year,
                    features: [
                        ...partialFeatureNames.map((name, index) => (
                            (row[name] - stats[index].center) / stats[index].scale
                        )),
                        row.year === currentTopYear ? 1 : 0,
                        -Math.abs(row.year - currentTopYear) / 4,
                        (row.year - currentTopYear) / 4,
                        Math.min(
                            row.year - event.startYear,
                            event.endYear - row.year,
                        ) / 4,
                    ],
                })),
            });
        };

        const allFiles: string[] = [];
        collectFiles(ITRDB_DIR, allFiles);
        allFiles.sort();
        const offset = Number(process.env.ITRDB_RANKER_OFFSET ?? 9);
        const files = sampleFiles(
            allFiles,
            Number(process.env.ITRDB_RANKER_FILES ?? 200),
            offset,
        );
        const maxCases = Number(process.env.ITRDB_RANKER_CASES ?? 120);
        let attempted = 0;
        for (let fileIndex = 0; fileIndex < files.length && attempted < maxCases; fileIndex += 1) {
            let parsed: Map<string, Series>;
            try {
                parsed = parseItrdb(readFileSync(files[fileIndex], "utf8"));
            } catch {
                continue;
            }
            const fixtureSeries = new Map<string, FixtureSeries>();
            parsed.forEach((series, id) => {
                const valuesByYear = new Map(series.valuesByYear);
                fixtureSeries.set(id, {
                    id,
                    valuesByYear,
                    startYear: series.startYear,
                    endYear: series.endYear,
                    length: valuesByYear.size,
                    zeroCount: series.zeros.length,
                    nonZeroCount: valuesByYear.size - series.zeros.length,
                });
            });
            const eligible = Array.from(fixtureSeries.values()).filter((series) => (
                series.zeroCount === 0
                && series.length >= 150
                && series.endYear - series.startYear + 1 >= 150
                && Array.from(fixtureSeries.values()).filter((reference) => (
                    reference.id !== series.id
                    && overlap(parsed.get(reference.id)!, parsed.get(series.id)!) >= 80
                )).length >= 5
            ));
            if (eligible.length === 0) continue;
            const target = eligible[fileIndex % eligible.length];
            const selection = pickStratifiedCalendarYear(
                target,
                attempted,
                `${offset}:${files[fileIndex]}:${target.id}:ranker`,
                Number(process.env.ITRDB_RANKER_MIN_CONTEXT_YEARS ?? 18),
            );
            if (!selection) continue;
            const truthYear = selection.year;

            const run = (corrupted: Map<number, number>) => {
                const site = buildSyntheticSite(fixtureSeries, target.id, corrupted).site;
                const bundle = site ? diagnoseTargetBundle(site, target.id, {
                    enableLearnedWindowRanking: false,
                }) : null;
                return {
                    events: bundle?.events ?? [],
                    diagnosis: bundle?.diagnosis ?? null,
                    site,
                    groupId: `${files[fileIndex]}:${target.id}`,
                };
            };
            addRankCase(
                "missingRing",
                truthYear,
                run(createEndAnchoredMissingRingCase(target, truthYear).corrupted),
            );
            const falseRing = createEndAnchoredFalseRingCase(
                target,
                truthYear,
                (["average", "moderate", "splitLike"] as const)[fileIndex % 3],
            );
            addRankCase("falseRing", truthYear, run(falseRing.corrupted));
            const injectedShift = ([2, 3, 4, 5, 6, 8] as const)[fileIndex % 6];
            if (injectedShift > 1) {
                addPartialRankCase(
                    truthYear,
                    -injectedShift,
                    run(createPartialRangeMoveCase(target, truthYear, injectedShift).corrupted),
                );
            }
            attempted += 1;
        }

        if (process.env.ITRDB_RANKER_DATA_PATH) {
            writeFileSync(
                process.env.ITRDB_RANKER_DATA_PATH,
                JSON.stringify(rankCases),
                "utf8",
            );
        }
        if (process.env.ITRDB_RANKER_COLLECT_ONLY === "1") {
            expect(rankCases.length).toBeGreaterThan(20);
            return;
        }

        const dot = (features: number[], weights: number[]) => features.reduce(
            (sum, value, index) => sum + value * weights[index],
            0,
        );
        type SelectorGate = { minMargin: number; maxDistance: number };
        const evaluate = (
            cases: RankCase[],
            weights: number[] | null,
            gate: SelectorGate = { minMargin: -Infinity, maxDistance: Infinity },
        ) => {
            let exact = 0;
            let withinOne = 0;
            let switched = 0;
            cases.forEach((rankCase) => {
                const ranked = weights
                    ? rankCase.rows.map((row) => ({
                        year: row.year,
                        score: dot(row.features, weights),
                    })).sort((a, b) => b.score - a.score || b.year - a.year)
                    : [];
                const modelTop = ranked[0];
                const modelMargin = modelTop && ranked[1]
                    ? modelTop.score - ranked[1].score
                    : Infinity;
                const useModel = Boolean(
                    modelTop
                    && modelMargin >= gate.minMargin
                    && Math.abs(modelTop.year - rankCase.currentTopYear) <= gate.maxDistance,
                );
                const selectedYear = useModel ? modelTop!.year : rankCase.currentTopYear;
                if (useModel && selectedYear !== rankCase.currentTopYear) switched += 1;
                if (selectedYear === rankCase.truthYear) exact += 1;
                if (selectedYear !== undefined
                    && Math.abs(selectedYear - rankCase.truthYear) <= 1) withinOne += 1;
            });
            return {
                cases: cases.length,
                exact,
                exactRate: exact / Math.max(1, cases.length),
                withinOne,
                withinOneRate: withinOne / Math.max(1, cases.length),
                switched,
            };
        };
        const fit = (
            cases: RankCase[],
            regularization: number,
            learningRate: number,
        ): number[] => {
            const featureCount = cases[0]?.rows[0]?.features.length ?? 0;
            const weights = new Array<number>(featureCount).fill(0);
            for (let epoch = 0; epoch < 800; epoch += 1) {
                const gradient = weights.map((weight) => regularization * weight);
                cases.forEach((rankCase) => {
                    const logits = rankCase.rows.map((row) => dot(row.features, weights));
                    const maximum = Math.max(...logits);
                    const exponentials = logits.map((value) => Math.exp(value - maximum));
                    const total = exponentials.reduce((sum, value) => sum + value, 0);
                    rankCase.rows.forEach((row, rowIndex) => {
                        const error = exponentials[rowIndex] / total
                            - Number(row.year === rankCase.truthYear);
                        row.features.forEach((value, featureIndex) => {
                            gradient[featureIndex] += error * value / cases.length;
                        });
                    });
                });
                weights.forEach((weight, index) => {
                    weights[index] = weight - learningRate * gradient[index];
                });
            }
            return weights;
        };
        const selectModel = (cases: RankCase[]) => {
            const configs = [0.01, 0.03, 0.1, 0.3, 1, 3].flatMap((regularization) => (
                [0.01, 0.03, 0.08].map((learningRate) => ({ regularization, learningRate }))
            ));
            const gates = [0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.5].flatMap((minMargin) => (
                [1, 2, 3, 5, Infinity].map((maxDistance) => ({ minMargin, maxDistance }))
            ));
            const scored = configs.flatMap((config) => {
                const byGate = gates.map((gate) => ({ ...config, ...gate, exact: 0, withinOne: 0, switched: 0 }));
                const foldFor = (rankCase: RankCase) => Array.from(rankCase.groupId)
                    .reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) | 0, 0);
                for (let fold = 0; fold < 5; fold += 1) {
                    const training = cases.filter((rankCase) => (
                        Math.abs(foldFor(rankCase)) % 5 !== fold
                    ));
                    const validation = cases.filter((rankCase) => (
                        Math.abs(foldFor(rankCase)) % 5 === fold
                    ));
                    const weights = fit(training, config.regularization, config.learningRate);
                    byGate.forEach((row) => {
                        const metrics = evaluate(validation, weights, row);
                        row.exact += metrics.exact;
                        row.withinOne += metrics.withinOne;
                        row.switched += metrics.switched;
                    });
                }
                return byGate;
            }).sort((a, b) => (
                b.exact - a.exact
                || b.withinOne - a.withinOne
                || a.switched - b.switched
                || b.regularization - a.regularization
            ));
            const selected = scored[0];
            const weights = fit(cases, selected.regularization, selected.learningRate);
            return {
                selected,
                alternatives: scored.slice(0, 12),
                productionConservative: scored.find((row) => (
                    row.regularization === 3
                    && row.learningRate === 0.01
                    && row.minMargin === 0.8
                    && row.maxDistance === 3
                )),
                baseline: evaluate(cases, null),
                crossValidated: {
                    cases: cases.length,
                    exact: selected.exact,
                    exactRate: selected.exact / Math.max(1, cases.length),
                    withinOne: selected.withinOne,
                    withinOneRate: selected.withinOne / Math.max(1, cases.length),
                },
                fitted: evaluate(cases, weights, selected),
                weights,
            };
        };
        const featureEvaluation = (cases: RankCase[], labels: string[]) => Object.fromEntries(
            labels.flatMap((label, index) => {
                const positive = new Array(labels.length).fill(0);
                positive[index] = 1;
                const negative = positive.map((value) => -value);
                return [
                    [`${label}:max`, evaluate(cases, positive)],
                    [`${label}:min`, evaluate(cases, negative)],
                ];
            }),
        );
        const missingCases = rankCases.filter((row) => row.eventType === "missingRing");
        const falseCases = rankCases.filter((row) => row.eventType === "falseRing");
        const partialCases = rankCases.filter((row) => row.eventType === "partialMove");
        expect(missingCases.length).toBeGreaterThan(20);
        expect(falseCases.length).toBeGreaterThan(20);
        expect(partialCases.length).toBeGreaterThan(20);
        // eslint-disable-next-line no-console
        console.log(`ITRDB UNIT YEAR RANKER ${JSON.stringify({
            offset,
            attempted,
            featureNames: [
                ...featureNames,
                "currentTop",
                "distance",
                "signedDistance",
                "edge",
                ...independentFeatureNames,
            ],
            partialFeatureNames: [
                ...partialFeatureNames,
                "currentTop",
                "distance",
                "signedDistance",
                "edge",
            ],
            missingFeatureEvaluation: featureEvaluation(missingCases, [
                ...featureNames,
                "currentTop",
                "distance",
                "signedDistance",
                "edge",
                ...independentFeatureNames,
            ]),
            falseFeatureEvaluation: featureEvaluation(falseCases, [
                ...featureNames,
                "currentTop",
                "distance",
                "signedDistance",
                "edge",
                ...independentFeatureNames,
            ]),
            missingRing: selectModel(missingCases),
            falseRing: selectModel(falseCases),
            partialMove: selectModel(partialCases),
        })}`);
    }, BENCH_TIMEOUT);

    it("真实缺轮 top5/top1：有 COFECHA vs 无（ITRDB 子集，需运行 COFECHA）", () => {
        if (!existsSync(COF_EXE)) return;
        const allFiles: string[] = [];
        collectFiles(ITRDB_DIR, allFiles);
        allFiles.sort();
        const stride = Math.max(1, Math.floor(allFiles.length / 120));
        const files = allFiles.filter((_, i) => i % stride === 0);
        const maxCases = Number(process.env.ITRDB_COF_CASES ?? 40);

        let attempted = 0;
        const base = { top5: 0, top1: 0, exact: 0 };
        const cof = { top5: 0, top1: 0, exact: 0 };
        let rangeContains = 0;
        const widths: number[] = [];

        for (const file of files) {
            if (attempted >= maxCases) break;
            let parsed: Map<string, Series>;
            try { parsed = parseItrdb(readFileSync(file, "utf8")); } catch { continue; }
            const series = Array.from(parsed.values());
            if (series.length < 6 || series.length > 40) continue; // 跳过过大文件控制 COFECHA 时间
            const target = series.find((s) => (
                s.zeros.length === 1 && s.valuesByYear.size >= 120
                && s.zeros[0] - s.startYear >= 15 && s.endYear - s.zeros[0] >= 15
                && series.filter((o) => o.id !== s.id && overlap(o, s) >= 80).length >= 5
            ));
            if (!target) continue;
            const zeroYear = target.zeros[0];
            const corrupted = reconstructMissingFromZero(target.valuesByYear, zeroYear);
            const site: RwlSiteData = new Map();
            series.forEach((s) => { if (s.id !== target.id) site.set(s.id, new Map(s.valuesByYear) as RwlTreeData); });
            site.set(target.id, corrupted as RwlTreeData);

            const cofechaText = runCofecha(site);
            if (!cofechaText) continue;
            attempted += 1;

            const tally = (acc: typeof base, useCof: boolean) => {
                let cands;
                try { cands = diagnoseCrossdating(site, { referenceConfig: null, cofechaText: useCof ? cofechaText : undefined }).candidates.filter((c) => c.targetTree === target.id); } catch { return; }
                const inserts = cands.filter((c) => c.operationType === "INSERT_MISSING_RING");
                if (inserts.some((c) => Math.abs((c.targetYear ?? 0) - zeroYear) <= 1)) acc.top5 += 1;
                const t = cands[0];
                if (t?.operationType === "INSERT_MISSING_RING" && Math.abs((t.targetYear ?? 0) - zeroYear) <= 1) acc.top1 += 1;
                if (t?.operationType === "INSERT_MISSING_RING" && t.targetYear === zeroYear) acc.exact += 1;
                if (useCof) {
                    const r = inserts.find((c) => c.suggestedRange)?.suggestedRange;
                    if (r) { widths.push(r.endYear - r.startYear + 1); if (zeroYear >= r.startYear - 1 && zeroYear <= r.endYear + 1) rangeContains += 1; }
                }
            };
            tally(base, false);
            tally(cof, true);
        }

        const pct = (n: number) => attempted ? (n / attempted).toFixed(3) : "-";
        const medW = widths.length ? widths.slice().sort((a, b) => a - b)[Math.floor(widths.length / 2)] : 0;
        // eslint-disable-next-line no-console
        console.log(`ITRDB COFECHA attempted=${attempted}`);
        // eslint-disable-next-line no-console
        console.log(`  无COFECHA: top5=${pct(base.top5)} top1=${pct(base.top1)} exact=${pct(base.exact)}`);
        // eslint-disable-next-line no-console
        console.log(`  有COFECHA: top5=${pct(cof.top5)} top1=${pct(cof.top1)} exact=${pct(cof.exact)}`);
        // eslint-disable-next-line no-console
        console.log(`  范围: 含真值=${widths.length ? (rangeContains / widths.length).toFixed(2) : "-"} 中位窗宽=${medW}`);
    }, BENCH_TIMEOUT);

    it("真实多缺轮 迭代全复原（基线，无 COFECHA）", () => {
        const allFiles: string[] = [];
        collectFiles(ITRDB_DIR, allFiles);
        allFiles.sort();
        const sampleCount = Number(process.env.ITRDB_MULTI_FILES ?? 300);
        const stride = Math.max(1, Math.floor(allFiles.length / sampleCount));
        const files = allFiles.filter((_, i) => i % stride === 0).slice(0, sampleCount);
        const maxCases = Number(process.env.ITRDB_MULTI_CASES ?? 80);
        const maxCasesPerFile = 2;
        const maxK = Number(process.env.ITRDB_MULTI_MAXK ?? 5);

        let attempted = 0;
        let totalMissing = 0;
        let restoredSteps = 0;          // 累计单步命中数（±1）
        let fullyRestored = 0;          // 全程每步都 ±1 命中的 case 数
        let reconstructOk = 0;          // 端锚重建/复原自检通过的 case 数
        const fullyByTol: Record<number, number> = { 1: 0, 2: 0, 3: 0, 5: 0 };
        const fracs: number[] = [];

        for (const file of files) {
            if (attempted >= maxCases) break;
            let parsed: Map<string, Series>;
            try { parsed = parseItrdb(readFileSync(file, "utf8")); } catch { continue; }
            const series = Array.from(parsed.values());
            if (series.length < 6) continue;
            const multi = series.filter((s) => {
                const z = s.zeros;
                return z.length >= 2 && z.length <= maxK
                    && s.valuesByYear.size >= 120
                    && z[0] - s.startYear >= 15
                    && s.endYear - z[z.length - 1] >= 15
                    && z.length / s.valuesByYear.size < 0.1; // 排除 0 占位密度异常的序列
            });
            let casesThisFile = 0;
            for (const target of multi) {
                if (casesThisFile >= maxCasesPerFile || attempted >= maxCases) break;
                const refs = series.filter((s) => s.id !== target.id && overlap(s, target) >= 80);
                if (refs.length < 5) continue;

                const zeros = [...target.zeros].sort((a, b) => a - b);
                let corrupted = buildMultiMissingCorrupted(target.valuesByYear, zeros);
                attempted += 1;
                casesThisFile += 1;
                totalMissing += zeros.length;

                // 从最靠树皮（max）到树心（min）逐个复原。每步在"上方已对齐"的帧里诊断，
                // 期望系统首位建议指向当前剩余缺轮的最大年份；按真值推进以隔离每步定位能力。
                const remaining = [...zeros];
                let stepHits = 0;
                let perfect = true;
                const tolPerfect: Record<number, boolean> = { 1: true, 2: true, 3: true, 5: true };

                while (remaining.length > 0) {
                    const zTop = remaining[remaining.length - 1];
                    const site: RwlSiteData = new Map();
                    series.forEach((s) => { if (s.id !== target.id) site.set(s.id, new Map(s.valuesByYear) as RwlTreeData); });
                    site.set(target.id, new Map(corrupted) as RwlTreeData);

                    let cands;
                    try {
                        cands = diagnoseCrossdating(site, { referenceConfig: null }).candidates.filter((c) => c.targetTree === target.id);
                    } catch { perfect = false; break; }

                    const t = cands[0];
                    const isInsert = t?.operationType === "INSERT_MISSING_RING";
                    const dist = isInsert ? Math.abs((t.targetYear ?? 0) - zTop) : Infinity;
                    [1, 2, 3, 5].forEach((tol) => { if (dist > tol) tolPerfect[tol] = false; });
                    if (dist <= 1) stepHits += 1; else perfect = false;

                    corrupted = applyInsertRestore(corrupted, zTop);
                    remaining.pop();
                }

                if (sameSeries(corrupted, target.valuesByYear)) reconstructOk += 1;
                restoredSteps += stepHits;
                fracs.push(stepHits / zeros.length);
                if (perfect) fullyRestored += 1;
                [1, 2, 3, 5].forEach((tol) => { if (tolPerfect[tol]) fullyByTol[tol] += 1; });
            }
        }

        const pct = (n: number) => attempted ? (n / attempted).toFixed(3) : "-";
        const meanFrac = fracs.length ? (fracs.reduce((s, v) => s + v, 0) / fracs.length).toFixed(3) : "-";
        // eslint-disable-next-line no-console
        console.log(`ITRDB MULTI files=${files.length} attempted=${attempted} 缺轮总数=${totalMissing} 自检通过=${reconstructOk}/${attempted}`);
        // eslint-disable-next-line no-console
        console.log(`  完全复原率(全程±1)=${pct(fullyRestored)} (${fullyRestored})  平均每case复原比例=${meanFrac}  单步命中率(±1)=${totalMissing ? (restoredSteps / totalMissing).toFixed(3) : "-"}`);
        // eslint-disable-next-line no-console
        console.log(`  完全复原率多容差: ±1=${pct(fullyByTol[1])} ±2=${pct(fullyByTol[2])} ±3=${pct(fullyByTol[3])} ±5=${pct(fullyByTol[5])}`);
    }, BENCH_TIMEOUT);

    it("真实多缺轮 迭代全复原：有 COFECHA vs 无（每步跑 COFECHA，对齐树皮优先工作流）", () => {
        if (!existsSync(COF_EXE)) return;
        const allFiles: string[] = [];
        collectFiles(ITRDB_DIR, allFiles);
        allFiles.sort();
        const sampleCount = Number(process.env.ITRDB_MULTI_COF_FILES ?? 150);
        const stride = Math.max(1, Math.floor(allFiles.length / sampleCount));
        const files = allFiles.filter((_, i) => i % stride === 0);
        const maxCases = Number(process.env.ITRDB_MULTI_COF_CASES ?? 30);
        const maxK = Number(process.env.ITRDB_MULTI_MAXK ?? 5);

        type Acc = { steps: number; fully: number; tol: Record<number, number> };
        const mkAcc = (): Acc => ({ steps: 0, fully: 0, tol: { 1: 0, 2: 0, 3: 0, 5: 0 } });
        const base = mkAcc();
        const cof = mkAcc();
        let attempted = 0;
        let totalMissing = 0;
        let reconstructOk = 0;

        // 取某次诊断首位建议相对 zTop 的距离（非 INSERT 记 Infinity）。
        const topDist = (cands: ReturnType<typeof diagnoseCrossdating>["candidates"], zTop: number): number => {
            const t = cands[0];
            return t?.operationType === "INSERT_MISSING_RING" ? Math.abs((t.targetYear ?? 0) - zTop) : Infinity;
        };

        for (const file of files) {
            if (attempted >= maxCases) break;
            let parsed: Map<string, Series>;
            try { parsed = parseItrdb(readFileSync(file, "utf8")); } catch { continue; }
            const series = Array.from(parsed.values());
            if (series.length < 6 || series.length > 40) continue; // 控制 COFECHA 时间
            const multi = series.filter((s) => {
                const z = s.zeros;
                return z.length >= 2 && z.length <= maxK
                    && s.valuesByYear.size >= 120
                    && z[0] - s.startYear >= 15
                    && s.endYear - z[z.length - 1] >= 15
                    && z.length / s.valuesByYear.size < 0.1;
            });
            const target = multi.find((s) => series.filter((o) => o.id !== s.id && overlap(o, s) >= 80).length >= 5);
            if (!target) continue;

            const zeros = [...target.zeros].sort((a, b) => a - b);
            let corrupted = buildMultiMissingCorrupted(target.valuesByYear, zeros);
            attempted += 1;
            totalMissing += zeros.length;

            const remaining = [...zeros];
            let baseHits = 0;
            let cofHits = 0;
            let basePerfect = true;
            let cofPerfect = true;
            const basePerfectTol: Record<number, boolean> = { 1: true, 2: true, 3: true, 5: true };
            const cofPerfectTol: Record<number, boolean> = { 1: true, 2: true, 3: true, 5: true };

            while (remaining.length > 0) {
                const zTop = remaining[remaining.length - 1];
                const site: RwlSiteData = new Map();
                series.forEach((s) => { if (s.id !== target.id) site.set(s.id, new Map(s.valuesByYear) as RwlTreeData); });
                site.set(target.id, new Map(corrupted) as RwlTreeData);

                const cofechaText = runCofecha(site);
                let dBase = Infinity;
                let dCof = Infinity;
                try {
                    dBase = topDist(diagnoseCrossdating(site, { referenceConfig: null }).candidates.filter((c) => c.targetTree === target.id), zTop);
                } catch { basePerfect = false; }
                if (cofechaText) {
                    try {
                        dCof = topDist(diagnoseCrossdating(site, { referenceConfig: null, cofechaText }).candidates.filter((c) => c.targetTree === target.id), zTop);
                    } catch { cofPerfect = false; }
                } else {
                    cofPerfect = false; // 没跑出 COFECHA 这步算未命中
                }

                if (dBase <= 1) baseHits += 1; else basePerfect = false;
                if (dCof <= 1) cofHits += 1; else cofPerfect = false;
                [1, 2, 3, 5].forEach((tol) => {
                    if (dBase > tol) basePerfectTol[tol] = false;
                    if (dCof > tol) cofPerfectTol[tol] = false;
                });

                corrupted = applyInsertRestore(corrupted, zTop);
                remaining.pop();
            }

            if (sameSeries(corrupted, target.valuesByYear)) reconstructOk += 1;
            base.steps += baseHits;
            cof.steps += cofHits;
            if (basePerfect) base.fully += 1;
            if (cofPerfect) cof.fully += 1;
            [1, 2, 3, 5].forEach((tol) => {
                if (basePerfectTol[tol]) base.tol[tol] += 1;
                if (cofPerfectTol[tol]) cof.tol[tol] += 1;
            });
        }

        const pct = (n: number) => attempted ? (n / attempted).toFixed(3) : "-";
        const stepPct = (n: number) => totalMissing ? (n / totalMissing).toFixed(3) : "-";
        // eslint-disable-next-line no-console
        console.log(`ITRDB MULTI-COF attempted=${attempted} 缺轮总数=${totalMissing} 自检通过=${reconstructOk}/${attempted}`);
        // eslint-disable-next-line no-console
        console.log(`  无COFECHA: 完全复原(±1)=${pct(base.fully)} 单步命中(±1)=${stepPct(base.steps)} 完全±2=${pct(base.tol[2])} ±3=${pct(base.tol[3])} ±5=${pct(base.tol[5])}`);
        // eslint-disable-next-line no-console
        console.log(`  有COFECHA: 完全复原(±1)=${pct(cof.fully)} 单步命中(±1)=${stepPct(cof.steps)} 完全±2=${pct(cof.tol[2])} ±3=${pct(cof.tol[3])} ±5=${pct(cof.tol[5])}`);
    }, BENCH_TIMEOUT);
});
