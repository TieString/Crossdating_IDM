import type { RwlSeries } from "@/features/rwl/types";

export type MatchedObservation = {
    rawYear: number;
    crossdatedYear: number;
    value: number;
    offsetYears: number;
};

export type OffsetRun = {
    offsetYears: number;
    observationCount: number;
    rawStartYear: number;
    rawEndYear: number;
    crossdatedStartYear: number;
    crossdatedEndYear: number;
};

export type OperationTransition = {
    olderOffsetYears: number;
    newerOffsetYears: number;
    shiftYears: number;
    firstFixedYear: number;
    operationType: "missingRing" | "falseRing" | "partialMove" | "offsetTransition";
};

export type ExpectedZslOperation = {
    eventType: "missingRing" | "falseRing" | "partialMove" | "wholeSeriesMove";
    shiftYears: number;
    firstFixedYear: number | null;
    eventYear: number | null;
};

export type ZslSeriesTruth = {
    matched: MatchedObservation[];
    unmatchedRaw: Array<{ rawYear: number; value: number }>;
    crossdatedZeroYears: number[];
    reconstructionMatchesRaw: boolean;
    offsetRuns: OffsetRun[];
    newerBaselineOffsetYears: number | null;
    wholeSeriesMove: { shiftYears: number } | null;
    transitions: OperationTransition[];
    expectedFrontier: ExpectedZslOperation | null;
};

export const observedEntries = (
    series: RwlSeries,
    includeZeros: boolean,
): Array<[number, number]> => Array.from(series.valuesByYear.entries())
    .filter(([, value]) => value !== -9999 && (includeZeros || value !== 0))
    .sort((left, right) => left[0] - right[0]);

export const alignZslObservations = (
    raw: RwlSeries,
    crossdated: RwlSeries,
): Pick<ZslSeriesTruth,
    "matched" | "unmatchedRaw" | "crossdatedZeroYears" | "reconstructionMatchesRaw"
> => {
    const rawEntries = observedEntries(raw, true);
    const crossdatedEntries = observedEntries(crossdated, false);
    const rowCount = rawEntries.length;
    const columnCount = crossdatedEntries.length;
    const dp = Array.from(
        { length: rowCount + 1 },
        () => new Uint16Array(columnCount + 1),
    );
    for (let row = 1; row <= rowCount; row += 1) {
        for (let column = 1; column <= columnCount; column += 1) {
            dp[row][column] = rawEntries[row - 1][1] === crossdatedEntries[column - 1][1]
                ? dp[row - 1][column - 1] + 1
                : Math.max(dp[row - 1][column], dp[row][column - 1]);
        }
    }

    const matchedRaw = new Array(rowCount).fill(false);
    const matched: MatchedObservation[] = [];
    let row = rowCount;
    let column = columnCount;
    while (row > 0 && column > 0) {
        const [rawYear, rawValue] = rawEntries[row - 1];
        const [crossdatedYear, crossdatedValue] = crossdatedEntries[column - 1];
        if (rawValue === crossdatedValue
            && dp[row][column] === dp[row - 1][column - 1] + 1) {
            matchedRaw[row - 1] = true;
            matched.push({
                rawYear,
                crossdatedYear,
                value: rawValue,
                offsetYears: crossdatedYear - rawYear,
            });
            row -= 1;
            column -= 1;
        } else if (dp[row - 1][column] >= dp[row][column - 1]) {
            row -= 1;
        } else {
            column -= 1;
        }
    }
    matched.reverse();

    return {
        matched,
        unmatchedRaw: rawEntries
            .filter((_, index) => !matchedRaw[index])
            .map(([rawYear, value]) => ({ rawYear, value })),
        crossdatedZeroYears: observedEntries(crossdated, true)
            .filter(([, value]) => value === 0)
            .map(([year]) => year),
        reconstructionMatchesRaw: dp[rowCount][columnCount] === columnCount,
    };
};

export const buildOffsetRuns = (
    matched: readonly MatchedObservation[],
): OffsetRun[] => {
    const runs: OffsetRun[] = [];
    matched.forEach((observation) => {
        const current = runs[runs.length - 1];
        if (current?.offsetYears === observation.offsetYears) {
            current.observationCount += 1;
            current.rawEndYear = observation.rawYear;
            current.crossdatedEndYear = observation.crossdatedYear;
            return;
        }
        runs.push({
            offsetYears: observation.offsetYears,
            observationCount: 1,
            rawStartYear: observation.rawYear,
            rawEndYear: observation.rawYear,
            crossdatedStartYear: observation.crossdatedYear,
            crossdatedEndYear: observation.crossdatedYear,
        });
    });
    return runs;
};

export const buildOperationTransitions = (
    runs: readonly OffsetRun[],
): OperationTransition[] => runs.slice(0, -1).map((older, index) => {
    const newer = runs[index + 1];
    const shiftYears = older.offsetYears - newer.offsetYears;
    return {
        olderOffsetYears: older.offsetYears,
        newerOffsetYears: newer.offsetYears,
        shiftYears,
        firstFixedYear: newer.crossdatedStartYear,
        operationType: shiftYears === -1
            ? "missingRing"
            : shiftYears === 1
                ? "falseRing"
                : shiftYears < -1
                    ? "partialMove"
                    : "offsetTransition",
    };
});

export const expectedZslFrontier = (input: {
    wholeSeriesMove: { shiftYears: number } | null;
    transitions: OperationTransition[];
}): ExpectedZslOperation | null => {
    if (input.wholeSeriesMove) {
        return {
            eventType: "wholeSeriesMove",
            shiftYears: input.wholeSeriesMove.shiftYears,
            firstFixedYear: null,
            eventYear: null,
        };
    }
    const transition = input.transitions.at(-1);
    if (!transition || transition.operationType === "offsetTransition") return null;
    return {
        eventType: transition.operationType,
        shiftYears: transition.shiftYears,
        firstFixedYear: transition.firstFixedYear,
        eventYear: transition.operationType === "partialMove"
            ? transition.firstFixedYear
            : transition.firstFixedYear - 1,
    };
};

export const deriveZslSeriesTruth = (
    raw: RwlSeries,
    crossdated: RwlSeries,
): ZslSeriesTruth => {
    const alignment = alignZslObservations(raw, crossdated);
    const runs = buildOffsetRuns(alignment.matched);
    const newerBaselineOffsetYears = runs.at(-1)?.offsetYears ?? null;
    const wholeSeriesMove = newerBaselineOffsetYears !== null
        && newerBaselineOffsetYears !== 0
        ? { shiftYears: newerBaselineOffsetYears }
        : null;
    const transitions = buildOperationTransitions(runs);
    return {
        ...alignment,
        offsetRuns: runs,
        newerBaselineOffsetYears,
        wholeSeriesMove,
        transitions,
        expectedFrontier: expectedZslFrontier({ wholeSeriesMove, transitions }),
    };
};
