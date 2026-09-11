import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { DiagnosisEventPanel } from '@/components/DiagnosisCandidates/DiagnosisEventPanel';
import type { DiagnosisEvent } from '@/features/crossdating/diagnosis';
import { receiveLocale } from './core';

afterEach(() => receiveLocale('zh-CN'));
const event: DiagnosisEvent = {
    id: 'event-1', seriesId: 'ABC01A', eventType: 'missingRing',
    startYear: 1880, endYear: 1886,
    rankedYears: [{ year: 1883, rank: 1, score: 2.1, evidenceTags: ['piecewise_lag_path'] }],
    confidenceLevel: 'high', evidence: {
        algorithmSources: ['piecewise_lag_path'], score: 2.1, scoreMargin: 0.4,
        baselineCorrelation: 0.31, correctedCorrelation: 0.62, correlationGain: 0.31,
        lagBefore: -1, lagAfter: 0, samplePairs: 38, candidateIds: [], notes: [],
    }, alternativeTypes: [],
};

describe('localized diagnosis views', () => {
    it('translates the rendered event, review labels, tooltips and accessible descriptions', () => {
        receiveLocale('en-US');
        const html = renderToStaticMarkup(createElement(DiagnosisEventPanel, {
            events: [event], selectedEventId: event.id, selectedReviewYear: 1883,
            onApplyEvent: () => true, onDismiss: () => undefined,
        }));
        expect(html).not.toMatch(/[\u3400-\u9fff]/);
        expect(html).toContain('1883'); expect(html).toContain('lag -1 → 0');
        expect(html).toContain('missing ring');
    });
    it('restores the original Chinese without changing the event evidence', () => {
        const before = JSON.stringify(event);
        receiveLocale('en-US'); renderToStaticMarkup(createElement(DiagnosisEventPanel, { events: [event] }));
        receiveLocale('zh-CN');
        const html = renderToStaticMarkup(createElement(DiagnosisEventPanel, { events: [event] }));
        expect(html).toContain('可能缺轮'); expect(html).toContain('复核年份');
        expect(JSON.stringify(event)).toBe(before);
    });
});
