export * from "./types"

import { RwlReadOptions, RwlReadResult, RwlFormat } from "./types";
import { detectPrecision, detectRwlFormat } from "./detect";
import { RwlParseError } from "./errors";
import { parseTucson } from "./parsers/tucson";
import { parseCompact } from "./parsers/compact";
import { parseCsv } from "./parsers/csv";
import { parseHeidelberg } from "./parsers/heidelberg";
import { parseTridas } from "./parsers/tridas";

function tryParseInOrder(text: string, order: RwlFormat[], opts: RwlReadOptions): RwlReadResult {
  const errors: string[] = [];
  for (const f of order) {
    try {
      if (f === "tucson") return parseTucson(text, opts);
      if (f === "compact") return parseCompact(text, opts);
      if (f === "csv") return parseCsv(text, opts);
      if (f === "heidelberg") return parseHeidelberg(text, opts);
      if (f === "tridas") return parseTridas(text, opts);
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`);
    }
  }
  throw new RwlParseError(`readRwlString failed:\n${errors.join("\n")}`, "unknown");
}

export async function readRwlString(text: string, opts: RwlReadOptions = {}): Promise<RwlReadResult> {
  if (opts.preferFormat) {
    return tryParseInOrder(text, [opts.preferFormat], opts);
  }

  const detected = detectRwlFormat(text);

  // 检测命中优先，其余作为回退
  const fallback: RwlFormat[] = ["tucson", "compact", "heidelberg", "csv", "tridas"];
  const order: RwlFormat[] = detected === "unknown"
    ? fallback
    : [detected, ...fallback.filter(f => f !== detected)];

  // 如果没有定义opts，则调用detectPrecision来检测文本中是否包含-9999，并将结果添加到opts中
  if (opts.stopMarker === undefined) {
    opts.stopMarker = await detectPrecision(text);
  }
  
  return tryParseInOrder(text, order, opts);
}