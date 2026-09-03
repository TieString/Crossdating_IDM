import { describe, expect, it } from "vitest";
import { canReuseValidation, refreshReusedReference } from "./validationReuse";

describe("save validation reuse", () => {
    const input = { inputText: "A 1900 1 2 -9999", sourcePath: "D:/sample.rwl", executablePath: "D:/COFECHA.exe", version: "cofecha" };
    it("reuses only a successfully recorded exact input", () => {
        expect(canReuseValidation({ ...input }, input)).toBe(true);
        expect(canReuseValidation(null, input)).toBe(false);
        expect(canReuseValidation({ version: "cofecha" }, input)).toBe(false);
    });
    it("requires fresh validation after data, precision, path or executable changes", () => {
        for (const key of Object.keys(input) as Array<keyof typeof input>) {
            expect(canReuseValidation(input, { ...input, [key]: input[key] + "-changed" })).toBe(false);
        }
    });
    it("restores freshness after undo only for the matching validated reference", () => {
        const reference = { rwlHash: "validated", isStale: true, points: [1, 2] };
        expect(refreshReusedReference(reference, "validated")).toEqual({ ...reference, isStale: false });
        expect(reference.isStale).toBe(true);
        expect(refreshReusedReference(reference, "changed")).toBe(reference);
        expect(refreshReusedReference(null, "validated")).toBe(null);
        const fresh = { ...reference, isStale: false };
        expect(refreshReusedReference(fresh, "validated")).toBe(fresh);
    });
});
