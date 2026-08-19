const PART_HEADER_RE = /^[\f\t ]*PART\s+(\d+):/;
const PART2_TITLE_RE = /^[\f\t ]*PART\s+2:\s*TIME PLOT OF TREE-RING SERIES:/;
const PART2_COLUMN_HEADER_RE = /\bIdent\s+Seq\s+Time-span\s+Yrs\b/;
const PART2_COLUMN_RULE_RE = /--------\s+---\s+----\s+----\s+----\s*$/;
const PART2_ROW_RE = /^(.*?)(\S+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s*$/;

const controlToken = (kind: string, id: number) => `\uE000COFECHA_PART2_${kind}_${id}\uE001`;

export interface CofechaPart2CheckboxControl {
    token: string;
    tree: string;
    checked: boolean;
}

export interface CofechaPart2SortControl {
    token: string;
    sorted: boolean;
}

export interface CofechaPart2View {
    text: string;
    checkboxes: CofechaPart2CheckboxControl[];
    sortControls: CofechaPart2SortControl[];
}

export interface CofechaPart2SeriesGroup {
    tree: string;
    startYear: number;
    endYear: number;
    age: number;
    lines: string[];
}

interface ParsedPart2Row {
    line: string;
    tree: string;
    startYear: number;
    endYear: number;
    originalIndex: number;
}

const normalizeTree = (tree: string) => tree.trim().toLocaleLowerCase();

const parsePart2Row = (
    line: string,
    originalIndex: number,
    knownTreeByKey: ReadonlyMap<string, string>,
): ParsedPart2Row | null => {
    const match = line.match(PART2_ROW_RE);
    if (!match) return null;
    const tree = knownTreeByKey.get(normalizeTree(match[2]));
    if (!tree) return null;
    const rawStart = Number(match[4]);
    const rawEnd = Number(match[5]);
    if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) return null;
    return {
        line,
        tree,
        startYear: Math.min(rawStart, rawEnd),
        endYear: Math.max(rawStart, rawEnd),
        originalIndex,
    };
};

export function groupCofechaPart2Series(
    lines: readonly string[],
    knownTrees: readonly string[],
): CofechaPart2SeriesGroup[] {
    const knownTreeByKey = new Map(knownTrees.map((tree) => [normalizeTree(tree), tree]));
    const groups = new Map<string, {
        tree: string;
        startYear: number;
        endYear: number;
        firstIndex: number;
        rows: ParsedPart2Row[];
    }>();

    lines.forEach((line, index) => {
        const row = parsePart2Row(line, index, knownTreeByKey);
        if (!row) return;
        const key = normalizeTree(row.tree);
        const existing = groups.get(key);
        if (existing) {
            existing.startYear = Math.min(existing.startYear, row.startYear);
            existing.endYear = Math.max(existing.endYear, row.endYear);
            existing.rows.push(row);
        } else {
            groups.set(key, {
                tree: row.tree,
                startYear: row.startYear,
                endYear: row.endYear,
                firstIndex: index,
                rows: [row],
            });
        }
    });

    return Array.from(groups.values())
        .sort((left, right) => left.firstIndex - right.firstIndex)
        .map((group) => ({
            tree: group.tree,
            startYear: group.startYear,
            endYear: group.endYear,
            age: group.endYear - group.startYear + 1,
            lines: group.rows.sort((left, right) => left.originalIndex - right.originalIndex).map((row) => row.line),
        }));
}

const enhancePart2Section = (
    lines: readonly string[],
    knownTrees: readonly string[],
    selectedTreeKeys: ReadonlySet<string>,
    sortByAge: boolean,
    nextControlId: () => number,
    checkboxes: CofechaPart2CheckboxControl[],
    sortControls: CofechaPart2SortControl[],
): string[] => {
    const groups = groupCofechaPart2Series(lines, knownTrees);
    if (groups.length === 0) return [...lines];
    const groupByTree = new Map(groups.map((group) => [normalizeTree(group.tree), group]));
    const knownTreeByKey = new Map(knownTrees.map((tree) => [normalizeTree(tree), tree]));
    const parsedRows = lines.map((line, index) => parsePart2Row(line, index, knownTreeByKey));
    const firstDataIndex = parsedRows.findIndex(Boolean);
    let lastDataIndex = -1;
    parsedRows.forEach((row, index) => {
        if (row) lastDataIndex = index;
    });

    let sortControlAdded = false;
    const enhanceNonDataLine = (line: string) => {
        if (!sortControlAdded && PART2_TITLE_RE.test(line)) {
            const token = controlToken("SORT", nextControlId());
            sortControls.push({ token, sorted: sortByAge });
            sortControlAdded = true;
            return line.replace(PART2_TITLE_RE, (title) => `${title}  ${token}`);
        }
        if (PART2_COLUMN_HEADER_RE.test(line)) return `${line}  Show Age`;
        if (PART2_COLUMN_RULE_RE.test(line)) return `${line}  ---- ----`;
        return line;
    };

    const enhanceDataLine = (line: string, originalIndex: number) => {
        const row = parsePart2Row(line, originalIndex, knownTreeByKey);
        if (!row) return enhanceNonDataLine(line);
        const group = groupByTree.get(normalizeTree(row.tree));
        if (!group) return line;
        const token = controlToken("CHECK", nextControlId());
        checkboxes.push({
            token,
            tree: group.tree,
            checked: selectedTreeKeys.has(normalizeTree(group.tree)),
        });
        return `${line}  ${token} ${String(group.age).padStart(4, " ")}`;
    };

    if (!sortByAge || firstDataIndex < 0 || lastDataIndex < firstDataIndex) {
        return lines.map((line, index) => (
            parsedRows[index] ? enhanceDataLine(line, index) : enhanceNonDataLine(line)
        ));
    }

    const sortedGroups = [...groups].sort((left, right) => (
        right.age - left.age
        || left.startYear - right.startYear
        || left.tree.localeCompare(right.tree)
    ));
    const prefix = lines.slice(0, firstDataIndex).map(enhanceNonDataLine);
    const sortedRows = sortedGroups.flatMap((group) => (
        group.lines.map((line, index) => enhanceDataLine(line, firstDataIndex + index))
    ));
    const suffix = lines.slice(lastDataIndex + 1).map((line) => (
        PART2_TITLE_RE.test(line) || PART2_COLUMN_HEADER_RE.test(line) || PART2_COLUMN_RULE_RE.test(line)
            ? ""
            : line
    )).filter((line, index, array) => line !== "" || (index > 0 && array[index - 1] !== ""));
    return [...prefix, ...sortedRows, ...suffix];
};

/**
 * Add UI-only PART 2 controls and derived ages. The returned text is a render copy; the COFECHA
 * report and persisted OUT content are never changed.
 */
export function enhanceCofechaPart2View(
    text: string | undefined,
    knownTrees: readonly string[],
    selectedTrees: readonly string[],
    sortByAge: boolean,
): CofechaPart2View {
    const lines = (text ?? "").split(/\r\n|\n|\r/);
    const selectedTreeKeys = new Set(selectedTrees.map(normalizeTree));
    const checkboxes: CofechaPart2CheckboxControl[] = [];
    const sortControls: CofechaPart2SortControl[] = [];
    let controlId = 0;
    const nextControlId = () => ++controlId;
    const output: string[] = [];

    for (let index = 0; index < lines.length;) {
        const partMatch = lines[index].match(PART_HEADER_RE);
        if (partMatch?.[1] !== "2") {
            output.push(lines[index]);
            index += 1;
            continue;
        }

        let end = index + 1;
        while (end < lines.length) {
            const nextPart = lines[end].match(PART_HEADER_RE);
            if (nextPart && nextPart[1] !== "2") break;
            end += 1;
        }
        output.push(...enhancePart2Section(
            lines.slice(index, end),
            knownTrees,
            selectedTreeKeys,
            sortByAge,
            nextControlId,
            checkboxes,
            sortControls,
        ));
        index = end;
    }

    return {
        text: output.join("\n"),
        checkboxes,
        sortControls,
    };
}
