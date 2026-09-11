import { afterEach, describe, expect, it, vi } from 'vitest';
import { RwlEditor } from '@/features/rwl/edit';
import { effectiveChanges, effectiveChangesCsv } from '@/features/rwl/effectiveChanges';
import { stopMarker } from '@/shared/constants';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { receiveLocale } from './core';

const oldMarker = stopMarker.value;
afterEach(() => { receiveLocale('zh-CN'); stopMarker.value = oldMarker; vi.useRealTimers(); });
function editor(id = 'A') {
    stopMarker.value = -9999;
    return new RwlEditor(new Map([[id, new Map([[2000, 100], [2001, 0], [2002, 300], [2003, 400], [2004, -9999]])]]),
        { stopMarkerValue: -9999 }, 'tucson');
}

describe('language-independent RWL and history', () => {
    it('preserves RWL, explicit zero, precision, unsaved history and undo across repeated switches', () => {
        vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
        const e = editor();
        const original = e.exportAsRwlString();
        e.changeYearWidth('A', 2000, 130);
        e.insertMissingYearAtSide('A', 2002, 'right');
        const rwl = e.exportAsRwlString();
        const snapshot = e.toHistorySnapshot();
        const log = e.getAllAppliedOperationLogEntries();
        for (const language of ['en-US', 'zh-CN', 'en-US', 'zh-CN'] as const) {
            receiveLocale(language);
            expect(e.exportAsRwlString()).toBe(rwl);
            expect(e.toHistorySnapshot()).toEqual(snapshot);
            expect(e.getAllAppliedOperationLogEntries()).toEqual(log);
        }
        e.undo(); e.undo(); expect(e.exportAsRwlString()).toBe(original);
        e.redo(); e.redo(); expect(e.exportAsRwlString()).toBe(rwl);
    });
    it('localizes CSV headings and descriptions, but never IDs, values or internal records', () => {
        const e = editor('左侧'); e.changeYearWidth('左侧', 2000, 130);
        const snapshot = e.toHistorySnapshot(); const original = JSON.stringify(snapshot);
        const en = effectiveChangesCsv(snapshot, 'en-US');
        expect(en).toContain('"Series ID"'); expect(en).toContain('"Ring-width change"');
        expect(en).toContain('"左侧"'); expect(en).toContain('"100","130"');
        expect(en.startsWith('\uFEFF')).toBe(true); expect(en.endsWith('\r\n')).toBe(true);
        expect(effectiveChangesCsv(snapshot, 'zh-CN')).toContain('"轮宽修改"');
        expect(effectiveChanges(snapshot)[0].type).toBe('轮宽修改');
        expect(JSON.stringify(snapshot)).toBe(original);
    });
    it('localizes compound block notes in exports while preserving their canonical source', () => {
        const e = editor();
        e.replaceTreeData('A', new Map([...Array.from({ length: 220 }, (_, i) => [1800 + i, 150] as [number, number]), [2020, -9999]]));
        const snapshot = e.toHistorySnapshot();
        const en = effectiveChangesCsv(snapshot, 'en-US');
        expect(en).not.toMatch(/[\u3400-\u9fff]/);
        expect(en).toContain('1/2'); expect(en).toContain('2/2');
        expect(effectiveChanges(snapshot)[0].note).toContain('分块');
    });
    it('preserves the frozen model byte-for-byte', () => {
        expect(createHash('sha256').update(readFileSync('public/models/unifiedV5Model.json')).digest('hex'))
            .toBe('4a355af59c22a9cd53e20d233256d94b44b83aea222d7ace55e6cb7e9bbb5c1e');
    });
});
