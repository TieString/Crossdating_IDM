import type { ReferenceSeriesConfig } from "../reference";
import { cofechaStyleStandardize } from "../reference";
import type { RwlSiteData } from "../../rwl/types";
import { getConfig } from "./config";
import { getJointCounterfactualOperationScores } from "./jointCounterfactualOperation";
import {
    scoreDynamicJointOperation,
    selectDynamicJointOperation,
    selectDynamicUnitOperation,
} from "./jointOperationSelector";
import {
    buildOnlineUnifiedEvidenceBundle,
    type OnlineUnifiedEvidenceBundle,
    type OnlineUnifiedOperationProfilePeak,
} from "./onlineUnifiedEvidence";
import { DEFAULT_MAX_PARTIAL_GAP_YEARS } from "./partialMoveSemantics";
import { preprocessSeries } from "./series";
import { diagnoseSeriesCore } from "./segments";
import type { CrossdatingDiagnosis } from "./types";
import type { SeriesCoreDiagnosis } from "./types";
import type { JointCounterfactualOperationScore } from "./jointCounterfactualOperation";

export const summarizeOnlineUnifiedOperationProfilePeaks = (
    operation: JointCounterfactualOperationScore,
): OnlineUnifiedOperationProfilePeak[] => {
    const definitions = [
        ["rawGain", (row: JointCounterfactualOperationScore["rows"][number]) => row.rawGain],
        ["differenceGain", (row: JointCounterfactualOperationScore["rows"][number]) => row.differenceGain],
        ["combinedGain", (row: JointCounterfactualOperationScore["rows"][number]) => row.combinedGain],
        ["sideStep", (row: JointCounterfactualOperationScore["rows"][number]) => row.sideStepScore],
        ["sideMinimumAdvantage", (row: JointCounterfactualOperationScore["rows"][number]) => row.sideMinimumAdvantage],
        ["correctedSideSupport", (row: JointCounterfactualOperationScore["rows"][number]) => row.correctedSideSupport],
    ] as const;
    return definitions.flatMap(([source, score]) => {
        const ranked = operation.rows.filter((row) => Number.isFinite(score(row)))
            .sort((left, right) => score(right) - score(left) || right.year - left.year);
        const best = ranked[0];
        if (!best) return [];
        const remote = ranked.find((row) => Math.abs(row.year - best.year) > 17);
        return [{
            source,
            year: best.year,
            score: score(best),
            remoteMargin: score(best) - score(remote ?? best),
        }];
    });
};

const effectiveAuditShift = (event: {
    eventType: string;
    shiftYears: number | null;
}): number => {
    if (event.eventType === "missingRing") return -1;
    if (event.eventType === "falseRing") return 1;
    return event.shiftYears ?? 0;
};

/**
 * Builds the compact immutable evidence consumed by the online unified model.
 * This reuses the same linear-time evidence primitives as the diagnosis worker;
 * it never applies a candidate or starts another diagnosis pass.
 */
export const buildOnlineUnifiedEvidenceForTarget = (input: {
    diagnosis: CrossdatingDiagnosis;
    siteData: RwlSiteData;
    targetTree: string;
    referenceConfig: ReferenceSeriesConfig;
    core?: SeriesCoreDiagnosis | null;
    includeExperimentalYearProfiles?: boolean;
}): OnlineUnifiedEvidenceBundle | null => {
    const config = getConfig({ referenceConfig: input.referenceConfig });
    const core = input.core ?? diagnoseSeriesCore(
        input.siteData,
        input.targetTree,
        config,
        preprocessSeries,
    );
    if (!core) return null;

    const beforeFusion = input.diagnosis.eventDecisionAudits?.find(
        (audit) => audit.seriesId === input.targetTree,
    )?.detectedBeforeFusion ?? [];
    const wholeBaselines = [...new Set(beforeFusion.flatMap((event) => (
        event.eventType === "wholeSeriesMove"
            ? [effectiveAuditShift(event)]
            : []
    )))];
    const baselineLag = wholeBaselines.length === 1 ? wholeBaselines[0]! : 0;
    const rawOperations = getJointCounterfactualOperationScores(
        core,
        15,
        DEFAULT_MAX_PARTIAL_GAP_YEARS,
        baselineLag,
    );
    const dynamicSelection = selectDynamicJointOperation(rawOperations);
    const unitSelection = selectDynamicUnitOperation(rawOperations);
    const cofechaCore = diagnoseSeriesCore(
        input.siteData,
        input.targetTree,
        config,
        (series) => new Map(cofechaStyleStandardize(series).map((point) => (
            [point.year, point.value]
        ))),
    );

    return buildOnlineUnifiedEvidenceBundle({
        diagnosis: input.diagnosis,
        seriesId: input.targetTree,
        operations: rawOperations.map((operation) => ({
            eventType: operation.eventType,
            shiftYears: operation.shiftYears,
            bestYear: operation.bestYear,
            dynamicScore: scoreDynamicJointOperation(operation, rawOperations),
            bestRawGain: operation.bestRawGain,
            bestDifferenceGain: operation.bestDifferenceGain,
            bestCombinedGain: operation.bestCombinedGain,
            topThreeDifferenceGain: operation.topThreeDifferenceGain,
            remoteDifferenceMargin: operation.remoteDifferenceMargin,
            baselineLag: operation.baselineLag,
            profilePeaks: input.includeExperimentalYearProfiles === true
                ? summarizeOnlineUnifiedOperationProfilePeaks(operation) : [],
            yearProfile: input.includeExperimentalYearProfiles === true
                ? operation.rows.map((row) => ({
                    year: row.year,
                    rawGain: row.rawGain,
                    differenceGain: row.differenceGain,
                    combinedGain: row.combinedGain,
                    sideStepScore: row.sideStepScore,
                    sideMinimumAdvantage: row.sideMinimumAdvantage,
                    correctedSideSupport: row.correctedSideSupport,
                })) : [],
        })),
        dynamicSelection: dynamicSelection ? {
            eventType: dynamicSelection.operation.eventType,
            shiftYears: dynamicSelection.operation.shiftYears,
            bestYear: dynamicSelection.operation.bestYear,
            score: dynamicSelection.score,
            scoreMargin: dynamicSelection.scoreMargin,
            shiftScoreMargin: dynamicSelection.shiftScoreMargin,
        } : null,
        unitSelection: unitSelection ? {
            eventType: unitSelection.operation.eventType,
            shiftYears: unitSelection.operation.shiftYears,
            bestYear: unitSelection.operation.bestYear,
            score: unitSelection.score,
            scoreMargin: unitSelection.scoreMargin,
            shiftScoreMargin: unitSelection.shiftScoreMargin,
        } : null,
        rawGlobalLag: core.globalSlidingMatch.bestGlobalLag,
        cofechaGlobalLag: cofechaCore?.globalSlidingMatch.bestGlobalLag ?? 0,
    });
};
