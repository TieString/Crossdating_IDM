import type { ICofechaResult } from "@/features/cofecha/types";
import type { RwlSiteData } from "@/features/rwl/types";

type ExportCell = string | number | null;
type ExportRow = ExportCell[];

export interface CrossdatingConsoleApi {
    current: () => {
        file: string | null;
        series: string[];
        hasMaster: boolean;
    };
    master: () => ExportRow[];
    series: (tree: string) => ExportRow[];
    aligned: (tree: string) => ExportRow[];
    copyMaster: () => string;
    copySeries: (tree: string) => string;
    copyAligned: (tree: string) => string;
}

declare global {
    interface Window {
        crossdating?: CrossdatingConsoleApi;
        cd?: CrossdatingConsoleApi;
    }
}

const rowsToTsv = (rows: ExportRow[]) => rows
    .map((row) => row.map((cell) => cell ?? "").join("\t"))
    .join("\n");

const outputRows = (rows: ExportRow[]) => {
    const text = rowsToTsv(rows);
    console.log(text);
    return text;
};

const resolveTree = (siteData: RwlSiteData, requestedTree: string) => {
    const exact = siteData.get(requestedTree);
    if (exact) return [requestedTree, exact] as const;

    const normalized = requestedTree.trim().toLowerCase();
    const matchedTree = Array.from(siteData.keys()).find((tree) => tree.toLowerCase() === normalized);
    if (!matchedTree) {
        throw new Error(`找不到序列 "${requestedTree}"。可用序列：${Array.from(siteData.keys()).join(", ")}`);
    }
    return [matchedTree, siteData.get(matchedTree)!] as const;
};

export const publishConsoleDataExport = (
    fileName: string | null,
    siteData: RwlSiteData,
    cofechaResult: ICofechaResult | undefined,
) => {
    const masterSeries = cofechaResult?.masterDatingSeries;

    const master = (): ExportRow[] => [
        ["year", "cofecha_master"],
        ...Array.from(masterSeries?.entries() ?? []).sort(([a], [b]) => a - b),
    ];

    const series = (requestedTree: string): ExportRow[] => {
        const [tree, treeData] = resolveTree(siteData, requestedTree);
        return [
            ["year", tree],
            ...Array.from(treeData.entries()).sort(([a], [b]) => a - b),
        ];
    };

    const aligned = (requestedTree: string): ExportRow[] => {
        const [tree, treeData] = resolveTree(siteData, requestedTree);
        const years = new Set<number>([
            ...Array.from(masterSeries?.keys() ?? []),
            ...treeData.keys(),
        ]);

        return [
            ["year", "cofecha_master", tree],
            ...Array.from(years)
                .sort((a, b) => a - b)
                .map((year): ExportRow => [
                    year,
                    masterSeries?.get(year) ?? null,
                    treeData.get(year) ?? null,
                ]),
        ];
    };

    const api: CrossdatingConsoleApi = {
        current: () => ({
            file: fileName,
            series: Array.from(siteData.keys()),
            hasMaster: Boolean(masterSeries?.size),
        }),
        master,
        series,
        aligned,
        copyMaster: () => outputRows(master()),
        copySeries: (tree) => outputRows(series(tree)),
        copyAligned: (tree) => outputRows(aligned(tree)),
    };

    window.crossdating = api;
    window.cd = api;
};
