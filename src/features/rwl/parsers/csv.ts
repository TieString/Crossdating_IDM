import { RwlReadOptions, RwlReadResult, RwlSiteData } from "../types";
import { ensureSeries, splitLines, stripBom, toIntOrNull, toNumOrNull } from "../normalize";
import { RwlParseError } from "../errors";

function splitCsvLine(line: string, delim: string): string[] {
  // 简化版 CSV：支持引号包裹
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { q = !q; continue; }
    if (!q && c === delim) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

export function parseCsv(text: string, opts: RwlReadOptions = {}): RwlReadResult {
  const delim = opts.csvDelimiter ?? ",";
  const lines = splitLines(stripBom(text)).filter(l => l.trim().length > 0);

  if (lines.length === 0) throw new RwlParseError("csv: empty", "csv");

  const head = splitCsvLine(lines[0], delim);
  const data: RwlSiteData = new Map();
  const warnings: string[] = [];

  // 形式 A：长表：series,year,value（列名不强制，按位置）
  if (head.length >= 3 && lines.length >= 2) {
    const r1 = splitCsvLine(lines[1], delim);
    const y = toIntOrNull(r1[1] ?? "");
    const v = toNumOrNull(r1[2] ?? "");
    if (r1.length >= 3 && y !== null && v !== null) {
      for (let i = 1; i < lines.length; i++) {
        const cols = splitCsvLine(lines[i], delim);
        if (cols.length < 3) continue;
        const id = (cols[0] ?? "").trim();
        const year = toIntOrNull(cols[1] ?? "");
        const val = toNumOrNull(cols[2] ?? "");
        if (!id || year === null) continue;
        ensureSeries(data, id).set(year, val);
      }
      if (data.size === 0) throw new RwlParseError("csv: long format parsed none", "csv");
      return { format: "csv", data, warnings };
    }
  }

  // 形式 B：宽表：第一列 year，其余列是 series ID
  // header: Year, A, B, C...
  const yearHeaderIdx = 0;
  const seriesIds = head.slice(1).map(s => s.trim()).filter(Boolean);
  if (seriesIds.length === 0) throw new RwlParseError("csv: cannot detect long/wide", "csv");

  for (const id of seriesIds) ensureSeries(data, id);

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], delim);
    const year = toIntOrNull(cols[yearHeaderIdx] ?? "");
    if (year === null) continue;
    for (let j = 0; j < seriesIds.length; j++) {
      const id = seriesIds[j];
      const val = toNumOrNull(cols[j + 1] ?? "");
      data.get(id)!.set(year, val);
    }
  }

  if (data.size === 0) throw new RwlParseError("csv: wide format parsed none", "csv");
  return { format: "csv", data, warnings };
}