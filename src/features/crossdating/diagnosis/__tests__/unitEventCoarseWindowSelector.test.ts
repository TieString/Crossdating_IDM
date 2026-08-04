import { describe, expect, it } from "vitest";
import {
    buildUnitEventCoarseCandidateFeatures,
    selectMissingRingCoarseRecoveryCandidateIndex,
    selectUnitEventCoarseWindow,
    type UnitEventCoarseCandidate,
} from "../unitEventCoarseWindowSelector";

const years = Array.from({ length: 31 }, (_, index) => 1900 + index);
const profiles = [
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
    "differenceFull",
    "comboFull",
    "transitionSplitGain",
    "piecewiseCombinedObjective",
];
const ranks = new Map(profiles.map((profile, profileIndex) => [
    profile,
    years.map((_, index) => (
        ((index * (profileIndex + 2)) % years.length) / (years.length - 1)
    )),
]));
const candidates: UnitEventCoarseCandidate[] = [
    {
        startYear: 1902,
        endYear: 1926,
        source: "current_event",
        aggregateScore: 0.8,
        overlapConsensus: 0.7,
    },
    {
        startYear: 1900,
        endYear: 1924,
        source: "lag_transition",
        score: 2,
        aggregateScore: 0.6,
        overlapConsensus: 0.65,
    },
    {
        startYear: 1906,
        endYear: 1930,
        source: "reference_transition:weightedWindowVote25",
        score: 1.2,
        aggregateScore: 0.9,
        overlapConsensus: 0.68,
    },
];

const input = {
    eventType: "missingRing" as const,
    years,
    ranks,
    candidates,
    currentPrimaryYear: 1915,
    operationEvidence: {
        bestYear: 1917,
        sideStepBestYear: 1913,
    },
};

describe("file-grouped unit-event coarse selector", () => {
    it("builds the frozen 77-column candidate schema", () => {
        const features = buildUnitEventCoarseCandidateFeatures(input);
        expect(features).toHaveLength(candidates.length);
        expect(features.every((row) => row.length === 77)).toBe(true);
        expect(features.flat().every(Number.isFinite)).toBe(true);
        expect(features[0].slice(0, 7)).toEqual([
            Math.fround(0.8),
            Math.fround(0.5),
            Math.fround(0.7),
            Math.fround(1),
            Math.fround(0),
            Math.fround(0),
            Math.fround(0),
        ]);
    });

    it("returns one deterministic candidate without mutating evidence", () => {
        const before = JSON.stringify(candidates);
        const first = selectUnitEventCoarseWindow(input);
        const second = selectUnitEventCoarseWindow(input);
        expect(first).not.toBeNull();
        expect(first).toEqual(second);
        expect(first!.index).toBeGreaterThanOrEqual(0);
        expect(first!.index).toBeLessThan(candidates.length);
        expect(first!.scoredCandidates).toHaveLength(candidates.length);
        expect(first!.scoredCandidates[0].index).toBe(first!.index);
        expect(first!.scoredCandidates.every(({ score }) => (
            Number.isFinite(score)
        ))).toBe(true);
        expect(JSON.stringify(candidates)).toBe(before);
    });

    it("uses the false-ring model without exposing candidate alternatives", () => {
        const selected = selectUnitEventCoarseWindow({
            ...input,
            eventType: "falseRing",
        });
        expect(selected).not.toBeNull();
        expect(selected!.index).toBeGreaterThanOrEqual(0);
        expect(selected!.index).toBeLessThan(candidates.length);
    });

    it("returns null when no internal candidate exists", () => {
        expect(selectUnitEventCoarseWindow({
            ...input,
            candidates: [],
        })).toBeNull();
    });

    it("recovers a separated older-side missing-ring mode", () => {
        const recoveryCandidates: UnitEventCoarseCandidate[] = [
            {
                startYear: 1923,
                endYear: 1947,
                source: "current_event",
                aggregateScore: 0.9,
                overlapConsensus: 0.7,
            },
            {
                startYear: 1882,
                endYear: 1906,
                source: "profile:cumulativeCombined",
                aggregateScore: 0.8,
                overlapConsensus: 0.5,
            },
            {
                startYear: 1894,
                endYear: 1918,
                source: "lag_transition",
                aggregateScore: 0.7,
                overlapConsensus: 0.5,
            },
        ];
        expect(selectMissingRingCoarseRecoveryCandidateIndex({
            eventType: "missingRing",
            years,
            ranks,
            candidates: recoveryCandidates,
            currentPrimaryYear: 1935,
            operationEvidence: {
                bestYear: 1935,
                sideStepBestYear: 1895,
                bestDifferenceGain: 0.13,
            },
        }, 0)).toBe(1);
    });

    it("keeps the learned mode when remote-side evidence is not calibrated", () => {
        expect(selectMissingRingCoarseRecoveryCandidateIndex({
            ...input,
            operationEvidence: {
                ...input.operationEvidence,
                bestDifferenceGain: 0.2,
            },
        }, 0)).toBeNull();
        expect(selectMissingRingCoarseRecoveryCandidateIndex({
            ...input,
            eventType: "falseRing",
            operationEvidence: {
                ...input.operationEvidence,
                bestDifferenceGain: 0.1,
            },
        }, 0)).toBeNull();
    });

});
