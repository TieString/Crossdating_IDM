import { RwlFormat } from "./types";
import { stripBom, splitLines } from "./normalize";

export async function detectPrecision(text: string): Promise<number> {
  if (text.includes("-9999")) {
    return -9999;
  }
  return 999;
}

const DPLR_COMPACT_RE = /[1-9][0-9]*\([1-9][0-9]*F[1-9][0-9]*\.0\)~ *$/;
const TRIDAS_RE = /<tridas>/i;

function isEmptyFile(lines: string[]): boolean {
  return lines.length === 0 || lines.every((line) => line.trim().length === 0);
}

export function detectRwlFormat(text: string): RwlFormat {
  const lines = splitLines(stripBom(text));
  if (isEmptyFile(lines)) {
    return "unknown";
  }

  const first = lines[0] ?? "";

  // Align with dplR::read.rwl(format = "auto") detection order.
  if (DPLR_COMPACT_RE.test(first)) {
    return "compact";
  }

  if (/^HEADER:$/.test(first.trim())) {
    return "heidelberg";
  }

  if (TRIDAS_RE.test(first)) {
    return "tridas";
  }

  const moreLines = lines.slice(1, 21);
  if (moreLines.some((line) => TRIDAS_RE.test(line))) {
    return "tridas";
  }

  if (moreLines.some((line) => line.includes(","))) {
    return "csv";
  }

  return "tucson";
}
