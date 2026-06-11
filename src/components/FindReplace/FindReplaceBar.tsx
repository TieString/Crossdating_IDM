import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { motion } from "motion/react";
import styles from "./FindReplaceBar.module.css";

// 查找/替换浮层（仅作用于左侧宽度模块）。
// 这是一个纯展示组件：所有状态由 Home 维护，这里只负责呈现输入框、
// 匹配计数和上一处/下一处/替换等操作按钮，并把交互回调上抛。

export type FindReplaceMode = "find" | "replace";

interface FindReplaceBarProps {
    mode: FindReplaceMode;
    /** true：文本匹配（作用于文本编辑器内容）；false：宽度值匹配。 */
    textMode?: boolean;
    query: string;
    replaceValue: string;
    matchIndex: number;
    matchCount: number;
    onModeChange: (mode: FindReplaceMode) => void;
    onQueryChange: (query: string) => void;
    onReplaceValueChange: (value: string) => void;
    onNext: () => void;
    onPrev: () => void;
    onReplaceOne: () => void;
    onReplaceAll: () => void;
    onClose: () => void;
}

export function FindReplaceBar({
    mode,
    textMode = false,
    query,
    replaceValue,
    matchIndex,
    matchCount,
    onModeChange,
    onQueryChange,
    onReplaceValueChange,
    onNext,
    onPrev,
    onReplaceOne,
    onReplaceAll,
    onClose,
}: FindReplaceBarProps) {
    const queryInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const frameId = window.requestAnimationFrame(() => {
            queryInputRef.current?.focus();
            queryInputRef.current?.select();
        });
        return () => window.cancelAnimationFrame(frameId);
    }, [mode]);

    // 浮层打开期间，任意位置按 Esc 都能关闭（不要求焦点在查找框内）。
    useEffect(() => {
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                onClose();
            }
        };
        document.addEventListener("keydown", handleEscape);
        return () => document.removeEventListener("keydown", handleEscape);
    }, [onClose]);

    const isReplace = mode === "replace";
    // 文本模式下允许"替换为空"（即删除匹配文本）；宽度模式要求填入数值。
    const canReplace = matchCount > 0 && (textMode || replaceValue.trim() !== "");
    const hasQuery = query.trim() !== "";
    const noResults = hasQuery && matchCount === 0;
    const matchLabel = matchCount > 0 ? `${matchIndex + 1}/${matchCount}` : (hasQuery ? "无结果" : "0/0");

    const handleQueryKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            event.preventDefault();
            if (event.shiftKey) {
                onPrev();
            } else {
                onNext();
            }
        }
    };

    const handleReplaceKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            event.preventDefault();
            if (canReplace) {
                onReplaceOne();
            }
        }
    };

    return (
        <motion.div
            className={styles["find-replace-bar"]}
            role="dialog"
            aria-label={isReplace ? "查找和替换" : "查找"}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
        >
            <button
                type="button"
                className={styles["expand-toggle"]}
                title={isReplace ? "切换到查找" : "切换到替换"}
                aria-label={isReplace ? "切换到查找" : "切换到替换"}
                aria-expanded={isReplace}
                onClick={() => onModeChange(isReplace ? "find" : "replace")}
            >
                <span
                    className={`${styles["fr-icon"]} ${styles["icon-chevron"]} ${styles["chevron"]} ${isReplace ? styles["chevron-open"] : ""}`}
                    aria-hidden="true"
                />
            </button>

            <div className={styles["rows"]}>
                <div className={styles["row"]}>
                    <div className={`${styles["input-wrap"]} ${noResults ? styles["input-wrap-empty"] : ""}`}>
                        <input
                            ref={queryInputRef}
                            className={styles["text-input"]}
                            type="text"
                            value={query}
                            placeholder={textMode ? "查找文本" : "查找宽度值"}
                            spellCheck={false}
                            onChange={(event) => onQueryChange(event.target.value)}
                            onKeyDown={handleQueryKeyDown}
                            aria-label="查找内容"
                        />
                        <span className={`${styles["match-count"]} ${noResults ? styles["match-count-empty"] : ""}`}>
                            {matchLabel}
                        </span>
                    </div>

                    <div className={styles["nav-group"]}>
                        <button
                            type="button"
                            className={styles["icon-button"]}
                            title="上一处 (Shift+Enter)"
                            aria-label="上一处"
                            disabled={matchCount === 0}
                            onClick={onPrev}
                        >
                            <span className={`${styles["fr-icon"]} ${styles["icon-up"]}`} aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            className={styles["icon-button"]}
                            title="下一处 (Enter)"
                            aria-label="下一处"
                            disabled={matchCount === 0}
                            onClick={onNext}
                        >
                            <span className={`${styles["fr-icon"]} ${styles["icon-down"]}`} aria-hidden="true" />
                        </button>
                    </div>

                    <button
                        type="button"
                        className={`${styles["icon-button"]} ${styles["close-button"]}`}
                        title="关闭 (Esc)"
                        aria-label="关闭"
                        onClick={onClose}
                    >
                        <span className={`${styles["fr-icon"]} ${styles["icon-close"]}`} aria-hidden="true" />
                    </button>
                </div>

                {isReplace ? (
                    <div className={styles["row"]}>
                        <div className={styles["input-wrap"]}>
                            <input
                                className={styles["text-input"]}
                                type="text"
                                value={replaceValue}
                                placeholder={textMode ? "替换文本" : "替换为宽度值"}
                                spellCheck={false}
                                onChange={(event) => onReplaceValueChange(event.target.value)}
                                onKeyDown={handleReplaceKeyDown}
                                aria-label="替换内容"
                            />
                        </div>
                        <div className={styles["action-group"]}>
                            <button
                                type="button"
                                className={styles["text-button"]}
                                title="替换当前 (Enter)"
                                disabled={!canReplace}
                                onClick={onReplaceOne}
                            >
                                替换
                            </button>
                            <button
                                type="button"
                                className={styles["text-button"]}
                                title="全部替换"
                                disabled={!canReplace}
                                onClick={onReplaceAll}
                            >
                                全部
                            </button>
                        </div>
                    </div>
                ) : null}
            </div>
        </motion.div>
    );
}
