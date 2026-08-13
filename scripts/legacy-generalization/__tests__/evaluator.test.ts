import { describe, expect, it } from "vitest";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis/types";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    applyConfirmedEvent,
    buildScenarioSite,
    canonicalSnapshot,
    createProductionReferenceForEvaluation,
    isResumableCompletedStage,
    matchTruthAfterDiagnosis,
    readRwlForEvaluation,
    siteHash,
    snapshotsSemanticallyEqual,
} from "../evaluator";
import type {
    LegacyDiagnosisSnapshot,
    LegacyScenarioPlan,
    LegacyTruthSpec,
} from "../types";
import type { RwlSeries } from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

const series = (
    id: string,
    startYear = 1800,
    endYear = 2024,
): RwlSeries => {
    const valuesByYear = new Map<number, number>();
    for (let year = startYear; year <= endYear; year += 1) {
        valuesByYear.set(year, 100 + ((year * 37) % 701));
    }
    return {
        id,
        valuesByYear,
        startYear,
        endYear,
        length: valuesByYear.size,
        nonZeroCount: valuesByYear.size,
        zeroCount: 0,
    };
};

const truth = (
    eventType: LegacyTruthSpec["eventType"],
    year: number | null,
    shiftYears: number,
): LegacyTruthSpec => ({
    truthId: `TARGET:${eventType}:${year ?? "whole"}`,
    eventType,
    year,
    shiftYears,
    observationId: `TARGET:${year ?? "whole"}:frozen`,
});

const scenario = (
    kind: string,
    truths: LegacyTruthSpec[],
): LegacyScenarioPlan => ({
    scenarioId: `fixture:TARGET:${kind}`,
    kind,
    truthQuality: "exact-injected",
    eventComplexity: "test",
    targetId: "TARGET",
    saveReopenPair: true,
    truths,
    parameters: {},
});

const event = (
    eventType: DiagnosisEvent["eventType"],
    year: number,
    shiftYears: number,
): DiagnosisEvent => ({
    id: `event-${eventType}-${year}`,
    seriesId: "TARGET",
    eventType,
    startYear: year - 2,
    endYear: year + 2,
    rankedYears: [{ year, rank: 1, score: 1, evidenceTags: [] }],
    confidenceLevel: "high",
    evidence: {
        algorithmSources: ["test"],
        score: 1,
        scoreMargin: 0.2,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.6,
        correlationGain: 0.4,
        lagBefore: shiftYears,
        lagAfter: 0,
        samplePairs: 80,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
    ...(eventType === "partialMove" || eventType === "wholeSeriesMove"
        ? { shiftYears, shiftSide: "older" as const }
        : {}),
});

const snapshot = (candidateScore: number): LegacyDiagnosisSnapshot => ({
    strictEvent: event("missingRing", 1900, -1),
    reviewEvent: event("missingRing", 1900, -1),
    candidates: [{ score: candidateScore, operationType: "INSERT_MISSING_RING" }],
    audit: null,
    reviewDecision: null,
    operationGrid: null,
    referenceMode: "cofecha-pass-leave-one-out",
    referenceAnchorCount: 4,
    durationMs: 123,
    error: null,
});

describe("Legacy generalization evaluator isolation", () => {
    it("mirrors production COFECHA-master selection when pass anchors are usable", () => {
        const site = new Map(Array.from({ length: 5 }, (_, index) => {
            const item = series(`anchor${index + 1}`);
            return [item.id, item.valuesByYear] as const;
        }));
        const result = createProductionReferenceForEvaluation({
            siteData: site,
            targetId: "anchor1",
            flaggedAIds: [],
            cofechaRunId: "master-run",
            rwlHash: "master-hash",
            masterDatingSeries: new Map(Array.from({ length: 225 }, (_, index) => (
                [1800 + index, Math.sin(index / 7)]
            ))),
        });

        expect(result.referenceMode).toBe("cofecha-master");
        expect(result.referenceConfig.cofechaPassReference?.source)
            .toBe("cofecha_master_series");
        expect(result.referenceConfig.cofechaPassReference?.includedSeriesIds)
            .toContain("anchor1");
    });

    it("uses target-excluded pairwise bootstrap for an all-flagged cold start", () => {
        const base = series("base").valuesByYear;
        const site = new Map(Array.from({ length: 6 }, (_, index) => [
            `anchor${index + 1}`,
            new Map(Array.from(base, ([year, value]) => [
                year,
                value + ((year + index * 3) % 7) - 3,
            ])),
        ]));
        const result = createProductionReferenceForEvaluation({
            siteData: site,
            targetId: "anchor1",
            flaggedAIds: site.keys(),
            cofechaRunId: "cold-start",
            rwlHash: "cold-hash",
            masterDatingSeries: new Map(),
        });

        expect(result.referenceMode).toBe("pairwise-bootstrap-target-excluded");
        expect(result.referenceConfig.cofechaPassReference?.source)
            .toBe("pairwise_bootstrap");
        expect(result.referenceConfig.cofechaPassReference?.includedSeriesIds)
            .not.toContain("anchor1");
        expect(result.referenceConfig.cofechaPassReference?.includedSeriesIds)
            .toHaveLength(5);
    });

    it("honors a frozen Tucson declaration when header text contains commas", async () => {
        const source = [
            "540    1 Lofoten, Loedingen WIDTH_EARLY PISY -",
            "540    2 Norway   Scots pine, Scotch pine 200  6829-1602 1485 1978 -",
            "540    3 FRITZ SCHWEINGRUBER -",
            "540011  1721    65    75    39    66    76    67    82    60    88",
        ].join("\n");

        const parsed = await readRwlForEvaluation(source, "tucson-auto");

        expect(parsed.format).toBe("tucson");
        expect(parsed.data.get("540011")?.get(1721)).toBe(65);
        expect(parsed.data.size).toBe(1);
    });

    it("does not resume past an explicitly failed gate checkpoint", () => {
        expect(isResumableCompletedStage({ stage: "gate", passed: false })).toBe(false);
        expect(isResumableCompletedStage({ stage: "gate", passed: true })).toBe(true);
        expect(isResumableCompletedStage({ stage: "worker", files: 3 })).toBe(true);
        expect(isResumableCompletedStage(null)).toBe(false);
    });

    it("builds a partial-gap copy without mutating the clean target or references", () => {
        const target = series("TARGET");
        const reference = series("REFERENCE");
        const cleanSite: RwlSiteData = new Map([
            [target.id, new Map(target.valuesByYear)],
            [reference.id, new Map(reference.valuesByYear)],
        ]);
        const cleanHash = siteHash(cleanSite);
        const referenceHash = siteHash(new Map([
            [reference.id, new Map(reference.valuesByYear)],
        ]));
        const partialTruth = truth("partialMove", 1904, -4);

        const corrupted = buildScenarioSite(
            cleanSite,
            new Map([[target.id, target], [reference.id, reference]]),
            scenario("singlePartialMove", [partialTruth]),
        );

        expect(siteHash(cleanSite)).toBe(cleanHash);
        expect(corrupted).not.toBe(cleanSite);
        expect(corrupted.get("TARGET")).not.toBe(cleanSite.get("TARGET"));
        expect(siteHash(new Map([
            [reference.id, corrupted.get(reference.id)!],
        ]))).toBe(referenceHash);
        expect(corrupted.get("TARGET")?.get(1904)).toBe(
            cleanSite.get("TARGET")?.get(1904),
        );
        expect(corrupted.get("TARGET")?.get(1903)).toBe(
            cleanSite.get("TARGET")?.get(1899),
        );
    });

    it("applies firstFixedYear partial semantics without touching the fixed side", () => {
        const target = series("TARGET");
        const cleanSite: RwlSiteData = new Map([
            [target.id, new Map(target.valuesByYear)],
        ]);
        const partialTruth = truth("partialMove", 1904, -4);
        const corrupted = buildScenarioSite(
            cleanSite,
            new Map([[target.id, target]]),
            scenario("singlePartialMove", [partialTruth]),
        );
        const fixedBefore = new Map(Array.from(corrupted.get("TARGET")!).filter(
            ([year]) => year >= 1904,
        ));

        expect(applyConfirmedEvent(
            corrupted,
            event("partialMove", 1904, -4),
            partialTruth,
        )).toEqual({ applied: true, reason: null });

        const applied = corrupted.get("TARGET")!;
        expect(Math.min(...applied.keys())).toBe(1800);
        expect(applied.has(1900)).toBe(false);
        expect(applied.has(1901)).toBe(false);
        expect(applied.has(1902)).toBe(false);
        expect(applied.has(1903)).toBe(false);
        expect(new Map(Array.from(applied).filter(([year]) => year >= 1904)))
            .toEqual(fixedBefore);
        for (let year = 1800; year <= 1899; year += 1) {
            expect(applied.get(year)).toBe(target.valuesByYear.get(year));
        }
    });

    it("matches only the same operation and nearest truth without changing rank input", () => {
        const truths = [
            truth("missingRing", 1880, -1),
            truth("missingRing", 1900, -1),
            truth("falseRing", 1900, 1),
        ];
        const prediction = event("missingRing", 1898, -1);

        expect(matchTruthAfterDiagnosis(prediction, truths)?.year).toBe(1900);
        expect(prediction.rankedYears[0]?.year).toBe(1898);
        expect(matchTruthAfterDiagnosis(
            event("partialMove", 1900, -4),
            truths,
        )).toBeNull();
    });

    it("ignores runtime and sub-floating-point formatting noise in semantic snapshots", () => {
        const left = snapshot(0.123456789012344);
        const right = {
            ...snapshot(0.123456789012346),
            durationMs: 9999,
        };

        expect(snapshotsSemanticallyEqual(left, right)).toBe(true);
        expect(canonicalSnapshot(left)).toEqual(canonicalSnapshot(right));
        expect(snapshotsSemanticallyEqual(left, snapshot(0.1234567899))).toBe(false);
    });
});
