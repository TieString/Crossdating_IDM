/**
 * COFECHA 输出解析与诊断隔离测试。
 *
 * 用仓库内真实 COFECHA 输出 笔记/数据/EBD/RAW.OUT（对应 EBD/RAW.rwl）验证：
 * [A] 段仍可供报告展示和独立解析，但不得生成、评分或改写自动诊断操作。
 * COFECHA master 与 pass 分类通过 referenceConfig 单独进入生产流程。数据缺失则 skip。
 */
import { describe, expect, it } from "vitest";
import {
    diagnoseCrossdating,
    limitRankedCandidatesForEventDetection,
} from "../engine";
import {
    getCofechaTerminalLagEstimate,
    getNewestFlaggedCofechaSegment,
    parseCofechaHints,
    type CofechaHints,
} from "../cofechaHints";
import {
    shouldSuppressAliasedCofechaUnitDraft,
    terminalResidualPatternSupport,
} from "../drafts";
import {
    pathFixedSideWholeCompositionGatePassed,
    recentTailGlobalAgreementGatePassed,
    recentTailResidualPartialGatePassed,
    terminalWholeCompositionGatePassed,
} from "../evaluation";
import {
    isValidatedPathFixedSideWholeCandidate,
    isValidatedTerminalWholeCandidate,
    selectWholeSeriesCandidate,
} from "../events";
import type { RwlSiteData } from "@/features/rwl/types";
import type { DiagnosisCandidateOperation, PropagationPattern } from "../types";
import {
    dataFoldersAvailable,
    loadCofechaOut,
    loadDataFolder,
    seriesToTreeData,
} from "./rdmFixture";

const hasData = dataFoldersAvailable() && loadCofechaOut("EBD") !== null;
const d = hasData ? describe : describe.skip;

describe("COFECHA unit-lag alias guard", () => {
    it("suppresses a unit hint when the newer side proves a long physical gap", () => {
        expect(shouldSuppressAliasedCofechaUnitDraft({
            regionLagMagnitude: 1,
            globalLag: -30,
            globalGain: 0.126,
            newerAtZero: 0.61,
            newerAtGlobal: 0.08,
        })).toBe(true);
    });

    it.each([
        ["true whole-series move", -30, 0.126, 0.08, 0.61],
        ["ordinary one-year event", -1, 0.126, 0.61, 0.08],
        ["weak global alternative", -30, 0.04, 0.61, 0.08],
    ] as const)("keeps the COFECHA draft for a %s", (
        _,
        globalLag,
        globalGain,
        newerAtZero,
        newerAtGlobal,
    ) => {
        expect(shouldSuppressAliasedCofechaUnitDraft({
            regionLagMagnitude: 1,
            globalLag,
            globalGain,
            newerAtZero,
            newerAtGlobal,
        })).toBe(false);
    });
});

describe("COFECHA terminal whole baseline", () => {
    const pattern = (
        dominantLag: number,
        confidence = 0.8,
        segmentCount = 3,
    ) => ({
        dominantLag,
        confidence,
        affectedSegments: Array.from({ length: segmentCount }, (_, index) => ({
            startYear: 1800 + index * 25,
            endYear: 1849 + index * 25,
            flag: "B_like" as const,
        })),
    } as PropagationPattern);

    const hints = (
        rows: Array<[number, number, number, number, number?]>,
    ): CofechaHints => ({
        segments: rows.map(([startYear, endYear, highLag, r, asDatedR]) => {
            const correlationsByLag: Record<number, number> = { [highLag]: r };
            if (asDatedR !== undefined) correlationsByLag[0] = asDatedR;
            return {
                seriesId: "TARGET",
                startYear,
                endYear,
                highLag,
                correlationsByLag,
                starredLag: highLag,
                starredR: r,
            };
        }),
        effects: [],
        yearToYear: [],
        outliers: [],
    });

    it("uses the stable non-zero state that reaches the newer endpoint", () => {
        const estimate = getCofechaTerminalLagEstimate(hints([
            [1800, 1849, -4, 0.91],
            [1875, 1924, -4, 0.89],
            [1925, 1974, -5, 0.91],
            [1950, 1999, -5, 0.94],
            [1953, 2002, -5, 0.92],
        ]), "TARGET", 2005);

        expect(estimate).toMatchObject({
            lag: -5,
            segmentCount: 3,
            terminalEndYear: 2002,
            unmatchedTailYears: 3,
        });
    });

    it("does not turn an older local-event state into a terminal baseline", () => {
        expect(getCofechaTerminalLagEstimate(hints([
            [1800, 1849, 1, 0.91],
            [1875, 1924, 1, 0.88],
            [1900, 1949, 1, 0.45],
        ]), "TARGET", 2000)).toBeNull();
    });

    it("allows one strong endpoint row for the later joint-composition gate", () => {
        const source = hints([
            [1900, 1949, 6, 0.86],
            [1925, 1974, 6, 0.63],
            [1948, 1997, 5, 0.54, 0.10],
        ]);
        expect(getCofechaTerminalLagEstimate(
            source,
            "TARGET",
            1997,
        )).toBeNull();
        expect(getCofechaTerminalLagEstimate(
            source,
            "TARGET",
            1997,
            {
                minEndpointStarredR: 0.45,
                minimumEndpointLagAdvantage: 0.2,
                minimumSegments: 1,
            },
        )).toMatchObject({ lag: 5, segmentCount: 1 });
    });

    it("uses repeated moderate endpoint rows instead of applying a single-row cutoff", () => {
        expect(getCofechaTerminalLagEstimate(hints([
            [1900, 1949, -6, 0.90],
            [1950, 1999, -5, 0.47, -0.17],
            [1953, 2002, -5, 0.50, -0.21],
        ]), "TARGET", 2007)).toMatchObject({
            lag: -5,
            segmentCount: 2,
        });
    });

    it("rejects a single endpoint lag without a clear advantage over lag zero", () => {
        expect(getCofechaTerminalLagEstimate(hints([
            [1948, 1997, 5, 0.54, 0.49],
        ]), "TARGET", 1997, {
            minEndpointStarredR: 0.45,
            minimumEndpointLagAdvantage: 0.2,
            minimumSegments: 1,
        })).toBeNull();
    });

    it("detects when local states contradict the terminal residual direction", () => {
        expect(terminalResidualPatternSupport(
            [pattern(-8, 0.9, 4)],
            -1,
            1,
        )).toEqual({ matching: 0, opposing: 3.6 });
        const matching = terminalResidualPatternSupport(
            [pattern(4, 0.8, 3)],
            5,
            -1,
        );
        expect(matching.matching).toBeCloseTo(2.4);
        expect(matching.opposing).toBe(0);
    });

    it("admits only preserved and path-supported physical partial residuals", () => {
        const input = {
            residualLag: -6,
            afterGlobalLag: -6,
            matchingPatternSupport: 3.2,
            opposingPatternSupport: 0.4,
            maxPartialGapYears: 100,
            lagMin: -100,
            seriesLength: 225,
        };
        expect(terminalWholeCompositionGatePassed(input)).toBe(true);
        expect(terminalWholeCompositionGatePassed({
            ...input,
            afterGlobalLag: -5,
        })).toBe(false);
        expect(terminalWholeCompositionGatePassed({
            ...input,
            matchingPatternSupport: 0,
        })).toBe(false);
        expect(terminalWholeCompositionGatePassed({
            ...input,
            opposingPatternSupport: 4,
        })).toBe(false);
        expect(terminalWholeCompositionGatePassed({
            ...input,
            residualLag: 6,
            afterGlobalLag: 6,
        })).toBe(false);
        expect(terminalWholeCompositionGatePassed({
            ...input,
            residualLag: -101,
            afterGlobalLag: -101,
        })).toBe(false);
    });

    it.each([-1, 1])("preserves the existing unit residual gate for lag %i", (lag) => {
        expect(terminalWholeCompositionGatePassed({
            residualLag: lag,
            afterGlobalLag: lag,
            matchingPatternSupport: 0,
            opposingPatternSupport: 0,
            maxPartialGapYears: 100,
            lagMin: -100,
            seriesLength: 225,
        })).toBe(true);
    });

    it("prefers a hard-gated terminal candidate over the higher-scoring majority state", () => {
        const candidate = (
            shiftYears: number,
            score: number,
            terminal: boolean,
        ) => ({
            operationType: "SHIFT_RANGE",
            mode: "wholeSeriesMove",
            deltaYears: shiftYears,
            score,
            candidateStrength: "strong",
            evidence: {
                recallSourceTags: terminal
                    ? ["cofecha_terminal_whole_baseline"]
                    : [],
                evaluationDelta: {
                    hardGatePassed: true,
                },
            },
        } as DiagnosisCandidateOperation);

        expect(selectWholeSeriesCandidate([
            candidate(-4, 18, false),
            candidate(-5, 14, true),
        ])?.deltaYears).toBe(-5);
    });

    it("reserves one top-five slot for a validated terminal whole baseline", () => {
        const ordinary = Array.from({ length: 5 }, (_, index) => ({
            id: `unit-${index}`,
            operationType: "INSERT_MISSING_RING",
            score: 20 - index,
            evidence: {},
        } as DiagnosisCandidateOperation));
        const terminal = {
            id: "terminal-whole",
            operationType: "SHIFT_RANGE",
            mode: "wholeSeriesMove",
            deltaYears: 5,
            score: 3,
            candidateStrength: "strong",
            evidence: {
                recallSourceTags: ["cofecha_terminal_whole_baseline"],
                evaluationDelta: { jointCompositionGatePassed: true },
            },
        } as DiagnosisCandidateOperation;
        const retained = limitRankedCandidatesForEventDetection(
            [...ordinary, terminal],
            5,
        );

        expect(retained).toHaveLength(5);
        expect(retained).toContain(terminal);
        expect(isValidatedTerminalWholeCandidate(terminal)).toBe(true);
        expect(retained).not.toContain(ordinary[4]);
    });

    it("does not reserve a slot for an unvalidated terminal draft", () => {
        const ordinary = Array.from({ length: 5 }, (_, index) => ({
            id: `unit-${index}`,
            operationType: "INSERT_MISSING_RING",
            score: 20 - index,
            evidence: {},
        } as DiagnosisCandidateOperation));
        const weakTerminal = {
            id: "weak-terminal",
            operationType: "SHIFT_RANGE",
            mode: "wholeSeriesMove",
            deltaYears: 5,
            score: 3,
            candidateStrength: "weak",
            evidence: {
                recallSourceTags: ["cofecha_terminal_whole_baseline"],
                evaluationDelta: { jointCompositionGatePassed: false },
            },
        } as DiagnosisCandidateOperation;

        expect(limitRankedCandidatesForEventDetection(
            [...ordinary, weakTerminal],
            5,
        )).toEqual(ordinary);
        expect(isValidatedTerminalWholeCandidate(weakTerminal)).toBe(false);
    });

    it("does not let a weak terminal draft outrank a validated majority candidate", () => {
        const candidate = (
            shiftYears: number,
            score: number,
            terminal: boolean,
            strong: boolean,
        ) => ({
            operationType: "SHIFT_RANGE",
            mode: "wholeSeriesMove",
            deltaYears: shiftYears,
            score,
            candidateStrength: strong ? "strong" : "weak",
            evidence: {
                recallSourceTags: terminal
                    ? ["cofecha_terminal_whole_baseline"]
                    : [],
                evaluationDelta: {
                    hardGatePassed: strong,
                },
            },
        } as DiagnosisCandidateOperation);

        expect(selectWholeSeriesCandidate([
            candidate(-4, 18, false, true),
            candidate(-5, 20, true, false),
        ])?.deltaYears).toBe(-4);
    });
});

describe("path fixed-side whole baseline", () => {
    const validComposition = {
        wholeShift: 2,
        fixedSideLag: 2,
        newerContextYears: 64,
        jointEventCount: 2,
        afterGlobalLag: 0,
        wholeSeriesRDelta: 0.08,
        meanSegmentRDelta: 0.05,
        problemReduction: 3,
    };

    it("requires an exact fixed-side shift and a jointly corrected zero-lag state", () => {
        expect(pathFixedSideWholeCompositionGatePassed(validComposition)).toBe(true);
        expect(pathFixedSideWholeCompositionGatePassed({
            ...validComposition,
            wholeShift: 1,
        })).toBe(false);
        expect(pathFixedSideWholeCompositionGatePassed({
            ...validComposition,
            newerContextYears: 17,
        })).toBe(false);
        expect(pathFixedSideWholeCompositionGatePassed({
            ...validComposition,
            afterGlobalLag: -1,
        })).toBe(false);
        expect(pathFixedSideWholeCompositionGatePassed({
            ...validComposition,
            problemReduction: -1,
        })).toBe(false);
        expect(pathFixedSideWholeCompositionGatePassed({
            ...validComposition,
            wholeSeriesRDelta: 0,
            meanSegmentRDelta: 0,
            problemReduction: 0,
        })).toBe(false);
    });

    it("accepts a strong jointly validated path baseline without weakening ordinary whole gates", () => {
        const pathCandidate = {
            operationType: "SHIFT_RANGE",
            mode: "wholeSeriesMove",
            deltaYears: 2,
            score: 8,
            candidateStrength: "strong",
            evidence: {
                recallSourceTags: ["path_fixed_side_whole_baseline"],
                evaluationDelta: {
                    hardGatePassed: false,
                    jointCompositionGatePassed: true,
                },
            },
        } as DiagnosisCandidateOperation;
        const weakPathCandidate = {
            ...pathCandidate,
            candidateStrength: "weak",
        } as DiagnosisCandidateOperation;

        expect(isValidatedPathFixedSideWholeCandidate(pathCandidate)).toBe(true);
        expect(isValidatedPathFixedSideWholeCandidate(weakPathCandidate)).toBe(false);
        expect(selectWholeSeriesCandidate([pathCandidate])?.deltaYears).toBe(2);
    });

    it("uses evidence-family priority instead of comparing incomparable raw scores", () => {
        const candidate = (
            shiftYears: number,
            score: number,
            tags: string[],
            hardGatePassed: boolean,
            jointCompositionGatePassed: boolean,
        ) => ({
            operationType: "SHIFT_RANGE",
            mode: "wholeSeriesMove",
            deltaYears: shiftYears,
            score,
            candidateStrength: "strong",
            evidence: {
                recallSourceTags: tags,
                evaluationDelta: { hardGatePassed, jointCompositionGatePassed },
            },
        } as DiagnosisCandidateOperation);
        const unitPath = candidate(-5, 30, [
            "path_fixed_side_whole_baseline",
            "path_fixed_side_event_type:falseRing",
        ], true, true);
        const residualTail = candidate(-2, 5, [
            "recent_tail_whole_baseline",
            "recent_tail_residual_partial_baseline",
        ], true, false);
        const partialPath = candidate(5, 4, [
            "path_fixed_side_whole_baseline",
            "path_fixed_side_event_type:partialMove",
        ], false, true);
        const spuriousTail = candidate(-9, 40, [
            "recent_tail_whole_baseline",
        ], true, false);
        const highQualityTail = candidate(-2, 3, [
            "recent_tail_whole_baseline",
            "recent_tail_support_count:4",
            "recent_tail_total_count:4",
            "recent_tail_competing_support:0",
            "recent_tail_median_r:0.75",
        ], true, false);

        expect(selectWholeSeriesCandidate([unitPath, residualTail])?.deltaYears).toBe(-2);
        expect(selectWholeSeriesCandidate([unitPath, highQualityTail])?.deltaYears).toBe(-2);
        expect(selectWholeSeriesCandidate([partialPath, spuriousTail])?.deltaYears).toBe(5);
    });

    it("requires unanimous recent-tail agreement before it can confirm the global lag", () => {
        const agreement = {
            wholeShift: 5,
            tailLag: 5,
            globalLag: 5,
            supportCount: 4,
            totalCount: 4,
            competingSupportCount: 0,
            contextYears: 20,
            medianCorrelation: 0.62,
        };

        expect(recentTailGlobalAgreementGatePassed(agreement)).toBe(true);
        expect(recentTailGlobalAgreementGatePassed({
            ...agreement,
            globalLag: 6,
        })).toBe(false);
        expect(recentTailGlobalAgreementGatePassed({
            ...agreement,
            supportCount: 3,
        })).toBe(false);
        expect(recentTailGlobalAgreementGatePassed({
            ...agreement,
            medianCorrelation: 0.45,
        })).toBe(true);
        expect(recentTailGlobalAgreementGatePassed({
            ...agreement,
            medianCorrelation: 0.449,
        })).toBe(false);
    });

    it("allows a unanimous moderate tail to explain a dynamic negative residual partial shift", () => {
        const residual = {
            wholeShift: 5,
            tailLag: 5,
            supportCount: 4,
            totalCount: 4,
            competingSupportCount: 0,
            contextYears: 20,
            medianCorrelation: 0.56,
            pathLag: 2,
            residualPartialShift: -3,
            pathEventCount: 2,
            pathAfterGlobalLag: 0,
            pathWholeSeriesRDelta: 0.19,
            pathMeanSegmentRDelta: 0.2,
            pathProblemReduction: 4,
            maxPartialGapYears: 100,
        };

        expect(recentTailResidualPartialGatePassed(residual)).toBe(true);
        expect(recentTailResidualPartialGatePassed({
            ...residual,
            supportCount: 3,
        })).toBe(false);
        expect(recentTailResidualPartialGatePassed({
            ...residual,
            residualPartialShift: -101,
            pathLag: -96,
        })).toBe(false);
    });
});

d("COFECHA [A] 解析与生产诊断隔离（EBD 真实输出）", () => {
    it("解析序列级 [A] 并定位最新 flagged 段", () => {
        const out = loadCofechaOut("EBD");
        expect(out).not.toBeNull();
        const hints = parseCofechaHints(out as string);
        // [A] 段应带 seriesId（多序列文本必须区分）。
        expect(hints.segments.length).toBeGreaterThan(0);
        expect(hints.segments.some((s) => s.seriesId !== null)).toBe(true);
        // EBD031 在 RAW.OUT 中四段一致 highLag=-5；方向是 insert，但自动操作必须保留为 -5 partialMove。
        const ebd031 = getNewestFlaggedCofechaSegment(hints, "EBD031");
        expect(ebd031).not.toBeNull();
        expect(ebd031?.editType).toBe("insert");
    });

    it("提供 cofechaText 不生成段级候选，也不改变内部诊断结果", () => {
        const folder = loadDataFolder("EBD");
        const out = loadCofechaOut("EBD");
        if (!folder || !out) return;
        const site: RwlSiteData = new Map();
        folder.raw.forEach((series, id) => site.set(id, seriesToTreeData(series)));
        const withoutCofecha = diagnoseCrossdating(site, { referenceConfig: null });
        const withCofecha = diagnoseCrossdating(site, { referenceConfig: null, cofechaText: out });
        const candidateSignature = (diagnosis: typeof withCofecha) => diagnosis.candidates.map((candidate) => ({
            targetTree: candidate.targetTree,
            operationType: candidate.operationType,
            targetYear: candidate.targetYear,
            anchorYear: candidate.anchorYear,
            deltaYears: candidate.deltaYears,
            score: candidate.score,
            algorithmSource: candidate.algorithmSource,
        }));
        const eventSignature = (diagnosis: typeof withCofecha) => diagnosis.events.map((event) => ({
            seriesId: event.seriesId,
            eventType: event.eventType,
            startYear: event.startYear,
            endYear: event.endYear,
            shiftYears: event.shiftYears,
            topYear: event.rankedYears[0]?.year,
        }));

        expect(withCofecha.candidates.some((candidate) => (
            candidate.algorithmSource.includes("cofecha_segment_lag")
        ))).toBe(false);
        expect(candidateSignature(withCofecha)).toEqual(candidateSignature(withoutCofecha));
        expect(eventSignature(withCofecha)).toEqual(eventSignature(withoutCofecha));
    });
});
