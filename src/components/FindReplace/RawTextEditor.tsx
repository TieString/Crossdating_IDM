import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, drawSelection, rectangularSelection } from "@codemirror/view";
import {
    defaultKeymap,
    history,
    historyKeymap,
    redo as cmRedo,
    redoDepth,
    undo as cmUndo,
    undoDepth,
} from "@codemirror/commands";
import {
    search,
    setSearchQuery,
    getSearchQuery,
    SearchQuery,
    SearchCursor,
    findNext as cmFindNext,
    findPrevious as cmFindPrevious,
    replaceNext as cmReplaceNext,
    replaceAll as cmReplaceAll,
} from "@codemirror/search";
import { FloatingScrollbar } from "@/components/FloatingScrollbar/FloatingScrollbar";
import styles from "./RawTextEditor.module.css";

// 基于 CodeMirror 6 的原始文本编辑器。
// - 按住鼠标中键拖拽 = 矩形（列）选择
// - 按住 Alt 单击 = 多光标
// - 查找/替换由外部 FindReplaceBar 通过 ref 暴露的接口驱动，作用于编辑器文本本身

export interface RawEditorHandle {
    /** Returns the current CodeMirror document text. */
    getValue: () => string;
    /** Focuses the editor view. */
    focus: () => void;
    /** Sets the active literal search and replacement query. */
    setSearch: (query: string, replace: string) => void;
    /** Selects the next search match. */
    findNext: () => void;
    /** Selects the previous search match. */
    findPrev: () => void;
    /** Replaces the active search match. */
    replaceCurrent: () => void;
    /** Replaces every search match. */
    replaceAll: () => void;
    /** Clears the active search query. */
    clearSearch: () => void;
    /** Undoes one text-editor change without touching the RWL data history. */
    undo: () => boolean;
    /** Redoes one text-editor change without touching the RWL data history. */
    redo: () => boolean;
}

export interface RawEditorSearchState {
    /** Total number of literal matches. */
    count: number;
    /** One-based active match index, or 0 when no match is active. */
    current: number;
}

export interface RawEditorHistoryState {
    /** Number of text-editor transactions that can currently be undone. */
    undoCount: number;
    /** Number of text-editor transactions that can currently be redone. */
    redoCount: number;
}

/** Props for the controlled raw text editor wrapper around CodeMirror 6. */
export interface RawTextEditorProps {
    /** Text used to initialize the editor. Recreate the component to reset it. */
    initialText: string;
    /** Applies the invalid visual state when true. */
    invalid?: boolean;
    /** Called when the editor document changes. */
    onInput?: () => void;
    /** Called when search count or active match changes. */
    onSearchStateChange?: (state: RawEditorSearchState) => void;
    /** Called when the local text undo/redo depth changes. */
    onHistoryStateChange?: (state: RawEditorHistoryState) => void;
    /** Called by the Mod+S key binding. */
    onSave?: () => void;
    /** Called by the Mod+Enter key binding. */
    onApply?: () => void;
    /** Called by the Escape key binding. */
    onCancel?: () => void;
}

/** CodeMirror-based raw text editor with imperative find/replace controls. */
export const RawTextEditor = forwardRef<RawEditorHandle, RawTextEditorProps>(function RawTextEditor({
    initialText,
    invalid,
    onInput,
    onSearchStateChange,
    onHistoryStateChange,
    onSave,
    onApply,
    onCancel,
}, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const scrollTargetRef = useRef<HTMLElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [scrollerRevision, setScrollerRevision] = useState(0);
    const callbacksRef = useRef({
        onInput,
        onSearchStateChange,
        onHistoryStateChange,
        onSave,
        onApply,
        onCancel,
    });
    callbacksRef.current = {
        onInput,
        onSearchStateChange,
        onHistoryStateChange,
        onSave,
        onApply,
        onCancel,
    };

    const emitSearchState = useCallback((view: EditorView) => {
        const notify = callbacksRef.current.onSearchStateChange;
        if (!notify) {
            return;
        }
        const query = getSearchQuery(view.state).search;
        if (!query) {
            notify({ count: 0, current: 0 });
            return;
        }
        const doc = view.state.doc;
        const selection = view.state.selection.main;
        let count = 0;
        let current = 0;
        const cursor = new SearchCursor(doc, query, 0, doc.length, (value) => value.toLowerCase());
        while (!cursor.next().done) {
            count += 1;
            if (cursor.value.from === selection.from && cursor.value.to === selection.to) {
                current = count;
            }
        }
        notify({ count, current });
    }, []);

    const emitHistoryState = useCallback((view: EditorView) => {
        callbacksRef.current.onHistoryStateChange?.({
            undoCount: undoDepth(view.state),
            redoCount: redoDepth(view.state),
        });
    }, []);

    useEffect(() => {
        if (!hostRef.current) {
            return;
        }

        const state = EditorState.create({
            doc: initialText,
            extensions: [
                history(),
                drawSelection(),
                // 鼠标中键拖拽触发矩形（列）选择。
                rectangularSelection({ eventFilter: (event) => event.button === 1 }),
                EditorState.allowMultipleSelections.of(true),
                // CodeMirror 在 Windows 上默认用 Ctrl+Click 添加光标；这里按产品交互
                // 明确改为 Alt+Click，同时保留普通单击清除其它光标的默认行为。
                EditorView.clickAddsSelectionRange.of((event) => event.button === 0 && event.altKey),
                search({ literal: true }),
                // 让保存/应用/取消的快捷键优先于编辑器默认键位。
                Prec.highest(keymap.of([
                    { key: "Mod-Enter", preventDefault: true, run: () => { callbacksRef.current.onApply?.(); return true; } },
                    { key: "Escape", preventDefault: true, run: () => { callbacksRef.current.onCancel?.(); return true; } },
                ])),
                keymap.of([...defaultKeymap, ...historyKeymap]),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) {
                        callbacksRef.current.onInput?.();
                        emitSearchState(update.view);
                        emitHistoryState(update.view);
                    } else if (update.selectionSet) {
                        emitSearchState(update.view);
                    }
                }),
                // 矩形选择完成后的 auxclick 不应触发 WebView 的中键默认动作。
                // mousedown 由 CodeMirror 自己消费，不能提前 preventDefault，否则会
                // 阻断 rectangularSelection 的拖动状态机。
                Prec.highest(EditorView.domEventHandlers({
                    keydown: (event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                            event.preventDefault();
                            if (!event.repeat) {
                                callbacksRef.current.onSave?.();
                            }
                            return true;
                        }
                        return false;
                    },
                    auxclick: (event) => event.button === 1,
                })),
                EditorView.contentAttributes.of({
                    "aria-label": "RWL 文本编辑器",
                    "aria-multiline": "true",
                }),
                EditorView.theme({
                    "&": { height: "100%", fontSize: "16px" },
                    ".cm-scroller": {
                        fontFamily: "Consolas, 'Courier New', monospace",
                        overflow: "auto",
                        lineHeight: "1.45",
                        scrollbarWidth: "none",
                    },
                    ".cm-scroller::-webkit-scrollbar": { width: "0", height: "0" },
                    "&.cm-focused": { outline: "none" },
                    ".cm-content": { padding: "10px 20px", caretColor: "#1f2a3a" },
                    ".cm-line": { padding: "0" },
                    ".cm-selectionBackground": { backgroundColor: "rgba(47, 95, 147, 0.18)" },
                    "&.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(47, 95, 147, 0.28)" },
                    ".cm-searchMatch": { backgroundColor: "rgba(250, 204, 21, 0.4)", outline: "1px solid rgba(202, 138, 4, 0.32)" },
                    ".cm-searchMatch-selected": { backgroundColor: "#f59e0b" },
                }),
            ],
        });

        const view = new EditorView({ state, parent: hostRef.current });
        const host = hostRef.current;
        const preventMiddleButtonDefault = (event: MouseEvent) => {
            if (event.button === 1) {
                // 该监听位于 contentDOM 的冒泡上游：CodeMirror 已先建立矩形选择，
                // 随后再阻止 WebView 的中键自动滚动，不会截断拖动手势。
                event.preventDefault();
            }
        };
        host.addEventListener("mousedown", preventMiddleButtonDefault);
        viewRef.current = view;
        scrollTargetRef.current = view.scrollDOM;
        setScrollerRevision((revision) => revision + 1);
        view.focus();
        emitHistoryState(view);

        return () => {
            host.removeEventListener("mousedown", preventMiddleButtonDefault);
            view.destroy();
            viewRef.current = null;
            scrollTargetRef.current = null;
        };
        // 仅在挂载时根据当时的 initialText 创建一次（外部用 key 控制重建）。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(ref, () => ({
        getValue: () => viewRef.current?.state.doc.toString() ?? initialText,
        focus: () => viewRef.current?.focus(),
        setSearch: (query, replace) => {
            const view = viewRef.current;
            if (!view) {
                return;
            }
            const previousQuery = getSearchQuery(view.state).search;
            view.dispatch({
                effects: setSearchQuery.of(new SearchQuery({ search: query, replace, caseSensitive: false, literal: true })),
            });
            // 新查询自动落到一个真实命中，计数不会出现“有结果但没有当前项”。
            // 只修改替换文本时不移动当前命中。
            if (query && query !== previousQuery) {
                cmFindNext(view);
            }
            emitSearchState(view);
        },
        findNext: () => {
            const view = viewRef.current;
            if (view) {
                cmFindNext(view);
                view.focus();
            }
        },
        findPrev: () => {
            const view = viewRef.current;
            if (view) {
                cmFindPrevious(view);
                view.focus();
            }
        },
        replaceCurrent: () => {
            const view = viewRef.current;
            if (view) {
                cmReplaceNext(view);
                view.focus();
            }
        },
        replaceAll: () => {
            const view = viewRef.current;
            if (view) {
                cmReplaceAll(view);
                view.focus();
            }
        },
        clearSearch: () => {
            const view = viewRef.current;
            if (view) {
                view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
                emitSearchState(view);
            }
        },
        undo: () => {
            const view = viewRef.current;
            if (!view) {
                return false;
            }
            const changed = cmUndo(view);
            view.focus();
            return changed;
        },
        redo: () => {
            const view = viewRef.current;
            if (!view) {
                return false;
            }
            const changed = cmRedo(view);
            view.focus();
            return changed;
        },
    }), [emitSearchState, initialText]);

    return (
        <div className={styles["editor-root"]}>
            <div ref={hostRef} className={`${styles["editor-host"]} ${invalid ? styles["editor-host-invalid"] : ""}`} />
            <FloatingScrollbar targetRef={scrollTargetRef} revision={scrollerRevision} />
        </div>
    );
});
