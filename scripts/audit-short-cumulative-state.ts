/** Audits short cumulative partial hypotheses without using benchmark truth. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
    extractPart6FlaggedASeriesIds,
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import { normalizeCofechaSeriesId } from "@/features/cofecha/seriesId";
import { getConfig } from "@/features/crossdating/diagnosis/config";
import { getJointCounterfactualOperationScores } from "@/features/crossdating/diagnosis/jointCounterfactualOperation";
import { summarizeJointOperationRegion } from "@/features/crossdating/diagnosis/jointOperationSelector";
import {
    scorePerReferenceCounterfactualEvidence,
    summarizePerReferenceCounterfactualRows,
} from "@/features/crossdating/diagnosis/perReferenceCounterfactualEvidence";
import { compareCompletedPartialPair } from "@/features/crossdating/diagnosis/completedPartialPairCompetition";
import {
    compareCompletedPartialWithSingleFalse,
    compareCompletedPartialWithSingleMissing,
    comparePartialMoveWithMissingStaircase,
    comparePartialMoveWithRobustMissingStaircase,
} from "@/features/crossdating/diagnosis/discreteMissingStaircaseCompetition";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import {
    selectBoundedCompletedPartialUnitSeeds,
    selectExhaustiveCompletedPartialUnitComposition,
    supportsCompletedPartialUnitComposition,
} from "@/features/crossdating/diagnosis/eventEnsemble";
import {
    createLagPathCache,
    locateSequentialMissingHead,
    locateTwoStepMissingStaircase,
} from "@/features/crossdating/diagnosis/eventPath";
import { makeDiagnosisEventsFromCandidates } from "@/features/crossdating/diagnosis/events";
import { preprocessSeries } from "@/features/crossdating/diagnosis/series";
import { diagnoseSeriesCore } from "@/features/crossdating/diagnosis/segments";
import {
    cofechaStyleStandardize,
    createCofechaMasterReferenceConfig,
    createCofechaPassReferenceConfig,
} from "@/features/crossdating/reference";
import { loadRwl, sha256Bytes } from "./legacy-generalization/evaluator";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const statePath = resolve(valueFor("--state") ?? "");
const outPath = resolve(valueFor("--out") ?? resolve(dirname(statePath), "VERYCOF.OUT"));
const targetId = valueFor("--target");
if (!statePath || !targetId) throw new Error("--state and --target are required");

const loaded = await loadRwl(statePath, "tucson-auto");
const outText = readFileSync(outPath, "utf8");
const canonicalIds = new Map(Array.from(loaded.siteData.keys(), (seriesId) => [
    normalizeCofechaSeriesId(seriesId),
    seriesId,
]));
const flaggedIds = extractPart6FlaggedASeriesIds(
    splitReportByParts(outText).get("PART 6") ?? "",
).flatMap((seriesId) => {
    const resolved = canonicalIds.get(normalizeCofechaSeriesId(seriesId));
    return resolved ? [resolved] : [];
});
const excluded = new Set([...flaggedIds, targetId]);
const rwlHash = sha256Bytes(readFileSync(statePath));
let referenceConfig = createCofechaPassReferenceConfig({
    siteData: loaded.siteData,
    flaggedAIds: excluded,
    cofechaRunId: `short-cumulative-audit-${targetId}`,
    rwlHash,
});
if (!referenceConfig.cofechaPassReference) {
    referenceConfig = createCofechaMasterReferenceConfig({
        siteData: loaded.siteData,
        flaggedAIds: excluded,
        cofechaRunId: `short-cumulative-audit-${targetId}`,
        rwlHash,
        masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
    });
}
const config = getConfig({ referenceConfig });
const core = diagnoseSeriesCore(
    loaded.siteData,
    targetId,
    config,
    preprocessSeries,
);
const cofechaCore = diagnoseSeriesCore(
    loaded.siteData,
    targetId,
    config,
    (series) => new Map(cofechaStyleStandardize(series).map((point) => (
        [point.year, point.value]
    ))),
);
if (!core || !cofechaCore) throw new Error("target diagnosis unavailable");
const diagnosis = diagnoseCrossdating(loaded.siteData, {
    referenceConfig,
    targetTrees: [targetId],
    cofechaText: outText,
    includeEventDecisionAudits: true,
    reviewWindowDisplayMode: "review",
});
const aggregate = diagnosis.reviewEvents?.[0] ?? diagnosis.events[0] ?? null;
const candidateEvents = makeDiagnosisEventsFromCandidates(
    [core],
    diagnosis.candidates.filter((candidate) => candidate.targetTree === targetId),
);
const pathConfig = { minLag: -2, maxPartialGapYears: 2 };
const pathCache = createLagPathCache();
const head = aggregate?.eventType === "partialMove" && aggregate.shiftYears === -2
    ? locateSequentialMissingHead(cofechaCore, loaded.siteData, pathConfig, pathCache, 0)
    : null;
const staircase = aggregate?.eventType === "partialMove" && aggregate.shiftYears === -2
    ? locateTwoStepMissingStaircase(
        cofechaCore,
        loaded.siteData,
        aggregate,
        pathConfig,
        pathCache,
    )
    : null;
const missingCompetition = aggregate?.eventType === "partialMove"
    && aggregate.shiftYears === -2
    ? comparePartialMoveWithMissingStaircase(
        cofechaCore,
        loaded.siteData,
        aggregate,
        true,
        head?.year ?? null,
    )
    : null;
const robustMissingCompetition = aggregate?.eventType === "partialMove"
    && aggregate.shiftYears === -2
    ? comparePartialMoveWithRobustMissingStaircase(
        cofechaCore,
        loaded.siteData,
        aggregate,
        true,
        head?.year ?? null,
    )
    : null;
const partialPair = aggregate?.eventType === "partialMove"
    ? compareCompletedPartialPair(
        core,
        cofechaCore,
        loaded.siteData,
        aggregate,
        candidateEvents,
        config.maxPartialGapYears,
    )
    : null;
const completedUnitSeeds = aggregate?.eventType === "partialMove"
    ? selectBoundedCompletedPartialUnitSeeds(
        [aggregate],
        candidateEvents,
        [],
    )
    : [];
const completedUnitCompetitions = completedUnitSeeds.map((seed) => ({
    unitEventType: seed.unitEventType,
    shiftYears: seed.event.shiftYears,
    anchorYears: seed.anchorYears,
    competition: seed.unitEventType === "missingRing"
        ? compareCompletedPartialWithSingleMissing(
            cofechaCore,
            loaded.siteData,
            seed.event,
            head?.unitEventYears ?? [],
            true,
            seed.anchorYears,
            40,
        )
        : compareCompletedPartialWithSingleFalse(
            cofechaCore,
            loaded.siteData,
            seed.event,
            true,
            seed.anchorYears,
            40,
        ),
}));
const exhaustiveUnitCompetitions = aggregate?.eventType === "partialMove"
    && aggregate.shiftSide === "older"
    && (aggregate.shiftYears ?? 0) <= -3
    ? (["missingRing", "falseRing"] as const).map((unitEventType) => {
        const diagnosticSeed = {
            ...aggregate,
            evidence: {
                ...aggregate.evidence,
                candidateIds: [
                    ...aggregate.evidence.candidateIds,
                    "diagnostic-exhaustive-composition-seed",
                ],
                notes: Array.from(new Set([
                    ...aggregate.evidence.notes,
                    "candidate_hard_gate_passed",
                ])),
            },
        };
        const rawCompetition = unitEventType === "missingRing"
            ? compareCompletedPartialWithSingleMissing(
                core,
                loaded.siteData,
                diagnosticSeed,
                [],
                false,
                [],
                40,
            )
            : compareCompletedPartialWithSingleFalse(
                core,
                loaded.siteData,
                diagnosticSeed,
                false,
                [],
                40,
            );
        const cofechaCompetition = unitEventType === "missingRing"
            ? compareCompletedPartialWithSingleMissing(
                cofechaCore,
                loaded.siteData,
                diagnosticSeed,
                head?.unitEventYears ?? [],
                true,
                [],
                40,
            )
            : compareCompletedPartialWithSingleFalse(
                cofechaCore,
                loaded.siteData,
                diagnosticSeed,
                true,
                [],
                40,
            );
        return {
            unitEventType,
            rawSupported: supportsCompletedPartialUnitComposition(rawCompetition),
            cofechaSupported: supportsCompletedPartialUnitComposition(
                cofechaCompetition,
            ),
            rawCompetition,
            cofechaCompetition,
        };
    })
    : [];
const regionalOperationRows = aggregate?.eventType === "partialMove"
    ? ([
        ["raw", core, false],
        ["cofecha", cofechaCore, true],
    ] as const).flatMap(([view, operationCore]) => (
        getJointCounterfactualOperationScores(
            operationCore,
            15,
            getConfig({ referenceConfig }).maxPartialGapYears,
            0,
        ).filter((operation) => (
            operation.eventType === "missingRing"
            || operation.eventType === "falseRing"
            || operation.shiftYears === aggregate.shiftYears! + 1
            || operation.shiftYears === aggregate.shiftYears! - 1
        )).map((operation) => ({
            view,
            eventType: operation.eventType,
            shiftYears: operation.shiftYears,
            globalBestYear: operation.bestYear,
            globalBestDifferenceGain: operation.bestDifferenceGain,
            regionalRows: operation.rows.filter((row) => (
                row.year >= aggregate.startYear - 6
                && row.year <= aggregate.endYear + 6
            )).sort((left, right) => (
                right.differenceGain - left.differenceGain
                || right.combinedGain - left.combinedGain
            )).slice(0, 5).map((row) => ({
                year: row.year,
                rawGain: row.rawGain,
                differenceGain: row.differenceGain,
                combinedGain: row.combinedGain,
                sideStepScore: row.sideStepScore,
                sideMinimumAdvantage: row.sideMinimumAdvantage,
                correctedSideSupport: row.correctedSideSupport,
            })),
        }))
    ))
    : [];
const regionalReferenceOperations = aggregate?.eventType === "partialMove"
    ? [-1, 1].map((shiftYears) => {
        const rows = scorePerReferenceCounterfactualEvidence(
            core,
            loaded.siteData,
            shiftYears,
            {
                edgeYears: 15,
                maximumReferences: 12,
                baselineLagCenter: 0,
            },
        ).filter((row) => (
            row.year >= aggregate.startYear - 6
            && row.year <= aggregate.endYear + 6
        ));
        return {
            eventType: shiftYears === -1 ? "missingRing" : "falseRing",
            shiftYears,
            summary: summarizePerReferenceCounterfactualRows(rows),
        };
    })
    : [];

const displayedAudit = diagnosis.eventDecisionAudits?.[0]?.displayedBeforeLocator[0];
const preLocatorAggregate = aggregate?.eventType === "partialMove"
    && displayedAudit?.eventType === "partialMove"
    ? {
        ...aggregate,
        startYear: displayedAudit.startYear,
        endYear: displayedAudit.endYear,
        rankedYears: [{
            year: displayedAudit.topYear ?? Math.round(
                (displayedAudit.startYear + displayedAudit.endYear) / 2,
            ),
            rank: 1,
            score: displayedAudit.score,
            evidenceTags: [],
        }],
        shiftYears: displayedAudit.shiftYears ?? aggregate.shiftYears,
        evidence: {
            ...aggregate.evidence,
            algorithmSources: displayedAudit.algorithmSources,
            score: displayedAudit.score,
            scoreMargin: displayedAudit.scoreMargin,
            notes: displayedAudit.notes,
        },
    }
    : null;
const preLocatorExhaustive = preLocatorAggregate
    ? (() => {
        const operations = getJointCounterfactualOperationScores(
            core,
            15,
            config.maxPartialGapYears,
            0,
        );
        const anchorYear = preLocatorAggregate.rankedYears[0]!.year;
        const candidates = (["missingRing", "falseRing"] as const).flatMap(
            (unitEventType) => {
                const shiftYears = unitEventType === "missingRing" ? -1 : 1;
                const operation = operations.find((row) => (
                    row.eventType === unitEventType
                ));
                if (!operation) return [];
                const regionalEvidence = summarizeJointOperationRegion(
                    operation,
                    preLocatorAggregate.startYear - 6,
                    preLocatorAggregate.endYear + 6,
                    anchorYear,
                );
                const anchors = [
                    regionalEvidence.bestYear,
                    regionalEvidence.bestSideStepYear,
                ].filter((year): year is number => year !== null);
                const seed = {
                    ...preLocatorAggregate,
                    evidence: {
                        ...preLocatorAggregate.evidence,
                        notes: Array.from(new Set([
                            ...preLocatorAggregate.evidence.notes,
                            "completed_mixed_seed=exhaustive_unit_family",
                        ])),
                    },
                };
                const rawCompetition = unitEventType === "missingRing"
                    ? compareCompletedPartialWithSingleMissing(
                        core, loaded.siteData, seed, [], false, anchors, 40,
                    )
                    : compareCompletedPartialWithSingleFalse(
                        core, loaded.siteData, seed, false, anchors, 40,
                    );
                const cofechaCompetition = unitEventType === "missingRing"
                    ? compareCompletedPartialWithSingleMissing(
                        cofechaCore,
                        loaded.siteData,
                        seed,
                        head?.unitEventYears ?? [],
                        true,
                        anchors,
                        40,
                    )
                    : compareCompletedPartialWithSingleFalse(
                        cofechaCore, loaded.siteData, seed, true, anchors, 40,
                    );
                return rawCompetition && cofechaCompetition ? [{
                    unitEventType,
                    rawCompetition,
                    cofechaCompetition,
                    regionalEvidence,
                }] : [];
            },
        );
        return {
            aggregate: {
                startYear: preLocatorAggregate.startYear,
                endYear: preLocatorAggregate.endYear,
                topYear: anchorYear,
                shiftYears: preLocatorAggregate.shiftYears,
            },
            candidates,
            selection: selectExhaustiveCompletedPartialUnitComposition(
                candidates,
                preLocatorAggregate.startYear,
                preLocatorAggregate.endYear,
            ),
        };
    })()
    : null;

process.stdout.write(`${JSON.stringify({
    decisionAudit: diagnosis.eventDecisionAudits?.[0] ? {
        pass: diagnosis.eventDecisionAudits[0].pass,
        candidateProjectedEvents: diagnosis.eventDecisionAudits[0].candidateProjectedEvents,
        displayedBeforeLocator: diagnosis.eventDecisionAudits[0].displayedBeforeLocator,
        finalEvents: diagnosis.eventDecisionAudits[0].finalEvents,
        finalReason: diagnosis.eventDecisionAudits[0].finalReason,
    } : null,
    aggregate: aggregate ? {
        eventType: aggregate.eventType,
        shiftYears: aggregate.shiftYears,
        startYear: aggregate.startYear,
        endYear: aggregate.endYear,
        topYear: aggregate.rankedYears[0]?.year ?? null,
        score: aggregate.evidence.score,
        scoreMargin: aggregate.evidence.scoreMargin,
        sources: aggregate.evidence.algorithmSources,
    } : null,
    candidateEvents: candidateEvents.map((event) => ({
        eventType: event.eventType,
        shiftYears: event.shiftYears,
        startYear: event.startYear,
        endYear: event.endYear,
        topYear: event.rankedYears[0]?.year ?? null,
        hardGate: event.evidence.notes.includes("candidate_hard_gate_passed"),
        sources: event.evidence.algorithmSources,
    })),
    head,
    staircase,
    missingCompetition,
    robustMissingCompetition,
    partialPair,
    completedUnitSeeds: completedUnitSeeds.map((seed) => ({
        unitEventType: seed.unitEventType,
        shiftYears: seed.event.shiftYears,
        anchorYears: seed.anchorYears,
        notes: seed.event.evidence.notes.filter((note) => (
            note.startsWith("bounded_completed_mixed_")
        )),
    })),
    completedUnitCompetitions,
    exhaustiveUnitCompetitions,
    regionalOperationRows,
    regionalReferenceOperations,
    preLocatorExhaustive,
}, null, 2)}\n`);
