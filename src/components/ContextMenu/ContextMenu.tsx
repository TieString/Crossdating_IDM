import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import style from "./ContextMenu.module.css";

export interface ContextMenuItem {
    key: string;
    label: string;
    icon?: ReactNode;
    danger?: boolean;
    disabled?: boolean;
    onSelect: () => void;
}

export interface ContextMenuProps {
    open: boolean;
    x: number;
    y: number;
    items: ContextMenuItem[];
    onClose: () => void;
}

const VIEWPORT_MARGIN = 8;

/**
 * 轻量右键上下文菜单：在 (x, y) 处弹出一组操作项，超出视口时翻转。
 * 在外部点击、Esc、滚动或窗口缩放时自动关闭。
 */
export default function ContextMenu({ open, x, y, items, onClose }: ContextMenuProps) {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const [position, setPosition] = useState({ left: x, top: y, flipX: false, flipY: false });

    useLayoutEffect(() => {
        if (!open) {
            return;
        }
        const node = menuRef.current;
        if (!node) {
            return;
        }

        const rect = node.getBoundingClientRect();
        let left = x;
        let top = y;
        let flipX = false;
        let flipY = false;

        if (left + rect.width + VIEWPORT_MARGIN > window.innerWidth) {
            left = Math.max(VIEWPORT_MARGIN, x - rect.width);
            flipX = true;
        }
        if (top + rect.height + VIEWPORT_MARGIN > window.innerHeight) {
            top = Math.max(VIEWPORT_MARGIN, y - rect.height);
            flipY = true;
        }

        setPosition((previous) => (
            previous.left === left && previous.top === top && previous.flipX === flipX && previous.flipY === flipY
                ? previous
                : { left, top, flipX, flipY }
        ));
    }, [open, x, y, items.length]);

    useEffect(() => {
        if (!open) {
            return;
        }

        const handlePointerDown = (event: PointerEvent) => {
            if (event.button === 2) {
                return;
            }
            const target = event.target;
            if (target instanceof Node && menuRef.current?.contains(target)) {
                return;
            }
            onClose();
        };

        const handleContextMenu = (event: MouseEvent) => {
            const target = event.target;
            if (target instanceof Node && menuRef.current?.contains(target)) {
                return;
            }
            onClose();
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                onClose();
            }
        };

        const handleScroll = (event: Event) => {
            const target = event.target;
            if (target instanceof Node && menuRef.current?.contains(target)) {
                return;
            }
            onClose();
        };

        window.addEventListener("pointerdown", handlePointerDown, true);
        window.addEventListener("contextmenu", handleContextMenu, true);
        window.addEventListener("keydown", handleKeyDown, true);
        window.addEventListener("scroll", handleScroll, true);
        window.addEventListener("resize", onClose);

        return () => {
            window.removeEventListener("pointerdown", handlePointerDown, true);
            window.removeEventListener("contextmenu", handleContextMenu, true);
            window.removeEventListener("keydown", handleKeyDown, true);
            window.removeEventListener("scroll", handleScroll, true);
            window.removeEventListener("resize", onClose);
        };
    }, [open, onClose]);

    if (!open) {
        return null;
    }

    const menuStyle: React.CSSProperties = {
        left: position.left,
        top: position.top,
        ["--menu-origin-x" as string]: position.flipX ? "right" : "left",
        ["--menu-origin-y" as string]: position.flipY ? "bottom" : "top",
    };

    return createPortal(
        <div
            ref={menuRef}
            className={style["menu-root"]}
            style={menuStyle}
            role="menu"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
        >
            {items.map((item) => (
                <button
                    key={item.key}
                    type="button"
                    className={`${style["menu-item"]}${item.danger ? ` ${style["menu-item-danger"]}` : ""}`}
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={() => {
                        if (item.disabled) {
                            return;
                        }
                        item.onSelect();
                        onClose();
                    }}
                >
                    {item.icon ? (
                        <span className={style["menu-item-icon"]} aria-hidden="true">{item.icon}</span>
                    ) : null}
                    <span className={style["menu-item-label"]}>{item.label}</span>
                </button>
            ))}
        </div>,
        document.body,
    );
}
