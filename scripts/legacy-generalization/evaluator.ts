import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
    extractPart6FlaggedASeriesIds,
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis/types";
import {
    cofechaStyleStandardize,
    createCofechaMasterReferenceConfig,
    createCofechaPassReferenceConfig,
} from "@/features/crossdating/reference";
import {
    createEndAnchoredFalseRingCase,
    createEndAnchoredMissingRingCase,
    createPartialRangeMoveCase,
    createPiecewiseLagMixedCase,
    createWholeSeriesMoveCase,
    type RwlSeries,
} from "@/features/crossdating/diagnosis/__tests__/rdmFixture";
import {
    deleteYearWithMode,
    getSeriesMoveConflicts,
    insertMissingYearAtSide,
    moveSeriesTailByOffset,
} from "@/features/rwl/edit";
import { formatHandlers, readRwlString } from "@/features/rwl";
import type {
    RwlFormat,
    RwlReadResult,
    RwlSiteData,
    RwlTreeData,
} from "@/features/rwl/types";
import type {
    LegacyCaseRow,
    LegacyConfig,
    LegacyDiagnosisSnapshot,
    LegacyFilePlan,
    LegacyQualityMetrics,
    LegacyScenarioPlan,
    LegacyTruthSpec,
} from "./types";

export type LoadedRwl = {
    sourceText: string;
    sourceSha256: string;
    readResult: RwlReadResult;
    siteData: RwlSiteData;
    series: Map<string, RwlSeries>;
};

export type CofechaContext = {
    stateDir: string;
    sitePath: string;
    outPath: string;
    outText: string;
    flaggedIds: string[];
    rwlHash: string;
};

export const sha256Bytes = (value: string | Buffer): string => createHash("sha256")
    .update(value).digest("hex");

export const cloneSite = (siteData: RwlSiteData): RwlSiteData => new Map(
    Array.from(siteData, ([seriesId, values]) => [seriesId, new Map(values)]),
);

const observedSite = (siteData: RwlSiteData): RwlSiteData => new Map(
    Array.from(siteData, ([seriesId, values]) => [
        seriesId,
        new Map(Array.from(values).flatMap(([year, value]) => (
            typeof value === "number" && value !== -9999
                ? [[year, value] as [number, number]]
                : []
        ))),
    ]),
);

export const siteHash = (siteData: RwlSiteData): string => sha256Bytes(JSON.stringify(
    Array.from(siteData, ([seriesId, values]) => [
        seriesId,
        Array.from(values).filter((row): row is [number, number] => (
            typeof row[1] === "number" && row[1] !== -9999
        )).sort((left, right) => left[0] - right[0]),
    ]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
));

export const readRwlForEvaluation = async (
    sourceText: string,
    declaredFormat?: string,
): Promise<RwlReadResult> => {
    const preferFormat: RwlFormat | undefined = declaredFormat === "tucson-auto"
        ? "tucson"
        : undefined;
    return readRwlString(sourceText, { edgeZeros: true, preferFormat });
};

export const loadRwl = async (
    path: string,
    declaredFormat?: string,
): Promise<LoadedRwl> => {
    const bytes = readFileSync(path);
    const sourceText = bytes.toString("utf8");
    const readResult = await readRwlForEvaluation(sourceText, declaredFormat);
    const series = new Map(Array.from(readResult.data, ([id, valuesByYear]) => {
        const years = Array.from(valuesByYear.keys());
        const zeroCount = Array.from(valuesByYear.values()).filter((value) => value === 0).length;
        return [id, {
            id,
            valuesByYear: new Map(Array.from(valuesByYear).flatMap(([year, value]) => (
                typeof value === "number" ? [[year, value] as [number, number]] : []
            ))),
            startYear: Math.min(...years),
            endYear: Math.max(...years),
            length: valuesByYear.size,
            nonZeroCount: valuesByYear.size - zeroCount,
            zeroCount,
        }];
    }));
    return {
        sourceText,
        sourceSha256: sha256Bytes(bytes),
        readResult,
        siteData: observedSite(readResult.data),
        series,
    };
};

export const formatLikeSource = (
    siteData: RwlSiteData,
    readResult: RwlReadResult,
): string => {
    const handler = formatHandlers[readResult.format];
    if (!handler?.format) throw new Error(`format unavailable: ${readResult.format}`);
    return handler.format(siteData, readResult.readOptions);
};

export const reopenFormattedSite = async (
    siteData: RwlSiteData,
    readResult: RwlReadResult,
): Promise<RwlSiteData> => {
    const reopened = await readRwlString(formatLikeSource(siteData, readResult), {
        edgeZeros: true,
        preferFormat: readResult.format === "unknown" ? undefined : readResult.format,
    });
    return observedSite(reopened.data);
};

export const runCofecha = (input: {
    siteData: RwlSiteData;
    readResult: RwlReadResult;
    workDir: string;
    label: string;
    cofechaExe: string;
    timeoutSeconds: number;
}): CofechaContext => {
    const stateDir = join(input.workDir, input.label);
    rmSync(stateDir, { force: true, recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const sitePath = join(stateDir, "state.rwl");
    const outPath = join(stateDir, "VERYCOF.OUT");
    writeFileSync(sitePath, formatLikeSource(input.siteData, input.readResult), "utf8");
    execFileSync(input.cofechaExe, [], {
        cwd: stateDir,
        input: "very\nstate.rwl\n\n\n\n\n\n\n",
        timeout: input.timeoutSeconds * 1000,
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
    });
    const outText = readFileSync(outPath, "utf8");
    const parts = splitReportByParts(outText);
    const canonical = new Map(Array.from(input.siteData.keys(), (seriesId) => [
        seriesId.trim().toUpperCase(),
        seriesId,
    ]));
    const flaggedIds = extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? "")
        .flatMap((seriesId) => {
            const resolved = canonical.get(seriesId.trim().toUpperCase());
            return resolved ? [resolved] : [];
        });
    return {
        stateDir,
        sitePath,
        outPath,
        outText,
        flaggedIds,
        rwlHash: sha256Bytes(readFileSync(sitePath)),
    };
};

const candidateAudit = (candidate: Record<string, unknown>) => ({
    id: candidate.id ?? null,
    operationType: candidate.operationType ?? null,
    mode: candidate.mode ?? null,
    targetTree: candidate.targetTree ?? null,
    targetYear: candidate.targetYear ?? null,
    suggestedLag: candidate.suggestedLag ?? null,
    deltaYears: candidate.deltaYears ?? null,
    score: candidate.score ?? null,
    algorithmSource: candidate.algorithmSource ?? null,
});

export const diagnoseTruthBlind = (input: {
    siteData: RwlSiteData;
    targetId: string;
    context: CofechaContext;
    runId: string;
}): LegacyDiagnosisSnapshot => {
    const started = performance.now();
    try {
        const targetExcludedFlags = new Set([...input.context.flaggedIds, input.targetId]);
        let referenceConfig = createCofechaPassReferenceConfig({
            siteData: input.siteData,
            flaggedAIds: targetExcludedFlags,
            cofechaRunId: `${input.runId}-${input.targetId}`,
            rwlHash: input.context.rwlHash,
        });
        let referenceMode: LegacyDiagnosisSnapshot["referenceMode"] =
            "cofecha-pass-leave-one-out";
        if (!referenceConfig.cofechaPassReference) {
            referenceMode = "cofecha-master-leave-one-out";
            referenceConfig = createCofechaMasterReferenceConfig({
                siteData: input.siteData,
                flaggedAIds: targetExcludedFlags,
                cofechaRunId: `${input.runId}-${input.targetId}`,
                rwlHash: input.context.rwlHash,
                masterDatingSeries: parseCofechaResult(
                    input.context.outText,
                ).masterDatingSeries,
            });
        }
        if (referenceConfig.cofechaPassReference?.includedSeriesIds.includes(input.targetId)) {
            throw new Error(`target leaked into reference: ${input.targetId}`);
        }
        const diagnosis = diagnoseCrossdating(input.siteData, {
            referenceConfig,
            targetTrees: [input.targetId],
            cofechaText: input.context.outText,
            includeEventDecisionAudits: true,
            reviewWindowDisplayMode: "review",
        });
        return {
            strictEvent: diagnosis.events[0] ?? null,
            reviewEvent: diagnosis.reviewEvents?.[0] ?? null,
            candidates: diagnosis.candidates.map((candidate) => candidateAudit(
                candidate as unknown as Record<string, unknown>,
            )),
            audit: diagnosis.eventDecisionAudits?.[0] ?? null,
            reviewDecision: diagnosis.reviewWindowDecisions?.[0] ?? null,
            referenceMode,
            referenceAnchorCount:
                referenceConfig.cofechaPassReference?.summary.includedCount
                ?? 0,
            durationMs: Math.round(performance.now() - started),
            error: null,
        };
    } catch (error) {
        return {
            strictEvent: null,
            reviewEvent: null,
            candidates: [],
            audit: null,
            reviewDecision: null,
            referenceMode: "cofecha-pass-leave-one-out",
            referenceAnchorCount: 0,
            durationMs: Math.round(performance.now() - started),
            error: error instanceof Error ? error.stack ?? error.message : String(error),
        };
    }
};

const treeRange = (tree: RwlTreeData): { startYear: number; endYear: number } => {
    const years = Array.from(tree.keys());
    return { startYear: Math.min(...years), endYear: Math.max(...years) };
};

export const buildScenarioSite = (
    cleanSite: RwlSiteData,
    cleanSeries: Map<string, RwlSeries>,
    scenario: LegacyScenarioPlan,
): RwlSiteData => {
    const site = cloneSite(cleanSite);
    const source = cleanSeries.get(scenario.targetId);
    if (!source) throw new Error(`target missing: ${scenario.targetId}`);
    const truths = scenario.truths;
    if (scenario.kind === "clean") return site;
    if (scenario.kind === "singleMissingRing" || scenario.kind === "endpointCropped") {
        let target = source;
        if (scenario.kind === "endpointCropped") {
            const cropYears = Number(scenario.parameters.cropOlderYears ?? 0);
            const croppedValues = new Map(Array.from(source.valuesByYear).filter(([year]) => (
                year >= source.startYear + cropYears
            )));
            target = {
                ...source,
                valuesByYear: croppedValues,
                startYear: source.startYear + cropYears,
                length: croppedValues.size,
                nonZeroCount: croppedValues.size,
            };
        }
        site.set(
            source.id,
            createEndAnchoredMissingRingCase(target, truths[0].year!).corrupted,
        );
        return site;
    }
    if (scenario.kind === "singleFalseRing") {
        site.set(source.id, createEndAnchoredFalseRingCase(
            source,
            truths[0].year!,
            String(scenario.parameters.falseRingMode ?? "moderate") as
                "average" | "moderate" | "splitLike",
        ).corrupted);
        return site;
    }
    if (scenario.kind === "singlePartialMove" || scenario.kind === "contiguousBlock") {
        site.set(source.id, createPartialRangeMoveCase(
            source,
            truths[0].year!,
            Math.abs(truths[0].shiftYears),
        ).corrupted);
        return site;
    }
    if (scenario.kind === "wholeSeriesMove") {
        site.set(source.id, createWholeSeriesMoveCase(source, -truths[0].shiftYears).corrupted);
        return site;
    }
    if (scenario.kind.startsWith("multiDiscreteMissing")) {
        site.set(source.id, createPiecewiseLagMixedCase(
            source,
            truths.map((item) => ({
                eventType: "missingRing" as const,
                year: item.year!,
                shiftYears: -1,
            })),
        ).corrupted);
        return site;
    }
    if (scenario.kind === "composite") {
        const localTruths = truths.filter((item) => item.eventType !== "wholeSeriesMove");
        const whole = truths.find((item) => item.eventType === "wholeSeriesMove");
        site.set(source.id, createPiecewiseLagMixedCase(
            source,
            localTruths.map((item) => ({
                eventType: item.eventType as "missingRing" | "falseRing" | "partialMove",
                year: item.year!,
                shiftYears: item.shiftYears,
                falseMode: item.eventType === "falseRing"
                    ? String(scenario.parameters.falseRingMode ?? "moderate") as
                        "average" | "moderate" | "splitLike"
                    : undefined,
            })),
            whole?.shiftYears ?? 0,
        ).corrupted);
        return site;
    }
    throw new Error(`unsupported scenario: ${scenario.kind}`);
};

export const canonicalEvent = (event: DiagnosisEvent | null): unknown => event === null
    ? null
    : {
        seriesId: event.seriesId,
        eventType: event.eventType,
        startYear: event.startYear,
        endYear: event.endYear,
        shiftYears: event.shiftYears ?? null,
        shiftSide: event.shiftSide ?? null,
        topYear: event.rankedYears[0]?.year ?? null,
        confidenceLevel: event.confidenceLevel,
        reviewOnly: event.reviewOnly === true,
    };

const semanticNumber = (value: number): number => (
    Number.isInteger(value) ? value : Number(value.toFixed(12))
);

const semanticValue = (value: unknown): unknown => {
    if (typeof value === "number") return semanticNumber(value);
    if (Array.isArray(value)) return value.map(semanticValue);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([
            key,
            nested,
        ]) => [key, semanticValue(nested)]));
    }
    return value;
};

export const canonicalSnapshot = (snapshot: LegacyDiagnosisSnapshot): unknown => semanticValue({
    strict: canonicalEvent(snapshot.strictEvent),
    review: canonicalEvent(snapshot.reviewEvent),
    candidates: snapshot.candidates,
    reviewStatus: snapshot.reviewDecision?.status ?? null,
    reviewReason: snapshot.reviewDecision?.reason ?? null,
});

export const snapshotsSemanticallyEqual = (
    left: LegacyDiagnosisSnapshot,
    right: LegacyDiagnosisSnapshot,
): boolean => JSON.stringify(canonicalSnapshot(left)) === JSON.stringify(canonicalSnapshot(right));

export const effectiveShift = (event: DiagnosisEvent | null): number | null => {
    if (!event) return null;
    if (event.eventType === "missingRing") return -1;
    if (event.eventType === "falseRing") return 1;
    return event.shiftYears ?? null;
};

const truthMatchesOperation = (
    event: DiagnosisEvent,
    truth: LegacyTruthSpec,
): boolean => event.eventType === truth.eventType
    && effectiveShift(event) === truth.shiftYears;

export const matchTruthAfterDiagnosis = (
    event: DiagnosisEvent | null,
    truths: readonly LegacyTruthSpec[],
): LegacyTruthSpec | null => {
    if (!event) return null;
    const matching = truths.filter((truth) => truthMatchesOperation(event, truth));
    if (matching.length === 0) return null;
    if (matching.length === 1 || event.eventType === "wholeSeriesMove") return matching[0];
    const anchor = event.rankedYears[0]?.year
        ?? Math.round((event.startYear + event.endYear) / 2);
    return [...matching].sort((left, right) => (
        Math.abs((left.year ?? anchor) - anchor) - Math.abs((right.year ?? anchor) - anchor)
        || String(left.truthId).localeCompare(String(right.truthId))
    ))[0];
};

export const makeCaseRow = (input: {
    file: LegacyFilePlan;
    scenario: LegacyScenarioPlan;
    pair: "before-save" | "after-reopen";
    snapshot: LegacyDiagnosisSnapshot;
    truth: LegacyTruthSpec | null;
    quality: LegacyQualityMetrics;
    saveReopenStable: boolean | null;
    cofechaFlagged: boolean;
}): LegacyCaseRow => {
    const event = input.snapshot.reviewEvent;
    const truth = input.truth;
    const response = event !== null;
    const typeCorrect = truth ? event?.eventType === truth.eventType : null;
    const shiftCorrect = truth
        ? effectiveShift(event) === truth.shiftYears
        : null;
    const operationCorrect = truth ? Boolean(typeCorrect && shiftCorrect) : null;
    const windowApplicable = truth !== null && truth.eventType !== "wholeSeriesMove";
    const windowCovered = windowApplicable
        ? Boolean(operationCorrect && event && truth?.year !== null
            && truth!.year! >= event.startYear && truth!.year! <= event.endYear)
        : null;
    const topYear = event?.rankedYears[0]?.year ?? null;
    return {
        caseId: `${input.scenario.scenarioId}:${input.pair}:${truth?.truthId ?? "negative"}`,
        fileId: input.file.fileId,
        relativePath: input.file.relativePath,
        source: input.file.source,
        developmentExposure: input.file.developmentExposure,
        seriesId: input.scenario.targetId,
        scenarioId: input.scenario.scenarioId,
        scenarioKind: input.scenario.kind,
        scenarioPair: input.pair,
        truthQuality: input.scenario.truthQuality,
        eventComplexity: input.scenario.eventComplexity,
        truthId: truth?.truthId ?? null,
        truthEventType: truth?.eventType ?? null,
        truthYear: truth?.year ?? null,
        truthShiftYears: truth?.shiftYears ?? null,
        absoluteIdentifiable: input.quality.identifiability !== "absolute-unidentifiable",
        response,
        eventCount: response ? 1 : 0,
        predictedType: event?.eventType ?? null,
        predictedShiftYears: effectiveShift(event),
        typeCorrect,
        shiftCorrect,
        operationCorrect,
        windowApplicable,
        windowCovered,
        top1Exact: windowApplicable && operationCorrect && truth?.year !== null
            ? topYear === truth!.year
            : null,
        topYear,
        windowStart: event?.startYear ?? null,
        windowEnd: event?.endYear ?? null,
        windowWidth: event ? event.endYear - event.startYear + 1 : null,
        breakpointError: windowApplicable && operationCorrect && truth?.year !== null
            && topYear !== null ? topYear - truth!.year! : null,
        saveReopenStable: input.saveReopenStable,
        strictResponse: input.snapshot.strictEvent !== null,
        reviewResponse: input.snapshot.reviewEvent !== null,
        refusalReason: input.snapshot.reviewDecision?.reason
            ?? input.snapshot.audit?.finalReason
            ?? null,
        referenceMode: input.snapshot.referenceMode,
        referenceAnchorCount: input.snapshot.referenceAnchorCount,
        referenceSourceCount: input.snapshot.audit?.referenceSourceCount ?? null,
        minimumReferenceDepth: input.snapshot.audit?.minimumReferenceDepth ?? null,
        medianReferenceDepth: input.snapshot.audit?.medianReferenceDepth ?? null,
        cofechaFlagged: input.cofechaFlagged,
        elapsedMs: input.snapshot.durationMs,
        quality: input.quality,
        error: input.snapshot.error,
    };
};

const pearson = (left: Map<number, number>, right: Map<number, number>): {
    correlation: number | null;
    overlap: number;
} => {
    let count = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    left.forEach((x, year) => {
        const y = right.get(year);
        if (y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return;
        count += 1;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
    });
    const numerator = sxy - sx * sy / Math.max(1, count);
    const denominator = Math.sqrt(
        Math.max(0, sxx - sx * sx / Math.max(1, count))
        * Math.max(0, syy - sy * sy / Math.max(1, count)),
    );
    return {
        correlation: count >= 20 && denominator > 0 ? numerator / denominator : null,
        overlap: count,
    };
};

const quantile = (values: number[], probability: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.max(
        0,
        Math.ceil(sorted.length * probability) - 1,
    ))];
};

const standardized = (tree: RwlTreeData): Map<number, number> => new Map(
    cofechaStyleStandardize(new Map(Array.from(tree).flatMap(([year, value]) => (
        typeof value === "number" && value > 0
            ? [[year, value] as [number, number]]
            : []
    )))).map((point) => [point.year, point.value]),
);

export const computeFileInterseries = (siteData: RwlSiteData): {
    median: number | null;
    iqr: number | null;
} => {
    const rows = Array.from(siteData, ([seriesId, values]) => ({
        seriesId,
        values: standardized(values),
    })).filter((row) => row.values.size >= 50);
    const correlations: number[] = [];
    for (let left = 0; left < rows.length; left += 1) {
        for (let right = left + 1; right < rows.length; right += 1) {
            const result = pearson(rows[left].values, rows[right].values);
            if (result.overlap >= 50 && result.correlation !== null) {
                correlations.push(result.correlation);
            }
        }
    }
    const q25 = quantile(correlations, 0.25);
    const q75 = quantile(correlations, 0.75);
    return {
        median: quantile(correlations, 0.5),
        iqr: q25 !== null && q75 !== null ? q75 - q25 : null,
    };
};

const longestZeroBlock = (tree: RwlTreeData): number => {
    const zeros = Array.from(tree).filter(([, value]) => value === 0)
        .map(([year]) => year).sort((left, right) => left - right);
    let longest = 0;
    let current = 0;
    let previous: number | null = null;
    zeros.forEach((year) => {
        current = previous !== null && year === previous + 1 ? current + 1 : 1;
        longest = Math.max(longest, current);
        previous = year;
    });
    return longest;
};

export const computeQualityMetrics = (input: {
    cleanSite: RwlSiteData;
    targetId: string;
    cleanSnapshot: LegacyDiagnosisSnapshot;
    context: CofechaContext;
    fileInterseries: { median: number | null; iqr: number | null };
}): LegacyQualityMetrics => {
    const target = input.cleanSite.get(input.targetId);
    if (!target) throw new Error(`quality target missing: ${input.targetId}`);
    const targetResidual = standardized(target);
    const targetExcludedFlags = new Set([...input.context.flaggedIds, input.targetId]);
    let reference = createCofechaPassReferenceConfig({
        siteData: input.cleanSite,
        flaggedAIds: targetExcludedFlags,
        cofechaRunId: `quality-${input.targetId}`,
        rwlHash: input.context.rwlHash,
    });
    if (!reference.cofechaPassReference) {
        reference = createCofechaMasterReferenceConfig({
            siteData: input.cleanSite,
            flaggedAIds: targetExcludedFlags,
            cofechaRunId: `quality-${input.targetId}`,
            rwlHash: input.context.rwlHash,
            masterDatingSeries: parseCofechaResult(
                input.context.outText,
            ).masterDatingSeries,
        });
    }
    const points = reference.cofechaPassReference?.points ?? [];
    const referenceMap = new Map(points.map((point) => [point.year, point.value]));
    const correlation = pearson(targetResidual, referenceMap);
    const years = Array.from(targetResidual.keys()).sort((left, right) => left - right);
    const segmentCorrelations: number[] = [];
    if (years.length > 0) {
        for (let start = years[0]; start + 49 <= years[years.length - 1]; start += 25) {
            const segmentTarget = new Map(Array.from(targetResidual).filter(([year]) => (
                year >= start && year <= start + 49
            )));
            const result = pearson(segmentTarget, referenceMap);
            if (result.overlap >= 25 && result.correlation !== null) {
                segmentCorrelations.push(result.correlation);
            }
        }
    }
    const q25 = quantile(segmentCorrelations, 0.25);
    const q75 = quantile(segmentCorrelations, 0.75);
    const zeroCount = Array.from(target.values()).filter((value) => value === 0).length;
    const depth = points.map((point) => point.replication);
    return {
        leaveOneOutCorrelation: correlation.correlation,
        fileInterseriesCorrelationMedian: input.fileInterseries.median,
        fileInterseriesCorrelationIqr: input.fileInterseries.iqr,
        validOverlapYears: correlation.overlap,
        effectiveReferenceSourceCount:
            reference.cofechaPassReference?.includedSeriesIds.length ?? 0,
        referenceDepthMedian: quantile(depth, 0.5),
        referenceDepthMinimum: depth.length > 0 ? Math.min(...depth) : null,
        segmentCorrelationMedian: quantile(segmentCorrelations, 0.5),
        segmentCorrelationIqr: q25 !== null && q75 !== null ? q75 - q25 : null,
        segmentStability: segmentCorrelations.length > 0
            ? segmentCorrelations.filter((value) => value >= 0.3).length
                / segmentCorrelations.length
            : null,
        cofechaPassAnchorRatio: input.cleanSite.size > 0
            ? (reference.classification?.anchorPassIds.length ?? 0) / input.cleanSite.size
            : null,
        zeroMissingDensity: zeroCount / Math.max(1, target.size),
        discreteZeroCount: zeroCount,
        longestZeroMissingBlock: longestZeroBlock(target),
        seriesLength: target.size,
        identifiability: "absolute-identifiable",
        unavailableReason: input.cleanSnapshot.error,
    };
};

export const applyConfirmedEvent = (
    site: RwlSiteData,
    event: DiagnosisEvent,
    truth: LegacyTruthSpec,
): { applied: boolean; reason: string | null } => {
    const current = site.get(event.seriesId);
    if (!current) return { applied: false, reason: "series_missing" };
    if (!truthMatchesOperation(event, truth)) {
        return { applied: false, reason: "operation_mismatch" };
    }
    if (event.eventType !== "wholeSeriesMove") {
        if (truth.year === null || truth.year < event.startYear || truth.year > event.endYear) {
            return { applied: false, reason: "truth_outside_window" };
        }
    }
    if (event.eventType === "missingRing") {
        site.set(event.seriesId, insertMissingYearAtSide(current, truth.year!, "right"));
        return { applied: true, reason: null };
    }
    if (event.eventType === "falseRing") {
        site.set(event.seriesId, deleteYearWithMode(current, truth.year!, "direct", "right"));
        return { applied: true, reason: null };
    }
    const shiftYears = event.shiftYears ?? 0;
    const range = treeRange(current);
    const startYear = range.startYear;
    const endYear = event.eventType === "partialMove" ? truth.year! - 1 : range.endYear;
    const conflicts = getSeriesMoveConflicts(current, startYear, endYear, shiftYears);
    if (conflicts.length > 0) {
        return { applied: false, reason: `move_conflict:${conflicts.join(",")}` };
    }
    site.set(event.seriesId, moveSeriesTailByOffset(
        current,
        startYear,
        endYear,
        shiftYears,
    ));
    return { applied: true, reason: null };
};

export const qualityBin = (
    value: number | null,
    cuts: number[],
): string => {
    if (value === null || !Number.isFinite(value)) return "unavailable";
    for (let index = 0; index < cuts.length - 1; index += 1) {
        if (value >= cuts[index] && value < cuts[index + 1]) {
            return `${cuts[index]}..${cuts[index + 1]}`;
        }
    }
    return `${cuts.at(-2)}..${cuts.at(-1)}`;
};

export const assertFrozenConfig = (
    config: LegacyConfig,
    manifestConfigHash: string,
    configBytes: Buffer,
): string => {
    const hash = sha256Bytes(configBytes);
    if (hash !== manifestConfigHash) {
        throw new Error(`config hash mismatch: ${hash} != ${manifestConfigHash}`);
    }
    if (config.schemaVersion !== 1) throw new Error("unsupported config schema");
    return hash;
};

export const isResumableCompletedStage = (stage: unknown): boolean => (
    Boolean(stage)
    && typeof stage === "object"
    && (stage as { passed?: unknown }).passed !== false
);
