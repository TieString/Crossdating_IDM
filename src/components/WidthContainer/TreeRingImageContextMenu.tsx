import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type {
    TreeRingImageMode,
    TreeRingScanFile,
    TreeRingScanSeriesState,
} from "@/features/treeRingScans";
import { isTreeRingScanCalibrated } from "@/features/treeRingScans";
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
    const calibrated = isTreeRingScanCalibrated(scanState);
    const scanModeAvailable = Boolean(scanFile && calibrated && mappingValid);
    const position = useMemo(() => {
        if (typeof window === "undefined") return { left: x, top: y };
        return {
            left: Math.max(8, Math.min(x, window.innerWidth - 288)),
            top: Math.max(8, Math.min(y, window.innerHeight - 286)),
        };
    }, [x, y]);

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

    return createPortal(
        <div
            className={styles.menu}
            style={position}
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
                className={styles.action}
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
                加载扫描影像文件夹…
            </button>
            <div className={styles.separator} />
            <button
                type="button"
                className={`${styles.modeItem}${mode === "generated" ? ` ${styles.selected}` : ""}`}
                role="menuitemradio"
                aria-checked={mode === "generated"}
                onClick={() => {
                    onSetMode("generated");
                    onClose();
                }}
            >
                <span className={styles.radio}>{mode === "generated" ? "●" : "○"}</span>
                绘制版影像
            </button>
            <button
                type="button"
                className={`${styles.modeItem}${mode === "scan" ? ` ${styles.selected}` : ""}`}
                role="menuitemradio"
                aria-checked={mode === "scan"}
                disabled={!scanModeAvailable}
                title={!scanModeAvailable ? scanDisabledTitle : "在序列 header 中显示扫描影像"}
                onClick={() => {
                    onSetMode("scan");
                    onClose();
                }}
            >
                <span className={styles.radio}>{mode === "scan" ? "●" : "○"}</span>
                扫描影像
            </button>
            <button
                type="button"
                className={styles.action}
                role="menuitem"
                disabled={!scanFile}
                title={scanFile ? "框选高分辨率样芯截面并标注年代锚点" : "当前序列没有同名影像"}
                onClick={() => {
                    onOpenScan();
                    onClose();
                }}
            >
                {calibrated
                    ? "查看或调整截面与年份锚点…"
                    : (scanState?.crop ? "打开并标注年份锚点…" : "打开并框选样芯截面…")}
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
