/** Replays saved terminal frontiers with the current production diagnosis worker. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
    extractPart6FlaggedASeriesIds,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import { selectPairwiseBootstrapCluster } from "@/features/crossdating/pairwiseBootstrap";
import type {
    DiagnosisEvent,
    DiagnosisEventDecisionAudit,
    DiagnosisJointEventDecision,
    DiagnosisReviewWindowDecision,
} from "@/features/crossdating/diagnosis/types";
import { parseRwl } from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

type PlanRow = { file: string; path: string };
type WorkerTargetResult = {
    seriesId: string;
    strictEvent: DiagnosisEvent | null;
    reviewEvent: DiagnosisEvent | null;
    reviewDecision: DiagnosisReviewWindowDecision;
    jointDecision: DiagnosisJointEventDecision;
    audit: DiagnosisEventDecisionAudit;
    referenceAnchorCount: number;
    durationMs: number;
};
type WorkerResponse = {
    requestId: string;
    targets?: WorkerTargetResult[];
    error?: string;
};
type WorkerRequest = {
    requestId: string;
    sitePath: string;
    cofechaOutPath: string;
    targetIds: string[];
    cofechaFlaggedIds: string[];
    pairwiseClusterIds: string[];
    usePairwiseBootstrap: boolean;
    runId: string;
    rwlHash: string;
};
type Checkpoint = {
    recoveredEvents: number;
    states: Array<{
        seriesId: string;
        remainingTruthYears: number[];
    }>;
};

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string): string | null => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteNode = join(repoRoot, "node_modules", "vite-node", "vite-node.mjs");
const workerScript = join(repoRoot, "scripts", "co612-review-window-worker.ts");
const planPath = resolve(valueFor("--plan") ?? "");
const eligibilityPath = resolve(valueFor("--eligibility") ?? "");
const outputDir = resolve(valueFor("--output-dir")
    ?? join(repoRoot, "tmp", "itrdb-terminal-frontier-audit"));
const workerCount = Math.max(1, Math.min(16, Number(valueFor("--workers") ?? 8)));
const forcePairwise = args.includes("--force-pairwise");
const requestedFiles = new Set((valueFor("--files") ?? "")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
if (!planPath || !eligibilityPath) {
    throw new Error("usage: --plan <audit-plan.csv> --eligibility <reference-structure.json>");
}

const parsePlan = (text: string): PlanRow[] => text.split(/\r?\n/)
    .slice(1).filter(Boolean).map((line) => {
        const match = /^"([^"]+)","([^"]+)"$/.exec(line);
        if (!match) throw new Error(`invalid audit plan row: ${line}`);
        return { file: match[1], path: match[2] };
    });
const percentile = (values: readonly number[], probability: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)] ?? null;
};
const csvCell = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
};
const writeCsv = (path: string, rows: readonly Record<string, unknown>[]): void => {
    const headers = Object.keys(rows[0] ?? {});
    writeFileSync(path, [
        headers.map(csvCell).join(","),
        ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
    ].join("\n"), "utf8");
};
const eventStageSignature = (
    events: ReadonlyArray<DiagnosisEventDecisionAudit["finalEvents"][number]>,
): string => events.map((event) => (
    `${event.eventType}:${event.shiftYears ?? ""}@${event.startYear}-${event.endYear}`
    + `#${event.topYear ?? ""}[${event.algorithmSources.join("+")}]`
)).join(";");

class DiagnosisWorkerClient {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<string, {
        resolve: (response: WorkerResponse) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();

    constructor(index: number) {
        this.child = spawn(process.execPath, [viteNode, workerScript], {
            cwd: repoRoot,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on("line", (line) => {
            if (!line.startsWith("CO612_WORKER_RESPONSE ")) return;
            const response = JSON.parse(
                line.slice("CO612_WORKER_RESPONSE ".length),
            ) as WorkerResponse;
            const pending = this.pending.get(response.requestId);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(response.requestId);
            if (response.error) pending.reject(new Error(response.error));
            else pending.resolve(response);
        });
        this.child.stderr.on("data", (data) => {
            appendFileSync(join(outputDir, `worker-${index}.log`), data);
        });
        this.child.on("exit", (code) => {
            this.pending.forEach(({ reject, timer }) => {
                clearTimeout(timer);
                reject(new Error(`diagnosis worker exited with code ${code}`));
            });
            this.pending.clear();
        });
    }

    request(request: WorkerRequest): Promise<WorkerResponse> {
        return new Promise((resolveRequest, rejectRequest) => {
            const timer = setTimeout(() => {
                this.pending.delete(request.requestId);
                rejectRequest(new Error(`diagnosis worker timed out: ${request.requestId}`));
            }, 15 * 60_000);
            this.pending.set(request.requestId, {
                resolve: resolveRequest,
                reject: rejectRequest,
                timer,
            });
            this.child.stdin.write(`${JSON.stringify(request)}\n`);
        });
    }

    close(): void {
        this.child.stdin.end();
    }
}

mkdirSync(outputDir, { recursive: true });
const eligibility = JSON.parse(readFileSync(eligibilityPath, "utf8")) as {
    rows: Array<{ file: string; metricEligibility: string }>;
};
const evaluable = new Set(eligibility.rows.filter((row) => (
    row.metricEligibility === "evaluable"
)).map((row) => row.file.toLowerCase()));
const plans = parsePlan(readFileSync(planPath, "utf8")).filter((plan) => (
    evaluable.has(plan.file.toLowerCase())
    && (requestedFiles.size === 0 || requestedFiles.has(plan.file.toLowerCase()))
));
const clients = Array.from({ length: workerCount }, (_, index) => (
    new DiagnosisWorkerClient(index + 1)
));

const diagnoseTargets = async (request: Omit<WorkerRequest, "requestId" | "targetIds"> & {
    file: string;
    targetIds: string[];
}): Promise<WorkerTargetResult[]> => {
    const chunks = Array.from({ length: clients.length }, () => [] as string[]);
    request.targetIds.forEach((seriesId, index) => chunks[index % chunks.length].push(seriesId));
    const responses = await Promise.all(chunks.map((targetIds, index) => (
        targetIds.length === 0
            ? Promise.resolve({ requestId: `${request.file}-${index}`, targets: [] })
            : clients[index].request({
                ...request,
                requestId: `${request.file}-${index}`,
                targetIds,
            })
    )));
    const order = new Map(request.targetIds.map((seriesId, index) => [seriesId, index]));
    return responses.flatMap((response) => response.targets ?? []).sort((left, right) => (
        (order.get(left.seriesId) ?? Infinity) - (order.get(right.seriesId) ?? Infinity)
    ));
};

const rows: Array<Record<string, unknown>> = [];
const fileSummaries: Array<Record<string, unknown>> = [];
for (const plan of plans) {
    const roundEntry = readdirSync(join(plan.path, "rounds"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .sort((left, right) => Number(right.name) - Number(left.name))[0];
    if (!roundEntry) throw new Error(`no saved terminal round for ${plan.file}`);
    const statePath = join(plan.path, "rounds", roundEntry.name, "state.rwl");
    const outPath = join(plan.path, "rounds", roundEntry.name, "VERYCOF.OUT");
    const checkpoint = JSON.parse(
        readFileSync(join(plan.path, "checkpoint.json"), "utf8"),
    ) as Checkpoint;
    const stateText = readFileSync(statePath, "utf8");
    const siteData = new Map(Array.from(
        parseRwl(stateText),
        ([seriesId, series]) => [seriesId, new Map(series.valuesByYear)],
    ));
    const canonicalIds = new Map(Array.from(siteData.keys(), (seriesId) => [
        seriesId.trim().toUpperCase(),
        seriesId,
    ]));
    const outText = readFileSync(outPath, "utf8");
    const flaggedIds = extractPart6FlaggedASeriesIds(
        splitReportByParts(outText).get("PART 6") ?? "",
    ).flatMap((seriesId) => {
        const canonical = canonicalIds.get(seriesId.trim().toUpperCase());
        return canonical ? [canonical] : [];
    });
    const pairwiseClusterIds = selectPairwiseBootstrapCluster(siteData);
    const targetStates = checkpoint.states.flatMap((state) => {
        const truthYear = state.remainingTruthYears[0];
        return Number.isInteger(truthYear)
            ? [{
                seriesId: state.seriesId,
                truthYear,
                remainingInSeries: state.remainingTruthYears.length,
            }]
            : [];
    });
    const diagnoses = await diagnoseTargets({
        file: plan.file,
        sitePath: statePath,
        cofechaOutPath: outPath,
        targetIds: targetStates.map((state) => state.seriesId),
        cofechaFlaggedIds: flaggedIds,
        pairwiseClusterIds,
        usePairwiseBootstrap: forcePairwise
            || siteData.size - new Set(flaggedIds).size < 3,
        runId: `terminal-frontier-audit-${plan.file}-${roundEntry.name}`,
        rwlHash: createHash("sha256").update(stateText).digest("hex"),
    });
    const diagnosisBySeries = new Map(diagnoses.map((row) => [row.seriesId, row]));
    const fileRows = targetStates.map((state) => {
        const diagnosis = diagnosisBySeries.get(state.seriesId);
        if (!diagnosis) throw new Error(`missing diagnosis for ${plan.file}/${state.seriesId}`);
        const primary = diagnosis.reviewEvent;
        const alternative = primary?.interpretationAmbiguity?.alternative ?? null;
        const options = [primary, alternative].filter(
            (event): event is DiagnosisEvent => event !== null,
        );
        const missingOptions = options.filter((event) => event.eventType === "missingRing");
        const covered = missingOptions.find((event) => (
            event.startYear <= state.truthYear && event.endYear >= state.truthYear
        )) ?? null;
        const chosen = covered ?? missingOptions[0] ?? primary;
        const category = covered
            ? covered === primary ? "correct-primary" : "correct-alternative"
            : !primary
                ? "refused"
                : missingOptions.length > 0
                    ? "window-miss"
                    : "wrong-operation";
        const years = [...(siteData.get(state.seriesId)?.keys() ?? [])];
        const newerEndpointDistance = years.length > 0
            ? Math.max(...years) - state.truthYear
            : null;
        const distance = chosen
            ? state.truthYear < chosen.startYear
                ? chosen.startYear - state.truthYear
                : state.truthYear > chosen.endYear
                    ? state.truthYear - chosen.endYear
                    : 0
            : null;
        return {
            file: plan.file,
            round: Number(roundEntry.name),
            recoveredBefore: checkpoint.recoveredEvents,
            seriesId: state.seriesId,
            truthYear: state.truthYear,
            remainingInSeries: state.remainingInSeries,
            newerEndpointDistance,
            category,
            acceptedInterpretation: covered !== null && covered === alternative
                ? "alternative"
                : covered !== null && covered === primary ? "primary" : null,
            primaryType: primary?.eventType ?? null,
            primaryShiftYears: primary?.shiftYears ?? null,
            primaryStart: primary?.startYear ?? null,
            primaryEnd: primary?.endYear ?? null,
            primaryTop: primary?.rankedYears[0]?.year ?? null,
            alternativeType: alternative?.eventType ?? null,
            alternativeStart: alternative?.startYear ?? null,
            alternativeEnd: alternative?.endYear ?? null,
            alternativeTop: alternative?.rankedYears[0]?.year ?? null,
            distance,
            finalReason: diagnosis.audit.finalReason,
            reviewReason: diagnosis.reviewDecision.reason,
            jointReason: diagnosis.jointDecision.reason,
            candidateProjected: eventStageSignature(
                diagnosis.audit.candidateProjectedEvents,
            ),
            detectedBeforeFusion: eventStageSignature(
                diagnosis.audit.detectedBeforeFusion,
            ),
            detectedAfterFusion: eventStageSignature(
                diagnosis.audit.detectedAfterFusion,
            ),
            retainedAfterEndpointGuard: eventStageSignature(
                diagnosis.audit.retainedAfterEndpointGuard,
            ),
            displayedBeforeLocator: eventStageSignature(
                diagnosis.audit.displayedBeforeLocator,
            ),
            finalEvents: eventStageSignature(diagnosis.audit.finalEvents),
            jointHypotheses: diagnosis.jointDecision.hypotheses.map((hypothesis) => (
                `${hypothesis.eventType}:${hypothesis.shiftYears ?? ""}`
                + `@${hypothesis.startYear}-${hypothesis.endYear}`
                + `#${hypothesis.topYear ?? ""}`
                + `{${hypothesis.sourceStage}:${hypothesis.supportStages.join("+")}`
                + `:c${hypothesis.claimCount}:l${hypothesis.locationEvidenceCount}}`
            )).join(";"),
            lagBefore: chosen?.evidence.lagBefore ?? null,
            lagAfter: chosen?.evidence.lagAfter ?? null,
            referenceAnchorCount: diagnosis.referenceAnchorCount,
            algorithmSources: chosen?.evidence.algorithmSources.join("+") ?? "",
            notes: chosen?.evidence.notes.join("|") ?? "",
        };
    });
    rows.push(...fileRows);
    const accepted = fileRows.filter((row) => row.category.startsWith("correct"));
    const distances = fileRows.flatMap((row) => typeof row.distance === "number"
        ? [row.distance]
        : []);
    fileSummaries.push({
        file: plan.file,
        round: Number(roundEntry.name),
        recoveredBefore: checkpoint.recoveredEvents,
        frontierSeries: fileRows.length,
        blockedEvents: targetStates.reduce((sum, state) => sum + state.remainingInSeries, 0),
        acceptedFrontiers: accepted.length,
        correctPrimary: fileRows.filter((row) => row.category === "correct-primary").length,
        correctAlternative: fileRows.filter(
            (row) => row.category === "correct-alternative",
        ).length,
        refused: fileRows.filter((row) => row.category === "refused").length,
        windowMiss: fileRows.filter((row) => row.category === "window-miss").length,
        wrongOperation: fileRows.filter((row) => row.category === "wrong-operation").length,
        medianDistance: percentile(distances, 0.5),
        p90Distance: percentile(distances, 0.9),
    });
    console.log(`AUDITED ${plan.file} ${accepted.length}/${fileRows.length}`);
}
clients.forEach((client) => client.close());

writeCsv(join(outputDir, "frontiers.csv"), rows);
writeCsv(join(outputDir, "files.csv"), fileSummaries);
writeFileSync(join(outputDir, "audit.json"), `${JSON.stringify({
    planPath,
    eligibilityPath,
    files: fileSummaries,
    cases: rows,
}, null, 2)}\n`, "utf8");
console.log(`ITRDB_TERMINAL_FRONTIERS ${JSON.stringify({
    outputDir,
    files: fileSummaries.length,
    cases: rows.length,
    accepted: rows.filter((row) => String(row.category).startsWith("correct")).length,
})}`);
