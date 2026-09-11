import { t, localizeMessage, localizeError } from '@/i18n/core';
import { useLocale } from '@/i18n/react';
import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { cancelCacheCleanup, getCacheUsage, lastCacheCleanupResult,
    pendingCacheCleanup, scheduleCacheCleanup, type CacheUsage } from "@/services/fs/cacheMaintenance";
import styles from "./SettingsPage.module.css";
import { useSettings } from "@/features/settings/SettingsContext";
import { SCAN_CACHE_LIMITS_GIB } from "@/features/settings/settings";

const sizeLabel = (bytes: number) => bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function CacheSection() {
    useLocale();
    const { settings, updateTreeRingImageSettings } = useSettings();
    const [usage, setUsage] = useState<CacheUsage | null>(null);
    const [includeWorkspaces, setIncludeWorkspaces] = useState(false);
    const [pending, setPending] = useState(() => pendingCacheCleanup());
    const [notice, setNotice] = useState(() => lastCacheCleanupResult() ?? "");
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let active = true;
        void getCacheUsage().then((value) => { if (active) setUsage(value); })
            .catch((error) => { if (active) setNotice(t("无法统计缓存：{0}", [localizeError(error)])); });
        return () => { active = false; };
    }, []);
    const schedule = async () => {
        setBusy(true);
        try {
            if (includeWorkspaces && !await ask(
                t("下次启动时将清除所有文件的本地工作区记录，包括未保存草稿、编辑历史、参考配置和扫描标注。请先保存需要保留的工作；此操作不能撤销。原始 RWL 和扫描图片不会删除。"),
                { title: t("清除文件工作区记录"), kind: "warning", okLabel: t("安排清理"), cancelLabel: t("取消") },
            )) return;
            scheduleCacheCleanup(includeWorkspaces);
            setPending(pendingCacheCleanup());
            setNotice(t("已安排清理，请关闭软件全部窗口后重新启动。"));
        } catch (error) { setNotice(t("无法安排清理：{0}", [localizeError(error)])); }
        finally { setBusy(false); }
    };
    return <div>
        <h2 className={styles["section-title"]}>{t("缓存管理")}</h2>
        <div className={`${styles.row} ${styles["row-top"]}`}>
            <label className={styles["row-label"]} htmlFor="scan-cache-limit">{t("影像缓存容量")}</label>
            <div className={styles["row-body"]}>
                <select id="scan-cache-limit" className={styles.select}
                    value={settings.treeRingImage.scanCacheLimitGiB}
                    onChange={(event) => updateTreeRingImageSettings({ scanCacheLimitGiB: Number(event.currentTarget.value) })}>
                    {SCAN_CACHE_LIMITS_GIB.map((size) => <option key={size} value={size}>{size} GiB{size === 16 ? t("（默认）") : ""}</option>)}
                </select>
                <div className={styles["setting-note"]}>{t("限制磁盘副本占用，不限制原始影像总量。下次加载影像时生效；正在读取的文件受保护，可能临时超过容量。大量大影像可选择32–128 GiB。")}</div>
            </div>
        </div>
        <div className={styles.row}>
            <span className={styles["row-label"]}>{t("临时缓存")}</span>
            <div className={styles["row-body"]}>
                <span>{usage ? t("{0} · {1} 项", [sizeLabel(usage.temporary.bytes), usage.temporary.files]) : t("正在统计…")}</span>
                <div className={styles["setting-note"]}>{t("COFECHA 临时文件、报告缓存和扫描影像副本。下次使用时重新生成，请保留原始 RWL 和扫描图片。")}</div>
            </div>
        </div>
        <div className={`${styles.row} ${styles["row-top"]}`}>
            <span className={styles["row-label"]}>{t("工作区记录")}</span>
            <div className={styles["row-body"]}>
                <span>{usage ? t("{0} · {1} 项", [sizeLabel(usage.workspace.bytes), usage.workspace.files]) : t("正在统计…")}</span>
                <label className={styles.check}><input type="checkbox" checked={includeWorkspaces}
                    disabled={busy || Boolean(pending)} onChange={(event) => setIncludeWorkspaces(event.currentTarget.checked)} />
                    {t("同时清除所有文件工作区记录")}</label>
                <div className={styles["setting-note"]}>{t("默认保留未保存草稿、编辑历史、参考配置和扫描标注。文件改名后旧路径的记录也包含在这里。")}</div>
            </div>
        </div>
        <div className={styles.row}>
            <span className={styles["row-label"]}>{t("执行清理")}</span>
            <div className={styles["row-body"]}>
                {pending ? <>
                    <span>{t("下次启动清理：")}{pending.includeWorkspaces ? t("临时缓存及全部工作区记录") : t("仅临时缓存")}</span>
                    <button type="button" className={styles["secondary-button"]} onClick={() => {
                        try { cancelCacheCleanup(); setPending(null); setNotice(t("已取消清理。")); }
                        catch (error) { setNotice(t("无法取消：{0}", [localizeError(error)])); }
                    }}>{t("取消待执行清理")}</button>
                </> : <button type="button" className={styles["action-button"]} disabled={busy}
                    onClick={() => void schedule()}>{t("下次启动时清理")}</button>}
                <div className={styles["setting-note"]}>{t("清理在加载工作区前执行。原始文件、模型和软件设置会保留。")}</div>
                <div className={styles["setting-note"]} role="status">{localizeMessage(notice)}</div>
            </div>
        </div>
    </div>;
}
