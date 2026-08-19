import type { RwlSiteData } from "@/features/rwl/types";

export type GridFindMatch =
    | { kind: "series"; tree: string }
    | {
        kind: "cell";
        tree: string;
        year: number;
        value: number | null | undefined;
        isStopMarker: boolean;
    };

export interface GridReplacementResult {
    data: RwlSiteData;
    changed: boolean;
    nextStopMarkerValue?: number;
}

/** Match series identifiers and exact grid values, including the format-wide stop marker. */
export function findGridMatches(
    siteData: RwlSiteData,
    query: string,
    stopMarkerValue: number,
): GridFindMatch[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const normalized = trimmed.toLocaleLowerCase();
    const numericQuery = Number(trimmed);
    const searchesNumbers = Number.isFinite(numericQuery);
    const searchesMissing = normalized === "missing";
    const matches: GridFindMatch[] = [];

    siteData.forEach((treeData, tree) => {
        if (tree.toLocaleLowerCase().includes(normalized)) {
            matches.push({ kind: "series", tree });
        }

        const entries = Array.from(treeData.entries()).sort(([left], [right]) => left - right);
        entries.forEach(([year, value]) => {
            if ((searchesNumbers && value === numericQuery) || (searchesMissing && value === null)) {
                matches.push({
                    kind: "cell",
                    tree,
                    year,
                    value,
                    isStopMarker: value === stopMarkerValue,
                });
            }
        });

        if (!searchesMissing) return;
        const years = entries
            .filter(([, value]) => value !== stopMarkerValue)
            .map(([year]) => year);
        if (years.length < 2) return;
        const presentYears = new Set(years);
        const firstYear = years[0];
        const lastYear = years[years.length - 1];
        for (let year = firstYear; year <= lastYear; year += 1) {
            if (!presentYears.has(year)) {
                matches.push({
                    kind: "cell",
                    tree,
                    year,
                    value: undefined,
                    isStopMarker: false,
                });
            }
        }
    });

    return matches;
}

/** Replace literal text without changing the casing of the unmatched identifier suffix/prefix. */
export function replaceSeriesNameLiteral(tree: string, query: string, replacement: string): string {
    const trimmed = query.trim();
    if (!trimmed) return tree;
    const normalizedTree = tree.toLocaleLowerCase();
    const normalizedQuery = trimmed.toLocaleLowerCase();
    let offset = 0;
    let result = "";

    while (offset < tree.length) {
        const matchIndex = normalizedTree.indexOf(normalizedQuery, offset);
        if (matchIndex < 0) {
            result += tree.slice(offset);
            break;
        }
        result += tree.slice(offset, matchIndex) + replacement;
        offset = matchIndex + trimmed.length;
    }

    return result;
}

/** Build one undoable site snapshot for mixed series-name, width, missing, and delimiter matches. */
export function replaceGridMatches(
    siteData: RwlSiteData,
    matches: readonly GridFindMatch[],
    query: string,
    replacement: string,
    stopMarkerValue: number,
): GridReplacementResult {
    if (matches.length === 0) return { data: siteData, changed: false };

    const replacementText = replacement.trim();
    const replacementNumber = Number(replacementText);
    const hasNumericReplacement = replacementText !== "" && Number.isFinite(replacementNumber);
    const nextData: RwlSiteData = new Map(
        Array.from(siteData, ([tree, treeData]) => [tree, new Map(treeData)]),
    );
    let changed = false;
    let nextStopMarkerValue: number | undefined;

    const replacesStopMarker = matches.some((match) => match.kind === "cell" && match.isStopMarker);
    if (
        replacesStopMarker
        && hasNumericReplacement
        && (replacementNumber === 999 || replacementNumber === -9999)
        && replacementNumber !== stopMarkerValue
    ) {
        nextData.forEach((treeData) => {
            treeData.forEach((value, year) => {
                if (value === stopMarkerValue) treeData.set(year, replacementNumber);
            });
        });
        nextStopMarkerValue = replacementNumber;
        changed = true;
    }

    if (hasNumericReplacement) {
        matches.forEach((match) => {
            if (match.kind !== "cell" || match.isStopMarker || match.value === replacementNumber) return;
            nextData.get(match.tree)?.set(match.year, replacementNumber);
            changed = true;
        });
    }

    const renameMap = new Map<string, string>();
    const maximumNameLength = Array.from(siteData.values()).some((treeData) => (
        Array.from(treeData.keys()).some((year) => year < 0)
    )) ? 7 : 8;
    matches.forEach((match) => {
        if (match.kind !== "series") return;
        const nextName = replaceSeriesNameLiteral(match.tree, query, replacement);
        if (
            nextName === match.tree
            || nextName.length === 0
            || nextName.length > maximumNameLength
            || /\s/.test(nextName)
        ) return;
        renameMap.set(match.tree, nextName);
    });

    if (renameMap.size > 0) {
        const finalNames = Array.from(nextData.keys(), (tree) => renameMap.get(tree) ?? tree);
        if (new Set(finalNames).size === finalNames.length) {
            const renamedData: RwlSiteData = new Map();
            nextData.forEach((treeData, tree) => {
                renamedData.set(renameMap.get(tree) ?? tree, treeData);
            });
            return {
                data: renamedData,
                changed: true,
                ...(nextStopMarkerValue === undefined ? {} : { nextStopMarkerValue }),
            };
        }
    }

    return {
        data: changed ? nextData : siteData,
        changed,
        ...(nextStopMarkerValue === undefined ? {} : { nextStopMarkerValue }),
    };
}
