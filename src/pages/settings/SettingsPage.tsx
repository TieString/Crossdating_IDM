import { useId, useState } from "react";
import { FloatingScrollArea } from "@/components/FloatingScrollArea/FloatingScrollArea";
import { useSettings } from "@/features/settings/SettingsContext";
import {
    normalizeAnimationSpeed,
    type AnimationSettings,
    type CofechaEngine,
} from "@/features/settings/settings";
import styles from "./SettingsPage.module.css";

type SectionId = "animation" | "cofecha" | "about";

const SECTIONS: { id: SectionId; label: string }[] = [
    { id: "animation", label: "动画" },
    { id: "cofecha", label: "COFECHA 引擎" },
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

/** Per-engine metadata shown beneath the COFECHA engine picker. */
const COFECHA_ENGINE_INFO: {
    engine: CofechaEngine;
    name: string;
    build: string;
    deps: string;
    note: string;
}[] = [
    {
        engine: "cofecha",
        name: "COFECHA（经典）",
        build: "32 位；Microsoft Fortran + Phar Lap TNT DOS 扩展器（COF6.06，1990 年代）",
        deps: "tnt.dll（Phar Lap DOS 扩展器）",
        note: "经典版本，标准最大时间跨度。兼容性最稳，作为默认引擎。",
    },
    {
        engine: "cofecha12k",
        name: "COFECHA 12K（扩展）",
        build: "与经典版同源重编译，仅放大内部数组维度",
        deps: "tnt.dll（Phar Lap DOS 扩展器）",
        note: "最大时间跨度扩展到约 12,000 年，用于超长年表；其余算法与经典版一致。",
    },
    {
        engine: "cofechawin",
        name: "COFECHA Win（原生）",
        build: "32 位；GNU/MinGW（gfortran）原生 Windows 重编译",
        deps: "仅系统 DLL（KERNEL32 / comdlg32），自包含，无需 DOS 扩展器",
        note: "现代原生 Windows 版本，算法相同。文件交互沿用控制台输入。",
    },
];

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
    const current = settings.cofecha.engine;
    const groupId = useId();
    const info = COFECHA_ENGINE_INFO.find((item) => item.engine === current) ?? COFECHA_ENGINE_INFO[0];

    return (
        <div>
            <h2 className={styles["section-title"]}>COFECHA 引擎</h2>

            <Row label="交叉定年引擎" htmlFor={`${groupId}-engine`} align="top">
                <Select
                    id={`${groupId}-engine`}
                    value={current}
                    onChange={(value) => updateCofechaSettings({ engine: value as CofechaEngine })}
                    options={COFECHA_ENGINE_INFO.map((item) => ({ value: item.engine, label: item.name }))}
                />
                <div className={styles["engine-spec"]}>
                    <span className={styles["engine-spec-key"]}>架构/编译</span>
                    <span className={styles["engine-spec-val"]}>{info.build}</span>
                    <span className={styles["engine-spec-key"]}>依赖</span>
                    <span className={styles["engine-spec-val"]}>{info.deps}</span>
                    <span className={styles["engine-spec-key"]}>说明</span>
                    <span className={styles["engine-spec-val"]}>{info.note}</span>
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
            <Row label="版本"><span className={styles["about-text"]}>1.2.0</span></Row>
            <Row label="技术栈"><span className={styles["about-text"]}>Tauri · React · TypeScript</span></Row>
            <Row label="COFECHA"><span className={styles["about-text"]}>International Tree-Ring Data Bank</span></Row>
            <Row label="开发团队" align="top">
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
                    {activeSection === "cofecha" && <CofechaSection />}
                    {activeSection === "about" && <AboutSection />}
                </FloatingScrollArea>
            </div>
        </div>
    );
}
