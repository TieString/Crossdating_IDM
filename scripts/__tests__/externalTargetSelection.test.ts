import { describe, expect, it } from "vitest";
import { selectLengthBalancedTargets } from "../itrdb-operation-capability/externalTargetSelection";
import type { CapabilityFile, CapabilityTarget } from "../itrdb-operation-capability/types";

const target = (id: string, years: number): CapabilityTarget => ({
    targetId: id,
    startYear: 1000,
    endYear: 1000 + years - 1,
    seriesYears: years,
    zeroCount: 0,
    masterCorrelation: 0.7,
    problemSegments: 0,
});

const file = (
    id: string,
    counts: [number, number, number],
): CapabilityFile => {
    const lengths = [150, 250, 350];
    const targets = counts.flatMap((count, band) => (
        Array.from({ length: count }, (_, index) => target(
            `${id}-${band}-${index}`,
            lengths[band],
        ))
    ));
    return {
        fileId: id,
        relativePath: `${id}.rwl`,
        sourceSha256: id,
        cleanCofechaSha256: id,
        seriesIntercorrelation: 0.7,
        possibleProblemSegments: 0,
        totalSeries: targets.length,
        eligibleTargetsBeforeLimit: targets.length,
        eligibleTargets: targets,
    };
};

describe("external target length balancing", () => {
    it("selects exactly ten per file and reaches the global marginal balance", () => {
        const files = Array.from({ length: 50 }, (_, index) => file(
            `f${index}`,
            index % 3 === 0 ? [12, 6, 6] : index % 3 === 1 ? [6, 12, 6] : [6, 6, 12],
        ));
        const result = selectLengthBalancedTargets(files, 10, "seed");
        expect([...result.selectedByFile.values()].every((items) => items.length === 10)).toBe(true);
        expect(result.counts).toEqual(result.idealCounts);
        expect(Object.values(result.counts).reduce((sum, value) => sum + value, 0)).toBe(500);
    });

    it("uses the nearest feasible marginal mix without dropping a file", () => {
        const files = [
            file("short-only", [12, 0, 0]),
            file("mixed", [4, 4, 12]),
        ];
        const result = selectLengthBalancedTargets(files, 10, "seed");
        expect(result.selectedByFile.get("short-only")).toHaveLength(10);
        expect(result.selectedByFile.get("mixed")).toHaveLength(10);
        expect(result.counts["100-199"]).toBeGreaterThan(result.idealCounts["100-199"]);
    });
});
