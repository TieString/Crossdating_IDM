export const PANEL_RESIZE_ACTIVE_ATTRIBUTE = "data-crossdating-panel-resizing";
export const PANEL_RESIZE_END_EVENT = "crossdating:panel-resize-end";

export const isPanelResizeActive = () => (
    typeof document !== "undefined"
    && document.body.hasAttribute(PANEL_RESIZE_ACTIVE_ATTRIBUTE)
);
