/** Create one truth-blind runtime attempt using the frozen benchmark contract. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
    extractPart6FlaggedASeriesIds,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import {
    diagnoseTruthBlind,
    loadRwl,
    sha256Bytes,
} from "./legacy-generalization/evaluator";

type RuntimeInput = {
    rwlPath: string;
    outPath: string;
    targetId: string;
};

type RuntimeEvent = NonNullable<ReturnType<typeof diagnoseTruthBlind>["reviewEvent"]>;

const eventShiftYears = (event: {
    eventType: string;
    shiftYears?: number;
}): number => {
    if (event.eventType === "missingRing") return -1;
    if (event.eventType === "falseRing") return 1;
    return event.shiftYears ?? 0;
};

const preview = (event: RuntimeEvent | null | undefined) => event ? ({
    eventType: event.eventType,
    shiftYears: eventShiftYears(event),
    startYear: event.startYear,
    endYear: event.endYear,
    topYear: event.rankedYears[0]?.year ?? null,
    confidence: event.confidenceLevel,
    score: event.evidence.score,
    scoreMargin: event.evidence.scoreMargin,
    sources: event.evidence.algorithmSources,
    notes: event.evidence.notes,
    reviewOnly: event.reviewOnly === true,
}) : null;

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string): string => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? "" : "";
};

const inputPath = resolve(valueFor("--input"));
const runDir = resolve(valueFor("--run-dir"));
if (!inputPath || !runDir) {
    throw new Error("--input and --run-dir are required");
}

const input = JSON.parse(readFileSync(inputPath, "utf8")) as RuntimeInput;
const sourceRwl = resolve(input.rwlPath);
const sourceOut = resolve(input.outPath);
const targetId = input.targetId.trim();
if (!targetId) throw new Error("targetId is required");

const stateDir = join(runDir, "workers", "worker-0", "case-0-step-1");
mkdirSync(stateDir, { recursive: true });
const statePath = join(stateDir, "state.rwl");
const outPath = join(stateDir, "VERYCOF.OUT");
const rwlBytes = readFileSync(sourceRwl);
const outText = readFileSync(sourceOut, "utf8");
writeFileSync(statePath, rwlBytes);
writeFileSync(outPath, outText, "utf8");

const loaded = await loadRwl(statePath, "tucson-auto");
if (!loaded.siteData.has(targetId)) {
    throw new Error(`target series is absent from RWL: ${targetId}`);
}
const part6 = splitReportByParts(outText).get("PART 6") ?? "";
const snapshot = diagnoseTruthBlind({
    siteData: loaded.siteData,
    targetId,
    context: {
        stateDir,
        sitePath: statePath,
        outPath,
        outText,
        flaggedIds: extractPart6FlaggedASeriesIds(part6),
        rwlHash: sha256Bytes(rwlBytes),
    },
    runId: "authoritative-runtime-0-1",
    includeOperationGrid: true,
});
if (snapshot.error) {
    throw new Error(`runtime evidence generation failed: ${snapshot.error}`);
}

writeFileSync(
    join(stateDir, "diagnosis-audit.json"),
    `${JSON.stringify({ before: snapshot, after: snapshot }, null, 2)}\n`,
    "utf8",
);
const sourcePrimary = snapshot.reviewEvent ?? snapshot.strictEvent;
const sourceAlternative = sourcePrimary?.interpretationAmbiguity?.alternative;
const primary = preview(sourcePrimary);
const alternative = sourceAlternative ? {
    eventType: sourceAlternative.eventType,
    shiftYears: eventShiftYears(sourceAlternative),
    startYear: sourceAlternative.startYear,
    endYear: sourceAlternative.endYear,
    topYear: sourceAlternative.rankedYears[0]?.year ?? null,
    confidence: sourceAlternative.confidenceLevel,
    score: sourceAlternative.evidence.score,
    scoreMargin: sourceAlternative.evidence.scoreMargin,
    sources: sourceAlternative.evidence.algorithmSources,
    notes: sourceAlternative.evidence.notes,
    reviewOnly: true,
} : null;
const steps = [{
    caseIndex: 0,
    caseId: "authoritative-runtime",
    step: 1,
    fileId: basename(sourceRwl).replace(/\.[^.]+$/, ""),
    family: "Runtime",
    targetId,
    response: primary !== null,
    workflowSuggestionCorrect: false,
    primary,
    alternative,
    diagnosedTruthType: null,
    diagnosedTruthYear: null,
    diagnosedTruthShiftYears: null,
    acceptedTruthType: null,
    acceptedTruthYear: null,
    acceptedTruthShiftYears: null,
}];
writeFileSync(
    join(runDir, "steps.json"),
    `${JSON.stringify(steps, null, 2)}\n`,
    "utf8",
);
console.log(JSON.stringify({
    runDir,
    targetId,
    referenceMode: snapshot.referenceMode,
    candidateCount: snapshot.candidates.length,
    hasOperationGrid: snapshot.operationGrid !== null,
}));
