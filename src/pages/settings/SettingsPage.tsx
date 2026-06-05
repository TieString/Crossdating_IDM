import { useId, useState } from "react";
import { useSettings } from "@/features/settings/SettingsContext";
import {
    ANIMATION_SPEED_MAX,
    ANIMATION_SPEED_MIN,
    ANIMATION_SPEED_STEP,
    normalizeAnimationSpeed,
    type AnimationSettings,
} from "@/features/settings/settings";
import styles from "./SettingsPage.module.css";

type SectionId = "animation" | "about";

const SECTIONS: { id: SectionId; label: string }[] = [
    { id: "animation", label: "动画" },
    { id: "about", label: "关于" },
];

const formatSpeedLabel = (speed: number) => (
    `${speed.toFixed(2).replace(/\.00$/, "").replace(/0$/, "")}x`
);

interface RadioOptionProps<T extends string> {
    name: string;
    value: T;
    current: T;
    label: string;
    desc?: string;
    badge?: string;
    disabled?: boolean;
    onChange: (value: T) => void;
}

function RadioOption<T extends string>({ name, value, current, label, desc, badge, disabled = false, onChange }: RadioOptionProps<T>) {
    return (
        <label className={`${styles["radio-option"]} ${disabled ? styles["radio-option-disabled"] : ""}`}>
            <input
                type="radio"
                name={name}
                value={value}
                checked={current === value}
                disabled={disabled}
                onChange={() => onChange(value)}
            />
            <span className={styles["radio-option-text"]}>
                <span className={styles["radio-option-label"]}>
                    {label}
                    {badge && <span className={styles["radio-option-badge"]}>{badge}</span>}
                </span>
                {desc && <span className={styles["radio-option-desc"]}>{desc}</span>}
            </span>
        </label>
    );
}

function AnimationSection() {
    const { settings, updateAnimationSettings } = useSettings();
    const anim = settings.animation;
    const groupId = useId();
    const animationsDisabled = anim.enabled === "disabled";
    const animationSpeed = normalizeAnimationSpeed(anim.speed);

    const update = <K extends keyof AnimationSettings>(key: K) => (value: AnimationSettings[K]) => {
        updateAnimationSettings({ [key]: value } as Partial<AnimationSettings>);
    };

    return (
        <div>
            <h2 className={styles["section-title"]}>动画</h2>

            <div className={styles["setting-group"]}>
                <label className={styles["switch-row"]}>
                    <span className={styles["switch-text"]}>
                        <span className={styles["switch-title"]}>动画总开关</span>
                        <span className={styles["switch-desc"]}>关闭后所有操作立即生效，不播放格子、数字和序列过渡动画</span>
                    </span>
                    <input
                        className={styles["switch-input"]}
                        type="checkbox"
                        checked={anim.enabled === "enabled"}
                        onChange={(event) => updateAnimationSettings({
                            enabled: event.currentTarget.checked ? "enabled" : "disabled",
                        })}
                    />
                    <span className={styles["switch-track"]} aria-hidden="true">
                        <span className={styles["switch-thumb"]} />
                    </span>
                </label>
            </div>

            <div className={styles["setting-group"]}>
                <label
                    className={`${styles["slider-row"]} ${animationsDisabled ? styles["slider-row-disabled"] : ""}`}
                    htmlFor={`${groupId}-speed`}
                >
                    <span className={styles["slider-text"]}>
                        <span className={styles["switch-title"]}>动画速度</span>
                        <span className={styles["switch-desc"]}>调节格子移动、数字滚动和删除过渡的播放速度</span>
                    </span>
                    <span className={styles["slider-control"]}>
                        <input
                            id={`${groupId}-speed`}
                            className={styles["slider-input"]}
                            type="range"
                            min={ANIMATION_SPEED_MIN}
                            max={ANIMATION_SPEED_MAX}
                            step={ANIMATION_SPEED_STEP}
                            value={animationSpeed}
                            disabled={animationsDisabled}
                            onChange={(event) => updateAnimationSettings({
                                speed: normalizeAnimationSpeed(event.currentTarget.value),
                            })}
                        />
                        <span className={styles["slider-value"]}>{formatSpeedLabel(animationSpeed)}</span>
                    </span>
                </label>
            </div>

            <div className={styles["setting-group"]}>
                <div className={styles["setting-group-label"]}>删除序列动画</div>
                <div className={styles["radio-list"]}>
                    <RadioOption
                        name={`${groupId}-del-series`}
                        value="fade"
                        current={anim.deleteSeries}
                        label="淡出消散"
                        desc="序列渐变黑白后淡出，布局同步收缩"
                        badge="默认"
                        disabled={animationsDisabled}
                        onChange={update("deleteSeries")}
                    />
                    <RadioOption
                        name={`${groupId}-del-series`}
                        value="shatter-rise"
                        current={anim.deleteSeries}
                        label="粉碎上升"
                        desc="碎片从下方涌起压碎，序列块同步收缩消失"
                        disabled={animationsDisabled}
                        onChange={update("deleteSeries")}
                    />
                    <RadioOption
                        name={`${groupId}-del-series`}
                        value="none"
                        current={anim.deleteSeries}
                        label="无动画"
                        desc="立即删除，无过渡效果"
                        disabled={animationsDisabled}
                        onChange={update("deleteSeries")}
                    />
                </div>
            </div>

            <div className={styles["setting-group"]}>
                <div className={styles["setting-group-label"]}>删除年份动画</div>
                <div className={styles["radio-list"]}>
                    <RadioOption
                        name={`${groupId}-del-year`}
                        value="pixel-burst"
                        current={anim.deleteYear}
                        label="像素爆炸"
                        desc="被删除的格子碎成像素向右飞散"
                        badge="默认"
                        disabled={animationsDisabled}
                        onChange={update("deleteYear")}
                    />
                    <RadioOption
                        name={`${groupId}-del-year`}
                        value="none"
                        current={anim.deleteYear}
                        label="无动画"
                        desc="格子直接消失，相邻格子滑入填补"
                        disabled={animationsDisabled}
                        onChange={update("deleteYear")}
                    />
                </div>
            </div>

            <div className={styles["setting-group"]}>
                <div className={styles["setting-group-label"]}>插入年份动画</div>
                <div className={styles["radio-list"]}>
                    <RadioOption
                        name={`${groupId}-ins-year`}
                        value="slide-shift"
                        current={anim.insertYear}
                        label="滑入移位"
                        desc="新格子弹入，相邻格子平滑位移；跨行时有飞行动画"
                        badge="默认"
                        disabled={animationsDisabled}
                        onChange={update("insertYear")}
                    />
                    <RadioOption
                        name={`${groupId}-ins-year`}
                        value="none"
                        current={anim.insertYear}
                        label="无动画"
                        desc="格子直接出现，无位移过渡"
                        disabled={animationsDisabled}
                        onChange={update("insertYear")}
                    />
                </div>
            </div>

            <div className={styles["setting-group"]}>
                <div className={styles["setting-group-label"]}>撤销 / 恢复动画</div>
                <div className={styles["radio-list"]}>
                    <RadioOption
                        name={`${groupId}-history`}
                        value="enabled"
                        current={anim.historyAnim}
                        label="启用"
                        desc="撤销和恢复操作时显示格子滑入/滑出的过渡动画"
                        badge="默认"
                        disabled={animationsDisabled}
                        onChange={update("historyAnim")}
                    />
                    <RadioOption
                        name={`${groupId}-history`}
                        value="disabled"
                        current={anim.historyAnim}
                        label="禁用"
                        desc="撤销和恢复立即生效，不播放过渡动画"
                        disabled={animationsDisabled}
                        onChange={update("historyAnim")}
                    />
                </div>
            </div>
        </div>
    );
}

function AboutSection() {
    return (
        <div>
            <h2 className={styles["section-title"]}>关于</h2>
            <div className={styles["about-grid"]}>
                <span className={styles["about-key"]}>应用名称</span>
                <span className={styles["about-value"]}>交叉定年 · IDM</span>

                <span className={styles["about-key"]}>版本</span>
                <span className={styles["about-value"]}>1.1.5</span>

                <hr className={styles["about-divider"]} />

                <span className={styles["about-key"]}>开发团队</span>
                <span className={styles["about-value"]}>
                    何志浩、张同文、张瑞波<br />
                    靳春寒、喻树龙、尚华明、秦莉
                </span>

                <hr className={styles["about-divider"]} />

                <span className={styles["about-key"]}>技术栈</span>
                <span className={styles["about-value"]}>Tauri · React · TypeScript</span>

                <span className={styles["about-key"]}>COFECHA</span>
                <span className={styles["about-value"]}>International Tree-Ring Data Bank</span>
            </div>
        </div>
    );
}

export default function SettingsPage() {
    const [activeSection, setActiveSection] = useState<SectionId>("animation");

    return (
        <div className={styles["page"]}>
            <div className={styles["body"]}>
                <nav className={styles["sidebar"]}>
                    {SECTIONS.map((section) => (
                        <button
                            key={section.id}
                            className={`${styles["sidebar-item"]} ${activeSection === section.id ? styles["sidebar-item-active"] : ""}`}
                            onClick={() => setActiveSection(section.id)}
                        >
                            {section.label}
                        </button>
                    ))}
                </nav>

                <div className={styles["content"]}>
                    {activeSection === "animation" && <AnimationSection />}
                    {activeSection === "about" && <AboutSection />}
                </div>
            </div>
        </div>
    );
}
