import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "@/i18n/core";
import { useLocale } from "@/i18n/react";
import {
    checkGitHubRelease,
    markAutomaticUpdateCheck,
    shouldRunAutomaticUpdateCheck,
    type GitHubReleaseInfo,
} from "./githubRelease";
import styles from "./UpdateNotice.module.css";

export function UpdateNotice() {
    useLocale();
    const [release, setRelease] = useState<GitHubReleaseInfo | null>(null);

    useEffect(() => {
        if (!shouldRunAutomaticUpdateCheck()) return;
        let active = true;
        markAutomaticUpdateCheck();
        void checkGitHubRelease().then((result) => {
            if (active && result.status === "available") setRelease(result.latest);
        }).catch(() => {
            // Startup checks are intentionally silent; manual checks surface errors in Settings.
        });
        return () => { active = false; };
    }, []);

    if (!release) return null;

    return (
        <aside className={styles["notice"]} role="status" aria-live="polite">
            <div className={styles["copy"]}>
                <strong>{t("发现新版本 {0}", [release.version])}</strong>
                <span>{t("当前版本可以继续使用；更新不会自动下载或安装。")}</span>
            </div>
            <div className={styles["actions"]}>
                <button type="button" className={styles["primary"]} onClick={() => void openUrl(release.htmlUrl)}>
                    {t("查看更新")}
                </button>
                <button type="button" className={styles["secondary"]} onClick={() => setRelease(null)}>
                    {t("稍后")}
                </button>
            </div>
        </aside>
    );
}
