import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stopMarker } from "@/shared/constants";
import { detectPrecision } from "@/features/rwl/detect";
import {
    COFECHA_REFERENCE_DEFAULT_OPTIONS,
    buildCofecha606MasterSeries,
} from "@/features/crossdating/reference";
import {
    cofecha606Pearson,
    prepareCofecha606SeriesForReport,
} from "@/features/cofecha/jsReportSeries";
import { loadRwl } from "./legacy-generalization/evaluator";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? "" : "";
};
const path = resolve(valueFor("--rwl"));
const sequence = Number(valueFor("--sequence"));
const expected = Number(valueFor("--expected"));
const windowStart = Number(valueFor("--start"));
const windowEnd = Number(valueFor("--end"));
const inspectYear = Number(valueFor("--year"));
const splineRigidityYears = Number(valueFor("--spline-years") || 32);
stopMarker.value = await detectPrecision(readFileSync(path, "utf8"));
const loaded = await loadRwl(path, "tucson-auto", {
    preserveNegativeMeasurements: true,
});
const master = buildCofecha606MasterSeries(loaded.siteData, {
    ...COFECHA_REFERENCE_DEFAULT_OPTIONS,
    splineRigidityYears,
    useAutoregressiveModel: true,
    useLogTransform: true,
    useFirstDifference: false,
})!;
const prepared = prepareCofecha606SeriesForReport(loaded.siteData, {
    splineRigidityYears,
    splineFrequencyResponse: 0.5,
    segmentLength: 50,
    segmentLag: 25,
    useAutoregressiveModel: true,
    useLogTransform: true,
    segmentGridStartYear: -10000,
    segmentGridEndYear: 10000,
    analysisStartYear: -10000,
    analysisEndYear: 10000,
});

const averageMaps = (key: "masterValues" | "testingValues", omittedIndex?: number) => {
    const valuesByYear = new Map<number, number[]>();
    prepared.forEach((series, seriesIndex) => {
        if (seriesIndex === omittedIndex) return;
        series.years.forEach((year, index) => {
            const sourceValue = series.segment.data.get(year);
            if (typeof sourceValue === "number" && sourceValue <= 0) return;
            const rows = valuesByYear.get(year) ?? [];
            rows.push(series[key][index]);
            valuesByYear.set(year, rows);
        });
    });
    return new Map([...valuesByYear].map(([year, values]) => {
        let sum = Math.fround(0);
        values.forEach((value) => {
            sum = Math.fround(sum + Math.fround(value));
        });
        return [year, Math.fround(sum / Math.fround(values.length))];
    }));
};
const averageTestingIncludingNonPositive = (omittedIndex?: number) => {
    const valuesByYear = new Map<number, number[]>();
    prepared.forEach((series, seriesIndex) => {
        if (seriesIndex === omittedIndex) return;
        series.years.forEach((year, index) => {
            const rows = valuesByYear.get(year) ?? [];
            rows.push(series.testingValues[index]);
            valuesByYear.set(year, rows);
        });
    });
    return new Map([...valuesByYear].map(([year, values]) => {
        let sum = Math.fround(0);
        values.forEach((value) => {
            sum = Math.fround(sum + Math.fround(value));
        });
        return [year, Math.fround(sum / Math.fround(values.length))];
    }));
};

const target = prepared[sequence - 1];
const allTestingReference = averageMaps("testingValues");
const allMasterReference = averageMaps("masterValues");
const leaveOneOutMasterReference = averageMaps("masterValues", sequence - 1);
const leaveOneOutTestingReference = averageMaps("testingValues", sequence - 1);
const leaveOneOutWithFallback = new Map(allTestingReference);
leaveOneOutTestingReference.forEach((value, year) => {
    leaveOneOutWithFallback.set(year, value);
});
const testingAccumulator = (() => {
    const result = new Map<number, { sum: number; count: number }>();
    prepared.forEach((series) => {
        series.years.forEach((year, index) => {
            const sourceValue = series.segment.data.get(year);
            if (typeof sourceValue === "number" && sourceValue <= 0) return;
            const current = result.get(year) ?? { sum: Math.fround(0), count: 0 };
            current.sum = Math.fround(current.sum + Math.fround(series.testingValues[index]));
            current.count += 1;
            result.set(year, current);
        });
    });
    return result;
})();
const coverageCountByYear = (() => {
    const result = new Map<number, number>();
    prepared.forEach((series) => {
        series.years.forEach((year) => result.set(year, (result.get(year) ?? 0) + 1));
    });
    return result;
})();
const subtractTargetReference = new Map<number, number>();
target.years.forEach((year, index) => {
    const accumulator = testingAccumulator.get(year);
    if (!accumulator) return;
    const sourceValue = target.segment.data.get(year);
    const contributes = !(typeof sourceValue === "number" && sourceValue <= 0);
    const count = accumulator.count - (contributes ? 1 : 0);
    if (count <= 0) return;
    const sum = contributes
        ? Math.fround(accumulator.sum - Math.fround(target.testingValues[index]))
        : accumulator.sum;
    subtractTargetReference.set(year, Math.fround(sum / Math.fround(count)));
});
const correlation = (
    reference: ReadonlyMap<number, number>,
    includeNonPositiveTarget = false,
    targetValues: readonly number[] = target.testingValues,
    startYear?: number,
    endYear?: number,
) => {
    const left: number[] = [];
    const right: number[] = [];
    target.years.forEach((year, index) => {
        if (startYear !== undefined && year < startYear) return;
        if (endYear !== undefined && year > endYear) return;
        const sourceValue = target.segment.data.get(year);
        const referenceValue = reference.get(year);
        if (!includeNonPositiveTarget
            && typeof sourceValue === "number"
            && sourceValue <= 0) return;
        if (referenceValue === undefined) return;
        left.push(targetValues[index]);
        right.push(referenceValue);
    });
    return {
        years: left.length,
        correlation: cofecha606Pearson(left, right),
    };
};

const averageSavedMasterCorrelation = prepared.reduce((total, series) => {
    const left: number[] = [];
    const right: number[] = [];
    series.years.forEach((year, index) => {
        const referenceValue = master.data.get(year);
        if (referenceValue === undefined) return;
        left.push(series.testingValues[index]);
        right.push(referenceValue);
    });
    return total + cofecha606Pearson(left, right);
}, 0) / prepared.length;
const masterResiduals = prepared.flatMap((series, seriesIndex) => {
    const reference = averageMaps("masterValues", seriesIndex);
    return series.years.flatMap((year, index) => {
        const value = reference.get(year);
        return value === undefined ? [] : [series.masterValues[index] - value];
    });
});
const savedMasterResiduals = prepared.flatMap((series) => series.years.flatMap((year, index) => {
    const value = master.data.get(year);
    return value === undefined ? [] : [series.masterValues[index] - value];
}));
const positiveSavedMasterResiduals = prepared.flatMap((series) => series.years.flatMap((year, index) => {
    const value = master.data.get(year);
    const source = series.segment.data.get(year);
    return value === undefined || typeof source !== "number" || source <= 0
        ? []
        : [series.masterValues[index] - value];
}));
const masterResidualMean = masterResiduals.reduce((sum, value) => sum + value, 0)
    / masterResiduals.length;
const masterResidualSquares = masterResiduals.reduce(
    (sum, value) => sum + value * value,
    0,
);
const masterResidualCenteredSquares = masterResiduals.reduce(
    (sum, value) => sum + (value - masterResidualMean) ** 2,
    0,
);
const clippedResidualScales = (() => {
    let retained = masterResiduals.slice();
    const rounds: Array<{ count: number; rms: number; sampleSd: number }> = [];
    for (let iteration = 0; iteration < 10; iteration += 1) {
        const mean = retained.reduce((sum, value) => sum + value, 0) / retained.length;
        const rms = Math.sqrt(
            retained.reduce((sum, value) => sum + value * value, 0) / retained.length,
        );
        const sampleSd = Math.sqrt(
            retained.reduce((sum, value) => sum + (value - mean) ** 2, 0)
                / (retained.length - 1),
        );
        rounds.push({ count: retained.length, rms, sampleSd });
        const next = retained.filter((value) => value <= 3 * sampleSd && value >= -4.5 * sampleSd);
        if (next.length === retained.length) break;
        retained = next;
    }
    return rounds;
})();
const yearlyMasterStandardDeviations = (() => {
    const valuesByYear = new Map<number, number[]>();
    prepared.forEach((series) => {
        series.years.forEach((year, index) => {
            const source = series.segment.data.get(year);
            if (typeof source === "number" && source <= 0) return;
            const values = valuesByYear.get(year) ?? [];
            values.push(series.masterValues[index]);
            valuesByYear.set(year, values);
        });
    });
    return [...valuesByYear.values()].flatMap((values) => {
        if (values.length < 2) return [];
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        return [Math.sqrt(
            values.reduce((sum, value) => sum + (value - mean) ** 2, 0)
                / (values.length - 1),
        )];
    });
})();

console.log(JSON.stringify({
    sequence,
    seriesId: target.segment.seriesId,
    expected,
    averageSavedMasterCorrelation,
    masterResidualScaleCandidates: {
        count: masterResiduals.length,
        mean: masterResidualMean,
        rms: Math.sqrt(masterResidualSquares / masterResiduals.length),
        populationSd: Math.sqrt(masterResidualCenteredSquares / masterResiduals.length),
        sampleSd: Math.sqrt(masterResidualCenteredSquares / (masterResiduals.length - 1)),
        savedMasterRms: Math.sqrt(
            savedMasterResiduals.reduce((sum, value) => sum + value * value, 0)
                / savedMasterResiduals.length,
        ),
        positiveSavedMasterRms: Math.sqrt(
            positiveSavedMasterResiduals.reduce((sum, value) => sum + value * value, 0)
                / positiveSavedMasterResiduals.length,
        ),
        clippedResidualScales,
        yearlySdMean: yearlyMasterStandardDeviations.reduce((sum, value) => sum + value, 0)
            / yearlyMasterStandardDeviations.length,
        yearlySdMedian: [...yearlyMasterStandardDeviations]
            .sort((left, right) => left - right)[Math.floor(yearlyMasterStandardDeviations.length / 2)],
    },
    inspectedYear: Number.isFinite(inspectYear) ? prepared.flatMap((series, seriesIndex) => {
        const index = series.years.indexOf(inspectYear);
        return index >= 0 ? [{
            seriesIndex,
            seriesId: series.segment.seriesId,
            source: series.segment.data.get(inspectYear),
            testing: series.testingValues[index],
            master: series.masterValues[index],
            baseFiltered: series.baseFilteredValues[index],
            arResidual: series.arResidualValues[index],
            filtered: series.filteredValues[index],
        }] : [];
    }) : null,
    savedMaster: correlation(master.data),
    allMasterCores: correlation(averageMaps("masterValues")),
    leaveOneOutMasterCores: correlation(averageMaps("masterValues", sequence - 1)),
    allTestingCores: correlation(allTestingReference),
    leaveOneOutTestingCores: correlation(leaveOneOutTestingReference),
    leaveOneOutTestingCoresWithTargetAbsent: correlation(
        leaveOneOutTestingReference,
        true,
    ),
    leaveOneOutTestingWithFallback: correlation(leaveOneOutWithFallback, true),
    subtractFromTestingAccumulator: correlation(subtractTargetReference, true),
    leaveOneOutTestingIncludingNonPositive: correlation(
        averageTestingIncludingNonPositive(sequence - 1),
        true,
    ),
    window: Number.isFinite(windowStart) && Number.isFinite(windowEnd) ? {
        referenceValues: Array.from(
            { length: windowEnd - windowStart + 21 },
            (_, index) => windowStart - 10 + index,
        ).map((year) => ({
            year,
            testing: leaveOneOutWithFallback.get(year),
            master: leaveOneOutMasterReference.get(year),
        })),
        targetValues: target.years.flatMap((year, index) => (
            year >= windowStart && year <= windowEnd
                ? [{
                    year,
                    source: target.segment.data.get(year),
                    testing: target.testingValues[index],
                    master: target.masterValues[index],
                    baseFiltered: target.baseFilteredValues[index],
                    arResidual: target.arResidualValues[index],
                    filtered: target.filteredValues[index],
                    leaveOneOutTesting: leaveOneOutWithFallback.get(year),
                    leaveOneOutMaster: leaveOneOutMasterReference.get(year),
                    coverageCount: coverageCountByYear.get(year),
                    positiveContributorCount: testingAccumulator.get(year)?.count ?? 0,
                }]
                : []
        )),
        savedMaster: correlation(
            master.data,
            true,
            target.testingValues,
            windowStart,
            windowEnd,
        ),
        leaveOneOutMaster: correlation(
            leaveOneOutMasterReference,
            true,
            target.testingValues,
            windowStart,
            windowEnd,
        ),
        leaveOneOutTesting: correlation(
            leaveOneOutWithFallback,
            true,
            target.testingValues,
            windowStart,
            windowEnd,
        ),
        masterTargetVsLeaveOneOutMaster: correlation(
            leaveOneOutMasterReference,
            true,
            target.masterValues,
            windowStart,
            windowEnd,
        ),
        masterTargetVsLeaveOneOutTesting: correlation(
            leaveOneOutWithFallback,
            true,
            target.masterValues,
            windowStart,
            windowEnd,
        ),
        testingTargetVsAllTesting: correlation(
            allTestingReference,
            true,
            target.testingValues,
            windowStart,
            windowEnd,
        ),
        masterTargetVsAllMaster: correlation(
            allMasterReference,
            true,
            target.masterValues,
            windowStart,
            windowEnd,
        ),
        masterTargetVsSavedMaster: correlation(
            master.data,
            true,
            target.masterValues,
            windowStart,
            windowEnd,
        ),
        baseTargetVsSavedMaster: correlation(
            master.data,
            true,
            target.baseFilteredValues,
            windowStart,
            windowEnd,
        ),
        baseTargetVsLeaveOneOutMaster: correlation(
            leaveOneOutMasterReference,
            true,
            target.baseFilteredValues,
            windowStart,
            windowEnd,
        ),
        baseTargetVsLeaveOneOutTesting: correlation(
            leaveOneOutWithFallback,
            true,
            target.baseFilteredValues,
            windowStart,
            windowEnd,
        ),
    } : null,
}));
