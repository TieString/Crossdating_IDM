import { describe, expect, it } from "vitest";
import {
    extractPart6FlaggedASeriesIds,
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import {
    createCofechaMasterReferenceConfig,
    createReferenceSeriesConfig,
} from "@/features/crossdating/reference";
import type { RwlSiteData } from "@/features/rwl/types";
import { getDisplayedDiagnosisEvents } from "@/features/crossdating/diagnosis";
import { getConfig } from "../config";
import { diagnoseCrossdating } from "../engine";
import {
    hasDecisiveNewerSideFixedEvidence,
    scoreNewerSideEndpointOperationContrast,
} from "../endpointOperationContrast";
import { preprocessSeries } from "../series";
import { diagnoseSeriesCore } from "../segments";
import {
    loadCofechaOut,
    loadDataFolder,
    type RwlSeries,
} from "./rdmFixture";

const loaded = loadDataFolder("ZSL");
const rawOut = loadCofechaOut("ZSL", "RAW");
const fixtureDescribe = loaded && rawOut ? describe : describe.skip;

const toSite = (series: Map<string, RwlSeries>): RwlSiteData => new Map(
    Array.from(series, ([seriesId, value]) => [
        seriesId,
        new Map(value.valuesByYear),
    ]),
);

const PURE_WHOLE_CASES = [
    ["ZSL091", -9],
    ["ZSL092", -6],
    ["ZSL111", -21],
    ["ZSL112", -24],
] as const;

fixtureDescribe("ZSL RAW/crossdated operation-type regression", () => {
    const rawSite = toSite(loaded!.raw);
    const crossdatedSite = toSite(loaded!.crossdated);
    const sharedIds = [...loaded!.crossdated.keys()].sort();
    const rawReference = createCofechaMasterReferenceConfig({
        siteData: rawSite,
        flaggedAIds: extractPart6FlaggedASeriesIds(
            splitReportByParts(rawOut!).get("PART 6") ?? "",
        ),
        cofechaRunId: "zsl-operation-type-raw",
        rwlHash: "zsl-operation-type-raw",
        masterDatingSeries: parseCofechaResult(rawOut!).masterDatingSeries,
    });

    it.each(PURE_WHOLE_CASES)(
        "keeps real RAW whole move %s at shift %i with a clean reference",
        (seriesId, shiftYears) => {
            const site = new Map(crossdatedSite);
            site.set(seriesId, new Map(loaded!.raw.get(seriesId)!.valuesByYear));
            const diagnosis = diagnoseCrossdating(site, {
                targetTrees: [seriesId],
                referenceConfig: createReferenceSeriesConfig(
                    sharedIds.filter((candidate) => candidate !== seriesId),
                ),
                cofechaText: rawOut!,
                reviewWindowDisplayMode: "review",
            });
            const displayed = getDisplayedDiagnosisEvents(diagnosis);

            expect(displayed).toHaveLength(1);
            expect(displayed[0].eventType).toBe("wholeSeriesMove");
            expect(displayed[0].evidence.lagBefore).toBe(shiftYears);
        },
    );

    it.each(PURE_WHOLE_CASES)(
        "does not collapse RAW dynamic whole move %s into a local event",
        (seriesId, shiftYears) => {
            const diagnosis = diagnoseCrossdating(rawSite, {
                targetTrees: [seriesId],
                referenceConfig: rawReference,
                cofechaText: rawOut!,
                reviewWindowDisplayMode: "review",
            });
            const displayed = getDisplayedDiagnosisEvents(diagnosis);

            expect(displayed).toHaveLength(1);
            expect(displayed[0].eventType).toBe("wholeSeriesMove");
            expect(displayed[0].evidence.lagBefore).toBe(shiftYears);
        },
    );

    it("finds the current ZSL212 -4 partial without injecting an obsolete whole offset", () => {
        const site = new Map(crossdatedSite);
        site.set("ZSL212", new Map(loaded!.raw.get("ZSL212")!.valuesByYear));
        const diagnosis = diagnoseCrossdating(site, {
            targetTrees: ["ZSL212"],
            referenceConfig: createReferenceSeriesConfig(
                sharedIds.filter((candidate) => candidate !== "ZSL212"),
            ),
            reviewWindowDisplayMode: "review",
        });
        const displayed = getDisplayedDiagnosisEvents(diagnosis);
        const summary = JSON.stringify({
            strict: diagnosis.events.map((event) => ({
                type: event.eventType,
                shift: event.shiftYears,
                range: [event.startYear, event.endYear],
                top: event.rankedYears[0]?.year,
                lag: [event.evidence.lagBefore, event.evidence.lagAfter],
                sources: event.evidence.algorithmSources,
                notes: event.evidence.notes,
            })),
            review: diagnosis.reviewWindowDecisions,
            candidates: diagnosis.candidates.map((candidate) => ({
                type: candidate.operationType,
                delta: candidate.deltaYears,
                anchor: candidate.anchorYear,
                score: candidate.score,
            })),
        });

        expect(displayed, summary).toHaveLength(1);
        expect(displayed[0].eventType).toBe("partialMove");
        expect(displayed[0].shiftYears).toBe(-4);
        expect(displayed[0].startYear).toBeLessThanOrEqual(1870);
        expect(displayed[0].endYear).toBeGreaterThanOrEqual(1870);
    });

    it("keeps the real ZSL152 false ring distinct from missing-ring evidence", () => {
        const site = new Map(crossdatedSite);
        site.set("ZSL152", new Map(loaded!.raw.get("ZSL152")!.valuesByYear));
        const diagnosis = diagnoseCrossdating(site, {
            targetTrees: ["ZSL152"],
            referenceConfig: createReferenceSeriesConfig(
                sharedIds.filter((candidate) => candidate !== "ZSL152"),
            ),
            cofechaText: rawOut!,
            reviewWindowDisplayMode: "review",
        });
        const displayed = getDisplayedDiagnosisEvents(diagnosis);

        expect(displayed).toHaveLength(1);
        expect(displayed[0].eventType).toBe("falseRing");
        expect(displayed[0].startYear).toBeLessThanOrEqual(2007);
        expect(displayed[0].endYear).toBeGreaterThanOrEqual(2007);
    });

    it("does not let a RAW-dynamic missing staircase overwrite ZSL152 false ring", () => {
        const diagnosis = diagnoseCrossdating(rawSite, {
            targetTrees: ["ZSL152"],
            referenceConfig: rawReference,
            cofechaText: rawOut!,
            reviewWindowDisplayMode: "review",
        });
        const displayed = getDisplayedDiagnosisEvents(diagnosis);

        expect(displayed).toHaveLength(1);
        expect(displayed[0].eventType).toBe("falseRing");
    });

    it("keeps newer-side lag-zero evidence for the ZSL182 endpoint missing ring", () => {
        const diagnosis = diagnoseCrossdating(rawSite, {
            targetTrees: ["ZSL182"],
            referenceConfig: rawReference,
            cofechaText: rawOut!,
            reviewWindowDisplayMode: "review",
        });
        const whole = diagnosis.events.find((event) => (
            event.eventType === "wholeSeriesMove"
        ));
        const unit = diagnosis.events.find((event) => (
            event.eventType === "missingRing"
        ));
        const core = diagnoseSeriesCore(
            rawSite,
            "ZSL182",
            getConfig({ referenceConfig: rawReference }),
            preprocessSeries,
        );
        expect(whole).toBeDefined();
        expect(unit).toBeDefined();
        expect(core).not.toBeNull();
        const contrast = scoreNewerSideEndpointOperationContrast(
            core!,
            rawSite,
            whole!,
            unit!,
        );
        expect(contrast).not.toBeNull();
        expect(hasDecisiveNewerSideFixedEvidence(contrast!)).toBe(true);
        expect(contrast!.positiveReferenceFraction).toBeGreaterThanOrEqual(0.9);
        const [displayed] = getDisplayedDiagnosisEvents(diagnosis);
        expect(displayed.eventType).toBe("missingRing");
        expect(displayed.startYear).toBeLessThanOrEqual(2015);
        expect(displayed.endYear).toBeGreaterThanOrEqual(2015);
    });
});
