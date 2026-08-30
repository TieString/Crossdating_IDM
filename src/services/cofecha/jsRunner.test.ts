import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCofechaResult, splitReportByParts } from "@/features/cofecha/formatter";
import { runCofechaReport } from ".";
import { createCofechaJsRequest, runCofechaJsInline } from "./jsRunner";

const fixturePath = resolve(process.cwd(), "test-data", "paki033.rwl");
const fixtureText = readFileSync(fixturePath, "utf8");
const undatedText = fixtureText
  .split(/\r?\n/)
  .filter((line) => line.startsWith("MUSP011"))
  .join("\n");

describe("cofecha-js report runner", () => {
  it("uses the real file name for deterministic request metadata", () => {
    const request = createCofechaJsRequest(fixtureText, "paki033.rwl");
    expect(request.metadata.jobName).toBe("PAKI033");
    expect(request.input.fileName).toBe("paki033.rwl");
  });

  it("generates the complete OUT contract consumed by Crossdating", async () => {
    const inline = runCofechaJsInline(fixtureText, "paki033.rwl");
    const throughSelectedEngine = await runCofechaReport({
      engine: "javascript",
      rwlText: fixtureText,
      inputFileName: "paki033.rwl",
    });

    expect(throughSelectedEngine).toBe(inline.outText);
    expect(Array.from(splitReportByParts(inline.outText).keys())).toEqual([
      "PART 1",
      "PART 2",
      "PART 3",
      "PART 4",
      "PART 5",
      "PART 6",
      "PART 7",
    ]);
    const parsed = parseCofechaResult(inline.outText);
    expect(parsed.masterDatingSeries.size).toBeGreaterThan(500);
    expect(parsed.seriesIntercorrelation).toBeGreaterThan(0);
    expect(parsed.masterCorrelations.size).toBeGreaterThan(0);
  });

  it("generates Part 8 for an undated series in both official sort modes", () => {
    const datedOnly = runCofechaJsInline(fixtureText, "paki033.rwl");
    const correlation = runCofechaJsInline(fixtureText, "paki033.rwl", {
      rwlText: undatedText,
      inputFileName: "undated.rwl",
      sort: "correlation",
    });
    const adjustment = runCofechaJsInline(fixtureText, "paki033.rwl", {
      rwlText: undatedText,
      inputFileName: "undated.rwl",
      sort: "adjustment",
    });

    expect(splitReportByParts(correlation.outText).has("PART 8")).toBe(true);
    expect(parseCofechaResult(correlation.outText)).toEqual(parseCofechaResult(datedOnly.outText));
    expect(correlation.report.part8).toMatchObject({ sort: "correlation", matchCount: 11 });
    expect(correlation.outText).toContain("Listed in order from highest correlation");
    expect(adjustment.report.part8).toMatchObject({ sort: "adjustment", matchCount: 11 });
    expect(adjustment.outText).toContain("Listed in order of increasing adjustment");
  });
});
