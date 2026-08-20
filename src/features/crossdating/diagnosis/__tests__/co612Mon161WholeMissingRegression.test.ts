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
import { getConfig } from "@/features/crossdating/diagnosis/config";
import { evaluateDraft } from "@/features/crossdating/diagnosis/evaluation";
import {
    makeRecentTailWholeDraft,
    measureRecentTailLagConsensus,
} from "@/features/crossdating/diagnosis/pathFixedSideWholeBaseline";
import { diagnoseSeriesCore } from "@/features/crossdating/diagnosis/segments";
import { createCofechaMasterReferenceConfig } from "@/features/crossdating/reference";
import {
    deleteYearWithMode,
    insertMissingYearAtSide,
    moveSeriesTailByOffset,
} from "@/features/rwl/edit";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    buildMultiMissingCorrupted,
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
    it.each([1977, 1967])(
        "keeps the -2 bark-side whole baseline ahead of one missing ring at displayed year %i",
        (deletedDisplayedYear) => {
            const parsed = parseRwl(readFileSync(RWL_PATH, "utf8"));
            const target = parsed.get(TARGET_ID)!;
            const site: RwlSiteData = new Map(
                Array.from(parsed, ([seriesId, series]) => [
                    seriesId,
                    new Map(series.valuesByYear),
                ]),
            );
            const wholeMoved = createWholeSeriesMoveCase(target, 2).corrupted;
            site.set(
                TARGET_ID,
                deleteYearWithMode(
                    wholeMoved,
                    deletedDisplayedYear,
                    "direct",
                    "right",
                ),
            );

            const outText = runBundledCofecha(site);
            const parts = splitReportByParts(outText);
            const referenceConfig = createCofechaMasterReferenceConfig({
                siteData: site,
                flaggedAIds: extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? ""),
                cofechaRunId: `co612-mon161-whole-one-missing-${deletedDisplayedYear}`,
                rwlHash: `co612-mon161-whole-one-missing-${deletedDisplayedYear}`,
                masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
            });
            const diagnosis = diagnoseCrossdating(site, {
                referenceConfig,
                targetTrees: [TARGET_ID],
                cofechaText: outText,
                reviewWindowDisplayMode: "review",
                includeEventDecisionAudits: true,
            });
            const core = diagnoseSeriesCore(
                site,
                TARGET_ID,
                getConfig({ referenceConfig }),
            );
            const tail = core
                ? measureRecentTailLagConsensus(core, getConfig({ referenceConfig }))
                : null;
            const tailDraft = core
                ? makeRecentTailWholeDraft(core, getConfig({ referenceConfig }))
                : null;
            const tailCandidate = core && tailDraft
                ? evaluateDraft(
                    site,
                    core,
                    tailDraft,
                    getConfig({ referenceConfig }),
                    null,
                )
                : null;
            const displayed = getDisplayedDiagnosisEvents(diagnosis)
                .filter((event) => event.seriesId === TARGET_ID);
            const audit = diagnosis.eventDecisionAudits?.find(
                (row) => row.seriesId === TARGET_ID,
            );
            const summarizeStage = (
                events: NonNullable<typeof audit>["finalEvents"],
            ) => events.map(
                (event) => ({
                    type: event.eventType,
                    shiftYears: event.shiftYears,
                    range: [event.startYear, event.endYear],
                    topYear: event.topYear,
                    lagBefore: event.lagBefore,
                    lagAfter: event.lagAfter,
                    sources: event.algorithmSources,
                    notes: event.notes.filter((note) => (
                        note.startsWith("whole_state_")
                        || note.startsWith("whole_baseline_")
                        || note.startsWith("bounded_path_transition=")
                    )),
                }),
            );
            const details = JSON.stringify({
                displayed: displayed.map((event) => ({
                    type: event.eventType,
                    shiftYears: event.shiftYears,
                    range: [event.startYear, event.endYear],
                    topYear: event.rankedYears[0]?.year,
                    sources: event.evidence.algorithmSources,
                    notes: event.evidence.notes.filter((note) => (
                        note.startsWith("whole_state_")
                        || note.startsWith("whole_baseline_")
                    )),
                    alternative: event.interpretationAmbiguity ? {
                        type: event.interpretationAmbiguity.alternative.eventType,
                        shiftYears: event.interpretationAmbiguity.alternative.shiftYears,
                        range: [
                            event.interpretationAmbiguity.alternative.startYear,
                            event.interpretationAmbiguity.alternative.endYear,
                        ],
                    } : null,
                })),
                stages: audit ? {
                    candidate: summarizeStage(audit.candidateProjectedEvents),
                    detected: summarizeStage(audit.detectedBeforeFusion),
                    fused: summarizeStage(audit.detectedAfterFusion),
                    final: summarizeStage(audit.finalEvents),
                } : null,
                tail,
                tailCandidate: tailCandidate ? {
                    shiftYears: tailCandidate.deltaYears,
                    strength: tailCandidate.candidateStrength,
                    score: tailCandidate.score,
                    gain: tailCandidate.evidence.evaluationDelta?.correlationGain,
                    hard: tailCandidate.evidence.evaluationDelta?.hardGatePassed,
                    joint: tailCandidate.evidence.evaluationDelta
                        ?.jointCompositionGatePassed,
                    tags: tailCandidate.evidence.recallSourceTags,
                } : null,
                joint: diagnosis.jointEventDecisions?.map((decision) => ({
                    status: decision.status,
                    reason: decision.reason,
                    operationMargin: decision.operationMargin,
                    sourceStage: decision.sourceStage,
                    event: decision.event ? {
                        type: decision.event.eventType,
                        shiftYears: decision.event.shiftYears,
                    } : null,
                })),
                review: diagnosis.reviewWindowDecisions?.map((decision) => ({
                    status: decision.status,
                    reason: decision.reason,
                    strictReason: decision.strictReason,
                    sourceStage: decision.sourceStage,
                })),
            }, null, 2);

            expect(displayed, details).toHaveLength(1);
            expect(displayed[0]?.eventType, details).toBe("wholeSeriesMove");
            expect(displayed[0]?.shiftYears, details).toBe(-2);
        },
        120_000,
    );

    it("keeps the newest of two distant mon032 missing rings as the primary frontier", () => {
        const parsed = parseRwl(readFileSync(RWL_PATH, "utf8"));
        const targetId = "mon032";
        const target = parsed.get(targetId)!;
        const site: RwlSiteData = new Map(
            Array.from(parsed, ([seriesId, series]) => [
                seriesId,
                new Map(series.valuesByYear),
            ]),
        );
        site.set(
            targetId,
            buildMultiMissingCorrupted(target.valuesByYear, [1977, 1902]),
        );

        const outText = runBundledCofecha(site);
        const parts = splitReportByParts(outText);
        const referenceConfig = createCofechaMasterReferenceConfig({
            siteData: site,
            flaggedAIds: extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? ""),
            cofechaRunId: "co612-mon032-two-distant-missing",
            rwlHash: "co612-mon032-two-distant-missing",
            masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
        });
        const diagnosis = diagnoseCrossdating(site, {
            referenceConfig,
            targetTrees: [targetId],
            cofechaText: outText,
            reviewWindowDisplayMode: "review",
            includeEventDecisionAudits: true,
        });
        const core = diagnoseSeriesCore(
            site,
            targetId,
            getConfig({ referenceConfig }),
        );
        const tail = core
            ? measureRecentTailLagConsensus(core, getConfig({ referenceConfig }))
            : null;
        const displayed = getDisplayedDiagnosisEvents(diagnosis)
            .filter((event) => event.seriesId === targetId);
        const audit = diagnosis.eventDecisionAudits?.find(
            (row) => row.seriesId === targetId,
        );
        const summarizeStage = (
            events: NonNullable<typeof audit>["finalEvents"],
        ) => events.map(
            (event) => ({
                type: event.eventType,
                shiftYears: event.shiftYears,
                range: [event.startYear, event.endYear],
                topYear: event.topYear,
                lagBefore: event.lagBefore,
                lagAfter: event.lagAfter,
                sources: event.algorithmSources,
                notes: event.notes.filter((note) => (
                    note.startsWith("whole_state_")
                    || note.startsWith("whole_baseline_")
                    || note.startsWith("bounded_path_transition=")
                )),
            }),
        );
        const details = JSON.stringify({
            displayed: displayed.map((event) => ({
                type: event.eventType,
                shiftYears: event.shiftYears,
                range: [event.startYear, event.endYear],
                topYear: event.rankedYears[0]?.year,
                sources: event.evidence.algorithmSources,
                notes: event.evidence.notes.filter((note) => (
                    note.startsWith("whole_state_")
                    || note.startsWith("whole_baseline_")
                )),
                alternative: event.interpretationAmbiguity ? {
                    type: event.interpretationAmbiguity.alternative.eventType,
                    range: [
                        event.interpretationAmbiguity.alternative.startYear,
                        event.interpretationAmbiguity.alternative.endYear,
                    ],
                    topYear: event.interpretationAmbiguity.alternative.rankedYears[0]?.year,
                    sources: event.interpretationAmbiguity.alternative.evidence.algorithmSources,
                    notes: event.interpretationAmbiguity.alternative.evidence.notes.filter(
                        (note) => note.startsWith("bounded_path_transition="),
                    ),
                } : null,
            })),
            candidates: diagnosis.candidates
                .filter((candidate) => candidate.targetTree === targetId)
                .map((candidate) => ({
                    mode: candidate.mode,
                    shiftYears: candidate.deltaYears,
                    year: candidate.targetYear,
                    score: candidate.score,
                    tags: candidate.evidence.recallSourceTags,
                })),
            stages: audit ? {
                candidate: summarizeStage(audit.candidateProjectedEvents),
                detected: summarizeStage(audit.detectedBeforeFusion),
                fused: summarizeStage(audit.detectedAfterFusion),
                final: summarizeStage(audit.finalEvents),
            } : null,
            tail,
        }, null, 2);

        expect(displayed, details).toHaveLength(1);
        expect(displayed[0]?.eventType, details).toBe("missingRing");
        expect(displayed[0]?.startYear, details).toBeLessThanOrEqual(1977);
        expect(displayed[0]?.endYear, details).toBeGreaterThanOrEqual(1977);
    }, 120_000);

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
        expect(displayed[0]?.eventType, details).toBe("wholeSeriesMove");
        expect(displayed[0]?.shiftYears, details).toBe(-2);
        expect(diagnosis.candidates.some((candidate) => (
            displayed[0]!.evidence.candidateIds.includes(candidate.id)
            && candidate.mode === "wholeSeriesMove"
            && candidate.deltaYears === -2
        )), details).toBe(true);

        const displayedYears = [...after1925.keys()];
        const afterWholeRepair = moveSeriesTailByOffset(
            after1925,
            Math.min(...displayedYears),
            Math.max(...displayedYears),
            -2,
        );
        site.set(TARGET_ID, afterWholeRepair);
        const repairedOutText = runBundledCofecha(site);
        const repairedParts = splitReportByParts(repairedOutText);
        const repairedReferenceConfig = createCofechaMasterReferenceConfig({
            siteData: site,
            flaggedAIds: extractPart6FlaggedASeriesIds(
                repairedParts.get("PART 6") ?? "",
            ),
            cofechaRunId: "co612-mon161-after-whole-repair",
            rwlHash: "co612-mon161-after-whole-repair",
            masterDatingSeries: parseCofechaResult(repairedOutText).masterDatingSeries,
        });
        const afterWholeDiagnosis = diagnoseCrossdating(site, {
            referenceConfig: repairedReferenceConfig,
            targetTrees: [TARGET_ID],
            cofechaText: repairedOutText,
            reviewWindowDisplayMode: "review",
            includeEventDecisionAudits: true,
        });
        const afterWholeDisplayed = getDisplayedDiagnosisEvents(afterWholeDiagnosis)
            .filter((event) => event.seriesId === TARGET_ID);
        const afterWholeDetails = JSON.stringify(afterWholeDisplayed.map((event) => ({
            type: event.eventType,
            shiftYears: event.shiftYears,
            range: [event.startYear, event.endYear],
            topYear: event.rankedYears[0]?.year,
            lagBefore: event.evidence.lagBefore,
            lagAfter: event.evidence.lagAfter,
            sources: event.evidence.algorithmSources,
        })), null, 2);

        expect(afterWholeDisplayed, afterWholeDetails).toHaveLength(1);
        expect(afterWholeDisplayed[0]?.eventType, afterWholeDetails).toBe("missingRing");
        expect(afterWholeDisplayed[0]?.startYear, afterWholeDetails)
            .toBeLessThanOrEqual(1975);
        expect(afterWholeDisplayed[0]?.endYear, afterWholeDetails)
            .toBeGreaterThanOrEqual(1975);

        site.set(
            TARGET_ID,
            insertMissingYearAtSide(afterWholeRepair, 1975, "right"),
        );
        const afterFirstMissingOutText = runBundledCofecha(site);
        const afterFirstMissingParts = splitReportByParts(afterFirstMissingOutText);
        const afterFirstMissingReferenceConfig = createCofechaMasterReferenceConfig({
            siteData: site,
            flaggedAIds: extractPart6FlaggedASeriesIds(
                afterFirstMissingParts.get("PART 6") ?? "",
            ),
            cofechaRunId: "co612-mon161-after-first-missing-repair",
            rwlHash: "co612-mon161-after-first-missing-repair",
            masterDatingSeries: parseCofechaResult(
                afterFirstMissingOutText,
            ).masterDatingSeries,
        });
        const afterFirstMissingDisplayed = getDisplayedDiagnosisEvents(
            diagnoseCrossdating(site, {
                referenceConfig: afterFirstMissingReferenceConfig,
                targetTrees: [TARGET_ID],
                cofechaText: afterFirstMissingOutText,
                reviewWindowDisplayMode: "review",
                includeEventDecisionAudits: true,
            }),
        ).filter((event) => event.seriesId === TARGET_ID);
        const afterFirstMissingDetails = JSON.stringify(
            afterFirstMissingDisplayed.map((event) => ({
                type: event.eventType,
                shiftYears: event.shiftYears,
                range: [event.startYear, event.endYear],
                topYear: event.rankedYears[0]?.year,
                lagBefore: event.evidence.lagBefore,
                lagAfter: event.evidence.lagAfter,
                sources: event.evidence.algorithmSources,
            })),
            null,
            2,
        );

        expect(afterFirstMissingDisplayed, afterFirstMissingDetails).toHaveLength(1);
        expect(afterFirstMissingDisplayed[0]?.eventType, afterFirstMissingDetails)
            .toBe("missingRing");
        expect(afterFirstMissingDisplayed[0]?.startYear, afterFirstMissingDetails)
            .toBeLessThanOrEqual(1922);
        expect(afterFirstMissingDisplayed[0]?.endYear, afterFirstMissingDetails)
            .toBeGreaterThanOrEqual(1922);
    }, 120_000);
});
