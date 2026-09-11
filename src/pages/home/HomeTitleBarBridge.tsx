import { t } from '@/i18n/core';
import { useLocale } from '@/i18n/react';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { createPortal } from "react-dom";
import Menu from "@/components/Menu/Menu";
import { useSettings } from "@/features/settings/SettingsContext";
import { TitleMenuKind } from "./homeShared";

type MenuItem = {
    label: string;
    onClick?: () => void | Promise<void>;
    disabled?: boolean;
    checked?: boolean;
};

type HomeTitleBarBridgeProps = {
    title: string;
    onLoad: () => void | Promise<void>;
    onSave: () => void | Promise<void>;
    onSaveAs: () => void | Promise<void>;
    onUndo: () => void | Promise<void>;
    onRedo: () => void | Promise<void>;
    canUndo?: boolean;
    canRedo?: boolean;
    onActiveMenuChange?: (menu: TitleMenuKind | null) => void;
    onOpenOperationLog?: () => void | Promise<void>;
    onOpenSettings?: () => void | Promise<void>;
    onOpenFind?: () => void | Promise<void>;
    onOpenReplace?: () => void | Promise<void>;
};

type MenuElements = {
    fileContainer: HTMLElement | null;
    editContainer: HTMLElement | null;
    runContainer: HTMLElement | null;
};

const EMPTY_MENU_ELEMENTS: MenuElements = {
    fileContainer: null,
    editContainer: null,
    runContainer: null,
};

const isTextEditingTarget = (target: EventTarget | null) => (
    target instanceof Element
    && Boolean(target.closest("input, textarea, [contenteditable='true'], [contenteditable='plaintext-only'], [role='textbox'], .cm-editor"))
);

export function HomeTitleBarBridge({
    title,
    onLoad,
    onSave,
    onSaveAs,
    onUndo,
    onRedo,
    canUndo = true,
    canRedo = true,
    onActiveMenuChange,
    onOpenOperationLog,
    onOpenSettings,
    onOpenFind,
    onOpenReplace,
}: HomeTitleBarBridgeProps) {
    const locale = useLocale();
    const { settings, updateCofechaSettings } = useSettings();
    const [activeMenu, setActiveMenu] = useState<TitleMenuKind | null>(null);
    const [menuElements, setMenuElements] = useState<MenuElements>(EMPTY_MENU_ELEMENTS);
    const activeMenuRef = useRef<TitleMenuKind | null>(null);

    useEffect(() => {
        setMenuElements({
            fileContainer: document.getElementById("title-submenu-file-container"),
            editContainer: document.getElementById("title-submenu-edit-container"),
            runContainer: document.getElementById("title-submenu-run-container"),
        });
    }, []);

    useEffect(() => {
        activeMenuRef.current = activeMenu;
        onActiveMenuChange?.(activeMenu);
    }, [activeMenu, onActiveMenuChange]);

    useEffect(() => {
        void getCurrentWindow().setTitle(title).catch(() => {});
        const menuTitle = document.getElementById("menu-title");
        if (menuTitle) {
            menuTitle.textContent = title;
        }
    }, [locale, title]);

    const closeAnd = useCallback((action?: () => void | Promise<void>) => async () => {
        try {
            await action?.();
        } finally {
            setActiveMenu(null);
        }
    }, []);

    const fileItems = useMemo<MenuItem[]>(() => ([
        { label: t("打开文件"), onClick: closeAnd(onLoad) },
        { label: t("保存"), onClick: closeAnd(onSave) },
        { label: t("另存为"), onClick: closeAnd(onSaveAs) },
        { label: t("设置"), onClick: closeAnd(onOpenSettings) },
    ]), [locale, closeAnd, onLoad, onSave, onSaveAs, onOpenSettings]);

    const editItems = useMemo<MenuItem[]>(() => ([
        { label: t("撤销"), onClick: closeAnd(onUndo), disabled: !canUndo },
        { label: t("恢复"), onClick: closeAnd(onRedo), disabled: !canRedo },
        { label: t("操作日志"), onClick: closeAnd(onOpenOperationLog) },
        { label: t("查找"), onClick: closeAnd(onOpenFind) },
        { label: t("替换"), onClick: closeAnd(onOpenReplace) },
    ]), [locale, closeAnd, canRedo, canUndo, onOpenFind, onOpenOperationLog, onOpenReplace, onRedo, onUndo]);

    const selectCofechaExecutable = useCallback(async () => {
        const selected = await open({
            title: t("加载 COFECHA 可执行文件"),
            multiple: false,
            directory: false,
            filters: [{ name: t("Windows 可执行文件"), extensions: ["exe"] }],
        });
        if (typeof selected !== "string") return;
        updateCofechaSettings({ executablePath: selected });
    }, [updateCofechaSettings]);

    const runItems = useMemo<MenuItem[]>(() => ([
        {
            label: settings.cofecha.executablePath ? t("更换 COFECHA...") : t("加载 COFECHA..."),
            onClick: closeAnd(selectCofechaExecutable),
        },
    ]), [locale, closeAnd, selectCofechaExecutable, settings.cofecha.executablePath]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const key = event.key.toLowerCase();
            if (!event.ctrlKey) {
                return;
            }

            if (event.defaultPrevented) {
                return;
            }

            // 忽略按住快捷键时操作系统产生的自动重复事件，
            // 否则按住 Ctrl+S 会不停触发保存与 COFECHA 验证。
            if (event.repeat) {
                return;
            }

            if (key === "s") {
                event.preventDefault();
                void onSave();
                return;
            }

            if (key === "z") {
                if (isTextEditingTarget(event.target)) return;
                event.preventDefault();
                void onUndo();
                return;
            }

            if (key === "y") {
                if (isTextEditingTarget(event.target)) return;
                event.preventDefault();
                void onRedo();
                return;
            }

            if (key === "f") {
                event.preventDefault();
                void onOpenFind?.();
                return;
            }

            if (key === "h") {
                event.preventDefault();
                void onOpenReplace?.();
            }
        };

        document.body.addEventListener("keydown", handleKeyDown);
        return () => {
            document.body.removeEventListener("keydown", handleKeyDown);
        };
    }, [onOpenFind, onOpenReplace, onRedo, onSave, onUndo]);

    useEffect(() => {
        const undoButton = document.getElementById("title-submenu-undo-button") as HTMLButtonElement | null;
        const redoButton = document.getElementById("title-submenu-redo-button") as HTMLButtonElement | null;

        if (undoButton) {
            undoButton.disabled = !canUndo;
            undoButton.title = canUndo ? t("撤销") : t("没有可撤销的操作");
        }
        if (redoButton) {
            redoButton.disabled = !canRedo;
            redoButton.title = canRedo ? t("恢复") : t("没有可恢复的操作");
        }
    }, [locale, canRedo, canUndo]);

    useEffect(() => {
        const undoButton = document.getElementById("title-submenu-undo-button");
        const redoButton = document.getElementById("title-submenu-redo-button");

        const handleUndoClick = (event: Event) => {
            event.stopPropagation();
            void onUndo();
        };

        const handleRedoClick = (event: Event) => {
            event.stopPropagation();
            void onRedo();
        };

        undoButton?.addEventListener("click", handleUndoClick);
        redoButton?.addEventListener("click", handleRedoClick);

        return () => {
            undoButton?.removeEventListener("click", handleUndoClick);
            redoButton?.removeEventListener("click", handleRedoClick);
        };
    }, [onRedo, onUndo]);

    useEffect(() => {
        const { fileContainer, editContainer, runContainer } = menuElements;
        const fileButton = document.getElementById("title-submenu-file-button");
        const editButton = document.getElementById("title-submenu-edit-button");
        const runButton = document.getElementById("title-submenu-run-button");

        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (
                !fileContainer?.contains(target) &&
                !editContainer?.contains(target) &&
                !runContainer?.contains(target)
            ) {
                setActiveMenu(null);
            }
        };

        const toggleMenu = (menu: TitleMenuKind) => (event: MouseEvent) => {
            event.stopPropagation();
            setActiveMenu((previous) => previous === menu ? null : menu);
        };

        const switchMenuOnHover = (menu: TitleMenuKind) => () => {
            if (activeMenuRef.current && activeMenuRef.current !== menu) {
                setActiveMenu(menu);
            }
        };

        const handleFileButtonClick = toggleMenu("file");
        const handleEditButtonClick = toggleMenu("edit");
        const handleRunButtonClick = toggleMenu("run");
        const handleFileMouseEnter = switchMenuOnHover("file");
        const handleEditMouseEnter = switchMenuOnHover("edit");
        const handleRunMouseEnter = switchMenuOnHover("run");

        document.addEventListener("click", handleClickOutside);
        fileButton?.addEventListener("click", handleFileButtonClick);
        editButton?.addEventListener("click", handleEditButtonClick);
        runButton?.addEventListener("click", handleRunButtonClick);
        fileButton?.addEventListener("mouseenter", handleFileMouseEnter);
        editButton?.addEventListener("mouseenter", handleEditMouseEnter);
        runButton?.addEventListener("mouseenter", handleRunMouseEnter);

        return () => {
            document.removeEventListener("click", handleClickOutside);
            fileButton?.removeEventListener("click", handleFileButtonClick);
            editButton?.removeEventListener("click", handleEditButtonClick);
            runButton?.removeEventListener("click", handleRunButtonClick);
            fileButton?.removeEventListener("mouseenter", handleFileMouseEnter);
            editButton?.removeEventListener("mouseenter", handleEditMouseEnter);
            runButton?.removeEventListener("mouseenter", handleRunMouseEnter);
        };
    }, [menuElements]);

    useEffect(() => {
        document.querySelectorAll(".title-menu-item").forEach((button) => {
            button.classList.remove("title-menu-item-active");
        });

        const activeButton = activeMenu ? document.getElementById(`title-submenu-${activeMenu}-button`) : null;
        if (activeButton) {
            activeButton.classList.add("title-menu-item-active");
        }

        const displayFile = activeMenu === "file" ? "block" : "none";
        const displayEdit = activeMenu === "edit" ? "block" : "none";
        const displayRun = activeMenu === "run" ? "block" : "none";

        if (menuElements.fileContainer) {
            menuElements.fileContainer.style.display = displayFile;
        }
        if (menuElements.editContainer) {
            menuElements.editContainer.style.display = displayEdit;
        }
        if (menuElements.runContainer) {
            menuElements.runContainer.style.display = displayRun;
        }
    }, [activeMenu, menuElements]);

    return (
        <>
            {menuElements.fileContainer ? createPortal(<Menu items={fileItems} />, menuElements.fileContainer) : null}
            {menuElements.editContainer ? createPortal(<Menu items={editItems} />, menuElements.editContainer) : null}
            {menuElements.runContainer ? createPortal(<Menu items={runItems} />, menuElements.runContainer) : null}
        </>
    );
}
