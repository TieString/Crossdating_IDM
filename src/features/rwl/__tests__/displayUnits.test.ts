import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { parseRwl } from "cofecha-js";
import { parseTucson } from "../parsers/tucson";
import { buildRwlDisplayUnits, displayUnitFor, displayWidth, workingWidth } from "../displayUnits";
import { RwlDisplayUnitsContext } from "../DisplayUnitsContext";
import { RwlEditor } from "../edit";
import { stopMarker } from "@/shared/constants";
import WidthGrid from "@/components/WidthContainer/WidthGrid";
import { effectiveChanges } from "../effectiveChanges";
import { findGridMatches, replaceGridMatches } from "@/pages/home/gridFindReplace";
import { publishConsoleDataExport } from "@/pages/home/consoleDataExport";
import { seriesDataToText, textToSeriesData } from "@/components/WidthContainer/SeriesTextEditor";
import { exportWorkspacePackage, importWorkspacePackage, restoredWorkspaceEditor } from "@/features/workspaceTransfer/package";

const oldMarker = stopMarker.value;
afterEach(() => { stopMarker.value = oldMarker; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const row = (id: string, year: number, values: number[]) => id.padEnd(8)+String(year).padStart(4)+values.map(v=>String(v).padStart(6)).join("");
const source = [row("1011",1960,[706,815,999,731,999]),row("1011",1980,[643,575,-9999]),
    row("COARSE",2000,[120,130,999])].join("\n");
const fixture = () => {
    const p = parseTucson(source); stopMarker.value = p.readOptions!.stopMarkerValue!;
    const e = new RwlEditor(p.data,p.readOptions,"tucson");
    const units = buildRwlDisplayUnits(e.getData(),e.getReadOptions());
    return { e, units };
};
const shown = (e: RwlEditor, tree: string, year: number) => {
    const units = buildRwlDisplayUnits(e.getData(),e.getReadOptions());
    return displayWidth(e.getData().get(tree)!.get(year)!,displayUnitFor(units,tree,year),units.workingMarker);
};

describe("source-unit display with unchanged working evidence", () => {
    it("renders original coarse numbers and markers, including a real 999", () => {
        const {e,units}=fixture();
        const snapshot = e.toHistorySnapshot();
        // React server rendering exercises the actual cell projection, not a copied renderer.
        const log = vi.spyOn(console,"error").mockImplementation(() => {});
        const html = (year: number) => renderToStaticMarkup(createElement(RwlDisplayUnitsContext.Provider,{value:units},
            createElement(WidthGrid,{tree:"1011",year,gridValue:e.getData().get("1011")!.get(year)!})));
        expect(html(1960)).toContain('>706<');
        expect(html(1962)).toContain('>999<');
        expect(html(1964)).toContain('>999<');
        expect(html(1980)).toContain('>643<');
        expect(html(1982)).toContain('>-9999<');
        expect(html(1960)).toContain("0.01 mm");
        expect(html(1980)).toContain("0.001 mm");
        expect(e.toHistorySnapshot().workingData).toEqual(snapshot.workingData);
        expect(log.mock.calls.every(args=>String(args[0]).includes("useLayoutEffect"))).toBe(true);
    });
    it("converts edited numbers once and keeps undo, redo, save and reopen stable", () => {
        const {e,units}=fixture();
        e.changeYearWidth("COARSE",2000,workingWidth(150,displayUnitFor(units,"COARSE",2000)));
        expect(e.getData().get("COARSE")!.get(2000)).toBe(1500);
        expect(shown(e,"COARSE",2000)).toBe(150);
        e.undo(); expect(shown(e,"COARSE",2000)).toBe(120);
        e.redo(); expect(shown(e,"COARSE",2000)).toBe(150);
        const saved = e.exportAsRwlString(), p = parseTucson(saved);
        const reopened = new RwlEditor(p.data,p.readOptions,"tucson");
        reopened.restorePersistedHistory(e.toHistorySnapshot());
        expect(shown(reopened,"COARSE",2000)).toBe(150);
        expect(reopened.exportAsRwlString()).toBe(saved);
    });
    it("keeps coarse units after insertion and whole movement", () => {
        const {e}=fixture();
        e.insertMissingYearAtSide("COARSE",2001,"right");
        expect(shown(e,"COARSE",1999)).toBe(120);
        e.moveSeriesTailByOffset("COARSE",1999,2001,7);
        expect(shown(e,"COARSE",2006)).toBe(120);
    });
    it("exports effective numeric changes in declared units without rewriting internal logs", () => {
        const {e}=fixture(); e.changeYearWidth("COARSE",2000,1500);
        const log = e.getAllAppliedOperationLogEntries();
        expect(effectiveChanges(e.toHistorySnapshot())).toContainEqual(expect.objectContaining({
            series:"COARSE",oldValue:"120",newValue:"150",unit:"0.01 mm"}));
        expect(e.getAllAppliedOperationLogEntries()).toEqual(log);
    });
    it("finds shown numbers and distinguishes real 999 from terminators", () => {
        const {e,units}=fixture();
        expect(findGridMatches(e.getData(),"706",-9999,units)).toContainEqual(expect.objectContaining({year:1960,value:7060}));
        const hits=findGridMatches(e.getData(),"999",-9999,units);
        expect(hits).toContainEqual(expect.objectContaining({year:1962,isStopMarker:false}));
        expect(hits).toContainEqual(expect.objectContaining({year:1964,isStopMarker:true}));
        const replaced=replaceGridMatches(e.getData(),findGridMatches(e.getData(),"706",-9999,units),"706","707",-9999,units);
        expect(replaced.data.get("1011")!.get(1960)).toBe(7070);
        expect(e.getData().get("1011")!.get(1960)).toBe(7060);
    });
    it("changes display precision without replacing a real width with a marker", () => {
        const {e,units}=fixture();
        const hits=findGridMatches(e.getData(),"999",-9999,units).filter(m=>m.kind==="cell"&&m.isStopMarker);
        const r=replaceGridMatches(e.getData(),hits,"999","-9999",-9999,units);
        expect(r.nextDisplayMarkerValue).toBe(-9999);
        expect(r.nextStopMarkerValue).toBeUndefined();
        expect(r.data).toEqual(e.getData());
    });
    it("copies source-unit numbers and keeps year/value text editing symmetric", () => {
        const {e,units}=fixture(); vi.stubGlobal("window",{});
        publishConsoleDataExport("test.rwl",e.getData(),undefined,units);
        expect(window.cd!.series("1011")).toContainEqual([1960,706]);
        const values=e.getData().get("COARSE")!;
        const text=seriesDataToText(values,-9999,(y,v)=>v/displayUnitFor(units,"COARSE",y).multiplier);
        expect(text).toContain("2000\t120");
        expect(textToSeriesData(text,-9999,(y,v)=>workingWidth(v,displayUnitFor(units,"COARSE",y))!)).toEqual(values);
    });
    it("fails nonrepresentable input and promotes output precision when necessary", () => {
        const {e,units}=fixture();
        expect(()=>workingWidth(12.345,displayUnitFor(units,"COARSE",2000))).toThrow();
        e.changeYearWidth("COARSE",2000,workingWidth(120.1,displayUnitFor(units,"COARSE",2000)));
        expect(shown(e,"COARSE",2000)).toBe(1201);
        expect(buildRwlDisplayUnits(e.getData(),e.getReadOptions()).series.COARSE.ranges[0].marker).toBe(-9999);
    });
    it("provides the same unit metadata to independent chart and log windows", () => {
        const home=readFileSync(new URL("../../../pages/Home.tsx",import.meta.url),"utf8");
        expect(home).toMatch(/kind: "line-chart",\s*displayUnits/);
        expect(home).toMatch(/kind: "operation-log",\s*displayUnits/);
    });
    it("restores source-unit display after portable workspace import", async () => {
        const {e}=fixture(); e.changeYearWidth("COARSE",2000,1500);
        const bundle=await importWorkspacePackage(await exportWorkspacePackage({fileName:"test.rwl",editor:e,reference:null}));
        const restored=restoredWorkspaceEditor(bundle,"E:/new-name.rwl");
        expect(shown(restored,"COARSE",2000)).toBe(150);
        expect(shown(restored,"1011",1960)).toBe(706);
        expect(shown(restored,"1011",1980)).toBe(643);
        expect(restored.getData()).toEqual(e.getData());
    });
    const sourcePath=process.env.CROSSDATING_DISPLAY_RWL;
    it.skipIf(!sourcePath || !existsSync(sourcePath))("displays every source measurement in a real RWL without changing its bytes", () => {
        const original=readFileSync(sourcePath!), text=original.toString("utf8");
        const parsed=parseTucson(text), units=buildRwlDisplayUnits(parsed.data,parsed.readOptions);
        const segments=parseRwl(text).segments!;
        let count=0;
        for(const segment of segments) for(const [year,value] of segment.entries) {
            expect(displayWidth(parsed.data.get(segment.id)!.get(year)!,displayUnitFor(units,segment.id,year),units.workingMarker)).toBe(value);
            count++;
        }
        expect(count).toBeGreaterThan(100);
        expect(readFileSync(sourcePath!)).toEqual(original);
    });
});
