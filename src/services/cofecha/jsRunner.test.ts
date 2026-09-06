import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPart6FlaggedASeriesIds, parseCofechaResult, splitReportByParts } from "@/features/cofecha/formatter";
import { readRwlString } from "@/features/rwl";
import { classifyCofechaPart6Series, createCofechaMasterReferenceConfig, hashRwlSiteData } from "@/features/crossdating/reference";
import { runCofechaReport } from ".";
import { createCofechaJsRequest, runCofechaJsInline } from "./jsRunner";

const fixtureText = readFileSync(resolve(process.cwd(), "test-data", "paki033.rwl"), "utf8");
const undatedText = fixtureText.split(/\r?\n/).filter((line) => line.startsWith("MUSP011")).join("\n");

describe("cofecha-js report runner", () => {
  it("uses the real file name in request metadata", () => {
    const request = createCofechaJsRequest(fixtureText, "paki033.rwl");
    expect(request.metadata.jobName).toBe("PAKI033");
    expect(request.input.fileName).toBe("paki033.rwl");
  });

  it("runs without an EXE and returns complete PART 1-7 OUT", async () => {
    const inline = runCofechaJsInline(fixtureText, "paki033.rwl");
    const selected = await runCofechaReport({ engine: "javascript", rwlText: fixtureText, inputFileName: "paki033.rwl" });
    expect(selected).toBe(inline.outText);
    expect(Array.from(splitReportByParts(selected).keys())).toEqual([
      "PART 1", "PART 2", "PART 3", "PART 4", "PART 5", "PART 6", "PART 7",
    ]);
    const parsed = parseCofechaResult(selected);
    expect(parsed.masterDatingSeries.size).toBeGreaterThan(500);
    expect(parsed.seriesIntercorrelation).toBeGreaterThan(0);
    expect(parsed.masterCorrelations.size).toBeGreaterThan(0);
  });

  it("generates PART 8 under both sort modes without changing PART 1-7 parsed fields", () => {
    const dated = runCofechaJsInline(fixtureText, "paki033.rwl");
    const correlation = runCofechaJsInline(fixtureText, "paki033.rwl", {
      rwlText: undatedText, inputFileName: "undated.rwl", sort: "correlation",
    });
    const adjustment = runCofechaJsInline(fixtureText, "paki033.rwl", {
      rwlText: undatedText, inputFileName: "undated.rwl", sort: "adjustment",
    });
    expect(splitReportByParts(correlation.outText).has("PART 8")).toBe(true);
    expect(parseCofechaResult(correlation.outText)).toEqual(parseCofechaResult(dated.outText));
    expect(correlation.report.part8).toMatchObject({ sort: "correlation", matchCount: 11 });
    expect(adjustment.report.part8).toMatchObject({ sort: "adjustment", matchCount: 11 });
    expect(correlation.outText).toContain("Listed in order from highest correlation");
    expect(adjustment.outText).toContain("Listed in order of increasing adjustment");
  });

  it("builds a fresh dynamic reference and review queue from PART 3 and PART 6", async () => {
    const out = runCofechaJsInline(fixtureText, "paki033.rwl").outText;
    const parts = splitReportByParts(out);
    const parsed = parseCofechaResult(out);
    const site = (await readRwlString(fixtureText, { stopMarker: -9999 })).data;
    const flagged = extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? "");
    const classification = classifyCofechaPart6Series(Array.from(site.keys()), flagged, "js-test-run");
    const reference = createCofechaMasterReferenceConfig({ siteData: site, flaggedAIds: flagged,
      cofechaRunId: "js-test-run", rwlHash: hashRwlSiteData(site), masterDatingSeries: parsed.masterDatingSeries });
    expect(reference.mode).toBe("dynamic");
    expect(reference.isStale).toBe(false);
    expect(reference.cofechaPassReference?.points.length).toBeGreaterThan(500);
    expect(reference.classification?.anchorPassIds).toEqual(classification.anchorPassIds);
    expect(reference.classification?.candidateFlaggedIds).toEqual(classification.candidateFlaggedIds);
    expect(new Set(classification.anchorPassIds).size).toBe(classification.anchorPassIds.length);
  });
});
