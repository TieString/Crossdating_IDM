import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findAbsoluteUnidentifiableTruthYears } from "@/features/crossdating/diagnosis/bootstrapEvaluation";
import {
    extractPart6FlaggedASeriesIds,
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import type {
    DiagnosisEvent,
    DiagnosisEventDecisionAudit,
    DiagnosisReviewWindowDecision,
} from "@/features/crossdating/diagnosis/types";
import {
    cofechaStyleStandardize,
    createCofechaMasterReferenceConfig,
    createCofechaPassReferenceConfig,
} from "@/features/crossdating/reference";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    buildMultiMissingCorrupted,
    parseRwl,
} from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

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
    valueFor("--output-dir") ?? "D:/软件测试/co612-review-window-results",
);
const runId = valueFor("--run-id")
    ?? `initial-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runDir = join(outputRoot, runId);
const requestedTargetLimit = Number(valueFor("--target-limit") ?? Number.POSITIVE_INFINITY);
const targetLimit = Number.isFinite(requestedTargetLimit)
    ? Math.max(1, Math.floor(requestedTargetLimit))
    : Number.POSITIVE_INFINITY;

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
const truthBySeries = new Map(Array.from(parsed, ([seriesId, series]) => [
    seriesId,
    Array.from(series.valuesByYear)
        .filter(([, value]) => value === 0)
        .map(([year]) => year)
        .sort((left, right) => right - left),
]));
const initialSite: RwlSiteData = new Map(Array.from(originalSite, ([seriesId, data]) => [
    seriesId,
    new Map(data),
]));
truthBySeries.forEach((truthYears, seriesId) => {
    if (truthYears.length === 0) return;
    initialSite.set(
        seriesId,
        buildMultiMissingCorrupted(parsed.get(seriesId)!.valuesByYear, truthYears),
    );
});
const initialZeroCount = Array.from(initialSite.values()).reduce((sum, data) => (
    sum + Array.from(data.values()).filter((value) => value === 0).length
), 0);
if (initialZeroCount !== 0) {
    throw new Error(`hidden zero leaked into initial diagnosis state: ${initialZeroCount}`);
}

writeFileSync(join(runDir, "initial-all-missing.rwl"), formatTucson(initialSite, false), "utf8");

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

const standardizedSiteSeries = (siteData: RwlSiteData) => Array.from(
    siteData,
    ([seriesId, data]) => ({
        seriesId,
        residual: new Map(cofechaStyleStandardize(new Map(Array.from(data).flatMap(
            ([year, value]) => typeof value === "number"
                ? [[year, value] as [number, number]]
                : [],
        ))).map((point) => [point.year, point.value])),
    }),
).filter((row) => row.residual.size >= 50);

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

const cofechaDir = join(runDir, "cofecha-initial");
mkdirSync(cofechaDir, { recursive: true });
writeFileSync(join(cofechaDir, "INPUT.RWL"), formatTucson(initialSite, false), "utf8");
execFileSync(cofechaExe, [], {
    cwd: cofechaDir,
    input: "very\nINPUT.RWL\n\n\n\n\n\n\n",
    timeout: 30_000,
    stdio: ["pipe", "ignore", "pipe"],
});
const outText = readFileSync(join(cofechaDir, "VERYCOF.OUT"), "utf8");
const cofechaResult = parseCofechaResult(outText);
const parts = splitReportByParts(outText);
const normalizedSeriesIds = new Map(Array.from(initialSite.keys(), (seriesId) => [
    seriesId.trim().toUpperCase(),
    seriesId,
]));
const cofechaFlagged = new Set(extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? "")
    .flatMap((seriesId) => {
        const canonical = normalizedSeriesIds.get(seriesId.trim().toUpperCase());
        return canonical ? [canonical] : [];
    }));
const pairwiseCluster = selectPairwiseBootstrapCluster(initialSite);
const pairwiseClusterSet = new Set(pairwiseCluster);
const usePairwiseBootstrap = initialSite.size - cofechaFlagged.size < 3;
const commonTruthYears = findAbsoluteUnidentifiableTruthYears(
    originalSite,
    truthBySeries,
);

const eventSummary = (event: DiagnosisEvent | null) => event ? {
    eventType: event.eventType,
    startYear: event.startYear,
    endYear: event.endYear,
    topYear: event.rankedYears[0]?.year ?? null,
    confidence: event.confidenceLevel,
    score: event.evidence.score,
    scoreMargin: event.evidence.scoreMargin,
    reviewOnly: event.reviewOnly === true,
    sources: event.evidence.algorithmSources,
} : null;

type ResultRow = {
    seriesId: string;
    truthYear: number | null;
    absoluteIdentifiable: boolean;
    originalMissingCount: number;
    seriesLength: number;
    cofechaFlagged: boolean;
    referenceMode: "pairwise-leave-one-out" | "cofecha-pass-leave-one-out";
    referenceAnchorCount: number;
    strict: ReturnType<typeof eventSummary>;
    review: ReturnType<typeof eventSummary>;
    reviewDecision: DiagnosisReviewWindowDecision;
    audit: DiagnosisEventDecisionAudit;
};

const resultsPath = join(runDir, "cases.jsonl");
if (existsSync(resultsPath)) rmSync(resultsPath);
const targetIds = Array.from(initialSite.keys()).sort().slice(0, targetLimit);
const rows: ResultRow[] = [];

targetIds.forEach((seriesId, index) => {
    const effectiveFlagged = usePairwiseBootstrap
        ? new Set(Array.from(initialSite.keys()).filter((candidateId) => (
            !pairwiseClusterSet.has(candidateId) || candidateId === seriesId
        )))
        : new Set([...cofechaFlagged, seriesId]);
    let referenceConfig = createCofechaPassReferenceConfig({
        siteData: initialSite,
        flaggedAIds: effectiveFlagged,
        cofechaRunId: `initial-${seriesId}`,
        rwlHash: sourceSha256,
    });
    if (!referenceConfig.cofechaPassReference) {
        referenceConfig = createCofechaMasterReferenceConfig({
            siteData: initialSite,
            flaggedAIds: effectiveFlagged,
            cofechaRunId: `initial-${seriesId}`,
            rwlHash: sourceSha256,
            masterDatingSeries: cofechaResult.masterDatingSeries,
        });
    }
    const diagnosis = diagnoseCrossdating(initialSite, {
        referenceConfig,
        targetTrees: [seriesId],
        cofechaText: outText,
        includeEventDecisionAudits: true,
        reviewWindowDisplayMode: "review",
    });
    const strict = diagnosis.events[0] ?? null;
    const review = diagnosis.reviewEvents?.[0] ?? null;
    const audit = diagnosis.eventDecisionAudits?.[0];
    const reviewDecision = diagnosis.reviewWindowDecisions?.[0];
    if (!audit || !reviewDecision) {
        throw new Error(`missing review audit for ${seriesId}`);
    }
    const data = initialSite.get(seriesId)!;
    const truthYears = truthBySeries.get(seriesId) ?? [];
    const truthYear = truthYears[0] ?? null;
    const row: ResultRow = {
        seriesId,
        truthYear,
        absoluteIdentifiable: truthYear === null || !commonTruthYears.has(truthYear),
        originalMissingCount: truthYears.length,
        seriesLength: data.size,
        cofechaFlagged: cofechaFlagged.has(seriesId),
        referenceMode: usePairwiseBootstrap
            ? "pairwise-leave-one-out"
            : "cofecha-pass-leave-one-out",
        referenceAnchorCount: referenceConfig.classification?.anchorPassIds.length ?? 0,
        strict: eventSummary(strict),
        review: eventSummary(review),
        reviewDecision,
        audit,
    };
    rows.push(row);
    appendFileSync(resultsPath, `${JSON.stringify(row)}\n`, "utf8");
    writeFileSync(join(runDir, "checkpoint.json"), JSON.stringify({
        completed: index + 1,
        total: targetIds.length,
        lastSeriesId: seriesId,
    }, null, 2), "utf8");
    console.log(`CO612_REVIEW_INITIAL_PROGRESS ${index + 1}/${targetIds.length} ${seriesId}`);
});

const evaluate = (key: "strict" | "review") => {
    const truthRows = rows.filter((row) => (
        row.truthYear !== null && row.absoluteIdentifiable
    ));
    const responses = truthRows.filter((row) => row[key] !== null);
    const operationCorrect = responses.filter((row) => row[key]?.eventType === "missingRing");
    const covered = operationCorrect.filter((row) => (
        row.truthYear! >= row[key]!.startYear && row.truthYear! <= row[key]!.endYear
    ));
    const top1 = operationCorrect.filter((row) => row[key]?.topYear === row.truthYear);
    const widths = responses.map((row) => row[key]!.endYear - row[key]!.startYear + 1)
        .sort((left, right) => left - right);
    const clean = rows.filter((row) => row.truthYear === null);
    return {
        truthEvents: truthRows.length,
        responseRate: responses.length / Math.max(1, truthRows.length),
        operationAccuracy: operationCorrect.length / Math.max(1, responses.length),
        primaryWindowCoverage: covered.length / Math.max(1, truthRows.length),
        conditionalWindowCoverage: covered.length / Math.max(1, operationCorrect.length),
        top1: top1.length / Math.max(1, truthRows.length),
        refusalRate: 1 - responses.length / Math.max(1, truthRows.length),
        partialMoveMisclassificationRate: responses.filter((row) => (
            row[key]?.eventType === "partialMove"
        )).length / Math.max(1, truthRows.length),
        noTruthTargetCasesInCorruptedFile: clean.length,
        noTruthTargetSuggestionRate: clean.filter((row) => row[key] !== null).length
            / Math.max(1, clean.length),
        medianWindowWidth: widths[Math.floor(widths.length / 2)] ?? null,
        p90WindowWidth: widths[Math.max(0, Math.ceil(widths.length * 0.9) - 1)] ?? null,
    };
};

const sourceSha256After = createHash("sha256").update(readFileSync(inputPath)).digest("hex");
if (sourceSha256After !== sourceSha256) {
    throw new Error(`source RWL changed: ${sourceSha256} -> ${sourceSha256After}`);
}
const summary = {
    inputPath,
    runDir,
    sourceSha256,
    sourceUnchanged: true,
    totalSeries: initialSite.size,
    testedSeries: rows.length,
    totalNaturalZeros: Array.from(truthBySeries.values()).reduce(
        (sum, years) => sum + years.length,
        0,
    ),
    activeTruthEvents: rows.filter((row) => row.truthYear !== null).length,
    absoluteUnidentifiableYears: [...commonTruthYears].sort((left, right) => left - right),
    initialZeroCount,
    cofechaFlaggedCount: cofechaFlagged.size,
    pairwiseClusterSize: pairwiseCluster.length,
    strict: evaluate("strict"),
    review: evaluate("review"),
    reviewDecisionReasons: Object.fromEntries(Array.from(new Set(rows.map(
        (row) => row.reviewDecision.reason,
    ))).sort().map((reason) => [
        reason,
        rows.filter((row) => row.reviewDecision.reason === reason).length,
    ])),
    strictRefusalReasons: Object.fromEntries(Array.from(new Set(rows
        .filter((row) => row.strict === null)
        .map((row) => row.audit.finalReason))).sort().map((reason) => [
        reason,
        rows.filter((row) => row.strict === null && row.audit.finalReason === reason).length,
    ])),
};
writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
console.log(`CO612_REVIEW_INITIAL_SUMMARY ${JSON.stringify(summary)}`);
