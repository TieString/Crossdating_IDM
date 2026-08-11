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
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import {
    createCofechaMasterReferenceConfig,
    createCofechaPassReferenceConfig,
    cofechaStyleStandardize,
} from "@/features/crossdating/reference";
import { getConfig } from "@/features/crossdating/diagnosis/config";
import { diagnoseCrossdating } from "@/features/crossdating/diagnosis/engine";
import {
    createLagPathCache,
    locateSequentialMissingHead,
} from "@/features/crossdating/diagnosis/eventPath";
import {
    comparePartialMoveWithMissingStaircase,
} from "@/features/crossdating/diagnosis/discreteMissingStaircaseCompetition";
import {
    evaluateMissingPartialInterpretationTie,
} from "@/features/crossdating/diagnosis/missingPartialInterpretation";
import { diagnoseSeriesCore } from "@/features/crossdating/diagnosis/segments";
import type {
    DiagnosisEvent,
    NumericSeries,
} from "@/features/crossdating/diagnosis/types";
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
const round = snapshotMode === "terminal"
    ? readdirSync(join(runDir, "rounds"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .sort((left, right) => Number(right.name) - Number(left.name))[0]
    : null;
if (snapshotMode === "terminal" && !round) {
    throw new Error(`no round directory found: ${runDir}`);
}

const statePath = snapshotMode === "clean"
    ? join(runDir, "clean-original", "state.rwl")
    : join(runDir, "rounds", round!.name, "state.rwl");
const outPath = snapshotMode === "clean"
    ? join(runDir, "clean-original", "VERYCOF.OUT")
    : join(runDir, "rounds", round!.name, "VERYCOF.OUT");
const checkpointPath = join(runDir, "checkpoint.json");
const diagnosisPath = snapshotMode === "clean"
    ? join(runDir, "clean-original-targets.json")
    : join(runDir, "rounds", round!.name, "target-diagnoses.json");
const stateText = readFileSync(statePath, "utf8");
const siteData = new Map(Array.from(
    parseRwl(stateText),
    ([seriesId, series]) => [seriesId, new Map(series.valuesByYear)],
));
const outText = readFileSync(outPath, "utf8");
const cofechaResult = parseCofechaResult(outText);
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
const flagged = new Set(flaggedIds);
const rwlHash = createHash("sha256").update(stateText).digest("hex");
type Checkpoint = {
    states: Array<{
        seriesId: string;
        remainingTruthYears: number[];
    }>;
};
const checkpoint = snapshotMode === "terminal"
    ? JSON.parse(readFileSync(checkpointPath, "utf8")) as Checkpoint
    : null;
const savedDiagnoses = JSON.parse(readFileSync(diagnosisPath, "utf8")) as Array<{
    seriesId: string;
    strictEvent: DiagnosisEvent | null;
}>;
const savedBySeries = new Map(savedDiagnoses.map((row) => [row.seriesId, row]));
const cofechaPreprocess = (series: NumericSeries): NumericSeries => new Map(
    cofechaStyleStandardize(series).map((point) => [point.year, point.value]),
);

const targetStates = snapshotMode === "terminal"
    ? checkpoint!.states.flatMap((state) => {
        const truthYear = state.remainingTruthYears[0];
        const strictEvent = savedBySeries.get(state.seriesId)?.strictEvent;
        return Number.isInteger(truthYear)
            && strictEvent?.eventType === "partialMove"
            && (strictEvent.shiftYears === -2 || strictEvent.shiftYears === -3)
            ? [{
                seriesId: state.seriesId,
                truthYear,
                remainingInSeries: state.remainingTruthYears.length,
            }]
            : [];
    })
    : savedDiagnoses.flatMap((saved) => (
        saved.strictEvent?.eventType === "partialMove"
        && (saved.strictEvent.shiftYears === -2
            || saved.strictEvent.shiftYears === -3)
            ? [{
                seriesId: saved.seriesId,
                truthYear: null,
                remainingInSeries: null,
            }]
            : []
    ));

const cases = targetStates.flatMap((state) => {
    const effectiveFlagged = new Set([...flagged, state.seriesId]);
    let referenceConfig = createCofechaPassReferenceConfig({
        siteData,
        flaggedAIds: effectiveFlagged,
        cofechaRunId: `${snapshotMode}-path-audit-${
            round?.name ?? "original"
        }-${state.seriesId}`,
        rwlHash,
    });
    if (!referenceConfig.cofechaPassReference) {
        referenceConfig = createCofechaMasterReferenceConfig({
            siteData,
            flaggedAIds: effectiveFlagged,
            cofechaRunId: `${snapshotMode}-path-audit-${
                round?.name ?? "original"
            }-${state.seriesId}`,
            rwlHash,
            masterDatingSeries: cofechaResult.masterDatingSeries,
        });
    }
    const config = getConfig({ referenceConfig });
    const productionDiagnosis = diagnoseCrossdating(siteData, {
        referenceConfig,
        targetTrees: [state.seriesId],
        cofechaText: outText,
        includeEventDecisionAudits: true,
        reviewWindowDisplayMode: "review",
    });
    const productionEvent = productionDiagnosis.reviewEvents?.[0] ?? null;
    const productionAlternative =
        productionEvent?.interpretationAmbiguity?.alternative ?? null;
    const diagnosis = diagnoseSeriesCore(
        siteData,
        state.seriesId,
        config,
        cofechaPreprocess,
    );
    const head = diagnosis ? locateSequentialMissingHead(
        diagnosis,
        siteData,
        {
            minLag: config.lagMin,
            maxPartialGapYears: config.maxPartialGapYears,
        },
        createLagPathCache(),
    ) : null;
    const strictEvent = savedBySeries.get(state.seriesId)?.strictEvent ?? null;
    const compactShift = strictEvent?.eventType === "partialMove"
        && (strictEvent.shiftYears === -2 || strictEvent.shiftYears === -3)
        ? strictEvent.shiftYears
        : null;
    const compactHead = diagnosis && compactShift !== null
        ? locateSequentialMissingHead(
            diagnosis,
            siteData,
            {
                minLag: compactShift,
                maxPartialGapYears: Math.abs(compactShift),
            },
            createLagPathCache(),
            0,
        )
        : null;
    const smallCompetition = diagnosis && compactHead && strictEvent
        ? comparePartialMoveWithMissingStaircase(
            diagnosis,
            siteData,
            strictEvent,
            true,
            compactHead.year,
        )
        : null;
    const interpretationTie = evaluateMissingPartialInterpretationTie(
        smallCompetition,
        {
            missingReviewPassed: head !== null,
            partialReviewPassed: strictEvent?.eventType === "partialMove",
            hasIndependentWholeSeriesBaseline: false,
        },
    );
    return [{
        seriesId: state.seriesId,
        truthYear: state.truthYear,
        remainingInSeries: state.remainingInSeries,
        referenceCount:
            referenceConfig.cofechaPassReference?.includedSeriesIds.length ?? 0,
        head,
        compactHead,
        smallCompetition,
        interpretationTie,
        production: {
            eventType: productionEvent?.eventType ?? null,
            startYear: productionEvent?.startYear ?? null,
            endYear: productionEvent?.endYear ?? null,
            topYear: productionEvent?.rankedYears[0]?.year ?? null,
            alternativeEventType: productionAlternative?.eventType ?? null,
            alternativeStartYear: productionAlternative?.startYear ?? null,
            alternativeEndYear: productionAlternative?.endYear ?? null,
            alternativeTopYear:
                productionAlternative?.rankedYears[0]?.year ?? null,
            missingRingCount:
                productionEvent?.interpretationAmbiguity?.evidence.missingRingCount
                ?? null,
        },
    }];
});

const outputDir = join(runDir, "analysis");
mkdirSync(outputDir, { recursive: true });
const outputPath = join(
    outputDir,
    `${snapshotMode}-sequential-path-audit.json`,
);
writeFileSync(outputPath, JSON.stringify({
    runDir,
    snapshotMode,
    round: round ? Number(round.name) : null,
    cases,
}, null, 2), "utf8");
console.log(JSON.stringify({
    runDir,
    snapshotMode,
    round: round ? Number(round.name) : null,
    frontierCases: cases.length,
    sequentialHeads: cases.filter((row) => row.head !== null).length,
    outputPath,
}));
