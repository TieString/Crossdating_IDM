import { RwlFormat } from "./types";
import { nonEmptyNonCommentLines, stripBom, splitLines } from "./normalize";

export async function detectPrecision(text: string): Promise<number> {
    if(text.includes("-9999")) {
        return -9999;
    }
    return 999; // 默认返回 999，表示未找到 -9999
}

function looksLikeXml(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith("<?xml") || t.startsWith("<");
}

function isIntStr(s: string) {
  const n = Number(s);
  return Number.isFinite(n) && Number.isInteger(n);
}

function isNumStr(s: string) {
  const n = Number(s);
  return Number.isFinite(n);
}

export function detectRwlFormat(text: string): RwlFormat {
  const lines = nonEmptyNonCommentLines(splitLines(stripBom(text)));
  if (lines.length === 0) return "unknown";

  const head = lines.slice(0, 30).join("\n");
  const first = lines[0];

  if (looksLikeXml(head) && /tridas/i.test(head)) return "tridas";
  if (/^\s*HEADER:/i.test(first)) return "heidelberg";

  // Tucson/Compact 的 tab/空白分隔变体：id year v...
  if (first.includes("\t") || /\s{2,}/.test(first)) {
    const toks = first.trim().split(/\s+/);
    if (toks.length >= 3 && isIntStr(toks[1]) && isNumStr(toks[2])) {
      // 3 列更像 compact；>=4 且总列数不大更像 tucson(tab 变体通常 1+1+<=11)
      if (toks.length === 3) return "compact";
      if (toks.length <= 13) return "tucson";
    }
  }

  // Tucson fixed-width：同时尝试 8+4 与 7+5 两种 year 位置
  if (first.length >= 12) {
    const yA = first.slice(8, 12).trim(); // 8-char id + 4-digit year
    const yB = first.slice(7, 12).trim(); // 7-char id + 5-char year (long)
    if (isIntStr(yA) || isIntStr(yB)) return "tucson";
  }

  // CSV：优先认逗号/分号；tab 分隔的 csv 需要更强判别再加
  if ((first.includes(",") || first.includes(";")) && first.split(/,|;/).length >= 3) return "csv";

  // Compact（空白三列）
  {
    const toks = first.trim().split(/\s+/);
    if (toks.length >= 3 && isIntStr(toks[1]) && isNumStr(toks[2])) return "compact";
  }

  return "unknown";
}