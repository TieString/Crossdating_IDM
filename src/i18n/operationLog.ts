import type { RwlOperationLogEntry } from '@/features/rwl/edit';
import { getLocale, localizeMessage, t } from './core';

/** Build display-only details from typed operations, never by replacing a series name. */
export function localizeOperationDetail(entry: RwlOperationLogEntry): string {
    if (getLocale() === 'zh-CN') return entry.detail;
    const op = entry.operation;
    if (!op) return localizeMessage(entry.detail);
    switch (op.type) {
        case 'insert-missing': return `${op.tree} · ${op.year} · ${t(op.side === 'left' ? '左侧' : '右侧')}`;
        case 'delete-year': return `${op.tree} · ${op.year} · ${t({ direct: '直接删除', left: '并入左侧', right: '并入右侧', both: '两侧均分' }[op.mode])} · ${t(op.shift === 'left' ? '右侧左靠' : '左侧右靠')}`;
        case 'delete-year-range': return `${op.tree} · ${op.startYear}-${op.endYear} · ${t({ missing: '保持缺失', left: '左侧补位', right: '右侧补位' }[op.fill])}`;
        case 'change-width': return `${op.tree} · ${op.year} → ${op.width ?? t('缺测')}`;
        case 'restore-deletion':
        case 'remove-deletion-marker': return t('{0} · 标记 {1} · #{2}{3}', [op.tree, op.markerYear, op.index + 1, (op.markerCount ?? 1) > 1 ? t(' · {0} 个', [op.markerCount]) : '']);
        case 'move-selection': return t('{0} · {1}-{2} · {3}{4} 年', [op.tree, op.selectedStartYear, op.selectedEndYear, op.yearOffset > 0 ? '+' : '', op.yearOffset]);
        case 'replace-all-data': return t('{0} 条序列{1}', [op.treeCount, op.format ? ` · ${op.format}` : '']);
        // These detail fields consist only of identifiers and numbers.
        case 'move-series-batch':
        case 'mark-missing-range':
        case 'delete-series':
        case 'replace-tree-data': return entry.detail;
    }
}
