import {
    OverlayScrollbarsComponent,
    type OverlayScrollbarsComponentProps,
} from "overlayscrollbars-react";
import type { PartialOptions } from "overlayscrollbars";
import "overlayscrollbars/overlayscrollbars.css";
import "./OverlayScroll.css";

/**
 * Floating (overlay) scrollbars for the whole app.
 *
 * Native `overflow: overlay` was removed from current Chromium/WebView2, so the
 * only way to get a scrollbar that floats over the content (instead of reserving
 * a white gutter) is a JS-drawn overlay scrollbar. This thin wrapper around
 * OverlayScrollbars applies the shared `os-theme-tree` look so every scroll area
 * matches.
 */
const DEFAULT_SCROLLBARS = {
    theme: "os-theme-tree",
    autoHide: "move",
    autoHideDelay: 1000,
    clickScroll: true,
} as const;

export type OverlayScrollProps = Omit<OverlayScrollbarsComponentProps<"div">, "ref" | "element">;

export function OverlayScroll({ className, options, ...props }: OverlayScrollProps) {
    const mergedOptions: PartialOptions = {
        ...(options || {}),
        scrollbars: {
            ...DEFAULT_SCROLLBARS,
            ...((options && options.scrollbars) || {}),
        },
    };

    return (
        <OverlayScrollbarsComponent
            element="div"
            className={className ? `tree-os-scroll ${className}` : "tree-os-scroll"}
            options={mergedOptions}
            {...props}
        />
    );
}
