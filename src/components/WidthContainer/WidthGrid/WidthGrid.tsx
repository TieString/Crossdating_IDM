import { useEffect, useRef, useState, forwardRef } from 'react';
import style from './WidthGrid.module.css'
import { callChangeYearWidth } from '@/features/rwl/edit';


export default forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement> & {
    year?: number;
    tree?: string;
    gridValue: string | number | null;
    masterSeriesValue?: number;
    isEditable?: boolean;
    onYearClick?: (year: number) => void;
}>(function WidthGrid({ 
    year, tree, gridValue, masterSeriesValue, isEditable = false, onYearClick,
    className = '', style: customStyle = {},
    ...rest  // ✅ 捕获其他 HTML 属性
}, ref) {
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

    const windth_title = (year? year.toString():"") +"\n" + (masterSeriesValue ? masterSeriesValue.toString() : "");
    const finalTitle = rest.title || windth_title;
    const {title, ...restWithoutTitle} = rest; // 从 rest 中剥离 title，优先使用 props.title

    return (
        <span 
            ref={spanRef}
            title={finalTitle}
            onClick={isEditable ? handleClick : undefined}
            onDoubleClick={isEditable ? handleDoubleClick : undefined}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className={`${style["width-grid"]} ${className} ${gridValue === 0 ? style["highlight-zero"] : ""} ${isEditable ? "" : style["disabled"]}`}
            style={{
                backgroundColor: getBackgroundColor(),
                color: getTextColor(),
                fontWeight: masterSeriesValue !== undefined && masterSeriesValue < -1 ? "bold" : "normal", // 小于 -1 加粗
                ...customStyle
            }}
            {...restWithoutTitle}  // ✅ 转发其他属性
        >
            {gridValue}
        </span>
    )
})