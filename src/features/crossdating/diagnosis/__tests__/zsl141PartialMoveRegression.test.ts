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
import { createCofechaMasterReferenceConfig } from "@/features/crossdating/reference";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData } from "@/features/rwl/types";
import { parseCofechaHints } from "../cofechaHints";
import { diagnoseCrossdating } from "../engine";
import type { DiagnosisEvent } from "../types";
import {
    buildSyntheticSite,
    createPartialRangeMoveCase,
    loadCofechaOut,
    loadDataFolder,
} from "./rdmFixture";

const TARGET_ID = "ZSL141";
const FIRST_FIXED_YEAR = 1975;
const SHIFT_YEARS = -6;
const COFECHA_EXE = fileURLToPath(new URL(
    "../../../../../src-tauri/bin/cofecha-x86_64-pc-windows-msvc.exe",
    import.meta.url,
));

const COFECHA_MINUS_SIX = `
 ZSL141    1912 to  2023     112 years                                                                                    Series  27

 [A] Segment   High   -10   -9   -8   -7   -6   -5   -4   -3   -2   -1   +0   +1   +2   +3   +4   +5   +6   +7   +8   +9  +10
 ---------  ----   ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---
 1912 1961   -6   -.29  .05 -.10  .39  .65* .07 -.11 -.22  .03 -.22  .01| .00 -.17 -.03 -.08  .17 -.03  .11 -.09  .05  .21
 1925 1974   -6   -.27 -.02  .09  .40  .67*-.03  .02 -.21 -.07 -.27  .00| .04 -.11 -.01 -.15  .03  .15  .20 -.03 -.11  .05
`;

const COFECHA_PLUS_SIX = `
 ZSL141    1912 to  2023     112 years                                                                                    Series  27

 [A] Segment   High   -10   -9   -8   -7   -6   -5   -4   -3   -2   -1   +0   +1   +2   +3   +4   +5   +6   +7   +8   +9  +10
 ---------  ----   ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---  ---
 1925 1974   +6    .01  .02  .03  .04  .05  .06  .07  .08  .09  .10  .11| .12  .13  .14  .15  .16  .65* .18  .19  .20  .21
`;

const summarize = (events: readonly DiagnosisEvent[]) => events.map((event) => ({
    type: event.eventType,
    shiftYears: event.shiftYears,
    range: [event.startYear, event.endYear],
    topYear: event.rankedYears[0]?.year,
    sources: event.evidence.algorithmSources,
    notes: event.evidence.notes,
}));

const runBundledCofecha = (site: RwlSiteData): string => {
    const workDir = mkdtempSync(join(tmpdir(), "zsl141-save-regression-"));
    try {
        writeFileSync(join(workDir, "INPUT.RWL"), formatTucson(site, false), "utf8");
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

const loaded = loadDataFolder("ZSL");
const regressionDescribe = loaded ? describe : describe.skip;

regressionDescribe("ZSL141 arbitrary-year six-ring partial gap", () => {
    const target = loaded!.crossdated.get(TARGET_ID)!;
    const corrupted = createPartialRangeMoveCase(
        target,
        FIRST_FIXED_YEAR,
        Math.abs(SHIFT_YEARS),
    ).corrupted;
    const built = buildSyntheticSite(loaded!.crossdated, TARGET_ID, corrupted);

    it.each([
        ["without COFECHA", undefined],
        ["with fresh COFECHA -6 evidence", COFECHA_MINUS_SIX],
    ] as const)("returns the exact operation %s", (_, cofechaText) => {
        expect(built.site).not.toBeNull();
        expect(Math.min(...corrupted.keys())).toBe(1912);
        expect(Math.max(...corrupted.keys())).toBe(2023);

        const diagnosis = diagnoseCrossdating(built.site!, {
            targetTrees: [TARGET_ID],
            cofechaText,
        });
        const partial = diagnosis.events.find((event) => (
            event.eventType === "partialMove"
            && event.shiftYears === SHIFT_YEARS
        ));
        const summary = JSON.stringify(summarize(diagnosis.events));

        expect(partial, summary).toBeDefined();
        expect(partial!.startYear, summary).toBeLessThanOrEqual(FIRST_FIXED_YEAR);
        expect(partial!.endYear, summary).toBeGreaterThanOrEqual(FIRST_FIXED_YEAR);
        expect(partial!.rankedYears[0]?.year, summary).toBe(FIRST_FIXED_YEAR);
        expect(diagnosis.events.some((event) => (
            event.eventType === "missingRing"
            || event.eventType === "falseRing"
        )), summary).toBe(false);

        if (cofechaText) {
            const cofechaCandidates = diagnosis.candidates.filter((candidate) => (
                candidate.algorithmSource.includes("cofecha_segment_lag")
            ));
            expect(cofechaCandidates.some((candidate) => (
                candidate.operationType === "SHIFT_RANGE"
                && candidate.mode === "partialRangeMove"
                && candidate.deltaYears === SHIFT_YEARS
                && candidate.anchorYear === FIRST_FIXED_YEAR
                && candidate.selectedRange?.endYear === FIRST_FIXED_YEAR - 1
            )), JSON.stringify(cofechaCandidates)).toBe(true);
            expect(cofechaCandidates.some((candidate) => (
                candidate.operationType === "INSERT_MISSING_RING"
                || candidate.operationType === "DELETE_FALSE_RING"
            )), JSON.stringify(cofechaCandidates)).toBe(false);
        }
    });

    it("does not convert a positive multi-year lag into an automatic edit", () => {
        const diagnosis = diagnoseCrossdating(built.site!, {
            targetTrees: [TARGET_ID],
            cofechaText: COFECHA_PLUS_SIX,
        });
        const cofechaCandidates = diagnosis.candidates.filter((candidate) => (
            candidate.algorithmSource.includes("cofecha_segment_lag")
        ));

        expect(cofechaCandidates).toEqual([]);
        expect(diagnosis.events.every((event) => (
            event.eventType !== "partialMove" || (event.shiftYears ?? 0) < -1
        ))).toBe(true);
    });

    it("keeps the -6 operation after switching to a fresh dynamic reference", () => {
        const cleanOut = loadCofechaOut("ZSL", "crossdated");
        expect(cleanOut).not.toBeNull();
        const referenceConfig = createCofechaMasterReferenceConfig({
            siteData: built.site!,
            flaggedAIds: [TARGET_ID],
            cofechaRunId: "zsl141-minus-six",
            rwlHash: "zsl141-minus-six",
            masterDatingSeries: parseCofechaResult(cleanOut!).masterDatingSeries,
        });
        const diagnosis = diagnoseCrossdating(built.site!, {
            targetTrees: [TARGET_ID],
            referenceConfig,
            cofechaText: COFECHA_MINUS_SIX,
        });
        const partial = diagnosis.events.find((event) => (
            event.eventType === "partialMove"
            && event.shiftYears === SHIFT_YEARS
        ));
        const summary = JSON.stringify(summarize(diagnosis.events));

        expect(referenceConfig.mode).toBe("dynamic");
        expect(referenceConfig.classification?.candidateFlaggedIds)
            .toContain(TARGET_ID);
        expect(partial, summary).toBeDefined();
        expect(partial!.rankedYears[0]?.year, summary).toBe(FIRST_FIXED_YEAR);
        expect(diagnosis.events.some((event) => (
            event.eventType === "missingRing"
            || event.eventType === "falseRing"
        )), summary).toBe(false);
    });

    it("does not report a large partial move after ZSL141 is correctly dated", () => {
        const cleanOut = loadCofechaOut("ZSL", "crossdated");
        const cleanBuilt = buildSyntheticSite(
            loaded!.crossdated,
            TARGET_ID,
            target.valuesByYear,
        );
        expect(cleanOut).not.toBeNull();
        expect(cleanBuilt.site).not.toBeNull();
        const flaggedAIds = Array.from(new Set(
            parseCofechaHints(cleanOut!).segments
                .map((segment) => segment.seriesId)
                .filter((seriesId): seriesId is string => seriesId !== null),
        ));
        const referenceConfig = createCofechaMasterReferenceConfig({
            siteData: cleanBuilt.site!,
            flaggedAIds,
            cofechaRunId: "zsl141-clean",
            rwlHash: "zsl141-clean",
            masterDatingSeries: parseCofechaResult(cleanOut!).masterDatingSeries,
        });
        const diagnosis = diagnoseCrossdating(cleanBuilt.site!, {
            targetTrees: [TARGET_ID],
            referenceConfig,
            cofechaText: cleanOut!,
        });

        expect(diagnosis.events.some((event) => (
            event.eventType === "partialMove"
        )), JSON.stringify(summarize(diagnosis.events))).toBe(false);
    });

    const saveRegressionIt = process.platform === "win32" && existsSync(COFECHA_EXE)
        ? it
        : it.skip;

    saveRegressionIt.each([
        [11, 1975, false],
        [16, 1975, false],
        [20, 1975, false],
        [30, 1995, true],
    ] as const)("keeps a -%i partial move after the real save cycle", (
        gapYears,
        firstFixedYear,
        expectUnitLagAlias,
    ) => {
        const cleanOut = loadCofechaOut("ZSL", "crossdated");
        expect(cleanOut).not.toBeNull();
        const cleanSite: RwlSiteData = new Map(
            Array.from(loaded!.crossdated.entries()).map(([seriesId, series]) => (
                [seriesId, new Map(series.valuesByYear)]
            )),
        );
        const cleanReference = createCofechaMasterReferenceConfig({
            siteData: cleanSite,
            flaggedAIds: extractPart6FlaggedASeriesIds(
                splitReportByParts(cleanOut!).get("PART 6") ?? "",
            ),
            cofechaRunId: "zsl141-before-save-clean-reference",
            rwlHash: "zsl141-before-save-clean-reference",
            masterDatingSeries: parseCofechaResult(cleanOut!).masterDatingSeries,
        });
        const saveCorrupted = createPartialRangeMoveCase(
            target,
            firstFixedYear,
            gapYears,
        ).corrupted;
        const fullSite: RwlSiteData = new Map(
            Array.from(loaded!.crossdated.entries()).map(([seriesId, series]) => (
                [seriesId, new Map(series.valuesByYear)]
            )),
        );
        fullSite.set(TARGET_ID, new Map(saveCorrupted));

        const before = diagnoseCrossdating(fullSite, {
            targetTrees: [TARGET_ID],
            referenceConfig: cleanReference,
        });
        const beforePartial = before.events.find((event) => (
            event.eventType === "partialMove"
            && event.shiftYears === -gapYears
        ));
        const beforeSummary = JSON.stringify(summarize(before.events));
        expect(beforePartial, beforeSummary).toBeDefined();
        expect(beforePartial!.startYear, beforeSummary)
            .toBeLessThanOrEqual(firstFixedYear);
        expect(beforePartial!.endYear, beforeSummary)
            .toBeGreaterThanOrEqual(firstFixedYear);

        const outText = runBundledCofecha(fullSite);
        const parts = splitReportByParts(outText);
        const result = parseCofechaResult(outText);
        const flaggedAIds = extractPart6FlaggedASeriesIds(
            parts.get("PART 6") ?? "",
        );
        const zslSegments = parseCofechaHints(outText).segments.filter(
            (segment) => segment.seriesId === TARGET_ID,
        );
        expect(flaggedAIds).toContain(TARGET_ID);
        if (expectUnitLagAlias) {
            expect(zslSegments.some((segment) => (
                Math.abs(segment.highLag) === 1
            ))).toBe(true);
        }

        const savedReference = createCofechaMasterReferenceConfig({
            siteData: fullSite,
            flaggedAIds,
            cofechaRunId: `zsl141-save-${firstFixedYear}-${gapYears}`,
            rwlHash: `zsl141-save-${firstFixedYear}-${gapYears}`,
            masterDatingSeries: result.masterDatingSeries,
        });
        const after = diagnoseCrossdating(fullSite, {
            targetTrees: [TARGET_ID],
            referenceConfig: savedReference,
            cofechaText: outText,
        });
        const afterPartial = after.events.find((event) => (
            event.eventType === "partialMove"
            && event.shiftYears === -gapYears
        ));
        const afterSummary = JSON.stringify(summarize(after.events));

        expect(afterPartial, afterSummary).toBeDefined();
        expect(afterPartial!.startYear, afterSummary)
            .toBeLessThanOrEqual(firstFixedYear);
        expect(afterPartial!.endYear, afterSummary)
            .toBeGreaterThanOrEqual(firstFixedYear);
        expect(afterPartial!.endYear - afterPartial!.startYear + 1, afterSummary)
            .toBeLessThanOrEqual(13);
        expect(after.events.some((event) => (
            event.eventType === "missingRing"
            || event.eventType === "falseRing"
        )), afterSummary).toBe(false);
        expect(after.events.some((event) => (
            event.eventType === "partialMove"
            && event.shiftYears !== -gapYears
        )), afterSummary).toBe(false);
    }, 60_000);
});
