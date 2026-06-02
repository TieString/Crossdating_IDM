import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DeleteMode, MissingInsertSide } from "@/features/rwl/edit";
import style from "./WidthGridContextMenu.module.css";

type DropdownKind = "insert" | "delete" | null;

export interface WidthGridContextMenuProps {
    open: boolean;
    x: number;
    y: number;
    tree: string;
    defaultYear: number;
    defaultDeleteStartYear?: number;
    defaultDeleteEndYear?: number;
    onInsert: (tree: string, year: number, side: MissingInsertSide) => void;
    onDelete: (tree: string, year: number, mode: DeleteMode) => void;
    onDeleteRange?: (tree: string, startYear: number, endYear: number) => void;
    onPreviewYearChange?: (tree: string, year: number) => void;
    onPreviewYearRangeChange?: (tree: string, startYear: number, endYear: number) => void;
    onClose: () => void;
}

const INSERT_OPTIONS: Array<{ side: MissingInsertSide; label: string; chip: string }> = [
    { side: "right", label: "在右侧插入", chip: "右侧" },
    { side: "left", label: "在左侧插入", chip: "左侧" },
];

const DELETE_OPTIONS: Array<{ mode: DeleteMode; label: string; chip: string }> = [
    { mode: "direct", label: "直接删除", chip: "无" },
    { mode: "both", label: "平均到两侧", chip: "平均" },
    { mode: "left", label: "分配到左侧", chip: "左侧" },
    { mode: "right", label: "分配到右侧", chip: "右侧" },
];

const DROPDOWN_GAP = 4;
const VIEWPORT_MARGIN = 8;

const parseYear = (input: string): number | null => {
    const trimmed = input.trim();
    if (trimmed === "") {
        return null;
    }
    const value = Number(trimmed);
    return Number.isFinite(value) && Number.isInteger(value) ? value : null;
};

export default function WidthGridContextMenu({
    open,
    x,
    y,
    tree,
    defaultYear,
    defaultDeleteStartYear,
    defaultDeleteEndYear,
    onInsert,
    onDelete,
    onDeleteRange,
    onPreviewYearChange,
    onPreviewYearRangeChange,
    onClose,
}: WidthGridContextMenuProps) {
    const resolvedDefaultDeleteStartYear = defaultDeleteStartYear ?? defaultYear;
    const resolvedDefaultDeleteEndYear = defaultDeleteEndYear ?? defaultYear;
    const isRangeDelete = resolvedDefaultDeleteStartYear !== resolvedDefaultDeleteEndYear;
    const [insertYear, setInsertYear] = useState<string>(defaultYear.toString());
    const [deleteYear, setDeleteYear] = useState<string>(defaultYear.toString());
    const [deleteStartYear, setDeleteStartYear] = useState<string>(resolvedDefaultDeleteStartYear.toString());
    const [deleteEndYear, setDeleteEndYear] = useState<string>(resolvedDefaultDeleteEndYear.toString());
    const [insertSide, setInsertSide] = useState<MissingInsertSide>("right");
    const [deleteMode, setDeleteMode] = useState<DeleteMode>("direct");
    const [dropdown, setDropdown] = useState<DropdownKind>(null);
    const [dropdownPosition, setDropdownPosition] = useState<{ left: number; top: number; alignRight: boolean; flipY: boolean }>({
        left: 0,
        top: 0,
        alignRight: true,
        flipY: false,
    });
    const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; flipX: boolean; flipY: boolean }>({
        left: x,
        top: y,
        flipX: false,
        flipY: false,
    });

    const menuRef = useRef<HTMLDivElement | null>(null);
    const insertChipRef = useRef<HTMLButtonElement | null>(null);
    const deleteChipRef = useRef<HTMLButtonElement | null>(null);
    const dropdownRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        setInsertYear(defaultYear.toString());
        setDeleteYear(defaultYear.toString());
        setDeleteStartYear(resolvedDefaultDeleteStartYear.toString());
        setDeleteEndYear(resolvedDefaultDeleteEndYear.toString());
        if (isRangeDelete) {
            setDeleteMode("direct");
        }
        setDropdown(null);
    }, [open, defaultYear, resolvedDefaultDeleteStartYear, resolvedDefaultDeleteEndYear, isRangeDelete, tree, x, y]);

    useEffect(() => {
        if (!open || !isRangeDelete) {
            return;
        }
        setDeleteMode("direct");
        setDropdown((previous) => (previous === "delete" ? null : previous));
    }, [open, isRangeDelete]);

    useLayoutEffect(() => {
        if (!open) {
            return;
        }

        const node = menuRef.current;
        if (!node) {
            return;
        }

        const rect = node.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let nextLeft = x;
        let nextTop = y;
        let flipX = false;
        let flipY = false;

        if (nextLeft + rect.width + VIEWPORT_MARGIN > viewportWidth) {
            nextLeft = Math.max(VIEWPORT_MARGIN, x - rect.width);
            flipX = true;
        }
        if (nextTop + rect.height + VIEWPORT_MARGIN > viewportHeight) {
            nextTop = Math.max(VIEWPORT_MARGIN, y - rect.height);
            flipY = true;
        }

        setMenuPosition((previous) => (
            previous.left === nextLeft && previous.top === nextTop && previous.flipX === flipX && previous.flipY === flipY
                ? previous
                : { left: nextLeft, top: nextTop, flipX, flipY }
        ));
    }, [open, x, y, defaultYear, tree]);

    useLayoutEffect(() => {
        if (!open || !dropdown) {
            return;
        }

        const triggerChip = dropdown === "insert" ? insertChipRef.current : deleteChipRef.current;
        const dropdownNode = dropdownRef.current;
        if (!triggerChip || !dropdownNode) {
            return;
        }

        const chipRect = triggerChip.getBoundingClientRect();
        const dropdownRect = dropdownNode.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let left = chipRect.right - dropdownRect.width;
        let alignRight = true;
        if (left < VIEWPORT_MARGIN) {
            left = Math.max(VIEWPORT_MARGIN, chipRect.left);
            alignRight = false;
        }
        if (left + dropdownRect.width + VIEWPORT_MARGIN > viewportWidth) {
            left = Math.max(VIEWPORT_MARGIN, viewportWidth - dropdownRect.width - VIEWPORT_MARGIN);
        }

        let top = chipRect.bottom + DROPDOWN_GAP;
        let flipY = false;
        if (top + dropdownRect.height + VIEWPORT_MARGIN > viewportHeight) {
            const upwardTop = chipRect.top - dropdownRect.height - DROPDOWN_GAP;
            if (upwardTop >= VIEWPORT_MARGIN) {
                top = upwardTop;
                flipY = true;
            } else {
                top = Math.max(VIEWPORT_MARGIN, viewportHeight - dropdownRect.height - VIEWPORT_MARGIN);
            }
        }

        setDropdownPosition((previous) => (
            previous.left === left && previous.top === top && previous.alignRight === alignRight && previous.flipY === flipY
                ? previous
                : { left, top, alignRight, flipY }
        ));
    }, [open, dropdown, menuPosition.left, menuPosition.top, insertSide, deleteMode]);

    useEffect(() => {
        if (!open) {
            return;
        }

        const handlePointerDown = (event: PointerEvent) => {
            if (event.button === 2) {
                return;
            }
            const target = event.target;
            if (!(target instanceof Node)) {
                return;
            }
            if (dropdownRef.current?.contains(target)) {
                return;
            }
            if (menuRef.current?.contains(target)) {
                if (dropdown) {
                    const triggerChip = dropdown === "insert" ? insertChipRef.current : deleteChipRef.current;
                    if (!triggerChip?.contains(target)) {
                        setDropdown(null);
                    }
                }
                return;
            }
            onClose();
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                if (dropdown) {
                    setDropdown(null);
                    return;
                }
                onClose();
            }
        };

        const handleScroll = (event: Event) => {
            const target = event.target;
            if (target instanceof Node && (menuRef.current?.contains(target) || dropdownRef.current?.contains(target))) {
                return;
            }
            onClose();
        };

        window.addEventListener("pointerdown", handlePointerDown, true);
        window.addEventListener("keydown", handleKeyDown, true);
        window.addEventListener("scroll", handleScroll, true);
        window.addEventListener("resize", onClose);

        return () => {
            window.removeEventListener("pointerdown", handlePointerDown, true);
            window.removeEventListener("keydown", handleKeyDown, true);
            window.removeEventListener("scroll", handleScroll, true);
            window.removeEventListener("resize", onClose);
        };
    }, [open, onClose, dropdown]);

    const parsedInsertYear = useMemo(() => parseYear(insertYear), [insertYear]);
    const parsedDeleteYear = useMemo(() => parseYear(deleteYear), [deleteYear]);
    const parsedDeleteStartYear = useMemo(() => parseYear(deleteStartYear), [deleteStartYear]);
    const parsedDeleteEndYear = useMemo(() => parseYear(deleteEndYear), [deleteEndYear]);
    const parsedDeleteRange = useMemo(() => {
        if (parsedDeleteStartYear === null || parsedDeleteEndYear === null) {
            return null;
        }

        return {
            startYear: Math.min(parsedDeleteStartYear, parsedDeleteEndYear),
            endYear: Math.max(parsedDeleteStartYear, parsedDeleteEndYear),
        };
    }, [parsedDeleteStartYear, parsedDeleteEndYear]);

    const insertChipLabel = useMemo(() => INSERT_OPTIONS.find((option) => option.side === insertSide)?.chip ?? "", [insertSide]);
    const directDeleteChipLabel = useMemo(() => DELETE_OPTIONS.find((option) => option.mode === "direct")?.chip ?? "", []);
    const deleteChipLabel = useMemo(() => (
        isRangeDelete
            ? directDeleteChipLabel
            : DELETE_OPTIONS.find((option) => option.mode === deleteMode)?.chip ?? ""
    ), [deleteMode, directDeleteChipLabel, isRangeDelete]);

    const previewYear = useCallback((nextYear: number | null) => {
        if (nextYear !== null) {
            onPreviewYearChange?.(tree, nextYear);
        }
    }, [onPreviewYearChange, tree]);

    const previewYearRange = useCallback((nextStartYear: number | null, nextEndYear: number | null) => {
        if (nextStartYear !== null && nextEndYear !== null) {
            onPreviewYearRangeChange?.(
                tree,
                Math.min(nextStartYear, nextEndYear),
                Math.max(nextStartYear, nextEndYear),
            );
        }
    }, [onPreviewYearRangeChange, tree]);

    const handleInsertYearChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const nextValue = event.target.value;
        setInsertYear(nextValue);
        previewYear(parseYear(nextValue));
    }, [previewYear]);

    const handleDeleteYearChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const nextValue = event.target.value;
        setDeleteYear(nextValue);
        previewYear(parseYear(nextValue));
    }, [previewYear]);

    const handleDeleteStartYearChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const nextValue = event.target.value;
        setDeleteStartYear(nextValue);
        previewYearRange(parseYear(nextValue), parsedDeleteEndYear);
    }, [parsedDeleteEndYear, previewYearRange]);

    const handleDeleteEndYearChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const nextValue = event.target.value;
        setDeleteEndYear(nextValue);
        previewYearRange(parsedDeleteStartYear, parseYear(nextValue));
    }, [parsedDeleteStartYear, previewYearRange]);

    const handleInsertActivate = useCallback(() => {
        if (parsedInsertYear === null) {
            return;
        }
        onInsert(tree, parsedInsertYear, insertSide);
        onClose();
    }, [parsedInsertYear, tree, insertSide, onInsert, onClose]);

    const handleDeleteActivate = useCallback(() => {
        if (isRangeDelete) {
            if (parsedDeleteRange === null || !onDeleteRange) {
                return;
            }
            onDeleteRange(tree, parsedDeleteRange.startYear, parsedDeleteRange.endYear);
            onClose();
            return;
        }

        if (parsedDeleteYear === null) {
            return;
        }
        onDelete(tree, parsedDeleteYear, deleteMode);
        onClose();
    }, [deleteMode, isRangeDelete, onClose, onDelete, onDeleteRange, parsedDeleteRange, parsedDeleteYear, tree]);

    const handleInsertKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            handleInsertActivate();
        }
    }, [handleInsertActivate]);

    const handleDeleteKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            handleDeleteActivate();
        }
    }, [handleDeleteActivate]);

    const toggleDropdown = useCallback((kind: Exclude<DropdownKind, null>) => {
        setDropdown((previous) => (previous === kind ? null : kind));
    }, []);

    const stopPortalPropagation = useCallback((event: React.SyntheticEvent) => {
        event.stopPropagation();
    }, []);

    if (!open) {
        return null;
    }

    const menuStyle: React.CSSProperties = {
        left: menuPosition.left,
        top: menuPosition.top,
        ["--menu-origin-x" as any]: menuPosition.flipX ? "right" : "left",
        ["--menu-origin-y" as any]: menuPosition.flipY ? "bottom" : "top",
    };

    const dropdownStyle: React.CSSProperties = {
        left: dropdownPosition.left,
        top: dropdownPosition.top,
        ["--dropdown-origin-x" as any]: dropdownPosition.alignRight ? "right" : "left",
        ["--dropdown-origin-y" as any]: dropdownPosition.flipY ? "bottom" : "top",
    };

    return createPortal(
        <>
            <div
                ref={menuRef}
                className={style["menu-root"]}
                style={menuStyle}
                role="menu"
                onPointerDown={stopPortalPropagation}
                onClick={stopPortalPropagation}
                onContextMenu={(event) => event.preventDefault()}
            >
                <div
                    className={`${style["menu-row"]} ${dropdown === "insert" ? style["menu-row-active"] : ""}`}
                    role="menuitem"
                    onClick={(event) => {
                        const target = event.target as HTMLElement;
                        if (target.tagName === "INPUT" || target.closest(`.${style["menu-row-mode-chip"]}`)) {
                            return;
                        }
                        handleInsertActivate();
                    }}
                >
                    <span className={style["menu-row-label"]}>插入</span>
                    <input
                        className={`${style["menu-row-input"]} ${parsedInsertYear === null ? style["menu-row-input-invalid"] : ""}`}
                        type="text"
                        value={insertYear}
                        onChange={handleInsertYearChange}
                        onFocus={() => previewYear(parsedInsertYear)}
                        onKeyDown={handleInsertKeyDown}
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        spellCheck={false}
                        inputMode="numeric"
                        aria-label="插入年份"
                    />
                    <button
                        ref={insertChipRef}
                        type="button"
                        className={`${style["menu-row-mode-chip"]} ${dropdown === "insert" ? style["menu-row-mode-chip-open"] : ""}`}
                        aria-haspopup="menu"
                        aria-expanded={dropdown === "insert"}
                        onClick={(event) => {
                            event.stopPropagation();
                            toggleDropdown("insert");
                        }}
                    >
                        <span>{insertChipLabel}</span>
                        <span className={style["menu-row-mode-chip-arrow"]} aria-hidden="true">▾</span>
                    </button>
                </div>

                <div className={style["menu-separator"]} role="separator" />

                <div
                    className={`${style["menu-row"]} ${dropdown === "delete" ? style["menu-row-active"] : ""}`}
                    role="menuitem"
                    onClick={(event) => {
                        const target = event.target as HTMLElement;
                        if (target.tagName === "INPUT" || target.closest(`.${style["menu-row-mode-chip"]}`)) {
                            return;
                        }
                        handleDeleteActivate();
                    }}
                >
                    <span className={style["menu-row-label"]}>删除</span>
                    {isRangeDelete ? (
                        <span className={style["menu-row-range"]}>
                            <input
                                className={`${style["menu-row-input"]} ${parsedDeleteStartYear === null ? style["menu-row-input-invalid"] : ""}`}
                                type="text"
                                value={deleteStartYear}
                                onChange={handleDeleteStartYearChange}
                                onFocus={() => previewYearRange(parsedDeleteStartYear, parsedDeleteEndYear)}
                                onKeyDown={handleDeleteKeyDown}
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                                spellCheck={false}
                                inputMode="numeric"
                                aria-label="删除起始年份"
                            />
                            <span className={style["menu-row-range-separator"]}>-</span>
                            <input
                                className={`${style["menu-row-input"]} ${parsedDeleteEndYear === null ? style["menu-row-input-invalid"] : ""}`}
                                type="text"
                                value={deleteEndYear}
                                onChange={handleDeleteEndYearChange}
                                onFocus={() => previewYearRange(parsedDeleteStartYear, parsedDeleteEndYear)}
                                onKeyDown={handleDeleteKeyDown}
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                                spellCheck={false}
                                inputMode="numeric"
                                aria-label="删除结束年份"
                            />
                        </span>
                    ) : (
                        <>
                            <input
                                className={`${style["menu-row-input"]} ${parsedDeleteYear === null ? style["menu-row-input-invalid"] : ""}`}
                                type="text"
                                value={deleteYear}
                                onChange={handleDeleteYearChange}
                                onFocus={() => previewYear(parsedDeleteYear)}
                                onKeyDown={handleDeleteKeyDown}
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                                spellCheck={false}
                                inputMode="numeric"
                                aria-label="删除年份"
                            />
                            <span className={style["menu-row-label"]}>后</span>
                        </>
                    )}
                    <button
                        ref={deleteChipRef}
                        type="button"
                        className={`${style["menu-row-mode-chip"]} ${dropdown === "delete" && !isRangeDelete ? style["menu-row-mode-chip-open"] : ""} ${isRangeDelete ? style["menu-row-mode-chip-disabled"] : ""}`}
                        aria-haspopup={isRangeDelete ? undefined : "menu"}
                        aria-expanded={isRangeDelete ? undefined : dropdown === "delete"}
                        disabled={isRangeDelete}
                        onClick={(event) => {
                            event.stopPropagation();
                            if (isRangeDelete) {
                                return;
                            }
                            toggleDropdown("delete");
                        }}
                    >
                        <span>{deleteChipLabel}</span>
                        {isRangeDelete ? null : (
                            <span className={style["menu-row-mode-chip-arrow"]} aria-hidden="true">▾</span>
                        )}
                    </button>
                </div>

            </div>

            {dropdown === "insert" ? (
                <div
                    ref={dropdownRef}
                    className={style["dropdown"]}
                    style={dropdownStyle}
                    role="menu"
                    onPointerDown={stopPortalPropagation}
                    onClick={stopPortalPropagation}
                    onContextMenu={(event) => event.preventDefault()}
                >
                    {INSERT_OPTIONS.map((option) => (
                        <div
                            key={option.side}
                            className={`${style["dropdown-item"]} ${insertSide === option.side ? style["dropdown-item-checked"] : ""}`}
                            role="menuitemradio"
                            aria-checked={insertSide === option.side}
                            onClick={() => {
                                setInsertSide(option.side);
                                setDropdown(null);
                            }}
                        >
                            <span className={style["dropdown-item-label"]}>{option.label}</span>
                        </div>
                    ))}
                </div>
            ) : null}

            {dropdown === "delete" && !isRangeDelete ? (
                <div
                    ref={dropdownRef}
                    className={style["dropdown"]}
                    style={dropdownStyle}
                    role="menu"
                    onPointerDown={stopPortalPropagation}
                    onClick={stopPortalPropagation}
                    onContextMenu={(event) => event.preventDefault()}
                >
                    {DELETE_OPTIONS.map((option) => (
                        <div
                            key={option.mode}
                            className={`${style["dropdown-item"]} ${deleteMode === option.mode ? style["dropdown-item-checked"] : ""}`}
                            role="menuitemradio"
                            aria-checked={deleteMode === option.mode}
                            onClick={() => {
                                setDeleteMode(option.mode);
                                setDropdown(null);
                            }}
                        >
                            <span className={style["dropdown-item-label"]}>{option.label}</span>
                        </div>
                    ))}
                </div>
            ) : null}
        </>,
        document.body,
    );
}
