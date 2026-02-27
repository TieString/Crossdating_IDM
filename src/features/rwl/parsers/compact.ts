import { RwlReadOptions, RwlReadResult, RwlSiteData } from "../types";
import { ensureSeries, nonEmptyNonCommentLines, splitLines, stripBom, toIntOrNull, toNumOrNull } from "../normalize";
import { RwlParseError } from "../errors";

export function parseCompact(text: string, _opts: RwlReadOptions = {}): RwlReadResult {
  const lines = nonEmptyNonCommentLines(splitLines(stripBom(text)));
  const data: RwlSiteData = new Map();
  const warnings: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const toks = line.split(/\s+/);
    if (toks.length < 3) {
      warnings.push(`compact: skip line ${i + 1} (need >=3 columns)`);
      continue;
    }

    const id = toks[0].trim();
    const year = toIntOrNull(toks[1]);
    const value = toNumOrNull(toks[2]);

    if (!id || year === null) {
      warnings.push(`compact: skip line ${i + 1} (bad id/year)`);
      continue;
    }

    const series = ensureSeries(data, id);
    series.set(year, value);
  }

  if (data.size === 0) throw new RwlParseError("compact: no series parsed", "compact");
  return { format: "compact", data, warnings };
}