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
    const { settings, updateTreeRingImageSettings } = useSettings();
    const [usage, setUsage] = useState<CacheUsage | null>(null);
    const [includeWorkspaces, setIncludeWorkspaces] = useState(false);
    const [pending, setPending] = useState(() => pendingCacheCleanup());
    const [notice, setNotice] = useState(() => lastCacheCleanupResult() ?? "");
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let active = true;
        void getCacheUsage().then((value) => { if (active) setUsage(value); })
            .catch((error) => { if (active) setNotice(`无法统计缓存：${String(error)}`); });
        return () => { active = false; };
    }, []);
    const schedule = async () => {
        setBusy(true);
        try {
            if (includeWorkspaces && !await ask(
                "下次启动时将清除所有文件的本地工作区记录，包括未保存草稿、编辑历史、参考配置和扫描标注。请先保存需要保留的工作；此操作不能撤销。原始 RWL 和扫描图片不会删除。",
                { title: "清除文件工作区记录", kind: "warning", okLabel: "安排清理", cancelLabel: "取消" },
            )) return;
            scheduleCacheCleanup(includeWorkspaces);
            setPending(pendingCacheCleanup());
            setNotice("已安排清理，请关闭软件全部窗口后重新启动。");
        } catch (error) { setNotice(`无法安排清理：${String(error)}`); }
        finally { setBusy(false); }
    };
    return <div>
        <h2 className={styles["section-title"]}>缓存管理</h2>
        <div className={`${styles.row} ${styles["row-top"]}`}>
            <label className={styles["row-label"]} htmlFor="scan-cache-limit">影像缓存容量</label>
            <div className={styles["row-body"]}>
                <select id="scan-cache-limit" className={styles.select}
                    value={settings.treeRingImage.scanCacheLimitGiB}
                    onChange={(event) => updateTreeRingImageSettings({ scanCacheLimitGiB: Number(event.currentTarget.value) })}>
                    {SCAN_CACHE_LIMITS_GIB.map((size) => <option key={size} value={size}>{size} GiB{size === 16 ? "（默认）" : ""}</option>)}
                </select>
                <div className={styles["setting-note"]}>限制磁盘副本占用，不限制原始影像总量。下次加载影像时生效；正在读取的文件受保护，可能临时超过容量。大量大影像可选择32–128 GiB。</div>
            </div>
        </div>
        <div className={styles.row}>
            <span className={styles["row-label"]}>临时缓存</span>
            <div className={styles["row-body"]}>
                <span>{usage ? `${sizeLabel(usage.temporary.bytes)} · ${usage.temporary.files} 项` : "正在统计…"}</span>
                <div className={styles["setting-note"]}>COFECHA 临时文件、报告缓存和扫描影像副本。下次使用时重新生成，请保留原始 RWL 和扫描图片。</div>
            </div>
        </div>
        <div className={`${styles.row} ${styles["row-top"]}`}>
            <span className={styles["row-label"]}>工作区记录</span>
            <div className={styles["row-body"]}>
                <span>{usage ? `${sizeLabel(usage.workspace.bytes)} · ${usage.workspace.files} 项` : "正在统计…"}</span>
                <label className={styles.check}><input type="checkbox" checked={includeWorkspaces}
                    disabled={busy || Boolean(pending)} onChange={(event) => setIncludeWorkspaces(event.currentTarget.checked)} />
                    同时清除所有文件工作区记录</label>
                <div className={styles["setting-note"]}>默认保留未保存草稿、编辑历史、参考配置和扫描标注。文件改名后旧路径的记录也包含在这里。</div>
            </div>
        </div>
        <div className={styles.row}>
            <span className={styles["row-label"]}>执行清理</span>
            <div className={styles["row-body"]}>
                {pending ? <>
                    <span>下次启动清理：{pending.includeWorkspaces ? "临时缓存及全部工作区记录" : "仅临时缓存"}</span>
                    <button type="button" className={styles["secondary-button"]} onClick={() => {
                        try { cancelCacheCleanup(); setPending(null); setNotice("已取消清理。"); }
                        catch (error) { setNotice(`无法取消：${String(error)}`); }
                    }}>取消待执行清理</button>
                </> : <button type="button" className={styles["action-button"]} disabled={busy}
                    onClick={() => void schedule()}>下次启动时清理</button>}
                <div className={styles["setting-note"]}>清理在加载工作区前执行。原始文件、模型和软件设置会保留。</div>
                <div className={styles["setting-note"]} role="status">{notice}</div>
            </div>
        </div>
    </div>;
}
