import { invoke } from "@tauri-apps/api/core";
import {
    CURRENT_EVENT_PROTOCOL_VERSION,
    DEFAULT_CURRENT_EVENT_MODEL_ID,
    RRF_CURRENT_EVENT_MODEL_ID,
    type CurrentEventModelCatalog,
    type CurrentEventRankRequest,
    type CurrentEventRankResponse,
    type CurrentEventTransportError,
} from "./types";

export type RankCurrentEventInput = {
    modelId?: string;
    rwlPath: string;
    targetSeriesId: string;
    confirmedYears?: readonly number[];
    requestId?: string;
};

export const currentEventRequestPolicyForModel = (modelId: string) => (
    modelId === RRF_CURRENT_EVENT_MODEL_ID
        ? { existingZeroPolicy: "remove" as const, topK: 5, rangeRadius: 3 }
        : { existingZeroPolicy: "preserve" as const, topK: 5, rangeRadius: 1 }
);

export const createCurrentEventRequest = ({
    modelId = DEFAULT_CURRENT_EVENT_MODEL_ID,
    rwlPath,
    targetSeriesId,
    confirmedYears = [],
    requestId = crypto.randomUUID(),
}: RankCurrentEventInput): CurrentEventRankRequest => {
    const policy = currentEventRequestPolicyForModel(modelId);
    return {
        protocolVersion: CURRENT_EVENT_PROTOCOL_VERSION,
        requestId,
        method: "rank_current_event",
        params: {
            rwlPath,
            targetSeriesId,
            existingZeroPolicy: policy.existingZeroPolicy,
            confirmedInsertions: Array.from(new Set(confirmedYears))
                .sort((a, b) => b - a)
                .map((year) => ({ year })),
            topK: policy.topK,
            rangeRadius: policy.rangeRadius,
        },
    };
};

export const rankCurrentEvent = async (
    input: RankCurrentEventInput,
): Promise<CurrentEventRankResponse> => {
    const request = createCurrentEventRequest(input);
    return invoke<CurrentEventRankResponse>("rank_current_event_v1", {
        modelId: input.modelId ?? DEFAULT_CURRENT_EVENT_MODEL_ID,
        request,
    });
};

export const listCurrentEventModels = async (): Promise<CurrentEventModelCatalog> => (
    invoke<CurrentEventModelCatalog>("list_current_event_models")
);

export const normalizeCurrentEventTransportError = (
    error: unknown,
): CurrentEventTransportError => {
    if (error && typeof error === "object") {
        const candidate = error as Partial<CurrentEventTransportError>;
        if (typeof candidate.code === "string" && typeof candidate.message === "string") {
            return {
                code: candidate.code,
                message: candidate.message,
                retryable: Boolean(candidate.retryable),
                details: candidate.details,
            };
        }
    }
    return {
        code: "TAURI_COMMAND_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
    };
};
