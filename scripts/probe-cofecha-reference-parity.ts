/** Runs controlled COFECHA profiles and compares their saved masters with JS variants. */
import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
    COFECHA_REFERENCE_DEFAULT_OPTIONS,
    cofecha606DivideSeries,
    cofecha606StabilizeFilteredSeries,
    cofechaStyleStandardize,
    solveCofecha606SplineTrend,
    type CofechaArImplementation,
    type CofechaDetrendImplementation,
    type CofechaLogImplementation,
    type CofechaNumericImplementation,
    type CofechaSplineImplementation,
} from "@/features/crossdating/reference";
import { loadRwl } from "./legacy-generalization/evaluator";

type ProbeProfile = {
    id: string;
    useAr: boolean;
    useLog: boolean;
};

const ALL_PROFILES: ProbeProfile[] = [
    { id: "plain", useAr: false, useLog: false },
    { id: "logon", useAr: false, useLog: true },
    { id: "arraw", useAr: true, useLog: false },
    { id: "full", useAr: true, useLog: true },
];
const DEFAULT_LAMBDA_SCALES = [
    0.05,
    0.1,
    0.2,
    0.35,
    0.5,
    0.75,
    1,
    1.5,
    2,
    3,
    5,
    8,
    12,
    20,
];
const AR_MODES: CofechaArImplementation[] = [
    "current-aic",
    "fixed-1",
    "fixed-2",
    "fixed-3",
    "fixed-4",
    "fixed-5",
];
const SPLINE_MODES: CofechaSplineImplementation[] = [
    "ltrr-cook-holmes",
    "discrete-penalty",
];
const ALL_DETREND_MODES: CofechaDetrendImplementation[] = [
    "ratio",
    "residual-plus-one",
];
const ALL_LOG_MODES: CofechaLogImplementation[] = [
    "post-ar",
    "pre-spline-ratio",
    "pre-spline-residual",
];
const ALL_FILTERED_QUANTIZATION_DIGITS: Array<number | null> = [null, 2, 3, 4];
const ALL_NUMERIC_MODES: CofechaNumericImplementation[] = [
    "double",
    "legacy-float32",
];

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string, fallback = ""): string => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const sourcePath = resolve(valueFor("--rwl"));
const cofechaExe = resolve(valueFor("--cofecha-exe"));
const outputDir = resolve(valueFor("--output-dir"));
const requestedProfiles = new Set(valueFor("--profiles", "plain,logon,arraw,full")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
const profiles = ALL_PROFILES.filter((profile) => requestedProfiles.has(profile.id));
const listMeasurements = valueFor("--list-measurements", "false") === "true";
const requestedLambdaScales = valueFor("--lambda-scales", "");
const lambdaScalesToTest = requestedLambdaScales
    ? requestedLambdaScales.split(",").map(Number).filter((value) => (
        Number.isFinite(value) && value > 0
    ))
    : DEFAULT_LAMBDA_SCALES;
const requestedDetrendModes = new Set(valueFor("--detrend-modes", "ratio")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
const detrendModesToTest = ALL_DETREND_MODES.filter((mode) => (
    requestedDetrendModes.has(mode)
));
const requestedQuantization = new Set(valueFor("--quantization-digits", "none")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
const filteredQuantizationDigitsToTest = ALL_FILTERED_QUANTIZATION_DIGITS.filter((digits) => (
    requestedQuantization.has(digits === null ? "none" : String(digits))
));
const requestedLogModes = new Set(valueFor("--log-modes", "post-ar")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
const logModesToTest = ALL_LOG_MODES.filter((mode) => requestedLogModes.has(mode));
const requestedNumericModes = new Set(valueFor("--numeric-modes", "double")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
const numericModesToTest = ALL_NUMERIC_MODES.filter((mode) => (
    requestedNumericModes.has(mode)
));
mkdirSync(outputDir, { recursive: true });
const runtimeName = "INPUT.RWL";
copyFileSync(sourcePath, join(outputDir, runtimeName));

const mean = (values: readonly number[]) => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);
const sd = (values: readonly number[], sample: boolean) => {
    if (values.length < 2) return 0;
    const average = mean(values);
    const denominator = sample ? values.length - 1 : values.length;
    return Math.sqrt(values.reduce(
        (sum, value) => sum + (value - average) ** 2,
        0,
    ) / denominator);
};
const zScoreMap = (values: Map<number, number>, sample: boolean) => {
    const rows = [...values.values()];
    const average = mean(rows);
    const scale = sd(rows, sample) || 1;
    return new Map([...values].map(([year, value]) => [
        year,
        (value - average) / scale,
    ]));
};
const quantizePoints = <T extends { value: number }>(
    points: readonly T[],
    digits: number | null,
): T[] => {
    if (digits === null) return points.slice();
    const scale = 10 ** digits;
    return points.map((point) => ({
        ...point,
        value: Math.round(point.value * scale) / scale,
    }));
};
const seriesStats = (values: readonly number[]) => {
    const average = mean(values);
    const lagPairs = values.slice(1).map((value, index) => [
        values[index],
        value,
    ] as const);
    const leftMean = mean(lagPairs.map((pair) => pair[0]));
    const rightMean = mean(lagPairs.map((pair) => pair[1]));
    const numerator = lagPairs.reduce((sum, pair) => (
        sum + (pair[0] - leftMean) * (pair[1] - rightMean)
    ), 0);
    const denominator = Math.sqrt(
        lagPairs.reduce((sum, pair) => sum + (pair[0] - leftMean) ** 2, 0)
        * lagPairs.reduce((sum, pair) => sum + (pair[1] - rightMean) ** 2, 0),
    );
    return {
        mean: average,
        maximum: Math.max(...values),
        sampleSd: sd(values, true),
        populationSd: sd(values, false),
        lagOneAutocorrelation: denominator > 0 ? numerator / denominator : null,
        meanSensitivity: mean(values.slice(1).map((value, index) => (
            Math.abs(value - values[index])
            / Math.max(1e-12, (value + values[index]) / 2)
        ))),
    };
};

const jobName = (profile: ProbeProfile) => profile.id.slice(0, 5).toUpperCase();
const masterPath = (profile: ProbeProfile) => join(
    outputDir,
    `${jobName(profile)}COF.MAS`,
);
const reportPath = (profile: ProbeProfile) => join(
    outputDir,
    `${jobName(profile)}COF.OUT`,
);
const buildPrompt = (profile: ProbeProfile) => {
    const lines = [
        jobName(profile),
        runtimeName,
        "", // accept measurement format
        "", // no undated file
        "", // blank title
    ];
    if (!profile.useAr) lines.push("3", "N");
    if (!profile.useLog) lines.push("4", "N");
    lines.push("6", "V", "");
    if (listMeasurements) {
        lines.splice(lines.length - 1, 0, "7", "Y");
    }
    return `${lines.join("\n")}\n`;
};
const runProfile = (profile: ProbeProfile) => {
    rmSync(masterPath(profile), { force: true });
    const result = spawnSync(cofechaExe, [], {
        cwd: outputDir,
        input: buildPrompt(profile),
        encoding: "utf8",
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`COFECHA ${profile.id} failed: ${result.stderr}`);
    }
    const path = masterPath(profile);
    const master = new Map<number, number>();
    readFileSync(path, "utf8").split(/\r?\n/).forEach((line) => {
        const match = line.match(/^\s*(-?\d+)\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*$/);
        if (match) master.set(Number(match[1]), Number(match[2]));
    });
    if (master.size === 0) throw new Error(`empty COFECHA master: ${path}`);
    const descriptiveStats = new Map<string, {
        correlationWithMaster: number;
        unfilteredMean: number;
        unfilteredMaximum: number;
        unfilteredSd: number;
        unfilteredLagOneAutocorrelation: number;
        filteredMeanSensitivity: number;
        filteredMaximum: number;
        filteredSd: number;
        filteredLagOneAutocorrelation: number;
        arOrder: number;
    }>();
    const report = readFileSync(reportPath(profile), "utf8");
    const partSeven = report.split("PART 7:  DESCRIPTIVE STATISTICS:")[1] ?? "";
    partSeven.split(/\r?\n/).forEach((line) => {
        const fields = line.trim().split(/\s+/);
        if (fields.length !== 17 || !/^\d+$/.test(fields[0])) return;
        const numeric = fields.slice(2).map(Number);
        if (numeric.some((value) => !Number.isFinite(value))) return;
        descriptiveStats.set(fields[1].toUpperCase(), {
            correlationWithMaster: numeric[5],
            unfilteredMean: numeric[6],
            unfilteredMaximum: numeric[7],
            unfilteredSd: numeric[8],
            unfilteredLagOneAutocorrelation: numeric[9],
            filteredMeanSensitivity: numeric[10],
            filteredMaximum: numeric[11],
            filteredSd: numeric[12],
            filteredLagOneAutocorrelation: numeric[13],
            arOrder: numeric[14],
        });
    });
    return { master, descriptiveStats };
};

const loaded = await loadRwl(sourcePath, "tucson-auto");
const firstTreeEntry = loaded.siteData.entries().next().value as
    | [string, (typeof loaded.siteData extends Map<string, infer V> ? V : never)]
    | undefined;
if (!firstTreeEntry) throw new Error(`empty RWL: ${sourcePath}`);
const [firstTreeId, firstTree] = firstTreeEntry;
const firstRawValues = [...firstTree.entries()]
    .filter((entry): entry is [number, number] => (
        typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0
    ))
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value);
const exactFirstTrend = solveCofecha606SplineTrend(
    firstRawValues,
    COFECHA_REFERENCE_DEFAULT_OPTIONS.splineRigidityYears,
    COFECHA_REFERENCE_DEFAULT_OPTIONS.splineFrequencyResponse,
);
const exactFirstDetrended = exactFirstTrend
    ? cofecha606DivideSeries(firstRawValues, exactFirstTrend)
    : null;
const exactFirstStabilized = exactFirstDetrended
    ? cofecha606StabilizeFilteredSeries(
        exactFirstDetrended,
        COFECHA_REFERENCE_DEFAULT_OPTIONS.splineRigidityYears,
        COFECHA_REFERENCE_DEFAULT_OPTIONS.splineFrequencyResponse,
    )
    : null;
const standardizeFirstCore = (input: {
    profile: ProbeProfile;
    spline: CofechaSplineImplementation;
    ar: CofechaArImplementation;
    splineLambdaScale: number;
    detrend: CofechaDetrendImplementation;
    log: CofechaLogImplementation;
    numeric: CofechaNumericImplementation;
}) => cofechaStyleStandardize(firstTree, {
    ...COFECHA_REFERENCE_DEFAULT_OPTIONS,
    useAutoregressiveModel: input.profile.useAr,
    useLogTransform: input.profile.useLog,
    minReplication: 1,
}, input.spline, input.profile.useAr ? input.ar : "none", input.splineLambdaScale, input.detrend, input.log, input.numeric);
const buildJsMaster = (input: {
    profile: ProbeProfile;
    spline: CofechaSplineImplementation;
    ar: CofechaArImplementation;
    normalizeCore: boolean;
    sampleCoreSd: boolean;
    sampleMasterSd: boolean;
    splineLambdaScale: number;
    detrend: CofechaDetrendImplementation;
    log: CofechaLogImplementation;
    numeric: CofechaNumericImplementation;
    filteredQuantizationDigits: number | null;
}) => {
    const valuesByYear = new Map<number, number[]>();
    loaded.siteData.forEach((tree) => {
        let points = quantizePoints(cofechaStyleStandardize(tree, {
            ...COFECHA_REFERENCE_DEFAULT_OPTIONS,
            useAutoregressiveModel: input.profile.useAr,
            useLogTransform: input.profile.useLog,
            minReplication: 1,
        }, input.spline, input.profile.useAr ? input.ar : "none", input.splineLambdaScale, input.detrend, input.log, input.numeric), input.filteredQuantizationDigits);
        if (input.normalizeCore && points.length > 0) {
            const values = points.map((point) => point.value);
            const average = mean(values);
            const scale = sd(values, input.sampleCoreSd) || 1;
            points = points.map((point) => ({
                ...point,
                value: (point.value - average) / scale,
            }));
        }
        points.forEach(({ year, value }) => {
            valuesByYear.set(year, [...valuesByYear.get(year) ?? [], value]);
        });
    });
    const raw = new Map([...valuesByYear]
        .sort(([left], [right]) => left - right)
        .map(([year, values]) => [year, mean(values)]));
    return zScoreMap(raw, input.sampleMasterSd);
};

const compare = (
    expected: ReadonlyMap<number, number>,
    actual: ReadonlyMap<number, number>,
) => {
    const pairs = [...expected].flatMap(([year, expectedValue]) => {
        const actualValue = actual.get(year);
        return actualValue === undefined ? [] : [{ year, expectedValue, actualValue }];
    });
    const expectedValues = pairs.map((row) => row.expectedValue);
    const actualValues = pairs.map((row) => row.actualValue);
    const expectedMean = mean(expectedValues);
    const actualMean = mean(actualValues);
    let covariance = 0;
    let expectedVariance = 0;
    let actualVariance = 0;
    pairs.forEach((row) => {
        const expectedDelta = row.expectedValue - expectedMean;
        const actualDelta = row.actualValue - actualMean;
        covariance += expectedDelta * actualDelta;
        expectedVariance += expectedDelta ** 2;
        actualVariance += actualDelta ** 2;
    });
    const errors = pairs.map((row) => row.actualValue - row.expectedValue);
    return {
        expectedYears: expected.size,
        actualYears: actual.size,
        overlapYears: pairs.length,
        correlation: covariance / Math.sqrt(expectedVariance * actualVariance),
        rmse: Math.sqrt(mean(errors.map((error) => error ** 2))),
        mae: mean(errors.map(Math.abs)),
        maxAbsoluteError: Math.max(...errors.map(Math.abs)),
        exactFourDecimals: pairs.filter((row) => (
            row.actualValue.toFixed(4) === row.expectedValue.toFixed(4)
        )).length,
        exactFourDecimalRate: pairs.filter((row) => (
            row.actualValue.toFixed(4) === row.expectedValue.toFixed(4)
        )).length / Math.max(1, pairs.length),
    };
};

const differenceDiagnostics = (
    expected: ReadonlyMap<number, number>,
    actual: ReadonlyMap<number, number>,
) => {
    const rows = [...expected].flatMap(([year, expectedValue]) => {
        const actualValue = actual.get(year);
        return actualValue === undefined ? [] : [{
            year,
            expected: expectedValue,
            actual: actualValue,
            error: actualValue - expectedValue,
        }];
    }).sort((left, right) => left.year - right.year);
    const rmse = (selected: typeof rows) => Math.sqrt(mean(selected.map(
        (row) => row.error ** 2,
    )));
    return {
        firstTwentyRmse: rmse(rows.slice(0, 20)),
        middleRmse: rmse(rows.slice(20, -20)),
        lastTwentyRmse: rmse(rows.slice(-20)),
        largestErrors: [...rows].sort((left, right) => (
            Math.abs(right.error) - Math.abs(left.error)
        )).slice(0, 20),
    };
};

const profileResults = [];
for (const profile of profiles) {
    const cofecha = runProfile(profile);
    const cofechaMaster = cofecha.master;
    const variants = [];
    const filterDiagnostics: Array<{
        spline: CofechaSplineImplementation;
        splineLambdaScale: number;
        ar: CofechaArImplementation | "none";
        detrend: CofechaDetrendImplementation;
        log: CofechaLogImplementation;
        numeric: CofechaNumericImplementation;
        filteredQuantizationDigits: number | null;
        firstCoreStats: ReturnType<typeof seriesStats>;
    }> = [];
    const arModes = profile.useAr ? AR_MODES : ["none" as const];
    for (const spline of SPLINE_MODES) {
        const lambdaScales = spline === "discrete-penalty" ? lambdaScalesToTest : [1];
        for (const splineLambdaScale of lambdaScales) {
            for (const ar of arModes) {
                const profileLogModes = profile.useLog ? logModesToTest : ["post-ar" as const];
                for (const log of profileLogModes) {
                    for (const detrend of detrendModesToTest) {
                    for (const numeric of numericModesToTest) {
                    const unquantizedFirstCorePoints = standardizeFirstCore({
                        profile,
                        spline,
                        ar,
                        splineLambdaScale,
                        detrend,
                        log,
                        numeric,
                    });
                    for (const filteredQuantizationDigits of filteredQuantizationDigitsToTest) {
                        const rawFirstCorePoints = quantizePoints(
                            unquantizedFirstCorePoints,
                            filteredQuantizationDigits,
                        );
                        filterDiagnostics.push({
                            spline,
                            splineLambdaScale,
                            ar,
                            detrend,
                            log,
                            numeric,
                            filteredQuantizationDigits,
                            firstCoreStats: seriesStats(
                                rawFirstCorePoints.map((point) => point.value),
                            ),
                        });
                        for (const normalizeCore of [false, true]) {
                            for (const sampleCoreSd of [false, true]) {
                                if (!normalizeCore && sampleCoreSd) continue;
                                for (const sampleMasterSd of [false, true]) {
                                    const jsMaster = buildJsMaster({
                                        profile,
                                        spline,
                                        ar,
                                        normalizeCore,
                                        sampleCoreSd,
                                        sampleMasterSd,
                                        splineLambdaScale,
                                        detrend,
                                        log,
                                        numeric,
                                        filteredQuantizationDigits,
                                    });
                                    variants.push({
                                        spline,
                                        splineLambdaScale,
                                        ar,
                                        detrend,
                                        log,
                                        numeric,
                                        filteredQuantizationDigits,
                                        normalizeCore,
                                        sampleCoreSd,
                                        sampleMasterSd,
                                        rawFirstCoreStats: seriesStats(
                                            rawFirstCorePoints.map((point) => point.value),
                                        ),
                                        ...compare(cofechaMaster, jsMaster),
                                    });
                                }
                            }
                        }
                    }
                    }
                }
                }
            }
        }
    }
    variants.sort((left, right) => (
        right.correlation - left.correlation
        || left.rmse - right.rmse
        || right.exactFourDecimalRate - left.exactFourDecimalRate
    ));
    const best = variants[0];
    const bestMaster = buildJsMaster({
        profile,
        spline: best.spline,
        ar: best.ar,
        normalizeCore: best.normalizeCore,
        sampleCoreSd: best.sampleCoreSd,
        sampleMasterSd: best.sampleMasterSd,
        splineLambdaScale: best.splineLambdaScale,
        detrend: best.detrend,
        log: best.log,
        numeric: best.numeric,
        filteredQuantizationDigits: best.filteredQuantizationDigits,
    });
    let bestFirstCorePoints = quantizePoints(standardizeFirstCore({
        profile,
        spline: best.spline,
        ar: best.ar,
        splineLambdaScale: best.splineLambdaScale,
        detrend: best.detrend,
        log: best.log,
        numeric: best.numeric,
    }), best.filteredQuantizationDigits);
    const rawBestFirstCoreStats = seriesStats(
        bestFirstCorePoints.map((point) => point.value),
    );
    if (best.normalizeCore && bestFirstCorePoints.length > 0) {
        const values = bestFirstCorePoints.map((point) => point.value);
        const average = mean(values);
        const scale = sd(values, best.sampleCoreSd) || 1;
        bestFirstCorePoints = bestFirstCorePoints.map((point) => ({
            ...point,
            value: (point.value - average) / scale,
        }));
    }
    profileResults.push({
        profile,
        cofechaMasterPath: masterPath(profile),
        cofechaYears: cofechaMaster.size,
        firstCoreId: firstTreeId,
        cofechaFirstCoreStats: cofecha.descriptiveStats.get(firstTreeId.toUpperCase()) ?? null,
        rawBestFirstCoreStats,
        normalizedBestFirstCoreStats: seriesStats(
            bestFirstCorePoints.map((point) => point.value),
        ),
        filterDiagnostics,
        bestDifferenceDiagnostics: differenceDiagnostics(cofechaMaster, bestMaster),
        bestVariantBySpline: SPLINE_MODES.map((spline) => (
            variants.find((variant) => variant.spline === spline) ?? null
        )),
        bestVariantByDetrend: detrendModesToTest.map((detrend) => (
            variants.find((variant) => variant.detrend === detrend) ?? null
        )),
        bestVariants: variants.slice(0, 20),
    });
    console.log(`COFECHA_PARITY_PROFILE ${JSON.stringify({
        profile: profile.id,
        years: cofechaMaster.size,
        best,
    })}`);
}

const output = {
    schemaVersion: 1,
    sourcePath,
    sourceName: basename(sourcePath),
    cofechaExe,
    exactPlainCoreDiagnostics: {
        splineSolved: exactFirstTrend !== null,
        firstDetrendedStats: exactFirstDetrended
            ? seriesStats(exactFirstDetrended)
            : null,
        stabilizedStats: exactFirstStabilized
            ? seriesStats(exactFirstStabilized)
            : null,
        stabilizedChangedValues: exactFirstDetrended && exactFirstStabilized
            ? exactFirstDetrended.filter((value, index) => (
                value !== exactFirstStabilized[index]
            )).length
            : 0,
    },
    profiles: profileResults,
};
writeFileSync(
    join(outputDir, "parity-report.json"),
    `${JSON.stringify(output, null, 2)}\n`,
);
console.log(`COFECHA_REFERENCE_PARITY_COMPLETE ${join(outputDir, "parity-report.json")}`);
