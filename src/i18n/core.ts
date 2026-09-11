import english from './en.json';

/** The catalog contains only application-owned messages; never pass arbitrary RWL text. */
export type Locale = 'zh-CN' | 'en-US';
export const LANGUAGE_STORAGE_KEY = 'crossdating-idm-language';
export const LANGUAGE_EVENT = 'crossdating-idm://language';
export const normalizeLocale = (value: unknown): Locale => value === 'en-US' ? 'en-US' : 'zh-CN';
export const isLocale = (value: unknown): value is Locale => value === 'en-US' || value === 'zh-CN';
export function readLocale(): Locale {
    try { return normalizeLocale(globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY)); }
    catch { return 'zh-CN'; }
}
let locale: Locale = readLocale();
const listeners = new Set<() => void>();
export const getLocale = (): Locale => locale;
/** Subscribe without touching React state or workspace data. */
export function subscribeLocale(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
/** Receiving a remote update must not broadcast it again. */
export function receiveLocale(value: unknown): void {
    if (!isLocale(value) || value === locale) return;
    locale = value;
    for (const listener of listeners) listener();
}
/** Returns false on storage failure; the live change is still applied. */
export function setLocale(value: Locale): boolean {
    if (!isLocale(value)) return false;
    let saved = true;
    try { globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, value); }
    catch { saved = false; }
    receiveLocale(value);
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        void import('@tauri-apps/api/event').then(({ emit }) => emit(LANGUAGE_EVENT, value)).catch(() => {});
    }
    return saved;
}
const catalog: Readonly<Record<string, string>> = english;
export const messageKey = (text: string): string => text.trim().replace(/\s*\n\s*/g, ' ');
const interpolate = (text: string, values: readonly unknown[]): string =>
    text.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)] ?? '') : match);

/** Translate a source message with single-pass interpolation. Values are never rewritten. */
export function t(source: string, values: readonly unknown[] = [], language: Locale = getLocale()): string {
    const translated = language === 'en-US' ? catalog[messageKey(source)] : undefined;
    const localized = translated === undefined ? source
        : (source.match(/^\s+/)?.[0] ?? '') + translated + (source.match(/\s+$/)?.[0] ?? '');
    return interpolate(localized, values);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const literalEntries = Object.entries(catalog);
const reverse = new Map<string, string>();
for (const [zh, en] of literalEntries) if (!reverse.has(en)) reverse.set(en, zh);
function compileTemplate(source: string) {
    const indexes: number[] = [];
    let cursor = 0;
    let pattern = '^';
    for (const match of source.matchAll(/\{(\d+)\}/g)) {
        pattern += escapeRegExp(source.slice(cursor, match.index)) + '([\\s\\S]*?)';
        indexes.push(Number(match[1]));
        cursor = match.index! + match[0].length;
    }
    pattern += escapeRegExp(source.slice(cursor)) + '$';
    return { regex: new RegExp(pattern), indexes };
}
const templates = literalEntries.filter(([key]) => /\{\d+\}/.test(key))
    // Specific messages must win over short templates such as "{0} 年".
    .sort((a, b) => b[0].replace(/\{\d+\}/g, '').length - a[0].replace(/\{\d+\}/g, '').length)
    .map(([zh, en]) => ({ zh, en, forward: compileTemplate(zh), backward: compileTemplate(en) }));

/**
 * Display adapter for existing app-generated logs/errors/diagnostics. Matches complete
 * catalog messages only; not a global substring replacer. Identifiers, paths and unknown
 * external messages remain verbatim. Persisted records are never changed.
 */
export function localizeMessage(source: string, language: Locale = getLocale()): string {
    const key = messageKey(source);
    const direct = language === 'en-US' ? catalog[key] : reverse.get(key);
    if (direct !== undefined) return direct;
    for (const entry of templates) {
        const matcher = language === 'en-US' ? entry.forward : entry.backward;
        const match = matcher.regex.exec(key);
        if (!match) continue;
        const values: string[] = [];
        matcher.indexes.forEach((index, position) => { values[index] = match[position + 1]; });
        return interpolate(language === 'en-US' ? entry.en : entry.zh, values);
    }
    return source;
}

/** Localize errors only at the UI boundary, leaving unknown external details intact. */
export function localizeError(error: unknown): string {
    return localizeMessage(error instanceof Error ? error.message : String(error));
}
