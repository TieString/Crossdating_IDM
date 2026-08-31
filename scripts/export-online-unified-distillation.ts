import { createReadStream, createWriteStream, readFileSync, readdirSync } from "node:fs";
import { once } from "node:events";
import { basename, join, resolve } from "node:path";
import { createGzip } from "node:zlib";
import { createInterface } from "node:readline";
import {
    buildOnlineUnifiedExecutablePackage,
    buildOnlineUnifiedEvidenceBundle,
    buildOnlineUnifiedLocationPackages,
    buildOnlineUnifiedOperationCandidates,
    type OnlineUnifiedLocationPackage,
    type OnlineUnifiedOperationCandidate,
    type OnlineUnifiedOperationIdentity,
    type OnlineUnifiedOperationProfilePeak,
} from "@/features/crossdating/diagnosis/onlineUnifiedEvidence";
import type {
    CrossdatingDiagnosis,
    DiagnosisEvent,
    DiagnosisEventDecisionAudit,
    DiagnosisJointEventDecision,
} from "@/features/crossdating/diagnosis/types";

type CsvRow = Record<string, string>;

type LegacySnapshot = {
    strictEvent?: DiagnosisEvent | null;
    reviewEvent?: DiagnosisEvent | null;
    audit?: DiagnosisEventDecisionAudit | null;
    operationGrid?: {
        jointDecision?: DiagnosisJointEventDecision | null;
        operations?: Array<Record<string, unknown>>;
        dynamicSelection?: Record<string, unknown> | null;
        unitSelection?: Record<string, unknown> | null;
        coreGlobalSlidingMatch?: { bestGlobalLag?: number } | null;
        cofechaCoreGlobalSlidingMatch?: { bestGlobalLag?: number } | null;
    } | null;
};

const parseArgs = (): Record<string, string> => Object.fromEntries(
    process.argv.slice(2).flatMap((argument) => {
        const match = /^--([^=]+)=(.*)$/.exec(argument);
        return match ? [[match[1]!, match[2]!]] : [];
    }),
);

const parseCsvLine = (line: string): string[] => {
    const output: string[] = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index]!;
        if (character === '"') {
            if (quoted && line[index + 1] === '"') {
                value += '"';
                index += 1;
            } else {
                quoted = !quoted;
            }
        } else if (character === "," && !quoted) {
            output.push(value);
            value = "";
        } else {
            value += character;
        }
    }
    output.push(value);
    return output;
};

const readCsv = async (path: string): Promise<CsvRow[]> => {
    const input = createInterface({
        input: createReadStream(path, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });
    let header: string[] | null = null;
    const output: CsvRow[] = [];
    for await (const line of input) {
        if (!header) {
            header = parseCsvLine(line.replace(/^\uFEFF/, ""));
            continue;
        }
        if (!line.trim()) continue;
        const values = parseCsvLine(line);
        output.push(Object.fromEntries(header.map((name, index) => (
            [name, values[index] ?? ""]
        ))));
    }
    return output;
};

const auditPaths = (runDir: string): Map<string, string> => {
    const output = new Map<string, string>();
    const workersDir = join(runDir, "workers");
    for (const worker of readdirSync(workersDir, { withFileTypes: true })) {
        if (!worker.isDirectory()) continue;
        const workerDir = join(workersDir, worker.name);
        for (const attempt of readdirSync(workerDir, { withFileTypes: true })) {
            if (!attempt.isDirectory()) continue;
            const match = /^case-(\d+)-step-(\d+)$/.exec(attempt.name);
            if (!match) continue;
            output.set(`${match[1]}:${match[2]}`, join(
                workerDir,
                attempt.name,
                "diagnosis-audit.json",
            ));
        }
    }
    return output;
};

const numeric = (value: unknown): number => {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : 0;
};

const candidateHeuristic = (candidate: OnlineUnifiedOperationCandidate): number => {
    const feature = candidate.features;
    return numeric(feature.claim_max_stage) * 4
        + Math.log1p(numeric(feature.claim_count))
        + numeric(feature.claim_max_confidence)
        + numeric(feature.grid_available) * 0.4
        + numeric(feature.dynamic_selected) * 3
        + numeric(feature.unit_selected) * 2
        + numeric(feature.raw_global_lag_match) * 2.5
        + numeric(feature.cofecha_global_lag_match) * 2.5
        + numeric(feature.grid_dynamic_score) * 3;
};

const locationHeuristic = (candidate: OnlineUnifiedLocationPackage): number => {
    const feature = candidate.features;
    return numeric(feature.claim_exact_count) * 6
        + numeric(feature.claim_within_2_count) * 2
        + numeric(feature.claim_within_6_count)
        + numeric(feature.claim_window_top_exact_count) * 12
        + numeric(feature.claim_window_exact_count) * 8
        + numeric(feature.claim_window_max_overlap_ratio) * 3
        + numeric(feature.grid_exact) * 4
        + numeric(feature.dynamic_exact) * 3
        + numeric(feature.unit_exact) * 2
        - numeric(feature.claim_min_distance) * 0.2;
};

const effectiveTeacherIdentity = (teacher: CsvRow): OnlineUnifiedOperationIdentity => ({
    eventType: teacher.event_type as OnlineUnifiedOperationIdentity["eventType"],
    shiftYears: numeric(teacher.shift_years),
});

const identityMatches = (
    candidate: OnlineUnifiedOperationIdentity,
    target: OnlineUnifiedOperationIdentity,
): boolean => candidate.eventType === target.eventType
    && candidate.shiftYears === target.shiftYears;

const workflowIdentityMatches = (
    candidate: OnlineUnifiedOperationIdentity,
    target: OnlineUnifiedOperationIdentity,
): boolean => identityMatches(candidate, target)
    || (
        target.eventType === "missingRing"
        && candidate.eventType === "partialMove"
        && candidate.shiftYears < -1
    );

const sampleOperationRows = (
    candidates: OnlineUnifiedOperationCandidate[],
    target: OnlineUnifiedOperationIdentity,
    workflowLabels = false,
): OnlineUnifiedOperationCandidate[] => {
    const selected = candidates.find((candidate) => identityMatches(candidate, target));
    const workflowCompatible = workflowLabels
        ? candidates.filter((candidate) => workflowIdentityMatches(candidate, target))
            .sort((left, right) => candidateHeuristic(right) - candidateHeuristic(left))
            .slice(0, 6)
        : [];
    const familyWinners = ["noEvent", "missingRing", "falseRing", "partialMove", "wholeSeriesMove"]
        .flatMap((eventType) => candidates
            .filter((candidate) => candidate.eventType === eventType)
            .sort((left, right) => candidateHeuristic(right) - candidateHeuristic(left))
            .slice(0, 6));
    const strongest = [...candidates]
        .sort((left, right) => candidateHeuristic(right) - candidateHeuristic(left))
        .slice(0, 32);
    return [...new Map([selected, ...workflowCompatible, ...familyWinners, ...strongest]
        .filter((candidate): candidate is OnlineUnifiedOperationCandidate => Boolean(candidate))
        .map((candidate) => [candidate.packageId, candidate])).values()];
};

const sampleLocationRows = (
    candidates: OnlineUnifiedLocationPackage[],
    targetYear: number,
    teacher?: CsvRow,
): OnlineUnifiedLocationPackage[] => {
    const startYear = teacher ? numeric(teacher.start_year) : 0;
    const endYear = teacher ? numeric(teacher.end_year) : 0;
    const topYear = teacher ? numeric(teacher.top_year) : targetYear;
    const exact = teacher ? candidates.find((candidate) => candidate.startYear === startYear
        && candidate.endYear === endYear
        && candidate.topYear === topYear) : undefined;
    const covering = candidates.filter((candidate) => (
        candidate.startYear <= targetYear && candidate.endYear >= targetYear
    ));
    const nearTruth = candidates.filter((candidate) => (
        Math.abs(candidate.topYear - targetYear) <= 6
    ));
    const strongest = [...candidates]
        .sort((left, right) => locationHeuristic(right) - locationHeuristic(left))
        .slice(0, 96);
    return [...new Map([exact, ...covering, ...nearTruth, ...strongest]
        .filter((candidate): candidate is OnlineUnifiedLocationPackage => Boolean(candidate))
        .map((candidate) => [candidate.packageId, candidate])).values()];
};

const main = async (): Promise<void> => {
    const args = parseArgs();
    const runDir = resolve(args["run-dir"] ?? "");
    const teacherPath = resolve(args.teacher ?? "");
    const outputPath = resolve(args.output ?? "online-unified-distillation.ndjson.gz");
    const searchRadiusYears = Number(args["search-radius-years"] ?? 25);
    const includeProfilePeaks = args["include-profile-peaks"] !== "false";
    const shardCount = Number(args["shard-count"] ?? 1);
    const shardIndex = Number(args["shard-index"] ?? 0);
    const gzipLevel = Number(args["gzip-level"] ?? 1);
    const labelMode = args["label-mode"] === "workflow-truth"
        ? "workflow-truth"
        : args["label-mode"] === "truth" ? "truth" : "teacher";
    if (!args["run-dir"] || !args.teacher) {
        throw new Error("--run-dir and --teacher are required");
    }
    if (!Number.isInteger(shardCount) || shardCount < 1
        || !Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
        throw new Error("shard index must be within a positive shard count");
    }
    if (!Number.isInteger(gzipLevel) || gzipLevel < 0 || gzipLevel > 9) {
        throw new Error("gzip level must be an integer from 0 through 9");
    }

    const [teachers, cases, steps] = await Promise.all([
        readCsv(teacherPath),
        readCsv(join(runDir, "cases.csv")),
        readCsv(join(runDir, "steps.csv")),
    ]);
    const fileByCase = new Map(cases.map((row) => [row.caseIndex, row.fileId]));
    const stepByCoordinates = new Map(steps.map((row) => [
        `${Number(row.caseIndex)}:${Number(row.step)}`,
        row,
    ]));
    const paths = auditPaths(runDir);
    const selectedTeachers = teachers.filter((_, index) => index % shardCount === shardIndex);
    const gzip = createGzip({ level: gzipLevel });
    const output = createWriteStream(outputPath);
    gzip.pipe(output);

    let written = 0;
    let operationOracle = 0;
    let locationOracle = 0;
    for (const teacher of selectedTeachers) {
        const match = /:(\d+):(\d+)$/.exec(teacher.attempt_id);
        if (!match) continue;
        const step = stepByCoordinates.get(`${Number(match[1])}:${Number(match[2])}`);
        if (!step) continue;
        const auditPath = paths.get(`${match[1]}:${match[2]}`);
        if (!auditPath) continue;
        const payload = JSON.parse(readFileSync(auditPath, "utf8")) as {
            before?: LegacySnapshot;
        } & LegacySnapshot;
        const snapshot = payload.before ?? payload;
        const audit = snapshot.audit;
        const grid = snapshot.operationGrid;
        if (!audit || !grid) continue;
        const diagnosis = {
            events: snapshot.strictEvent ? [snapshot.strictEvent] : [],
            reviewEvents: snapshot.reviewEvent ? [snapshot.reviewEvent] : [],
            eventDecisionAudits: [audit],
            jointEventDecisions: grid.jointDecision ? [grid.jointDecision] : [],
        } as unknown as CrossdatingDiagnosis;
        const bundle = buildOnlineUnifiedEvidenceBundle({
            diagnosis,
            seriesId: audit.seriesId,
            operations: (grid.operations ?? []).map((operation) => ({
                eventType: String(operation.eventType) as "missingRing" | "falseRing" | "partialMove",
                shiftYears: numeric(operation.shiftYears),
                bestYear: numeric(operation.bestYear),
                dynamicScore: numeric(operation.dynamicScore),
                bestRawGain: numeric(operation.bestRawGain),
                bestDifferenceGain: numeric(operation.bestDifferenceGain),
                bestCombinedGain: numeric(operation.bestCombinedGain),
                topThreeDifferenceGain: numeric(operation.topThreeDifferenceGain),
                remoteDifferenceMargin: numeric(operation.remoteDifferenceMargin),
                baselineLag: numeric(operation.baselineLag),
                profilePeaks: Array.isArray(operation.profilePeaks)
                    ? operation.profilePeaks.map((value) => {
                        const peak = value as Record<string, unknown>;
                        return {
                            source: String(peak.source) as OnlineUnifiedOperationProfilePeak["source"],
                            year: numeric(peak.year),
                            score: numeric(peak.score),
                            remoteMargin: numeric(peak.remoteMargin),
                        };
                    }) : [],
                yearProfile: Array.isArray(operation.yearProfile)
                    ? operation.yearProfile.map((value) => {
                        const row = value as Record<string, unknown>;
                        return {
                            year: numeric(row.year),
                            rawGain: numeric(row.rawGain),
                            differenceGain: numeric(row.differenceGain),
                            combinedGain: numeric(row.combinedGain),
                            sideStepScore: numeric(row.sideStepScore),
                            sideMinimumAdvantage: numeric(row.sideMinimumAdvantage),
                            correctedSideSupport: numeric(row.correctedSideSupport),
                        };
                    }) : [],
            })),
            dynamicSelection: grid.dynamicSelection ? {
                eventType: String(grid.dynamicSelection.eventType) as "missingRing" | "falseRing" | "partialMove",
                shiftYears: numeric(grid.dynamicSelection.shiftYears),
                bestYear: numeric(grid.dynamicSelection.bestYear),
                score: numeric(grid.dynamicSelection.score),
                scoreMargin: numeric(grid.dynamicSelection.scoreMargin),
                shiftScoreMargin: grid.dynamicSelection.shiftScoreMargin === null
                    || grid.dynamicSelection.shiftScoreMargin === undefined
                    ? null : numeric(grid.dynamicSelection.shiftScoreMargin),
            } : null,
            unitSelection: grid.unitSelection ? {
                eventType: String(grid.unitSelection.eventType) as "missingRing" | "falseRing" | "partialMove",
                shiftYears: numeric(grid.unitSelection.shiftYears),
                bestYear: numeric(grid.unitSelection.bestYear),
                score: numeric(grid.unitSelection.score),
                scoreMargin: numeric(grid.unitSelection.scoreMargin),
                shiftScoreMargin: grid.unitSelection.shiftScoreMargin === null
                    || grid.unitSelection.shiftScoreMargin === undefined
                    ? null : numeric(grid.unitSelection.shiftScoreMargin),
            } : null,
            rawGlobalLag: numeric(grid.coreGlobalSlidingMatch?.bestGlobalLag),
            cofechaGlobalLag: numeric(grid.cofechaCoreGlobalSlidingMatch?.bestGlobalLag),
        });
        if (!bundle) continue;
        const usesTruth = labelMode !== "teacher";
        const workflowLabels = labelMode === "workflow-truth";
        const targetIdentity = usesTruth
            ? step.family === "Clean"
                ? { eventType: "noEvent" as const, shiftYears: 0 }
                : {
                    eventType: step.diagnosedTruthType as OnlineUnifiedOperationIdentity["eventType"],
                    shiftYears: numeric(step.diagnosedTruthShiftYears),
                }
            : effectiveTeacherIdentity(teacher);
        const targetYear = usesTruth
            ? numeric(step.diagnosedTruthYear)
            : numeric(teacher.top_year);
        const allOperations = buildOnlineUnifiedOperationCandidates(bundle);
        const operationHit = allOperations.some((candidate) => (
            workflowLabels
                ? workflowIdentityMatches(candidate, targetIdentity)
                : identityMatches(candidate, targetIdentity)
        ));
        operationOracle += Number(operationHit);
        const sampledOperations = sampleOperationRows(
            allOperations,
            targetIdentity,
            workflowLabels,
        );
        const operationRows = sampledOperations.map(
            (candidate) => ({
                packageId: candidate.packageId,
                eventType: candidate.eventType,
                shiftYears: candidate.shiftYears,
                label: Number(workflowLabels
                    ? workflowIdentityMatches(candidate, targetIdentity)
                    : identityMatches(candidate, targetIdentity)),
                features: candidate.features,
            }),
        );
        let locationRows: Array<Record<string, unknown>> = [];
        let locationHit = targetIdentity.eventType === "noEvent"
            || targetIdentity.eventType === "wholeSeriesMove";
        const positiveLocalOperations = sampledOperations.filter((candidate) => (
            candidate.eventType !== "noEvent"
            && candidate.eventType !== "wholeSeriesMove"
            && (workflowLabels
                ? workflowIdentityMatches(candidate, targetIdentity)
                : identityMatches(candidate, targetIdentity))
        ));
        const locationOperations = positiveLocalOperations;
        if (locationOperations.length > 0) {
            locationRows = locationOperations.flatMap((operation) => {
                const claimWindowKeys = new Set(bundle.claims.filter((claim) => (
                    claim.eventType === operation.eventType
                    && claim.shiftYears === operation.shiftYears
                    && claim.topYear !== null
                )).map((claim) => (
                    `${claim.topYear}:${claim.startYear}:${claim.endYear}`
                )));
                const locations = buildOnlineUnifiedLocationPackages(bundle, operation, {
                    compactWindowPerYear: true,
                    searchRadiusYears,
                    includeProfilePeaks,
                    includeYearProfile: true,
                    includeWindow: (candidate) => (
                        !usesTruth
                        || Math.abs(candidate.topYear - targetYear) <= 6
                        || Math.abs(
                            (candidate.startYear + candidate.endYear) / 2
                            - candidate.topYear,
                        ) <= 0.5
                        || claimWindowKeys.has(
                            `${candidate.topYear}:${candidate.startYear}:${candidate.endYear}`,
                        )
                    ),
                });
                const sampled = sampleLocationRows(
                    locations,
                    targetYear,
                    labelMode === "teacher" ? teacher : undefined,
                );
                const locationGroup = [
                    teacher.attempt_id,
                    operation.eventType,
                    operation.shiftYears,
                ].join("|");
                return sampled.map((candidate) => {
                    const executable = buildOnlineUnifiedExecutablePackage({
                        bundle,
                        candidate,
                        score: 0,
                        scoreMargin: 0,
                    });
                    const primary = executable?.event ?? null;
                    const alternative = primary?.interpretationAmbiguity?.alternative ?? null;
                    const candidateCoversTruth = candidate.startYear <= targetYear
                        && candidate.endYear >= targetYear;
                    const exactPrimary = identityMatches(candidate, targetIdentity);
                    const reviewedPrimary = workflowLabels
                        && targetIdentity.eventType === "missingRing"
                        && primary?.eventType === "partialMove"
                        && (primary.shiftYears ?? 0) < -1;
                    const exactAlternative = alternative !== null
                        && identityMatches({
                            eventType: alternative.eventType,
                            shiftYears: alternative.eventType === "missingRing"
                                ? -1
                                : alternative.eventType === "falseRing"
                                    ? 1
                                    : alternative.shiftYears ?? 0,
                        }, targetIdentity)
                        && alternative.startYear <= targetYear
                        && alternative.endYear >= targetYear;
                    return {
                        locationGroup,
                        packageId: candidate.packageId,
                        eventType: operation.eventType,
                        shiftYears: operation.shiftYears,
                        startYear: candidate.startYear,
                        endYear: candidate.endYear,
                        topYear: candidate.topYear,
                        width: candidate.width,
                        label: Number(usesTruth
                            ? candidateCoversTruth
                                && (exactPrimary || reviewedPrimary || exactAlternative)
                            : candidate.startYear === numeric(teacher.start_year)
                                && candidate.endYear === numeric(teacher.end_year)
                                && candidate.topYear === numeric(teacher.top_year)),
                        features: candidate.features,
                    };
                });
            });
            locationHit = locationRows.some((row) => row.label === 1);
        }
        locationOracle += Number(locationHit);
        const line = `${JSON.stringify({
            attemptId: teacher.attempt_id,
            fileId: fileByCase.get(match[1]!) ?? `case-${match[1]}`,
            teacherStatus: teacher.status,
            labelMode,
            family: step.family,
            targetYear: targetIdentity.eventType === "wholeSeriesMove"
                || targetIdentity.eventType === "noEvent" ? null : targetYear,
            targetIdentity,
            workflowOracle: operationHit && locationHit,
            operationRows,
            locationRows,
        })}\n`;
        if (!gzip.write(line)) await once(gzip, "drain");
        written += 1;
        if (written % 250 === 0) {
            process.stderr.write(
                `exported shard=${shardIndex}/${shardCount} ${written}/${selectedTeachers.length}\n`,
            );
        }
    }
    gzip.end();
    await new Promise<void>((resolveFinished, reject) => {
        output.on("finish", resolveFinished);
        output.on("error", reject);
    });
    process.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        output: outputPath,
        attempts: written,
        shardIndex,
        shardCount,
        gzipLevel,
        operationOracle: operationOracle / Math.max(1, written),
        locationOracle: locationOracle / Math.max(1, written),
        sourceRun: basename(runDir),
    }, null, 2)}\n`);
};

void main();
