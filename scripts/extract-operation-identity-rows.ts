/** Extract full yearly evidence for a bounded, truth-blind set of operation identities. */
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
    scoreOperationIdentityRowsForEvaluation,
    sha256Bytes,
} from "./legacy-generalization/evaluator";

type IdentityRow = Record<string, string>;
type LocalEventType = "missingRing" | "falseRing" | "partialMove";
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
const identitiesPath = resolve(valueFor("--operation-identities"));
const outputDir = resolve(valueFor("--output-dir"));
const topK = Math.max(1, Number(valueFor("--top-k", "8")));
const workerCount = Math.max(1, Number(valueFor("--workers", "8")));
const workerIndexValue = valueFor("--worker-index");
const workerIndex = workerIndexValue === "" ? null : Number(workerIndexValue);
const scriptPath = fileURLToPath(import.meta.url);

const parseCsv = (text: string): IdentityRow[] => {
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

const localEventType = (value: string): value is LocalEventType => (
    value === "missingRing" || value === "falseRing" || value === "partialMove"
);

const selectIdentities = (rows: readonly IdentityRow[]): IdentityRow[] => {
    const local = rows.filter((row) => localEventType(row.event_type));
    const ordered = [...local].sort((left, right) => (
        Number(right.operation_probability) - Number(left.operation_probability)
        || Number(right.package_identity) - Number(left.package_identity)
        || Math.abs(Number(left.shift_years)) - Math.abs(Number(right.shift_years))
    ));
    const selected = new Map<string, IdentityRow>();
    const add = (row: IdentityRow): void => {
        selected.set(`${row.event_type}:${Number(row.shift_years)}`, row);
    };
    ordered.slice(0, topK).forEach(add);
    ordered.filter((row) => row.package_identity === "1").forEach(add);
    (["missingRing", "falseRing", "partialMove"] as const).forEach((eventType) => {
        const best = ordered.find((row) => row.event_type === eventType);
        if (best) add(best);
    });
    return [...selected.values()].sort((left, right) => (
        Number(right.operation_probability) - Number(left.operation_probability)
    ));
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
        throw new Error(`operation-row worker failure: ${statuses.join(",")}`);
    }
    const parts = Array.from({ length: workerCount }, (_, index) => partPath(index));
    writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify({
        schemaVersion: 1,
        runDir,
        identitiesPath,
        topK,
        selection: "top-k-plus-product-package-plus-best-per-local-type",
        parts,
    }, null, 2)}\n`, "utf8");
    console.log(`OPERATION_IDENTITY_ROWS_COMPLETE ${JSON.stringify({
        outputDir,
        topK,
        parts: parts.length,
    })}`);
} else {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(partPath(workerIndex), "", "utf8");
    const steps = JSON.parse(readFileSync(join(runDir, "steps.json"), "utf8")) as Step[];
    const stepById = new Map(steps.map((step) => [
        `${step.caseIndex}:${step.step}`,
        step,
    ]));
    const attemptDirs = findAttemptDirectories(join(runDir, "workers"));
    const grouped = new Map<string, IdentityRow[]>();
    parseCsv(readFileSync(identitiesPath, "utf8")).forEach((row) => {
        const group = grouped.get(row.attempt_id) ?? [];
        group.push(row);
        grouped.set(row.attempt_id, group);
    });
    const attempts = [...grouped.entries()]
        .filter(([attemptId]) => /^evaluation:\d+:\d+$/.test(attemptId))
        .filter((_, index) => index % workerCount === workerIndex);
    for (const [index, [attemptId, identityRows]] of attempts.entries()) {
        const match = attemptId.match(/^evaluation:(\d+):(\d+)$/);
        if (!match) continue;
        const key = `${Number(match[1])}:${Number(match[2])}`;
        const step = stepById.get(key);
        const directory = attemptDirs.get(key);
        if (!step || !directory) continue;
        const selected = selectIdentities(identityRows);
        if (selected.length === 0) continue;
        const statePath = join(directory, "state.rwl");
        const outPath = join(directory, "VERYCOF.OUT");
        const loaded = await loadRwl(statePath, "tucson-auto");
        const outText = readFileSync(outPath, "utf8");
        const part6 = splitReportByParts(outText).get("PART 6") ?? "";
        const scored = scoreOperationIdentityRowsForEvaluation({
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
            runId: `operation-identities-${workerIndex}-${key}`,
            operations: selected.map((row) => ({
                eventType: row.event_type as LocalEventType,
                shiftYears: Number(row.shift_years),
            })),
        });
        const scoreByIdentity = new Map(scored.map((operation) => [
            `${operation.eventType}:${operation.shiftYears}`,
            operation,
        ]));
        const first = identityRows[0];
        appendFileSync(partPath(workerIndex), `${JSON.stringify({
            attemptId,
            fileId: first.file_id,
            family: first.family,
            productCorrect: Number(first.product_correct),
            identities: selected.map((row, operationRank) => ({
                eventType: row.event_type,
                shiftYears: Number(row.shift_years),
                operationProbability: Number(row.operation_probability),
                operationRank: operationRank + 1,
                packageIdentity: Number(row.package_identity),
                scored: scoreByIdentity.get(
                    `${row.event_type}:${Number(row.shift_years)}`,
                ) ?? null,
            })),
        })}\n`, "utf8");
        if ((index + 1) % 10 === 0) {
            console.log(
                `OPERATION_IDENTITY_ROWS worker=${workerIndex}`
                + ` attempts=${index + 1}/${attempts.length}`,
            );
        }
    }
}
