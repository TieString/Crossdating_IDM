import { describe, expect, it } from "vitest";
import {
    selectCounterfactualCoarseCandidateIndex,
    selectFalseRingCoarseCandidateIndex,
} from "../counterfactualEventLocator";

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
});
