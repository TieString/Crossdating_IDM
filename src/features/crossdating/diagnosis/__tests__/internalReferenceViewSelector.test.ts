import { describe, expect, it } from "vitest";
import frozenModel from "../internalReferenceViewSelectorModel.json";
import {
    canSelectInternalReferenceViewPackage,
    INTERNAL_REFERENCE_VIEW_FEATURE_NAMES,
    INTERNAL_REFERENCE_VIEW_SELECTOR_THRESHOLDS,
    internalReferenceViewFeatureVector,
    predictInternalReferenceViewPackage,
} from "../internalReferenceViewSelector";

describe("internal reference-view selector", () => {
    it("reproduces the frozen standardized logistic intercept", () => {
        const features = Object.fromEntries(
            INTERNAL_REFERENCE_VIEW_FEATURE_NAMES.map((name, index) => [
                name,
                frozenModel.means[index],
            ]),
        );
        const expected = 1 / (1 + Math.exp(-frozenModel.intercept));

        expect(INTERNAL_REFERENCE_VIEW_FEATURE_NAMES).toHaveLength(171);
        expect(internalReferenceViewFeatureVector(features)).toHaveLength(171);
        expect(predictInternalReferenceViewPackage(features)).toBeCloseTo(expected, 12);
    });

    it("rejects incomplete or malformed feature vectors", () => {
        expect(() => internalReferenceViewFeatureVector({})).toThrow(
            "missing internal reference-view feature",
        );
        expect(() => predictInternalReferenceViewPackage([1, 2])).toThrow(
            "feature vector contract mismatch",
        );
    });

    it("enforces support, probability, and partial-to-false-ring guards", () => {
        expect(INTERNAL_REFERENCE_VIEW_SELECTOR_THRESHOLDS).toMatchObject({
            minimumProbability: 0.8,
            minimumMargin: 0.2,
            minimumSupport: 2,
            minimumSafeConsensusProbability: 0.03,
        });
        expect(canSelectInternalReferenceViewPackage({
            probability: 0.95,
            baselineProbability: 0.5,
            support: 1,
            baselineSupport: 1,
            baselineEventType: "missingRing",
            candidateEventType: "partialMove",
            safeConsensus: false,
        })).toBe(false);
        expect(canSelectInternalReferenceViewPackage({
            probability: 0.99,
            baselineProbability: 0.5,
            support: 2,
            baselineSupport: 7,
            baselineEventType: "partialMove",
            candidateEventType: "falseRing",
            safeConsensus: false,
        })).toBe(false);
        expect(canSelectInternalReferenceViewPackage({
            probability: 0.85,
            baselineProbability: 0.6,
            support: 2,
            baselineSupport: 1,
            baselineEventType: "falseRing",
            candidateEventType: "partialMove",
            safeConsensus: false,
        })).toBe(true);
        expect(canSelectInternalReferenceViewPackage({
            probability: 0.02,
            baselineProbability: 0.5,
            support: 5,
            baselineSupport: 1,
            baselineEventType: "partialMove",
            candidateEventType: "partialMove",
            safeConsensus: true,
        })).toBe(false);
    });
});
