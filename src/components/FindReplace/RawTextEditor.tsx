import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, drawSelection, rectangularSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
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
}

export interface RawEditorSearchState {
    /** Total number of literal matches. */
    count: number;
    /** One-based active match index, or 0 when no match is active. */
    current: number;
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
    onSave,
    onApply,
    onCancel,
}, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const callbacksRef = useRef({ onInput, onSearchStateChange, onSave, onApply, onCancel });
    callbacksRef.current = { onInput, onSearchStateChange, onSave, onApply, onCancel };

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
                search({ literal: true }),
                // 让保存/应用/取消的快捷键优先于编辑器默认键位。
                Prec.highest(keymap.of([
                    { key: "Mod-s", preventDefault: true, run: () => { callbacksRef.current.onSave?.(); return true; } },
                    { key: "Mod-Enter", preventDefault: true, run: () => { callbacksRef.current.onApply?.(); return true; } },
                    { key: "Escape", preventDefault: true, run: () => { callbacksRef.current.onCancel?.(); return true; } },
                ])),
                keymap.of([...defaultKeymap, ...historyKeymap]),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) {
                        callbacksRef.current.onInput?.();
                        emitSearchState(update.view);
                    } else if (update.selectionSet) {
                        emitSearchState(update.view);
                    }
                }),
                // 阻止鼠标中键在 WebView 中触发自动滚动。
                EditorView.domEventHandlers({
                    mousedown: (event) => {
                        if (event.button === 1) {
                            event.preventDefault();
                        }
                        return false;
                    },
                }),
                EditorView.theme({
                    "&": { height: "100%", fontSize: "13px" },
                    ".cm-scroller": { fontFamily: "Consolas, 'Courier New', monospace", overflow: "auto", lineHeight: "1.5" },
                    "&.cm-focused": { outline: "none" },
                    ".cm-content": { caretColor: "#1f2a3a" },
                    ".cm-selectionBackground": { backgroundColor: "rgba(47, 95, 147, 0.18)" },
                    "&.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(47, 95, 147, 0.28)" },
                    ".cm-searchMatch": { backgroundColor: "rgba(250, 204, 21, 0.4)", outline: "1px solid rgba(202, 138, 4, 0.32)" },
                    ".cm-searchMatch-selected": { backgroundColor: "#f59e0b" },
                }),
            ],
        });

        const view = new EditorView({ state, parent: hostRef.current });
        viewRef.current = view;
        view.focus();

        return () => {
            view.destroy();
            viewRef.current = null;
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
            view.dispatch({
                effects: setSearchQuery.of(new SearchQuery({ search: query, replace, caseSensitive: false, literal: true })),
            });
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
    }), [emitSearchState, initialText]);

    return <div ref={hostRef} className={`${styles["editor-host"]} ${invalid ? styles["editor-host-invalid"] : ""}`} />;
});
