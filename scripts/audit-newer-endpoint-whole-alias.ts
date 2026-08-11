import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
    DiagnosisEventAuditSnapshot,
    DiagnosisEventDecisionAudit,
} from "@/features/crossdating/diagnosis/types";
import { parseRwl } from "@/features/crossdating/diagnosis/__tests__/rdmFixture";

type PlanRow = { file: string; path: string };

type EventOutcome = {
    response: boolean;
    eventType: string | null;
    operationCorrect: boolean;
    windowCovered: boolean;
    top1Exact: boolean;
    topYear: number | null;
    windowStart: number | null;
    windowEnd: number | null;
};

type Observation = {
    round: number;
    eventId: string;
    seriesId: string;
    truthYear: number;
    strict: EventOutcome;
    review: EventOutcome;
};

type SavedDiagnosis = {
    seriesId: string;
    audit?: DiagnosisEventDecisionAudit;
};

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string): string | null => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};

const planPath = resolve(valueFor("--plan") ?? "");
if (!planPath) throw new Error("usage: --plan <stage5-reference-mode-audit-plan.csv>");
const runRoot = valueFor("--run-root");
const maximumEndpointDistance = Number(valueFor("--max-distance") ?? 15);
const outputPath = resolve(
    valueFor("--output") ?? join(dirname(planPath), "newer-endpoint-whole-alias-audit.json"),
);

const parsePlan = (path: string): PlanRow[] => readFileSync(path, "utf8")
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((line) => {
        const separator = line.indexOf(",");
        const unquote = (value: string): string => value.trim().replace(/^"|"$/g, "");
        return {
            file: unquote(line.slice(0, separator)),
            path: unquote(line.slice(separator + 1)),
        };
    });

const jsonLines = <T>(path: string): T[] => readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);

const covers = (event: DiagnosisEventAuditSnapshot, truthYear: number): boolean => (
    event.startYear <= truthYear && truthYear <= event.endYear
);

const allAuditEvents = (audit: DiagnosisEventDecisionAudit) => [
    ...audit.candidateProjectedEvents.map((event) => ({ stage: "candidate", event })),
    ...audit.detectedBeforeFusion.map((event) => ({ stage: "detected", event })),
    ...audit.detectedAfterFusion.map((event) => ({ stage: "fused", event })),
    ...audit.retainedAfterEndpointGuard.map((event) => ({ stage: "retained", event })),
    ...audit.displayedBeforeLocator.map((event) => ({ stage: "displayed", event })),
    ...audit.locatorDecisions.flatMap((decision) => (
        decision.proposedEvent
            ? [{ stage: "locator-proposed", event: decision.proposedEvent }]
            : []
    )),
    ...audit.finalEvents.map((event) => ({ stage: "final", event })),
] as const;

const plans = parsePlan(planPath).map((plan) => ({
    ...plan,
    path: runRoot ? resolve(runRoot, plan.file) : plan.path,
}));

const rows = plans.flatMap((plan) => {
    const summary = JSON.parse(
        readFileSync(join(plan.path, "run-summary.json"), "utf8"),
    ) as { inputPath: string };
    const series = parseRwl(readFileSync(summary.inputPath, "utf8"));
    const endYears = new Map(Array.from(series, ([seriesId, value]) => [
        seriesId,
        Math.max(...value.valuesByYear.keys()),
    ]));
    const observations = jsonLines<Observation>(join(plan.path, "observations.jsonl"));
    const candidates = observations.filter((row) => {
        const endYear = endYears.get(row.seriesId);
        return endYear !== undefined
            && endYear - row.truthYear <= maximumEndpointDistance
            && row.review.eventType === "wholeSeriesMove"
            && !row.review.operationCorrect;
    });
    const firstByEvent = new Map<string, Observation>();
    candidates.forEach((row) => {
        const previous = firstByEvent.get(row.eventId);
        if (!previous || row.round < previous.round) firstByEvent.set(row.eventId, row);
    });
    const diagnosesByRound = new Map<number, Map<string, SavedDiagnosis>>();
    const diagnosisFor = (round: number, seriesId: string): SavedDiagnosis | null => {
        if (!diagnosesByRound.has(round)) {
            const path = join(
                plan.path,
                "rounds",
                String(round).padStart(4, "0"),
                "target-diagnoses.json",
            );
            if (!existsSync(path)) {
                diagnosesByRound.set(round, new Map());
                return null;
            }
            const saved = JSON.parse(readFileSync(path, "utf8")) as SavedDiagnosis[];
            diagnosesByRound.set(round, new Map(saved.map((row) => [row.seriesId, row])));
        }
        return diagnosesByRound.get(round)?.get(seriesId) ?? null;
    };
    return [...firstByEvent.values()].map((observation) => {
        const endYear = endYears.get(observation.seriesId)!;
        const audit = diagnosisFor(observation.round, observation.seriesId)?.audit;
        const missingHypotheses = audit
            ? allAuditEvents(audit)
                .filter(({ event }) => event.eventType === "missingRing")
                .map(({ stage, event }) => ({
                    stage,
                    startYear: event.startYear,
                    endYear: event.endYear,
                    topYear: event.topYear,
                    coversTruth: covers(event, observation.truthYear),
                    score: event.score,
                    scoreMargin: event.scoreMargin,
                    lagBefore: event.lagBefore,
                    lagAfter: event.lagAfter,
                    samplePairs: event.samplePairs,
                    algorithmSources: event.algorithmSources,
                    notes: event.notes,
                }))
            : [];
        return {
            file: plan.file,
            runDir: plan.path,
            eventId: observation.eventId,
            seriesId: observation.seriesId,
            truthYear: observation.truthYear,
            seriesEndYear: endYear,
            endpointDistance: endYear - observation.truthYear,
            firstWholeRound: observation.round,
            review: observation.review,
            missingHypotheses,
            coveringMissingHypothesisCount: missingHypotheses.filter(
                (row) => row.coversTruth,
            ).length,
        };
    });
});

const byFile = Object.fromEntries(plans.map(({ file }) => {
    const fileRows = rows.filter((row) => row.file === file);
    return [file, {
        wholeAliases: fileRows.length,
        withCoveringMissingHypothesis: fileRows.filter(
            (row) => row.coveringMissingHypothesisCount > 0,
        ).length,
    }];
}));

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify({
    planPath,
    runRoot: runRoot ? resolve(runRoot) : null,
    maximumEndpointDistance,
    totalWholeAliases: rows.length,
    withCoveringMissingHypothesis: rows.filter(
        (row) => row.coveringMissingHypothesisCount > 0,
    ).length,
    byFile,
    rows,
}, null, 2), "utf8");
console.log(JSON.stringify({
    totalWholeAliases: rows.length,
    withCoveringMissingHypothesis: rows.filter(
        (row) => row.coveringMissingHypothesisCount > 0,
    ).length,
    outputPath,
}));
