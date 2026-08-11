export type ItrdbReferenceStructureEvidence = {
    initialZeroLagRate: number;
    initialAbsoluteLagP90: number;
    pairwiseClusterFraction: number;
    clusterDominanceRatio: number;
    clusterEdgeDensity: number;
    clusterZeroLagRate: number;
    clusterAbsoluteLagP90: number;
};

export type ItrdbReferenceStructureClassification = {
    metricEligibility: "evaluable" | "reference-structure-lost";
    qualificationRoute:
        | "global-zero-lag"
        | "dominant-reference-core"
        | "compact-high-consensus-core"
        | "none";
};

export const ITRDB_REFERENCE_STRUCTURE_THRESHOLDS = Object.freeze({
    globalZeroLagRate: 0.35,
    dominantCoreFraction: 0.35,
    dominantCoreRatio: 3,
    dominantCoreEdgeDensity: 0.20,
    dominantCoreZeroLagRate: 0.25,
    compactCoreFraction: 0.30,
    compactCoreEdgeDensity: 0.60,
    compactCoreZeroLagRate: 0.65,
    compactCoreAbsoluteLagP90: 2,
});

/**
 * Classifies the all-zero-deleted starting state without consulting recovery outcomes.
 * This keeps difficult algorithm failures in the primary metric whenever a usable
 * global alignment or a unique internal reference core still exists.
 */
export const classifyItrdbReferenceStructure = (
    evidence: ItrdbReferenceStructureEvidence,
): ItrdbReferenceStructureClassification => {
    const thresholds = ITRDB_REFERENCE_STRUCTURE_THRESHOLDS;
    if (evidence.initialZeroLagRate >= thresholds.globalZeroLagRate) {
        return {
            metricEligibility: "evaluable",
            qualificationRoute: "global-zero-lag",
        };
    }
    if (evidence.pairwiseClusterFraction >= thresholds.dominantCoreFraction
        && evidence.clusterDominanceRatio >= thresholds.dominantCoreRatio
        && evidence.clusterEdgeDensity >= thresholds.dominantCoreEdgeDensity
        && evidence.clusterZeroLagRate >= thresholds.dominantCoreZeroLagRate) {
        return {
            metricEligibility: "evaluable",
            qualificationRoute: "dominant-reference-core",
        };
    }
    if (evidence.pairwiseClusterFraction >= thresholds.compactCoreFraction
        && evidence.clusterEdgeDensity >= thresholds.compactCoreEdgeDensity
        && evidence.clusterZeroLagRate >= thresholds.compactCoreZeroLagRate
        && evidence.clusterAbsoluteLagP90 <= thresholds.compactCoreAbsoluteLagP90) {
        return {
            metricEligibility: "evaluable",
            qualificationRoute: "compact-high-consensus-core",
        };
    }
    return {
        metricEligibility: "reference-structure-lost",
        qualificationRoute: "none",
    };
};
