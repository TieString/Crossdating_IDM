/** Replays frozen frontier states with no COFECHA input to automatic diagnosis. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    extractPart6FlaggedASeriesIds,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import {
    diagnoseTruthBlind,
    loadRwl,
    sha256Bytes,
    type EvaluationReferenceStrategy,
} from "./legacy-generalization/evaluator";
import {
    matchWorkflowSuggestion,
} from "./itrdb-operation-capability/workflowSuggestionMetric";
import type { CapabilityTruth } from "./itrdb-operation-capability/types";
import type {
    InternalCompatibilityLinearModel,
    InternalMasterMethod,
    InternalTargetContribution,
} from "@/features/crossdating/internalReferenceModel";
import type {
    CofechaArImplementation,
    CofechaSplineImplementation,
} from "@/features/crossdating/reference";

type Step = {
    caseIndex: number;
    step: number;
    fileId: string;
    family: "Clean" | "A" | "B" | "C" | "D";
    targetId: string;
    diagnosedTruthId: string | null;
    diagnosedTruthType: CapabilityTruth["eventType"] | null;
    diagnosedTruthYear: number | null;
    diagnosedTruthShiftYears: number | null;
    workflowSuggestionCorrect: boolean;
    response: boolean;
};

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string, fallback = ""): string => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const runDir = resolve(valueFor("--run-dir"));
const outputDir = resolve(valueFor("--output-dir"));
const workerCount = Math.max(1, Number(valueFor("--workers", "8")));
const workerIndexValue = valueFor("--worker-index");
const workerIndex = workerIndexValue === "" ? null : Number(workerIndexValue);
const referenceStrategy = valueFor(
    "--reference-strategy",
    "pairwise-only",
) as EvaluationReferenceStrategy;
const internalMasterMethod = valueFor(
    "--internal-master-method",
    "weighted-huber",
) as InternalMasterMethod;
const internalTargetContribution = valueFor(
    "--internal-target-contribution",
    "exclude",
) as InternalTargetContribution;
const includeEvaluationLabels = valueFor(
    "--include-evaluation-labels",
    "false",
) === "true";
const includeOperationGrid = valueFor("--include-operation-grid", "false") === "true";
const includeDetailedAudit = valueFor("--include-detailed-audit", "false") === "true";
const failedAttemptsPath = valueFor("--failed-attempts-from");
const failedAttemptIds = failedAttemptsPath
    ? new Set((JSON.parse(readFileSync(resolve(failedAttemptsPath), "utf8")) as Array<{
        attemptId: string;
        truthId: string | null;
        workflowCorrect: boolean;
    }>).filter((row) => row.truthId !== null && !row.workflowCorrect)
        .map((row) => row.attemptId))
    : null;
const selectedFileIds = new Set(valueFor("--file-ids")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean));
const internalCompatibilityThreshold = Number(valueFor(
    "--internal-compatibility-threshold",
    "0.16239316239316237",
));
const internalCompatibilityModelPath = valueFor("--internal-compatibility-model");
const internalCompatibilityModel = internalCompatibilityModelPath
    ? (() => {
        const artifact = JSON.parse(readFileSync(resolve(
            internalCompatibilityModelPath,
        ), "utf8"));
        return {
            featureNames: artifact.featureNames,
            means: artifact.model.means,
            scales: artifact.model.scales,
            coefficients: artifact.model.coefficients,
            intercept: artifact.model.intercept,
            threshold: artifact.recommendedThreshold,
            safeStrictSuppressionThreshold:
                artifact.safeStrictSuppressionThreshold ?? null,
        } satisfies InternalCompatibilityLinearModel;
    })()
    : undefined;
const normalizeInternalSourceResiduals = valueFor(
    "--normalize-internal-source-residuals",
    "false",
) === "true";
const internalSplineImplementation = valueFor(
    "--internal-spline-implementation",
    "discrete-penalty",
) as CofechaSplineImplementation;
const internalArImplementation = valueFor(
    "--internal-ar-implementation",
    "current-aic",
) as CofechaArImplementation;
const usesStoredCofecha = referenceStrategy === "production"
    || referenceStrategy === "pairwise-with-cofecha-evidence"
    || referenceStrategy === "cofecha-master-without-diagnosis-evidence";
const scriptPath = fileURLToPath(import.meta.url);
const partPath = (index: number): string => join(outputDir, `part-${index}.ndjson`);

const findAttemptDirectories = (root: string): Map<string, string> => {
    const output = new Map<string, string>();
    const scan = (directory: string): void => {
        readdirSync(directory).forEach((entry) => {
            const path = join(directory, entry);
            if (!statSync(path).isDirectory()) return;
            const match = entry.match(/^case-(\d+)-step-(\d+)$/);
            if (match) {
                output.set(`${Number(match[1])}:${Number(match[2])}`, path);
            } else {
                scan(path);
            }
        });
    };
    scan(root);
    return output;
};

const rate = (numerator: number, denominator: number) => (
    denominator > 0 ? numerator / denominator : null
);

const oneSidedClusterLower = (
    rows: Array<{ fileId: string; correct: boolean }>,
    seed: string,
    replicates = 20000,
): number | null => {
    const byFile = new Map<string, boolean[]>();
    rows.forEach((row) => byFile.set(
        row.fileId,
        [...byFile.get(row.fileId) ?? [], row.correct],
    ));
    const files = [...byFile.keys()];
    if (files.length === 0) return null;
    let state = Number.parseInt(
        createHash("sha256").update(seed).digest("hex").slice(0, 8),
        16,
    ) || 1;
    const random = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
    };
    const estimates: number[] = [];
    for (let replicate = 0; replicate < replicates; replicate += 1) {
        let correct = 0;
        let total = 0;
        for (let index = 0; index < files.length; index += 1) {
            const file = files[Math.floor(random() * files.length)]!;
            const values = byFile.get(file)!;
            correct += values.filter(Boolean).length;
            total += values.length;
        }
        estimates.push(correct / Math.max(1, total));
    }
    estimates.sort((left, right) => left - right);
    return estimates[Math.floor(replicates * 0.05)] ?? null;
};

if (workerIndex === null) {
    mkdirSync(outputDir, { recursive: true });
    const statuses = await Promise.all(Array.from({ length: workerCount }, (_, index) => (
        new Promise<number>((complete, reject) => {
            const child = spawn(process.execPath, [
                scriptPath,
                ...args,
                `--worker-index=${index}`,
            ], {
                cwd: process.cwd(),
                env: process.env,
                stdio: "inherit",
                windowsHide: true,
            });
            child.once("error", reject);
            child.once("exit", (code) => complete(code ?? 1));
        })
    )));
    if (statuses.some((status) => status !== 0)) {
        throw new Error(`pairwise-only replay worker failure: ${statuses.join(",")}`);
    }
    const rows = Array.from({ length: workerCount }, (_, index) => (
        readFileSync(partPath(index), "utf8").split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
    )).flat();
    const eventRows = rows.filter((row) => row.truthId !== null);
    const cleanRows = rows.filter((row) => row.family === "Clean");
    const summarize = (selected: typeof eventRows) => ({
        attempts: selected.length,
        correct: selected.filter((row) => row.workflowCorrect).length,
        workflowAccuracy: rate(
            selected.filter((row) => row.workflowCorrect).length,
            selected.length,
        ),
        responseRate: rate(
            selected.filter((row) => row.response).length,
            selected.length,
        ),
        oneSided95Lower: oneSidedClusterLower(
            selected.map((row) => ({
                fileId: row.fileId,
                correct: row.workflowCorrect,
            })),
            `${referenceStrategy}:${selected[0]?.family ?? "overall"}`,
        ),
        referenceUnavailable: selected.filter((row) => row.error !== null).length,
    });
    const summary = {
        schemaVersion: 1,
        referenceStrategy,
        internalMasterMethod,
        internalTargetContribution,
        usesCofechaForEvaluationLabels: includeEvaluationLabels,
        includeOperationGrid,
        includeDetailedAudit,
        failedAttemptsPath: failedAttemptsPath || null,
        selectedFailureAttempts: failedAttemptIds?.size ?? null,
        selectedFileIds: [...selectedFileIds],
        internalCompatibilityThreshold,
        internalCompatibilityModelPath: internalCompatibilityModelPath || null,
        normalizeInternalSourceResiduals,
        internalSplineImplementation,
        internalArImplementation,
        usesCofechaMaster: referenceStrategy === "production"
            || referenceStrategy === "cofecha-master-without-diagnosis-evidence",
        usesCofechaPart6: usesStoredCofecha,
        passesCofechaTextToDiagnosis: referenceStrategy === "production"
            || referenceStrategy === "pairwise-with-cofecha-evidence",
        runDir,
        overall: summarize(eventRows),
        byFamily: Object.fromEntries(
            (["A", "B", "C", "D"] as const).map((family) => [
                family,
                summarize(eventRows.filter((row) => row.family === family)),
            ]),
        ),
        clean: {
            attempts: cleanRows.length,
            falsePositives: cleanRows.filter((row) => row.response).length,
            falsePositiveRate: rate(
                cleanRows.filter((row) => row.response).length,
                cleanRows.length,
            ),
        },
        productionComparison: {
            attempts: eventRows.length,
            productionCorrect: eventRows.filter(
                (row) => row.productionWorkflowCorrect,
            ).length,
            pairwiseOnlyCorrect: eventRows.filter((row) => row.workflowCorrect).length,
            correctedProductionFailures: eventRows.filter((row) => (
                !row.productionWorkflowCorrect && row.workflowCorrect
            )).length,
            regressedProductionCorrect: eventRows.filter((row) => (
                row.productionWorkflowCorrect && !row.workflowCorrect
            )).length,
        },
    };
    writeFileSync(join(outputDir, "rows.json"), `${JSON.stringify(rows, null, 2)}\n`);
    writeFileSync(join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`PAIRWISE_ONLY_REPLAY_COMPLETE ${JSON.stringify({
        outputDir,
        ...summary.overall,
        clean: summary.clean,
    })}`);
} else {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(partPath(workerIndex), "");
    const steps = JSON.parse(readFileSync(join(runDir, "steps.json"), "utf8")) as Step[];
    const directories = findAttemptDirectories(join(runDir, "workers"));
    const selected = steps
        .filter((step) => selectedFileIds.size === 0 || selectedFileIds.has(step.fileId))
        .filter((step) => failedAttemptIds === null || failedAttemptIds.has(
            `evaluation:${step.caseIndex}:${step.step}`,
        ))
        .filter((_, index) => index % workerCount === workerIndex);
    for (const [index, step] of selected.entries()) {
        const key = `${step.caseIndex}:${step.step}`;
        const directory = directories.get(key);
        if (!directory) continue;
        const statePath = join(directory, "state.rwl");
        const bytes = readFileSync(statePath);
        const loaded = await loadRwl(statePath, "tucson-auto");
        const outPath = join(directory, "VERYCOF.OUT");
        const usesCofechaEvidence = usesStoredCofecha;
        const evaluationOutText = usesCofechaEvidence || includeEvaluationLabels
            ? readFileSync(outPath, "utf8")
            : "";
        const outText = usesCofechaEvidence ? evaluationOutText : "";
        const flaggedIds = usesCofechaEvidence
            ? extractPart6FlaggedASeriesIds(
                splitReportByParts(outText).get("PART 6") ?? "",
            )
            : [];
        const evaluationFlaggedIds = includeEvaluationLabels
            ? extractPart6FlaggedASeriesIds(
                splitReportByParts(evaluationOutText).get("PART 6") ?? "",
            )
            : [];
        const snapshot = diagnoseTruthBlind({
            siteData: loaded.siteData,
            targetId: step.targetId,
            context: {
                stateDir: directory,
                sitePath: statePath,
                outPath: usesCofechaEvidence ? outPath : "",
                outText,
                flaggedIds,
                rwlHash: sha256Bytes(bytes),
            },
            runId: `${referenceStrategy}-${key}`,
            referenceStrategy,
            internalMasterMethod,
            internalTargetContribution,
            internalCompatibilityThreshold,
            normalizeInternalSourceResiduals,
            internalSplineImplementation,
            internalArImplementation,
            internalCompatibilityModel,
            includeOperationGrid,
        });
        const primary = snapshot.reviewEvent;
        const alternative = primary?.interpretationAmbiguity?.alternative ?? null;
        const truth: CapabilityTruth | null = step.diagnosedTruthId
            && step.diagnosedTruthType
            && step.diagnosedTruthShiftYears !== null
            ? {
                truthId: step.diagnosedTruthId,
                eventType: step.diagnosedTruthType,
                year: step.diagnosedTruthYear,
                shiftYears: step.diagnosedTruthShiftYears,
            }
            : null;
        const workflowMatch = truth
            ? matchWorkflowSuggestion(primary, alternative, [truth])
            : null;
        appendFileSync(partPath(workerIndex), `${JSON.stringify({
            attemptId: `evaluation:${step.caseIndex}:${step.step}`,
            fileId: step.fileId,
            family: step.family,
            targetId: step.targetId,
            truthId: truth?.truthId ?? null,
            truthType: truth?.eventType ?? null,
            truthYear: truth?.year ?? null,
            truthShiftYears: truth?.shiftYears ?? null,
            response: primary !== null,
            workflowCorrect: truth ? workflowMatch !== null : primary === null,
            strictResponse: snapshot.strictEvent !== null,
            predictedType: primary?.eventType ?? null,
            predictedShiftYears: primary
                ? primary.eventType === "missingRing"
                    ? -1
                    : primary.eventType === "falseRing"
                        ? 1
                        : primary.shiftYears ?? null
                : null,
            windowStart: primary?.startYear ?? null,
            windowEnd: primary?.endYear ?? null,
            referenceMode: snapshot.referenceMode,
            referenceAnchorCount: snapshot.referenceAnchorCount,
            internalTargetCompatibility: snapshot.internalTargetCompatibility ?? null,
            internalTargetIncompatibilityScore:
                snapshot.internalTargetIncompatibilityScore ?? null,
            internalTargetIncompatibilityProbability:
                snapshot.internalTargetIncompatibilityProbability ?? null,
            operationGrid: includeOperationGrid ? snapshot.operationGrid : undefined,
            candidates: includeDetailedAudit ? snapshot.candidates : undefined,
            eventDecisionAudit: includeDetailedAudit ? snapshot.audit : undefined,
            reviewDecision: includeDetailedAudit ? snapshot.reviewDecision : undefined,
            evaluationCofechaFlagged: includeEvaluationLabels
                ? evaluationFlaggedIds.includes(step.targetId)
                : null,
            productionWorkflowCorrect: step.workflowSuggestionCorrect,
            productionResponse: step.response,
            error: snapshot.error,
        })}\n`);
        if ((index + 1) % 10 === 0) {
            console.log(
                `PAIRWISE_ONLY_REPLAY worker=${workerIndex}`
                + ` attempts=${index + 1}/${selected.length}`,
            );
        }
    }
}
