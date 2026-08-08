/** Newer-side evidence for distinguishing an endpoint unit event from a whole-series lag. */
import type { RwlSiteData } from "@/features/rwl/types";
import {
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import type { DiagnosisEvent, NumericSeries, SeriesCoreDiagnosis } from "./types";

export type EndpointOperationContrast = {
    boundaryYear: number;
    startYear: number;
    endYear: number;
    masterAdvantage: number | null;
    referenceCount: number;
    positiveReferenceFraction: number;
    medianReferenceAdvantage: number | null;
    lowerQuartileReferenceAdvantage: number | null;
    pairedReferenceAdvantage: number | null;
};

export const hasDecisiveNewerSideFixedEvidence = (
    contrast: EndpointOperationContrast,
): boolean => (
    (contrast.masterAdvantage ?? Number.NEGATIVE_INFINITY) >= 0.25
    && contrast.referenceCount >= 8
    && contrast.positiveReferenceFraction >= 0.8
    && (contrast.medianReferenceAdvantage ?? Number.NEGATIVE_INFINITY) >= 0.2
    && (contrast.lowerQuartileReferenceAdvantage ?? Number.NEGATIVE_INFINITY) >= 0.05
    && (
        contrast.pairedReferenceAdvantage === null
        || contrast.pairedReferenceAdvantage >= 0.1
    )
);

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const result = new Map<number, number>();
    series.forEach((value, year) => {
        const previous = series.get(year - 1);
        if (previous !== undefined) result.set(year, value - previous);
    });
    return preprocessSeries(result);
};

type ContrastViews = { raw: NumericSeries; difference: NumericSeries };

const contrastViews = (series: NumericSeries): ContrastViews => ({
    raw: series,
    difference: firstDifferences(series),
});

const mean = (values: readonly number[]): number | null => (
    values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : null
);

const quantile = (values: readonly number[], probability: number): number | null => {
    if (values.length === 0) return null;
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.min(
        ordered.length - 1,
        Math.max(0, Math.floor((ordered.length - 1) * probability)),
    )];
};

const lagZeroAdvantage = (
    target: NumericSeries,
    reference: NumericSeries,
    startYear: number,
    endYear: number,
    wholeLag: number,
    minimumPairs: number,
): number | null => {
    const fixed = correlationForSegment(
        target,
        reference,
        startYear,
        endYear,
        0,
        minimumPairs,
    ).correlation;
    const shifted = correlationForSegment(
        target,
        reference,
        startYear,
        endYear,
        wholeLag,
        minimumPairs,
    ).correlation;
    return fixed === null || shifted === null ? null : fixed - shifted;
};

const combinedAdvantage = (
    target: ContrastViews,
    reference: ContrastViews,
    startYear: number,
    endYear: number,
    wholeLag: number,
): number | null => {
    const width = endYear - startYear + 1;
    const raw = lagZeroAdvantage(
        target.raw,
        reference.raw,
        startYear,
        endYear,
        wholeLag,
        Math.max(5, Math.min(10, width - 1)),
    );
    const difference = lagZeroAdvantage(
        target.difference,
        reference.difference,
        startYear + 1,
        endYear,
        wholeLag,
        Math.max(4, Math.min(8, width - 2)),
    );
    const channels = [
        raw === null ? null : { value: raw, weight: 0.4 },
        difference === null ? null : { value: difference, weight: 0.6 },
    ].filter((row): row is { value: number; weight: number } => row !== null);
    const weight = channels.reduce((sum, row) => sum + row.weight, 0);
    return weight > 0
        ? channels.reduce((sum, row) => sum + row.value * row.weight, 0) / weight
        : null;
};

export const scoreNewerSideEndpointOperationContrast = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    whole: DiagnosisEvent,
    unit: DiagnosisEvent,
): EndpointOperationContrast | null => {
    if (whole.eventType !== "wholeSeriesMove"
        || (unit.eventType !== "missingRing" && unit.eventType !== "falseRing")) {
        return null;
    }
    const wholeLag = whole.shiftYears ?? whole.evidence.lagBefore;
    if (wholeLag !== -1 && wholeLag !== 1) {
        return null;
    }
    const endYear = diagnosis.targetRange.endYear;
    const target = contrastViews(preprocessSeries(diagnosis.rawTarget));
    const master = contrastViews(diagnosis.master.data);
    const sourceIds = diagnosis.master.sourceTrees.length > 0
        ? diagnosis.master.sourceTrees
        : Array.from(siteData.keys()).filter((id) => id !== diagnosis.targetTree);
    const targetStem = diagnosis.targetTree.slice(0, -1).toLowerCase();
    const references = sourceIds.flatMap((id) => {
        const source = siteData.get(id);
        if (!source) return [];
        return [{
            reference: contrastViews(preprocessSeries(toNumericSeries(source))),
            paired: id.slice(0, -1).toLowerCase() === targetStem,
        }];
    });
    const candidates = Array.from(
        { length: unit.endYear - unit.startYear + 1 },
        (_, index) => unit.startYear + index,
    ).flatMap((boundaryYear): EndpointOperationContrast[] => {
        const startYear = boundaryYear + 1;
        if (endYear - startYear + 1 < 6 || endYear - startYear + 1 > 29) return [];
        const masterAdvantage = combinedAdvantage(
            target,
            master,
            startYear,
            endYear,
            wholeLag,
        );
        const rows = references.flatMap(({ reference, paired }) => {
            const advantage = combinedAdvantage(
                target,
                reference,
                startYear,
                endYear,
                wholeLag,
            );
            return advantage === null ? [] : [{ advantage, paired }];
        });
        const advantages = rows.map((row) => row.advantage);
        return [{
            boundaryYear,
            startYear,
            endYear,
            masterAdvantage,
            referenceCount: rows.length,
            positiveReferenceFraction: rows.length > 0
                ? rows.filter((row) => row.advantage > 0).length / rows.length
                : 0,
            medianReferenceAdvantage: quantile(advantages, 0.5),
            lowerQuartileReferenceAdvantage: quantile(advantages, 0.25),
            pairedReferenceAdvantage: mean(
                rows.filter((row) => row.paired).map((row) => row.advantage),
            ),
        }];
    });
    const robustScore = (row: EndpointOperationContrast): number => Math.min(
        row.masterAdvantage ?? Number.NEGATIVE_INFINITY,
        row.medianReferenceAdvantage ?? Number.NEGATIVE_INFINITY,
        row.lowerQuartileReferenceAdvantage ?? Number.NEGATIVE_INFINITY,
        row.pairedReferenceAdvantage ?? Number.POSITIVE_INFINITY,
    );
    return candidates.sort((left, right) => (
        robustScore(right) - robustScore(left)
        || Math.abs(left.boundaryYear - (unit.rankedYears[0]?.year ?? left.boundaryYear))
            - Math.abs(right.boundaryYear - (unit.rankedYears[0]?.year ?? right.boundaryYear))
    ))[0] ?? null;
};
