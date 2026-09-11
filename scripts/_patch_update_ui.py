from pathlib import Path
import json
import re

root = Path(__file__).resolve().parents[1]

settings_path = root / "src/pages/settings/SettingsPage.tsx"
settings = settings_path.read_text(encoding="utf-8")
settings, import_count = re.subn(
    r'import \{\n    CURRENT_APP_VERSION,\n.*?\n\} from "@/features/update/githubRelease";',
    'import {\n    CURRENT_APP_VERSION,\n    GITHUB_RELEASES_URL,\n    UpdateCheckError,\n    checkGitHubRelease,\n    normalizeUpdateProxyUrl,\n    readAutoUpdateCheckEnabled,\n    readCdnFallbackEnabled,\n    readUpdateProxyUrl,\n    writeAutoUpdateCheckEnabled,\n    writeCdnFallbackEnabled,\n    writeUpdateProxyUrl,\n    type UpdateAttempt,\n    type UpdateCheckResult,\n    type UpdateSource,\n} from "@/features/update/githubRelease";',
    settings,
    count=1,
    flags=re.S,
)
if import_count != 1:
    raise SystemExit("could not replace update import block")

new_about = r'''function updateSourceLabel(source: UpdateSource): string {
    if (source === "github-api") return "GitHub API";
    if (source === "github-web") return t("GitHub Release 页面");
    return t("jsDelivr 备用清单");
}

function updateFailureLabel(attempt: UpdateAttempt): string {
    if (attempt.reason === "timeout") return t("连接超时");
    if (attempt.reason === "network") return t("网络连接失败");
    if (attempt.reason === "http") return t("HTTP 状态码 {0}", [String(attempt.status ?? "?")]);
    if (attempt.reason === "invalid-data") return t("返回的版本信息无效");
    if (attempt.reason === "permission") return t("请求被应用网络权限拒绝");
    return t("未知错误");
}

function AboutSection() {
    useLocale();
    const [checking, setChecking] = useState(false);
    const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);
    const [checkError, setCheckError] = useState<UpdateCheckError | null>(null);
    const [autoCheck, setAutoCheck] = useState(() => readAutoUpdateCheckEnabled());
    const [proxyUrl, setProxyUrl] = useState(() => readUpdateProxyUrl());
    const [cdnFallback, setCdnFallback] = useState(() => readCdnFallbackEnabled());
    const [preferenceSaveFailed, setPreferenceSaveFailed] = useState(false);
    const [networkSaveState, setNetworkSaveState] = useState<"idle" | "saved" | "failed" | "invalid" | "auth">("idle");

    const normalizedProxyOrNull = (): string | null => {
        try {
            const normalized = normalizeUpdateProxyUrl(proxyUrl);
            setNetworkSaveState("idle");
            return normalized;
        } catch (error) {
            setNetworkSaveState(error instanceof Error && error.message === "proxy-auth-not-supported" ? "auth" : "invalid");
            return null;
        }
    };

    const checkForUpdate = async () => {
        const normalizedProxy = normalizedProxyOrNull();
        if (normalizedProxy === null) return;

        setChecking(true);
        setCheckError(null);
        setCheckResult(null);
        try {
            setCheckResult(await checkGitHubRelease(CURRENT_APP_VERSION, {
                proxyUrl: normalizedProxy,
                useCdnFallback: cdnFallback,
            }));
        } catch (error) {
            setCheckError(error instanceof UpdateCheckError ? error : new UpdateCheckError([]));
        } finally {
            setChecking(false);
        }
    };

    const saveNetworkSettings = () => {
        const normalizedProxy = normalizedProxyOrNull();
        if (normalizedProxy === null) return;
        const saved = writeUpdateProxyUrl(normalizedProxy) && writeCdnFallbackEnabled(cdnFallback);
        setProxyUrl(normalizedProxy);
        setNetworkSaveState(saved ? "saved" : "failed");
    };

    const changeAutoCheck = (enabled: boolean) => {
        setAutoCheck(enabled);
        setPreferenceSaveFailed(!writeAutoUpdateCheckEnabled(enabled));
    };

    return (
        <div>
            <h2 className={styles["section-title"]}>{t("关于")}</h2>

            <Row label={t("应用名称")}><span className={styles["about-text"]}>{t("交叉定年 · IDM")}</span></Row>
            <Row label={t("版本")}><span className={styles["about-text"]}>{CURRENT_APP_VERSION}</span></Row>
            <Row label={t("软件更新")} align="top">
                <div className={styles["update-controls"]}>
                    <button className={styles["action-button"]} type="button" disabled={checking} onClick={() => void checkForUpdate()}>
                        {checking ? t("正在检查...") : t("检查更新")}
                    </button>
                    <button className={styles["secondary-button"]} type="button" onClick={() => void openUrl(GITHUB_RELEASES_URL)}>
                        {t("打开 GitHub Releases")}
                    </button>
                    {checkResult?.status === "available" && (
                        <button className={styles["download-button"]} type="button" onClick={() => void openUrl(checkResult.latest.htmlUrl)}>
                            {t("查看 GitHub Release")}
                        </button>
                    )}
                </div>

                {checkResult?.status === "available" && (
                    <div className={styles["update-result"]} role="status">
                        <strong>{t("发现新版本 {0}", [checkResult.latest.version])}</strong>
                        <span>{t("当前版本：{0}", [checkResult.currentVersion])}</span>
                        {checkResult.latest.body && <pre className={styles["release-notes"]}>{checkResult.latest.body}</pre>}
                    </div>
                )}
                {checkResult?.status === "current" && (
                    <div className={styles["configured-status"]} role="status">
                        {t("已是最新版（{0}）", [checkResult.currentVersion])}
                    </div>
                )}
                {checkResult && (
                    <div className={styles["setting-note"]}>
                        {t("更新信息来源：{0}", [updateSourceLabel(checkResult.source)])}
                    </div>
                )}
                {checkError && (
                    <div className={styles["update-error"]} role="status">
                        <strong>{t("无法完成更新检查。")}</strong>
                        {checkError.attempts.length > 0 && (
                            <>
                                <span>{t("更新检查尝试：")}</span>
                                <ul className={styles["update-attempts"]}>
                                    {checkError.attempts.map((attempt) => (
                                        <li key={attempt.source}>
                                            {updateSourceLabel(attempt.source)}：{updateFailureLabel(attempt)}
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                        <span>{t("如果当前网络无法直连 GitHub，可填写本机 HTTP/HTTPS 代理地址。")}</span>
                    </div>
                )}

                <div className={styles["network-settings"]}>
                    <label className={styles["network-label"]}>
                        <span>{t("代理地址（可选）")}</span>
                        <input
                            className={styles["network-input"]}
                            value={proxyUrl}
                            onChange={(event) => {
                                setProxyUrl(event.currentTarget.value);
                                setNetworkSaveState("idle");
                            }}
                            placeholder={t("例如 http://127.0.0.1:7890")}
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                        />
                    </label>
                    <label className={styles["check"]}>
                        <input
                            type="checkbox"
                            checked={cdnFallback}
                            onChange={(event) => {
                                setCdnFallback(event.currentTarget.checked);
                                setNetworkSaveState("idle");
                            }}
                        />
                        <span>{t("允许使用 jsDelivr 只读版本清单作为备用更新源")}</span>
                    </label>
                    <div className={styles["setting-note"]}>
                        {t("备用源只读取版本元数据，不会下载或执行安装包；可随时关闭。")}
                    </div>
                    <div className={styles["update-controls"]}>
                        <button className={styles["secondary-button"]} type="button" onClick={saveNetworkSettings}>
                            {t("保存网络设置")}
                        </button>
                        {networkSaveState === "saved" && <span className={styles["configured-status"]}>{t("网络设置已保存。")}</span>}
                        {networkSaveState === "failed" && <span className={styles["unconfigured-status"]}>{t("无法保存网络设置。")}</span>}
                        {networkSaveState === "invalid" && <span className={styles["unconfigured-status"]}>{t("代理地址无效，请使用 http:// 或 https:// 地址。")}</span>}
                        {networkSaveState === "auth" && <span className={styles["unconfigured-status"]}>{t("代理地址暂不支持在 URL 中保存用户名或密码。")}</span>}
                    </div>
                </div>

                <label className={styles["check"]}>
                    <input type="checkbox" checked={autoCheck} onChange={(event) => changeAutoCheck(event.currentTarget.checked)} />
                    <span>{t("启动时自动检查更新")}</span>
                </label>
                <div className={styles["setting-note"]}>
                    {t("自动检查最多每 12 小时访问一次公开的 GitHub Releases；只读取版本信息，不会自动下载或安装。")}</div>
                {preferenceSaveFailed && (
                    <div className={styles["unconfigured-status"]} role="status">
                        {t("自动检查更新偏好无法保存；本次设置仍然有效。")}
                    </div>
                )}
            </Row>
            <Row label={t("技术栈")}><span className={styles["about-text"]}>Tauri · React · TypeScript</span></Row>
            <Row label="COFECHA"><span className={styles["about-text"]}>Richard L. Holmes · LTRR Dendrochronology Program Library</span></Row>
            <Row label={t("研发团队")} align="top">
                <span className={styles["about-text"]}>
                    {t("何志浩、张同文、张瑞波")}<br />
                    {t("靳春寒、喻树龙、尚华明、秦莉")}</span>
            </Row>
        </div>
    );
}'''

replacement = new_about + "\n\nexport default function SettingsPage"
settings, about_count = re.subn(
    r'function AboutSection\(\) \{.*?\n\}\n\nexport default function SettingsPage',
    replacement,
    settings,
    count=1,
    flags=re.S,
)
if about_count != 1:
    raise SystemExit("could not replace AboutSection")
settings_path.write_text(settings, encoding="utf-8")

css_path = root / "src/pages/settings/SettingsPage.module.css"
css = css_path.read_text(encoding="utf-8")
css_add = r'''

.update-error {
    max-width: 600px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 9px 10px;
    border: 1px solid #e2c9ae;
    border-radius: 5px;
    background: #fffaf4;
    color: #8a5425;
    font-size: 12.5px;
    line-height: 1.45;
}

.update-attempts {
    margin: 0;
    padding-left: 20px;
}

.network-settings {
    max-width: 600px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 0 2px;
}

.network-label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12.5px;
    color: #555;
}

.network-input {
    width: 100%;
    min-height: 34px;
    box-sizing: border-box;
    padding: 6px 10px;
    border: 1px solid #cfcfcf;
    border-radius: 5px;
    background: #fff;
    color: #333;
    font-family: Consolas, "Microsoft YaHei", sans-serif;
    font-size: 12.5px;
}

.network-input:focus {
    outline: none;
    border-color: #8bb7e0;
}

@media (prefers-color-scheme: dark) {
    .update-error {
        border-color: #725b46;
        background: #352f29;
        color: #e3b98d;
    }

    .network-label {
        color: #ccc;
    }

    .network-input {
        border-color: #555;
        background: #2c2c2c;
        color: #eee;
    }
}
'''
if ".network-settings {" not in css:
    css = css.rstrip() + css_add + "\n"
css_path.write_text(css, encoding="utf-8")

en_path = root / "src/i18n/en.json"
translations = json.loads(en_path.read_text(encoding="utf-8"))
translations.update({
    "GitHub Release 页面": "GitHub Releases page",
    "jsDelivr 备用清单": "jsDelivr fallback manifest",
    "连接超时": "Connection timed out",
    "网络连接失败": "Network connection failed",
    "HTTP 状态码 {0}": "HTTP status {0}",
    "返回的版本信息无效": "The returned version metadata is invalid",
    "请求被应用网络权限拒绝": "The request was denied by the app network permissions",
    "未知错误": "Unknown error",
    "打开 GitHub Releases": "Open GitHub Releases",
    "更新信息来源：{0}": "Update source: {0}",
    "无法完成更新检查。": "Could not complete the update check.",
    "更新检查尝试：": "Update attempts:",
    "如果当前网络无法直连 GitHub，可填写本机 HTTP/HTTPS 代理地址。": "If this network cannot reach GitHub directly, enter a local HTTP/HTTPS proxy address.",
    "代理地址（可选）": "Proxy address (optional)",
    "例如 http://127.0.0.1:7890": "For example: http://127.0.0.1:7890",
    "允许使用 jsDelivr 只读版本清单作为备用更新源": "Allow the read-only jsDelivr version manifest as a fallback source",
    "备用源只读取版本元数据，不会下载或执行安装包；可随时关闭。": "The fallback source only reads version metadata; it never downloads or runs installers and can be disabled at any time.",
    "保存网络设置": "Save network settings",
    "网络设置已保存。": "Network settings saved.",
    "无法保存网络设置。": "Could not save network settings.",
    "代理地址无效，请使用 http:// 或 https:// 地址。": "Invalid proxy address. Use an http:// or https:// URL.",
    "代理地址暂不支持在 URL 中保存用户名或密码。": "Proxy URLs with embedded usernames or passwords are not supported."
})
en_path.write_text(json.dumps(translations, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
