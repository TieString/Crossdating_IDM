import { createHash } from "node:crypto";
import {
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
    extractPart6FlaggedASeriesIds,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis/types";
import {
    createPairwiseBootstrapReferenceConfig,
    createPairwiseBootstrapTargetReferenceConfig,
} from "@/features/crossdating/pairwiseBootstrap";
import { parseRwl } from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string): string | null => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};

const runDir = resolve(valueFor("--run-dir") ?? "");
if (!runDir) throw new Error("usage: --run-dir <serial checkpoint directory>");
const snapshotMode = valueFor("--snapshot") ?? "terminal";
if (snapshotMode !== "terminal" && snapshotMode !== "clean") {
    throw new Error("--snapshot must be terminal or clean");
}

const requestedRound = valueFor("--round");
const requestedSeries = new Set(
    (valueFor("--series") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
);
const roundDir = snapshotMode === "terminal"
    ? readdirSync(join(runDir, "rounds"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .filter((entry) => requestedRound === null
            || Number(entry.name) === Number(requestedRound))
        .sort((left, right) => Number(right.name) - Number(left.name))[0]
    : null;
if (snapshotMode === "terminal" && !roundDir) {
    throw new Error(`no round directory found: ${runDir}`);
}

const statePath = snapshotMode === "clean"
    ? join(runDir, "clean-original", "state.rwl")
    : join(runDir, "rounds", roundDir!.name, "state.rwl");
const outPath = snapshotMode === "clean"
    ? join(runDir, "clean-original", "VERYCOF.OUT")
    : join(runDir, "rounds", roundDir!.name, "VERYCOF.OUT");
const currentDiagnosisPath = snapshotMode === "clean"
    ? join(runDir, "clean-original-targets.json")
    : join(runDir, "rounds", roundDir!.name, "target-diagnoses.json");
const checkpointPath = join(runDir, "checkpoint.json");
const siteData = new Map(Array.from(
    parseRwl(readFileSync(statePath, "utf8")),
    ([seriesId, series]) => [seriesId, new Map(series.valuesByYear)],
));
const outText = readFileSync(outPath, "utf8");
const canonicalIds = new Map(Array.from(siteData.keys(), (seriesId) => [
    seriesId.trim().toUpperCase(),
    seriesId,
]));
const flaggedIds = extractPart6FlaggedASeriesIds(
    splitReportByParts(outText).get("PART 6") ?? "",
).flatMap((seriesId) => {
    const canonical = canonicalIds.get(seriesId.trim().toUpperCase());
    return canonical ? [canonical] : [];
});
const rwlHash = createHash("sha256").update(readFileSync(statePath)).digest("hex");
const pairwiseReference = createPairwiseBootstrapReferenceConfig({
    siteData,
    flaggedAIds: flaggedIds,
    cofechaRunId: `${snapshotMode}-reference-audit-${roundDir?.name ?? "original"}`,
    rwlHash,
});
if (!pairwiseReference?.cofechaPassReference) {
    throw new Error(`pairwise bootstrap unavailable: ${runDir}`);
}

type Checkpoint = {
    states: Array<{
        seriesId: string;
        remainingTruthYears: number[];
    }>;
};
type SavedTarget = {
    seriesId: string;
    reviewEvent: DiagnosisEvent | null;
    reviewDecision?: {
        reason?: string;
    };
};
const checkpoint = snapshotMode === "terminal"
    ? JSON.parse(readFileSync(checkpointPath, "utf8")) as Checkpoint
    : null;
const currentTargets = JSON.parse(
    readFileSync(currentDiagnosisPath, "utf8"),
) as SavedTarget[];
const currentBySeries = new Map(currentTargets.map((row) => [row.seriesId, row]));

const topYear = (event: DiagnosisEvent | null): number | null => event
    ? [...event.rankedYears].sort((left, right) => (
        left.rank - right.rank || right.score - left.score || right.year - left.year
    ))[0]?.year ?? null
    : null;

const snapshot = (event: DiagnosisEvent | null, truthYear: number | null) => ({
    response: event !== null,
    eventType: event?.eventType ?? null,
    startYear: event?.startYear ?? null,
    endYear: event?.endYear ?? null,
    topYear: topYear(event),
    operationCorrect: event?.eventType === "missingRing",
    windowCovered: truthYear === null
        ? null
        : event?.eventType === "missingRing"
        && event.startYear <= truthYear
        && event.endYear >= truthYear,
    confidenceLevel: event?.confidenceLevel ?? null,
    score: event?.evidence.score ?? null,
    scoreMargin: event?.evidence.scoreMargin ?? null,
    correlationGain: event?.evidence.correlationGain ?? null,
    samplePairs: event?.evidence.samplePairs ?? 0,
    lagBefore: event?.evidence.lagBefore ?? null,
    lagAfter: event?.evidence.lagAfter ?? null,
    algorithmSources: event ? [...event.evidence.algorithmSources] : [],
    notes: event ? [...event.evidence.notes] : [],
});

const targetStates = snapshotMode === "terminal"
    ? checkpoint!.states.flatMap((state) => {
        const truthYear = state.remainingTruthYears[0];
        return Number.isInteger(truthYear)
            ? [{ seriesId: state.seriesId, truthYear }]
            : [];
    })
    : currentTargets
        .filter((target) => target.reviewEvent === null
            && target.reviewDecision?.reason === "partial_move_evidence_insufficient")
        .map((target) => ({ seriesId: target.seriesId, truthYear: null }));
const selectedTargetStates = targetStates.filter((state) => (
    requestedSeries.size === 0 || requestedSeries.has(state.seriesId)
));

const cases = selectedTargetStates.flatMap((state) => {
    const truthYear = state.truthYear;
    const targetReference = createPairwiseBootstrapTargetReferenceConfig(
        siteData,
        pairwiseReference,
        state.seriesId,
    );
    const diagnosis = diagnoseCrossdating(siteData, {
        referenceConfig: targetReference,
        targetTrees: [state.seriesId],
        cofechaText: outText,
        includeEventDecisionAudits: true,
        reviewWindowDisplayMode: "review",
    });
    const current = snapshot(
        currentBySeries.get(state.seriesId)?.reviewEvent ?? null,
        truthYear,
    );
    const pairwise = snapshot(diagnosis.reviewEvents?.[0] ?? null, truthYear);
    const targetYears = [...(siteData.get(state.seriesId)?.keys() ?? [])];
    const targetStartYear = targetYears.length > 0 ? Math.min(...targetYears) : null;
    const targetEndYear = targetYears.length > 0 ? Math.max(...targetYears) : null;
    return [{
        seriesId: state.seriesId,
        truthYear,
        targetStartYear,
        targetEndYear,
        current,
        pairwise,
        gainedCorrectWindow: truthYear === null
            ? null
            : !current.windowCovered && pairwise.windowCovered,
        lostCorrectWindow: truthYear === null
            ? null
            : current.windowCovered && !pairwise.windowCovered,
    }];
});

const summary = {
    runDir,
    snapshotMode,
    round: roundDir ? Number(roundDir.name) : null,
    frontierCases: cases.length,
    pairwiseAnchorCount: pairwiseReference.selectedTrees.length,
    currentResponses: cases.filter((row) => row.current.response).length,
    currentCorrectWindows: snapshotMode === "terminal"
        ? cases.filter((row) => row.current.windowCovered).length
        : null,
    pairwiseResponses: cases.filter((row) => row.pairwise.response).length,
    pairwiseCorrectWindows: snapshotMode === "terminal"
        ? cases.filter((row) => row.pairwise.windowCovered).length
        : null,
    pairwiseIncorrectOperations: cases.filter((row) => (
        row.pairwise.response && !row.pairwise.operationCorrect
    )).length,
    gainedCorrectWindows: snapshotMode === "terminal"
        ? cases.filter((row) => row.gainedCorrectWindow).length
        : null,
    lostCorrectWindows: snapshotMode === "terminal"
        ? cases.filter((row) => row.lostCorrectWindow).length
        : null,
};
const outputDir = join(runDir, "analysis");
mkdirSync(outputDir, { recursive: true });
const outputPath = join(
    outputDir,
    `${snapshotMode}-reference-mode-audit.json`,
);
writeFileSync(outputPath, JSON.stringify({ summary, cases }, null, 2), "utf8");
console.log(JSON.stringify(summary));
