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
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import {
    createWholeSeriesMoveCase,
    parseRwl,
} from "./rdmFixture";

const RWL_PATH = process.env.CO612_RWL_PATH ?? "D:/软件测试/co612.rwl";
const OUT_PATH = process.env.CO612_OUT_PATH ?? "D:/软件测试/co612.OUT";
const TARGET_ID = "mon232";
const COFECHA_EXE = process.env.COFECHA_EXE?.trim() ?? "";

const fixtureDescribe = existsSync(RWL_PATH) && existsSync(OUT_PATH)
    ? describe
    : describe.skip;
const bundledCofechaIt = process.platform === "win32" && existsSync(COFECHA_EXE)
    ? it
    : it.skip;

const runBundledCofecha = (siteData: RwlSiteData): string => {
    const workDir = mkdtempSync(join(tmpdir(), "co612-mon232-whole-"));
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

fixtureDescribe("co612 mon232 whole-series move regression", () => {
    const parsed = parseRwl(readFileSync(RWL_PATH, "utf8"));
    const target = parsed.get(TARGET_ID)!;
    const cleanSite: RwlSiteData = new Map(
        Array.from(parsed, ([seriesId, series]) => [
            seriesId,
            new Map(series.valuesByYear),
        ]),
    );
    const outText = readFileSync(OUT_PATH, "utf8");
    const parts = splitReportByParts(outText);
    const referenceConfig = createCofechaMasterReferenceConfig({
        siteData: cleanSite,
        flaggedAIds: extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? ""),
        cofechaRunId: "co612-mon232-whole-regression",
        rwlHash: "co612-mon232-whole-regression",
        masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
    });

    it("keeps the missing-ring review path after deleting 1994 and 1990", () => {
        const after1994 = deleteYearWithMode(
            new Map(target.valuesByYear),
            1994,
            "direct",
            "right",
        );
        const after1990 = deleteYearWithMode(
            after1994,
            1990,
            "direct",
            "right",
        );
        const afterFirstSite = new Map(cleanSite);
        afterFirstSite.set(TARGET_ID, after1994);
        const afterFirstDiagnosis = diagnoseCrossdating(afterFirstSite, {
            referenceConfig,
            targetTrees: [TARGET_ID],
            reviewWindowDisplayMode: "review",
            includeEventDecisionAudits: true,
        });
        const site = new Map(cleanSite);
        site.set(TARGET_ID, after1990);

        const diagnosis = diagnoseCrossdating(site, {
            referenceConfig,
            targetTrees: [TARGET_ID],
            reviewWindowDisplayMode: "review",
            includeEventDecisionAudits: true,
        });
        const firstDisplayed = getDisplayedDiagnosisEvents(afterFirstDiagnosis)
            .filter((event) => event.seriesId === TARGET_ID);
        const displayed = getDisplayedDiagnosisEvents(diagnosis)
            .filter((event) => event.seriesId === TARGET_ID);
        const event = displayed[0];
        const globalSliding = diagnosis.globalSlidingMatches.find((match) => (
            match.seriesId === TARGET_ID
        ));
        const details = JSON.stringify({
            afterFirstDelete: firstDisplayed.map((item) => ({
                type: item.eventType,
                shiftYears: item.shiftYears,
                ambiguity: item.interpretationAmbiguity?.kind,
                alternative: item.interpretationAmbiguity?.alternative.eventType,
            })),
            globalSliding: globalSliding ? {
                bestGlobalLag: globalSliding.bestGlobalLag,
                bestGlobalR: globalSliding.bestGlobalR,
                currentR: globalSliding.currentR,
                overlapYears: globalSliding.overlapYears,
            } : null,
            candidates: diagnosis.candidates
                .filter((candidate) => candidate.targetTree === TARGET_ID)
                .map((candidate) => ({
                    mode: candidate.mode,
                    targetYear: candidate.targetYear,
                    shiftYears: candidate.deltaYears,
                    score: candidate.score,
                    strength: candidate.candidateStrength,
                    sources: candidate.algorithmSource,
                })),
            displayed: displayed.map((item) => ({
                type: item.eventType,
                shiftYears: item.shiftYears,
                range: [item.startYear, item.endYear],
                ambiguity: item.interpretationAmbiguity?.kind,
                alternative: item.interpretationAmbiguity ? {
                    type: item.interpretationAmbiguity.alternative.eventType,
                    range: [
                        item.interpretationAmbiguity.alternative.startYear,
                        item.interpretationAmbiguity.alternative.endYear,
                    ],
                    topYear: item.interpretationAmbiguity.alternative.rankedYears[0]?.year,
                } : null,
            })),
        }, null, 2);

        expect(firstDisplayed[0], details).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: -1,
            interpretationAmbiguity: {
                kind: "wholeSeriesMoveOrMissingRing",
            },
        });
        expect(displayed, details).toHaveLength(1);
        expect(event, details).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: -2,
            interpretationAmbiguity: {
                kind: "wholeSeriesMoveOrMissingRing",
                evidence: {
                    wholeShiftYears: -2,
                },
                alternative: {
                    eventType: "missingRing",
                },
            },
        });
    }, 120_000);

    it("keeps the missing-ring review path at the three-year boundary", () => {
        const corrupted = [1994, 1990, 1986].reduce<RwlTreeData>(
            (values, year) => deleteYearWithMode(values, year, "direct", "right"),
            new Map(target.valuesByYear),
        );
        const site = new Map(cleanSite);
        site.set(TARGET_ID, corrupted);
        const diagnosis = diagnoseCrossdating(site, {
            referenceConfig,
            targetTrees: [TARGET_ID],
            reviewWindowDisplayMode: "review",
            includeEventDecisionAudits: true,
        });
        const displayed = getDisplayedDiagnosisEvents(diagnosis)
            .filter((event) => event.seriesId === TARGET_ID);
        const details = JSON.stringify(displayed.map((item) => ({
            type: item.eventType,
            shiftYears: item.shiftYears,
            ambiguity: item.interpretationAmbiguity?.kind,
            alternative: item.interpretationAmbiguity?.alternative.eventType,
        })));

        expect(displayed, details).toHaveLength(1);
        expect(displayed[0], details).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: -3,
            interpretationAmbiguity: {
                kind: "wholeSeriesMoveOrMissingRing",
                evidence: { wholeShiftYears: -3 },
                alternative: { eventType: "missingRing" },
            },
        });
    }, 120_000);

    it.each([-10, -11, -20, -50])(
        "keeps a %i-year whole move classified as wholeSeriesMove",
        (injectedShiftYears) => {
            const moved = createWholeSeriesMoveCase(target, injectedShiftYears);
            const site = new Map(cleanSite);
            site.set(TARGET_ID, moved.corrupted);

            const diagnosis = diagnoseCrossdating(site, {
                referenceConfig,
                targetTrees: [TARGET_ID],
                reviewWindowDisplayMode: "review",
                includeEventDecisionAudits: true,
            });
            const events = diagnosis.events
                .filter((event) => event.seriesId === TARGET_ID);
            const details = JSON.stringify({
                injectedShiftYears,
                globalSliding: (() => {
                    const match = diagnosis.globalSlidingMatches.find((item) => (
                        item.seriesId === TARGET_ID
                    ));
                    return match ? {
                        bestGlobalLag: match.bestGlobalLag,
                        bestGlobalR: match.bestGlobalR,
                        currentR: match.currentR,
                        overlapYears: match.overlapYears,
                    } : null;
                })(),
                candidates: diagnosis.candidates
                    .filter((candidate) => candidate.targetTree === TARGET_ID)
                    .map((candidate) => ({
                        mode: candidate.mode,
                        shiftYears: candidate.deltaYears,
                        score: candidate.score,
                        sources: candidate.algorithmSource,
                    })),
                events: diagnosis.events
                    .filter((event) => event.seriesId === TARGET_ID)
                    .map((event) => ({
                        type: event.eventType,
                        shiftYears: event.shiftYears,
                        range: [event.startYear, event.endYear],
                        notes: event.evidence.notes,
                    })),
                audit: (() => {
                    const audit = diagnosis.eventDecisionAudits?.[0];
                    const summarize = (events: NonNullable<typeof audit>["finalEvents"]) => events.map((event) => ({
                        type: event.eventType,
                        shiftYears: event.shiftYears,
                        range: [event.startYear, event.endYear],
                        topYear: event.topYear,
                        sources: event.algorithmSources,
                    }));
                    return audit ? {
                        candidateProjected: summarize(audit.candidateProjectedEvents),
                        detectedBeforeFusion: summarize(audit.detectedBeforeFusion),
                        detectedAfterFusion: summarize(audit.detectedAfterFusion),
                        retainedAfterEndpointGuard: summarize(audit.retainedAfterEndpointGuard),
                        displayedBeforeLocator: summarize(audit.displayedBeforeLocator),
                        finalEvents: summarize(audit.finalEvents),
                        finalReason: audit.finalReason,
                    } : null;
                })(),
            }, null, 2);

            expect(events, details).toHaveLength(1);
            expect(events[0].eventType, details).toBe("wholeSeriesMove");
            expect(events[0].shiftYears, details).toBe(-injectedShiftYears);
        },
        120_000,
    );

    bundledCofechaIt.each([-11, -50])(
        "keeps a %i-year whole move visible after save and fresh COFECHA",
        (injectedShiftYears) => {
            const moved = createWholeSeriesMoveCase(target, injectedShiftYears);
            const site = new Map(cleanSite);
            site.set(TARGET_ID, moved.corrupted);
            const freshOut = runBundledCofecha(site);
            const freshParts = splitReportByParts(freshOut);
            const freshReference = createCofechaMasterReferenceConfig({
                siteData: site,
                flaggedAIds: extractPart6FlaggedASeriesIds(
                    freshParts.get("PART 6") ?? "",
                ),
                cofechaRunId: `co612-mon232-whole-${injectedShiftYears}`,
                rwlHash: `co612-mon232-whole-${injectedShiftYears}`,
                masterDatingSeries: parseCofechaResult(freshOut).masterDatingSeries,
            });
            const diagnosis = diagnoseCrossdating(site, {
                referenceConfig: freshReference,
                targetTrees: [TARGET_ID],
                cofechaText: freshOut,
                reviewWindowDisplayMode: "review",
                includeEventDecisionAudits: true,
            });
            const displayed = getDisplayedDiagnosisEvents(diagnosis)
                .filter((event) => event.seriesId === TARGET_ID);
            const globalSliding = diagnosis.globalSlidingMatches.find((match) => (
                match.seriesId === TARGET_ID
            ));
            const audit = diagnosis.eventDecisionAudits?.find((row) => (
                row.seriesId === TARGET_ID
            ));
            const summarizeAuditEvents = (
                rows: NonNullable<typeof audit>["finalEvents"],
            ) => rows.map((event) => ({
                type: event.eventType,
                shiftYears: event.shiftYears,
                range: [event.startYear, event.endYear],
                topYear: event.topYear,
            }));
            const details = JSON.stringify({
                globalSliding: globalSliding ? {
                    bestGlobalLag: globalSliding.bestGlobalLag,
                    bestGlobalR: globalSliding.bestGlobalR,
                    currentR: globalSliding.currentR,
                    overlapYears: globalSliding.overlapYears,
                } : null,
                candidates: diagnosis.candidates
                    .filter((candidate) => candidate.targetTree === TARGET_ID)
                    .map((candidate) => ({
                        mode: candidate.mode,
                        shiftYears: candidate.deltaYears,
                        score: candidate.score,
                        strength: candidate.candidateStrength,
                        sources: candidate.algorithmSource,
                    })),
                strict: diagnosis.events.map((event) => ({
                    type: event.eventType,
                    shiftYears: event.shiftYears,
                    range: [event.startYear, event.endYear],
                })),
                displayed: displayed.map((event) => ({
                    type: event.eventType,
                    shiftYears: event.shiftYears,
                    range: [event.startYear, event.endYear],
                })),
                flaggedIds: freshReference.classification?.candidateFlaggedIds,
                audit: audit ? {
                    candidateProjected: summarizeAuditEvents(audit.candidateProjectedEvents),
                    displayedBeforeLocator: summarizeAuditEvents(audit.displayedBeforeLocator),
                    finalEvents: summarizeAuditEvents(audit.finalEvents),
                    finalReason: audit.finalReason,
                } : null,
            }, null, 2);

            expect(displayed, details).toHaveLength(1);
            expect(displayed[0].eventType, details).toBe("wholeSeriesMove");
            expect(displayed[0].shiftYears, details).toBe(-injectedShiftYears);
        },
        120_000,
    );
});
