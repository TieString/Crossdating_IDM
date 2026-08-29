import { describe, expect, it } from "vitest";
import { isCofechaValidationFresh } from "./validationIdentity";

describe("COFECHA validation identity", () => {
  const validation = { inputSignature: "rwl-hash", engine: "javascript" as const };

  it("requires both the current RWL snapshot and report engine", () => {
    expect(isCofechaValidationFresh(true, validation, "rwl-hash", "javascript")).toBe(true);
    expect(isCofechaValidationFresh(true, validation, "other-hash", "javascript")).toBe(false);
    expect(isCofechaValidationFresh(true, validation, "rwl-hash", "official")).toBe(false);
  });

  it("rejects missing report content or provenance", () => {
    expect(isCofechaValidationFresh(false, validation, "rwl-hash", "javascript")).toBe(false);
    expect(isCofechaValidationFresh(true, null, "rwl-hash", "javascript")).toBe(false);
  });
});
