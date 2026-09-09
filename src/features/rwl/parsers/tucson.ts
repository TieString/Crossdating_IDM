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
  const preserveNegativeMeasurements = opts.preserveNegativeMeasurements ?? false;
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
  const records: Array<{ id: string; year: number; values: Array<number | null> }> = [];

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

    const mod = ((year0 % 10) + 10) % 10;
    const fullPerRow = 10 - mod;
    const maxColsAllowed = fullPerRow + 1;
    const values = valFields.slice(0, maxColsAllowed).map(toIntOrNull);
    while (values.length && values[values.length - 1] === null) values.pop();
    records.push({ id, year: year0, values });
  }

  // Precision belongs to a terminated segment. In particular, a 999 at the
  // end of a decade row can still be a measurement when that segment continues.
  const segments: Array<{ id: string; marker: number; entries: Array<[number, number]> }> = [];
  let pending: Array<[number, number]> = [];
  let pendingId = "";
  const flush = (marker: number) => {
    if (pending.length) segments.push({ id: pendingId, marker, entries: pending });
    pending = [];
  };
  records.forEach((record, recordIndex) => {
    if (pending.length && pendingId !== record.id) flush(activeStopMarker);
    pendingId = record.id;
    const next = records[recordIndex + 1];
    for (let i = 0; i < record.values.length; i++) {
      const rawValue = record.values[i];
      if (rawValue === null) continue;
      const year = record.year + i;
      const continues = next?.id === record.id && next.year === year + 1;
      const terminal = rawValue === -9999 || (rawValue === 999
        && i === record.values.length - 1 && !continues);
      pending.push([year, rawValue]);
      if (terminal) {
        flush(rawValue);
        break;
      }
    }
  });
  flush(activeStopMarker);

  // The editor uses one unit for all maps. Normalize mixed input to 0.001 mm,
  // retaining source precision for lossless per-series export and persistence.
  const internalMarker = segments.some((segment) => segment.marker === -9999)
    ? -9999 : activeStopMarker;
  const outputMarkers: Record<string, number> = Object.create(null);
  for (const segment of segments) {
    const series = ensureSeries(data, segment.id);
    const scale = segment.marker === 999 && internalMarker === -9999 ? 10 : 1;
    outputMarkers[segment.id] = outputMarkers[segment.id] === undefined
      || outputMarkers[segment.id] === segment.marker ? segment.marker : internalMarker;
    for (let i = 0; i < segment.entries.length; i++) {
      const [year, rawValue] = segment.entries[i];
      if (i === segment.entries.length - 1 && rawValue === segment.marker) {
        series.set(year, internalMarker);
        continue;
      }
      let value: number | null = rawValue;

      if (edgeZeros) {
        if (value < 0
          && value !== activeStopMarker
          && !preserveNegativeMeasurements) value = null;
      } else {
        if (value < 0
          && value !== activeStopMarker
          && !preserveNegativeMeasurements) value = null;
        if (value === 0) value = null;
      }

      series.set(year, value === null ? null : value * scale);
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
      preserveNegativeMeasurements,
      stopMarkerValue: internalMarker,
      tucsonOutputMarkers: outputMarkers,
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

export function splitSeriesIntoRwlSegments(series: RwlTreeData, marker = stopMarker.value): RwlSegment[] {
  const segments: RwlSegment[] = [];
  const entries = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
  let currentSegment: RwlSegment | null = null;
  let previousValueYear: number | null = null;

  entries.forEach(([year, width]) => {
    if (width === null || width === marker) {
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

export function formatRwlSeries(seriesName: string, segments: RwlSegment[], long: boolean, marker = stopMarker.value): string {
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
          + marker.toString().padStart(6, " ")
        );
      } else {
        currentLine += marker.toString().padStart(6, " ");
        lines.push(currentLine);
      }
    }
  });

  return lines.join("\r\n");
}

export function formatTucson(
  data: RwlSiteData,
  long: boolean,
  selectedTree?: string,
  readOptions?: RwlReadResult["readOptions"]
): string {
  if (selectedTree && selectedTree !== "\u5168\u90e8") {
    const treeData = data.get(selectedTree);
    if (!treeData) return "";
    data = new Map([[selectedTree, treeData]]);
  }

  const seriesText: string[] = [];

  data.forEach((treeMap, treeCode) => {
    const internalMarker = readOptions?.stopMarkerValue ?? stopMarker.value;
    let segments = splitSeriesIntoRwlSegments(treeMap, internalMarker);
    let outputMarker = internalMarker;
    // Preserve 0.01 mm source precision only when every edited measurement can
    // still be represented exactly. Otherwise retain the finer working unit.
    if (internalMarker === -9999 && readOptions?.tucsonOutputMarkers?.[treeCode] === 999
      && segments.every((segment) => segment.values.every(([, value]) => value === null || value % 10 === 0))) {
      outputMarker = 999;
      segments = segments.map((segment) => ({ ...segment,
        values: segment.values.map(([year, value]) => [year, value === null ? null : value / 10]),
      }));
    }
    const formattedSeries = formatRwlSeries(treeCode, segments, long, outputMarker);

    if (formattedSeries) {
      seriesText.push(formattedSeries);
    }
  });

  const result = seriesText.join("\r\n");
  return result ? `${result}\r\n` : "";
}
