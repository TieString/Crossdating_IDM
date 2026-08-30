import type { CofechaUndatedSort } from "@/features/cofecha/types";
import styles from "./CofechaUndatedControls.module.css";

type CofechaUndatedControlsProps = {
    fileName: string | null;
    sort: CofechaUndatedSort;
    disabled?: boolean;
    compact?: boolean;
    onLoad: () => void | Promise<void>;
    onClear: () => void | Promise<void>;
    onSortChange: (sort: CofechaUndatedSort) => void | Promise<void>;
};

export function CofechaUndatedControls({
    fileName,
    sort,
    disabled = false,
    compact = false,
    onLoad,
    onClear,
    onSortChange,
}: CofechaUndatedControlsProps) {
    return (
        <div className={`${styles["controls"]} ${compact ? styles["controls-compact"] : ""}`}>
            <button
                type="button"
                className={styles["load-button"]}
                disabled={disabled}
                title={fileName ? "更换未定年 RWL" : "加载未定年 RWL 并生成 PART 8"}
                onClick={() => { void onLoad(); }}
            >
                {fileName ? "更换未定年" : "加载未定年"}
            </button>
            {fileName ? (
                <>
                    <span className={styles["file-name"]} title={fileName}>{fileName}</span>
                    <select
                        className={styles["sort-select"]}
                        value={sort}
                        disabled={disabled}
                        aria-label="未定年匹配排序"
                        title="PART 8 排序"
                        onChange={(event) => {
                            void onSortChange(event.currentTarget.value as CofechaUndatedSort);
                        }}
                    >
                        <option value="correlation">最高相关 R</option>
                        <option value="adjustment">年份调整 D</option>
                    </select>
                    <button
                        type="button"
                        className={styles["clear-button"]}
                        disabled={disabled}
                        aria-label="清除未定年 RWL"
                        title="清除未定年 RWL"
                        onClick={() => { void onClear(); }}
                    >
                        ×
                    </button>
                </>
            ) : null}
        </div>
    );
}
