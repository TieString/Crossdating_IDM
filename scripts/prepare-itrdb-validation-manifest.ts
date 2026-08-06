import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    ITRDB_VALIDATION_PROTOCOL,
    itrdbSplitForRelativePath,
    normalizeItrdbRelativePath,
    stableItrdbPathHash,
    type ItrdbValidationSplit,
} from "@/features/crossdating/diagnosis/__tests__/itrdbValidationProtocol";
import {
    parseRwl,
    type RwlSeries,
} from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

type TargetDescriptor = {
    target: string;
    seriesLength: number;
    startYear: number;
    endYear: number;
    referenceCount: number;
};

type NaturalSingleCase = TargetDescriptor & {
    caseId: string;
    kind: "naturalSingle";
    file: string;
    truthYears: [number];
};

type SingleInjectedCase = TargetDescriptor & {
    caseId: string;
    kind: "singleInjected";
    file: string;
    truthYears: [number];
    falseRingMode: "average" | "moderate" | "splitLike";
};

type MultiCase = TargetDescriptor & {
    caseId: string;
    kind: "separatedMulti" | "adjacentMulti";
    file: string;
    truthYears: number[];
};

type CrossSeriesCase = {
    caseId: string;
    kind: "crossSeries";
    file: string;
    targets: Array<TargetDescriptor & { truthYears: [number] }>;
};

type NaturalBootstrapCase = {
    caseId: string;
    kind: "naturalBootstrap";
    file: string;
    targets: Array<TargetDescriptor & {
        truthYears: number[];
        scoredTruthYears: number[];
    }>;
};

export type ItrdbSupplementaryManifestCase =
    | SingleInjectedCase
    | NaturalSingleCase
    | MultiCase
    | CrossSeriesCase
    | NaturalBootstrapCase;

export type ItrdbValidationManifest = {
    schemaVersion: 1;
    protocol: typeof ITRDB_VALIDATION_PROTOCOL;
    datasetRoot: string;
    selection: {
        fileUnit: "RWL site";
        splitUsesOnlyNormalizedRelativePath: true;
        eventSelectionUsesSignal: false;
        eventSelectionUsesRingWidthMagnitude: false;
        finalCasesGeneratedBeforeFinalEvaluation: true;
    };
    fileSha256: Record<string, string>;
    splits: Record<ItrdbValidationSplit, {
        cases: ItrdbSupplementaryManifestCase[];
        counts: Record<ItrdbSupplementaryManifestCase["kind"], number>;
    }>;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const datasetRoot = resolve(
    valueFor("--input-dir")
        ?? "D:/软件测试/数据/ITRDB/itrdb_download/measurements",
);
const outputPath = resolve(
    valueFor("--output")
        ?? `${repoRoot}/docs/benchmarks/itrdb-validation-v1-manifest.json`,
);

if (!existsSync(datasetRoot)) throw new Error(`ITRDB directory not found: ${datasetRoot}`);

const collectRwlFiles = (directory: string, output: string[]): void => {
    for (const entry of readdirSync(directory)) {
        const path = resolve(directory, entry);
        if (statSync(path).isDirectory()) collectRwlFiles(path, output);
        else if (entry.toLowerCase().endsWith(".rwl")) output.push(path);
    }
};

const overlapYears = (left: RwlSeries, right: RwlSeries): number => {
    let count = 0;
    left.valuesByYear.forEach((_, year) => {
        if (right.valuesByYear.has(year)) count += 1;
    });
    return count;
};

const referenceCount = (
    target: RwlSeries,
    series: RwlSeries[],
): number => series.filter((candidate) => (
    candidate.id !== target.id
    && overlapYears(target, candidate)
        >= ITRDB_VALIDATION_PROTOCOL.inclusion.minimumReferenceOverlapYears
)).length;

const descriptor = (
    target: RwlSeries,
    series: RwlSeries[],
): TargetDescriptor => ({
    target: target.id,
    seriesLength: target.length,
    startYear: target.startYear,
    endYear: target.endYear,
    referenceCount: referenceCount(target, series),
});

const hashOrder = (seed: string, value: string): number => (
    stableItrdbPathHash(`${ITRDB_VALIDATION_PROTOCOL.seed}:${seed}:${value}`)
);

const positiveYears = (series: RwlSeries): number[] => Array.from(
    series.valuesByYear,
).filter(([, value]) => value > 0).map(([year]) => year).sort((a, b) => a - b);

const pickYearInStratum = (
    series: RwlSeries,
    stratum: number,
    seed: string,
): number | null => {
    const { minimumOlderContextYears, minimumNewerContextYears } =
        ITRDB_VALIDATION_PROTOCOL.inclusion;
    const lo = series.startYear + minimumOlderContextYears;
    const hi = series.endYear - minimumNewerContextYears;
    if (hi < lo) return null;
    const normalizedStratum = ((stratum % 5) + 5) % 5;
    const span = hi - lo + 1;
    const binLo = lo + Math.floor(span * normalizedStratum / 5);
    const binHi = normalizedStratum === 4
        ? hi
        : lo + Math.floor(span * (normalizedStratum + 1) / 5) - 1;
    const candidates = positiveYears(series).filter((year) => year >= binLo && year <= binHi);
    if (candidates.length === 0) return null;
    return candidates[hashOrder(seed, series.id) % candidates.length];
};

const pickAdjacentYears = (series: RwlSeries, seed: string): number[] | null => {
    const positive = new Set(positiveYears(series));
    const candidates = Array.from(positive).filter((year) => (
        positive.has(year + 1)
        && year - series.startYear
            >= ITRDB_VALIDATION_PROTOCOL.inclusion.minimumOlderContextYears
        && series.endYear - (year + 1)
            >= ITRDB_VALIDATION_PROTOCOL.inclusion.minimumNewerContextYears
    ));
    if (candidates.length === 0) return null;
    const first = candidates[hashOrder(seed, series.id) % candidates.length];
    return [first, first + 1];
};

const pickSeparatedYears = (series: RwlSeries, seed: string): number[] | null => {
    const years = [0, 2, 4].map((stratum, index) => (
        pickYearInStratum(series, stratum, `${seed}:${index}`)
    ));
    if (years.some((year) => year === null)) return null;
    const sorted = (years as number[]).sort((a, b) => a - b);
    const minimumSpacing = ITRDB_VALIDATION_PROTOCOL.supplementary
        .minimumSeparatedEventSpacingYears;
    if (sorted.some((year, index) => (
        index > 0 && year - sorted[index - 1] < minimumSpacing
    ))) return null;
    return sorted;
};

const eligibleInjectedTargets = (series: RwlSeries[]): RwlSeries[] => series.filter((target) => (
    target.length >= ITRDB_VALIDATION_PROTOCOL.inclusion.minimumInjectedSeriesLength
    && target.endYear - target.startYear + 1
        >= ITRDB_VALIDATION_PROTOCOL.inclusion.minimumInjectedSeriesLength
    && !Array.from(target.valuesByYear.values()).includes(0)
    && referenceCount(target, series)
        >= ITRDB_VALIDATION_PROTOCOL.inclusion.minimumReferenceCount
));

const eligibleNaturalTruthYears = (series: RwlSeries): number[] => Array.from(
    series.valuesByYear,
).filter(([year, value]) => (
    value === 0
    && year - series.startYear
        >= ITRDB_VALIDATION_PROTOCOL.inclusion.minimumOlderContextYears
    && series.endYear - year
        >= ITRDB_VALIDATION_PROTOCOL.inclusion.minimumNewerContextYears
)).map(([year]) => year).sort((a, b) => a - b);

const emptyCounts = (): Record<ItrdbSupplementaryManifestCase["kind"], number> => ({
    singleInjected: 0,
    naturalSingle: 0,
    separatedMulti: 0,
    adjacentMulti: 0,
    crossSeries: 0,
    naturalBootstrap: 0,
});

const quotas: Record<ItrdbSupplementaryManifestCase["kind"], number> = {
    singleInjected: ITRDB_VALIDATION_PROTOCOL.formalHoldout.casesPerSplit,
    naturalSingle: ITRDB_VALIDATION_PROTOCOL.supplementary.naturalSingleCasesPerSplit,
    separatedMulti: ITRDB_VALIDATION_PROTOCOL.supplementary.separatedMultiCasesPerSplit,
    adjacentMulti: ITRDB_VALIDATION_PROTOCOL.supplementary.adjacentMultiCasesPerSplit,
    crossSeries: ITRDB_VALIDATION_PROTOCOL.supplementary.crossSeriesCasesPerSplit,
    naturalBootstrap: ITRDB_VALIDATION_PROTOCOL.supplementary.naturalBootstrapSitesPerSplit,
};

const allFiles: string[] = [];
collectRwlFiles(datasetRoot, allFiles);
const relativeFiles = allFiles.map((path) => ({
    path,
    relativePath: normalizeItrdbRelativePath(relative(datasetRoot, path)),
}));
const splits: ItrdbValidationManifest["splits"] = {
    development: { cases: [], counts: emptyCounts() },
    calibration: { cases: [], counts: emptyCounts() },
    final: { cases: [], counts: emptyCounts() },
};

for (const split of ["development", "calibration", "final"] as const) {
    const candidates = relativeFiles
        .filter(({ relativePath }) => itrdbSplitForRelativePath(relativePath) === split)
        .sort((left, right) => (
            hashOrder(`file:${split}`, left.relativePath)
            - hashOrder(`file:${split}`, right.relativePath)
            || left.relativePath.localeCompare(right.relativePath)
        ));
    const selected = splits[split];
    for (const file of candidates) {
        if (Object.entries(quotas).every(([kind, quota]) => (
            selected.counts[kind as keyof typeof quotas] >= quota
        ))) break;
        let parsed: Map<string, RwlSeries>;
        try {
            parsed = parseRwl(readFileSync(file.path, "utf8"));
        } catch {
            continue;
        }
        const series = Array.from(parsed.values());
        if (series.length < 6) continue;
        const injected = eligibleInjectedTargets(series).sort((left, right) => (
            hashOrder(file.relativePath, left.id) - hashOrder(file.relativePath, right.id)
        ));

        if (selected.counts.singleInjected < quotas.singleInjected) {
            const target = injected.find((candidate) => pickYearInStratum(
                candidate,
                selected.counts.singleInjected,
                `${file.relativePath}:single`,
            ) !== null);
            if (target) {
                const truthYear = pickYearInStratum(
                    target,
                    selected.counts.singleInjected,
                    `${file.relativePath}:single`,
                )!;
                selected.cases.push({
                    caseId: `${split}:single:${file.relativePath}:${target.id}:${truthYear}`,
                    kind: "singleInjected",
                    file: file.relativePath,
                    ...descriptor(target, series),
                    truthYears: [truthYear],
                    falseRingMode: (
                        ["average", "moderate", "splitLike"] as const
                    )[selected.counts.singleInjected % 3],
                });
                selected.counts.singleInjected += 1;
            }
        }

        if (selected.counts.separatedMulti < quotas.separatedMulti) {
            const target = injected.find((candidate) => (
                pickSeparatedYears(candidate, `${file.relativePath}:separated`) !== null
            ));
            if (target) {
                const truthYears = pickSeparatedYears(target, `${file.relativePath}:separated`)!;
                selected.cases.push({
                    caseId: `${split}:separated:${file.relativePath}:${target.id}`,
                    kind: "separatedMulti",
                    file: file.relativePath,
                    ...descriptor(target, series),
                    truthYears,
                });
                selected.counts.separatedMulti += 1;
            }
        }

        if (selected.counts.adjacentMulti < quotas.adjacentMulti) {
            const target = injected.find((candidate) => (
                pickAdjacentYears(candidate, `${file.relativePath}:adjacent`) !== null
            ));
            if (target) {
                const truthYears = pickAdjacentYears(target, `${file.relativePath}:adjacent`)!;
                selected.cases.push({
                    caseId: `${split}:adjacent:${file.relativePath}:${target.id}`,
                    kind: "adjacentMulti",
                    file: file.relativePath,
                    ...descriptor(target, series),
                    truthYears,
                });
                selected.counts.adjacentMulti += 1;
            }
        }

        if (selected.counts.crossSeries < quotas.crossSeries && injected.length >= 2) {
            const targets = injected.slice(0, 2).map((target, index) => ({
                target,
                year: pickYearInStratum(
                    target,
                    (selected.counts.crossSeries + index * 2) % 5,
                    `${file.relativePath}:cross:${index}`,
                ),
            }));
            if (targets.every(({ year }) => year !== null)) {
                selected.cases.push({
                    caseId: `${split}:cross:${file.relativePath}`,
                    kind: "crossSeries",
                    file: file.relativePath,
                    targets: targets.map(({ target, year }) => ({
                        ...descriptor(target, series),
                        truthYears: [year!] as [number],
                    })),
                });
                selected.counts.crossSeries += 1;
            }
        }

        const naturalTargets = series.filter((target) => {
            const zeros = Array.from(target.valuesByYear.values()).filter((value) => value === 0);
            return target.length >= ITRDB_VALIDATION_PROTOCOL.inclusion.minimumNaturalSeriesLength
                && zeros.length > 0
                && zeros.length / target.length
                    <= ITRDB_VALIDATION_PROTOCOL.inclusion.maximumNaturalZeroDensity
                && referenceCount(target, series)
                    >= ITRDB_VALIDATION_PROTOCOL.inclusion.minimumReferenceCount;
        }).sort((left, right) => (
            hashOrder(`${file.relativePath}:natural`, left.id)
            - hashOrder(`${file.relativePath}:natural`, right.id)
        ));

        if (selected.counts.naturalSingle < quotas.naturalSingle) {
            const target = naturalTargets.find((candidate) => (
                eligibleNaturalTruthYears(candidate).length > 0
            ));
            if (target) {
                const truthCandidates = eligibleNaturalTruthYears(target);
                const truthYear = truthCandidates[
                    hashOrder(`${file.relativePath}:natural-year`, target.id)
                    % truthCandidates.length
                ];
                selected.cases.push({
                    caseId: `${split}:natural:${file.relativePath}:${target.id}:${truthYear}`,
                    kind: "naturalSingle",
                    file: file.relativePath,
                    ...descriptor(target, series),
                    truthYears: [truthYear],
                });
                selected.counts.naturalSingle += 1;
            }
        }

        if (selected.counts.naturalBootstrap < quotas.naturalBootstrap) {
            const allNaturalTargets = series.filter((target) => (
                Array.from(target.valuesByYear.values()).some((value) => value === 0)
            ));
            const totalTruths = allNaturalTargets.reduce((sum, target) => (
                sum + Array.from(target.valuesByYear.values()).filter((value) => value === 0).length
            ), 0);
            if (allNaturalTargets.length >= 2
                && totalTruths >= 2
                && totalTruths <= ITRDB_VALIDATION_PROTOCOL.supplementary
                    .maximumNaturalBootstrapTruths) {
                selected.cases.push({
                    caseId: `${split}:bootstrap:${file.relativePath}`,
                    kind: "naturalBootstrap",
                    file: file.relativePath,
                    targets: allNaturalTargets.map((target) => ({
                        ...descriptor(target, series),
                        truthYears: Array.from(target.valuesByYear)
                            .filter(([, value]) => value === 0)
                            .map(([year]) => year)
                            .sort((a, b) => a - b),
                        scoredTruthYears: eligibleNaturalTruthYears(target),
                    })),
                });
                selected.counts.naturalBootstrap += 1;
            }
        }
    }
}

const selectedFiles = new Set(Object.values(splits).flatMap(({ cases }) => (
    cases.map((item) => item.file)
)));
const fileSha256 = Object.fromEntries(Array.from(selectedFiles).sort().map((relativePath) => {
    const path = resolve(datasetRoot, relativePath);
    return [
        relativePath,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
    ];
}));

const manifest: ItrdbValidationManifest = {
    schemaVersion: 1,
    protocol: ITRDB_VALIDATION_PROTOCOL,
    datasetRoot,
    selection: {
        fileUnit: "RWL site",
        splitUsesOnlyNormalizedRelativePath: true,
        eventSelectionUsesSignal: false,
        eventSelectionUsesRingWidthMagnitude: false,
        finalCasesGeneratedBeforeFinalEvaluation: true,
    },
    fileSha256,
    splits,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
// eslint-disable-next-line no-console
console.log(`ITRDB_VALIDATION_MANIFEST ${JSON.stringify({
    outputPath,
    datasetFiles: allFiles.length,
    selectedFiles: selectedFiles.size,
    splits: Object.fromEntries(Object.entries(splits).map(([split, value]) => [
        split,
        value.counts,
    ])),
})}`);
