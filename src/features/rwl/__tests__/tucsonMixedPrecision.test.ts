import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stopMarker } from "@/shared/constants";
import { RwlEditor } from "../edit";
import { parseTucson } from "../parsers/tucson";
import { parseRwl as parseEngineRwl } from "cofecha-js";
import { normalizeCofechaInputUnits } from "@/features/crossdating/diagnosis/cofechaInputUnits";
import { normalizeOfficialCofechaInput } from "@/services/cofecha/normalizedInput";
import { splitCofecha606SeriesSegments as splitReferenceSegments } from "@/features/crossdating/reference";

const initialMarker = stopMarker.value;
afterEach(() => { stopMarker.value = initialMarker; });
const line = (id: string, year: number, values: number[]) => id.padEnd(8)
  + String(year).padStart(4) + values.map((value) => String(value).padStart(6)).join("");
const mixed = [line("FINE", 2000, [120, 999, 0, -9999]),
  line("COARSE", 2000, [12, 20, 0, 999])].join("\n");
function editorFor(text: string) {
  stopMarker.value = text.includes("-9999") ? -9999 : 999;
  const parsed = parseTucson(text, { stopMarker: stopMarker.value });
  stopMarker.value = parsed.readOptions!.stopMarkerValue!;
  return new RwlEditor(parsed.data, parsed.readOptions, parsed.format);
}

describe("mixed Tucson segment precision", () => {
  it("excludes each terminator and uses a common physical unit internally", () => {
    const editor = editorFor(mixed);
    expect([...editor.getData().get("COARSE")!]).toEqual([[2000, 120], [2001, 200], [2002, 0], [2003, -9999]]);
    expect(editor.getData().get("FINE")!.get(2001)).toBe(999);
    const saved = editor.exportAsRwlString();
    expect(saved.trim().split(/\r?\n/)).toEqual(mixed.split("\n"));
    expect(editorFor(saved).exportAsRwlString()).toBe(saved);
  });

  it("does not mistake a real 999 at the end of a decade for termination", () => {
    const text = [line("FINE", 1998, [120, 999]), line("FINE", 2000, [45, -9999]),
      line("COARSE", 2000, [12, 999])].join("\n");
    expect(editorFor(text).getData().get("FINE")!.get(1999)).toBe(999);
    expect(editorFor(text).exportAsRwlString()).toContain(line("FINE", 1998, [120, 999]));
  });

  it("preserves mixed precision through edits, undo, redo and history persistence", () => {
    const editor = editorFor(mixed);
    const before = editor.exportAsRwlString();
    editor.insertMissingYearAtSide("COARSE", 2001, "right");
    const after = editor.exportAsRwlString();
    expect(after).toContain(line("COARSE", 2000, [20, 0, 0, 999]));
    editor.undo(); expect(editor.exportAsRwlString()).toBe(before);
    editor.redo(); expect(editor.exportAsRwlString()).toBe(after);
    const snapshot = editor.toHistorySnapshot();
    expect(snapshot.readOptions?.tucsonOutputMarkers?.COARSE).toBe(999);
    snapshot.readOptions!.tucsonOutputMarkers!.COARSE = -9999;
    expect(editor.exportAsRwlString()).toBe(after);
  });

  it("uses fine output when an edit cannot be represented in original coarse units", () => {
    const editor = editorFor(mixed);
    editor.changeYearWidth("COARSE", 2000, 121);
    expect(editor.exportAsRwlString()).toContain(line("COARSE", 2000, [121, 200, 0, -9999]));
    expect(editorFor(editor.exportAsRwlString()).getData().get("COARSE")!.get(2000)).toBe(121);
  });

  it("normalizes repeated same-name segments with differing precisions", () => {
    const editor = editorFor([line("SAME", 1900, [12, 999]), line("SAME", 2000, [120, -9999])].join("\n"));
    expect(editor.getData().get("SAME")!.get(1900)).toBe(120);
    expect(editor.exportAsRwlString()).toContain(line("SAME", 1900, [12, 999]));
    expect(editor.exportAsRwlString()).toContain(line("SAME", 2000, [120, -9999]));
  });

  const boundaryCases = [
    [line("A",2000,[120,999,130,999])],
    [line("A",2000,[120,999,999])],
    [line("A",2000,[120,999,-9999])],
    [line("A",1990,[1,2,3,4,5,6,7,8,9,999]),line("A",2000,[120,999])],
    [line("A",1990,[1,2,3,4,5,6,7,8,9,999]),line("A",2003,[120,999])],
    [line("A",1990,[1,2,3,4,5,999]),line("A",1996,[120,999])],
    [line("A",1990,[1,2,3,4,5,999]),line("A",1997,[120,999])],
    [line("A",1990,[1,2,3,4,5,6,7,8,9,999]),line("A",2000,[999])],
    [line("A",1990,[1,2,3,4,5,6,7,8,9,999,999])],
    [line("A",1990,[120,999]),line("A",2000,[999,130,-9999])],
  ];
  boundaryCases.forEach((rows, i) => it(`boundary ${i}: app/engine/export/EXE transport retain identical measurements`, () => {
    const source = rows.join("\n");
    const editor = editorFor(source);
    const saved = editor.exportAsRwlString();
    expect(editor.getData()).toEqual(normalizeCofechaInputUnits(parseEngineRwl(source).data));
    expect(editorFor(saved).getData()).toEqual(editor.getData());
    expect(normalizeCofechaInputUnits(parseEngineRwl(saved).data)).toEqual(editor.getData());
    expect(normalizeCofechaInputUnits(parseEngineRwl(normalizeOfficialCofechaInput(saved)).data)).toEqual(editor.getData());
    expect(editorFor(saved).exportAsRwlString()).toBe(saved);
  }));

  it("preserves an edited real 999 through undo/redo, saving and persisted history", () => {
    const e = editorFor(line("A",2000,[100,120,130,999]));
    e.changeYearWidth("A",2001,999);
    const saved = e.exportAsRwlString();
    expect(saved).toContain(line("A",2000,[1000,999,1300,-9999]));
    e.undo(); expect(e.getData().get("A")!.get(2001)).toBe(1200);
    e.redo(); expect(e.getData().get("A")!.get(2001)).toBe(999);
    const restored = editorFor(saved);
    restored.restorePersistedHistory(e.toHistorySnapshot());
    expect(restored.getData()).toEqual(e.getData());
    expect(restored.exportAsRwlString()).toBe(saved);
  });
  it("does not filter a fine-unit 999 beside an edited gap in dynamic references", () => {
    stopMarker.value = -9999;
    const data = new Map([["A",new Map([[1990,120],[1991,999],[2000,130],[2001,-9999]])]]);
    expect([...splitReferenceSegments(data)[0].data]).toEqual([[1990,120],[1991,999]]);
  });
  it("rejects a new measurement/marker collision in a legacy coarse snapshot without editing it", () => {
    stopMarker.value = 999;
    const e = new RwlEditor(new Map([["A",new Map([[2000,120],[2001,999]])]]), {stopMarkerValue:999}, "tucson");
    const before = e.toHistorySnapshot();
    expect(() => e.changeYearWidth("A",2000,999)).toThrow(/结束标记冲突/);
    expect(e.getData().get("A")!.get(2000)).toBe(120);
    expect(e.getAllAppliedOperationLogEntries()).toEqual([]);
    expect(e.toHistorySnapshot().workingData).toEqual(before.workingData);
  });

  for (const file of readdirSync(resolve("test-data")).filter((name) => name.endsWith(".rwl"))) {
    it(`preserves the bundled ${file} through repeated editor serialization`, () => {
      const source = readFileSync(resolve("test-data", file), "utf8");
      const editor = editorFor(source);
      const saved = editor.exportAsRwlString();
      const reopened = editorFor(saved);
      const measurements = (current: RwlEditor) => [...current.getData()].map(([id, tree]) => [id,
        [...tree].filter(([, value]) => value !== null && value !== stopMarker.value)]);
      expect(measurements(reopened)).toEqual(measurements(editor));
      expect(reopened.exportAsRwlString()).toBe(saved);
    });
  }

  const inputPath = process.env.CROSSDATING_MIXED_RWL;
  it.skipIf(!inputPath || !existsSync(inputPath))("round-trips every source measurement and endpoint in a user-supplied mixed RWL", () => {
    const original = readFileSync(inputPath!);
    const source = original.toString("utf8").trim().split(/\r?\n/);
    const values = (lines: string[]) => {
      const result = new Map<string, Array<[number, number]>>();
      for (const row of lines) {
        const id = row.slice(0, 8).trim();
        const fields = row.slice(12).match(/.{1,6}/g)!.map((field) => Number(field.trim()));
        const year = Number(row.slice(8, 12));
        result.set(id, [...(result.get(id) ?? []), ...fields.map((value, i): [number, number] => [year + i, value])]);
      }
      return result;
    };
    const expected = values(source);
    const saved = editorFor(original.toString("utf8")).exportAsRwlString();
    expect(values(saved.trim().split(/\r?\n/))).toEqual(expected);
    expect(editorFor(saved).exportAsRwlString()).toBe(saved);
    // The model's working values must retain the same physical units as the
    // independent COFECHA parser, not just the same exported character strings.
    expect(editorFor(original.toString("utf8")).getData())
      .toEqual(normalizeCofechaInputUnits(parseEngineRwl(original.toString("utf8")).data));
    expect(createHash("sha256").update(readFileSync(inputPath!)).digest("hex"))
      .toBe(createHash("sha256").update(original).digest("hex"));
  });
});
