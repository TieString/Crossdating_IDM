import { describe, expect, it } from "vitest";
import { summarizeClusteredMetric } from "../clusteredStatistics";

const options = {
    replicates: 2000,
    confidenceLevel: 0.95,
    seed: "cluster-test",
};

describe("file-clustered bootstrap", () => {
    it("reports micro and file-equal macro estimates separately", () => {
        const result = summarizeClusteredMetric([
            { clusterId: "large", numerator: 90, denominator: 100 },
            { clusterId: "small", numerator: 0, denominator: 10 },
        ], options);

        expect(result.micro.estimate).toBeCloseTo(90 / 110, 10);
        expect(result.macro.estimate).toBeCloseTo(0.45, 10);
        expect(result.clusters).toBe(2);
    });

    it("resamples whole files and is deterministic", () => {
        const clusters = [
            { clusterId: "a", numerator: 18, denominator: 20 },
            { clusterId: "b", numerator: 19, denominator: 20 },
            { clusterId: "c", numerator: 16, denominator: 20 },
            { clusterId: "d", numerator: 20, denominator: 20 },
        ];
        const first = summarizeClusteredMetric(clusters, options);
        const second = summarizeClusteredMetric([...clusters].reverse(), options);

        expect(first).toEqual(second);
        expect(first.micro.confidenceInterval[0]).toBeLessThanOrEqual(
            first.micro.estimate!,
        );
        expect(first.micro.confidenceInterval[1]).toBeGreaterThanOrEqual(
            first.micro.estimate!,
        );
        expect(first.micro.oneSidedLower).toBeGreaterThanOrEqual(
            first.micro.confidenceInterval[0]!,
        );
    });

    it("does not let zero-denominator files create artificial observations", () => {
        const result = summarizeClusteredMetric([
            { clusterId: "empty", numerator: 0, denominator: 0 },
            { clusterId: "observed", numerator: 9, denominator: 10 },
        ], options);

        expect(result.clusters).toBe(1);
        expect(result.micro.estimate).toBe(0.9);
        expect(result.macro.estimate).toBe(0.9);
        expect(result.micro.confidenceInterval).toEqual([0.9, 0.9]);
    });
});
