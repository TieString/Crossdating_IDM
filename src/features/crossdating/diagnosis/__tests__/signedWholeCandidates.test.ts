import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import fixture from "./signedWholeCandidates.fixture.json";
import { UnifiedV5Predictor, type UnifiedV5Model } from "../unifiedV5Model";
import { V5_FEATURE_COLUMNS } from "../unifiedV5Evidence";

describe("whole +7 with a local event: frozen candidate score regressions", () => {
    const model = new UnifiedV5Predictor(JSON.parse(readFileSync("public/models/unifiedV5Model.json", "utf8")) as UnifiedV5Model);
    it.each(fixture)("keeps the +7 baseline when $local is also present", sample => {
        const values = sample.features.map(row => Float32Array.from(row, v => v ?? NaN));
        const codes = Int16Array.from(sample.codes), starts = Int32Array.from(sample.starts);
        expect(model.predict(values, codes, starts).operation).toBe("false");
        const corrected = model.predict(values, codes, starts, true);
        expect([corrected.operation, corrected.shift, corrected.windowStart]).toEqual(["whole", 7, null]);
        expect(values[1]![V5_FEATURE_COLUMNS.indexOf("shift")]).toBe(7);
    });
});
