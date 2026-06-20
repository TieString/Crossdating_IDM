import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FloatingScrollbar } from '@/components/FloatingScrollbar/FloatingScrollbar';
import style from './SeriesTextEditor.module.css';

// ── Data conversion ────────────────────────────────────────────────────────

/** Converts a series map into the line-oriented text format used by SeriesTextEditor. */
export function seriesDataToText(data: Map<number, number | null>, stopMarkerValue: number): string {
    return Array.from(data.entries())
        .filter(([, v]) => v !== stopMarkerValue)
        .sort(([a], [b]) => a - b)
        .map(([year, width]) => `${year}\t${width === null ? 'missing' : width}`)
        .join('\n');
}

/** Parses SeriesTextEditor text back into a series map, appending the stop marker after the last year. */
export function textToSeriesData(
    text: string,
    stopMarkerValue: number,
): Map<number, number | null> | null {
    const data = new Map<number, number | null>();

    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;

        const year = Number(parts[0]);
        if (!Number.isInteger(year) || !Number.isFinite(year)) return null;

        const valueStr = parts[1].toLowerCase();
        let value: number | null;
        if (valueStr === 'missing') {
            value = null;
        } else {
            value = Number(valueStr);
            if (!Number.isInteger(value) || !Number.isFinite(value)) return null;
        }

        data.set(year, value);
    }

    if (data.size === 0) return null;

    const maxYear = Math.max(...data.keys());
    data.set(maxYear + 1, stopMarkerValue);

    return data;
}

// ── Cursor/position utilities ──────────────────────────────────────────────

function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
    const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
    const lines = before.split('\n');
    return { line: lines.length - 1, col: lines[lines.length - 1].length };
}

function lineColToOffset(lines: string[], line: number, col: number): number {
    const clampedLine = Math.max(0, Math.min(line, lines.length - 1));
    let offset = 0;
    for (let i = 0; i < clampedLine; i++) {
        offset += lines[i].length + 1; // +1 for \n
    }
    const lineText = lines[clampedLine] ?? '';
    return offset + Math.min(col, lineText.length);
}

function getWordBounds(text: string, offset: number): { start: number; end: number } | null {
    let start = offset;
    let end = offset;
    while (start > 0 && /\S/.test(text[start - 1])) start--;
    while (end < text.length && /\S/.test(text[end])) end++;
    return start < end ? { start, end } : null;
}

// ── Multi-cursor edit engine ───────────────────────────────────────────────

interface Edit {
    start: number;
    end: number;
    insert: string;
    idx: number; // original index in the operations array
}

function applyEdits(
    text: string,
    edits: Edit[],
): { text: string; newOffsets: number[] } {
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    let result = text;
    const newOffsets = new Array(edits.length).fill(0);

    for (const edit of sorted) {
        result = result.slice(0, edit.start) + edit.insert + result.slice(edit.end);
        newOffsets[edit.idx] = edit.start + edit.insert.length;
    }

    return { text: result, newOffsets };
}

// ── Extra cursor state ─────────────────────────────────────────────────────

interface ExtraCursor {
    head: number;   // character offset of cursor head
    anchor: number; // character offset of selection anchor
}

// ── Component ──────────────────────────────────────────────────────────────

const PADDING_LEFT = 10;
const PADDING_TOP = 8;

/** Props for editing one tree-ring series as year/value text. */
export interface SeriesTextEditorProps {
    /** Series identifier displayed in the editor header. */
    treeCode: string;
    /** Initial editable text. */
    initialText: string;
    /** Numeric stop marker appended by the parser. */
    stopMarkerValue: number;
    /** Called with text on commit, or without text when cancelled. */
    onClose: (newText?: string) => void;
}

/** Text-mode editor for one width series, including multi-cursor shortcuts. */
export default function SeriesTextEditor({ treeCode, initialText, stopMarkerValue, onClose }: SeriesTextEditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [charWidth, setCharWidth] = useState(7.8);
    const [lineHeight, setLineHeight] = useState(20.8);
    const [extraCursors, setExtraCursors] = useState<ExtraCursor[]>([]);
    const [highlights, setHighlights] = useState<Array<{ start: number; end: number }>>([]);
    const [scroll, setScroll] = useState({ left: 0, top: 0 });
    const [parseError, setParseError] = useState(false);
    const isMiddleDraggingRef = useRef(false);
    const middleDragStartRef = useRef<{ line: number; col: number } | null>(null);
    const hasClosedRef = useRef(false);
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

    const close = useCallback((text?: string) => {
        if (hasClosedRef.current) return;
        hasClosedRef.current = true;
        onClose(text);
    }, [onClose]);

    // Measure monospace character dimensions after mount
    useLayoutEffect(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        const cs = window.getComputedStyle(ta);
        const fs = parseFloat(cs.fontSize);
        const lh = parseFloat(cs.lineHeight);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.font = `${fs}px ${cs.fontFamily}`;
            setCharWidth(ctx.measureText('0').width);
        } else {
            setCharWidth(fs * 0.6);
        }
        setLineHeight(Number.isFinite(lh) ? lh : fs * 1.6);
        ta.focus();
    }, []);

    // Convert mouse event to {line, col} in text
    const mouseToPos = useCallback((e: MouseEvent | React.MouseEvent): { line: number; col: number } => {
        const ta = textareaRef.current;
        if (!ta) return { line: 0, col: 0 };
        const rect = ta.getBoundingClientRect();
        const x = e.clientX - rect.left - PADDING_LEFT + scroll.left;
        const y = e.clientY - rect.top - PADDING_TOP + scroll.top;
        const lines = ta.value.split('\n');
        const line = Math.max(0, Math.min(lines.length - 1, Math.floor(y / lineHeight)));
        const col = Math.max(0, Math.min(lines[line]?.length ?? 0, Math.round(x / charWidth)));
        return { line, col };
    }, [charWidth, lineHeight, scroll]);

    // Ctrl+Shift+L: select all occurrences of current word/selection
    const selectAllSame = useCallback(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        const text = ta.value;
        let wordStart: number;
        let wordEnd: number;
        if (ta.selectionStart !== ta.selectionEnd) {
            wordStart = ta.selectionStart;
            wordEnd = ta.selectionEnd;
        } else {
            const bounds = getWordBounds(text, ta.selectionStart);
            if (!bounds) return;
            wordStart = bounds.start;
            wordEnd = bounds.end;
        }
        const word = text.slice(wordStart, wordEnd);
        if (!word) return;

        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'g');
        const occurrences: Array<{ start: number; end: number }> = [];
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            occurrences.push({ start: match.index, end: match.index + match[0].length });
        }
        if (occurrences.length === 0) return;

        setHighlights(occurrences);
        ta.setSelectionRange(occurrences[0].start, occurrences[0].end);
        setExtraCursors(occurrences.slice(1).map(occ => ({ head: occ.end, anchor: occ.start })));
    }, []);

    // Apply an edit operation at the primary cursor and all extra cursors
    const applyAtAllCursors = useCallback((
        insert: string,
        primaryStart: number,
        primaryEnd: number,
    ) => {
        const ta = textareaRef.current;
        if (!ta) return;
        const text = ta.value;

        const edits: Edit[] = [
            { start: Math.max(0, primaryStart), end: Math.min(text.length, primaryEnd), insert, idx: 0 },
            ...extraCursors.map((cur, i) => {
                const selMin = Math.min(cur.head, cur.anchor);
                const selMax = Math.max(cur.head, cur.anchor);
                const hasSelection = cur.head !== cur.anchor;
                return {
                    start: hasSelection ? selMin : Math.max(0, cur.head),
                    end: hasSelection ? selMax : Math.max(0, cur.head),
                    insert,
                    idx: i + 1,
                };
            }),
        ];

        const { text: newText, newOffsets } = applyEdits(text, edits);
        ta.value = newText;
        ta.setSelectionRange(newOffsets[0], newOffsets[0]);
        setExtraCursors(extraCursors.map((_, i) => ({ head: newOffsets[i + 1], anchor: newOffsets[i + 1] })));
        setHighlights([]);
        setParseError(false);
    }, [extraCursors]);

    // Commit on unmount (handles virtual list scrolling the editor out of view)
    useEffect(() => {
        return () => {
            if (!hasClosedRef.current) {
                const text = textareaRef.current?.value;
                onCloseRef.current(text);
            }
        };
    }, []);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            const text = textareaRef.current?.value ?? initialText;
            const parsed = textToSeriesData(text, stopMarkerValue);
            if (!parsed) {
                setParseError(true);
                return;
            }
            close(text);
            return;
        }

        if (e.ctrlKey && e.shiftKey && e.key === 'L') {
            e.preventDefault();
            selectAllSame();
            return;
        }

        if (extraCursors.length === 0) return;

        const ta = textareaRef.current;
        if (!ta) return;

        const selStart = ta.selectionStart;
        const selEnd = ta.selectionEnd;
        const hasSelection = selStart !== selEnd;

        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            applyAtAllCursors(e.key, selStart, selEnd);
            return;
        }

        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            applyAtAllCursors('\n', selStart, selEnd);
            return;
        }

        if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            const text = ta.value;
            const edits: Edit[] = [
                hasSelection
                    ? { start: selStart, end: selEnd, insert: '', idx: 0 }
                    : { start: Math.max(0, selStart - 1), end: selStart, insert: '', idx: 0 },
                ...extraCursors.map((cur, i) => {
                    const curHasSel = cur.head !== cur.anchor;
                    const selMin = Math.min(cur.head, cur.anchor);
                    const selMax = Math.max(cur.head, cur.anchor);
                    return curHasSel
                        ? { start: selMin, end: selMax, insert: '', idx: i + 1 }
                        : { start: Math.max(0, cur.head - 1), end: cur.head, insert: '', idx: i + 1 };
                }),
            ];
            const { text: newText, newOffsets } = applyEdits(text, edits);
            ta.value = newText;
            ta.setSelectionRange(newOffsets[0], newOffsets[0]);
            setExtraCursors(extraCursors.map((_, i) => ({ head: newOffsets[i + 1], anchor: newOffsets[i + 1] })));
            setHighlights([]);
            setParseError(false);
            return;
        }

        if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            const text = ta.value;
            const edits: Edit[] = [
                hasSelection
                    ? { start: selStart, end: selEnd, insert: '', idx: 0 }
                    : { start: selStart, end: Math.min(text.length, selEnd + 1), insert: '', idx: 0 },
                ...extraCursors.map((cur, i) => {
                    const curHasSel = cur.head !== cur.anchor;
                    const selMin = Math.min(cur.head, cur.anchor);
                    const selMax = Math.max(cur.head, cur.anchor);
                    return curHasSel
                        ? { start: selMin, end: selMax, insert: '', idx: i + 1 }
                        : { start: cur.head, end: Math.min(ta.value.length, cur.head + 1), insert: '', idx: i + 1 };
                }),
            ];
            const { text: newText, newOffsets } = applyEdits(text, edits);
            ta.value = newText;
            ta.setSelectionRange(newOffsets[0], newOffsets[0]);
            setExtraCursors(extraCursors.map((_, i) => ({ head: newOffsets[i + 1], anchor: newOffsets[i + 1] })));
            setHighlights([]);
            setParseError(false);
            return;
        }

        // Arrow keys / navigation: clear extra cursors
        setExtraCursors([]);
        setHighlights([]);
    }, [extraCursors, selectAllSame, applyAtAllCursors, onClose, initialText, stopMarkerValue]);

    const handleMouseDown = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
        // Alt+Click → add extra cursor
        if (e.button === 0 && e.altKey) {
            e.preventDefault();
            const { line, col } = mouseToPos(e);
            const ta = textareaRef.current;
            if (!ta) return;
            const lines = ta.value.split('\n');
            const offset = lineColToOffset(lines, line, col);
            setExtraCursors(prev => [...prev, { head: offset, anchor: offset }]);
            setHighlights([]);
            return;
        }

        // Middle button → start column selection
        if (e.button === 1) {
            e.preventDefault();
            const pos = mouseToPos(e);
            isMiddleDraggingRef.current = true;
            middleDragStartRef.current = pos;
            return;
        }

        // Left click without alt → clear extra cursors
        if (e.button === 0 && !e.altKey && !e.shiftKey) {
            setExtraCursors([]);
            setHighlights([]);
            setParseError(false);
        }
    }, [mouseToPos]);

    // Global mouse move/up for middle-drag column selection
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isMiddleDraggingRef.current || !middleDragStartRef.current) return;
            const ta = textareaRef.current;
            if (!ta) return;

            const { line: endLine, col: endCol } = mouseToPos(e);
            const { line: startLine, col: startCol } = middleDragStartRef.current;
            const text = ta.value;
            const lines = text.split('\n');
            const minLine = Math.min(startLine, endLine);
            const maxLine = Math.max(startLine, endLine);
            const minCol = Math.min(startCol, endCol);
            const maxCol = Math.max(startCol, endCol);

            const cursors: ExtraCursor[] = [];
            for (let l = minLine; l <= maxLine; l++) {
                const lineText = lines[l] ?? '';
                const head = lineColToOffset(lines, l, Math.min(maxCol, lineText.length));
                const anchor = lineColToOffset(lines, l, Math.min(minCol, lineText.length));
                cursors.push({ head, anchor });
            }

            if (cursors.length > 0) {
                const [primary, ...extras] = cursors;
                ta.setSelectionRange(primary.anchor, primary.head);
                setExtraCursors(extras);
            }

            const hl = cursors
                .filter(c => c.head !== c.anchor)
                .map(c => ({ start: Math.min(c.head, c.anchor), end: Math.max(c.head, c.anchor) }));
            setHighlights(hl);
        };

        const handleMouseUp = (e: MouseEvent) => {
            if (e.button === 1) {
                isMiddleDraggingRef.current = false;
                middleDragStartRef.current = null;
            }
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [mouseToPos]);

    // Click outside → commit
    useEffect(() => {
        const handlePointerDown = (e: PointerEvent) => {
            const container = containerRef.current;
            if (!container || container.contains(e.target as Node)) return;
            const text = textareaRef.current?.value ?? initialText;
            close(text);
        };
        window.addEventListener('pointerdown', handlePointerDown, true);
        return () => window.removeEventListener('pointerdown', handlePointerDown, true);
    }, [close, initialText]);

    const handleScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
        setScroll({ left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop });
    }, []);

    // Keep textarea focus when clicking non-interactive parts of the container
    const handleContainerMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target !== textareaRef.current) {
            e.preventDefault();
            textareaRef.current?.focus();
        }
    }, []);

    // Build overlay elements (highlights + extra cursors)
    const overlayItems = useMemo(() => {
        // Snapshot text from the ref at render time
        const text = textareaRef.current?.value ?? initialText;
        const items: React.ReactNode[] = [];

        const renderSpan = (
            key: string,
            cls: string,
            line: number,
            colStart: number,
            colEnd: number,
        ) => {
            const x = PADDING_LEFT + colStart * charWidth;
            const y = PADDING_TOP + line * lineHeight;
            const w = (colEnd - colStart) * charWidth;
            items.push(
                <span
                    key={key}
                    className={cls}
                    style={{ left: x, top: y, width: Math.max(w, 2), height: lineHeight }}
                />
            );
        };

        highlights.forEach((h, i) => {
            const s = offsetToLineCol(text, h.start);
            const e2 = offsetToLineCol(text, h.end);
            if (s.line === e2.line) {
                renderSpan(`h${i}`, style['highlight-match'], s.line, s.col, e2.col);
            } else {
                const textLines = text.split('\n');
                for (let l = s.line; l <= e2.line; l++) {
                    const lineLen = textLines[l]?.length ?? 0;
                    renderSpan(`h${i}-${l}`, style['highlight-match'], l,
                        l === s.line ? s.col : 0,
                        l === e2.line ? e2.col : lineLen);
                }
            }
        });

        extraCursors.forEach((cur, i) => {
            if (cur.head !== cur.anchor) {
                const sMin = Math.min(cur.head, cur.anchor);
                const sMax = Math.max(cur.head, cur.anchor);
                const sPos = offsetToLineCol(text, sMin);
                const ePos = offsetToLineCol(text, sMax);
                const textLines = text.split('\n');
                for (let l = sPos.line; l <= ePos.line; l++) {
                    const lineLen = textLines[l]?.length ?? 0;
                    renderSpan(`cs${i}-${l}`, style['extra-selection'], l,
                        l === sPos.line ? sPos.col : 0,
                        l === ePos.line ? ePos.col : lineLen);
                }
            }
            const hp = offsetToLineCol(text, cur.head);
            const x = PADDING_LEFT + hp.col * charWidth;
            const y = PADDING_TOP + hp.line * lineHeight;
            items.push(
                <span
                    key={`cur${i}`}
                    className={style['extra-cursor']}
                    style={{ left: x, top: y, height: lineHeight }}
                />
            );
        });

        return items;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [highlights, extraCursors, charWidth, lineHeight, initialText]);

    return (
        <div
            ref={containerRef}
            className={style['container']}
            onMouseDown={handleContainerMouseDown}
        >
            <div className={style['header']}>
                <span className={style['header-title']}>{treeCode}</span>
                <span className={style['header-label']}> — 文本编辑模式</span>
                <span className={style['header-hint']}>Ctrl+Enter 提交 · Esc 取消</span>
            </div>

            <div className={style['editor-area']}>
                <textarea
                    ref={textareaRef}
                    className={style['textarea']}
                    defaultValue={initialText}
                    onKeyDown={handleKeyDown}
                    onMouseDown={handleMouseDown}
                    onScroll={handleScroll}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                />
                <div className={style['overlay']}>
                    <div
                        className={style['overlay-content']}
                        style={{ transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}
                    >
                        {overlayItems}
                    </div>
                </div>
                <FloatingScrollbar targetRef={textareaRef} />
            </div>

            {parseError && (
                <div className={style['parse-error']}>
                    格式错误：每行应为 "年份  宽度值" 或 "年份  missing"
                </div>
            )}

            <div className={style['footer']}>
                <span className={style['footer-hint']}>
                    <kbd className={style['kbd']}>Ctrl+Shift+L</kbd> 选择所有相同词
                </span>
                <span className={style['footer-hint']}>
                    <kbd className={style['kbd']}>Alt+Click</kbd> 添加光标
                </span>
                <span className={style['footer-hint']}>
                    <kbd className={style['kbd']}>中键拖动</kbd> 列选择
                </span>
            </div>
        </div>
    );
}
