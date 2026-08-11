/** Audits whether all-zero removal leaves enough internal reference structure for serial review. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cofechaStyleStandardize } from "@/features/crossdating/reference";
import { selectPairwiseBootstrapCluster } from "@/features/crossdating/pairwiseBootstrap";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    buildMultiMissingCorrupted,
    parseRwl,
} from "@/features/crossdating/diagnosis/__tests__/rdmFixture";
import { classifyItrdbReferenceStructure } from "./itrdbReferenceStructureClassification";

type PlanRow = { file: string; path: string };
type PairwiseAlignment = {
    eligiblePairs: number;
    zeroLagBestRate: number;
    p90AbsoluteBestLag: number;
};
type RunSummary = {
    inputPath: string;
    totalSeries: number;
    totalTruthEvents: number;
    absoluteIdentifiableEvents: number;
    recoveredEvents: number;
    relativeAlignment: {
        initial: PairwiseAlignment;
        final: PairwiseAlignment;
    };
};

const args = process.argv.slice(2);
const positionalArgs = args.filter((value, index) => (
    !value.startsWith("--") && (index === 0 || !args[index - 1].startsWith("--"))
));
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedPlanPath = valueFor("--plan") ?? positionalArgs[0] ?? null;
if (!requestedPlanPath) throw new Error("--plan <audit-plan.csv> is required");
const planPath = resolve(requestedPlanPath);
const outputDir = resolve(valueFor("--output-dir")
    ?? positionalArgs[1]
    ?? join(repoRoot, "tmp", "itrdb-reference-structure-audit"));
const PAIRWISE_MIN_OVERLAP = 50;
const PAIRWISE_LAG_RADIUS = 10;
const PAIRWISE_MIN_ZERO_LAG_CORRELATION = 0.3;
const PAIRWISE_MAX_ZERO_LAG_DEFICIT = 0.03;

const parsePlan = (text: string): PlanRow[] => text.split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((line) => {
        const match = /^"([^"]+)","([^"]+)"$/.exec(line);
        if (!match) throw new Error(`invalid audit plan row: ${line}`);
        return { file: match[1], path: match[2] };
    });

const pearsonAtLag = (
    left: ReadonlyMap<number, number>,
    right: ReadonlyMap<number, number>,
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
    if (count < PAIRWISE_MIN_OVERLAP) return null;
    const numerator = sxy - sx * sy / count;
    const denominator = Math.sqrt(
        Math.max(0, sxx - sx * sx / count)
        * Math.max(0, syy - sy * sy / count),
    );
    return denominator > 0 ? numerator / denominator : null;
};

const standardize = (siteData: RwlSiteData) => new Map(Array.from(
    siteData,
    ([seriesId, data]) => [
        seriesId,
        new Map(cofechaStyleStandardize(new Map(Array.from(data).flatMap(
            ([year, value]) => typeof value === "number"
                ? [[year, value] as [number, number]]
                : [],
        ))).map((point) => [point.year, point.value])),
    ],
).filter(([, values]) => values.size >= PAIRWISE_MIN_OVERLAP));

const summarizeAlignment = (
    siteData: RwlSiteData,
    selectedIds?: ReadonlySet<string>,
): PairwiseAlignment => {
    const residuals = Array.from(standardize(siteData)).filter(([seriesId]) => (
        !selectedIds || selectedIds.has(seriesId)
    ));
    const absoluteBestLags: number[] = [];
    for (let leftIndex = 0; leftIndex < residuals.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < residuals.length; rightIndex += 1) {
            const candidates = Array.from({ length: PAIRWISE_LAG_RADIUS * 2 + 1 }, (_, index) => {
                const lag = index - PAIRWISE_LAG_RADIUS;
                return {
                    lag,
                    correlation: pearsonAtLag(
                        residuals[leftIndex][1],
                        residuals[rightIndex][1],
                        lag,
                    ),
                };
            }).filter((row): row is { lag: number; correlation: number } => (
                row.correlation !== null
            )).sort((left, right) => (
                right.correlation - left.correlation
                || Math.abs(left.lag) - Math.abs(right.lag)
            ));
            if (candidates[0]) absoluteBestLags.push(Math.abs(candidates[0].lag));
        }
    }
    absoluteBestLags.sort((left, right) => left - right);
    return {
        eligiblePairs: absoluteBestLags.length,
        zeroLagBestRate: absoluteBestLags.filter((lag) => lag === 0).length
            / Math.max(1, absoluteBestLags.length),
        p90AbsoluteBestLag: absoluteBestLags[
            Math.max(0, Math.ceil(absoluteBestLags.length * 0.9) - 1)
        ] ?? 0,
    };
};

const summarizeBootstrapGraph = (siteData: RwlSiteData) => {
    const residuals = Array.from(standardize(siteData));
    const adjacency = new Map(residuals.map(([seriesId]) => [seriesId, new Set<string>()]));
    for (let leftIndex = 0; leftIndex < residuals.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < residuals.length; rightIndex += 1) {
            let bestCorrelation = -Infinity;
            let zeroCorrelation: number | null = null;
            for (let lag = -PAIRWISE_LAG_RADIUS; lag <= PAIRWISE_LAG_RADIUS; lag += 1) {
                const correlation = pearsonAtLag(
                    residuals[leftIndex][1],
                    residuals[rightIndex][1],
                    lag,
                );
                if (correlation === null) continue;
                bestCorrelation = Math.max(bestCorrelation, correlation);
                if (lag === 0) zeroCorrelation = correlation;
            }
            if (zeroCorrelation === null
                || zeroCorrelation < PAIRWISE_MIN_ZERO_LAG_CORRELATION
                || bestCorrelation - zeroCorrelation > PAIRWISE_MAX_ZERO_LAG_DEFICIT) {
                continue;
            }
            adjacency.get(residuals[leftIndex][0])?.add(residuals[rightIndex][0]);
            adjacency.get(residuals[rightIndex][0])?.add(residuals[leftIndex][0]);
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
        components.push(component.sort());
    });
    components.sort((left, right) => (
        right.length - left.length || left[0].localeCompare(right[0])
    ));
    const largest = components[0] ?? [];
    const largestSet = new Set(largest);
    const largestEdges = largest.reduce((sum, seriesId) => (
        sum + Array.from(adjacency.get(seriesId) ?? []).filter((neighbor) => (
            largestSet.has(neighbor)
        )).length
    ), 0) / 2;
    const possibleLargestEdges = largest.length * (largest.length - 1) / 2;
    return {
        components,
        largestEdgeDensity: possibleLargestEdges > 0
            ? largestEdges / possibleLargestEdges
            : 0,
    };
};

const initialSiteFrom = (inputPath: string): RwlSiteData => {
    const parsed = parseRwl(readFileSync(inputPath, "utf8"));
    return new Map(Array.from(parsed, ([seriesId, series]) => {
        const truthYears = Array.from(series.valuesByYear)
            .filter(([, value]) => value === 0)
            .map(([year]) => year)
            .sort((left, right) => right - left);
        return [
            seriesId,
            truthYears.length > 0
                ? buildMultiMissingCorrupted(series.valuesByYear, truthYears)
                : new Map(series.valuesByYear),
        ];
    }));
};

const csvCell = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
};
const writeCsv = (path: string, rows: readonly Record<string, unknown>[]): void => {
    const headers = Object.keys(rows[0] ?? {});
    writeFileSync(path, [
        headers.map(csvCell).join(","),
        ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
    ].join("\n"), "utf8");
};

const rows = parsePlan(readFileSync(planPath, "utf8")).map((plan) => {
    const summary = JSON.parse(
        readFileSync(join(plan.path, "run-summary.json"), "utf8"),
    ) as RunSummary;
    const initialSite = initialSiteFrom(summary.inputPath);
    const clusterIds = selectPairwiseBootstrapCluster(initialSite);
    const graph = summarizeBootstrapGraph(initialSite);
    if (clusterIds.length !== (graph.components[0]?.length ?? 0)) {
        throw new Error(`pairwise graph mismatch for ${plan.file}`);
    }
    const clusterAlignment = summarizeAlignment(initialSite, new Set(clusterIds));
    const secondClusterSize = graph.components[1]?.length ?? 0;
    const structure = {
        initialZeroLagRate: summary.relativeAlignment.initial.zeroLagBestRate,
        initialAbsoluteLagP90: summary.relativeAlignment.initial.p90AbsoluteBestLag,
        pairwiseClusterFraction: clusterIds.length / Math.max(1, summary.totalSeries),
        clusterDominanceRatio: clusterIds.length / Math.max(1, secondClusterSize),
        clusterEdgeDensity: graph.largestEdgeDensity,
        clusterZeroLagRate: clusterAlignment.zeroLagBestRate,
        clusterAbsoluteLagP90: clusterAlignment.p90AbsoluteBestLag,
    };
    const classification = classifyItrdbReferenceStructure(structure);
    return {
        file: plan.file,
        totalSeries: summary.totalSeries,
        truthEvents: summary.totalTruthEvents,
        absoluteIdentifiableEvents: summary.absoluteIdentifiableEvents,
        absoluteUnidentifiableEvents:
            summary.totalTruthEvents - summary.absoluteIdentifiableEvents,
        ...structure,
        pairwiseClusterSize: clusterIds.length,
        secondClusterSize,
        clusterEligiblePairs: clusterAlignment.eligiblePairs,
        metricEligibility: classification.metricEligibility,
        qualificationRoute: classification.qualificationRoute,
        recoveredEvents: summary.recoveredEvents,
        recoveryRate: summary.recoveredEvents
            / Math.max(1, summary.absoluteIdentifiableEvents),
        finalZeroLagRate: summary.relativeAlignment.final.zeroLagBestRate,
        finalAbsoluteLagP90: summary.relativeAlignment.final.p90AbsoluteBestLag,
        zeroLagImprovement: summary.relativeAlignment.final.zeroLagBestRate
            - summary.relativeAlignment.initial.zeroLagBestRate,
    };
});

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
const reportTable = rows.map((row) => (
    `| ${row.file} | ${row.metricEligibility} | ${row.qualificationRoute} | `
    + `${percent(row.initialZeroLagRate)} | ${row.initialAbsoluteLagP90} | `
    + `${row.pairwiseClusterSize}/${row.totalSeries} | ${percent(row.clusterEdgeDensity)} | `
    + `${percent(row.clusterZeroLagRate)} | ${row.recoveredEvents}/${row.absoluteIdentifiableEvents} |`
)).join("\n");
const evaluableRows = rows.filter((row) => row.metricEligibility === "evaluable");
const excludedRows = rows.filter((row) => row.metricEligibility === "reference-structure-lost");
const aggregate = (selected: typeof rows) => {
    const identifiable = selected.reduce((sum, row) => sum + row.absoluteIdentifiableEvents, 0);
    const recovered = selected.reduce((sum, row) => sum + row.recoveredEvents, 0);
    return {
        files: selected.length,
        identifiable,
        recovered,
        recoveryRate: recovered / Math.max(1, identifiable),
    };
};
const primaryAggregate = aggregate(evaluableRows);
const excludedAggregate = aggregate(excludedRows);
const report = `# ITRDB all-zero reference-structure audit

The eligibility decision uses only the all-zero-deleted starting state. Recovery counts,
final alignment and file identity are not classification inputs.

- Primary metric: ${primaryAggregate.files} files, ${primaryAggregate.recovered}/${primaryAggregate.identifiable} recovered (${percent(primaryAggregate.recoveryRate)}).
- Reference structure lost: ${excludedAggregate.files} files, ${excludedAggregate.recovered}/${excludedAggregate.identifiable} recovered (${percent(excludedAggregate.recoveryRate)}), reported separately.
- Excluded file ids: ${excludedRows.map((row) => row.file).join(", ") || "none"}.

| File | Eligibility | Route | Initial zero lag | Initial lag P90 | Main core | Core edge density | Core zero lag | Recovered |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${reportTable}
`;

mkdirSync(outputDir, { recursive: true });
writeCsv(join(outputDir, "reference-structure.csv"), rows);
writeFileSync(
    join(outputDir, "reference-structure.json"),
    `${JSON.stringify({ planPath, rows }, null, 2)}\n`,
    "utf8",
);
writeFileSync(join(outputDir, "report.md"), report, "utf8");
console.log(`ITRDB_REFERENCE_STRUCTURE ${JSON.stringify({ outputDir, rows })}`);
