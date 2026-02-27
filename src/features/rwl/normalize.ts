export function splitLines(input: string): string[] {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
}

export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// Tucson/FH 常见：行内 # 注释，且 # 出现在前 78 列视为整行注释
export function isCommentLine(line: string): boolean {
  const idx = line.indexOf("#");
  return idx >= 0 && idx <= 77;
}

export function nonEmptyNonCommentLines(lines: string[]): string[] {
  return lines
    .map(l => l.replace(/\s+$/g, ""))
    .filter(l => l.length > 0)
    .filter(l => !isCommentLine(l));
}

export function toIntOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

export function toNumOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function ensureSeries(map: Map<string, Map<number, number | null>>, id: string) {
  if (!map.has(id)) map.set(id, new Map());
  return map.get(id)!;
}