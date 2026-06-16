// COFECHA 报告里 PART 6 序列标题的锚点工具。
// 生成端（Home 的报告渲染）和消费端（主窗口 / 独立 COFECHA 窗口的滚动）共用，
// 避免锚点属性名与滚动逻辑在多处各写一份而走样。

import { ALL_OPTION_VALUE } from "./constants";

export const COFECHA_PART6_ANCHOR_ATTR = "data-cofecha-part6-anchor";

// PART 6 在 selector 里的取值，与 COFECHA_PART_OPTIONS 中那一项保持一致。
export const COFECHA_PART6_PART_VALUE = "PART 6";

// 当前选中的部分下，报告里是否含 PART 6 区段（即锚点是否存在）：
// 显示“全部内容”或单独选了 PART 6 时为真，选了其它单一部分时为假。
export const cofechaReportShowsPart6 = (selectedPart: string): boolean => (
    selectedPart === ALL_OPTION_VALUE || selectedPart === COFECHA_PART6_PART_VALUE
);

// 在报告滚动区里找到指定序列的 PART 6 标题锚点（大小写不敏感，
// 因为网格里的序列名沿用 RWL 大小写，而锚点用的是 COFECHA 输出里的写法）。
export const findCofechaPart6Anchor = (scroller: HTMLElement, tree: string): HTMLElement | null => {
    const target = tree.toLowerCase();
    const anchors = scroller.querySelectorAll<HTMLElement>(`[${COFECHA_PART6_ANCHOR_ATTR}]`);
    for (const anchor of anchors) {
        if ((anchor.dataset.cofechaPart6Anchor ?? "").toLowerCase() === target) {
            return anchor;
        }
    }
    return null;
};

// 把锚点滚动到滚动区上缘下方一小段，与网格跳转保持一致的“留白”观感。
export const scrollCofechaAnchorIntoView = (scroller: HTMLElement, anchor: HTMLElement) => {
    const scrollerRect = scroller.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const lead = Math.max(40, Math.floor(scroller.clientHeight * 0.25));
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const nextScrollTop = Math.min(
        Math.max(scroller.scrollTop + (anchorRect.top - scrollerRect.top) - lead, 0),
        maxScrollTop,
    );
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollTo({ top: nextScrollTop, behavior: prefersReducedMotion ? "auto" : "smooth" });
};
