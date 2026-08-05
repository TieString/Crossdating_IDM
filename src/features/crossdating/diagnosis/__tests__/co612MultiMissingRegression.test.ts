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
import { createCofechaMasterReferenceConfig } from "@/features/crossdating/reference";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData } from "@/features/rwl/types";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis";
import { getConfig } from "@/features/crossdating/diagnosis/config";
import {
    createLagPathCache,
    locateSequentialMissingHead,
} from "@/features/crossdating/diagnosis/eventPath";
import { diagnoseSeriesCore } from "@/features/crossdating/diagnosis/segments";
import { cofechaStyleStandardize } from "@/features/crossdating/reference";
import type { DiagnosisEvent } from "../types";
import {
    applyInsertRestore,
    buildMultiMissingCorrupted,
    createPartialRangeMoveCase,
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
    1873,
    1879,
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

    it("shows only the newest missing ring for the fully undated sequence", () => {
        const corrupted = buildMultiMissingCorrupted(
            target.valuesByYear,
            zeroYears,
        );
        const diagnosis = runDiagnosis(corrupted);
        const [event] = diagnosis.events;

        expect(diagnosis.events, JSON.stringify(summarize(diagnosis.events)))
            .toHaveLength(1);
        expect(event.eventType).toBe("missingRing");
        expect(event.startYear).toBeLessThanOrEqual(1977);
        expect(event.endYear).toBeGreaterThanOrEqual(1977);
        expect(event.rankedYears[0]?.year).toBe(1977);
        expect(event.evidence.algorithmSources)
            .toContain("sequential_unit_chain_projection");
    }, 180_000);

    it("reveals all nine missing rings from bark to pith", () => {
        let corrupted = buildMultiMissingCorrupted(
            target.valuesByYear,
            zeroYears,
        );
        const steps: Array<{
            truthYear: number;
            events: ReturnType<typeof summarize>;
        }> = [];

        zeroYears.slice().reverse().forEach((truthYear) => {
            const events = diagnose(corrupted);
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
        expect(steps[2]?.events[0]?.sources, JSON.stringify(steps))
            .toContain("sequential_missing_staircase_head");

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
