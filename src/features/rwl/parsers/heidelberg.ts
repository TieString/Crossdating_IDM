import { RwlReadOptions, RwlReadResult } from "../types";
import { splitLines, stripBom } from "../normalize";
import { parseTucson } from "./tucson";

// Heidelberg/FH 常见做法：去掉以 HEADER: 开头的头部块后，正文按 Tucson decadal 固定宽度读
export function parseHeidelberg(text: string, opts: RwlReadOptions = {}): RwlReadResult {
  const lines = splitLines(stripBom(text));
  const start = lines.findIndex(l => !/^\s*HEADER:/i.test(l));
  const body = (start >= 0 ? lines.slice(start) : lines).join("\n");
  return parseTucson(body, { ...opts, header: false });
}