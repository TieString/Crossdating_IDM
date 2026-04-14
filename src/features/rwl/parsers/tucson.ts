import { RwlReadOptions, RwlReadResult, RwlSiteData } from "../types";
import {
  ensureSeries,
  nonEmptyNonCommentLines,
  splitLines,
  stripBom,
  toIntOrNull,
} from "../normalize";
import { RwlParseError } from "../errors";

// Tucson/ITRDB 格式解析器。
// 支持两种变体：
// - 短格式（8+4）：编号 8 列，年份 4 列
// - 长格式（7+5）：编号 7 列，年份 5 列（用于负年代）
// 
// 关键特性：
// 1. 自动检测 long/short 格式（当 opts.long 未指定时）
// 2. 推导 stop marker 值
// 3. 返回 readOptions 用于格式透明性（保存时复现原格式）
// 
// 详见 RWL_FORMAT_SPEC.md#Tucson 格式规范

function splitFixed(line: string, widths: number[]): string[] {
  let pos = 0;
  const out: string[] = [];
  for (const w of widths) {
    out.push(line.slice(pos, pos + w));
    pos += w;
  }
  return out;
}

function isLikelyYear(yr: number | null): boolean {
  return yr !== null && yr >= -10000 && yr <= 10000;
}

function detectHeaderAuto(firstDataLine: string, long: boolean): boolean {
  if (firstDataLine.length < 12) return true;

  // Tucson has both 8+4(short) and 7+5(long) variants. In auto mode,
  // treat either valid year field as "no header" to avoid over-skipping.
  const shortYear = toIntOrNull(firstDataLine.slice(8, 12));
  const longYear = toIntOrNull(firstDataLine.slice(7, 12));

  if (long) {
    return !isLikelyYear(longYear);
  }
  return !(isLikelyYear(shortYear) || isLikelyYear(longYear));
}

export function parseTucson(text: string, opts: RwlReadOptions = {}): RwlReadResult {
  const edgeZeros = opts.edgeZeros ?? true;
  const stopMarker = opts.stopMarker ?? -9999;
  const header = opts.header ?? "auto";

  const raw = nonEmptyNonCommentLines(splitLines(stripBom(text)));
  if (raw.length === 0) return { format: "tucson", data: new Map(), warnings: [], readOptions: { tucsonLong: false, edgeZeros } };

  // 自动检测 long/short 格式（若未明确指定）
  let long: boolean = opts.long ?? false; // 默认为 false（8 列短格式）
  const autoDetectLong = opts.long === undefined;
  if (autoDetectLong) {
    // 尝试从第一个有效行推断格式
    // 短格式（8+4）vs 长格式（7+5）
    const firstLine = raw[0];
    const shortYear = toIntOrNull(firstLine.slice(8, 12));
    const longYear = toIntOrNull(firstLine.slice(7, 12));
    
    // 优先选择能解析出有效年份的格式
    if (isLikelyYear(longYear) && !isLikelyYear(shortYear)) {
      long = true;
    } else {
      long = false;
    }
  }

  let skip = 0;
  if (header === true) skip = 3;
  if (header === "auto") skip = detectHeaderAuto(raw[0], long) ? 3 : 0;

  const lines = raw.slice(skip);
  const data: RwlSiteData = new Map();
  const warnings: string[] = [];

  const widths = long
    ? [7, 5, ...Array(11).fill(6)]
    : [8, 4, ...Array(11).fill(6)];
  const totalWidth = widths.reduce((a, b) => a + b, 0);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line.trim()) continue;

    let idRaw = "";
    let yearRaw = "";
    let valFields: string[] = [];

    const padded = line.length < totalWidth ? line.padEnd(totalWidth, " ") : line;
    const fields = splitFixed(padded, widths);
    idRaw = fields[0];
    yearRaw = fields[1];
    valFields = fields.slice(2);

    let id = idRaw.trim();
    let year0 = toIntOrNull(yearRaw);

    // Fallback for whitespace-separated Tucson variants: if fixed-width
    // id/year are not reliable, retry with token parsing.
    const fixedLooksBad = !id || /\s/.test(id) || year0 === null;
    if (fixedLooksBad) {
      const toks = line.trim().split(/\s+/);
      if (toks.length >= 2) {
        idRaw = toks[0];
        yearRaw = toks[1];
        valFields = toks.slice(2, 2 + 11);
        id = idRaw.trim();
        year0 = toIntOrNull(yearRaw);
      }
    }

    if (!id || year0 === null) {
      warnings.push(`tucson: skip line ${li + 1} (bad id/year)`);
      continue;
    }

    const series = ensureSeries(data, id);

    // 每行有效值数：10 - (year % 10)，并允许额外 1 列容纳 stop marker
    const mod = ((year0 % 10) + 10) % 10;
    const fullPerRow = 10 - mod;
    const maxColsAllowed = fullPerRow + 1;

    for (let i = 0; i < Math.min(valFields.length, maxColsAllowed); i++) {
      const v0 = toIntOrNull(valFields[i]);
      if (v0 === null) continue;

      if (v0 === stopMarker){
        series.set(year0 + i, v0);
        break;
      }

      let v: number | null = v0;
      if (edgeZeros) {
        if (v < 0 && v !== stopMarker) v = null;
      } else {
        if (v <= 0 && v !== stopMarker) v = null;
      }

      series.set(year0 + i, v);
    }
  }

  if (data.size === 0) throw new RwlParseError("tucson: no series parsed", "tucson");

  return {
    format: "tucson",
    data,
    warnings,
    readOptions: {
      tucsonLong: long,
      edgeZeros,
    },
  };
}

// Tucson 格式导出：与 parseTucson 对称，确保读写一致
export function formatTucson(
  data: RwlSiteData,
  long: boolean,
  selectedTree?: string
): string {
  const idWidth = long ? 7 : 8;
  const yearWidth = long ? 5 : 4;

  if (selectedTree && selectedTree !== '全部') {
    const treeData = data.get(selectedTree);
    if (!treeData) return '';
    data = new Map([[selectedTree, treeData]]);
  }

  let result = '';
  data.forEach((treeMap, treeCode) => {
    const entries = Array.from(treeMap.entries()).sort((a, b) => a[0] - b[0]);
    let interruptFlag = false;

    entries.forEach(([year, width], index) => {
      const isFirst = index === 0;
      const isTenth = year % 10 === 0;
      const isLast = index === entries.length - 1;
      const widthStr = (width === null ? '' : width).toString().padStart(6, ' ');

      if (isFirst || isTenth || interruptFlag) {
        if (!isFirst) result += '\r\n';
        result += treeCode.padEnd(idWidth, ' ') + year.toString().padStart(yearWidth, ' ') + widthStr;
        interruptFlag = false;
      } else {
        result += widthStr;
      }

      if (width === -9999 && !isLast) {
        interruptFlag = true;
      }
    });

    result += '\r\n';
  });

  return result.trimEnd() + '\r\n';
}
