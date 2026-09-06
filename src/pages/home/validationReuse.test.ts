import { describe, expect, it } from "vitest";
import { canReuseValidation, hashValidationText, refreshReusedReference, shouldScheduleAutomaticValidation } from "./validationReuse";

describe("save validation reuse", () => {
    const input = { inputText: "A 1900 1 2 -9999", sourcePath: "D:/sample.rwl", engine: "javascript" as const,
        executablePath: null, cofechaJsVersion: "0.2.0", undatedInputText: null,
        undatedSourcePath: null, undatedSort: null };
    it("reuses only a successfully recorded exact input", () => {
        expect(canReuseValidation({ ...input }, input)).toBe(true);
        expect(canReuseValidation(null, input)).toBe(false);
        expect(canReuseValidation({ engine: "javascript" }, input)).toBe(false);
    });
    it("includes engine, EXE, cofecha-js version and PART 8 inputs in the identity", () => {
        const official = { ...input, engine: "official" as const, executablePath: "D:/COFECHA.exe" };
        expect(canReuseValidation(input, { ...input, engine: "official", executablePath: "D:/COFECHA.exe" })).toBe(false);
        expect(canReuseValidation(official, { ...official, executablePath: "D:/OTHER.exe" })).toBe(false);
        expect(canReuseValidation(input, { ...input, cofechaJsVersion: "0.2.1" })).toBe(false);
        expect(canReuseValidation(input, { ...input, undatedInputText: "U", undatedSourcePath: "D:/u.rwl", undatedSort: "correlation" })).toBe(false);
        expect(hashValidationText("abc")).toBe(hashValidationText("abc"));
        expect(hashValidationText("abc")).not.toBe(hashValidationText("abd"));
    });
    it("automatically refreshes edited working data without requiring save", () => {
        const base = { filePath: "D:/sample.rwl", siteSize: 10, isLoading: false,
            executablePath: "", validationCurrent: false };
        expect(shouldScheduleAutomaticValidation({ ...base, engine: "javascript" })).toBe(true);
        expect(shouldScheduleAutomaticValidation({ ...base, engine: "official" })).toBe(false);
        expect(shouldScheduleAutomaticValidation({ ...base, engine: "official", executablePath: "D:/COFECHA.exe" })).toBe(true);
        expect(shouldScheduleAutomaticValidation({ ...base, engine: "javascript", validationCurrent: true })).toBe(false);
        expect(shouldScheduleAutomaticValidation({ ...base, engine: "javascript", isLoading: true })).toBe(false);
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
