import { describe, expect, it } from "vitest";
import {
    classifyItrdbReferenceStructure,
    type ItrdbReferenceStructureEvidence,
} from "../itrdbReferenceStructureClassification";

const evidence = (
    overrides: Partial<ItrdbReferenceStructureEvidence> = {},
): ItrdbReferenceStructureEvidence => ({
    initialZeroLagRate: 0.10,
    initialAbsoluteLagP90: 9,
    pairwiseClusterFraction: 0.20,
    clusterDominanceRatio: 2,
    clusterEdgeDensity: 0.10,
    clusterZeroLagRate: 0.20,
    clusterAbsoluteLagP90: 8,
    ...overrides,
});

describe("ITRDB reference-structure classification", () => {
    it("keeps a globally coherent starting state evaluable", () => {
        expect(classifyItrdbReferenceStructure(evidence({
            initialZeroLagRate: 0.50,
        }))).toEqual({
            metricEligibility: "evaluable",
            qualificationRoute: "global-zero-lag",
        });
    });

    it("keeps a co612-like dominant internal reference core evaluable", () => {
        expect(classifyItrdbReferenceStructure(evidence({
            initialZeroLagRate: 0.246,
            pairwiseClusterFraction: 0.732,
            clusterDominanceRatio: 20.5,
            clusterEdgeDensity: 0.256,
            clusterZeroLagRate: 0.359,
            clusterAbsoluteLagP90: 4,
        }))).toEqual({
            metricEligibility: "evaluable",
            qualificationRoute: "dominant-reference-core",
        });
    });

    it("accepts a smaller but dense and high-consensus reference core", () => {
        expect(classifyItrdbReferenceStructure(evidence({
            pairwiseClusterFraction: 0.36,
            clusterDominanceRatio: 2.6,
            clusterEdgeDensity: 0.79,
            clusterZeroLagRate: 0.71,
            clusterAbsoluteLagP90: 2,
        }))).toEqual({
            metricEligibility: "evaluable",
            qualificationRoute: "compact-high-consensus-core",
        });
    });

    it("excludes an az086-like state with no stable dominant reference", () => {
        expect(classifyItrdbReferenceStructure(evidence({
            initialZeroLagRate: 0.17,
            pairwiseClusterFraction: 0.214,
            clusterDominanceRatio: 2,
            clusterEdgeDensity: 0.533,
            clusterZeroLagRate: 0.733,
            clusterAbsoluteLagP90: 2,
        }))).toEqual({
            metricEligibility: "reference-structure-lost",
            qualificationRoute: "none",
        });
    });

    it("does not accept a large component held together by sparse bridge edges", () => {
        expect(classifyItrdbReferenceStructure(evidence({
            pairwiseClusterFraction: 0.75,
            clusterDominanceRatio: 31,
            clusterEdgeDensity: 0.125,
            clusterZeroLagRate: 0.265,
            clusterAbsoluteLagP90: 5,
        })).metricEligibility).toBe("reference-structure-lost");
    });
});
