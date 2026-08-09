import { describe, expect, it } from "vitest";
import {
    selectLocalConsensusBoundaryShift,
    selectPartialMoveLocalConsensusRecenter,
    selectCorroboratedFalseRingCurrentCandidateIndex,
    selectCounterfactualCoarseCandidateIndex,
    selectFalseRingCoarseCandidateIndex,
} from "../counterfactualEventLocator";
import type { DiagnosisEvent } from "../types";

const localPartialEvent = (notes: string[]): DiagnosisEvent => ({
    id: "partial-local-consensus",
    seriesId: "TARGET",
    eventType: "partialMove",
    startYear: 1795,
    endYear: 1803,
    rankedYears: [{
        year: 1799,
        rank: 1,
        score: 1,
        evidenceTags: [],
    }],
    confidenceLevel: "medium",
    shiftYears: -2,
    shiftSide: "older",
    evidence: {
        algorithmSources: [
            "local_corrected_raw_breakpoint",
            "piecewise_lag_path",
        ],
        score: 1,
        scoreMargin: 0.1,
        baselineCorrelation: 0.3,
        correctedCorrelation: 0.6,
        correlationGain: 0.3,
        lagBefore: -2,
        lagAfter: 0,
        samplePairs: 40,
        candidateIds: ["partial-candidate"],
        notes,
    },
    alternativeTypes: [],
});

const localPartialNotes = [
    "local_raw_boundary_year=1799",
    "local_raw_boundary_support=2",
    "partial_reference_vote_year=1802",
    "partial_reference_vote_shift=-2",
    "partial_reference_vote_gain=0.149899",
    "partial_reference_vote_margin=0.017845",
    "partial_exhaustive_vote_year=1802",
    "partial_exhaustive_vote_shift=-2",
    "partial_exhaustive_vote_gain=0.240447",
    "partial_exhaustive_vote_margin=0.018906",
];

describe("counterfactual coarse-mode selection", () => {
    const candidates = [
        { startYear: 1842, endYear: 1866 },
        { startYear: 1873, endYear: 1897 },
        { startYear: 1855, endYear: 1879 },
        { startYear: 1856, endYear: 1880 },
        { startYear: 1857, endYear: 1881 },
    ];

    it("uses overlap consensus to break numerical ties between distant modes", () => {
        const selected = selectCounterfactualCoarseCandidateIndex(
            candidates,
            [0.6, 0.6000000000000001, 0.6, 0.6, 0.6],
        );

        expect(selected.index).not.toBe(1);
        expect(candidates[selected.index].startYear).toBeLessThanOrEqual(1867);
        expect(candidates[selected.index].endYear).toBeGreaterThanOrEqual(1867);
        expect(selected.overlapConsensus[selected.index])
            .toBeGreaterThan(selected.overlapConsensus[1]);
    });

    it("keeps a materially stronger isolated candidate", () => {
        const selected = selectCounterfactualCoarseCandidateIndex(
            candidates,
            [0.6, 0.62, 0.6, 0.6, 0.6],
        );

        expect(selected.index).toBe(1);
    });

    it("can prefer an agreeing partial-move mode before fine localization", () => {
        const selected = selectCounterfactualCoarseCandidateIndex(
            candidates,
            [0.6, 0.62, 0.6, 0.6, 0.6],
            1 / 3,
        );

        expect(selected.index).not.toBe(1);
        expect(selected.overlapConsensus[selected.index])
            .toBeGreaterThan(selected.overlapConsensus[1]);
    });

    it("gives each false-ring evidence family one normalized coarse vote", () => {
        const familyCandidates = [
            {
                startYear: 1900,
                endYear: 1924,
                source: "reference_transition:rankMedian",
            },
            {
                startYear: 1901,
                endYear: 1925,
                source: "reference_transition:peakKernel5",
            },
            {
                startYear: 1902,
                endYear: 1926,
                source: "reference_transition:peakKernel9",
            },
            {
                startYear: 1914,
                endYear: 1938,
                source: "profile:differenceFull",
            },
            {
                startYear: 1913,
                endYear: 1937,
                source: "lag_transition",
            },
            {
                startYear: 1915,
                endYear: 1939,
                source: "current_event",
            },
        ];

        const index = selectFalseRingCoarseCandidateIndex(
            familyCandidates,
        );

        expect(familyCandidates[index].startYear).toBeGreaterThanOrEqual(1913);
        expect(familyCandidates[index].startYear).toBeLessThanOrEqual(1915);
    });

    it("keeps a corroborated false-ring current mode over a remote transition", () => {
        const familyCandidates = [
            {
                startYear: 1946,
                endYear: 1970,
                source: "lag_transition",
            },
            {
                startYear: 1923,
                endYear: 1947,
                source: "current_event",
            },
        ];

        expect(selectCorroboratedFalseRingCurrentCandidateIndex({
            candidates: familyCandidates,
            selectedIndex: 0,
            currentPrimaryYear: 1935,
            candidateTopYear: 1936,
            candidateTopMargin: 0.2,
        })).toBe(1);
        expect(selectCorroboratedFalseRingCurrentCandidateIndex({
            candidates: familyCandidates,
            selectedIndex: 0,
            currentPrimaryYear: 1935,
            candidateTopYear: 1958,
            candidateTopMargin: 0.2,
        })).toBe(0);
        expect(selectCorroboratedFalseRingCurrentCandidateIndex({
            candidates: familyCandidates,
            selectedIndex: 0,
            currentPrimaryYear: 1935,
            candidateTopYear: 1936,
            candidateTopMargin: 0.05,
        })).toBe(0);
    });

    it("minimally shifts a window toward a compact consensus just outside its edge", () => {
        expect(selectLocalConsensusBoundaryShift({
            window: { startYear: 1948, endYear: 1960 },
            evidenceYears: [1946, 1946, 1947, 1958],
            minimumYear: 1900,
            maximumYear: 2000,
        })).toEqual({
            window: { startYear: 1946, endYear: 1958 },
            centerYear: 1946,
            supportCount: 3,
            shiftYears: -2,
        });
    });

    it("does not shift for a distant, divided, or already-contained consensus", () => {
        const base = {
            window: { startYear: 1948, endYear: 1960 },
            minimumYear: 1900,
            maximumYear: 2000,
        };
        expect(selectLocalConsensusBoundaryShift({
            ...base,
            evidenceYears: [1940, 1940, 1941, 1958],
        })).toBeNull();
        expect(selectLocalConsensusBoundaryShift({
            ...base,
            evidenceYears: [1946, 1955, 1963, 1970],
        })).toBeNull();
        expect(selectLocalConsensusBoundaryShift({
            ...base,
            evidenceYears: [1950, 1951, 1952, 1970],
        })).toBeNull();
        expect(selectLocalConsensusBoundaryShift({
            ...base,
            evidenceYears: [1946, 1946, 1947, 1958],
            anchorYear: 1955,
        })).toBeNull();
    });

    it("keeps a compact operation-consistent partial window over a detached diffuse mode", () => {
        expect(selectPartialMoveLocalConsensusRecenter({
            event: localPartialEvent(localPartialNotes),
            correctionYears: -2,
            proposedWindow: { startYear: 1805, endYear: 1817 },
            calibrationRule: "calibrated_default_13",
        })).toEqual({
            window: { startYear: 1795, endYear: 1803 },
            centerYear: 1800,
            supportCount: 4,
            consensusKind: "local_votes",
            discardedWindow: { startYear: 1805, endYear: 1817 },
        });
    });

    it("keeps reference-core and multiview partial modes when only their tail overlaps", () => {
        const referenceBase = localPartialEvent([
            "reference_vote_year=1803",
            "reference_vote_gain=0.181398",
            "reference_vote_remote_margin=0.010144",
            "reference_partialMove_peak_year=1803",
        ]);
        const referenceEvent: DiagnosisEvent = {
            ...referenceBase,
            startYear: 1799,
            endYear: 1807,
            shiftYears: -3,
            rankedYears: [{
                year: 1803,
                rank: 1,
                score: 1,
                evidenceTags: [],
            }],
            evidence: {
                ...referenceBase.evidence,
                algorithmSources: ["reference_core_voting"],
                correlationGain: 0.181398,
                lagBefore: -3,
            },
        };
        expect(selectPartialMoveLocalConsensusRecenter({
            event: referenceEvent,
            correctionYears: -3,
            proposedWindow: { startYear: 1788, endYear: 1800 },
            calibrationRule: "calibrated_default_13",
        })).toMatchObject({
            window: { startYear: 1799, endYear: 1807 },
            centerYear: 1803,
            consensusKind: "reference_core",
        });

        const multiviewBase = localPartialEvent([
            "partial_consensus_year=1804",
            "partial_consensus_support=3",
            "partial_reference_vote_year=1806",
            "partial_reference_vote_shift=-4",
            "partial_reference_vote_gain=0.146087",
            "partial_reference_vote_margin=0.009807",
            "partial_exhaustive_vote_year=1802",
            "partial_exhaustive_vote_shift=-4",
            "partial_exhaustive_vote_gain=0.223684",
            "partial_exhaustive_vote_margin=0.012685",
        ]);
        const multiviewEvent: DiagnosisEvent = {
            ...multiviewBase,
            startYear: 1800,
            endYear: 1808,
            shiftYears: -4,
            rankedYears: [{
                year: 1804,
                rank: 1,
                score: 1,
                evidenceTags: [],
            }],
            evidence: {
                ...multiviewBase.evidence,
                algorithmSources: [
                    "negative_partial_multiview_consensus",
                    "piecewise_lag_path",
                ],
                lagBefore: -4,
            },
        };
        expect(selectPartialMoveLocalConsensusRecenter({
            event: multiviewEvent,
            correctionYears: -4,
            proposedWindow: { startYear: 1806, endYear: 1818 },
            calibrationRule: "calibrated_default_13",
        })).toMatchObject({
            window: { startYear: 1800, endYear: 1808 },
            centerYear: 1804,
            consensusKind: "multiview_votes",
        });
    });

    it("does not keep the local partial window without independent concentrated support", () => {
        const input = {
            event: localPartialEvent(localPartialNotes),
            correctionYears: -2,
            proposedWindow: { startYear: 1805, endYear: 1817 },
            calibrationRule: "calibrated_default_13",
        };
        expect(selectPartialMoveLocalConsensusRecenter({
            ...input,
            event: localPartialEvent(localPartialNotes.filter((note) => (
                !note.startsWith("partial_exhaustive_vote_")
            ))),
        })).toBeNull();
        expect(selectPartialMoveLocalConsensusRecenter({
            ...input,
            proposedWindow: { startYear: 1799, endYear: 1811 },
        })).toBeNull();
        expect(selectPartialMoveLocalConsensusRecenter({
            ...input,
            calibrationRule: "partial_physical_consensus_7",
        })).toBeNull();
    });

});
