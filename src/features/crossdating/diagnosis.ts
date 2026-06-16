import { buildReferenceSeries, type ReferenceSeriesConfig } from "./reference";
import {
    deleteYearWithMode,
    insertMissingYearAtSide,
    moveSeriesTailByOffset,
} from "@/features/rwl/edit";
import { stopMarker } from "@/shared/constants";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";

export type DiagnosisConfidence = "high" | "medium" | "low";

export type DiagnosisCandidateOperationType =
    | "SHIFT_RANGE"
    | "INSERT_MISSING_RING"
    | "DELETE_FALSE_RING"
    | "MARK_SUSPICIOUS";

export type SegmentDiagnosis = {
    targetTree: string;
    startYear: number;
    endYear: number;
    currentCorrelation: number | null;
    bestLag: number;
    bestCorrelation: number | null;
    samplePairs: number;
    flagged: boolean;
    reason: string;
};

export type DiagnosisCandidateOperation = {
    id: string;
    targetTree: string;
    operationType: DiagnosisCandidateOperationType;
    segmentStartYear: number;
    segmentEndYear: number;
    targetYear?: number;
    suggestedLag: number;
    currentCorrelation: number | null;
    expectedCorrelation: number | null;
    delta?: number | null;
    confidence: DiagnosisConfidence;
    side?: "left" | "right";
    shift?: -1 | 1;
    label?: string;
    reason: string;
};

export type DiagnosisBatchCandidateStatus = "applied" | "skipped" | "failed";

export type DiagnosisBatchCandidateResult = {
    candidateId: string;
    targetTree: string;
    label: string;
    status: DiagnosisBatchCandidateStatus;
    reason?: string;
};

export type DiagnosisBatchApplyResult = {
    batchId: string;
    createdAt: string;
    requestedCount: number;
    appliedCount: number;
    skippedCount: number;
    failedCount: number;
    results: DiagnosisBatchCandidateResult[];
};

export type DiagnosisBatchSelection = {
    selected: DiagnosisCandidateOperation[];
    skipped: DiagnosisBatchCandidateResult[];
};

export type SeriesDiagnosisSummary = {
    tree: string;
    segmentCount: number;
    flaggedSegmentCount: number;
    bestLagSuggestion: number;
    meanCorrelation: number | null;
    worstCorrelation: number | null;
    candidateCount: number;
};

export type CrossdatingDiagnosis = {
    createdAt: string;
    seriesCount: number;
    problemSegmentCount: number;
    candidateCount: number;
    segmentLength: number;
    overlap: number;
    lagRange: { min: number; max: number };
    lowCorrelationThreshold: number;
    summaries: SeriesDiagnosisSummary[];
    segments: SegmentDiagnosis[];
    candidates: DiagnosisCandidateOperation[];
};

export type LocalSimulationOperationType =
    | "INSERT_MISSING_RING"
    | "DELETE_FALSE_RING"
    | "SHIFT_RANGE"
    | "NO_ACTION";

export type LocalSimulationOption = {
    operationType: LocalSimulationOperationType;
    label: string;
    currentCorrelation: number | null;
    simulatedCorrelation: number | null;
    delta: number | null;
    confidence: DiagnosisConfidence;
    side?: "left" | "right";
    shift?: -1 | 1;
    reason: string;
};

export type LocalCrossdatingSimulation = {
    targetTree: string;
    year: number;
    segmentStartYear: number;
    segmentEndYear: number;
    samplePairs: number;
    currentCorrelation: number | null;
    bestOption: LocalSimulationOption;
    options: LocalSimulationOption[];
};

export type LocalSimulationApplyRequest = {
    simulation: LocalCrossdatingSimulation;
    option: LocalSimulationOption;
};

type DiagnosisOptions = {
    referenceConfig?: ReferenceSeriesConfig | null;
    segmentLength?: number;
    overlap?: number;
    lagMin?: number;
    lagMax?: number;
    lowCorrelationThreshold?: number;
    lagImprovementThreshold?: number;
};

type NumericSeries = Map<number, number>;

const DEFAULT_LAG_MIN = -10;
const DEFAULT_LAG_MAX = 10;
const DEFAULT_LOW_CORRELATION_THRESHOLD = 0.25;
const DEFAULT_LAG_IMPROVEMENT_THRESHOLD = 0.2;
const DEFAULT_SIMULATION_IMPROVEMENT_THRESHOLD = 0.12;
const MIN_SEGMENT_LENGTH = 30;
const DEFAULT_SEGMENT_LENGTH = 50;
const DEFAULT_OVERLAP = 25;
const MIN_PAIRS_FOR_CORRELATION = 8;

const isUsableWidth = (value: number | null | undefined): value is number => (
    typeof value === "number"
    && Number.isFinite(value)
    && value > 0
    && value !== stopMarker.value
);

const toNumericSeries = (treeData: RwlTreeData | undefined): NumericSeries => {
    const result = new Map<number, number>();
    treeData?.forEach((value, year) => {
        if (isUsableWidth(value)) {
            result.set(year, value);
        }
    });
    return result;
};

const zScoreSeries = (series: NumericSeries): NumericSeries => {
    const values = Array.from(series.values());
    if (values.length === 0) return new Map();

    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const sd = Math.sqrt(variance);
    if (!Number.isFinite(sd) || sd === 0) {
        return new Map(Array.from(series.keys()).map((year) => [year, 0]));
    }

    return new Map(Array.from(series.entries()).map(([year, value]) => [year, (value - mean) / sd]));
};

const firstDifference = (series: NumericSeries): NumericSeries => {
    const entries = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
    const result = new Map<number, number>();

    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) {
            result.set(year, value - previousValue);
        }
    }

    return result;
};

const preprocessSeries = (series: NumericSeries): NumericSeries => (
    zScoreSeries(firstDifference(zScoreSeries(series)))
);

const pearson = (pairs: Array<[number, number]>): number | null => {
    if (pairs.length < MIN_PAIRS_FOR_CORRELATION) return null;

    const meanA = pairs.reduce((sum, [a]) => sum + a, 0) / pairs.length;
    const meanB = pairs.reduce((sum, [, b]) => sum + b, 0) / pairs.length;
    let numerator = 0;
    let denominatorA = 0;
    let denominatorB = 0;

    pairs.forEach(([a, b]) => {
        const da = a - meanA;
        const db = b - meanB;
        numerator += da * db;
        denominatorA += da * da;
        denominatorB += db * db;
    });

    const denominator = Math.sqrt(denominatorA * denominatorB);
    if (!Number.isFinite(denominator) || denominator === 0) return null;
    return numerator / denominator;
};

const correlationForSegment = (
    target: NumericSeries,
    master: NumericSeries,
    startYear: number,
    endYear: number,
    lag: number,
) => {
    const pairs: Array<[number, number]> = [];

    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const masterValue = master.get(year + lag);
        if (targetValue !== undefined && masterValue !== undefined) {
            pairs.push([targetValue, masterValue]);
        }
    }

    return {
        correlation: pearson(pairs),
        samplePairs: pairs.length,
    };
};

const buildMeanMaster = (
    siteData: RwlSiteData,
    sourceTrees: string[],
): NumericSeries => {
    const valuesByYear = new Map<number, number[]>();

    sourceTrees.forEach((tree) => {
        toNumericSeries(siteData.get(tree)).forEach((value, year) => {
            const values = valuesByYear.get(year);
            if (values) {
                values.push(value);
            } else {
                valuesByYear.set(year, [value]);
            }
        });
    });

    return new Map(Array.from(valuesByYear.entries()).map(([year, values]) => [
        year,
        values.reduce((sum, value) => sum + value, 0) / values.length,
    ]));
};

const getReferenceMaster = (
    siteData: RwlSiteData,
    targetTree: string,
    referenceConfig: ReferenceSeriesConfig | null | undefined,
) => {
    if (!referenceConfig) return null;

    const selectedTrees = referenceConfig.selectedTrees.filter((tree) => (
        tree !== targetTree && siteData.has(tree)
    ));
    const config = selectedTrees.length > 0
        ? { ...referenceConfig, selectedTrees }
        : referenceConfig.selectedTrees.includes(targetTree)
            ? null
            : referenceConfig;

    if (!config) return null;
    const reference = buildReferenceSeries(siteData, config);
    return reference?.data ?? null;
};

const getAdaptiveSegmentLength = (siteData: RwlSiteData) => {
    const lengths = Array.from(siteData.values()).map((treeData) => (
        Array.from(treeData.values()).filter(isUsableWidth).length
    )).filter((length) => length > 0);

    if (lengths.length === 0) return DEFAULT_SEGMENT_LENGTH;
    const averageLength = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
    if (averageLength < 100) {
        return Math.max(MIN_SEGMENT_LENGTH, Math.floor(averageLength / 2));
    }
    return DEFAULT_SEGMENT_LENGTH;
};

const createSegmentsForSeries = (series: NumericSeries, segmentLength: number, overlap: number) => {
    const years = Array.from(series.keys()).sort((a, b) => a - b);
    if (years.length === 0) return [];

    const minYear = years[0];
    const maxYear = years[years.length - 1];
    const step = Math.max(1, segmentLength - overlap);
    const segments: Array<{ startYear: number; endYear: number }> = [];

    for (let startYear = minYear; startYear <= maxYear; startYear += step) {
        const endYear = Math.min(startYear + segmentLength - 1, maxYear);
        if (endYear - startYear + 1 >= Math.min(MIN_SEGMENT_LENGTH, segmentLength)) {
            segments.push({ startYear, endYear });
        }
        if (endYear === maxYear) break;
    }

    return segments;
};

const confidenceFor = (current: number | null, best: number | null, bestLag: number): DiagnosisConfidence => {
    if (best === null) return "low";
    const improvement = best - (current ?? -1);
    if (bestLag !== 0 && best >= 0.45 && improvement >= 0.35) return "high";
    if (bestLag !== 0 && best >= 0.3 && improvement >= 0.2) return "medium";
    return "low";
};

const nearestExistingYear = (
    years: number[],
    targetYear: number,
    startYear: number,
    endYear: number,
): number | null => {
    let bestYear: number | null = null;
    let bestDistance = Infinity;

    years.forEach((year) => {
        if (year < startYear || year > endYear) return;
        const distance = Math.abs(year - targetYear);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestYear = year;
        }
    });

    return bestYear;
};

const getSimulationProbeYears = (
    rawTarget: NumericSeries,
    startYear: number,
    endYear: number,
): number[] => {
    const years = Array.from(rawTarget.keys()).sort((a, b) => a - b);
    const midpoint = Math.round((startYear + endYear) / 2);
    const probes = [startYear, midpoint, endYear]
        .map((year) => nearestExistingYear(years, year, startYear, endYear))
        .filter((year): year is number => year !== null);

    return Array.from(new Set(probes));
};

const confidenceForLocalSimulation = (
    current: number | null,
    simulated: number | null,
): DiagnosisConfidence => {
    if (simulated === null) return "low";
    const improvement = simulated - (current ?? -1);
    if (simulated >= 0.45 && improvement >= 0.3) return "high";
    if (simulated >= 0.3 && improvement >= 0.15) return "medium";
    return "low";
};

const createLocalSimulationOption = (
    operationType: LocalSimulationOperationType,
    label: string,
    currentCorrelation: number | null,
    simulatedCorrelation: number | null,
    reason: string,
    extra: Pick<LocalSimulationOption, "side" | "shift"> = {},
): LocalSimulationOption => {
    const delta = simulatedCorrelation === null ? null : simulatedCorrelation - (currentCorrelation ?? -1);
    return {
        operationType,
        label,
        currentCorrelation,
        simulatedCorrelation,
        delta,
        confidence: confidenceForLocalSimulation(currentCorrelation, simulatedCorrelation),
        reason,
        ...extra,
    };
};

const createCandidateFromLocalSimulation = (
    simulation: LocalCrossdatingSimulation,
    flaggedReason: string,
): DiagnosisCandidateOperation | null => {
    const option = simulation.bestOption;
    if (
        option.operationType === "NO_ACTION"
        || option.delta === null
        || option.delta < DEFAULT_SIMULATION_IMPROVEMENT_THRESHOLD
    ) {
        return null;
    }

    if (option.operationType === "INSERT_MISSING_RING" && !option.side) return null;
    if (option.operationType === "DELETE_FALSE_RING" && !option.side) return null;
    if (option.operationType === "SHIFT_RANGE" && !option.shift) return null;

    return {
        id: [
            simulation.targetTree,
            simulation.segmentStartYear,
            simulation.segmentEndYear,
            simulation.year,
            option.operationType,
            option.side ?? option.shift ?? 0,
        ].join(":"),
        targetTree: simulation.targetTree,
        operationType: option.operationType,
        segmentStartYear: simulation.segmentStartYear,
        segmentEndYear: simulation.segmentEndYear,
        targetYear: simulation.year,
        suggestedLag: option.shift ?? 0,
        currentCorrelation: option.currentCorrelation,
        expectedCorrelation: option.simulatedCorrelation,
        delta: option.delta,
        confidence: option.confidence,
        side: option.side,
        shift: option.shift,
        label: option.label,
        reason: `${flaggedReason}；${option.reason}`,
    };
};

export const getDiagnosisCandidateLabel = (candidate: DiagnosisCandidateOperation): string => {
    if (candidate.label) return candidate.label;
    if (candidate.operationType === "INSERT_MISSING_RING") return "插入缺轮";
    if (candidate.operationType === "DELETE_FALSE_RING") return "删除伪轮";
    if (candidate.operationType === "SHIFT_RANGE") {
        const shift = candidate.shift ?? candidate.suggestedLag;
        return `平移 ${shift > 0 ? "+" : ""}${shift} 年`;
    }
    return "标记可疑";
};

export const isActionableDiagnosisCandidate = (candidate: DiagnosisCandidateOperation): boolean => {
    if (candidate.operationType === "SHIFT_RANGE") {
        return candidate.suggestedLag !== 0 || Boolean(candidate.shift);
    }
    if (candidate.operationType === "INSERT_MISSING_RING" || candidate.operationType === "DELETE_FALSE_RING") {
        return candidate.targetYear !== undefined && Boolean(candidate.side);
    }
    return false;
};

const compareDiagnosisCandidates = (
    a: DiagnosisCandidateOperation,
    b: DiagnosisCandidateOperation,
) => {
    const actionablePriority = Number(isActionableDiagnosisCandidate(b)) - Number(isActionableDiagnosisCandidate(a));
    if (actionablePriority !== 0) return actionablePriority;

    const confidenceOrder = { high: 0, medium: 1, low: 2 };
    const confidencePriority = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
    if (confidencePriority !== 0) return confidencePriority;

    const deltaPriority = (b.delta ?? -Infinity) - (a.delta ?? -Infinity);
    if (deltaPriority !== 0) return deltaPriority;

    return a.targetTree.localeCompare(b.targetTree)
        || a.segmentStartYear - b.segmentStartYear
        || (a.targetYear ?? a.segmentStartYear) - (b.targetYear ?? b.segmentStartYear)
        || a.operationType.localeCompare(b.operationType);
};

const getCandidateEffectKey = (candidate: DiagnosisCandidateOperation): string => {
    if (candidate.operationType === "SHIFT_RANGE") {
        const startYear = candidate.targetYear ?? candidate.segmentStartYear;
        const shift = candidate.shift ?? candidate.suggestedLag;
        return [
            candidate.operationType,
            candidate.targetTree,
            startYear,
            candidate.segmentEndYear,
            shift,
        ].join(":");
    }

    if (candidate.operationType === "INSERT_MISSING_RING" || candidate.operationType === "DELETE_FALSE_RING") {
        return [
            candidate.operationType,
            candidate.targetTree,
            candidate.targetYear ?? candidate.segmentStartYear,
            candidate.side ?? "",
        ].join(":");
    }

    return [
        candidate.operationType,
        candidate.targetTree,
        candidate.segmentStartYear,
        candidate.segmentEndYear,
    ].join(":");
};

const dedupeDiagnosisCandidates = (
    candidates: DiagnosisCandidateOperation[],
): DiagnosisCandidateOperation[] => {
    const bestByEffect = new Map<string, DiagnosisCandidateOperation>();

    candidates.forEach((candidate) => {
        const key = getCandidateEffectKey(candidate);
        const current = bestByEffect.get(key);
        if (!current || compareDiagnosisCandidates(candidate, current) < 0) {
            bestByEffect.set(key, candidate);
        }
    });

    return Array.from(bestByEffect.values());
};

export const selectSafeDiagnosisCandidateBatch = (
    candidates: DiagnosisCandidateOperation[],
): DiagnosisBatchSelection => {
    const selected: DiagnosisCandidateOperation[] = [];
    const skipped: DiagnosisBatchCandidateResult[] = [];
    const usedTrees = new Set<string>();

    candidates.forEach((candidate) => {
        if (!isActionableDiagnosisCandidate(candidate)) {
            skipped.push({
                candidateId: candidate.id,
                targetTree: candidate.targetTree,
                label: getDiagnosisCandidateLabel(candidate),
                status: "skipped",
                reason: "该候选仅用于标记可疑段，未生成可直接应用的编辑操作。",
            });
            return;
        }

        if (usedTrees.has(candidate.targetTree)) {
            skipped.push({
                candidateId: candidate.id,
                targetTree: candidate.targetTree,
                label: getDiagnosisCandidateLabel(candidate),
                status: "skipped",
                reason: "同一批次已包含该序列的更高优先级候选；请应用后重新诊断再继续。",
            });
            return;
        }

        usedTrees.add(candidate.targetTree);
        selected.push(candidate);
    });

    return { selected, skipped };
};

const getMasterForTarget = (
    siteData: RwlSiteData,
    targetTree: string,
    referenceConfig: ReferenceSeriesConfig | null | undefined,
) => {
    const referenceMaster = getReferenceMaster(siteData, targetTree, referenceConfig);
    return referenceMaster ?? buildMeanMaster(
        siteData,
        Array.from(siteData.keys()).filter((tree) => tree !== targetTree),
    );
};

export function simulateLocalCrossdating(
    siteData: RwlSiteData,
    targetTree: string,
    year: number,
    options: DiagnosisOptions = {},
): LocalCrossdatingSimulation | null {
    const treeData = siteData.get(targetTree);
    if (!treeData) return null;

    const numericTarget = toNumericSeries(treeData);
    const targetYears = Array.from(numericTarget.keys()).sort((a, b) => a - b);
    if (targetYears.length === 0) return null;

    const segmentLength = options.segmentLength ?? Math.min(getAdaptiveSegmentLength(siteData), 50);
    const halfWindow = Math.floor(segmentLength / 2);
    const minYear = targetYears[0];
    const maxYear = targetYears[targetYears.length - 1];
    const segmentStartYear = Math.max(minYear, year - halfWindow);
    const segmentEndYear = Math.min(maxYear, segmentStartYear + segmentLength - 1);
    const master = preprocessSeries(getMasterForTarget(siteData, targetTree, options.referenceConfig));
    if (master.size === 0) return null;

    const measure = (nextTreeData: RwlTreeData) => (
        correlationForSegment(
            preprocessSeries(toNumericSeries(nextTreeData)),
            master,
            segmentStartYear,
            segmentEndYear,
            0,
        )
    );

    const current = measure(treeData);
    const simulatedOptions = [
        createLocalSimulationOption(
            "INSERT_MISSING_RING",
            "插入缺轮（左侧）",
            current.correlation,
            measure(insertMissingYearAtSide(treeData, year, "left")).correlation,
            "模拟在该年左侧插入 missing ring",
            { side: "left" },
        ),
        createLocalSimulationOption(
            "INSERT_MISSING_RING",
            "插入缺轮（右侧）",
            current.correlation,
            measure(insertMissingYearAtSide(treeData, year, "right")).correlation,
            "模拟在该年右侧插入 missing ring",
            { side: "right" },
        ),
        createLocalSimulationOption(
            "DELETE_FALSE_RING",
            "删除该年（左靠）",
            current.correlation,
            measure(deleteYearWithMode(treeData, year, "direct", "left")).correlation,
            "模拟删除该年并让右侧年份左靠",
            { side: "left" },
        ),
        createLocalSimulationOption(
            "DELETE_FALSE_RING",
            "删除该年（右靠）",
            current.correlation,
            measure(deleteYearWithMode(treeData, year, "direct", "right")).correlation,
            "模拟删除该年并让左侧年份右靠",
            { side: "right" },
        ),
        createLocalSimulationOption(
            "SHIFT_RANGE",
            "从该年起左移 1 年",
            current.correlation,
            measure(moveSeriesTailByOffset(treeData, year, segmentEndYear, -1)).correlation,
            "模拟把该年至局部窗口末端整体左移一年",
            { shift: -1 },
        ),
        createLocalSimulationOption(
            "SHIFT_RANGE",
            "从该年起右移 1 年",
            current.correlation,
            measure(moveSeriesTailByOffset(treeData, year, segmentEndYear, 1)).correlation,
            "模拟把该年至局部窗口末端整体右移一年",
            { shift: 1 },
        ),
    ];

    const bestOption = simulatedOptions
        .filter((option) => option.simulatedCorrelation !== null)
        .sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity))[0]
        ?? createLocalSimulationOption(
            "NO_ACTION",
            "暂无建议",
            current.correlation,
            current.correlation,
            "当前局部窗口样本对不足或无明显改善",
        );

    return {
        targetTree,
        year,
        segmentStartYear,
        segmentEndYear,
        samplePairs: current.samplePairs,
        currentCorrelation: current.correlation,
        bestOption,
        options: simulatedOptions,
    };
}

export function diagnoseCrossdating(
    siteData: RwlSiteData,
    options: DiagnosisOptions = {},
): CrossdatingDiagnosis {
    const segmentLength = options.segmentLength ?? getAdaptiveSegmentLength(siteData);
    const overlap = options.overlap ?? Math.min(DEFAULT_OVERLAP, Math.floor(segmentLength / 2));
    const lagMin = options.lagMin ?? DEFAULT_LAG_MIN;
    const lagMax = options.lagMax ?? DEFAULT_LAG_MAX;
    const lowCorrelationThreshold = options.lowCorrelationThreshold ?? DEFAULT_LOW_CORRELATION_THRESHOLD;
    const lagImprovementThreshold = options.lagImprovementThreshold ?? DEFAULT_LAG_IMPROVEMENT_THRESHOLD;
    const treeCodes = Array.from(siteData.keys());
    const segments: SegmentDiagnosis[] = [];
    const candidates: DiagnosisCandidateOperation[] = [];
    const candidateIds = new Set<string>();
    const summaries: SeriesDiagnosisSummary[] = [];

    treeCodes.forEach((targetTree) => {
        const rawTarget = toNumericSeries(siteData.get(targetTree));
        const target = preprocessSeries(rawTarget);
        if (target.size === 0) return;

        const referenceMaster = getReferenceMaster(siteData, targetTree, options.referenceConfig);
        const masterSource = referenceMaster ?? buildMeanMaster(
            siteData,
            treeCodes.filter((tree) => tree !== targetTree),
        );
        const master = preprocessSeries(masterSource);
        if (master.size === 0) return;

        const seriesSegments = createSegmentsForSeries(target, segmentLength, overlap).map(({ startYear, endYear }) => {
            const current = correlationForSegment(target, master, startYear, endYear, 0);
            let bestLag = 0;
            let bestCorrelation = current.correlation;
            let bestPairs = current.samplePairs;

            for (let lag = lagMin; lag <= lagMax; lag += 1) {
                const result = correlationForSegment(target, master, startYear, endYear, lag);
                if (result.correlation !== null && (bestCorrelation === null || result.correlation > bestCorrelation)) {
                    bestLag = lag;
                    bestCorrelation = result.correlation;
                    bestPairs = result.samplePairs;
                }
            }

            const improvement = bestCorrelation === null ? 0 : bestCorrelation - (current.correlation ?? -1);
            const lowCorrelation = current.correlation !== null && current.correlation < lowCorrelationThreshold;
            const lagLooksBetter = bestLag !== 0 && improvement >= lagImprovementThreshold;
            const weakEvidence = current.samplePairs < MIN_PAIRS_FOR_CORRELATION;
            const flagged = !weakEvidence && (lowCorrelation || lagLooksBetter);
            const reason = weakEvidence
                ? "样本对不足，暂不判定"
                : lagLooksBetter
                    ? `lag ${bestLag > 0 ? "+" : ""}${bestLag} 相关更高`
                    : lowCorrelation
                        ? "当前分段相关偏低"
                        : "未发现明显问题";

            const segment: SegmentDiagnosis = {
                targetTree,
                startYear,
                endYear,
                currentCorrelation: current.correlation,
                bestLag,
                bestCorrelation,
                samplePairs: bestPairs,
                flagged,
                reason,
            };

            if (flagged) {
                const operationType: DiagnosisCandidateOperationType = bestLag !== 0
                    ? "SHIFT_RANGE"
                    : "MARK_SUSPICIOUS";
                const lagCandidate: DiagnosisCandidateOperation = {
                    id: `${targetTree}:${startYear}-${endYear}:${bestLag}`,
                    targetTree,
                    operationType,
                    segmentStartYear: startYear,
                    segmentEndYear: endYear,
                    suggestedLag: bestLag,
                    currentCorrelation: current.correlation,
                    expectedCorrelation: bestCorrelation,
                    delta: bestCorrelation === null ? null : bestCorrelation - (current.correlation ?? -1),
                    confidence: confidenceFor(current.correlation, bestCorrelation, bestLag),
                    reason,
                };
                candidates.push(lagCandidate);
                candidateIds.add(lagCandidate.id);

                getSimulationProbeYears(rawTarget, startYear, endYear).forEach((year) => {
                    const simulation = simulateLocalCrossdating(siteData, targetTree, year, {
                        ...options,
                        segmentLength,
                        overlap,
                    });
                    const simulationCandidate = simulation
                        ? createCandidateFromLocalSimulation(simulation, reason)
                        : null;
                    if (!simulationCandidate || candidateIds.has(simulationCandidate.id)) return;

                    candidates.push(simulationCandidate);
                    candidateIds.add(simulationCandidate.id);
                });
            }

            return segment;
        });

        segments.push(...seriesSegments);

        const validCorrelations = seriesSegments
            .map((segment) => segment.currentCorrelation)
            .filter((value): value is number => value !== null);
        const flaggedSegments = seriesSegments.filter((segment) => segment.flagged);
        const candidateCount = candidates.filter((candidate) => candidate.targetTree === targetTree).length;
        const lagVotes = flaggedSegments.reduce((votes, segment) => {
            if (segment.bestLag !== 0) {
                votes.set(segment.bestLag, (votes.get(segment.bestLag) ?? 0) + 1);
            }
            return votes;
        }, new Map<number, number>());
        const bestLagSuggestion = Array.from(lagVotes.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;

        summaries.push({
            tree: targetTree,
            segmentCount: seriesSegments.length,
            flaggedSegmentCount: flaggedSegments.length,
            bestLagSuggestion,
            meanCorrelation: validCorrelations.length
                ? validCorrelations.reduce((sum, value) => sum + value, 0) / validCorrelations.length
                : null,
            worstCorrelation: validCorrelations.length ? Math.min(...validCorrelations) : null,
            candidateCount,
        });
    });

    const uniqueCandidates = dedupeDiagnosisCandidates(candidates).sort(compareDiagnosisCandidates);
    const candidateCountByTree = uniqueCandidates.reduce((counts, candidate) => {
        counts.set(candidate.targetTree, (counts.get(candidate.targetTree) ?? 0) + 1);
        return counts;
    }, new Map<string, number>());

    return {
        createdAt: new Date().toISOString(),
        seriesCount: treeCodes.length,
        problemSegmentCount: segments.filter((segment) => segment.flagged).length,
        candidateCount: uniqueCandidates.length,
        segmentLength,
        overlap,
        lagRange: { min: lagMin, max: lagMax },
        lowCorrelationThreshold,
        summaries: summaries.map((summary) => ({
            ...summary,
            candidateCount: candidateCountByTree.get(summary.tree) ?? 0,
        })),
        segments,
        candidates: uniqueCandidates,
    };
}
