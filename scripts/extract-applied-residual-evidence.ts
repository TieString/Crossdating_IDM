/** Extract truth-blind residual chronology after virtually applying one proposal. */
import { spawn } from "node:child_process";
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
    loadRwl,
    scoreAppliedOperationResidualForEvaluation,
    sha256Bytes,
} from "./legacy-generalization/evaluator";

type ProposalRow = Record<string, string>;
type EvaluatedEventType = "missingRing" | "falseRing" | "partialMove"
    | "wholeSeriesMove" | "noEvent";
type Step = { caseIndex: number; step: number; targetId: string };

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string, fallback = ""): string => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const runDir = resolve(valueFor("--run-dir"));
const proposalsPath = resolve(valueFor("--proposals"));
const outputDir = resolve(valueFor("--output-dir"));
const workerCount = Math.max(1, Number(valueFor("--workers", "8")));
const workerIndexValue = valueFor("--worker-index");
const workerIndex = workerIndexValue === "" ? null : Number(workerIndexValue);
const scriptPath = fileURLToPath(import.meta.url);

const parseCsv = (text: string): ProposalRow[] => {
    const lines = text.trim().split(/\r?\n/);
    const parseLine = (line: string): string[] => {
        const values: string[] = [];
        let value = "";
        let quoted = false;
        for (let index = 0; index < line.length; index += 1) {
            const char = line[index];
            if (char === '"') {
                if (quoted && line[index + 1] === '"') {
                    value += '"';
                    index += 1;
                } else {
                    quoted = !quoted;
                }
            } else if (char === "," && !quoted) {
                values.push(value);
                value = "";
            } else {
                value += char;
            }
        }
        values.push(value);
        return values;
    };
    const headers = parseLine(lines[0]);
    return lines.slice(1).map((line) => Object.fromEntries(
        parseLine(line).map((value, index) => [headers[index], value]),
    ));
};

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

const flatten = (
    value: unknown,
    prefix = "residual",
    output: Record<string, string | number | boolean | null> = {},
): Record<string, string | number | boolean | null> => {
    if (value === null || value === undefined) {
        output[prefix] = null;
    } else if (typeof value === "object" && !Array.isArray(value)) {
        Object.entries(value).forEach(([key, child]) => {
            flatten(child, `${prefix}_${key}`, output);
        });
    } else if (typeof value === "string"
        || typeof value === "number"
        || typeof value === "boolean") {
        output[prefix] = value;
    }
    return output;
};

const partPath = (index: number): string => join(outputDir, `part-${index}.ndjson`);

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
        throw new Error(`residual worker failure: ${statuses.join(",")}`);
    }
    const rows = Array.from({ length: workerCount }, (_, index) => (
        readFileSync(partPath(index), "utf8").split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
    )).flat().sort((left, right) => String(
        left.proposal_id ?? left.attempt_id,
    ).localeCompare(String(right.proposal_id ?? right.attempt_id)));
    writeFileSync(join(outputDir, "residual-evidence.json"), `${JSON.stringify({
        schemaVersion: 2,
        runDir,
        proposalsPath,
        rows,
    }, null, 2)}\n`, "utf8");
    console.log(`APPLIED_RESIDUAL_COMPLETE ${JSON.stringify({
        outputDir,
        attempts: rows.length,
    })}`);
} else {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(partPath(workerIndex), "", "utf8");
    const steps = JSON.parse(readFileSync(join(runDir, "steps.json"), "utf8")) as Step[];
    const stepById = new Map(steps.map((step) => [
        `${step.caseIndex}:${step.step}`,
        step,
    ]));
    const directories = findAttemptDirectories(join(runDir, "workers"));
    const proposals = parseCsv(readFileSync(proposalsPath, "utf8"))
        .filter((_, index) => index % workerCount === workerIndex);
    for (const [index, proposal] of proposals.entries()) {
        const match = proposal.attempt_id.match(/:(\d+):(\d+)$/);
        if (!match) continue;
        const key = `${Number(match[1])}:${Number(match[2])}`;
        const step = stepById.get(key);
        const directory = directories.get(key);
        if (!step || !directory) continue;
        const eventType = proposal.event_type as EvaluatedEventType;
        const supported = [
            "missingRing",
            "falseRing",
            "partialMove",
            "wholeSeriesMove",
            "noEvent",
        ] as string[];
        if (!supported.includes(eventType)) continue;
        const statePath = join(directory, "state.rwl");
        const outPath = join(directory, "VERYCOF.OUT");
        const loaded = await loadRwl(statePath, "tucson-auto");
        const outText = readFileSync(outPath, "utf8");
        const part6 = splitReportByParts(outText).get("PART 6") ?? "";
        const residual = scoreAppliedOperationResidualForEvaluation({
            siteData: loaded.siteData,
            targetId: step.targetId,
            context: {
                stateDir: directory,
                sitePath: statePath,
                outPath,
                outText,
                flaggedIds: extractPart6FlaggedASeriesIds(part6),
                rwlHash: sha256Bytes(readFileSync(statePath)),
            },
            runId: `applied-residual-${workerIndex}-${key}`,
            operation: {
                eventType,
                shiftYears: Number(proposal.shift_years),
                year: Number(proposal.year),
            },
        });
        appendFileSync(partPath(workerIndex), `${JSON.stringify({
            proposal_id: proposal.proposal_id || proposal.attempt_id,
            attempt_id: proposal.attempt_id,
            file_id: proposal.file_id,
            family: proposal.family,
            event_type: eventType,
            shift_years: Number(proposal.shift_years),
            year: Number(proposal.year),
            ...flatten(residual),
        })}\n`, "utf8");
        if ((index + 1) % 10 === 0) {
            console.log(
                `APPLIED_RESIDUAL worker=${workerIndex}`
                + ` attempts=${index + 1}/${proposals.length}`,
            );
        }
    }
}
