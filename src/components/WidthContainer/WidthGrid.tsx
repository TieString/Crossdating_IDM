import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion, type TargetAndTransition, type Transition } from "motion/react";
import { callChangeYearWidth } from "@/features/rwl/edit";
import { RollingNumber } from "@/components/RollingNumber/RollingNumber";
import style from "./WidthGrid.module.css";

type PlusSide = "left" | "right";
type GridAnimationKind =
    | "insert-left"
    | "insert-right"
    | "insert-shift-left"
    | "insert-shift-right"
    | "insert-edge-fade-left"
    | "insert-edge-fade-right"
    | "insert-cross-row-shift-left"
    | "insert-cross-row-shift-right"
    | "move-target"
    | "move-gap"
    | "overwrite";

type MotionReservedHtmlProps =
    | "onDrag"
    | "onDragStart"
    | "onDragEnd"
    | "onAnimationStart";

type WidthGridMotionConfig = {
    initial?: TargetAndTransition;
    animate?: TargetAndTransition;
    transition?: Transition;
    transitionEnd?: TargetAndTransition["transitionEnd"];
};

type AnimationOffset = {
    x: number;
    y: number;
};

type InsertCellMotion = "rise" | "pulse" | "side-pop";

const getAnimationDurationScale = (animationSpeed: number) => (
    Number.isFinite(animationSpeed) && animationSpeed > 0 ? 1 / animationSpeed : 1
);

const scaleTransitionTiming = (transition: Transition, animationSpeed: number): Transition => {
    const scale = getAnimationDurationScale(animationSpeed);
    const next: Transition = { ...transition };

    if (typeof next.duration === "number") {
        next.duration *= scale;
    }

    if (typeof next.delay === "number") {
        next.delay *= scale;
    }

    return next;
};

const withDelay = (transition: Transition, delaySeconds: number, animationSpeed: number): Transition => {
    const delayed = delaySeconds > 0 ? { ...transition, delay: delaySeconds } : transition;
    return scaleTransitionTiming(delayed, animationSpeed);
};

const isShiftAnimation = (animationKind: GridAnimationKind | undefined) => (
    animationKind === "insert-shift-left"
    || animationKind === "insert-shift-right"
    || animationKind === "insert-edge-fade-left"
    || animationKind === "insert-edge-fade-right"
    || animationKind === "insert-cross-row-shift-left"
    || animationKind === "insert-cross-row-shift-right"
);

const getMotionConfig = (
    animationKind: GridAnimationKind | undefined,
    delaySeconds = 0,
    animationSpeed = 1,
    animationOffset?: AnimationOffset,
    insertCellMotion: InsertCellMotion = "rise",
): WidthGridMotionConfig => {
    if (isShiftAnimation(animationKind) && animationOffset) {
        const isCrossRowShift = animationKind === "insert-cross-row-shift-left"
            || animationKind === "insert-cross-row-shift-right";
        const isEdgeFadeShift = animationKind === "insert-edge-fade-left"
            || animationKind === "insert-edge-fade-right";
        const initial: TargetAndTransition = { x: animationOffset.x, y: animationOffset.y };
        const animate: TargetAndTransition = { x: 0, y: 0 };

        if (isEdgeFadeShift) {
            initial.opacity = 0;
            animate.opacity = 1;
        }

        return {
            initial,
            animate,
            transition: withDelay({
                duration: isCrossRowShift ? 1.18 : 0.95,
                ease: isCrossRowShift ? [0.22, 1, 0.36, 1] : [0.16, 1, 0.3, 1],
            }, delaySeconds, animationSpeed),
            transitionEnd: isEdgeFadeShift ? { opacity: 1 } : undefined,
        };
    }

    switch (animationKind) {
        case "insert-left":
        case "insert-right": {
            if (insertCellMotion === "pulse") {
                return {
                    initial: {
                        scale: 0.82,
                        opacity: 0,
                        transformOrigin: "50% 50%",
                        boxShadow: "inset 0 0 0 2px #22c55e, 0 0 0 0 rgba(34, 197, 94, 0.22)",
                    },
                    animate: {
                        scale: [0.82, 1.08, 1],
                        opacity: [0, 1, 1],
                        boxShadow: [
                            "inset 0 0 0 2px #16a34a, 0 0 0 0 rgba(34, 197, 94, 0.24)",
                            "inset 0 0 0 2px #16a34a, 0 0 0 7px rgba(34, 197, 94, 0.16)",
                            "inset 0 0 0 0 rgba(34, 197, 94, 0), 0 0 0 0 rgba(34, 197, 94, 0)",
                        ],
                    },
                    transition: withDelay({ duration: 0.7, ease: [0.16, 1, 0.3, 1], times: [0, 0.48, 1] }, delaySeconds + 0.08, animationSpeed),
                    transitionEnd: { boxShadow: "", opacity: 1, scale: 1 },
                };
            }

            if (insertCellMotion === "rise") {
                return {
                    initial: {
                        scale: 0.62,
                        opacity: 0,
                        transformOrigin: "50% 50%",
                        boxShadow: "inset 0 0 0 2px #22c55e, 0 0 0 0 rgba(34, 197, 94, 0.18)",
                    },
                    animate: {
                        scale: 1,
                        opacity: 1,
                        boxShadow: "inset 0 0 0 0 rgba(34, 197, 94, 0), 0 0 0 0 rgba(34, 197, 94, 0)",
                    },
                    transition: withDelay({ duration: 0.52, ease: [0.16, 1, 0.3, 1] }, delaySeconds + 0.08, animationSpeed),
                    transitionEnd: { boxShadow: "", opacity: 1, scale: 1 },
                };
            }

            const sideOffset = animationKind === "insert-left" ? -5 : 5;
            return {
                initial: {
                    x: sideOffset,
                    scale: 0.96,
                    opacity: 0,
                    boxShadow: "inset 0 0 0 2px #22c55e, 0 0 0 0 rgba(34, 197, 94, 0.22)",
                },
                animate: {
                    x: 0,
                    opacity: 1,
                    scale: [1.04, 1],
                    boxShadow: [
                        "inset 0 0 0 2px #16a34a, 0 0 0 4px rgba(34, 197, 94, 0.16)",
                        "inset 0 0 0 0 rgba(34, 197, 94, 0), 0 0 0 0 rgba(34, 197, 94, 0)",
                    ],
                },
                transition: withDelay({ duration: 0.68, ease: "easeOut", times: [0.45, 1] }, delaySeconds, animationSpeed),
                transitionEnd: { boxShadow: "", opacity: 1 },
            };
        }
        case "insert-shift-left":
            return {
                initial: { x: "calc(100% + 5px)" },
                animate: { x: 0 },
                transition: withDelay({ duration: 0.95, ease: [0.16, 1, 0.3, 1] }, delaySeconds, animationSpeed),
            };
        case "insert-shift-right":
            return {
                initial: { x: "calc(-100% - 5px)" },
                animate: { x: 0 },
                transition: withDelay({ duration: 0.95, ease: [0.16, 1, 0.3, 1] }, delaySeconds, animationSpeed),
            };
        case "insert-edge-fade-left":
            return {
                initial: { x: "calc(100% + 5px)", opacity: 0 },
                animate: { x: 0, opacity: 1 },
                transition: withDelay({ duration: 0.95, ease: [0.16, 1, 0.3, 1] }, delaySeconds, animationSpeed),
                transitionEnd: { opacity: 1 },
            };
        case "insert-edge-fade-right":
            return {
                initial: { x: "calc(-100% - 5px)", opacity: 0 },
                animate: { x: 0, opacity: 1 },
                transition: withDelay({ duration: 0.95, ease: [0.16, 1, 0.3, 1] }, delaySeconds, animationSpeed),
                transitionEnd: { opacity: 1 },
            };
        case "insert-cross-row-shift-left":
            return {
                initial: {
                    x: "calc(100% + 5px)",
                    opacity: 0,
                },
                animate: { x: 0, opacity: 1 },
                transition: withDelay({ duration: 1.04, ease: [0.16, 1, 0.3, 1] }, delaySeconds, animationSpeed),
                transitionEnd: { opacity: 1 },
            };
        case "insert-cross-row-shift-right":
            return {
                initial: {
                    x: "calc(-100% - 5px)",
                    opacity: 0,
                },
                animate: { x: 0, opacity: 1 },
                transition: withDelay({ duration: 1.04, ease: [0.16, 1, 0.3, 1] }, delaySeconds, animationSpeed),
                transitionEnd: { opacity: 1 },
            };
        case "move-target":
            return {
                initial: {
                    y: -4,
                    scale: 1.02,
                    boxShadow: "inset 0 0 0 2px #2563eb, 0 4px 12px rgba(37, 99, 235, 0.28)",
                },
                animate: {
                    y: 0,
                    scale: 1,
                    boxShadow: [
                        "inset 0 0 0 2px #3b82f6, 0 0 0 4px rgba(59, 130, 246, 0.14)",
                        "inset 0 0 0 0 rgba(59, 130, 246, 0), 0 0 0 0 rgba(59, 130, 246, 0)",
                    ],
                },
                transition: withDelay({ duration: 0.72, ease: [0.2, 0.8, 0.2, 1], times: [0.62, 1] }, delaySeconds, animationSpeed),
                transitionEnd: { boxShadow: "" },
            };
        case "move-gap":
            return {
                initial: {
                    scaleX: 0.86,
                    backgroundColor: "#e5edf8",
                    boxShadow: "inset 0 0 0 1px #8fb3df",
                },
                animate: {
                    scaleX: [1.03, 1],
                    backgroundColor: ["#eef4fb", "#ffffff"],
                    boxShadow: [
                        "inset 0 0 0 1px #76a2d6, 0 0 0 3px rgba(118, 162, 214, 0.12)",
                        "inset 0 0 0 0 rgba(118, 162, 214, 0), 0 0 0 0 rgba(118, 162, 214, 0)",
                    ],
                },
                transition: withDelay({ duration: 0.72, ease: "easeOut", times: [0.55, 1] }, delaySeconds, animationSpeed),
                transitionEnd: { backgroundColor: "", boxShadow: "" },
            };
        case "overwrite":
            return {
                initial: {
                    x: 0,
                    boxShadow: "inset 0 0 0 2px #dc2626, 0 0 0 0 rgba(220, 38, 38, 0.28)",
                    textShadow: "none",
                },
                animate: {
                    x: [0, -2, 2, -1, 0],
                    boxShadow: [
                        "inset 0 0 0 2px #dc2626, 0 0 0 0 rgba(220, 38, 38, 0.28)",
                        "inset 0 0 0 2px #dc2626, 0 0 0 4px rgba(220, 38, 38, 0.2)",
                        "inset 0 0 0 2px #b91c1c, 0 0 0 5px rgba(220, 38, 38, 0.18)",
                        "inset 0 0 0 2px #dc2626, 0 0 0 3px rgba(220, 38, 38, 0.14)",
                        "inset 0 0 0 0 rgba(220, 38, 38, 0), 0 0 0 0 rgba(220, 38, 38, 0)",
                    ],
                    textShadow: [
                        "none",
                        "0 0 4px rgba(220, 38, 38, 0.35)",
                        "0 0 4px rgba(220, 38, 38, 0.28)",
                        "0 0 2px rgba(220, 38, 38, 0.18)",
                        "none",
                    ],
                },
                transition: withDelay({ duration: 1.18, ease: "easeInOut", times: [0, 0.18, 0.36, 0.54, 1] }, delaySeconds, animationSpeed),
                transitionEnd: { boxShadow: "", textShadow: "" },
            };
        default:
            return {};
    }
};

/** Props for one rendered width-grid cell. */
export type WidthGridProps = Omit<React.HTMLAttributes<HTMLSpanElement>, MotionReservedHtmlProps> & {
    /** Calendar year represented by the cell. */
    year?: number;
    /** Series code represented by the cell. */
    tree?: string;
    /** Displayed cell value. */
    gridValue: string | number | null;
    /** Optional reference-series value used for warning coloring. */
    masterSeriesValue?: number;
    /** Enables double-click value editing and insert affordances. */
    isEditable?: boolean;
    /** Marks the cell as a structural missing-year placeholder. */
    isMissing?: boolean;
    isSelected?: boolean;
    isJumpHighlighted?: boolean;
    jumpHighlightId?: number;
    inSuggestedRange?: boolean;
    isSuggestedRangeStart?: boolean;
    isSuggestedRangeEnd?: boolean;
    isDragging?: boolean;
    dragYearOffset?: number;
    animationKind?: GridAnimationKind;
    animationDelay?: number;
    animationOffset?: AnimationOffset;
    insertCellMotion?: InsertCellMotion;
    animationSpeed?: number;
    hasLeftDeletionMark?: boolean;
    hasRightDeletionMark?: boolean;
    rightDeletionMarkerYear?: number;
    isDeletionMarkActive?: boolean;
    isRightDeletionMarkActive?: boolean;
    rollingDigits?: boolean;
    rollingFromValue?: number;
    onYearClick?: (tree: string, year: number) => void;
    onInsertMissingYearAtSide?: (tree: string, year: number, side: PlusSide) => void;
    onDeletionMarkHoverChange?: (tree: string, year: number, hovered: boolean, element: HTMLElement | null, side?: "left" | "right") => void;
    onDeletionMarkDoubleClick?: (tree: string, year: number) => void;
};

export default function WidthGrid({
    year,
    tree,
    gridValue,
    masterSeriesValue,
    isEditable = false,
    isMissing = false,
    isSelected = false,
    isJumpHighlighted = false,
    jumpHighlightId,
    inSuggestedRange = false,
    isSuggestedRangeStart = false,
    isSuggestedRangeEnd = false,
    isDragging = false,
    dragYearOffset = 0,
    animationKind,
    animationDelay = 0,
    animationOffset,
    insertCellMotion = "rise",
    animationSpeed = 1,
    hasLeftDeletionMark = false,
    hasRightDeletionMark = false,
    rightDeletionMarkerYear,
    isDeletionMarkActive = false,
    isRightDeletionMarkActive = false,
    rollingDigits = false,
    rollingFromValue,
    onYearClick,
    onInsertMissingYearAtSide,
    onDeletionMarkHoverChange,
    onDeletionMarkDoubleClick,
    className = "",
    style: customStyle = {},
    ...rest
}: WidthGridProps) {
    const { title, onMouseMove, onMouseLeave, ...restWithoutTitle } = rest;
    const [isEditing, setIsEditing] = useState(false);
    const [editText, setEditText] = useState("");
    const [hoverPlusSide, setHoverPlusSide] = useState<PlusSide | null>(null);
    const spanRef = useRef<HTMLSpanElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const isInsertedZero = gridValue === 0;
    const shouldReduceMotion = useReducedMotion();

    useLayoutEffect(() => {
        if (!isEditing) {
            return;
        }

        const input = inputRef.current;
        input?.focus();
        input?.select();
    }, [isEditing]);

    useLayoutEffect(() => {
        if (!isJumpHighlighted || jumpHighlightId === undefined || shouldReduceMotion) {
            return;
        }

        const span = spanRef.current;
        if (!span) {
            return;
        }

        span.style.animation = "none";
        void span.offsetWidth;
        span.style.animation = "";
    }, [isJumpHighlighted, jumpHighlightId, shouldReduceMotion]);

    const handleClick = () => {
        if (tree !== undefined && year !== undefined && onYearClick) {
            onYearClick(tree, year);
        }
    };

    const handleDoubleClick = () => {
        if (!isEditable) {
            return;
        }

        setHoverPlusSide(null);
        setEditText(displayedValue === null || displayedValue === undefined ? "" : String(displayedValue));
        setIsEditing(true);
    };

    const commitEdit = () => {
        const text = editText.trim();
        const normalizedText = text.toLowerCase();
        const parsedWidth = text === ""
            ? null
            : normalizedText === "missing"
                ? 0
                : Number(text);
        const newWidth = typeof parsedWidth === "number" && Number.isNaN(parsedWidth) ? null : parsedWidth;

        setIsEditing(false);

        if (tree !== undefined && year !== undefined) {
            callChangeYearWidth(tree, year, newWidth);
        }
    };

    const handleEditKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
            event.preventDefault();
            commitEdit();
            return;
        }

        if (event.key === "Escape") {
            event.preventDefault();
            setIsEditing(false);
        }
    };

    const getBackgroundColor = () => {
        if (isMissing) {
            return undefined;
        }

        if (masterSeriesValue !== undefined && masterSeriesValue < -0.5) {
            const intensity = Math.min(1, Math.abs(masterSeriesValue) / 2);
            return `rgba(255, 255, 0, ${intensity})`;
        }

        return undefined;
    };

    const getTextColor = () => {
        if (isMissing) {
            return "#6b7280";
        }

        return masterSeriesValue !== undefined && masterSeriesValue < -1 ? "red" : "black";
    };

    const handleMouseMove = (event: React.MouseEvent<HTMLSpanElement>) => {
        onMouseMove?.(event);

        if (!isEditable || isEditing || tree === undefined || year === undefined || isDragging) {
            return;
        }

        const rect = event.currentTarget.getBoundingClientRect();
        const nextSide = event.clientX - rect.left < rect.width / 2 ? "left" : "right";
        setHoverPlusSide((previous) => previous === nextSide ? previous : nextSide);
    };

    const handleMouseLeave = (event: React.MouseEvent<HTMLSpanElement>) => {
        onMouseLeave?.(event);
        setHoverPlusSide(null);
    };

    const handlePlusPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
    };

    const handlePlusClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();

        if (tree !== undefined && year !== undefined && hoverPlusSide && onInsertMissingYearAtSide) {
            onInsertMissingYearAtSide(tree, year, hoverPlusSide);
        }

        setHoverPlusSide(null);
    };

    const masterText = masterSeriesValue !== undefined ? masterSeriesValue.toString() : "";
    const widthTitle = `${year !== undefined ? year.toString() : ""}\n${masterText}`;
    const finalTitle = title || widthTitle;
    const displayedValue = isMissing ? "missing" : gridValue;
    const plusButtonClassName = hoverPlusSide
        ? `${style["insert-missing-button"]} ${style[`insert-missing-button-${hoverPlusSide}`]} ${style["insert-missing-button-visible"]}`
        : style["insert-missing-button"];
    const motionConfig = useMemo(
        () => shouldReduceMotion ? {} : getMotionConfig(animationKind, animationDelay, animationSpeed, animationOffset, insertCellMotion),
        [animationDelay, animationKind, animationOffset, animationSpeed, insertCellMotion, shouldReduceMotion],
    );
    const motionAnimate = useMemo(
        () => motionConfig.animate && motionConfig.transitionEnd
            ? { ...motionConfig.animate, transitionEnd: motionConfig.transitionEnd }
            : motionConfig.animate,
        [motionConfig],
    );

    const handleDeletionMarkEnter = (event: React.MouseEvent<HTMLSpanElement>, markerYear: number | undefined, side: "left" | "right") => {
        event.stopPropagation();
        setHoverPlusSide(null);
        if (tree !== undefined && markerYear !== undefined) {
            onDeletionMarkHoverChange?.(tree, markerYear, true, event.currentTarget, side);
        }
    };

    const handleDeletionMarkLeave = (event: React.MouseEvent<HTMLSpanElement>, markerYear: number | undefined, side: "left" | "right") => {
        event.stopPropagation();
        if (tree !== undefined && markerYear !== undefined) {
            onDeletionMarkHoverChange?.(tree, markerYear, false, event.currentTarget, side);
        }
    };

    const handleDeletionMarkMove = (event: React.MouseEvent<HTMLSpanElement>) => {
        event.stopPropagation();
    };

    const handleDeletionMarkDoubleClick = (event: React.MouseEvent<HTMLSpanElement>, markerYear: number | undefined) => {
        event.stopPropagation();
        event.preventDefault();
        if (tree !== undefined && markerYear !== undefined) {
            onDeletionMarkDoubleClick?.(tree, markerYear);
        }
    };

    const valueContent = isEditing
        ? (
            <input
                ref={inputRef}
                className={style["width-editor"]}
                value={editText}
                onChange={(event) => setEditText(event.target.value)}
                onBlur={commitEdit}
                onKeyDown={handleEditKeyDown}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
            />
        )
        : rollingDigits && typeof displayedValue === "number"
            ? <RollingNumber value={displayedValue} fromValue={rollingFromValue} speed={animationSpeed} />
            : displayedValue;

    return (
        <motion.span
            {...restWithoutTitle}
            ref={spanRef}
            title={finalTitle}
            initial={motionConfig.initial}
            animate={motionAnimate}
            transition={motionConfig.transition}
            data-drag-year-offset={dragYearOffset || undefined}
            onClick={isEditable && !isEditing ? handleClick : undefined}
            onDoubleClick={isEditable && !isEditing ? handleDoubleClick : undefined}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            className={`${style["width-grid"]} ${className} ${isMissing ? style["missing"] : ""} ${isInsertedZero ? style["inserted-zero"] : ""} ${isSelected ? style["selected"] : ""} ${isJumpHighlighted ? style["cofecha-jump-target"] : ""} ${inSuggestedRange ? style["suggested-range"] : ""} ${inSuggestedRange && isSuggestedRangeStart ? style["suggested-range-start"] : ""} ${inSuggestedRange && isSuggestedRangeEnd ? style["suggested-range-end"] : ""} ${isDragging ? style["dragging"] : ""} ${hasLeftDeletionMark ? style["has-left-deletion-mark"] : ""} ${hasRightDeletionMark ? style["has-right-deletion-mark"] : ""} ${animationKind ? style["motion-animated"] : ""} ${isEditable ? "" : style["disabled"]}`}
            style={{
                backgroundColor: getBackgroundColor(),
                color: getTextColor(),
                fontWeight: !isMissing && masterSeriesValue !== undefined && masterSeriesValue < -1 ? "bold" : "normal",
                ...customStyle,
            }}
        >
            {valueContent}
            {!isEditing && hasLeftDeletionMark ? (
                <span
                    aria-hidden="true"
                    className={`${style["deletion-mark"]} ${style["deletion-mark-left"]} ${isDeletionMarkActive ? style["deletion-mark-active"] : ""}`}
                    onMouseEnter={(event) => handleDeletionMarkEnter(event, year, "left")}
                    onMouseLeave={(event) => handleDeletionMarkLeave(event, year, "left")}
                    onMouseMove={handleDeletionMarkMove}
                    onDoubleClick={(event) => handleDeletionMarkDoubleClick(event, year)}
                />
            ) : null}
            {!isEditing && hasRightDeletionMark ? (
                <span
                    aria-hidden="true"
                    className={`${style["deletion-mark"]} ${style["deletion-mark-right"]} ${isRightDeletionMarkActive ? style["deletion-mark-active"] : ""}`}
                    onMouseEnter={(event) => handleDeletionMarkEnter(event, rightDeletionMarkerYear, "right")}
                    onMouseLeave={(event) => handleDeletionMarkLeave(event, rightDeletionMarkerYear, "right")}
                    onMouseMove={handleDeletionMarkMove}
                    onDoubleClick={(event) => handleDeletionMarkDoubleClick(event, rightDeletionMarkerYear)}
                />
            ) : null}
            {!isEditing && isEditable && hoverPlusSide ? (
                <button
                    type="button"
                    aria-label={`Insert missing year on ${hoverPlusSide} side`}
                    className={plusButtonClassName}
                    onPointerDown={handlePlusPointerDown}
                    onClick={handlePlusClick}
                >
                    +
                </button>
            ) : null}
        </motion.span>
    );
}
