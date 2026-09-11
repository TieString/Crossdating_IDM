import { t, localizeMessage, setLocale, type Locale } from '@/i18n/core';
import { useLocale } from '@/i18n/react';
import { useId, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FloatingScrollArea } from "@/components/FloatingScrollArea/FloatingScrollArea";
import { useSettings } from "@/features/settings/SettingsContext";
import {
    CURRENT_APP_VERSION,
    GITHUB_RELEASES_URL,
    UpdateCheckError,
    checkGitHubRelease,
    normalizeUpdateProxyUrl,
    readAutoUpdateCheckEnabled,
    readCdnFallbackEnabled,
    readUpdateProxyUrl,
    writeAutoUpdateCheckEnabled,
    writeCdnFallbackEnabled,
    writeUpdateProxyUrl,
    type UpdateAttempt,
    type UpdateCheckResult,
    type UpdateSource,
} from "@/features/update/githubRelease";
import ltrrFavicon from "@/assets/ltrr-favicon.ico";
import {
    normalizeAnimationSpeed,
    type AnimationSettings,
} from "@/features/settings/settings";
import styles from "./SettingsPage.module.css";
import { CacheSection } from "./CacheSection";
import { WorkspaceTransferSection } from "./WorkspaceTransferSection";

type SectionId = "language" | "animation" | "tree-ring-image" | "diagnosis" | "cofecha" | "cache" | "transfer" | "about";

const SECTIONS: { id: SectionId; label: string }[] = [
    { id: "language", label: "语言" },
    { id: "animation", label: "动画" },
    { id: "tree-ring-image", label: "年轮图像" },
    { id: "diagnosis", label: "定年建议" },
    { id: "cofecha", label: "COFECHA" },
    { id: "cache", label: "缓存管理" },
    { id: "transfer", label: "工作区迁移" },
    { id: "about", label: "关于" },
];

const SPEED_PRESETS: { value: number; label: string }[] = [
    { value: 0.5, label: "0.5×（慢）" },
    { value: 0.75, label: "0.75×" },
    { value: 1, label: "1×（正常）" },
    { value: 1.5, label: "1.5×" },
    { value: 2, label: "2×（快）" },
    { value: 3, label: "3×（极快）" },
];

const LTRR_COFECHA_DOWNLOAD_URL = "https://www.ltrr.arizona.edu/pub/dpl/";

interface RowProps {
    label: string;
    htmlFor?: string;
    align?: "center" | "top";
    children: React.ReactNode;
}

/** Typora-style preferences row: bold label on the left, control(s) on the right. */
function Row({ label, htmlFor, align = "center", children }: RowProps) {
    useLocale();
    return (
        <div className={`${styles["row"]} ${align === "top" ? styles["row-top"] : ""}`}>
            <label className={styles["row-label"]} htmlFor={htmlFor}>{label}</label>
            <div className={styles["row-body"]}>{children}</div>
        </div>
    );
}

interface SelectProps {
    id?: string;
    value: string;
    disabled?: boolean;
    onChange: (value: string) => void;
    options: { value: string; label: string }[];
}

function Select({ id, value, disabled = false, onChange, options }: SelectProps) {
    useLocale();
    return (
        <span className={styles["select-wrap"]}>
            <select
                id={id}
                className={styles["select"]}
                value={value}
                disabled={disabled}
                onChange={(event) => onChange(event.currentTarget.value)}
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value}>{localizeMessage(option.label)}</option>
                ))}
            </select>
        </span>
    );
}

function LanguageSection() {
    const locale = useLocale();
    const [saveFailed, setSaveFailed] = useState(false);
    const id = useId();
    return <div>
        <h2 className={styles["section-title"]}>{t("语言设置")}</h2>
        <Row label={t("界面语言")} htmlFor={id} align="top">
            <Select id={id} value={locale}
                onChange={(value) => setSaveFailed(!setLocale(value as Locale))}
                options={[{ value: "zh-CN", label: "简体中文" }, { value: "en-US", label: "English" }]} />
            <div className={styles["setting-note"]}>{t("切换立即生效，并同步到所有已打开窗口；不会关闭文件或丢失未保存的编辑。")}</div>
            <div className={styles["setting-note"]}>{t("所选语言会在下次启动时保留。")}</div>
            {saveFailed && <div role="status">{t("语言偏好无法保存；本次切换仍然有效。")}</div>}
        </Row>
    </div>;
}

function AnimationSection() {
    useLocale();
    const { settings, updateAnimationSettings } = useSettings();
    const anim = settings.animation;
    const groupId = useId();
    const disabled = anim.enabled === "disabled";
    const speed = normalizeAnimationSpeed(anim.speed);
    const nearestSpeed = SPEED_PRESETS.reduce((closest, preset) => (
        Math.abs(preset.value - speed) < Math.abs(closest.value - speed) ? preset : closest
    ), SPEED_PRESETS[0]).value;

    const update = <K extends keyof AnimationSettings>(key: K) => (value: string) => {
        updateAnimationSettings({ [key]: value } as unknown as Partial<AnimationSettings>);
    };

    return (
        <div>
            <h2 className={styles["section-title"]}>{t("动画")}</h2>

            <Row label={t("动画效果")}>
                <label className={styles["check"]}>
                    <input
                        type="checkbox"
                        checked={anim.enabled === "enabled"}
                        onChange={(event) => updateAnimationSettings({
                            enabled: event.currentTarget.checked ? "enabled" : "disabled",
                        })}
                    />
                    <span>{t("启用动画")}</span>
                </label>
            </Row>

            <Row label={t("动画速度")} htmlFor={`${groupId}-speed`}>
                <Select
                    id={`${groupId}-speed`}
                    value={String(nearestSpeed)}
                    disabled={disabled}
                    onChange={(value) => updateAnimationSettings({ speed: normalizeAnimationSpeed(value) })}
                    options={SPEED_PRESETS.map((preset) => ({ value: String(preset.value), label: preset.label }))}
                />
            </Row>

            <Row label={t("删除序列动画")} htmlFor={`${groupId}-del-series`}>
                <Select
                    id={`${groupId}-del-series`}
                    value={anim.deleteSeries}
                    disabled={disabled}
                    onChange={update("deleteSeries")}
                    options={[
                        { value: "fade", label: t("淡出消散（默认）") },
                        { value: "shatter-rise", label: t("粉碎上升") },
                        { value: "none", label: t("无动画") },
                    ]}
                />
            </Row>

            <Row label={t("删除年份动画")} htmlFor={`${groupId}-del-year`}>
                <Select
                    id={`${groupId}-del-year`}
                    value={anim.deleteYear}
                    disabled={disabled}
                    onChange={update("deleteYear")}
                    options={[
                        { value: "pixel-burst", label: t("像素爆炸（默认）") },
                        { value: "none", label: t("无动画") },
                    ]}
                />
            </Row>

            <Row label={t("插入年份动画")} htmlFor={`${groupId}-ins-year`}>
                <Select
                    id={`${groupId}-ins-year`}
                    value={anim.insertYear}
                    disabled={disabled}
                    onChange={update("insertYear")}
                    options={[
                        { value: "slide-shift", label: t("底层浮现（默认）") },
                        { value: "pulse-shift", label: t("脉冲浮现") },
                        { value: "side-pop-shift", label: t("侧向弹入") },
                        { value: "flight-shift", label: t("跨行飞入") },
                        { value: "none", label: t("无动画") },
                    ]}
                />
            </Row>

            <Row label={t("撤销 / 恢复动画")} htmlFor={`${groupId}-history`}>
                <Select
                    id={`${groupId}-history`}
                    value={anim.historyAnim}
                    disabled={disabled}
                    onChange={update("historyAnim")}
                    options={[
                        { value: "enabled", label: t("启用（默认）") },
                        { value: "disabled", label: t("禁用") },
                    ]}
                />
            </Row>
        </div>
    );
}

export function CofechaSection() {
    useLocale();
    const { settings, updateCofechaSettings } = useSettings();
    const executablePath = settings.cofecha.executablePath;

    const selectExecutable = async () => {
        const selected = await open({
            title: t("加载 COFECHA 可执行文件"),
            multiple: false,
            directory: false,
            filters: [{ name: t("Windows 可执行文件"), extensions: ["exe"] }],
        });
        if (typeof selected !== "string") return;

        updateCofechaSettings({ executablePath: selected });
    };

    const clearExecutable = () => {
        updateCofechaSettings({ executablePath: "" });
    };

    return (
        <div>
            <h2 className={styles["section-title"]}>COFECHA</h2>

            <Row label={t("报告引擎")} align="top">
                <div className={styles["segmented-control"]} role="group" aria-label={t("COFECHA 报告引擎")}>
                    <button className={`${styles["segment-button"]} ${settings.cofecha.engine === "javascript" ? styles["segment-button-active"] : ""}`}
                        type="button" aria-pressed={settings.cofecha.engine === "javascript"}
                        onClick={() => updateCofechaSettings({ engine: "javascript" })}>JavaScript</button>
                    <button className={`${styles["segment-button"]} ${settings.cofecha.engine === "official" ? styles["segment-button-active"] : ""}`}
                        type="button" aria-pressed={settings.cofecha.engine === "official"}
                        onClick={() => updateCofechaSettings({ engine: "official" })}>{t("官方 COFECHA")}</button>
                </div>
                <div className={styles["setting-note"]}>{t("报告、动态参考和自动定年建议共享该引擎生成的当前报告。")}</div>
            </Row>

            <Row label={t("可执行文件")} align="top">
                <div className={styles["executable-row"]}>
                    <input
                        className={styles["path-input"]}
                        value={executablePath}
                        readOnly
                        placeholder={t("尚未选择 COFECHA EXE")}
                        aria-label={t("COFECHA 可执行文件路径")}
                    />
                    <button className={styles["action-button"]} type="button" onClick={() => void selectExecutable()}>
                        {t("选择 EXE")}</button>
                    {executablePath && (
                        <button className={styles["secondary-button"]} type="button" onClick={clearExecutable}>
                            {t("清除")}</button>
                    )}
                </div>
                <div className={executablePath ? styles["configured-status"] : styles["unconfigured-status"]}>
                    {executablePath ? t("官方 COFECHA 已配置") : t("官方 COFECHA 尚未配置")}
                </div>
            </Row>

            <Row label={t("官方获取")} align="top">
                <button
                    className={styles["download-button"]}
                    type="button"
                    onClick={() => void openUrl(LTRR_COFECHA_DOWNLOAD_URL)}
                >
                    <img className={styles["website-icon"]} src={ltrrFavicon} alt="" aria-hidden="true" />
                    <span>{t("下载")}</span>
                </button>
                <div className={styles["setting-note"]}>
                    {t("Crossdating IDM 不附带 COFECHA。")}</div>
            </Row>
        </div>
    );
}

function DiagnosisSection() {
    useLocale();
    const { settings, updateDiagnosisSettings } = useSettings();

    return (
        <div>
            <h2 className={styles["section-title"]}>{t("定年建议")}</h2>

            <Row label={t("自动分析")} align="top">
                <label className={styles["check"]}>
                    <input
                        type="checkbox"
                        checked={settings.diagnosis.enabled}
                        onChange={(event) => updateDiagnosisSettings({
                            enabled: event.currentTarget.checked,
                        })}
                    />
                    <span>{t("选择序列或编辑数据后自动生成定年建议")}</span>
                </label>
                <div className={styles["setting-note"]}>
                    {t("关闭后会停止当前自动分析并隐藏建议；COFECHA 验证与已有编辑记录不受影响。")}</div>
            </Row>
        </div>
    );
}

function TreeRingImageSection() {
    useLocale();
    const { settings, updateTreeRingImageSettings } = useSettings();

    return (
        <div>
            <h2 className={styles["section-title"]}>{t("年轮图像")}</h2>

            <Row label={t("绘制图片")} align="top">
                <label className={styles["check"]}>
                    <input
                        type="checkbox"
                        checked={settings.treeRingImage.showGeneratedPreview}
                        onChange={(event) => updateTreeRingImageSettings({
                            showGeneratedPreview: event.currentTarget.checked,
                        })}
                    />
                    <span>{t("在序列 header 中显示绘制年轮图")}</span>
                </label>
                <div className={styles["setting-note"]}>
                    {t("关闭后不生成或显示 header 绘制图，但保留原按钮、右键菜单和双击打开功能；扫描影像不受影响。")}</div>
            </Row>
        </div>
    );
}

function updateSourceLabel(source: UpdateSource): string {
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
}

export default function SettingsPage() {
    useLocale();
    const [activeSection, setActiveSection] = useState<SectionId>("language");
    const [query, setQuery] = useState("");

    const normalizedQuery = query.trim().toLowerCase();
    const visibleSections = normalizedQuery
        ? SECTIONS.filter((section) => localizeMessage(section.label).toLowerCase().includes(normalizedQuery))
        : SECTIONS;

    return (
        <div className={styles["page"]}>
            <div className={styles["body"]}>
                <div className={styles["sidebar"]}>
                    <input
                        className={styles["search"]}
                        type="text"
                        placeholder={t("查找...")}
                        value={query}
                        onChange={(event) => setQuery(event.currentTarget.value)}
                    />
                    <FloatingScrollArea
                        className={styles["sidebar-nav"]}
                        viewportClassName={styles["sidebar-viewport"]}
                        role="navigation"
                    >
                        {visibleSections.map((section) => (
                            <button
                                key={section.id}
                                className={`${styles["sidebar-item"]} ${activeSection === section.id ? styles["sidebar-item-active"] : ""}`}
                                onClick={() => setActiveSection(section.id)}
                            >
                                {localizeMessage(section.label)}
                            </button>
                        ))}
                    </FloatingScrollArea>
                </div>

                <FloatingScrollArea className={styles["content"]}>
                    {activeSection === "language" && <LanguageSection />}
                    {activeSection === "animation" && <AnimationSection />}
                    {activeSection === "tree-ring-image" && <TreeRingImageSection />}
                    {activeSection === "diagnosis" && <DiagnosisSection />}
                    {activeSection === "cofecha" && <CofechaSection />}
                    {activeSection === "cache" && <CacheSection />}
                    {activeSection === "transfer" && <WorkspaceTransferSection />}
                    {activeSection === "about" && <AboutSection />}
                </FloatingScrollArea>
            </div>
        </div>
    );
}
