/** Builds a deterministic structural candidate pool while excluding every historical file ID. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cofechaStyleStandardize } from "@/features/crossdating/reference";
import { loadRwl } from "./legacy-generalization/evaluator";

type StructuralCandidate = {
    fileId: string;
    relativePath: string;
    sourceSha256: string;
    totalSeries: number;
    longSeries: number;
    approximateEligibleSeries: number;
    approximateMedianCorrelation: number;
    deterministicOrder: string;
};

const repoRoot = resolve(
    process.env.CROSSDATING_REPO_ROOT
    ?? fileURLToPath(new URL("..", import.meta.url)),
);
const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string, fallback: string): string => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const itrdbRoot = resolve(valueFor(
    "--itrdb-root",
    "D:/软件测试/数据/ITRDB/itrdb_download/measurements",
));
const historyRoot = resolve(valueFor(
    "--history-root",
    "D:/软件测试/itrdb-operation-capability",
));
const outputPath = resolve(valueFor(
    "--output",
    "D:/软件测试/itrdb-unified-model-v2/unseen-structural-pool.json",
));
const seed = valueFor("--seed", "unified-model-unseen-file-pool-2026-08-23-v1");
const poolSize = Number(valueFor("--pool-size", "600"));
const minimumSeriesYears = Number(valueFor("--minimum-series-years", "200"));
const minimumLongSeries = Number(valueFor("--minimum-long-series", "6"));
const minimumApproximateCorrelation = Number(valueFor(
    "--minimum-approximate-correlation",
    "0.62",
));
const historicalCommit = valueFor("--historical-commit", "1a509069^");

const digest = (value: string): string => createHash("sha256")
    .update(value).digest("hex");
const median = (values: readonly number[]): number => {
    if (values.length === 0) return -1;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
};
const correlation = (pairs: readonly [number, number][]): number | null => {
    if (pairs.length < 100) return null;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    pairs.forEach(([x, y]) => {
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
    });
    const count = pairs.length;
    const numerator = sxy - sx * sy / count;
    const denominator = Math.sqrt(
        Math.max(0, sxx - sx * sx / count)
        * Math.max(0, syy - sy * sy / count),
    );
    return denominator > 0 ? numerator / denominator : null;
};

const collectIds = (text: string, output: Set<string>): void => {
    const scalar = /"fileId"\s*:\s*"([^"]+)"/g;
    for (let match = scalar.exec(text); match; match = scalar.exec(text)) {
        output.add(match[1].toLowerCase());
    }
    const arrays = /"fileIds"\s*:\s*\[([\s\S]*?)\]/g;
    for (let match = arrays.exec(text); match; match = arrays.exec(text)) {
        const strings = /"([^"]+)"/g;
        for (let item = strings.exec(match[1]); item; item = strings.exec(match[1])) {
            output.add(item[1].toLowerCase());
        }
    }
};

const historicalIds = new Set<string>();
const historicalFiles: string[] = [];
const tracked = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", historicalCommit, "docs/benchmarks"],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true },
).split(/\r?\n/).filter((path) => (
    /(?:config|manifest|split).*\.json$/i.test(path)
));
tracked.forEach((path) => {
    try {
        const text = execFileSync(
            "git",
            ["show", `${historicalCommit}:${path}`],
            { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 128 * 1024 * 1024 },
        );
        collectIds(text, historicalIds);
        historicalFiles.push(`git:${historicalCommit}:${path}`);
    } catch {
        // A malformed historical artifact is ignored but remains visible in the provenance count.
    }
});

const historyName = /^(?:steps|resolved-cases)\.json$|(?:config|manifest|split).*\.json$/i;
const scanHistory = (directory: string): void => {
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return;
    readdirSync(directory).forEach((entry) => {
        const path = resolve(directory, entry);
        const stats = statSync(path);
        if (stats.isDirectory()) {
            scanHistory(path);
            return;
        }
        if (!historyName.test(entry)) return;
        try {
            collectIds(readFileSync(path, "utf8"), historicalIds);
            historicalFiles.push(path);
        } catch {
            // Keep scanning other frozen artifacts.
        }
    });
};
scanHistory(historyRoot);

const pathsByName = new Map<string, string[]>();
const scanRwl = (directory: string): void => {
    readdirSync(directory).forEach((entry) => {
        const path = resolve(directory, entry);
        const stats = statSync(path);
        if (stats.isDirectory()) {
            scanRwl(path);
            return;
        }
        if (!entry.toLowerCase().endsWith(".rwl")) return;
        const key = entry.toLowerCase();
        pathsByName.set(key, [...pathsByName.get(key) ?? [], path]);
    });
};
scanRwl(itrdbRoot);

const sourceCandidates = Array.from(pathsByName.entries()).flatMap(([name, paths]) => {
    const fileId = basename(name, ".rwl").toLowerCase();
    if (paths.length !== 1
        || fileId.includes("-noaa")
        || historicalIds.has(fileId)) return [];
    const relativePath = relative(itrdbRoot, paths[0]).replaceAll("\\", "/");
    return [{
        fileId,
        path: paths[0],
        relativePath,
        order: digest(`${seed}:${relativePath}`),
    }];
}).sort((left, right) => left.order.localeCompare(right.order));

const candidates: StructuralCandidate[] = [];
const excluded: { fileId: string; relativePath: string; reason: string }[] = [];
for (const [index, source] of sourceCandidates.entries()) {
    if (candidates.length >= poolSize) break;
    try {
        const loaded = await loadRwl(source.path, "tucson-auto");
        const long = Array.from(loaded.series.values())
            .filter((series) => series.length >= minimumSeriesYears);
        if (long.length < minimumLongSeries) continue;
        const residuals = long.map((series) => ({
            id: series.id,
            data: new Map(cofechaStyleStandardize(series.valuesByYear)
                .map((point) => [point.year, point.value])),
        }));
        const sums = new Map<number, { sum: number; count: number }>();
        residuals.forEach((series) => series.data.forEach((value, year) => {
            const current = sums.get(year) ?? { sum: 0, count: 0 };
            current.sum += value;
            current.count += 1;
            sums.set(year, current);
        }));
        const correlations = residuals.flatMap((series) => {
            const pairs: [number, number][] = [];
            series.data.forEach((value, year) => {
                const aggregate = sums.get(year);
                if (!aggregate || aggregate.count < 2) return;
                pairs.push([value, (aggregate.sum - value) / (aggregate.count - 1)]);
            });
            const measured = correlation(pairs);
            return measured === null ? [] : [measured];
        });
        const approximateMedianCorrelation = median(correlations);
        const approximateEligibleSeries = correlations.filter(
            (value) => value >= minimumApproximateCorrelation,
        ).length;
        if (approximateMedianCorrelation < minimumApproximateCorrelation
            || approximateEligibleSeries < minimumLongSeries) continue;
        candidates.push({
            fileId: source.fileId,
            relativePath: source.relativePath,
            sourceSha256: loaded.sourceSha256,
            totalSeries: loaded.series.size,
            longSeries: long.length,
            approximateEligibleSeries,
            approximateMedianCorrelation,
            deterministicOrder: source.order,
        });
        console.log(
            `UNSEEN_POOL accepted=${candidates.length}/${poolSize}`
            + ` scanned=${index + 1}/${sourceCandidates.length}`
            + ` file=${source.fileId} approx=${approximateMedianCorrelation.toFixed(3)}`,
        );
    } catch (error) {
        excluded.push({
            fileId: source.fileId,
            relativePath: source.relativePath,
            reason: error instanceof Error ? error.message : String(error),
        });
    }
}

const output = {
    schemaVersion: 1,
    seed,
    createdAt: new Date().toISOString(),
    itrdbRoot: itrdbRoot.replaceAll("\\", "/"),
    historyRoot: historyRoot.replaceAll("\\", "/"),
    historicalCommit,
    historicalArtifactCount: historicalFiles.length,
    excludedHistoricalFileIds: [...historicalIds].sort(),
    selection: {
        requireUniqueBasename: true,
        excludeNoaaDuplicateNames: true,
        minimumSeriesYears,
        minimumLongSeries,
        minimumApproximateCorrelation,
        usesDiagnosisOutput: false,
        usesInjectedTruth: false,
    },
    counts: {
        uniqueUnseenSources: sourceCandidates.length,
        selectedCandidates: candidates.length,
        parseFailures: excluded.length,
    },
    candidates,
    excluded,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`UNSEEN_POOL_COMPLETE ${JSON.stringify({
    outputPath,
    historicalFileIds: historicalIds.size,
    ...output.counts,
})}`);
