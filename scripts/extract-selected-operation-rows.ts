/** Extracts full yearly evidence only for the file-OOF operation identity selected per attempt. */
import { spawn } from "node:child_process";
import {
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    extractPart6FlaggedASeriesIds,
    splitReportByParts,
} from "@/features/cofecha/formatter";
import {
    loadRwl,
    scoreSelectedOperationRowsForEvaluation,
    sha256Bytes,
} from "./legacy-generalization/evaluator";

type TopRow = Record<string, string>;
type Step = {
    caseIndex: number;
    step: number;
    targetId: string;
};

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string, fallback = ""): string => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const runDir = resolve(valueFor("--run-dir"));
const operationTopPath = resolve(valueFor("--operation-top"));
const outputPath = resolve(valueFor("--output"));
const workerCount = Number(valueFor("--workers", "12"));
const workerIndexValue = valueFor("--worker-index");
const workerIndex = workerIndexValue === "" ? null : Number(workerIndexValue);
const scriptPath = fileURLToPath(import.meta.url);

const parseCsv = (text: string): TopRow[] => {
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

const partPath = (index: number): string => `${outputPath}.part-${index}.json`;

if (workerIndex === null) {
    mkdirSync(dirname(outputPath), { recursive: true });
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
        throw new Error(`selected-row worker failure: ${statuses.join(",")}`);
    }
    const rows = Array.from({ length: workerCount }, (_, index) => (
        JSON.parse(readFileSync(partPath(index), "utf8")) as unknown[]
    )).flat();
    writeFileSync(outputPath, `${JSON.stringify({
        schemaVersion: 1,
        runDir,
        operationTopPath,
        rows,
    }, null, 2)}\n`, "utf8");
    console.log(`SELECTED_OPERATION_ROWS_COMPLETE ${JSON.stringify({
        outputPath,
        attempts: rows.length,
    })}`);
} else {
    const steps = JSON.parse(readFileSync(join(runDir, "steps.json"), "utf8")) as Step[];
    const stepById = new Map(steps.map((step) => [
        `${step.caseIndex}:${step.step}`,
        step,
    ]));
    const attemptDirs = findAttemptDirectories(join(runDir, "workers"));
    const selected = parseCsv(readFileSync(operationTopPath, "utf8"))
        .filter((row) => row.family !== "Clean")
        .filter((row) => row.event_type !== "wholeSeriesMove")
        .filter((_, index) => index % workerCount === workerIndex);
    const output = [];
    for (const [index, row] of selected.entries()) {
        const match = row.attempt_id.match(/^evaluation:(\d+):(\d+)$/);
        if (!match) continue;
        const key = `${Number(match[1])}:${Number(match[2])}`;
        const step = stepById.get(key);
        const directory = attemptDirs.get(key);
        if (!step || !directory) continue;
        const statePath = join(directory, "state.rwl");
        const outPath = join(directory, "VERYCOF.OUT");
        const loaded = await loadRwl(statePath, "tucson-auto");
        const outText = readFileSync(outPath, "utf8");
        const part6 = splitReportByParts(outText).get("PART 6") ?? "";
        const scored = scoreSelectedOperationRowsForEvaluation({
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
            runId: `selected-operation-${workerIndex}-${key}`,
            eventType: row.event_type as "missingRing" | "falseRing" | "partialMove",
            shiftYears: Number(row.shift_years),
        });
        output.push({
            attemptId: row.attempt_id,
            fileId: row.file_id,
            family: row.family,
            eventType: row.event_type,
            shiftYears: Number(row.shift_years),
            operationProbability: Number(row.operation_probability),
            scored,
        });
        if ((index + 1) % 10 === 0) {
            console.log(
                `SELECTED_OPERATION_ROWS worker=${workerIndex}`
                + ` attempts=${index + 1}/${selected.length}`,
            );
        }
    }
    writeFileSync(partPath(workerIndex), `${JSON.stringify(output)}\n`, "utf8");
}
