import { useRef, useState } from "react";
import { callChangeYearWidth } from "@/features/rwl/edit";
import { RollingNumber } from "@/components/RollingNumber/RollingNumber";
import style from "./WidthGrid.module.css";

type PlusSide = "left" | "right";
type GridAnimationKind =
    | "insert-left"
    | "insert-right"
    | "insert-shift-left"
    | "insert-shift-right"
    | "move-target"
    | "move-gap"
    | "overwrite";

type WidthGridProps = React.HTMLAttributes<HTMLSpanElement> & {
    year?: number;
    tree?: string;
    gridValue: string | number | null;
    masterSeriesValue?: number;
    isEditable?: boolean;
    isMissing?: boolean;
    isSelected?: boolean;
    isDragging?: boolean;
    dragYearOffset?: number;
    animationKind?: GridAnimationKind;
    hasLeftDeletionMark?: boolean;
    isDeletionMarkActive?: boolean;
    rollingDigits?: boolean;
    onYearClick?: (tree: string, year: number) => void;
    onInsertMissingYearAtSide?: (tree: string, year: number, side: PlusSide) => void;
    onDeletionMarkHoverChange?: (tree: string, year: number, hovered: boolean, element: HTMLElement | null) => void;
};

export default function WidthGrid({
    year,
    tree,
    gridValue,
    masterSeriesValue,
    isEditable = false,
    isMissing = false,
    isSelected = false,
    isDragging = false,
    dragYearOffset = 0,
    animationKind,
    hasLeftDeletionMark = false,
    isDeletionMarkActive = false,
    rollingDigits = false,
    onYearClick,
    onInsertMissingYearAtSide,
    onDeletionMarkHoverChange,
    className = "",
    style: customStyle = {},
    ...rest
}: WidthGridProps) {
    const { title, onMouseMove, onMouseLeave, ...restWithoutTitle } = rest;
    const [, setText] = useState("");
    const [hoverPlusSide, setHoverPlusSide] = useState<PlusSide | null>(null);
    const spanRef = useRef<HTMLSpanElement>(null);
    const isInsertedZero = gridValue === 0;

    const handleClick = () => {
        if (tree !== undefined && year !== undefined && onYearClick) {
            onYearClick(tree, year);
        }
    };

    const handleDoubleClick = () => {
        const span = spanRef.current;

        if (span) {
            setHoverPlusSide(null);
            span.contentEditable = "true";
            span.focus();
        }
    };

    const handleBlur = () => {
        const span = spanRef.current;

        if (span) {
            const text = span.innerText.trim();
            const normalizedText = text.toLowerCase();
            const parsedWidth = text === ""
                ? null
                : normalizedText === "missing"
                    ? 0
                    : Number(text);
            const newWidth = typeof parsedWidth === "number" && Number.isNaN(parsedWidth) ? null : parsedWidth;

            setText(text);
            span.contentEditable = "false";

            if (tree !== undefined && year !== undefined) {
                callChangeYearWidth(tree, year, newWidth);
            }
        }
    };

    const handleKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === "Enter") {
            event.preventDefault();
            spanRef.current?.blur();
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

        if (!isEditable || tree === undefined || year === undefined || isDragging) {
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
    const animationClassName = animationKind ? style[`animate-${animationKind}`] : "";

    const handleDeletionMarkEnter = (event: React.MouseEvent<HTMLSpanElement>) => {
        event.stopPropagation();
        if (tree !== undefined && year !== undefined) {
            onDeletionMarkHoverChange?.(tree, year, true, event.currentTarget);
        }
    };

    const handleDeletionMarkLeave = (event: React.MouseEvent<HTMLSpanElement>) => {
        event.stopPropagation();
        if (tree !== undefined && year !== undefined) {
            onDeletionMarkHoverChange?.(tree, year, false, event.currentTarget);
        }
    };

    const valueContent = rollingDigits && typeof displayedValue === "number"
        ? <RollingNumber value={displayedValue} />
        : displayedValue;

    return (
        <span
            {...restWithoutTitle}
            ref={spanRef}
            title={finalTitle}
            data-drag-year-offset={dragYearOffset || undefined}
            onClick={isEditable ? handleClick : undefined}
            onDoubleClick={isEditable ? handleDoubleClick : undefined}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className={`${style["width-grid"]} ${className} ${isMissing ? style["missing"] : ""} ${isInsertedZero ? style["inserted-zero"] : ""} ${isSelected ? style["selected"] : ""} ${isDragging ? style["dragging"] : ""} ${hasLeftDeletionMark ? style["has-left-deletion-mark"] : ""} ${animationClassName} ${isEditable ? "" : style["disabled"]}`}
            style={{
                backgroundColor: getBackgroundColor(),
                color: getTextColor(),
                fontWeight: !isMissing && masterSeriesValue !== undefined && masterSeriesValue < -1 ? "bold" : "normal",
                ...customStyle,
            }}
        >
            {valueContent}
            {hasLeftDeletionMark ? (
                <span
                    aria-hidden="true"
                    className={`${style["deletion-mark"]} ${isDeletionMarkActive ? style["deletion-mark-active"] : ""}`}
                    onMouseEnter={handleDeletionMarkEnter}
                    onMouseLeave={handleDeletionMarkLeave}
                />
            ) : null}
            {isEditable && hoverPlusSide ? (
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
        </span>
    );
}
