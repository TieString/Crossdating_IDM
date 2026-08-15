export interface GridSelectAllRange {
    tree: string;
    startYear: number;
    endYear: number;
}

interface TreeAvailability {
    has(tree: string): boolean;
}

interface SelectAllShortcut {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}

export const isGridSelectAllShortcut = (shortcut: SelectAllShortcut): boolean => (
    (shortcut.ctrlKey || shortcut.metaKey)
    && !shortcut.altKey
    && !shortcut.shiftKey
    && shortcut.key.toLowerCase() === "a"
);

export const resolveGridSelectAllTree = (
    selectedTree: string | undefined,
    availableTrees: TreeAvailability,
    lastInteractedTree: string | null,
): string | null => {
    if (selectedTree && availableTrees.has(selectedTree)) {
        return selectedTree;
    }

    if (lastInteractedTree && availableTrees.has(lastInteractedTree)) {
        return lastInteractedTree;
    }

    return null;
};

export const getGridSelectAllRange = (
    tree: string,
    treeData: ReadonlyMap<number, number | null> | undefined,
    stopMarkerValue: number,
): GridSelectAllRange | null => {
    if (!treeData) {
        return null;
    }

    let startYear: number | undefined;
    let endYear: number | undefined;

    for (const [year, width] of treeData.entries()) {
        if (width === stopMarkerValue) {
            continue;
        }

        if (startYear === undefined || year < startYear) {
            startYear = year;
        }
        if (endYear === undefined || year > endYear) {
            endYear = year;
        }
    }

    return startYear === undefined || endYear === undefined
        ? null
        : { tree, startYear, endYear };
};
