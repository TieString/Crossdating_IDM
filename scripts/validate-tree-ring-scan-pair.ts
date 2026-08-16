import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { readRwlString } from "@/features/rwl";
import { matchTreeRingScanEntries, normalizeTreeRingScanSeriesKey } from "@/features/treeRingScans";

const [, , rwlArgument, imageArgument] = process.argv;

if (!rwlArgument || !imageArgument) {
    throw new Error(
        "用法: vite-node scripts/validate-tree-ring-scan-pair.ts <input.rwl> <scan-image>",
    );
}

const rwlPath = resolve(rwlArgument);
const imagePath = resolve(imageArgument);
const imageSeriesId = basename(imagePath, extname(imagePath));
const parsed = await readRwlString(await readFile(rwlPath, "utf8"));
const matchedFiles = matchTreeRingScanEntries(
    [{ name: basename(imagePath), isFile: true }],
    [...parsed.data.keys()],
);
const matchedFile = matchedFiles.get(normalizeTreeRingScanSeriesKey(imageSeriesId));
const matchingEntry = matchedFile
    ? [...parsed.data.entries()].find(
        ([seriesId]) => normalizeTreeRingScanSeriesKey(seriesId)
            === normalizeTreeRingScanSeriesKey(imageSeriesId),
    )
    : undefined;

if (!matchingEntry) {
    const availableIds = [...parsed.data.keys()];
    throw new Error(
        `影像 ${basename(imagePath)} 无法匹配 ${basename(rwlPath)} 中的序列。`
        + `文件内共有 ${availableIds.length} 条序列。`,
    );
}

const [seriesId, series] = matchingEntry;
const years = [...series.keys()].sort((left, right) => left - right);
const validWidths = [...series.values()].filter((width) => width !== null && Number.isFinite(width));

console.info(JSON.stringify({
    matched: true,
    rwlPath,
    imagePath,
    rwlFormat: parsed.format,
    seriesId,
    scanExtension: matchedFile?.extension,
    firstYear: years[0],
    latestYear: years.at(-1),
    yearCount: years.length,
    widthCount: validWidths.length,
}, null, 2));
