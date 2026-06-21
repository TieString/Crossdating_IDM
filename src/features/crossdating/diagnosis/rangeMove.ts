/**
 * 年份范围移动与边界推断工具。
 * 这里负责从异常 lag 推导 selectedRange、missingRange，并细化部分移动的边界。
 */
import { CrossdateConfig } from "./config";
import { runGlobalSlidingMatch } from "./sliding";
import { correlationForSegment, filterSeriesByRange, preprocessSeries } from "./series";
import type {
    EffectiveDiagnosisConfig,
    GlobalSlidingMatch,
    NumericSeries,
    PartialRangeMoveEvidence,
    PropagationPattern,
    SegmentDiagnosis,
    SeriesCoreDiagnosis,
    YearRange,
} from "./types";

export const getLagSupportingSegments = (
    segments: SegmentDiagnosis[],
    lag: number,
): SegmentDiagnosis[] => (
    segments.filter((segment) => segment.flag === "B_like" && segment.bestLag === lag)
);

export const getMeanLag = (segments: SegmentDiagnosis[]): number => {
    if (segments.length === 0) return 0;
    return segments.reduce((sum, segment) => sum + segment.bestLag, 0) / segments.length;
};

export const getRepresentativeSegmentForLag = (
    diagnosis: SeriesCoreDiagnosis,
    lag: number,
): SegmentDiagnosis | null => (
    getLagSupportingSegments(diagnosis.segments, lag)
        .sort((a, b) => b.samplePairs - a.samplePairs)[0]
    ?? getSegmentNearYear(diagnosis.segments, diagnosis.targetRange.endYear)
);

const overlapRange = (a: YearRange, b: YearRange): boolean => (
    a.startYear <= b.endYear && b.startYear <= a.endYear
);

export const nearestExistingYear = (
    years: number[],
    targetYear: number,
    minYear: number,
    maxYear: number,
): number | null => {
    let bestYear: number | null = null;
    let bestDistance = Infinity;

    years.forEach((year) => {
        if (year < minYear || year > maxYear) return;
        const distance = Math.abs(year - targetYear);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestYear = year;
        }
    });

    return bestYear;
};

export const getSegmentNearYear = (
    segments: SegmentDiagnosis[],
    year: number,
): SegmentDiagnosis | null => (
    segments.find((segment) => year >= segment.startYear && year <= segment.endYear)
    ?? segments.slice().sort((a, b) => (
        Math.abs(((a.startYear + a.endYear) / 2) - year)
        - Math.abs(((b.startYear + b.endYear) / 2) - year)
    ))[0]
    ?? null
);

export const missingRangeForMove = (
    selectedRange: YearRange,
    deltaYears: number,
): YearRange | undefined => {
    if (deltaYears < 0) {
        return {
            startYear: selectedRange.endYear + deltaYears + 1,
            endYear: selectedRange.endYear,
        };
    }
    if (deltaYears > 0) {
        return {
            startYear: selectedRange.endYear + 1,
            endYear: selectedRange.endYear + deltaYears,
        };
    }
    return undefined;
};

export const pickSingleYearAnchor = (
    diagnosis: SeriesCoreDiagnosis,
    pattern: PropagationPattern,
    fallbackYear: number,
    config: EffectiveDiagnosisConfig,
): number => {
    const existingYears = Array.from(diagnosis.rawTarget.keys())
        .filter((year) => year >= pattern.olderBoundaryYear && year <= pattern.newerBoundaryYear);
    if (existingYears.length === 0) return fallbackYear;

    const narrowCandidate = existingYears
        .map((year) => ({ year, masterValue: diagnosis.master.data.get(year) }))
        .filter((entry): entry is { year: number; masterValue: number } => entry.masterValue !== undefined)
        .filter((entry) => entry.masterValue <= config.narrowYearThreshold)
        .sort((a, b) => (
            Math.abs(a.year - fallbackYear) - Math.abs(b.year - fallbackYear)
            || a.masterValue - b.masterValue
        ))[0];

    if (narrowCandidate) {
        return narrowCandidate.year;
    }

    return nearestExistingYear(
        existingYears,
        fallbackYear,
        pattern.olderBoundaryYear,
        pattern.newerBoundaryYear,
    ) ?? fallbackYear;
};

export const runSlidingMatchForRange = (
    diagnosis: SeriesCoreDiagnosis,
    range: YearRange,
    config: EffectiveDiagnosisConfig,
): GlobalSlidingMatch => (
    runGlobalSlidingMatch(
        filterSeriesByRange(preprocessSeries(diagnosis.rawTarget), range),
        diagnosis.master.data,
        {
            seriesId: diagnosis.targetTree,
            lagMin: config.globalLagMin,
            lagMax: config.globalLagMax,
            minOverlap: Math.max(config.minLocalOverlap, CrossdateConfig.localEditAlignment.minLocalOverlap),
        },
    )
);

export const makePartialRangeEvidence = (
    diagnosis: SeriesCoreDiagnosis,
    selectedRange: YearRange,
    deltaYears: number,
): Omit<PartialRangeMoveEvidence, "afterUnresolvedA" | "afterUnresolvedB"> => {
    const fixedRange = selectedRange.endYear < diagnosis.targetRange.endYear
        ? { startYear: selectedRange.endYear + 1, endYear: diagnosis.targetRange.endYear }
        : undefined;
    const newerSegments = fixedRange
        ? diagnosis.segments.filter((segment) => overlapRange(fixedRange, segment))
        : [];

    return {
        fixedRange,
        selectedRange,
        deltaYears,
        inferredMissingRange: missingRangeForMove(selectedRange, deltaYears),
        boundaryYear: selectedRange.endYear,
        olderSideLag: deltaYears,
        newerSideMeanLag: getMeanLag(newerSegments),
        beforeUnresolvedA: diagnosis.unresolvedA,
        beforeUnresolvedB: diagnosis.unresolvedB,
    };
};

const moveNumericRangeByOffset = (
    series: NumericSeries,
    selectedRange: YearRange,
    deltaYears: number,
): NumericSeries => {
    const next = new Map<number, number>();
    series.forEach((value, year) => {
        if (year < selectedRange.startYear || year > selectedRange.endYear) {
            next.set(year, value);
        }
    });
    series.forEach((value, year) => {
        if (year >= selectedRange.startYear && year <= selectedRange.endYear) {
            next.set(year + deltaYears, value);
        }
    });
    return new Map(Array.from(next.entries()).sort((a, b) => a[0] - b[0]));
};

export const refinePartialSelectedRange = (
    diagnosis: SeriesCoreDiagnosis,
    initialRange: YearRange,
    deltaYears: number,
    config: EffectiveDiagnosisConfig,
): YearRange => {
    if (deltaYears === 0) return initialRange;

    const years = Array.from(diagnosis.rawTarget.keys()).sort((a, b) => a - b);
    const radius = Math.max(Math.abs(deltaYears) * 2, config.overlap, 8);
    const candidateEndYears = years.filter((year) => (
        year >= initialRange.endYear - radius
        && year <= initialRange.endYear + radius
        && year >= initialRange.startYear
        && year < diagnosis.targetRange.endYear
    ));
    if (candidateEndYears.length === 0) return initialRange;

    const scored = candidateEndYears
        .map((endYear) => {
            const selectedRange = { startYear: initialRange.startYear, endYear };
            const moved = preprocessSeries(moveNumericRangeByOffset(diagnosis.rawTarget, selectedRange, deltaYears));
            const movedRange = {
                startYear: selectedRange.startYear + deltaYears,
                endYear: selectedRange.endYear + deltaYears,
            };
            const older = correlationForSegment(
                moved,
                diagnosis.master.data,
                movedRange.startYear,
                movedRange.endYear,
                0,
                config.minPairsForCorrelation,
            );
            const fixed = correlationForSegment(
                moved,
                diagnosis.master.data,
                endYear + 1,
                diagnosis.targetRange.endYear,
                0,
                config.minPairsForCorrelation,
            );
            const olderScore = older.correlation ?? -1;
            const fixedScore = fixed.correlation ?? 0;
            return {
                endYear,
                score: olderScore + fixedScore * 0.25 - Math.abs(endYear - initialRange.endYear) * 0.001,
            };
        })
        .sort((a, b) => b.score - a.score || Math.abs(a.endYear - initialRange.endYear) - Math.abs(b.endYear - initialRange.endYear));
    const best = scored[0];
    return best ? { ...initialRange, endYear: best.endYear } : initialRange;
};

export const extendPartialBoundaryByPointFit = (
    diagnosis: SeriesCoreDiagnosis,
    selectedRange: YearRange,
    deltaYears: number,
): YearRange => {
    if (deltaYears === 0 || selectedRange.endYear >= diagnosis.targetRange.endYear) return selectedRange;

    const target = preprocessSeries(diagnosis.rawTarget);
    const maxExtension = Math.max(2, Math.abs(deltaYears));
    let endYear = selectedRange.endYear;

    for (let nextYear = selectedRange.endYear + 1; nextYear <= selectedRange.endYear + maxExtension; nextYear += 1) {
        if (nextYear >= diagnosis.targetRange.endYear) break;
        const targetValue = target.get(nextYear);
        const fixedMasterValue = diagnosis.master.data.get(nextYear);
        const shiftedMasterValue = diagnosis.master.data.get(nextYear + deltaYears);
        if (targetValue === undefined || shiftedMasterValue === undefined) break;

        const fixedDistance = fixedMasterValue === undefined
            ? Infinity
            : Math.abs(targetValue - fixedMasterValue);
        const shiftedDistance = Math.abs(targetValue - shiftedMasterValue);
        if (shiftedDistance + 0.05 < fixedDistance) {
            endYear = nextYear;
            continue;
        }
        break;
    }

    return { ...selectedRange, endYear };
};
