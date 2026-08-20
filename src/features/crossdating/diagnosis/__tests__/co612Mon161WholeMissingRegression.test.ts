import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
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
} from "@/features/crossdating/diagnosis";
import { createCofechaMasterReferenceConfig } from "@/features/crossdating/reference";
import { deleteYearWithMode } from "@/features/rwl/edit";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    createWholeSeriesMoveCase,
    parseRwl,
} from "./rdmFixture";

const RWL_PATH = process.env.CO612_SOURCE_RWL_PATH
    ?? "D:/软件测试/数据/ITRDB/itrdb_download/measurements/northamerica/usa/co612.rwl";
const TARGET_ID = "mon161";
const COFECHA_EXE = fileURLToPath(new URL(
    "../../../../../src-tauri/bin/cofecha-x86_64-pc-windows-msvc.exe",
    import.meta.url,
));

const fixtureDescribe = existsSync(RWL_PATH) && existsSync(COFECHA_EXE)
    ? describe
    : describe.skip;

const runBundledCofecha = (siteData: RwlSiteData): string => {
    const workDir = mkdtempSync(join(tmpdir(), "co612-mon161-whole-missing-"));
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

fixtureDescribe("co612 mon161 whole baseline plus missing-ring regression", () => {
    it("keeps the uncontaminated -2 whole-series baseline as a whole move", () => {
        const parsed = parseRwl(readFileSync(RWL_PATH, "utf8"));
        const target = parsed.get(TARGET_ID)!;
        const site: RwlSiteData = new Map(
            Array.from(parsed, ([seriesId, series]) => [
                seriesId,
                new Map(series.valuesByYear),
            ]),
        );
        site.set(TARGET_ID, createWholeSeriesMoveCase(target, 2).corrupted);

        const outText = runBundledCofecha(site);
        const parts = splitReportByParts(outText);
        const referenceConfig = createCofechaMasterReferenceConfig({
            siteData: site,
            flaggedAIds: extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? ""),
            cofechaRunId: "co612-mon161-whole-only-regression",
            rwlHash: "co612-mon161-whole-only-regression",
            masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
        });
        const displayed = getDisplayedDiagnosisEvents(diagnoseCrossdating(site, {
            referenceConfig,
            targetTrees: [TARGET_ID],
            cofechaText: outText,
            reviewWindowDisplayMode: "review",
            includeEventDecisionAudits: true,
        })).filter((event) => event.seriesId === TARGET_ID);

        expect(displayed).toHaveLength(1);
        expect(displayed[0]).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: -2,
        });
    }, 120_000);

    it("does not promote the older -4 lag state to the whole-series baseline", () => {
        const parsed = parseRwl(readFileSync(RWL_PATH, "utf8"));
        const target = parsed.get(TARGET_ID)!;
        const site: RwlSiteData = new Map(
            Array.from(parsed, ([seriesId, series]) => [
                seriesId,
                new Map(series.valuesByYear),
            ]),
        );
        const wholeMoved = createWholeSeriesMoveCase(target, 2).corrupted;
        const after1977 = deleteYearWithMode(wholeMoved, 1977, "direct", "right");
        const after1925 = deleteYearWithMode(after1977, 1925, "direct", "right");
        site.set(TARGET_ID, after1925);

        const outText = runBundledCofecha(site);
        const parts = splitReportByParts(outText);
        const referenceConfig = createCofechaMasterReferenceConfig({
            siteData: site,
            flaggedAIds: extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? ""),
            cofechaRunId: "co612-mon161-whole-missing-regression",
            rwlHash: "co612-mon161-whole-missing-regression",
            masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
        });
        const diagnosis = diagnoseCrossdating(site, {
            referenceConfig,
            targetTrees: [TARGET_ID],
            cofechaText: outText,
            reviewWindowDisplayMode: "review",
            includeEventDecisionAudits: true,
        });
        const displayed = getDisplayedDiagnosisEvents(diagnosis)
            .filter((event) => event.seriesId === TARGET_ID);
        const audit = diagnosis.eventDecisionAudits?.find((row) => row.seriesId === TARGET_ID);
        const summarize = (events: NonNullable<typeof audit>["finalEvents"]) => events.map((event) => ({
            type: event.eventType,
            shiftYears: event.shiftYears,
            range: [event.startYear, event.endYear],
            topYear: event.topYear,
            sources: event.algorithmSources,
            notes: event.notes.filter((note) => (
                note.includes("whole_")
                || note.includes("baseline")
                || note.includes("cumulative")
                || note.includes("path_")
            )),
        }));
        const details = JSON.stringify({
            displayed: displayed.map((event) => ({
                type: event.eventType,
                shiftYears: event.shiftYears,
                range: [event.startYear, event.endYear],
                topYear: event.rankedYears[0]?.year,
                sources: event.evidence.algorithmSources,
                notes: event.evidence.notes,
            })),
            candidates: diagnosis.candidates
                .filter((candidate) => candidate.targetTree === TARGET_ID)
                .map((candidate) => ({
                    mode: candidate.mode,
                    year: candidate.targetYear,
                    shiftYears: candidate.deltaYears,
                    score: candidate.score,
                    sources: candidate.algorithmSource,
                })),
            globalSliding: (() => {
                const match = diagnosis.globalSlidingMatches.find((row) => (
                    row.seriesId === TARGET_ID
                ));
                return match ? {
                    bestGlobalLag: match.bestGlobalLag,
                    bestGlobalR: match.bestGlobalR,
                    currentR: match.currentR,
                    overlapYears: match.overlapYears,
                } : null;
            })(),
            audit: audit ? {
                candidateProjected: summarize(audit.candidateProjectedEvents),
                detectedBeforeFusion: summarize(audit.detectedBeforeFusion),
                detectedAfterFusion: summarize(audit.detectedAfterFusion),
                retainedAfterEndpointGuard: summarize(audit.retainedAfterEndpointGuard),
                displayedBeforeLocator: summarize(audit.displayedBeforeLocator),
                finalEvents: summarize(audit.finalEvents),
                finalReason: audit.finalReason,
            } : null,
        }, null, 2);

        expect(displayed, details).toHaveLength(1);
        expect(displayed[0]?.eventType, details).toBe("missingRing");
        expect(displayed[0]?.startYear, details).toBeLessThanOrEqual(1977);
        expect(displayed[0]?.endYear, details).toBeGreaterThanOrEqual(1977);
        expect(displayed[0]?.evidence.algorithmSources, details).toContain(
            "whole_frame_compatible_local_frontier",
        );
    }, 120_000);
});
