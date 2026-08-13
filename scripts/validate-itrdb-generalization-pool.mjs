import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const configPath = resolve(
    process.argv[2] ?? "docs/benchmarks/itrdb-current-generalization-config-v1.json",
);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const selection = config.generalizationSelection;
if (!selection) throw new Error("generalizationSelection is required");
const datasetRoot = resolve(config.itrdbRoot);
const normalizePath = (value) => value.replaceAll("\\", "/").toLowerCase();
const digest = (value) => createHash("sha256").update(value).digest("hex");

const priorPaths = new Set();
const priorHashes = new Set();
selection.priorManifestPaths.forEach((manifestPath) => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), "utf8"));
    Object.entries(manifest.fileSha256 ?? {}).forEach(([path, hash]) => {
        priorPaths.add(normalizePath(path));
        priorHashes.add(String(hash).toLowerCase());
    });
    (manifest.files ?? []).forEach((file) => {
        if (file.relativePath) priorPaths.add(normalizePath(file.relativePath));
        const hash = file.sourceSha256 ?? file.sha256;
        if (hash) priorHashes.add(String(hash).toLowerCase());
    });
});

const candidates = [];
const basenameCounts = new Map();
const scan = (directory) => {
    readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
            scan(path);
            return;
        }
        if (!entry.name.toLowerCase().endsWith(".rwl")) return;
        const relativePath = normalizePath(relative(datasetRoot, path));
        const sourceSha256 = digest(readFileSync(path));
        if (priorPaths.has(relativePath) || priorHashes.has(sourceSha256)) return;
        const key = entry.name.toLowerCase();
        basenameCounts.set(key, (basenameCounts.get(key) ?? 0) + 1);
        candidates.push({
            fileId: basename(entry.name, ".rwl"),
            basename: key,
            relativePath,
            sourceSha256,
        });
    });
};
scan(datasetRoot);

const selected = candidates
    .filter((file) => !selection.requireUniqueBasename
        || basenameCounts.get(file.basename) === 1)
    .sort((left, right) => digest(
        `${selection.fileSelectionSeed}:${left.relativePath}`,
    ).localeCompare(digest(
        `${selection.fileSelectionSeed}:${right.relativePath}`,
    )))
    .slice(0, selection.candidateFileCount);
const selectedIds = selected.map((file) => file.fileId);
if (JSON.stringify(selectedIds) !== JSON.stringify(config.fileIds)) {
    const firstMismatch = selectedIds.findIndex((fileId, index) => (
        fileId !== config.fileIds[index]
    ));
    throw new Error(
        `frozen candidate pool drifted at index ${firstMismatch}: `
        + `${selectedIds[firstMismatch]} != ${config.fileIds[firstMismatch]}`,
    );
}
console.log(`ITRDB_GENERALIZATION_POOL_VALID ${JSON.stringify({
    configPath,
    candidateFiles: selected.length,
    priorUniquePaths: priorPaths.size,
    priorUniqueHashes: priorHashes.size,
    overlapCount: 0,
    fileSelectionSeed: selection.fileSelectionSeed,
})}`);
