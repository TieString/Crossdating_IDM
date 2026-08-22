import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const valueFor = (name) => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? null : null;
};
const source = valueFor("--resolved-cases");
if (!source) throw new Error("--resolved-cases is required");
const perFileFamily = Number(valueFor("--per-file-family") ?? 4);
if (!Number.isInteger(perFileFamily) || perFileFamily < 1) {
    throw new Error("--per-file-family must be a positive integer");
}
const cases = JSON.parse(readFileSync(resolve(source), "utf8"));
const families = ["Clean", "A", "B", "C", "D"];
const fileIds = [...new Set(cases.map(({ fileId }) => fileId))].sort();
const selected = [];
for (const family of families) {
    for (const fileId of fileIds) {
        const group = cases.filter((entry) => (
            entry.family === family && entry.fileId === fileId
        )).sort((left, right) => left.index - right.index);
        if (group.length < perFileFamily) {
            throw new Error(`${fileId}/${family} has only ${group.length} cases`);
        }
        selected.push(...group.slice(0, perFileFamily));
    }
}
const manifest = {
    schemaVersion: 1,
    selection: "first cases by frozen case index within each file and family",
    perFileFamily,
    files: fileIds.length,
    families,
    cases: selected.length,
    caseIndices: selected.map(({ index }) => index),
    caseIds: selected.map(({ caseId }) => caseId),
};
const output = valueFor("--output");
if (output) writeFileSync(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
if (args.includes("--indices-only")) console.log(manifest.caseIndices.join(","));
else console.log(JSON.stringify(manifest));
