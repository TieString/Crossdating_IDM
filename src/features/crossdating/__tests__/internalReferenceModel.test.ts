import { describe, expect, it } from "vitest";
import {
    adjudicateAdaptiveInternalReferenceBlend,
    buildInternalReferenceModel,
    INTERNAL_COMPATIBILITY_FEATURE_NAMES,
    predictInternalTargetIncompatibility,
    scoreInternalTargetIncompatibility,
    setInternalTargetCandidate,
    shouldSuppressInternalStrictSuggestion,
} from "../internalReferenceModel";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";

const signal = (year: number, phase = 0) => (
    900
    + 180 * Math.sin((year + phase) * 0.43)
    + 95 * Math.cos((year + phase) * 0.17)
    + 40 * Math.sin((year + phase) * 1.13)
);

const series = (shift = 0, phase = 0): RwlTreeData => new Map(
    Array.from({ length: 180 }, (_, index) => {
        const year = 1800 + index;
        return [year, Math.round(signal(year + shift, phase))] as const;
    }),
);

const cleanSite = (): RwlSiteData => new Map([
    ["REF001", series(0, 0)],
    ["REF002", series(0, 0.2)],
    ["REF003", series(0, -0.3)],
    ["REF004", series(0, 0.5)],
    ["REF005", series(0, -0.6)],
    ["SHIFT1", series(6, 0.1)],
    ["TARGET", series(0, 0.15)],
]);

describe("internal reference model", () => {
    it("excludes the target and downweights a shifted source", () => {
        const model = buildInternalReferenceModel({
            siteData: cleanSite(),
            targetId: "TARGET",
            runId: "test",
            rwlHash: "hash",
        });

        expect(model).not.toBeNull();
        expect(model?.referenceConfig.selectedTrees).not.toContain("TARGET");
        expect(model?.referenceConfig.selectedTrees).toHaveLength(6);
        const shifted = model?.sourceCompatibility.find((row) => row.seriesId === "SHIFT1");
        const clean = model?.sourceCompatibility.find((row) => row.seriesId === "REF001");
        expect(shifted?.bestLag).not.toBe(0);
        expect(shifted?.referenceWeight ?? 1).toBeLessThan(clean?.referenceWeight ?? 0);
    });

    it("separates a clean target from a nonzero-lag target", () => {
        const clean = buildInternalReferenceModel({
            siteData: cleanSite(),
            targetId: "TARGET",
            runId: "clean",
            rwlHash: "hash",
        });
        const shiftedSite = cleanSite();
        shiftedSite.set("TARGET", series(4, 0.15));
        const shifted = buildInternalReferenceModel({
            siteData: shiftedSite,
            targetId: "TARGET",
            runId: "shifted",
            rwlHash: "hash",
            candidateTarget: true,
        });

        expect(clean?.targetCompatibility.bestLag).toBe(0);
        expect(shifted?.targetCompatibility.bestLag).not.toBe(0);
        expect(shifted?.targetCompatibility.zeroLagDeficit ?? 0).toBeGreaterThan(0.2);
        expect(scoreInternalTargetIncompatibility(shifted!.targetCompatibility))
            .toBeGreaterThan(scoreInternalTargetIncompatibility(clean!.targetCompatibility));
        const candidate = setInternalTargetCandidate(shifted!, "TARGET", true);
        expect(candidate.referenceConfig.classification?.candidateFlaggedIds)
            .toContain("TARGET");
        expect(candidate.referenceConfig.classification?.anchorPassIds)
            .not.toContain("TARGET");
    });

    it("validates and applies the frozen compatibility feature contract", () => {
        const model = buildInternalReferenceModel({
            siteData: cleanSite(),
            targetId: "TARGET",
            runId: "contract",
            rwlHash: "hash",
        })!;
        const linearModel = {
            featureNames: INTERNAL_COMPATIBILITY_FEATURE_NAMES,
            means: INTERNAL_COMPATIBILITY_FEATURE_NAMES.map(() => 0),
            scales: INTERNAL_COMPATIBILITY_FEATURE_NAMES.map(() => 1),
            coefficients: INTERNAL_COMPATIBILITY_FEATURE_NAMES.map(() => 0),
            intercept: 0,
            threshold: 0.5,
        };

        expect(predictInternalTargetIncompatibility(
            model.targetCompatibility,
            linearModel,
        )).toBe(0.5);
        expect(() => predictInternalTargetIncompatibility(
            model.targetCompatibility,
            { ...linearModel, featureNames: ["wrong"] },
        )).toThrow("feature contract mismatch");
        expect(shouldSuppressInternalStrictSuggestion(
            0.1,
            true,
            { ...linearModel, safeStrictSuppressionThreshold: 0.2 },
        )).toBe(true);
        expect(shouldSuppressInternalStrictSuggestion(
            0.1,
            false,
            { ...linearModel, safeStrictSuppressionThreshold: 0.2 },
        )).toBe(false);
    });

    it("applies the adaptive blend only for stronger anomaly or reference evidence", () => {
        const base = buildInternalReferenceModel({
            siteData: cleanSite(),
            targetId: "TARGET",
            runId: "adaptive-contract",
            rwlHash: "hash",
        })!.targetCompatibility;
        const anomalyGain = adjudicateAdaptiveInternalReferenceBlend(base, {
            ...base,
            zeroCorrelation: (base.zeroCorrelation ?? 0) - 0.02,
            perReferenceIncompatibleFraction:
                (base.perReferenceIncompatibleFraction ?? 0) + 0.05,
        });
        expect(anomalyGain.applied).toBe(true);
        expect(anomalyGain.reasons).toContain("anomaly_contrast_gain");

        const conflict = adjudicateAdaptiveInternalReferenceBlend(base, {
            ...base,
            zeroCorrelation: (base.zeroCorrelation ?? 0) - 0.02,
            perReferenceIncompatibleFraction:
                (base.perReferenceIncompatibleFraction ?? 0) + 0.08,
        });
        expect(conflict.applied).toBe(false);

        const consensusGain = adjudicateAdaptiveInternalReferenceBlend(base, {
            ...base,
            perReferenceIncompatibleFraction:
                (base.perReferenceIncompatibleFraction ?? 0.2) - 0.12,
            perReferenceZeroCorrelationMedian:
                (base.perReferenceZeroCorrelationMedian ?? 0) + 0.05,
        });
        expect(consensusGain.applied).toBe(true);
        expect(consensusGain.reasons).toContain("reference_consensus_gain");
    });
});
