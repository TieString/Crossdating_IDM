import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    createCofechaMasterReferenceConfig,
    createCofechaPassReferenceConfig,
} from "@/features/crossdating/reference";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    diagnoseCrossdating,
    getDisplayedDiagnosisEvents,
} from "@/features/crossdating/diagnosis";
import { getConfig } from "@/features/crossdating/diagnosis/config";
import {
    createLagPathCache,
    locateSequentialFalseHead,
    locateSequentialMissingHead,
} from "@/features/crossdating/diagnosis/eventPath";
import { diagnoseSeriesCore } from "@/features/crossdating/diagnosis/segments";
import { scoreJointCounterfactualOperations } from "@/features/crossdating/diagnosis/jointCounterfactualOperation";
import { compareTwoStepUnitDirections } from "@/features/crossdating/diagnosis/discreteMissingStaircaseCompetition";
import { cofechaStyleStandardize } from "@/features/crossdating/reference";
import type { DiagnosisEvent } from "../types";
import {
    applyInsertRestore,
    buildMultiMissingCorrupted,
    createPartialRangeMoveCase,
    createPiecewiseLagMixedCase,
    parseRwl,
    reconstructMissingFromZero,
    sameSeries,
} from "./rdmFixture";

const FIXTURE_PATH = process.env.CO612_RWL_PATH ?? "D:/软件测试/co612.rwl";
const OUT_PATH = process.env.CO612_OUT_PATH ?? "D:/软件测试/co612.OUT";
const TARGET_ID = "mon052";
const COFECHA_EXE = fileURLToPath(new URL(
    "../../../../../src-tauri/bin/cofecha-x86_64-pc-windows-msvc.exe",
    import.meta.url,
));
const EXPECTED_ZERO_YEARS = [
    1685,
    1773,
    1778,
    1813,
    1861,
    1870,
    1873,
    1902,
    1977,
];

const summarize = (events: readonly DiagnosisEvent[]) => events.map((event) => ({
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

const fixtureDescribe = existsSync(FIXTURE_PATH) && existsSync(OUT_PATH)
    ? describe
    : describe.skip;
const bundledCofechaIt = process.platform === "win32" && existsSync(COFECHA_EXE)
    ? it
    : it.skip;

const runBundledCofecha = (siteData: RwlSiteData): string => {
    const workDir = mkdtempSync(join(tmpdir(), "co612-multi-missing-"));
    try {
        writeFileSync(join(workDir, "INPUT.RWL"), formatTucson(siteData, false), "utf8");
        execFileSync(COFECHA_EXE, [], {
            cwd: workDir,
            input: "very\nINPUT.RWL\n\n\n\n\n\n\n",
            timeout: 30_000,
            stdio: ["pipe", "ignore", "pipe"],
        });
        return readFileSync(join(workDir, "VERYCOF.OUT"), "utf8");
    } finally {
        rmSync(workDir, { force: true, recursive: true });
    }
};

fixtureDescribe("co612 mon052 multi-missing-ring regression", () => {
    const parsed = parseRwl(readFileSync(FIXTURE_PATH, "utf8"));
    const target = parsed.get(TARGET_ID)!;
    const cleanSite: RwlSiteData = new Map(
        Array.from(parsed, ([seriesId, series]) => [
            seriesId,
            new Map(series.valuesByYear),
        ]),
    );
    const cleanOut = readFileSync(OUT_PATH, "utf8");
    const cleanParts = splitReportByParts(cleanOut);
    const referenceConfig = createCofechaMasterReferenceConfig({
        siteData: cleanSite,
        flaggedAIds: extractPart6FlaggedASeriesIds(
            cleanParts.get("PART 6") ?? "",
        ),
        cofechaRunId: "co612-clean",
        rwlHash: "co612-clean",
        masterDatingSeries: parseCofechaResult(cleanOut).masterDatingSeries,
    });
    const zeroYears = Array.from(target.valuesByYear)
        .filter(([, value]) => value === 0)
        .map(([year]) => year)
        .sort((left, right) => left - right);

    const buildSite = (valuesByYear: Map<number, number>): RwlSiteData => {
        const site = new Map(cleanSite);
        site.set(TARGET_ID, new Map(valuesByYear));
        return site;
    };
    const runDiagnosis = (valuesByYear: Map<number, number>) => {
        const site = buildSite(valuesByYear);
        return diagnoseCrossdating(site, {
            referenceConfig,
            targetTrees: [TARGET_ID],
        });
    };
    const diagnose = (valuesByYear: Map<number, number>): DiagnosisEvent[] => (
        runDiagnosis(valuesByYear).events.filter((event) => event.seriesId === TARGET_ID)
    );
    const diagnoseWithFreshCofecha = (valuesByYear: Map<number, number>) => {
        const site = buildSite(valuesByYear);
        const outText = runBundledCofecha(site);
        const parts = splitReportByParts(outText);
        const dynamicReference = createCofechaMasterReferenceConfig({
            siteData: site,
            flaggedAIds: extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? ""),
            cofechaRunId: "co612-multi-missing-fresh",
            rwlHash: "co612-multi-missing-fresh",
            masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
        });
        return diagnoseCrossdating(site, {
            referenceConfig: dynamicReference,
            targetTrees: [TARGET_ID],
            cofechaText: outText,
        }).events.filter((event) => event.seriesId === TARGET_ID);
    };

    it("keeps every single-zero removal inside its main window", () => {
        expect(zeroYears).toEqual(EXPECTED_ZERO_YEARS);

        const singleCases = zeroYears.map((year) => {
            const events = diagnose(reconstructMissingFromZero(
                target.valuesByYear,
                year,
            ));
            const missing = events.find((event) => event.eventType === "missingRing");
            return {
                year,
                covered: Boolean(
                    missing
                    && year >= missing.startYear
                    && year <= missing.endYear
                ),
                events: summarize(events),
            };
        });

        expect(singleCases.every((row) => row.covered)).toBe(true);
    }, 180_000);

    bundledCofechaIt("shows only the newest missing ring after fresh COFECHA", () => {
        const corrupted = buildMultiMissingCorrupted(
            target.valuesByYear,
            zeroYears,
        );
        const events = diagnoseWithFreshCofecha(corrupted);
        const [event] = events;

        expect(events, JSON.stringify(summarize(events)))
            .toHaveLength(1);
        expect(event.eventType).toBe("missingRing");
        expect(event.startYear).toBeLessThanOrEqual(1977);
        expect(event.endYear).toBeGreaterThanOrEqual(1977);
        expect(event.rankedYears[0]?.year).toBe(1977);
        expect(event.evidence.algorithmSources)
            .toContain("sequential_missing_staircase_head");
    }, 180_000);

    bundledCofechaIt("reveals all nine missing rings from bark to pith", () => {
        let corrupted = buildMultiMissingCorrupted(
            target.valuesByYear,
            zeroYears,
        );
        const steps: Array<{
            truthYear: number;
            events: ReturnType<typeof summarize>;
        }> = [];

        zeroYears.slice().reverse().forEach((truthYear) => {
            const events = diagnoseWithFreshCofecha(corrupted);
            steps.push({ truthYear, events: summarize(events) });
            const [event] = events;

            expect(events, JSON.stringify(steps)).toHaveLength(1);
            expect(event.eventType, JSON.stringify(steps)).toBe("missingRing");
            expect(event.startYear, JSON.stringify(steps))
                .toBeLessThanOrEqual(truthYear);
            expect(event.endYear, JSON.stringify(steps))
                .toBeGreaterThanOrEqual(truthYear);
            expect(event.endYear - event.startYear + 1, JSON.stringify(steps))
                .toBeLessThanOrEqual(13);
            corrupted = applyInsertRestore(corrupted, truthYear);
        });

        expect(sameSeries(
            corrupted,
            target.valuesByYear,
        ), JSON.stringify(steps)).toBe(true);
    }, 240_000);

    bundledCofechaIt("keeps the next missing ring after saving the first repair", () => {
        const corrupted = buildMultiMissingCorrupted(
            target.valuesByYear,
            zeroYears,
        );
        const after1977 = applyInsertRestore(corrupted, 1977);
        const savedSite = buildSite(after1977);
        const savedOut = runBundledCofecha(savedSite);
        const savedParts = splitReportByParts(savedOut);
        const savedFlaggedIds = extractPart6FlaggedASeriesIds(
            savedParts.get("PART 6") ?? "",
        );
        const savedReference = createCofechaMasterReferenceConfig({
            siteData: savedSite,
            flaggedAIds: savedFlaggedIds,
            cofechaRunId: "co612-after-1977",
            rwlHash: "co612-after-1977",
            masterDatingSeries: parseCofechaResult(savedOut).masterDatingSeries,
        });
        const events = diagnoseCrossdating(savedSite, {
            referenceConfig: savedReference,
            targetTrees: [TARGET_ID],
            cofechaText: savedOut,
        }).events.filter((event) => event.seriesId === TARGET_ID);
        const [event] = events;

        expect(savedReference.classification?.candidateFlaggedIds).toHaveLength(1);
        expect(events, JSON.stringify(summarize(events))).toHaveLength(1);
        expect(event.eventType).toBe("missingRing");
        expect(event.rankedYears[0]?.year).toBe(1902);
        expect(event.startYear).toBeLessThanOrEqual(1902);
        expect(event.endYear).toBeGreaterThanOrEqual(1902);
        expect(events.some((candidate) => candidate.eventType === "partialMove")).toBe(false);
    }, 180_000);

    bundledCofechaIt("keeps the bark-most mon062 zero removal as a missing ring", () => {
        const seriesId = "mon062";
        const mon062 = parsed.get(seriesId)!;
        const newestZeroYear = Math.max(...Array.from(mon062.valuesByYear)
            .filter(([, value]) => value === 0)
            .map(([year]) => year));
        const corrupted = reconstructMissingFromZero(
            mon062.valuesByYear,
            newestZeroYear,
        );
        const site = new Map(cleanSite);
        site.set(seriesId, corrupted);
        const beforeSave = diagnoseCrossdating(site, {
            referenceConfig,
            targetTrees: [seriesId],
            reviewWindowDisplayMode: "review",
        });

        const outText = runBundledCofecha(site);
        const parts = splitReportByParts(outText);
        const freshReference = createCofechaMasterReferenceConfig({
            siteData: site,
            flaggedAIds: extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? ""),
            cofechaRunId: "co612-mon062-after-zero-removal",
            rwlHash: "co612-mon062-after-zero-removal",
            masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
        });
        const afterSave = diagnoseCrossdating(site, {
            referenceConfig: freshReference,
            targetTrees: [seriesId],
            cofechaText: outText,
            reviewWindowDisplayMode: "review",
        });

        expect(newestZeroYear).toBe(1977);
        const displayedByState = [beforeSave, afterSave].map((diagnosis) => (
            getDisplayedDiagnosisEvents(diagnosis)
                .filter((event) => event.seriesId === seriesId)
        ));
        displayedByState.forEach((events) => {
            const [event] = events;
            expect(events, JSON.stringify(summarize(events))).toHaveLength(1);
            expect(event.eventType, JSON.stringify(summarize(events))).toBe("missingRing");
            expect(event.startYear, JSON.stringify(summarize(events)))
                .toBeLessThanOrEqual(newestZeroYear);
            expect(event.endYear, JSON.stringify(summarize(events)))
                .toBeGreaterThanOrEqual(newestZeroYear);
            expect(event.rankedYears[0]?.year, JSON.stringify(summarize(events)))
                .toBe(newestZeroYear);
            expect(event.endYear - event.startYear + 1, JSON.stringify(summarize(events)))
                .toBeLessThanOrEqual(13);
        });
        [beforeSave, afterSave].forEach((diagnosis) => {
            expect(diagnosis.events.some((event) => (
                event.eventType === "wholeSeriesMove"
            )), JSON.stringify(summarize(diagnosis.events))).toBe(false);
        });
        expect(displayedByState[1][0], JSON.stringify({
            before: summarize(displayedByState[0]),
            after: summarize(displayedByState[1]),
        })).toMatchObject({
            eventType: displayedByState[0][0].eventType,
            startYear: displayedByState[0][0].startYear,
            endYear: displayedByState[0][0].endYear,
        });
    }, 180_000);

    bundledCofechaIt("keeps the first two bark-side mtr721 zero removals as one missing-ring frontier", () => {
        const seriesId = "mtr721";
        const mtr721 = parsed.get(seriesId)!;
        const removedZeroYears = Array.from(mtr721.valuesByYear)
            .filter(([, value]) => value === 0)
            .map(([year]) => year)
            .sort((left, right) => right - left)
            .slice(0, 2);
        const corrupted = buildMultiMissingCorrupted(
            mtr721.valuesByYear,
            removedZeroYears,
        );
        const site = new Map(cleanSite);
        site.set(seriesId, corrupted);
        const beforeSave = diagnoseCrossdating(site, {
            referenceConfig,
            targetTrees: [seriesId],
            reviewWindowDisplayMode: "review",
        });

        const outText = runBundledCofecha(site);
        const parts = splitReportByParts(outText);
        const freshReference = createCofechaMasterReferenceConfig({
            siteData: site,
            flaggedAIds: extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? ""),
            cofechaRunId: "co612-mtr721-after-two-zero-removals",
            rwlHash: "co612-mtr721-after-two-zero-removals",
            masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
        });
        const afterSave = diagnoseCrossdating(site, {
            referenceConfig: freshReference,
            targetTrees: [seriesId],
            cofechaText: outText,
            reviewWindowDisplayMode: "review",
        });

        expect(removedZeroYears).toEqual([1803, 1798]);
        const displayedByState = [beforeSave, afterSave].map((diagnosis) => (
            getDisplayedDiagnosisEvents(diagnosis)
                .filter((event) => event.seriesId === seriesId)
        ));
        const failureContext = JSON.stringify({
            before: summarize(displayedByState[0]),
            after: summarize(displayedByState[1]),
        });
        displayedByState.forEach((events) => {
            const [event] = events;
            expect(events, failureContext).toHaveLength(1);
            expect(event.eventType, failureContext).toBe("missingRing");
            expect(event.startYear, failureContext)
                .toBeLessThanOrEqual(removedZeroYears[0]);
            expect(event.endYear, failureContext)
                .toBeGreaterThanOrEqual(removedZeroYears[0]);
            expect(event.rankedYears[0]?.year, failureContext)
                .toBe(removedZeroYears[0]);
            expect(event.endYear - event.startYear + 1, failureContext)
                .toBeLessThanOrEqual(13);
        });
        expect(displayedByState[1][0].eventType, failureContext)
            .toBe(displayedByState[0][0].eventType);
        expect(
            displayedByState[1][0].endYear - displayedByState[1][0].startYear,
            failureContext,
        ).toBeLessThanOrEqual(
            displayedByState[0][0].endYear - displayedByState[0][0].startYear,
        );
        expect(displayedByState[1][0].evidence.algorithmSources, failureContext)
            .toContain("robust_per_reference_missing_staircase");
    }, 180_000);

    bundledCofechaIt("keeps the mtr721 1801-1802 physical gap visible before and after save", () => {
        const seriesId = "mtr721";
        const firstFixedYear = 1803;
        const gapYears = 2;
        const source = parsed.get(seriesId)!;
        const cleanDisplayed = getDisplayedDiagnosisEvents(diagnoseCrossdating(
            cleanSite,
            {
                referenceConfig,
                targetTrees: [seriesId],
                reviewWindowDisplayMode: "review",
                includeEventDecisionAudits: true,
            },
        )).filter((event) => event.seriesId === seriesId);
        const physical = createPartialRangeMoveCase(
            source,
            firstFixedYear,
            gapYears,
        );
        const site = new Map(cleanSite);
        site.set(seriesId, physical.corrupted);
        const beforeSave = diagnoseCrossdating(site, {
            referenceConfig,
            targetTrees: [seriesId],
            reviewWindowDisplayMode: "review",
            includeEventDecisionAudits: true,
        });

        const outText = runBundledCofecha(site);
        const parts = splitReportByParts(outText);
        const freshReference = createCofechaMasterReferenceConfig({
            siteData: site,
            flaggedAIds: extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? ""),
            cofechaRunId: "co612-mtr721-physical-gap-1803",
            rwlHash: "co612-mtr721-physical-gap-1803",
            masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
        });
        const afterSave = diagnoseCrossdating(site, {
            referenceConfig: freshReference,
            targetTrees: [seriesId],
            cofechaText: outText,
            reviewWindowDisplayMode: "review",
            includeEventDecisionAudits: true,
        });
        const displayedByState = [beforeSave, afterSave].map((diagnosis) => (
            getDisplayedDiagnosisEvents(diagnosis)
                .filter((event) => event.seriesId === seriesId)
        ));
        const auditSummary = (diagnosis: typeof beforeSave) => {
            const audit = diagnosis.eventDecisionAudits?.[0];
            const events = (rows: NonNullable<typeof audit>["finalEvents"]) => rows.map(
                (event) => ({
                    type: event.eventType,
                    range: [event.startYear, event.endYear],
                    topYear: event.topYear,
                    shiftYears: event.shiftYears,
                    lag: [event.lagBefore, event.lagAfter],
                    sources: event.algorithmSources,
                }),
            );
            return audit ? {
                finalReason: audit.finalReason,
                pass: audit.pass,
                candidates: audit.candidates,
                candidateProjected: events(audit.candidateProjectedEvents),
                detectedBeforeFusion: events(audit.detectedBeforeFusion),
                detectedAfterFusion: events(audit.detectedAfterFusion),
                retained: events(audit.retainedAfterEndpointGuard),
                displayed: events(audit.displayedBeforeLocator),
                final: events(audit.finalEvents),
                finalNotes: diagnosis.events[0]?.evidence.notes.filter((note) => (
                    note.startsWith("counterfactual_")
                    || note.startsWith("candidate_")
                    || note.startsWith("partial_")
                    || note.startsWith("local_")
                    || note.startsWith("scan_")
                    || note.startsWith("paired_")
                )),
            } : null;
        };
        const failureContext = JSON.stringify({
            before: summarize(displayedByState[0]),
            after: summarize(displayedByState[1]),
            beforeAudit: auditSummary(beforeSave),
            afterAudit: auditSummary(afterSave),
        });

        expect(source.valuesByYear.get(1803)).toBe(0);
        expect(
            cleanDisplayed.filter((event) => event.eventType === "partialMove"),
            JSON.stringify(summarize(cleanDisplayed)),
        ).toEqual([]);
        expect(physical.corrupted.get(1800)).toBe(source.valuesByYear.get(1798));
        expect(physical.corrupted.get(1801)).toBe(source.valuesByYear.get(1799));
        expect(physical.corrupted.get(1802)).toBe(source.valuesByYear.get(1800));
        expect(physical.corrupted.get(1803)).toBe(source.valuesByYear.get(1803));
        displayedByState.forEach((events) => {
            const [event] = events;
            expect(events, failureContext).toHaveLength(1);
            expect(event.eventType, failureContext).toBe("partialMove");
            expect(event.shiftYears, failureContext).toBe(-gapYears);
            expect(event.startYear, failureContext).toBeLessThanOrEqual(firstFixedYear);
            expect(event.endYear, failureContext).toBeGreaterThanOrEqual(firstFixedYear);
            expect([5, 7, 9, 13], failureContext).toContain(
                event.endYear - event.startYear + 1,
            );
            expect(event.rankedYears.some((row) => row.year === firstFixedYear), failureContext)
                .toBe(true);
            expect(event.evidence.algorithmSources, failureContext)
                .toContain("partial_local_consensus_recenter");
        });
        expect(
            [displayedByState[1][0].startYear, displayedByState[1][0].endYear],
            failureContext,
        ).toEqual([
            displayedByState[0][0].startYear,
            displayedByState[0][0].endYear,
        ]);
    }, 180_000);

    bundledCofechaIt("keeps the mtr721 three- and four-year physical gaps visible", () => {
        const seriesId = "mtr721";
        const firstFixedYear = 1803;
        const source = parsed.get(seriesId)!;
        const compact = (diagnosis: ReturnType<typeof diagnoseCrossdating>) => {
            const audit = diagnosis.eventDecisionAudits?.[0];
            const events = (rows: NonNullable<typeof audit>["finalEvents"]) => rows.map(
                (event) => ({
                    type: event.eventType,
                    range: [event.startYear, event.endYear],
                    topYear: event.topYear,
                    shiftYears: event.shiftYears,
                    lag: [event.lagBefore, event.lagAfter],
                    sources: event.algorithmSources,
                }),
            );
            return {
                shown: summarize(getDisplayedDiagnosisEvents(diagnosis)),
                strict: summarize(diagnosis.events),
                audit: audit ? {
                    finalReason: audit.finalReason,
                    candidates: audit.candidates,
                    candidateProjected: events(audit.candidateProjectedEvents),
                    detectedBeforeFusion: events(audit.detectedBeforeFusion),
                    detectedAfterFusion: events(audit.detectedAfterFusion),
                    retained: events(audit.retainedAfterEndpointGuard),
                    displayed: events(audit.displayedBeforeLocator),
                    final: events(audit.finalEvents),
                    finalNotes: diagnosis.events[0]?.evidence.notes.filter((note) => (
                        note.startsWith("counterfactual_")
                        || note.startsWith("candidate_")
                        || note.startsWith("partial_")
                        || note.startsWith("local_")
                        || note.startsWith("joint_")
                    )),
                } : null,
            };
        };
        const scenarios = [3, 4].map((gapYears) => {
            const physical = createPartialRangeMoveCase(
                source,
                firstFixedYear,
                gapYears,
            );
            const site = new Map(cleanSite);
            site.set(seriesId, physical.corrupted);
            const beforeSave = diagnoseCrossdating(site, {
                referenceConfig,
                targetTrees: [seriesId],
                reviewWindowDisplayMode: "review",
                includeEventDecisionAudits: true,
            });
            const outText = runBundledCofecha(site);
            const parts = splitReportByParts(outText);
            const freshReference = createCofechaMasterReferenceConfig({
                siteData: site,
                flaggedAIds: extractPart6FlaggedASeriesIds(
                    parts.get("PART 6") ?? "",
                ),
                cofechaRunId: `co612-mtr721-physical-gap-${gapYears}`,
                rwlHash: `co612-mtr721-physical-gap-${gapYears}`,
                masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
            });
            const afterSave = diagnoseCrossdating(site, {
                referenceConfig: freshReference,
                targetTrees: [seriesId],
                cofechaText: outText,
                reviewWindowDisplayMode: "review",
                includeEventDecisionAudits: true,
            });
            return { gapYears, beforeSave, afterSave };
        });
        const failureContext = JSON.stringify(scenarios.map((scenario) => ({
            gapYears: scenario.gapYears,
            beforeSave: compact(scenario.beforeSave),
            afterSave: compact(scenario.afterSave),
        })));

        scenarios.forEach(({ gapYears, beforeSave, afterSave }) => {
            const displayedStates = [beforeSave, afterSave].map((diagnosis) => (
                getDisplayedDiagnosisEvents(diagnosis).filter(
                    (event) => event.seriesId === seriesId,
                )
            ));
            displayedStates.forEach((events) => {
                const [event] = events;
                expect(events, failureContext).toHaveLength(1);
                expect(event.eventType, failureContext).toBe("partialMove");
                expect(event.shiftYears, failureContext).toBe(-gapYears);
                expect(event.startYear, failureContext)
                    .toBeLessThanOrEqual(firstFixedYear);
                expect(event.endYear, failureContext)
                    .toBeGreaterThanOrEqual(firstFixedYear);
                expect([5, 7, 9, 13], failureContext).toContain(
                    event.endYear - event.startYear + 1,
                );
                expect(event.evidence.algorithmSources, failureContext)
                    .toContain("partial_local_consensus_recenter");
            });
            expect([
                displayedStates[1][0].startYear,
                displayedStates[1][0].endYear,
            ], failureContext).toEqual([
                displayedStates[0][0].startYear,
                displayedStates[0][0].endYear,
            ]);
        });
    }, 240_000);

    bundledCofechaIt("reveals all mtr841 missing rings without a partial-move detour", () => {
        const mtr841 = parsed.get("mtr841")!;
        const mtrZeroYears = Array.from(mtr841.valuesByYear)
            .filter(([, value]) => value === 0)
            .map(([year]) => year)
            .sort((left, right) => left - right);
        let corrupted = buildMultiMissingCorrupted(
            mtr841.valuesByYear,
            mtrZeroYears,
        );
        const steps: Array<{
            truthYear: number;
            events: ReturnType<typeof summarize>;
        }> = [];

        mtrZeroYears.slice().reverse().forEach((truthYear, index) => {
            const savedSite = new Map(cleanSite);
            savedSite.set("mtr841", new Map(corrupted));
            const savedOut = runBundledCofecha(savedSite);
            const savedParts = splitReportByParts(savedOut);
            const savedReference = createCofechaMasterReferenceConfig({
                siteData: savedSite,
                flaggedAIds: extractPart6FlaggedASeriesIds(
                    savedParts.get("PART 6") ?? "",
                ),
                cofechaRunId: `co612-mtr841-${index}`,
                rwlHash: `co612-mtr841-${index}`,
                masterDatingSeries: parseCofechaResult(savedOut).masterDatingSeries,
            });
            const events = diagnoseCrossdating(savedSite, {
                referenceConfig: savedReference,
                targetTrees: ["mtr841"],
                cofechaText: savedOut,
            }).events.filter((event) => event.seriesId === "mtr841");
            steps.push({ truthYear, events: summarize(events) });
            const [event] = events;

            expect(events, JSON.stringify(steps)).toHaveLength(1);
            expect(event.eventType, JSON.stringify(steps)).toBe("missingRing");
            expect(event.rankedYears[0]?.year, JSON.stringify(steps)).toBe(truthYear);
            expect(event.startYear, JSON.stringify(steps)).toBeLessThanOrEqual(truthYear);
            expect(event.endYear, JSON.stringify(steps)).toBeGreaterThanOrEqual(truthYear);
            expect(event.endYear - event.startYear + 1, JSON.stringify(steps))
                .toBeLessThanOrEqual(13);
            expect(events.some((candidate) => candidate.eventType === "partialMove"))
                .toBe(false);
            corrupted = applyInsertRestore(corrupted, truthYear);
        });

        expect(sameSeries(corrupted, mtr841.valuesByYear), JSON.stringify(steps))
            .toBe(true);
        expect(steps[2]?.events[0]?.sources.some((source) => (
            source === "sequential_missing_staircase_head"
            || source === "compressed_missing_staircase_projection"
        )), JSON.stringify(steps)).toBe(true);

        const physical = createPartialRangeMoveCase(mtr841, 1800, 2);
        const physicalSite = new Map(cleanSite);
        physicalSite.set("mtr841", physical.corrupted);
        const physicalEvents = diagnoseCrossdating(physicalSite, {
            referenceConfig,
            targetTrees: ["mtr841"],
        }).events.filter((event) => event.seriesId === "mtr841");
        expect(physicalEvents.some((event) => (
            event.eventType === "partialMove" && event.shiftYears === -2
        )), JSON.stringify(summarize(physicalEvents))).toBe(true);
        expect(physicalEvents.some((event) => event.evidence.algorithmSources.includes(
            "compressed_missing_staircase_projection",
        ))).toBe(false);
    }, 240_000);

    bundledCofechaIt("recovers only reference-supported separated two-step gaps", () => {
        const scenarios = [
            { seriesId: "mon121", targetStep: 4 },
            { seriesId: "mon162", targetStep: 3 },
        ];
        scenarios.forEach(({ seriesId, targetStep }) => {
            const series = parsed.get(seriesId)!;
            const truths = Array.from(series.valuesByYear)
                .filter(([, value]) => value === 0)
                .map(([year]) => year)
                .sort((left, right) => right - left);
            let corrupted = buildMultiMissingCorrupted(series.valuesByYear, truths);
            truths.slice(0, targetStep - 1).forEach((year) => {
                corrupted = applyInsertRestore(corrupted, year);
            });
            const truthYear = truths[targetStep - 1];
            const site = new Map(cleanSite);
            site.set(seriesId, corrupted);
            const outText = runBundledCofecha(site);
            const parts = splitReportByParts(outText);
            const dynamicReference = createCofechaMasterReferenceConfig({
                siteData: site,
                flaggedAIds: extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? ""),
                cofechaRunId: `co612-separated-staircase-${seriesId}`,
                rwlHash: `co612-separated-staircase-${seriesId}`,
                masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
            });
            const events = diagnoseCrossdating(site, {
                referenceConfig: dynamicReference,
                targetTrees: [seriesId],
                cofechaText: outText,
            }).events.filter((event) => event.seriesId === seriesId);
            const [event] = events;

            expect(event?.eventType, JSON.stringify(summarize(events))).toBe("missingRing");
            expect(event?.startYear, JSON.stringify(summarize(events)))
                .toBeLessThanOrEqual(truthYear);
            expect(event?.endYear, JSON.stringify(summarize(events)))
                .toBeGreaterThanOrEqual(truthYear);
            expect(event?.evidence.algorithmSources, JSON.stringify(summarize(events)))
                .toContain("explicit_partial_vs_missing_staircase");
        });
    }, 240_000);

    bundledCofechaIt("keeps separated same-direction unit steps visible before a -2 partial", () => {
        const rows = ["mtr712", "mtr832"].map((seriesId) => {
            const series = parsed.get(seriesId)!;
            const center = Math.round(
                series.startYear + (series.endYear - series.startYear) * 0.5,
            );
            // Mirror the frozen composition benchmark's deterministic middle stratum.
            const olderYear = center - 3;
            const newerYear = olderYear + 9;
            const corrupted = createPiecewiseLagMixedCase(series, [{
                eventType: "missingRing",
                year: olderYear,
                shiftYears: -1,
            }, {
                eventType: "missingRing",
                year: newerYear,
                shiftYears: -1,
            }]).corrupted;
            const site = new Map(cleanSite);
            site.set(seriesId, corrupted);
            const outText = runBundledCofecha(site);
            const flaggedIds = extractPart6FlaggedASeriesIds(
                splitReportByParts(outText).get("PART 6") ?? "",
            );
            const targetExcludedFlags = new Set([...flaggedIds, seriesId]);
            const dynamicReference = createCofechaPassReferenceConfig({
                siteData: site,
                flaggedAIds: targetExcludedFlags,
                cofechaRunId: `co612-same-direction-staircase-${seriesId}`,
                rwlHash: `co612-same-direction-staircase-${seriesId}`,
            });
            const diagnosis = diagnoseCrossdating(site, {
                referenceConfig: dynamicReference,
                targetTrees: [seriesId],
                cofechaText: outText,
                includeEventDecisionAudits: true,
            });
            const events = diagnosis.events.filter((event) => event.seriesId === seriesId);
            return {
                seriesId,
                olderYear,
                newerYear,
                events: summarize(events),
                audit: diagnosis.eventDecisionAudits?.[0] ?? null,
            };
        });

        rows.forEach((row) => {
            const event = row.events[0];
            expect(event?.type, JSON.stringify(rows)).toBe("missingRing");
            expect(
                event && row.newerYear >= event.range[0] && row.newerYear <= event.range[1],
                JSON.stringify(rows),
            ).toBe(true);
            expect(event?.sources, JSON.stringify(rows))
                .toContain("robust_per_reference_missing_staircase");
        });
    }, 240_000);

    bundledCofechaIt("keeps COFECHA-backed physical gaps as partial moves", () => {
        const scenarios = [
            { seriesId: "mon251", firstFixedYear: 1942, gapYears: 2 },
            { seriesId: "mon252", firstFixedYear: 1765, gapYears: 20 },
        ];
        scenarios.forEach(({ seriesId, firstFixedYear, gapYears }) => {
            const series = parsed.get(seriesId)!;
            const physical = createPartialRangeMoveCase(
                series,
                firstFixedYear,
                gapYears,
            );
            const site = new Map(cleanSite);
            site.set(seriesId, physical.corrupted);
            const outText = runBundledCofecha(site);
            const parts = splitReportByParts(outText);
            const dynamicReference = createCofechaMasterReferenceConfig({
                siteData: site,
                flaggedAIds: extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? ""),
                cofechaRunId: `co612-physical-partial-${seriesId}-${gapYears}`,
                rwlHash: `co612-physical-partial-${seriesId}-${gapYears}`,
                masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
            });
            const events = diagnoseCrossdating(site, {
                referenceConfig: dynamicReference,
                targetTrees: [seriesId],
                cofechaText: outText,
            }).events.filter((event) => event.seriesId === seriesId);
            const event = events.find((candidate) => (
                candidate.eventType === "partialMove"
                && candidate.shiftYears === -gapYears
            ));

            expect(event, JSON.stringify({
                seriesId,
                firstFixedYear,
                gapYears,
                events: summarize(events),
            })).toBeDefined();
            expect(event!.startYear).toBeLessThanOrEqual(firstFixedYear);
            expect(event!.endYear).toBeGreaterThanOrEqual(firstFixedYear);
            expect(events.some((candidate) => candidate.eventType === "missingRing"),
                JSON.stringify(summarize(events))).toBe(false);
        });
    }, 240_000);

    it("keeps genuine two-year gaps as partial moves", () => {
        [1800, 1850].forEach((firstFixedYear) => {
            const partial = createPartialRangeMoveCase(target, firstFixedYear, 2);
            const events = diagnose(partial.corrupted);
            const event = events.find((candidate) => (
                candidate.eventType === "partialMove" && candidate.shiftYears === -2
            ));
            expect(event, JSON.stringify(summarize(events))).toBeDefined();
            expect(event!.startYear).toBeLessThanOrEqual(firstFixedYear);
            expect(event!.endYear).toBeGreaterThanOrEqual(firstFixedYear);
            expect(events.some((candidate) => candidate.evidence.algorithmSources.includes(
                "compressed_missing_staircase_projection",
            ))).toBe(false);
        });
    }, 180_000);

    it("keeps physical gaps from -2 through -100 at multiple boundaries", () => {
        const gapYears = [2, 3, 4, 6, 10, 30, 50, 100];
        const firstFixedYears = [1750, 1800, 1850];
        const rows = firstFixedYears.flatMap((firstFixedYear) => (
            gapYears.map((gap) => {
                const partial = createPartialRangeMoveCase(
                    target,
                    firstFixedYear,
                    gap,
                );
                const events = diagnose(partial.corrupted);
                return { firstFixedYear, gap, events };
            })
        ));

        expect(rows).toHaveLength(firstFixedYears.length * gapYears.length);
        rows.forEach(({ firstFixedYear, gap, events }) => {
            const matching = events.find((event) => (
                event.eventType === "partialMove"
                && event.shiftYears === -gap
                && event.startYear <= firstFixedYear
                && event.endYear >= firstFixedYear
            ));
            expect(matching, JSON.stringify({
                firstFixedYear,
                gap,
                events: summarize(events),
            })).toBeDefined();
            expect(events.some((event) => event.evidence.algorithmSources.includes(
                "explicit_partial_vs_missing_staircase",
            ))).toBe(false);
        });
    }, 360_000);

    it("keeps a sequential-missing path weaker than genuine physical gaps", () => {
        const effectiveConfig = getConfig({ referenceConfig });
        const rows = [2, 4, 6, 10, 30].map((gapYears) => {
            const partial = createPartialRangeMoveCase(target, 1850, gapYears);
            const site = buildSite(partial.corrupted);
            const core = diagnoseSeriesCore(
                site,
                TARGET_ID,
                effectiveConfig,
                (series) => new Map(cofechaStyleStandardize(series).map(
                    (point) => [point.year, point.value],
                )),
            );
            return {
                gapYears,
                head: core
                    ? locateSequentialMissingHead(
                            core,
                            site,
                            { minLag: effectiveConfig.lagMin },
                            createLagPathCache(),
                        )
                    : null,
            };
        });
        expect(rows).toHaveLength(5);
        expect(rows.every((row) => (
            row.head !== null && row.head.gainOverDirect < 0
        )), JSON.stringify(rows)).toBe(true);
    }, 180_000);

    it("keeps positive staircase and delete counterfactual aligned for two false rings", () => {
        const falseTargetId = "mon151";
        const falseTarget = parsed.get(falseTargetId)!;
        const synthetic = createPiecewiseLagMixedCase(falseTarget, [{
            eventType: "falseRing",
            year: 1685,
            shiftYears: 1,
            falseMode: "moderate",
        }, {
            eventType: "falseRing",
            year: 1694,
            shiftYears: 1,
            falseMode: "moderate",
        }]);
        const site = new Map(cleanSite);
        site.set(falseTargetId, synthetic.corrupted);
        const outText = runBundledCofecha(site);
        const parts = splitReportByParts(outText);
        const targetExcludedFlags = new Set([
            ...extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? ""),
            falseTargetId,
        ]);
        const passReference = createCofechaPassReferenceConfig({
            siteData: site,
            flaggedAIds: targetExcludedFlags,
            cofechaRunId: "co612-double-false-fresh",
            rwlHash: "co612-double-false-fresh",
        });
        const dynamicReference = passReference.cofechaPassReference
            ? passReference
            : createCofechaMasterReferenceConfig({
                    siteData: site,
                    flaggedAIds: targetExcludedFlags,
                    cofechaRunId: "co612-double-false-fresh",
                    rwlHash: "co612-double-false-fresh",
                    masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
                });
        const effectiveConfig = getConfig({ referenceConfig: dynamicReference });
        const core = diagnoseSeriesCore(
            site,
            falseTargetId,
            effectiveConfig,
            (series) => new Map(cofechaStyleStandardize(series).map(
                (point) => [point.year, point.value],
            )),
        );
        const positive = core
            ? locateSequentialFalseHead(
                    core,
                    site,
                    { maxLag: 2 },
                    createLagPathCache(),
                    0,
                )
            : null;
        const negative = core
            ? locateSequentialMissingHead(
                    core,
                    site,
                    { minLag: -2, maxPartialGapYears: 2 },
                    createLagPathCache(),
                    0,
                )
            : null;

        const operationScores = core
            ? scoreJointCounterfactualOperations(core, 20, [-1, 1], 0)
            : [];
        const falseScore = operationScores.find((score) => (
            score.eventType === "falseRing"
        ));
        const missingScore = operationScores.find((score) => (
            score.eventType === "missingRing"
        ));
        const direction = core && positive && negative
            ? compareTwoStepUnitDirections(
                    core,
                    site,
                    positive.year,
                    negative.year,
                    true,
                )
            : null;
        expect(positive, JSON.stringify({ positive, negative })).not.toBeNull();
        expect(positive?.pathStartLag).toBe(2);
        expect(positive?.gainOverDirect ?? 0).toBeGreaterThan(0);
        expect(falseScore?.bestDifferenceGain ?? Number.NEGATIVE_INFINITY)
            .toBeLessThan(missingScore?.bestDifferenceGain ?? Number.NEGATIVE_INFINITY);
        expect(falseScore?.topThreeDifferenceGain ?? Number.NEGATIVE_INFINITY)
            .toBeLessThan(missingScore?.topThreeDifferenceGain ?? Number.NEGATIVE_INFINITY);
        expect(direction).not.toBeNull();
        expect(direction?.masterMargin ?? 0).toBeGreaterThan(0);
        expect(direction?.referenceSupportRatio ?? 0).toBeGreaterThanOrEqual(0.8);
        expect(direction?.referenceMedianMargin ?? 0).toBeGreaterThan(0.02);
        expect(direction?.referenceLowerQuartileMargin ?? 0).toBeGreaterThan(0.005);
        const recovered = diagnoseCrossdating(site, {
            referenceConfig: dynamicReference,
            targetTrees: [falseTargetId],
            cofechaText: outText,
        }).events.find((event) => event.seriesId === falseTargetId);
        expect(recovered, JSON.stringify(summarize(
            recovered ? [recovered] : [],
        ))).toBeDefined();
        expect(recovered?.eventType).toBe("falseRing");
        expect(recovered?.evidence.algorithmSources)
            .toContain("sequential_false_staircase_head");
        expect(recovered?.startYear).toBeLessThanOrEqual(1694);
        expect(recovered?.endYear).toBeGreaterThanOrEqual(1694);
    }, 180_000);

    it("audits sequential-missing evidence on the clean file", () => {
        const effectiveConfig = getConfig({ referenceConfig });
        const rows = Array.from(parsed).map(([seriesId]) => {
            const core = diagnoseSeriesCore(
                cleanSite,
                seriesId,
                effectiveConfig,
                (series) => new Map(cofechaStyleStandardize(series).map(
                    (point) => [point.year, point.value],
                )),
            );
            const head = core
                ? locateSequentialMissingHead(
                        core,
                        cleanSite,
                        { minLag: effectiveConfig.lagMin },
                        createLagPathCache(),
                    )
                : null;
            return { seriesId, head };
        });
        expect(rows).toHaveLength(parsed.size);
        const flagged = new Set(
            referenceConfig.classification?.candidateFlaggedIds.map(
                (seriesId) => seriesId.toLowerCase(),
            ) ?? [],
        );
        expect(rows.filter((row) => (
            flagged.has(row.seriesId.toLowerCase())
            && (row.head?.gainOverDirect ?? 0) > 0
        ))).toEqual([]);
    }, 180_000);
});
