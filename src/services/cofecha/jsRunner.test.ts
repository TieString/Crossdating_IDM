import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCofechaResult, splitReportByParts } from "@/features/cofecha/formatter";
import { runCofechaReport } from ".";
import { createCofechaJsRequest, runCofechaJsInline } from "./jsRunner";

const fixturePath = resolve(process.cwd(), "test-data", "paki033.rwl");
const fixtureText = readFileSync(fixturePath, "utf8");

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
});
