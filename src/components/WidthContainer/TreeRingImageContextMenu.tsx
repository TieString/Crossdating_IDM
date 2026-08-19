import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type {
    TreeRingImageMode,
    TreeRingScanFile,
    TreeRingScanSeriesState,
} from "@/features/treeRingScans";
import { isTreeRingScanCalibrated } from "@/features/treeRingScans";
import menuStyles from "./WidthGridContextMenu.module.css";
import styles from "./TreeRingImageContextMenu.module.css";

interface TreeRingImageContextMenuProps {
    open: boolean;
    x: number;
    y: number;
    seriesId: string;
    folderPath: string | null;
    matchedCount: number;
    totalSeriesCount: number;
    scanFile?: TreeRingScanFile;
    scanState?: TreeRingScanSeriesState;
    mappingValid: boolean;
    mappingInvalidReason?: string;
    onLoadFolder: () => Promise<number>;
    onSetMode: (mode: TreeRingImageMode) => void;
    onOpenScan: () => void;
    onClose: () => void;
}

export function TreeRingImageContextMenu({
    open,
    x,
    y,
    seriesId,
    folderPath,
    matchedCount,
    totalSeriesCount,
    scanFile,
    scanState,
    mappingValid,
    mappingInvalidReason,
    onLoadFolder,
    onSetMode,
    onOpenScan,
    onClose,
}: TreeRingImageContextMenuProps) {
    const [status, setStatus] = useState<string | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState({ left: x, top: y, flipX: false, flipY: false });
    const calibrated = isTreeRingScanCalibrated(scanState);
    const scanModeAvailable = Boolean(scanFile && calibrated && mappingValid);

    useLayoutEffect(() => {
        if (!open || !menuRef.current) return;
        const rect = menuRef.current.getBoundingClientRect();
        const flipX = x + rect.width + 8 > window.innerWidth;
        const flipY = y + rect.height + 8 > window.innerHeight;
        const left = flipX ? Math.max(8, x - rect.width) : Math.max(8, x);
        const top = flipY ? Math.max(8, y - rect.height) : Math.max(8, y);
        setPosition((previous) => (
            previous.left === left
            && previous.top === top
            && previous.flipX === flipX
            && previous.flipY === flipY
                ? previous
                : { left, top, flipX, flipY }
        ));
    }, [open, status, x, y]);

    useEffect(() => {
        if (!open) return;
        setStatus(null);
        const close = () => onClose();
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("pointerdown", close);
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("pointerdown", close);
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [open, onClose]);

    if (!open || typeof document === "undefined") return null;

    const mode = scanState?.mode ?? "generated";
    const scanDisabledTitle = !scanFile
        ? "当前文件夹中没有与该序列同名的影像"
        : !scanState?.crop
            ? "请先打开扫描影像并框选长方形样芯截面"
        : !calibrated
            ? "请在选定截面上至少标注两个年代锚点"
            : mappingInvalidReason ?? "扫描影像年份映射不可用";
    const menuStyle = {
        left: position.left,
        top: position.top,
        ["--menu-origin-x" as string]: position.flipX ? "right" : "left",
        ["--menu-origin-y" as string]: position.flipY ? "bottom" : "top",
    } as CSSProperties;

    return createPortal(
        <div
            ref={menuRef}
            className={`${menuStyles["menu-root"]} ${styles.menuOverlay}`}
            style={menuStyle}
            role="menu"
            aria-label={`${seriesId} 年轮影像菜单`}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
        >
            <div className={styles.heading}>
                <span>{seriesId}</span>
                <span className={styles.headingHint}>年轮影像</span>
            </div>
            <button
                type="button"
                className={`${menuStyles["menu-row"]} ${styles.menuButton}`}
                role="menuitem"
                onClick={async () => {
                    setStatus("正在读取文件名…");
                    try {
                        const count = await onLoadFolder();
                        setStatus(count > 0 ? `已匹配 ${count} 条序列` : "没有找到同名影像");
                    } catch (error) {
                        setStatus(error instanceof Error ? error.message : "读取文件夹失败");
                    }
                }}
            >
                <span className={menuStyles["menu-row-icon"]} aria-hidden="true">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                        <path d="M3 10h18" />
                    </svg>
                </span>
                <span className={menuStyles["menu-row-label"]}>加载扫描影像文件夹…</span>
            </button>
            <div className={menuStyles["menu-separator"]} role="separator" />
            <button
                type="button"
                className={`${menuStyles["menu-row"]} ${styles.menuButton}${mode === "generated" ? ` ${menuStyles["menu-row-active"]}` : ""}`}
                role="menuitemradio"
                aria-checked={mode === "generated"}
                onClick={() => {
                    onSetMode("generated");
                    onClose();
                }}
            >
                <span className={`${menuStyles["menu-row-icon"]} ${styles.radioIcon}`} aria-hidden="true">
                    <span className={mode === "generated" ? styles.radioSelected : styles.radioEmpty} />
                </span>
                <span className={menuStyles["menu-row-label"]}>绘制版影像</span>
            </button>
            <button
                type="button"
                className={`${menuStyles["menu-row"]} ${styles.menuButton}${mode === "scan" ? ` ${menuStyles["menu-row-active"]}` : ""}`}
                role="menuitemradio"
                aria-checked={mode === "scan"}
                disabled={!scanModeAvailable}
                title={!scanModeAvailable ? scanDisabledTitle : "在序列 header 中显示扫描影像"}
                onClick={() => {
                    onSetMode("scan");
                    onClose();
                }}
            >
                <span className={`${menuStyles["menu-row-icon"]} ${styles.radioIcon}`} aria-hidden="true">
                    <span className={mode === "scan" ? styles.radioSelected : styles.radioEmpty} />
                </span>
                <span className={menuStyles["menu-row-label"]}>扫描影像</span>
            </button>
            <button
                type="button"
                className={`${menuStyles["menu-row"]} ${styles.menuButton}`}
                role="menuitem"
                disabled={!scanFile}
                title={scanFile ? "框选高分辨率样芯截面并标注年代锚点" : "当前序列没有同名影像"}
                onClick={() => {
                    onOpenScan();
                    onClose();
                }}
            >
                <span className={menuStyles["menu-row-icon"]} aria-hidden="true">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 17 17 4" /><path d="m14 4 3 3" />
                        <circle cx="6" cy="18" r="2" /><circle cx="18" cy="6" r="2" />
                    </svg>
                </span>
                <span className={menuStyles["menu-row-label"]}>
                    {calibrated
                        ? "查看或调整截面与年份锚点…"
                        : (scanState?.crop ? "打开并标注年份锚点…" : "打开并框选样芯截面…")}
                </span>
            </button>
            <div className={styles.footer}>
                {scanFile ? (
                    <>
                        <span title={scanFile.path}>{scanFile.name}</span>
                        <span>{scanState?.crop ? "已选截面" : "未选截面"} · {scanState?.anchors.length ?? 0} 个锚点</span>
                    </>
                ) : folderPath ? (
                    <span>已匹配 {matchedCount}/{totalSeriesCount}，本序列无同名影像</span>
                ) : (
                    <span>尚未加载扫描影像文件夹</span>
                )}
                {mappingInvalidReason && calibrated ? (
                    <span className={styles.warning}>{mappingInvalidReason}</span>
                ) : null}
                {status ? <span className={styles.status}>{status}</span> : null}
            </div>
        </div>,
        document.body,
    );
}
