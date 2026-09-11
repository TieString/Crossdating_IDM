import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import catalog from './en.json';
import { getLocale, isLocale, LANGUAGE_STORAGE_KEY, localizeError, localizeMessage, messageKey, normalizeLocale, readLocale, receiveLocale, setLocale, subscribeLocale, t } from './core';
import { localizeOperationDetail } from './operationLog';
import type { RwlOperationLogEntry } from '@/features/rwl/edit';
import { formatRwlReadError } from '@/pages/home/rwlReadError';

afterEach(() => { receiveLocale('zh-CN'); vi.unstubAllGlobals(); });

describe('offline language store', () => {
    it('defaults and migrates unknown preferences to Chinese', () => {
        expect(normalizeLocale(undefined)).toBe('zh-CN');
        expect(normalizeLocale('xx')).toBe('zh-CN');
        expect(isLocale('en-US')).toBe(true);
        expect(isLocale('English')).toBe(false);
        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
        expect(readLocale()).toBe('zh-CN');
    });
    it('persists only the language key and preserves existing settings/drafts', () => {
        const data = new Map([['crossdating-idm-settings', '{"animation":{}}'], ['draft', '原始数据']]);
        vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key), setItem: (key: string, value: string) => data.set(key, value) });
        expect(setLocale('en-US')).toBe(true);
        expect(data.get(LANGUAGE_STORAGE_KEY)).toBe('en-US');
        expect(readLocale()).toBe('en-US');
        expect(data.get('draft')).toBe('原始数据');
        expect(data.get('crossdating-idm-settings')).toBe('{"animation":{}}');
    });
    it('keeps live switching available when storage is blocked', () => {
        vi.stubGlobal('localStorage', { setItem: () => { throw new Error('quota'); } });
        expect(setLocale('en-US')).toBe(false);
        expect(t('保存')).toBe('Save');
    });
    it('validates remote updates, notifies once, and cleans up subscriptions', () => {
        const listener = vi.fn(); const off = subscribeLocale(listener);
        receiveLocale('en-US'); receiveLocale('en-US'); receiveLocale('invalid');
        expect(getLocale()).toBe('en-US'); expect(listener).toHaveBeenCalledTimes(1);
        off(); receiveLocale('zh-CN'); expect(listener).toHaveBeenCalledTimes(1);
    });
});

describe('message boundaries', () => {
    it('translates and switches back without a network request', () => {
        receiveLocale('en-US'); expect(t('保存')).toBe('Save');
        receiveLocale('zh-CN'); expect(t('保存')).toBe('保存');
    });
    it('interpolates once, preserving Chinese identifiers, paths, punctuation and signs', () => {
        const id = '左侧$&{1}<样芯>'; const file = 'C:\\测量\\设置.rwl';
        expect(t('文件：{0}', [file], 'en-US')).toBe(`File: ${file}`);
        expect(t('{0} · 整体移动 {1} 年', [id, -3], 'en-US')).toBe(`${id} · Shift entire series by -3 years`);
    });
    it('preserves explicit JSX boundary spaces', () => {
        expect(t(' 条编辑记录', [], 'en-US')).toBe(' edit records');
        expect(t('置信度 ', [], 'en-US')).toBe('Confidence ');
    });
    it('keeps unknown external text unchanged', () => {
        const raw = '第三方错误 /home/设置.rwl: x=y';
        expect(localizeMessage(raw, 'en-US')).toBe(raw);
    });
    it('localizes complete historical messages in either direction', () => {
        expect(localizeMessage('统一诊断模型整体移动 -2 年', 'en-US')).toBe('Unified-model whole-series shift of -2 years');
        expect(localizeMessage('Connecting to the main window…', 'zh-CN')).toBe('正在连接主窗口...');
    });
    it('localizes native TIFF errors without changing the embedded path', () => {
        receiveLocale('en-US');
        expect(localizeError(new Error('无法读取扫描影像 C:\\扫描\\样芯.tiff: denied'))).toBe('Cannot read scan image C:\\扫描\\样芯.tiff: denied');
    });
    it('renders parser guidance in English without guessing or editing data', () => {
        receiveLocale('en-US');
        const result = formatRwlReadError(new Error('missing stop marker in 中文芯 before 1910; inferred 999'), '/data/样本.rwl');
        expect(result).toContain('中文芯'); expect(result).toContain('/data/样本.rwl');
        expect(result).toContain('999 (0.01 mm)'); expect(result).toContain('-9999 (0.001 mm)');
        expect(result).toContain('source file was not modified');
    });
    it('renders typed operation details without translating a core named like a label', () => {
        const entry = { detail: '左侧 · 1900 · 左侧', operation: { type: 'insert-missing', tree: '左侧', year: 1900, side: 'left' } } as RwlOperationLogEntry;
        const before = JSON.stringify(entry);
        receiveLocale('en-US'); expect(localizeOperationDetail(entry)).toBe('左侧 · 1900 · Left side');
        receiveLocale('zh-CN'); expect(localizeOperationDetail(entry)).toBe('左侧 · 1900 · 左侧');
        expect(JSON.stringify(entry)).toBe(before);
    });
});

describe('catalog coverage', () => {
    it('has an English translation and the same parameter indexes for every message', () => {
        const slots = (text: string) => [...text.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort();
        for (const [zh, en] of Object.entries(catalog)) {
            expect(en.trim().length, zh).toBeGreaterThan(0);
            expect(slots(en), zh).toEqual(slots(zh));
            if (zh !== '简体中文') expect(en, zh).not.toMatch(/[\u3400-\u9fff]/u);
        }
    });
    it('covers every Chinese literal in the runtime React views and every direct t() key', () => {
        const missing: string[] = [];
        const visitDirectory = (directory: string) => {
            for (const item of readdirSync(directory, { withFileTypes: true })) {
                const file = path.join(directory, item.name);
                if (item.isDirectory()) { if (item.name !== 'i18n' && item.name !== '__tests__') visitDirectory(file); continue; }
                if (!/\.tsx?$/.test(file) || /\.test\./.test(file)) continue;
                const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
                const visit = (node: ts.Node) => {
                    if (ts.isStringLiteral(node) && /[\u3400-\u9fff]/u.test(node.text)) {
                        let consoleMessage = false;
                        for (let ancestor: ts.Node | undefined = node.parent; ancestor; ancestor = ancestor.parent) {
                            if (ts.isCallExpression(ancestor) && ancestor.expression.getText(source).startsWith('console.')) consoleMessage = true;
                        }
                        const directKey = ts.isCallExpression(node.parent) && node.parent.expression.getText(source) === 't' && node.parent.arguments[0] === node;
                        if (!consoleMessage && (file.endsWith('.tsx') || directKey) && !(messageKey(node.text) in catalog)) missing.push(`${file}: ${node.text}`);
                    }
                    if (ts.isJsxText(node) && /[\u3400-\u9fff]/u.test(node.text)) missing.push(`${file}: untranslated JSX ${node.text.trim()}`);
                    ts.forEachChild(node, visit);
                };
                visit(source);
            }
        };
        visitDirectory(path.resolve('src'));
        expect(missing).toEqual([]);
    });
});
