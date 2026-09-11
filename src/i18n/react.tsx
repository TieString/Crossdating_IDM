import { useEffect, useSyncExternalStore } from 'react';
import {
    getLocale, isLocale, LANGUAGE_EVENT, LANGUAGE_STORAGE_KEY, readLocale,
    receiveLocale, subscribeLocale, t,
} from './core';

/** A separate subscription updates even memoized views without remounting the editor. */
export function useLocale() {
    return useSyncExternalStore(subscribeLocale, getLocale, () => 'zh-CN' as const);
}

/** One bridge per webview; cleans up async Tauri listeners under React StrictMode. */
export function LanguageBridge() {
    const locale = useLocale();
    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) receiveLocale(readLocale());
        };
        window.addEventListener('storage', onStorage);
        let disposed = false;
        let unlisten: (() => void) | undefined;
        if ('__TAURI_INTERNALS__' in window) {
            void import('@tauri-apps/api/event').then(({ listen }) =>
                listen<unknown>(LANGUAGE_EVENT, ({ payload }) => {
                    if (!disposed && isLocale(payload)) receiveLocale(payload);
                }),
            ).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup; }).catch(() => {});
        }
        receiveLocale(readLocale());
        return () => { disposed = true; unlisten?.(); window.removeEventListener('storage', onStorage); };
    }, []);
    useEffect(() => {
        document.documentElement.lang = locale;
        for (const [id, source] of [
            ['title-submenu-file-button', '文件(F)'],
            ['title-submenu-edit-button', '编辑(E)'],
            ['title-submenu-run-button', '运行(R)'],
        ]) {
            const element = document.getElementById(id);
            if (element) element.textContent = t(source);
        }
        const page = new URLSearchParams(window.location.search).get('page');
        const source = page === 'settings' ? '偏好设置' : page === 'operation-log' ? '操作日志'
            : page === 'cofecha' ? 'COFECHA' : page === 'line-chart' ? 'Line Chart' : null;
        if (source) {
            document.title = t(source);
            if ('__TAURI_INTERNALS__' in window) {
                void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
                    getCurrentWindow().setTitle(t(source)),
                ).catch(() => {});
            }
        }
    }, [locale]);
    return null;
}
