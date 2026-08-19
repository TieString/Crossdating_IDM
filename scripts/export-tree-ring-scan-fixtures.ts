import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { detectPrecision, readRwlString } from "@/features/rwl";
import {
    buildTreeRingGeometry,
    getRwlWidthUnitMillimetres,
    renderTreeRingSvg,
} from "@/components/WidthContainer/treeRingArtwork";

const [, , inputArgument, outputArgument] = process.argv;

if (!inputArgument || !outputArgument) {
    throw new Error(
        "用法: vite-node scripts/export-tree-ring-scan-fixtures.ts <input.rwl> <output-folder>",
    );
}

const inputPath = resolve(inputArgument);
const outputFolder = resolve(outputArgument);
const inputText = await readFile(inputPath, "utf8");
const stopMarkerValue = await detectPrecision(inputText);
const widthUnitMm = getRwlWidthUnitMillimetres(stopMarkerValue);
const parsed = await readRwlString(inputText, { stopMarker: stopMarkerValue });
await mkdir(outputFolder, { recursive: true });

const exported: Array<{ seriesId: string; fileName: string; ringCount: number }> = [];
for (const [seriesId, series] of parsed.data.entries()) {
    if (/[<>:"/\\|?*]/.test(seriesId)) {
        console.warn(`跳过无法作为 Windows 文件名的序列：${seriesId}`);
        continue;
    }
    const geometry = buildTreeRingGeometry(series, stopMarkerValue);
    if (!geometry) continue;
    const fileName = `${seriesId}.svg`;
    await writeFile(resolve(outputFolder, fileName), renderTreeRingSvg(geometry, "full"), "utf8");
    exported.push({ seriesId, fileName, ringCount: geometry.rings.length });
}

await writeFile(
    resolve(outputFolder, "tree-ring-scan-fixtures.json"),
    JSON.stringify({
        inputPath,
        outputFolder,
        generatedAt: new Date().toISOString(),
        stopMarkerValue,
        widthUnitMm,
        exported,
    }, null, 2),
    "utf8",
);

console.info(`已导出 ${exported.length} 个同名绘制版 SVG 到 ${outputFolder}`);
