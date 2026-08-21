import { useId, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FloatingScrollArea } from "@/components/FloatingScrollArea/FloatingScrollArea";
import { useSettings } from "@/features/settings/SettingsContext";
import ltrrFavicon from "@/assets/ltrr-favicon.ico";
import {
    normalizeAnimationSpeed,
    type AnimationSettings,
} from "@/features/settings/settings";
import styles from "./SettingsPage.module.css";

type SectionId = "animation" | "tree-ring-image" | "diagnosis" | "cofecha" | "about";

const SECTIONS: { id: SectionId; label: string }[] = [
    { id: "animation", label: "动画" },
    { id: "tree-ring-image", label: "年轮图像" },
    { id: "diagnosis", label: "定年建议" },
    { id: "cofecha", label: "COFECHA" },
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
                    <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </select>
        </span>
    );
}

function AnimationSection() {
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
            <h2 className={styles["section-title"]}>动画</h2>

            <Row label="动画效果">
                <label className={styles["check"]}>
                    <input
                        type="checkbox"
                        checked={anim.enabled === "enabled"}
                        onChange={(event) => updateAnimationSettings({
                            enabled: event.currentTarget.checked ? "enabled" : "disabled",
                        })}
                    />
                    <span>启用动画</span>
                </label>
            </Row>

            <Row label="动画速度" htmlFor={`${groupId}-speed`}>
                <Select
                    id={`${groupId}-speed`}
                    value={String(nearestSpeed)}
                    disabled={disabled}
                    onChange={(value) => updateAnimationSettings({ speed: normalizeAnimationSpeed(value) })}
                    options={SPEED_PRESETS.map((preset) => ({ value: String(preset.value), label: preset.label }))}
                />
            </Row>

            <Row label="删除序列动画" htmlFor={`${groupId}-del-series`}>
                <Select
                    id={`${groupId}-del-series`}
                    value={anim.deleteSeries}
                    disabled={disabled}
                    onChange={update("deleteSeries")}
                    options={[
                        { value: "fade", label: "淡出消散（默认）" },
                        { value: "shatter-rise", label: "粉碎上升" },
                        { value: "none", label: "无动画" },
                    ]}
                />
            </Row>

            <Row label="删除年份动画" htmlFor={`${groupId}-del-year`}>
                <Select
                    id={`${groupId}-del-year`}
                    value={anim.deleteYear}
                    disabled={disabled}
                    onChange={update("deleteYear")}
                    options={[
                        { value: "pixel-burst", label: "像素爆炸（默认）" },
                        { value: "none", label: "无动画" },
                    ]}
                />
            </Row>

            <Row label="插入年份动画" htmlFor={`${groupId}-ins-year`}>
                <Select
                    id={`${groupId}-ins-year`}
                    value={anim.insertYear}
                    disabled={disabled}
                    onChange={update("insertYear")}
                    options={[
                        { value: "slide-shift", label: "底层浮现（默认）" },
                        { value: "pulse-shift", label: "脉冲浮现" },
                        { value: "side-pop-shift", label: "侧向弹入" },
                        { value: "flight-shift", label: "跨行飞入" },
                        { value: "none", label: "无动画" },
                    ]}
                />
            </Row>

            <Row label="撤销 / 恢复动画" htmlFor={`${groupId}-history`}>
                <Select
                    id={`${groupId}-history`}
                    value={anim.historyAnim}
                    disabled={disabled}
                    onChange={update("historyAnim")}
                    options={[
                        { value: "enabled", label: "启用（默认）" },
                        { value: "disabled", label: "禁用" },
                    ]}
                />
            </Row>
        </div>
    );
}

function CofechaSection() {
    const { settings, updateCofechaSettings } = useSettings();
    const executablePath = settings.cofecha.executablePath;

    const selectExecutable = async () => {
        const selected = await open({
            title: "加载 COFECHA 可执行文件",
            multiple: false,
            directory: false,
            filters: [{ name: "Windows 可执行文件", extensions: ["exe"] }],
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

            <Row label="可执行文件" align="top">
                <div className={styles["executable-row"]}>
                    <input
                        className={styles["path-input"]}
                        value={executablePath}
                        readOnly
                        placeholder="尚未选择 COFECHA EXE"
                        aria-label="COFECHA 可执行文件路径"
                    />
                    <button className={styles["action-button"]} type="button" onClick={() => void selectExecutable()}>
                        选择 EXE
                    </button>
                    {executablePath && (
                        <button className={styles["secondary-button"]} type="button" onClick={clearExecutable}>
                            清除
                        </button>
                    )}
                </div>
                <div className={executablePath ? styles["configured-status"] : styles["unconfigured-status"]}>
                    {executablePath ? "COFECHA 已配置" : "COFECHA 尚未配置"}
                </div>
            </Row>

            <Row label="官方获取" align="top">
                <button
                    className={styles["download-button"]}
                    type="button"
                    onClick={() => void openUrl(LTRR_COFECHA_DOWNLOAD_URL)}
                >
                    <img className={styles["website-icon"]} src={ltrrFavicon} alt="" aria-hidden="true" />
                    <span>下载</span>
                </button>
                <div className={styles["setting-note"]}>
                    Crossdating IDM 不附带 COFECHA。
                </div>
            </Row>
        </div>
    );
}

function DiagnosisSection() {
    const { settings, updateDiagnosisSettings } = useSettings();

    return (
        <div>
            <h2 className={styles["section-title"]}>定年建议</h2>

            <Row label="自动分析" align="top">
                <label className={styles["check"]}>
                    <input
                        type="checkbox"
                        checked={settings.diagnosis.enabled}
                        onChange={(event) => updateDiagnosisSettings({
                            enabled: event.currentTarget.checked,
                        })}
                    />
                    <span>选择序列或编辑数据后自动生成定年建议</span>
                </label>
                <div className={styles["setting-note"]}>
                    关闭后会停止当前自动分析并隐藏建议；COFECHA 验证与已有编辑记录不受影响。
                </div>
            </Row>
        </div>
    );
}

function TreeRingImageSection() {
    const { settings, updateTreeRingImageSettings } = useSettings();

    return (
        <div>
            <h2 className={styles["section-title"]}>年轮图像</h2>

            <Row label="绘制图片" align="top">
                <label className={styles["check"]}>
                    <input
                        type="checkbox"
                        checked={settings.treeRingImage.showGeneratedPreview}
                        onChange={(event) => updateTreeRingImageSettings({
                            showGeneratedPreview: event.currentTarget.checked,
                        })}
                    />
                    <span>在序列 header 中显示绘制年轮图</span>
                </label>
                <div className={styles["setting-note"]}>
                    关闭后不生成或显示 header 绘制图，但保留原按钮、右键菜单和双击打开功能；扫描影像不受影响。
                </div>
            </Row>
        </div>
    );
}

function AboutSection() {
    return (
        <div>
            <h2 className={styles["section-title"]}>关于</h2>

            <Row label="应用名称"><span className={styles["about-text"]}>交叉定年 · IDM</span></Row>
            <Row label="版本"><span className={styles["about-text"]}>1.5.0</span></Row>
            <Row label="技术栈"><span className={styles["about-text"]}>Tauri · React · TypeScript</span></Row>
            <Row label="COFECHA"><span className={styles["about-text"]}>Richard L. Holmes · LTRR Dendrochronology Program Library</span></Row>
            <Row label="研发团队" align="top">
                <span className={styles["about-text"]}>
                    何志浩、张同文、张瑞波<br />
                    靳春寒、喻树龙、尚华明、秦莉
                </span>
            </Row>
        </div>
    );
}

export default function SettingsPage() {
    const [activeSection, setActiveSection] = useState<SectionId>("animation");
    const [query, setQuery] = useState("");

    const normalizedQuery = query.trim().toLowerCase();
    const visibleSections = normalizedQuery
        ? SECTIONS.filter((section) => section.label.toLowerCase().includes(normalizedQuery))
        : SECTIONS;

    return (
        <div className={styles["page"]}>
            <div className={styles["body"]}>
                <div className={styles["sidebar"]}>
                    <input
                        className={styles["search"]}
                        type="text"
                        placeholder="查找..."
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
                                {section.label}
                            </button>
                        ))}
                    </FloatingScrollArea>
                </div>

                <FloatingScrollArea className={styles["content"]}>
                    {activeSection === "animation" && <AnimationSection />}
                    {activeSection === "tree-ring-image" && <TreeRingImageSection />}
                    {activeSection === "diagnosis" && <DiagnosisSection />}
                    {activeSection === "cofecha" && <CofechaSection />}
                    {activeSection === "about" && <AboutSection />}
                </FloatingScrollArea>
            </div>
        </div>
    );
}
