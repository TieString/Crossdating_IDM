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
import { compareCompletedPartialPair } from "@/features/crossdating/diagnosis/completedPartialPairCompetition";
import {
    comparePartialMoveWithMissingStaircase,
    comparePartialMoveWithRobustMissingStaircase,
} from "@/features/crossdating/diagnosis/discreteMissingStaircaseCompetition";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
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
}, null, 2)}\n`);
