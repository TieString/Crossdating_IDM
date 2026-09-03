import { describe, expect, it } from "vitest";
import { V5_FEATURE_COLUMNS, buildUnifiedV5Evidence } from "../unifiedV5Evidence";
import { V5_BASE_COLUMNS, V5_IDENTITIES } from "../unifiedV5Operations";
import { V5_GLOBAL_COLUMNS } from "../unifiedV5Global";
import { V5_LAG_COUNT, v5Forward } from "../unifiedV5Path";
import { V5_PROPOSAL_SPEC } from "../unifiedV5Windows";
import { UnifiedV5Predictor, UNIFIED_V5_MODEL_VERSION, UNIFIED_V5_SOURCE_SHA256, type UnifiedV5Model } from "../unifiedV5Model";
import { lowerBound, quantile, roundEven } from "../unifiedV5Math";
import { UnifiedV5Runtime, loadUnifiedV5Runtime } from "../unifiedV5Runtime";
import { attachUniversalPartialMissingWorkflow, promoteValidatedSequentialMissingInterpretation } from "../missingPartialInterpretation";
import { applyAuthoritativeModelDecision } from "../authoritativeModelProjection";
import { createEmptyCrossdatingDiagnosis } from "../../../../pages/home/workspaceState";

const tinyModel = (): UnifiedV5Model => ({
    schemaVersion: 1, version: UNIFIED_V5_MODEL_VERSION, columns: V5_FEATURE_COLUMNS,
    identities: V5_IDENTITIES, proposalSpec: V5_PROPOSAL_SPEC, eventGate: -0.5126752297719945,
    windowWidth: 13, sourceSha256: UNIFIED_V5_SOURCE_SHA256, objective: "lambdarank", averageOutput: false,
    treeInfo: [{ tree_structure: { split_feature: 0, threshold: 0, decision_type: "<=", missing_type: "NaN",
        default_left: true, left_child: { leaf_value: 0 }, right_child: { leaf_value: 1 } } }],
});

describe("accepted v5 evidence and frozen operation/window decision", () => {
    it("loads the exact installed application asset and reuses its verified model", async () => {
        const runtime = await loadUnifiedV5Runtime();
        expect(runtime).toBe(await loadUnifiedV5Runtime());
        expect(runtime.predictor.model.version).toBe("joint-explicit-global-v5");
        expect(runtime.predictor.model.treeInfo).toHaveLength(600);
        expect(runtime.predictor.model.identities).toHaveLength(302);
    });
    it("scans all allowed exact displacements and has one common 207-field schema", () => {
        expect(V5_IDENTITIES).toHaveLength(302);
        expect(V5_IDENTITIES.filter(([op]) => op === "whole").map(([, d]) => d)).toEqual([
            ...Array.from({ length: 100 }, (_, i) => i - 100), ...Array.from({ length: 100 }, (_, i) => i + 1),
        ]);
        expect(V5_IDENTITIES.filter(([op]) => op === "partial").map(([, d]) => d)).toEqual(Array.from({ length: 99 }, (_, i) => i - 100));
        expect(V5_FEATURE_COLUMNS).toHaveLength(207);
        expect(new Set(V5_FEATURE_COLUMNS).size).toBe(207);
        expect(V5_BASE_COLUMNS).toHaveLength(62);
        expect(V5_GLOBAL_COLUMNS).toHaveLength(84);
        expect(V5_FEATURE_COLUMNS.some(name => /truth|category|bark|remaining|masterCorrelation|^mp|^np/.test(name))).toBe(false);
    });

    it("matches exhaustive bounded transitions including unmatched false observations", () => {
        const n = 5, size = V5_LAG_COUNT;
        const values = Float64Array.from({ length: n * size }, (_, i) => Math.sin(i * 1.73));
        const nulls = Float64Array.from([0.1, -0.3, 0.8, 0.7, -0.2]);
        const actual = v5Forward(values, nulls, 6), expected = new Float64Array(values.length);
        expected.set(values.subarray(0, size));
        for (let t = 1; t < n; t++) for (let s = 0; s < size; s++) {
            const previous = (t - 1) * size;
            let best = expected[previous + s]!;
            for (let from = Math.max(0, s - 100); from <= s - 2; from++) best = Math.max(best, expected[previous + from]! - 6);
            if (s > 0) best = Math.max(best, expected[previous + s - 1]! - 3);
            if (s + 1 < size) best = Math.max(best, expected[previous + s + 1]! - 4.5 + (nulls[t - 1]! - values[previous + s + 1]!));
            expected[t * size + s] = values[t * size + s]! + best;
        }
        expect(actual).toEqual(expected);
    });

    it("keeps NumPy boundary and half-even rounding conventions", () => {
        expect([-2.5, -1.5, 0.5, 1.5, 2.5].map(roundEven)).toEqual([-2, -2, 0, 2, 2]);
        expect(lowerBound([1, 4, 7], 4)).toBe(1);
        expect(lowerBound([1, 4, 7], 4, true)).toBe(2);
        expect(quantile([NaN, 2, 5, 8, 11], 0.25)).toBe(4.25);
        expect(Number.isNaN(quantile([NaN]))).toBe(true);
    });

    it("binds local candidates to G=0, not their partial amount, and never invents an outside-endpoint window", () => {
        const target = new Map(Array.from({ length: 50 }, (_, i) => [1900 + i, Math.sin(i * 1.7)]));
        const master = new Map(Array.from({ length: 320 }, (_, i) => [1700 + i, Math.sin((i - 200) * 1.7)]));
        const evidence = buildUnifiedV5Evidence({ target, master, references: [master] }, [...target]);
        for (let i = 0; i < evidence.codes.length; i++) {
            const [op, shift] = V5_IDENTITIES[evidence.codes[i]!]!;
            expect(evidence.features[i]!.slice(123)).toEqual(evidence.global.features[op === "whole" ? shift + 100 : 100]);
            if (op !== "none" && op !== "whole") {
                expect(evidence.starts[i]).toBeGreaterThanOrEqual(1900);
                expect(evidence.starts[i]! + 12).toBeLessThanOrEqual(1949);
            }
        }
    });

    it("commits a single exact identity then chooses its window; partial alone gets one missing review", () => {
        const predictor = new UnifiedV5Predictor(tinyModel());
        const partial = V5_IDENTITIES.findIndex(([op, shift]) => op === "partial" && shift === -12);
        const missing = V5_IDENTITIES.findIndex(([op]) => op === "missing");
        const a = new Float32Array(207), b = new Float32Array(207); b[0] = 1;
        const result = predictor.predict([a, b, a], Int16Array.from([0, partial, missing]), Int32Array.from([0, 1920, 1940]));
        expect([result.operation, result.shift, result.windowStart, result.windowEnd, result.missingReviewStart]).toEqual(["partial", -12, 1920, 1932, 1940]);
        expect(result.windows[missing]).not.toBe(result.windows[partial]);
        const whole = V5_IDENTITIES.findIndex(([op, shift]) => op === "whole" && shift === 8);
        const entire = predictor.predict([a, b], Int16Array.from([0, whole]), Int32Array.from([0, 0]));
        expect([entire.operation, entire.shift, entire.windowStart, entire.missingReviewStart]).toEqual(["whole", 8, null, null]);
    });

    it("preserves missing-value tree routing and rejects changed field schemas", () => {
        const predictor = new UnifiedV5Predictor(tinyModel()), features = new Float32Array(207).fill(NaN);
        expect(predictor.score(features)).toBe(0);
        features[0] = 2; expect(predictor.score(features)).toBe(1);
        expect(() => new UnifiedV5Predictor({ ...tinyModel(), columns: [...V5_FEATURE_COLUMNS].reverse() })).toThrow("contract mismatch");
        expect(() => predictor.score([1, 2])).toThrow("feature count");
    });

    it("adapts only the chosen operation, caches identical RWL states and scopes review IDs to each new state", async () => {
        const model = tinyModel();
        const node = model.treeInfo[0]!.tree_structure;
        if ("leaf_value" in node) throw new Error("Expected test split");
        node.split_feature = V5_FEATURE_COLUMNS.indexOf("is_partial"); node.threshold = 0.5;
        const runtime = new UnifiedV5Runtime(new UnifiedV5Predictor(model));
        const site = new Map(["target", "ref1", "ref2"].map((id, k) => [id, new Map<number, number | null>([
            ...Array.from({ length: 70 }, (_, i): [number, number] => [1900 + i, Math.round(200 + 20 * Math.sin(i * 1.7) + k * Math.cos(i * 0.4))]),
            [1970, -9999],
        ])]));
        const first = await runtime.infer(site, "target"), before = { ...runtime.preprocessing.stats };
        const second = await runtime.infer(site, "target");
        expect(second).toBe(first);
        expect(runtime.stats).toEqual({ stateHits: 1, stateMisses: 1 });
        expect(runtime.preprocessing.stats).toEqual(before);
        const event = first.selectedPackage!.event;
        expect(event.eventType).toBe("partialMove");
        expect(event.endYear - event.startYear + 1).toBe(13);
        const ambiguity = event.interpretationAmbiguity;
        if (ambiguity?.kind !== "missingRingsOrPartialMove") throw new Error("Expected directed review");
        expect(ambiguity.evidence.interpretationBasis).toBe("frozenConditionalMissingReview");
        expect(ambiguity.alternative.eventType).toBe("missingRing");
        expect(ambiguity.alternative.interpretationAmbiguity).toBeUndefined();
        expect(ambiguity.alternative.alternativeTypes).toEqual([]);
        expect(attachUniversalPartialMissingWorkflow(event, null, site)).toBe(event);
        expect(promoteValidatedSequentialMissingInterpretation(event, false)).toBe(event);
        expect(applyAuthoritativeModelDecision(createEmptyCrossdatingDiagnosis(), first.decision, "target", event).events).toEqual([event]);
        site.get("target")!.set(1901, 0);
        const next = await runtime.infer(site, "target");
        expect(next.stateHash).not.toBe(first.stateHash);
        expect(next.selectedPackage!.event.id).not.toBe(event.id);
        expect(next.selectedPackage!.event.eventType).toBe("partialMove");
        expect(runtime.stats).toEqual({ stateHits: 1, stateMisses: 2 });
        for (const family of ["whole", "missing", "false", "none"]) {
            const otherModel = tinyModel(), split = otherModel.treeInfo[0]!.tree_structure;
            if ("leaf_value" in split) throw new Error("Expected test split");
            split.split_feature = V5_FEATURE_COLUMNS.indexOf(`is_${family}`); split.threshold = 0.5;
            const other = await new UnifiedV5Runtime(new UnifiedV5Predictor(otherModel)).infer(site, "target");
            expect(other.prediction?.operation).toBe(family);
            expect(other.selectedPackage?.event.interpretationAmbiguity).toBeUndefined();
            if (family !== "none") expect(other.selectedPackage?.event.alternativeTypes).toEqual([]);
        }
    });
});
