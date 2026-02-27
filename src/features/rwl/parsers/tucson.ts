import { RwlReadOptions, RwlReadResult, RwlSiteData } from "../types";
import {
  ensureSeries,
  nonEmptyNonCommentLines,
  splitLines,
  stripBom,
  toIntOrNull,
} from "../normalize";
import { RwlParseError } from "../errors";

function splitFixed(line: string, widths: number[]): string[] {
  let pos = 0;
  const out: string[] = [];
  for (const w of widths) {
    out.push(line.slice(pos, pos + w));
    pos += w;
  }
  return out;
}

function detectHeaderAuto(firstDataLine: string): boolean {
  if (firstDataLine.length < 12) return true;
  const yearStr = firstDataLine.slice(8, 12);
  const yr = Number(yearStr.trim());
  if (!Number.isFinite(yr) || !Number.isInteger(yr) || yr < -10000 || yr > 10000) return true;
  return false;
}

export function parseTucson(text: string, opts: RwlReadOptions = {}): RwlReadResult {
  const long = opts.long ?? false;
  const edgeZeros = opts.edgeZeros ?? true;
  const stopMarker = opts.stopMarker ?? -9999;
  const header = opts.header ?? "auto";

  const raw = nonEmptyNonCommentLines(splitLines(stripBom(text)));
  if (raw.length === 0) return { format: "tucson", data: new Map(), warnings: [] };

  let skip = 0;
  if (header === true) skip = 3;
  if (header === "auto") skip = detectHeaderAuto(raw[0]) ? 3 : 0;

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

    if (line.includes("\t")) {
      const toks = line.trim().split(/\s+/);
      if (toks.length < 2) continue;
      idRaw = toks[0];
      yearRaw = toks[1];
      valFields = toks.slice(2, 2 + 11);
    } else {
      const padded = line.length < totalWidth ? line.padEnd(totalWidth, " ") : line;
      const fields = splitFixed(padded, widths);
      idRaw = fields[0];
      yearRaw = fields[1];
      valFields = fields.slice(2);
    }

    const id = idRaw.trim();
    const year0 = toIntOrNull(yearRaw);
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
  return { format: "tucson", data, warnings };
}