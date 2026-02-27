import { useEffect, useRef, useState } from 'react';
import style from './WidthGrid.module.css'
import { callChangeYearWidth } from '@/features/rwl/rwlOperator';


export default function WidthGrid({ year, tree, gridValue, masterSeriesValue, isEditable = false, onYearClick }: {
    year?: number,
    tree?: string,
    gridValue: string | number | null,
    masterSeriesValue?: number,
    isEditable?: boolean,
    onYearClick?: (year: number) => void; // ✅ 传递点击的年份
}) {
    const handleClick = () => {
        if (year !== undefined && onYearClick) {
            onYearClick(year); // 触发父组件的回调
        }
    };

    const [_text, setText] = useState("");
    const spanRef = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        // setText(gridValue.toString());
    }, [])

    // 进入编辑模式
    const handleDoubleClick = () => {
        const span = spanRef.current;
        if (span) {
            span.contentEditable = "true";
            span.focus();
            // document.execCommand("selectAll", false, undefined); // 自动选中文本
        }
    };

    // 退出编辑模式并保存内容
    const handleBlur = () => {
        const span = spanRef.current;
        if (span) {
            const text = span.innerText.trim();
            setText(text);
            span.contentEditable = "false";
            // 计算并调用全局桥函数
            const newWidth = text === '' ? null : Number(text);
            if (tree !== undefined && year !== undefined) {
                callChangeYearWidth(tree, year, newWidth);
            }
        }
    };

    // 监听 Enter 键保存内容
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault(); // 防止换行
            spanRef.current?.blur(); // 触发 onBlur 事件
        }
    };

    // 计算颜色深度（负值越大，颜色越深）
    const getBackgroundColor = () => {
        if (masterSeriesValue !== undefined && masterSeriesValue < -0.5) {
            const intensity = Math.min(1, Math.abs(masterSeriesValue) / 2); // 归一化到 0 ~ 1 范围
            return `rgba(255, 255, 0, ${intensity})`; // 颜色为黄色 (R255, G255, B0)，透明度 0 ~ 1
        }
        return "transparent"; // 默认无背景
    };
    // 计算字体颜色（小于 -1 变红）
    const getTextColor = () => {
        return masterSeriesValue !== undefined && masterSeriesValue < -1 ? "red" : "black";
    };

    return (
        <>
            <span ref={spanRef}
                onClick={handleClick} // ✅ 点击时触发 `onYearClick`
                onDoubleClick={handleDoubleClick}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                className={`${style["width-grid"]} ${gridValue === 0 ? style["highlight-zero"] : ""} ${isEditable ? "" : style["disabled"]}`}
                title={(year ? year.toString() : "") + "\n" + (masterSeriesValue ? masterSeriesValue.toString() : "")}
                style={{
                    backgroundColor: getBackgroundColor(),
                    color: getTextColor(),
                    fontWeight: masterSeriesValue !== undefined && masterSeriesValue < -1 ? "bold" : "normal", // 小于 -1 加粗
                }} // 动态背景 & 文字颜色
            >
                {gridValue}
            </span>
        </>
    )
}