/** Replays one preserved capability state and emits the full event-decision audit. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
    extractPart6FlaggedASeriesIds,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import { normalizeCofechaSeriesId } from "@/features/cofecha/seriesId";
import {
    diagnoseTruthBlind,
    loadRwl,
    sha256Bytes,
} from "./legacy-generalization/evaluator";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const statePath = resolve(valueFor("--state") ?? "");
const outPath = resolve(valueFor("--out") ?? resolve(dirname(statePath), "VERYCOF.OUT"));
const targetId = valueFor("--target");
const outputPath = valueFor("--output");
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
const snapshot = diagnoseTruthBlind({
    siteData: loaded.siteData,
    targetId,
    context: {
        stateDir: dirname(statePath),
        sitePath: statePath,
        outPath,
        outText,
        flaggedIds,
        rwlHash: sha256Bytes(readFileSync(statePath)),
    },
    runId: `capability-audit-${targetId}`,
    includeOperationGrid: true,
});
const text = `${JSON.stringify(snapshot, null, 2)}\n`;
if (outputPath) writeFileSync(resolve(outputPath), text, "utf8");
else process.stdout.write(text);
