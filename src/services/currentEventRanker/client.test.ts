import { beforeEach, describe, expect, it, vi } from "vitest";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import {
    createCurrentEventRequest,
    currentEventRequestPolicyForModel,
    listCurrentEventModels,
    normalizeCurrentEventTransportError,
    rankCurrentEvent,
} from "./client";
import {
    ADAPTIVE_CURRENT_EVENT_MODEL_ID,
    CURRENT_EVENT_PROTOCOL_VERSION,
    DEFAULT_CURRENT_EVENT_MODEL_ID,
    migrateCurrentEventModelId,
    RRF_CURRENT_EVENT_MODEL_ID,
    shouldRunCurrentEventAfterSave,
    SUPERSEDED_SINGLE_RANGE_MODEL_ID,
} from "./types";

describe("current-event Tauri protocol client", () => {
    beforeEach(() => invokeMock.mockReset());

    it("builds the frozen desktop request shape without label leakage", () => {
        const request = createCurrentEventRequest({
            requestId: "rank-1",
            rwlPath: String.raw`D:\data\sample.rwl`,
            targetSeriesId: "ABC01A",
            confirmedYears: [1880, 1910, 1880],
        });

        expect(request).toEqual({
            protocolVersion: CURRENT_EVENT_PROTOCOL_VERSION,
            requestId: "rank-1",
            method: "rank_current_event",
            params: {
                rwlPath: String.raw`D:\data\sample.rwl`,
                targetSeriesId: "ABC01A",
                existingZeroPolicy: "preserve",
                confirmedInsertions: [{ year: 1910 }, { year: 1880 }],
                topK: 5,
                rangeRadius: 1,
            },
        });
        expect(request.params).not.toHaveProperty("zero_count");
        expect(request.params).not.toHaveProperty("remaining_event_count");
    });

    it("builds the RRF route with remove/Top5/radius3 and newest-first confirmations", () => {
        const request = createCurrentEventRequest({
            modelId: RRF_CURRENT_EVENT_MODEL_ID,
            requestId: "rrf-1",
            rwlPath: String.raw`D:\data\sample.rwl`,
            targetSeriesId: "ABC01A",
            confirmedYears: [1880, 1910, 1880],
        });

        expect(currentEventRequestPolicyForModel(RRF_CURRENT_EVENT_MODEL_ID)).toEqual({
            existingZeroPolicy: "remove",
            topK: 5,
            rangeRadius: 3,
        });
        expect(request.params).toEqual({
            rwlPath: String.raw`D:\data\sample.rwl`,
            targetSeriesId: "ABC01A",
            existingZeroPolicy: "remove",
            confirmedInsertions: [{ year: 1910 }, { year: 1880 }],
            topK: 5,
            rangeRadius: 3,
        });
        expect(shouldRunCurrentEventAfterSave(RRF_CURRENT_EVENT_MODEL_ID, [])).toBe(false);
        expect(shouldRunCurrentEventAfterSave(DEFAULT_CURRENT_EVENT_MODEL_ID, [])).toBe(true);
    });

    it("preserves structured Rust transport errors", () => {
        expect(normalizeCurrentEventTransportError({
            code: "SIDECAR_TIMEOUT",
            message: "timed out",
            retryable: true,
            details: { seconds: 30 },
        })).toEqual({
            code: "SIDECAR_TIMEOUT",
            message: "timed out",
            retryable: true,
            details: { seconds: 30 },
        });
    });

    it("passes the selected model and preserves the server suggestion array order", async () => {
        const response = {
            protocolVersion: CURRENT_EVENT_PROTOCOL_VERSION,
            requestId: "rank-order",
            ok: true,
            result: {
                status: "advice",
                message: "single range",
                eventRange: {
                    startYear: 1880,
                    endYear: 1894,
                    centerYear: 1887,
                    width: 15,
                    scope: "newest_unresolved_event",
                    localizerScore: 1.2,
                    baseCenterRank: 4,
                    candidateCenterCount: 120,
                    scoreSemantics: "not probability",
                    adaptive: true,
                    shrunk: false,
                    windowPolicy: "local_score_mass",
                    maxEnvelopeStart: 1880,
                    maxEnvelopeEnd: 1894,
                    evidencePeak: 0.2,
                    evidenceMass: 0.8,
                },
                suggestions: [
                    { rank: 1, centerYear: 1892, rangeStart: 1880, rangeEnd: 1894, rankingScore: 0.1 },
                    { rank: 2, centerYear: 1879, rangeStart: 1880, rangeEnd: 1894, rankingScore: 0.9 },
                ],
            },
        };
        invokeMock.mockResolvedValue(response);

        const actual = await rankCurrentEvent({
            modelId: ADAPTIVE_CURRENT_EVENT_MODEL_ID,
            requestId: "rank-order",
            rwlPath: String.raw`D:\data\sample.rwl`,
            targetSeriesId: "ABC01A",
        });

        expect(invokeMock).toHaveBeenCalledWith("rank_current_event_v1", expect.objectContaining({
            modelId: ADAPTIVE_CURRENT_EVENT_MODEL_ID,
        }));
        expect(actual.result?.suggestions.map((item) => item.centerYear)).toEqual([1892, 1879]);
    });

    it("loads the packaged model catalog and keeps the legacy model as default", async () => {
        const catalog = { defaultModelId: DEFAULT_CURRENT_EVENT_MODEL_ID, models: [] };
        invokeMock.mockResolvedValue(catalog);
        await expect(listCurrentEventModels()).resolves.toEqual(catalog);
        expect(invokeMock).toHaveBeenCalledWith("list_current_event_models");
    });

    it("migrates the removed V1.1 selection to the adaptive model", () => {
        expect(migrateCurrentEventModelId(SUPERSEDED_SINGLE_RANGE_MODEL_ID))
            .toBe(ADAPTIVE_CURRENT_EVENT_MODEL_ID);
        expect(migrateCurrentEventModelId(null)).toBe(DEFAULT_CURRENT_EVENT_MODEL_ID);
    });
});
