import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    extractPart6FlaggedASeriesIds,
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import {
    diagnoseCrossdating,
    getDisplayedDiagnosisEvents,
    type CrossdatingDiagnosis,
    type DiagnosisEvent,
} from "@/features/crossdating/diagnosis";
import { createCofechaMasterReferenceConfig } from "@/features/crossdating/reference";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData } from "@/features/rwl/types";
import { buildMultiMissingCorrupted, parseRwl } from "./rdmFixture";

const FIXTURE_PATH = process.env.AUSL038_RWL_PATH
    ?? "D:/软件测试/数据/ITRDB/itrdb_download/measurements/ausl038.rwl";
const TARGET_ID = "MCP17A";
const FIRST_FIXED_YEAR = 1788;
const SHIFT_YEARS = -9;
const EXPECTED_ZERO_YEARS = [1779, 1780, 1781, 1782, 1783, 1784, 1785, 1786, 1787];
const COFECHA_EXE = fileURLToPath(new URL(
    "../../../../../src-tauri/bin/cofecha-x86_64-pc-windows-msvc.exe",
    import.meta.url,
));

const fixtureDescribe = existsSync(FIXTURE_PATH) && existsSync(COFECHA_EXE)
    ? describe
    : describe.skip;

const runBundledCofecha = (siteData: RwlSiteData): string => {
    const workDir = mkdtempSync(join(tmpdir(), "ausl038-mcp17a-"));
    try {
        writeFileSync(join(workDir, "INPUT.RWL"), formatTucson(siteData, false), "utf8");
        execFileSync(COFECHA_EXE, [], {
            cwd: workDir,
            input: "very\nINPUT.RWL\n\n\n\n\n\n\n",
            timeout: 60_000,
            stdio: ["pipe", "ignore", "pipe"],
        });
        return readFileSync(join(workDir, "VERYCOF.OUT"), "utf8");
    } finally {
        rmSync(workDir, { force: true, recursive: true });
    }
};

const summarizeEvents = (events: readonly DiagnosisEvent[]) => events.map((event) => ({
    type: event.eventType,
    range: [event.startYear, event.endYear],
    topYear: event.rankedYears[0]?.year,
    shiftYears: event.shiftYears,
    score: event.evidence.score,
    lagBefore: event.evidence.lagBefore,
    lagAfter: event.evidence.lagAfter,
    sources: event.evidence.algorithmSources,
    notes: event.evidence.notes,
}));

const expectPhysicalGap = (diagnosis: CrossdatingDiagnosis) => {
    const events = getDisplayedDiagnosisEvents(diagnosis)
        .filter((event) => event.seriesId === TARGET_ID);
    const event = events.find((candidate) => (
        candidate.eventType === "partialMove"
        && candidate.shiftYears === SHIFT_YEARS
    ));

    expect(events, JSON.stringify({
        strict: summarizeEvents(diagnosis.events),
        review: summarizeEvents(diagnosis.reviewEvents ?? []),
        candidates: diagnosis.candidates.map((candidate) => ({
            operationType: candidate.operationType,
            targetYear: candidate.targetYear,
            suggestedLag: candidate.suggestedLag,
            deltaYears: candidate.deltaYears,
            score: candidate.score,
            source: candidate.algorithmSource,
        })),
    })).toHaveLength(1);
    expect(event).toBeDefined();
    expect(event!.startYear).toBeLessThanOrEqual(FIRST_FIXED_YEAR);
    expect(event!.endYear).toBeGreaterThanOrEqual(FIRST_FIXED_YEAR);
    expect([5, 7, 9, 13]).toContain(event!.endYear - event!.startYear + 1);
    expect(diagnosis.events.some((candidate) => (
        candidate.eventType === "wholeSeriesMove"
    ))).toBe(false);
};

fixtureDescribe("ausl038 MCP17A contiguous physical gap regression", () => {
    const parsed = parseRwl(readFileSync(FIXTURE_PATH, "utf8"));
    const target = parsed.get(TARGET_ID)!;
    const cleanSite: RwlSiteData = new Map(
        Array.from(parsed, ([seriesId, series]) => [seriesId, new Map(series.valuesByYear)]),
    );
    const zeroYears = Array.from(target.valuesByYear)
        .filter(([, value]) => value === 0)
        .map(([year]) => year)
        .sort((left, right) => left - right);
    const corruptedSite = new Map(cleanSite);
    corruptedSite.set(
        TARGET_ID,
        buildMultiMissingCorrupted(target.valuesByYear, zeroYears),
    );

    it("recognizes the deleted contiguous zeros before saving", () => {
        expect(zeroYears).toEqual(EXPECTED_ZERO_YEARS);
        const cleanOut = runBundledCofecha(cleanSite);
        const cleanParts = splitReportByParts(cleanOut);
        const cleanReference = createCofechaMasterReferenceConfig({
            siteData: cleanSite,
            flaggedAIds: extractPart6FlaggedASeriesIds(cleanParts.get("PART 6") ?? ""),
            cofechaRunId: "ausl038-clean",
            rwlHash: "ausl038-clean",
            masterDatingSeries: parseCofechaResult(cleanOut).masterDatingSeries,
        });
        const diagnosis = diagnoseCrossdating(corruptedSite, {
            referenceConfig: cleanReference,
            targetTrees: [TARGET_ID],
            reviewWindowDisplayMode: "review",
        });

        expectPhysicalGap(diagnosis);
    }, 180_000);

    it("keeps the partial move after saving and rebuilding COFECHA", () => {
        const corruptedOut = runBundledCofecha(corruptedSite);
        const corruptedParts = splitReportByParts(corruptedOut);
        const corruptedReference = createCofechaMasterReferenceConfig({
            siteData: corruptedSite,
            flaggedAIds: extractPart6FlaggedASeriesIds(corruptedParts.get("PART 6") ?? ""),
            cofechaRunId: "ausl038-corrupted",
            rwlHash: "ausl038-corrupted",
            masterDatingSeries: parseCofechaResult(corruptedOut).masterDatingSeries,
        });
        const diagnosis = diagnoseCrossdating(corruptedSite, {
            referenceConfig: corruptedReference,
            targetTrees: [TARGET_ID],
            cofechaText: corruptedOut,
            reviewWindowDisplayMode: "review",
        });

        expectPhysicalGap(diagnosis);
    }, 180_000);
});
