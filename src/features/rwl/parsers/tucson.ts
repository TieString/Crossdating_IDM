import { stopMarker } from "@/shared/constants";
import { RwlReadOptions, RwlReadResult, RwlSiteData, RwlTreeData } from "../types";
import {
  ensureSeries,
  nonEmptyNonCommentLines,
  splitLines,
  stripBom,
  toIntOrNull,
} from "../normalize";
import { RwlParseError } from "../errors";

// Tucson/ITRDB parser and formatter. Explicit 0 values are missing-ring years
// and are written as values; year gaps are exported as separate same-name segments.

function splitFixed(line: string, widths: number[]): string[] {
  let pos = 0;
  const out: string[] = [];

  for (const width of widths) {
    out.push(line.slice(pos, pos + width));
    pos += width;
  }

  return out;
}

function isLikelyYear(year: number | null): boolean {
  return year !== null && year >= -10000 && year <= 10000;
}

function detectHeaderAuto(firstDataLine: string, long: boolean): boolean {
  if (firstDataLine.length < 12) return true;

  const shortYear = toIntOrNull(firstDataLine.slice(8, 12));
  const longYear = toIntOrNull(firstDataLine.slice(7, 12));

  if (long) {
    return !isLikelyYear(longYear);
  }

  return !(isLikelyYear(shortYear) || isLikelyYear(longYear));
}

export function parseTucson(text: string, opts: RwlReadOptions = {}): RwlReadResult {
  const edgeZeros = opts.edgeZeros ?? true;
  const activeStopMarker = opts.stopMarker ?? -9999;
  const header = opts.header ?? "auto";

  const raw = nonEmptyNonCommentLines(splitLines(stripBom(text)));
  if (raw.length === 0) {
    return {
      format: "tucson",
      data: new Map(),
      warnings: [],
      readOptions: { tucsonLong: false, edgeZeros },
    };
  }

  let long = opts.long ?? false;
  const autoDetectLong = opts.long === undefined;

  if (autoDetectLong) {
    const firstLine = raw[0];
    const shortYear = toIntOrNull(firstLine.slice(8, 12));
    const longYear = toIntOrNull(firstLine.slice(7, 12));
    long = isLikelyYear(longYear) && !isLikelyYear(shortYear);
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
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;

    const padded = line.length < totalWidth ? line.padEnd(totalWidth, " ") : line;
    const fields = splitFixed(padded, widths);
    let idRaw = fields[0];
    let yearRaw = fields[1];
    let valFields = fields.slice(2);
    let id = idRaw.trim();
    let year0 = toIntOrNull(yearRaw);
    const fixedLooksBad = !id || /\s/.test(id) || year0 === null;

    if (fixedLooksBad) {
      const tokens = line.trim().split(/\s+/);

      if (tokens.length >= 2) {
        idRaw = tokens[0];
        yearRaw = tokens[1];
        valFields = tokens.slice(2, 13);
        id = idRaw.trim();
        year0 = toIntOrNull(yearRaw);
      }
    }

    if (!id || year0 === null) {
      warnings.push(`tucson: skip line ${lineIndex + 1} (bad id/year)`);
      continue;
    }

    const series = ensureSeries(data, id);
    const mod = ((year0 % 10) + 10) % 10;
    const fullPerRow = 10 - mod;
    const maxColsAllowed = fullPerRow + 1;

    for (let i = 0; i < Math.min(valFields.length, maxColsAllowed); i++) {
      const rawValue = toIntOrNull(valFields[i]);
      if (rawValue === null) continue;

      if (rawValue === activeStopMarker) {
        series.set(year0 + i, rawValue);
        break;
      }

      let value: number | null = rawValue;

      if (edgeZeros) {
        if (value < 0 && value !== activeStopMarker) value = null;
      } else {
        if (value <= 0 && value !== activeStopMarker) value = null;
      }

      series.set(year0 + i, value);
    }
  }

  if (data.size === 0) {
    throw new RwlParseError("tucson: no series parsed", "tucson");
  }

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

export interface RwlSegment {
  startYear: number;
  values: Array<[number, number | null]>;
}

const toTucsonValueField = (width: number | null) => (
  (width === null ? "" : width).toString().padStart(6, " ")
);

export function splitSeriesIntoRwlSegments(series: RwlTreeData): RwlSegment[] {
  const segments: RwlSegment[] = [];
  const entries = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
  let currentSegment: RwlSegment | null = null;
  let previousValueYear: number | null = null;

  entries.forEach(([year, width]) => {
    if (width === null || width === stopMarker.value) {
      currentSegment = null;
      previousValueYear = null;
      return;
    }

    if (!currentSegment || previousValueYear === null || year !== previousValueYear + 1) {
      currentSegment = {
        startYear: year,
        values: [],
      };
      segments.push(currentSegment);
    }

    currentSegment.values.push([year, width]);
    previousValueYear = year;
  });

  return segments;
}

export function formatRwlSeries(seriesName: string, segments: RwlSegment[], long: boolean): string {
  const idWidth = long ? 7 : 8;
  const yearWidth = long ? 5 : 4;
  const lines: string[] = [];

  segments.forEach((segment) => {
    let currentLine = "";
    let currentLineValueCount = 0;

    segment.values.forEach(([year, width], index) => {
      const startsNewLine = index === 0 || year % 10 === 0;
      const widthStr = toTucsonValueField(width);

      if (startsNewLine) {
        if (currentLine) {
          lines.push(currentLine);
        }

        currentLine = seriesName.padEnd(idWidth, " ") + year.toString().padStart(yearWidth, " ") + widthStr;
        currentLineValueCount = 1;
        return;
      }

      currentLine += widthStr;
      currentLineValueCount += 1;
    });

    if (currentLine) {
      if (currentLineValueCount >= 10) {
        const lastYear = segment.values[segment.values.length - 1][0];
        lines.push(currentLine);
        lines.push(
          seriesName.padEnd(idWidth, " ")
          + (lastYear + 1).toString().padStart(yearWidth, " ")
          + stopMarker.value.toString().padStart(6, " ")
        );
      } else {
        currentLine += stopMarker.value.toString().padStart(6, " ");
        lines.push(currentLine);
      }
    }
  });

  return lines.join("\r\n");
}

export function formatTucson(
  data: RwlSiteData,
  long: boolean,
  selectedTree?: string
): string {
  if (selectedTree && selectedTree !== "\u5168\u90e8") {
    const treeData = data.get(selectedTree);
    if (!treeData) return "";
    data = new Map([[selectedTree, treeData]]);
  }

  const seriesText: string[] = [];

  data.forEach((treeMap, treeCode) => {
    const segments = splitSeriesIntoRwlSegments(treeMap);
    const formattedSeries = formatRwlSeries(treeCode, segments, long);

    if (formattedSeries) {
      seriesText.push(formattedSeries);
    }
  });

  const result = seriesText.join("\r\n");
  return result ? `${result}\r\n` : "";
}
