/** Evaluate the authoritative online model on every clean series in one RWL. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    extractPart6FlaggedASeriesIds,
    parseCofechaResult,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import { diagnoseCrossdating, getDisplayedDiagnosisEvents } from "@/features/crossdating/diagnosis";
import { applyAuthoritativeModelDecision } from "@/features/crossdating/diagnosis/authoritativeModelProjection";
import { buildOnlineUnifiedEvidenceForTarget } from "@/features/crossdating/diagnosis/onlineUnifiedEvidenceRuntime";
import { inferOnlineUnifiedDiagnosis, warmOnlineUnifiedModel } from "@/features/crossdating/diagnosis/onlineUnifiedModel";
import { createPairwiseBootstrapTargetReferenceConfig } from "@/features/crossdating/pairwiseBootstrap";
import { createCofechaMasterReferenceConfig } from "@/features/crossdating/reference";
import { formatTucson } from "@/features/rwl/parsers/tucson";
import type { RwlSiteData } from "@/features/rwl/types";
import { parseRwl } from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueFor = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const inputPath = resolve(valueFor("--input") ?? join(repoRoot, "test-data", "co612.rwl"));
const cofechaExe = resolve(valueFor("--cofecha-exe") ?? process.env.COFECHA_EXE ?? "");
const outputDir = resolve(valueFor("--output-dir")
    ?? join(repoRoot, ".benchmark-results", "online-unified-clean"));
const expectedHash = valueFor("--expected-sha256")?.toLowerCase() ?? null;

const inputBytes = readFileSync(inputPath);
const sourceHash = createHash("sha256").update(inputBytes).digest("hex");
if (expectedHash && sourceHash !== expectedHash) {
    throw new Error(`unexpected source hash: expected=${expectedHash} actual=${sourceHash}`);
}
const parsed = parseRwl(inputBytes.toString("utf8"));
const siteData: RwlSiteData = new Map(Array.from(parsed, ([seriesId, series]) => [
    seriesId,
    new Map(series.valuesByYear),
]));

const runCofecha = (): string => {
    const workDir = mkdtempSync(join(tmpdir(), "online-unified-clean-"));
    try {
        writeFileSync(join(workDir, "INPUT.RWL"), formatTucson(siteData, false), "utf8");
        execFileSync(cofechaExe, [], {
            cwd: workDir,
            input: "very\nINPUT.RWL\n\n\n\n\n\n\n",
            timeout: 30_000,
            stdio: ["pipe", "ignore", "pipe"],
        });
        return readFileSync(join(workDir, "VERYCOF.OUT"), "utf8");
    } finally {
        rmSync(workDir, { force: true, recursive: true });
    }
};

warmOnlineUnifiedModel();
const outText = runCofecha();
const result = parseCofechaResult(outText);
const flaggedIds = extractPart6FlaggedASeriesIds(
    splitReportByParts(outText).get("PART 6") ?? "",
);
const referenceConfig = createCofechaMasterReferenceConfig({
    siteData,
    flaggedAIds: flaggedIds,
    cofechaRunId: "online-unified-clean",
    rwlHash: sourceHash,
    masterDatingSeries: result.masterDatingSeries,
});

const rows = [];
for (const seriesId of siteData.keys()) {
    const startedAt = performance.now();
    const targetReferenceConfig = createPairwiseBootstrapTargetReferenceConfig(
        siteData,
        referenceConfig,
        seriesId,
    ) ?? referenceConfig;
    const diagnosis = diagnoseCrossdating(siteData, {
        referenceConfig: targetReferenceConfig,
        targetTrees: [seriesId],
        cofechaText: outText,
        reviewWindowDisplayMode: "review",
        includeEventDecisionAudits: true,
    });
    const bundle = buildOnlineUnifiedEvidenceForTarget({
        diagnosis,
        siteData,
        targetTree: seriesId,
        referenceConfig: targetReferenceConfig,
    });
    const inference = bundle ? inferOnlineUnifiedDiagnosis(bundle) : null;
    const projected = inference ? applyAuthoritativeModelDecision(
        diagnosis,
        inference.decision,
        seriesId,
        inference.selectedPackage?.event ?? null,
    ) : diagnosis;
    const event = getDisplayedDiagnosisEvents(projected)[0] ?? null;
    rows.push({
        seriesId,
        cofechaFlagged: Array.from(flaggedIds).some(
            (id) => id.toLowerCase() === seriesId.toLowerCase(),
        ),
        modelStatus: inference?.decision.status ?? "evidence-unavailable",
        eventType: event?.eventType ?? null,
        shiftYears: event?.shiftYears ?? null,
        startYear: event?.startYear ?? null,
        endYear: event?.endYear ?? null,
        elapsedMs: performance.now() - startedAt,
        modelElapsedMs: inference
            ? inference.operationElapsedMs + inference.locationElapsedMs
            : null,
    });
    if (rows.length % 10 === 0) console.log(`progress clean=${rows.length}/${siteData.size}`);
}

const falsePositives = rows.filter((row) => row.eventType !== null);
const finalHash = createHash("sha256").update(readFileSync(inputPath)).digest("hex");
const summary = {
    inputPath,
    sourceSha256: sourceHash,
    sourceUnchanged: sourceHash === finalHash,
    seriesCount: rows.length,
    falsePositiveCount: falsePositives.length,
    falsePositiveRate: rows.length > 0 ? falsePositives.length / rows.length : 0,
    modelResponseCount: rows.filter((row) => row.modelStatus === "selected").length,
    falsePositives,
};
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
writeFileSync(join(outputDir, "cases.json"), `${JSON.stringify(rows, null, 2)}\n`, "utf8");
console.log(`ONLINE_UNIFIED_CLEAN ${JSON.stringify(summary)}`);
