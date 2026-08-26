import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name, fallback = "") => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};

const baselinePath = resolve(valueFor("--baseline-rows"));
const outputPath = resolve(valueFor("--output"));
const perFileFamily = Math.max(1, Number(valueFor("--per-file-family", "2")));
const includeFailures = valueFor("--include-failures", "false") === "true";
const rows = JSON.parse(readFileSync(baselinePath, "utf8"));
const clean = rows.filter((row) => row.family === "Clean");
const failures = rows.filter((row) => (
    row.truthId !== null && !row.workflowCorrect
));
const eligible = rows.filter((row) => row.truthId !== null && row.workflowCorrect);
const groups = new Map();
eligible.forEach((row) => {
    const key = `${row.fileId}\u0000${row.family}`;
    groups.set(key, [...groups.get(key) ?? [], row]);
});
const score = (row) => createHash("sha256")
    .update(`internal-reference-safety:${row.attemptId}`)
    .digest("hex");
const correctSample = Array.from(groups.values()).flatMap((group) => (
    [...group].sort((left, right) => score(left).localeCompare(score(right)))
        .slice(0, perFileFamily)
));
const selected = [...clean, ...correctSample, ...(includeFailures ? failures : [])];
const output = {
    schemaVersion: 1,
    baselinePath,
    perFileFamily,
    cleanAttempts: clean.length,
    correctEventAttempts: correctSample.length,
    failureAttempts: includeFailures ? failures.length : 0,
    files: [...new Set(selected.map((row) => row.fileId))],
    attemptIds: selected.map((row) => row.attemptId),
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`INTERNAL_REFERENCE_SAFETY_SAMPLE_COMPLETE ${JSON.stringify({
    outputPath,
    attempts: output.attemptIds.length,
    cleanAttempts: output.cleanAttempts,
    correctEventAttempts: output.correctEventAttempts,
    files: output.files.length,
})}`);
