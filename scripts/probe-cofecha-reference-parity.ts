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
import { stopMarker } from "@/shared/constants";
import { parseCofecha606TucsonWidth } from "@/features/crossdating/cofecha606F63";
import { detectPrecision } from "@/features/rwl/detect";
import {
    COFECHA_REFERENCE_DEFAULT_OPTIONS,
    buildCofecha606MasterSeries,
    cofecha606DivideSeries,
    cofecha606StandardizeValues,
    cofecha606StabilizeFilteredSeries,
    cofechaStyleStandardize,
    formatCofecha606MasterSeries,
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
    "fixed-6",
    "fixed-7",
    "fixed-8",
    "fixed-9",
    "fixed-10",
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
const exactOnly = valueFor("--exact-only", "false") === "true";
const runtimeStagesPath = valueFor("--runtime-stages", "");
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
    const masterText = readFileSync(path, "utf8");
    const master = new Map<number, number>();
    masterText.split(/\r?\n/).forEach((line) => {
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
    const masterDepth = new Map<number, number>();
    const partThreeHeading = "PART 3:  Master Dating Series:";
    const partThreeStart = report.indexOf(partThreeHeading);
    const partThree = partThreeStart >= 0
        ? report.slice(partThreeStart + partThreeHeading.length)
            .split("PART 4:  Master Bar Plot:")[0] ?? ""
        : "";
    const depthPattern = /(?:^|\s)(-?\d{1,4})\s+([+-]?(?:\d*\.\d+))\s+(\d+)(?=\s|$)/g;
    for (const match of partThree.matchAll(depthPattern)) {
        masterDepth.set(Number(match[1]), Number(match[3]));
    }
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
    return { master, masterText, masterDepth, descriptiveStats };
};

stopMarker.value = await detectPrecision(readFileSync(sourcePath, "utf8"));
const loaded = await loadRwl(sourcePath, "tucson-auto", {
    preserveNegativeMeasurements: true,
});
const inputValues = [...loaded.siteData.values()].flatMap((tree) => (
    [...tree.values()].filter((value): value is number => (
        typeof value === "number" && Number.isFinite(value) && value !== stopMarker.value
    ))
));
const structuralGapCount = [...loaded.siteData.values()].reduce((total, tree) => {
    const years = [...tree.entries()]
        .filter(([, value]) => value !== stopMarker.value)
        .map(([year]) => year);
    if (years.length === 0) return total;
    return total + (Math.max(...years) - Math.min(...years) + 1 - years.length);
}, 0);
const inputStats = {
    stopMarker: stopMarker.value,
    seriesCount: loaded.siteData.size,
    pointCount: inputValues.length,
    zeroCount: inputValues.filter((value) => value === 0).length,
    above9998Count: inputValues.filter((value) => value > 9998).length,
    maximumWidth: inputValues.length > 0 ? Math.max(...inputValues) : null,
    structuralGapCount,
    series: [...loaded.siteData].map(([seriesId, tree]) => {
        const entries = [...tree.entries()]
            .filter(([, value]) => value !== stopMarker.value)
            .sort(([left], [right]) => left - right);
        return {
            seriesId,
            startYear: entries[0]?.[0] ?? null,
            endYear: entries.at(-1)?.[0] ?? null,
            pointCount: entries.length,
            zeroCount: entries.filter(([, value]) => value === 0).length,
            leadingZero: entries[0]?.[1] === 0,
            trailingZero: entries.at(-1)?.[1] === 0,
        };
    }),
};
const runtimeInputAudit = (() => {
    if (!runtimeStagesPath) return null;
    const runtime = JSON.parse(readFileSync(resolve(runtimeStagesPath), "utf8"));
    const firstSplinePasses = runtime.records
        .filter((record: { stage?: string }) => record.stage === "spline")
        .filter((_: unknown, index: number) => index % 2 === 0);
    const runtimeMasterCores = runtime.records.filter((record: {
        stage?: string;
        callerOffset?: string;
    }) => record.stage === "standardize" && record.callerOffset === "0x795f");
    const runtimeVariancePasses = runtime.records.filter((record: { stage?: string }) => (
        record.stage === "varianceStabilize"
    ));
    const runtimeFirstDivisions = runtime.records
        .filter((record: { stage?: string }) => record.stage === "divser")
        .filter((_: unknown, index: number) => index % 2 === 0);
    const runtimeVarianceStandardizations = runtime.records.filter((record: {
        stage?: string;
        callerOffset?: string;
    }) => record.stage === "standardize" && record.callerOffset === "0xe510");
    const runtimeSecondSplines = runtime.records
        .filter((record: { stage?: string }) => record.stage === "spline")
        .filter((_: unknown, index: number) => index % 2 === 1);
    const runtimeSecondDivisions = runtime.records
        .filter((record: { stage?: string }) => record.stage === "divser")
        .filter((_: unknown, index: number) => index % 2 === 1);
    const trees = [...loaded.siteData];
    const mismatches = trees.flatMap(([seriesId, tree], seriesIndex) => {
        const expected = [...tree.entries()]
            .filter((entry): entry is [number, number] => (
                typeof entry[1] === "number"
                && Number.isFinite(entry[1])
                && entry[1] !== stopMarker.value
            ))
            .sort(([left], [right]) => left - right)
            .map(([, value]) => parseCofecha606TucsonWidth(value, stopMarker.value));
        const actual = firstSplinePasses[seriesIndex]?.input ?? [];
        const valueMismatchCount = Array.from(
            { length: Math.min(expected.length, actual.length) },
            (_, index) => expected[index] !== actual[index],
        ).filter(Boolean).length;
        return expected.length === actual.length && valueMismatchCount === 0 ? [] : [{
            seriesId,
            expectedLength: expected.length,
            actualLength: actual.length,
            valueMismatchCount,
        }];
    });
    return {
        expectedSeries: trees.length,
        actualSeries: firstSplinePasses.length,
        mismatches,
        masterCoreMismatches: trees.flatMap(([seriesId, tree], seriesIndex) => {
            const rawValues = [...tree.entries()]
                .filter((entry): entry is [number, number] => (
                    typeof entry[1] === "number"
                    && Number.isFinite(entry[1])
                    && entry[1] !== stopMarker.value
                ))
                .sort(([left], [right]) => left - right)
                .map(([, value]) => parseCofecha606TucsonWidth(value, stopMarker.value));
            const trend = solveCofecha606SplineTrend(rawValues, 32, 0.5) ?? [];
            const runtimeTrend = firstSplinePasses[seriesIndex]?.output ?? [];
            const trendErrors = Array.from(
                { length: Math.min(trend.length, runtimeTrend.length) },
                (_, index) => trend[index] - runtimeTrend[index],
            );
            const divided = trend.length === rawValues.length
                ? cofecha606DivideSeries(rawValues, trend)
                : [];
            const runtimeDivided = runtimeFirstDivisions[seriesIndex]?.output ?? [];
            const divisionErrors = Array.from(
                { length: Math.min(divided.length, runtimeDivided.length) },
                (_, index) => divided[index] - runtimeDivided[index],
            );
            const varianceStandardized = cofecha606StandardizeValues(divided);
            const runtimeVarianceStandardized = runtimeVarianceStandardizations[seriesIndex]?.output ?? [];
            const varianceStandardizationErrors = Array.from(
                {
                    length: Math.min(
                        varianceStandardized.length,
                        runtimeVarianceStandardized.length,
                    ),
                },
                (_, index) => (
                    varianceStandardized[index] - runtimeVarianceStandardized[index]
                ),
            );
            const absoluteStandardized = varianceStandardized.map((value) => (
                value < 0 ? Math.fround(value * -1) : value
            ));
            const secondTrend = solveCofecha606SplineTrend(
                absoluteStandardized,
                32,
                0.5,
            ) ?? [];
            const runtimeSecondTrend = runtimeSecondSplines[seriesIndex]?.output ?? [];
            const secondTrendErrors = Array.from(
                { length: Math.min(secondTrend.length, runtimeSecondTrend.length) },
                (_, index) => secondTrend[index] - runtimeSecondTrend[index],
            );
            const secondDivided = cofecha606DivideSeries(
                absoluteStandardized,
                secondTrend,
            );
            const runtimeSecondDivided = runtimeSecondDivisions[seriesIndex]?.output ?? [];
            const secondDivisionErrors = Array.from(
                { length: Math.min(secondDivided.length, runtimeSecondDivided.length) },
                (_, index) => secondDivided[index] - runtimeSecondDivided[index],
            );
            const unlogged = cofechaStyleStandardize(tree, {
                ...COFECHA_REFERENCE_DEFAULT_OPTIONS,
                useAutoregressiveModel: false,
                useLogTransform: false,
                omitAbsentRingsFromMaster: false,
            }, "ltrr-cook-holmes", "none", 1, "ratio", "post-ar", "legacy-float32");
            const runtimeVariance = runtimeVariancePasses[seriesIndex]?.output ?? [];
            const manualVariance = cofecha606StabilizeFilteredSeries(
                divided,
                32,
                0.5,
            );
            const manualVarianceErrors = Array.from(
                { length: Math.min(manualVariance.length, runtimeVariance.length) },
                (_, index) => manualVariance[index] - runtimeVariance[index],
            );
            const varianceErrors = Array.from(
                { length: Math.min(unlogged.length, runtimeVariance.length) },
                (_, index) => unlogged[index].value - runtimeVariance[index],
            );
            const filtered = cofechaStyleStandardize(tree, {
                ...COFECHA_REFERENCE_DEFAULT_OPTIONS,
                useAutoregressiveModel: false,
                useLogTransform: true,
                omitAbsentRingsFromMaster: false,
            }, "ltrr-cook-holmes", "none", 1, "ratio", "post-ar", "legacy-float32");
            const expected = cofecha606StandardizeValues(
                filtered.map((point) => point.value),
            );
            const runtimeCore = runtimeMasterCores[seriesIndex];
            const actualInput = runtimeCore?.input ?? [];
            const actual = runtimeCore?.output ?? [];
            const inputErrors = Array.from(
                { length: Math.min(filtered.length, actualInput.length) },
                (_, index) => filtered[index].value - actualInput[index],
            );
            const errors = Array.from(
                { length: Math.min(expected.length, actual.length) },
                (_, index) => expected[index] - actual[index],
            );
            const mismatchCount = errors.filter((error) => error !== 0).length;
            return expected.length === actual.length && mismatchCount === 0 ? [] : [{
                seriesId,
                expectedLength: expected.length,
                actualLength: actual.length,
                mismatchCount,
                maxAbsoluteError: errors.length > 0
                    ? Math.max(...errors.map(Math.abs))
                    : null,
                inputMismatchCount: inputErrors.filter((error) => error !== 0).length,
                inputMaxAbsoluteError: inputErrors.length > 0
                    ? Math.max(...inputErrors.map(Math.abs))
                    : null,
                varianceMismatchCount: varianceErrors.filter((error) => error !== 0).length,
                varianceMaxAbsoluteError: varianceErrors.length > 0
                    ? Math.max(...varianceErrors.map(Math.abs))
                    : null,
                manualVarianceMismatchCount: manualVarianceErrors
                    .filter((error) => error !== 0).length,
                manualVarianceMaxAbsoluteError: manualVarianceErrors.length > 0
                    ? Math.max(...manualVarianceErrors.map(Math.abs))
                    : null,
                trendMismatchCount: trendErrors.filter((error) => error !== 0).length,
                trendMaxAbsoluteError: trendErrors.length > 0
                    ? Math.max(...trendErrors.map(Math.abs))
                    : null,
                divisionMismatchCount: divisionErrors.filter((error) => error !== 0).length,
                divisionMaxAbsoluteError: divisionErrors.length > 0
                    ? Math.max(...divisionErrors.map(Math.abs))
                    : null,
                varianceStandardizationMismatchCount: varianceStandardizationErrors
                    .filter((error) => error !== 0).length,
                varianceStandardizationMaxAbsoluteError: varianceStandardizationErrors.length > 0
                    ? Math.max(...varianceStandardizationErrors.map(Math.abs))
                    : null,
                secondTrendMismatchCount: secondTrendErrors.filter((error) => error !== 0).length,
                secondTrendMaxAbsoluteError: secondTrendErrors.length > 0
                    ? Math.max(...secondTrendErrors.map(Math.abs))
                    : null,
                secondDivisionMismatchCount: secondDivisionErrors
                    .filter((error) => error !== 0).length,
                secondDivisionMaxAbsoluteError: secondDivisionErrors.length > 0
                    ? Math.max(...secondDivisionErrors.map(Math.abs))
                    : null,
                expectedVarianceHead: unlogged.slice(0, 5).map((point) => point.value),
                manualVarianceHead: manualVariance.slice(0, 5),
                actualVarianceHead: runtimeVariance.slice(0, 5),
                standardizedHead: varianceStandardized.slice(0, 5),
                secondDivisionHead: secondDivided.slice(0, 5),
            }];
        }),
    };
})();
const firstTreeEntry = loaded.siteData.entries().next().value as
    | [string, (typeof loaded.siteData extends Map<string, infer V> ? V : never)]
    | undefined;
if (!firstTreeEntry) throw new Error(`empty RWL: ${sourcePath}`);
const [firstTreeId, firstTree] = firstTreeEntry;
const firstRawValues = [...firstTree.entries()]
    .filter((entry): entry is [number, number] => (
        typeof entry[1] === "number"
        && Number.isFinite(entry[1])
        && entry[1] !== stopMarker.value
    ))
    .sort(([left], [right]) => left - right)
    .map(([, value]) => parseCofecha606TucsonWidth(value, stopMarker.value));
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
const exactFirstStandardized = exactFirstDetrended
    ? cofecha606StandardizeValues(exactFirstDetrended)
    : null;
const exactFirstAbsoluteStandardized = exactFirstStandardized?.map((value) => (
    value < 0 ? Math.fround(value * -1) : value
)) ?? null;
const exactSecondTrend = exactFirstAbsoluteStandardized
    ? solveCofecha606SplineTrend(
        exactFirstAbsoluteStandardized,
        COFECHA_REFERENCE_DEFAULT_OPTIONS.splineRigidityYears,
        COFECHA_REFERENCE_DEFAULT_OPTIONS.splineFrequencyResponse,
    )
    : null;
const exactSecondDetrended = exactFirstAbsoluteStandardized && exactSecondTrend
    ? cofecha606DivideSeries(exactFirstAbsoluteStandardized, exactSecondTrend)
    : null;
const exactPlainMasterCorePoints = cofechaStyleStandardize(firstTree, {
    ...COFECHA_REFERENCE_DEFAULT_OPTIONS,
    useAutoregressiveModel: false,
    useLogTransform: false,
    omitAbsentRingsFromMaster: false,
    minReplication: 1,
}, "ltrr-cook-holmes", "none", 1, "ratio", "post-ar", "legacy-float32");
const exactPlainMasterCore = cofecha606StandardizeValues(
    exactPlainMasterCorePoints.map((point) => point.value),
);
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
            // COFECHA applies AR residuals to checking/statistics, not to the
            // saved master chronology. FULLCOF.MAS equals LOGONCOF.MAS and
            // ARRAWCOF.MAS equals PLAINCOF.MAS byte-for-byte.
            useAutoregressiveModel: false,
            useLogTransform: input.profile.useLog,
            minReplication: 1,
            omitAbsentRingsFromMaster: input.numeric !== "legacy-float32",
        }, input.spline, "none", input.splineLambdaScale, input.detrend, input.log, input.numeric), input.filteredQuantizationDigits);
        if (input.normalizeCore && points.length > 0) {
            const values = points.map((point) => point.value);
            if (input.numeric === "legacy-float32" && !input.sampleCoreSd) {
                const standardized = cofecha606StandardizeValues(values);
                points = points.map((point, index) => ({
                    ...point,
                    value: standardized[index],
                }));
            } else {
                const average = mean(values);
                const scale = sd(values, input.sampleCoreSd) || 1;
                points = points.map((point) => ({
                    ...point,
                    value: (point.value - average) / scale,
                }));
            }
        }
        points.forEach(({ year, value }) => {
            if (input.numeric === "legacy-float32" && tree.get(year) === 0) return;
            valuesByYear.set(year, [...valuesByYear.get(year) ?? [], value]);
        });
    });
    const raw = new Map([...valuesByYear]
        .sort(([left], [right]) => left - right)
        .map(([year, values]) => {
            if (input.numeric !== "legacy-float32") return [year, mean(values)];
            let sum = Math.fround(0);
            values.forEach((value) => {
                sum = Math.fround(sum + Math.fround(value));
            });
            return [year, Math.fround(sum / Math.fround(values.length))];
        }));
    if (input.numeric === "legacy-float32" && !input.sampleMasterSd) {
        const years = [...raw.keys()];
        const standardized = cofecha606StandardizeValues([...raw.values()]);
        return new Map(years.map((year, index) => [year, standardized[index]]));
    }
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
    const fourDecimals = (value: number) => {
        const formatted = value.toFixed(4);
        return formatted === "-0.0000" ? "0.0000" : formatted;
    };
    return {
        expectedYears: expected.size,
        actualYears: actual.size,
        overlapYears: pairs.length,
        correlation: covariance / Math.sqrt(expectedVariance * actualVariance),
        rmse: Math.sqrt(mean(errors.map((error) => error ** 2))),
        mae: mean(errors.map(Math.abs)),
        maxAbsoluteError: Math.max(...errors.map(Math.abs)),
        exactFourDecimals: pairs.filter((row) => (
            fourDecimals(row.actualValue) === fourDecimals(row.expectedValue)
        )).length,
        exactFourDecimalRate: pairs.filter((row) => (
            fourDecimals(row.actualValue) === fourDecimals(row.expectedValue)
        )).length / Math.max(1, pairs.length),
        fourDecimalMismatches: pairs.filter((row) => (
            fourDecimals(row.actualValue) !== fourDecimals(row.expectedValue)
        )).slice(0, 20),
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
    const exactBuilder = buildCofecha606MasterSeries(loaded.siteData, {
        ...COFECHA_REFERENCE_DEFAULT_OPTIONS,
        useAutoregressiveModel: profile.useAr,
        useLogTransform: profile.useLog,
    });
    if (!exactBuilder) throw new Error(`exact builder returned no master for ${profile.id}`);
    const formattedExactMaster = formatCofecha606MasterSeries(exactBuilder);
    const normalizedCofechaText = cofecha.masterText.replace(/\r?\n/g, "\r\n");
    const depthYears = new Set([
        ...cofecha.masterDepth.keys(),
        ...exactBuilder.sampleDepth.keys(),
    ]);
    const depthMismatches = [...depthYears].flatMap((year) => {
        const expected = cofecha.masterDepth.get(year);
        const actual = exactBuilder.sampleDepth.get(year);
        return expected === actual ? [] : [{ year, expected, actual }];
    });
    const exactBuilderResult = {
        ...compare(cofechaMaster, exactBuilder.data),
        formattedTextExact: formattedExactMaster === normalizedCofechaText,
        expectedDepthYears: cofecha.masterDepth.size,
        actualDepthYears: exactBuilder.sampleDepth.size,
        depthMismatches,
    };
    if (exactOnly) {
        profileResults.push({
            profile,
            cofechaMasterPath: masterPath(profile),
            cofechaYears: cofechaMaster.size,
            exactBuilder: exactBuilderResult,
        });
        console.log(`COFECHA_PARITY_PROFILE ${JSON.stringify({
            profile: profile.id,
            years: cofechaMaster.size,
            exactBuilder: exactBuilderResult,
        })}`);
        continue;
    }
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
        right.exactFourDecimalRate - left.exactFourDecimalRate
        || left.rmse - right.rmse
        || right.correlation - left.correlation
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
        exactBuilder: exactBuilderResult,
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
    inputStats,
    runtimeInputAudit,
    exactPlainCoreDiagnostics: {
        splineSolved: exactFirstTrend !== null,
        firstRawValues,
        firstTrendValues: exactFirstTrend,
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
        firstDetrendedValues: exactFirstDetrended,
        firstStandardizedValues: exactFirstStandardized,
        secondTrendValues: exactSecondTrend,
        secondDetrendedValues: exactSecondDetrended,
        masterCoreYears: exactPlainMasterCorePoints.map((point) => point.year),
        masterCoreFilteredValues: exactPlainMasterCorePoints.map((point) => point.value),
        masterCoreValues: exactPlainMasterCore,
    },
    profiles: profileResults,
};
writeFileSync(
    join(outputDir, "parity-report.json"),
    `${JSON.stringify(output, null, 2)}\n`,
);
console.log(`COFECHA_REFERENCE_PARITY_COMPLETE ${join(outputDir, "parity-report.json")}`);
