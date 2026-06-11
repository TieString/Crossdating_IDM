import {
    forwardRef,
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

type FloatingScrollAreaChildren =
    | ReactNode
    | ((scrollRef: RefObject<HTMLDivElement | null>) => ReactNode);

type FloatingScrollAreaProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
    children: FloatingScrollAreaChildren;
    viewportClassName?: string;
    viewportStyle?: CSSProperties;
    scrollbarRevision?: unknown;
    topClearanceSelector?: string;
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

        return (
            <div className={rootClassName} style={viewportStyle}>
                <div
                    {...scrollProps}
                    ref={(node) => {
                        scrollRef.current = node;
                        setRef(forwardedRef, node);
                    }}
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
