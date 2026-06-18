import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsProvider } from "@/features/settings/SettingsContext";
import { STORAGE_KEY } from "@/features/settings/settings";
import WidthContainer from "@/components/WidthContainer/WidthContainer";
import { insertMissingYearAtSide, moveSeriesTailByOffset } from "@/features/rwl/edit";
import type { RwlHistoryAnimation } from "@/features/rwl/edit";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";

// 强制：动画开启、极慢（便于逐帧截图）、insertYear = slide-shift（非 flight，走同行 in-row 平移）。
// 可用 ?speed=0.1 覆盖速度，?insert=slide-shift|pulse-shift|side-pop-shift|flight-shift 切换插入风格。
const params = new URLSearchParams(location.search);
const speed = Number(params.get("speed") ?? "0.1");
const insertYear = params.get("insert") ?? "slide-shift";
localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
        animation: {
            enabled: "enabled",
            speed,
            deleteSeries: "shatter-rise",
            deleteYear: "pixel-burst",
            insertYear,
            historyAnim: "enabled",
        },
    }),
);

// 起始年 1780（offset 0）→ 首行满 10 格 1780-1789（触发整十年首行重排），共 4 行到 1819。
// 每格唯一、好认的宽度值（年份后两位 *10 + 1），方便追踪每个格子去向。可用 ?start=1785 改成残缺首行。
function makeSeries(): RwlTreeData {
    const start = Number(params.get("start") ?? "1780");
    const m = new Map<number, number | null>();
    for (let y = start; y <= start + 39; y++) {
        m.set(y, (y % 100) * 10 + 1);
    }
    return m;
}

type InsertRecord = { before: RwlSiteData; tree: string; year: number; side: "left" | "right" };

function Harness() {
    const [site, setSite] = useState<RwlSiteData>(() => new Map([["RDM021", makeSeries()]]));
    const [historyAnimation, setHistoryAnimation] = useState<(RwlHistoryAnimation & { id: number }) | null>(null);
    const undoStack = useRef<InsertRecord[]>([]);
    const animId = useRef(0);

    const onInsert = (tree: string, year: number, side: "left" | "right") => {
        setSite((prev) => {
            const td = prev.get(tree);
            if (!td) return prev;
            undoStack.current.push({ before: prev, tree, year, side });
            const next = new Map(prev);
            next.set(tree, insertMissingYearAtSide(td, year, side));
            return next;
        });
    };

    // 模拟 useHomeWorkspace 的 undo：先把数据回退到插入前，再投出 insert-missing/undo 的 historyAnimation。
    const onUndo = () => {
        const last = undoStack.current.pop();
        if (!last) return;
        setSite(last.before);
        setHistoryAnimation({ type: "insert-missing", tree: last.tree, year: last.year, side: last.side, direction: "undo", id: ++animId.current });
    };

    const onMove = (tree: string, startYear: number, endYear: number, yearOffset: number) => {
        setSite((prev) => {
            const td = prev.get(tree);
            if (!td) return prev;
            const next = new Map(prev);
            next.set(tree, moveSeriesTailByOffset(td, startYear, endYear, yearOffset));
            return next;
        });
    };

    return (
        <div style={{ padding: 20 }}>
            <h3 style={{ font: "14px system-ui", margin: "0 0 8px" }}>
                WidthGrid anim harness — speed {speed}, insert {insertYear}
                <button id="undo-btn" onClick={onUndo} style={{ marginLeft: 12 }}>undo</button>
            </h3>
            <div
                id="grid-host"
                style={{ width: 900, height: 640, overflow: "auto", border: "1px solid #ccc" }}
            >
                <WidthContainer
                    siteData={site}
                    selected="RDM021"
                    historyAnimation={historyAnimation}
                    onInsertMissingYearAtSide={onInsert}
                    onMoveSeriesTailByOffset={onMove}
                />
            </div>
        </div>
    );
}

createRoot(document.getElementById("root")!).render(
    <SettingsProvider>
        <Harness />
    </SettingsProvider>,
);
