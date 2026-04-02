export * from "./types"
export * from "./detect"

// RWL 解析入口。
// 这里不直接做格式处理，而是负责：
// 1. 识别输入文本的格式；
// 2. 推导 stop marker；
// 3. 按优先级依次调用具体解析器。
// 这样上层只需要调用 readRwlString，就能拿到统一的解析结果。

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

  // 先尝试命中的格式，其余格式作为回退顺序。
  const fallback: RwlFormat[] = ["tucson", "compact", "heidelberg", "csv", "tridas"];
  const order: RwlFormat[] = detected === "unknown"
    ? fallback
    : [detected, ...fallback.filter(f => f !== detected)];

  // stopMarker 未显式传入时，从文本中自动推导
  if (opts.stopMarker === undefined) {
    opts.stopMarker = await detectPrecision(text);
  }
  
  return tryParseInOrder(text, order, opts);
}