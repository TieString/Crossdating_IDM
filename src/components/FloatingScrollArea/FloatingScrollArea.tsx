import {
    forwardRef,
    useCallback,
    useRef,
    type CSSProperties,
    type HTMLAttributes,
    type MutableRefObject,
    type ReactNode,
    type Ref,
    type RefObject,
} from "react";
import { FloatingScrollbar } from "@/components/FloatingScrollbar/FloatingScrollbar";
import styles from "./FloatingScrollArea.module.css";

/** Children can be static content or a render function receiving the scroll element ref. */
export type FloatingScrollAreaChildren =
    | ReactNode
    | ((scrollRef: RefObject<HTMLDivElement | null>) => ReactNode);

/** Props for a native scrolling area decorated with the floating scrollbar overlay. */
export type FloatingScrollAreaProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
    /** Scroll content or render function that can access the scroll container ref. */
    children: FloatingScrollAreaChildren;
    /** Extra class name for the outer viewport wrapper. */
    viewportClassName?: string;
    /** Inline style for the outer viewport wrapper. */
    viewportStyle?: CSSProperties;
    /** Changing value used to force FloatingScrollbar measurements to refresh. */
    scrollbarRevision?: unknown;
    /** Selector inside the scroll target that the vertical thumb should avoid. */
    topClearanceSelector?: string;
    /** Pixel inset from scrollbar track edges. */
    edgeInset?: number;
};

const setRef = (ref: Ref<HTMLDivElement> | undefined, node: HTMLDivElement | null) => {
    if (!ref) {
        return;
    }

    if (typeof ref === "function") {
        ref(node);
        return;
    }

    (ref as MutableRefObject<HTMLDivElement | null>).current = node;
};

/** Wraps scrollable content and renders floating overlay scroll thumbs. */
export const FloatingScrollArea = forwardRef<HTMLDivElement, FloatingScrollAreaProps>(
    function FloatingScrollArea(
        {
            children,
            className,
            viewportClassName,
            viewportStyle,
            scrollbarRevision,
            topClearanceSelector,
            edgeInset,
            ...scrollProps
        },
        forwardedRef,
    ) {
        const scrollRef = useRef<HTMLDivElement | null>(null);
        const scrollClassName = className ? `${styles.scroller} ${className}` : styles.scroller;
        const rootClassName = viewportClassName ? `${styles.viewport} ${viewportClassName}` : styles.viewport;

        // Stable callback ref: an inline ref function changes identity every render,
        // which makes React detach (set null) then re-attach the node on *every* update.
        // A child's useLayoutEffect runs before an ancestor's ref re-attaches, so any
        // consumer reading scrollRef.current in a layout effect (e.g. the grid's jump-to
        // scroll) would observe null. Keeping the ref stable avoids that detach/attach churn.
        const setScrollNode = useCallback((node: HTMLDivElement | null) => {
            scrollRef.current = node;
            setRef(forwardedRef, node);
        }, [forwardedRef]);

        return (
            <div className={rootClassName} style={viewportStyle}>
                <div
                    {...scrollProps}
                    ref={setScrollNode}
                    className={scrollClassName}
                >
                    {typeof children === "function" ? children(scrollRef) : children}
                </div>
                <FloatingScrollbar
                    targetRef={scrollRef}
                    revision={scrollbarRevision}
                    topClearanceSelector={topClearanceSelector}
                    edgeInset={edgeInset}
                />
            </div>
        );
    },
);
