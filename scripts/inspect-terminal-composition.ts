import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    extractPart6FlaggedASeriesIds,
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import { getConfig } from "@/features/crossdating/diagnosis/config";
import { parseCofechaHints } from "@/features/crossdating/diagnosis/cofechaHints";
import { makeCofechaTerminalWholeDrafts } from "@/features/crossdating/diagnosis/drafts";
import { evaluateDraft } from "@/features/crossdating/diagnosis/evaluation";
import { diagnoseSeriesCore } from "@/features/crossdating/diagnosis/segments";
import {
    createSeriesPreprocessCache,
    preprocessSeries,
} from "@/features/crossdating/diagnosis/series";
import {
    createCofechaMasterReferenceConfig,
    createCofechaPassReferenceConfig,
} from "@/features/crossdating/reference";
import {
    loadRwl,
    sha256Bytes,
} from "./legacy-generalization/evaluator";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string): string | null => {
    const equals = args.find((argument) => argument.startsWith(`${name}=`));
    if (equals) return equals.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};

const statePath = resolve(valueFor("--state") ?? "");
const outPath = resolve(valueFor("--out") ?? "");
const targetId = valueFor("--target");
if (!statePath || !outPath || !targetId) {
    throw new Error("usage: --state <state.rwl> --out <VERYCOF.OUT> --target <series>");
}

const loaded = await loadRwl(statePath, "tucson-auto");
const outText = readFileSync(outPath, "utf8");
const parts = splitReportByParts(outText);
const canonical = new Map(Array.from(loaded.siteData.keys(), (seriesId) => [
    seriesId.trim().toUpperCase(),
    seriesId,
]));
const flaggedIds = extractPart6FlaggedASeriesIds(parts.get("PART 6") ?? "")
    .flatMap((seriesId) => {
        const resolved = canonical.get(seriesId.trim().toUpperCase());
        return resolved ? [resolved] : [];
    });
const excluded = new Set([...flaggedIds, targetId]);
const rwlHash = sha256Bytes(readFileSync(statePath));
let referenceConfig = createCofechaPassReferenceConfig({
    siteData: loaded.siteData,
    flaggedAIds: excluded,
    cofechaRunId: `terminal-inspection-${targetId}`,
    rwlHash,
});
if (!referenceConfig.cofechaPassReference) {
    referenceConfig = createCofechaMasterReferenceConfig({
        siteData: loaded.siteData,
        flaggedAIds: excluded,
        cofechaRunId: `terminal-inspection-${targetId}`,
        rwlHash,
        masterDatingSeries: parseCofechaResult(outText).masterDatingSeries,
    });
}
const config = getConfig({
    referenceConfig,
    targetTrees: [targetId],
    cofechaText: outText,
});
const cache = createSeriesPreprocessCache();
const diagnosis = diagnoseSeriesCore(
    loaded.siteData,
    targetId,
    config,
    preprocessSeries,
    cache,
);
if (!diagnosis) throw new Error(`diagnosis unavailable: ${targetId}`);
const hints = parseCofechaHints(outText);
const drafts = makeCofechaTerminalWholeDrafts(diagnosis, config, hints);
const result = {
    statePath,
    targetId,
    targetRange: diagnosis.targetRange,
    globalLag: diagnosis.globalSlidingMatch.bestGlobalLag,
    propagationPatterns: diagnosis.propagationPatterns.map((pattern) => ({
        dominantLag: pattern.dominantLag,
        patternType: pattern.patternType,
        confidence: pattern.confidence,
        segmentCount: pattern.affectedSegments.length,
    })),
    terminalDrafts: drafts.map((draft) => {
        const candidate = evaluateDraft(
            loaded.siteData,
            diagnosis,
            draft,
            config,
            hints,
            cache,
        );
        return {
            deltaYears: draft.deltaYears,
            recallSourceTags: draft.recallSourceTags,
            evaluated: candidate !== null,
            score: candidate?.score ?? null,
            candidateStrength: candidate?.candidateStrength ?? null,
            evaluationDelta: candidate?.evidence.evaluationDelta ?? null,
        };
    }),
};

console.log(JSON.stringify(result, null, 2));
