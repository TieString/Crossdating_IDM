import styles from "./CofechaOutExportButton.module.css";

interface CofechaOutExportButtonProps {
    disabled: boolean;
    onExport: () => void | Promise<unknown>;
}

/** Explicitly export the complete raw COFECHA OUT currently held by the workspace. */
export function CofechaOutExportButton({ disabled, onExport }: CofechaOutExportButtonProps) {
    return (
        <button
            type="button"
            className={styles.button}
            disabled={disabled}
            aria-label="导出 COFECHA OUT"
            title={disabled ? "当前没有可导出的 COFECHA OUT" : "导出完整 COFECHA OUT"}
            onClick={() => { void onExport(); }}
        >
            <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
            >
                <path d="M12 3v12" />
                <path d="m7 10 5 5 5-5" />
                <path d="M5 20h14" />
            </svg>
        </button>
    );
}
