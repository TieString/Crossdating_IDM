import { describe, expect, it } from "vitest";
import { hashCofechaText, isCofechaValidationFresh } from "./validationIdentity";

describe("COFECHA validation identity", () => {
  const validation = {
    inputSignature: "rwl-hash",
    engine: "javascript" as const,
    undatedInputSignature: "undated-hash",
    undatedSort: "correlation" as const,
  };

  it("requires both the current RWL snapshot and report engine", () => {
    expect(isCofechaValidationFresh(true, validation, "rwl-hash", "javascript", "undated-hash", "correlation")).toBe(true);
    expect(isCofechaValidationFresh(true, validation, "other-hash", "javascript", "undated-hash", "correlation")).toBe(false);
    expect(isCofechaValidationFresh(true, validation, "rwl-hash", "official", "undated-hash", "correlation")).toBe(false);
    expect(isCofechaValidationFresh(true, validation, "rwl-hash", "javascript", "other-undated", "correlation")).toBe(false);
    expect(isCofechaValidationFresh(true, validation, "rwl-hash", "javascript", "undated-hash", "adjustment")).toBe(false);
  });

  it("rejects missing report content or provenance", () => {
    expect(isCofechaValidationFresh(false, validation, "rwl-hash", "javascript", "undated-hash", "correlation")).toBe(false);
    expect(isCofechaValidationFresh(true, null, "rwl-hash", "javascript")).toBe(false);
  });

  it("hashes undated content deterministically", () => {
    expect(hashCofechaText("abc")).toBe(hashCofechaText("abc"));
    expect(hashCofechaText("abc")).not.toBe(hashCofechaText("abd"));
  });
});
