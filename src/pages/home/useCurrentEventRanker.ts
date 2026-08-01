import { useCallback, useEffect, useRef, useState } from "react";
import {
    listCurrentEventModels,
    normalizeCurrentEventTransportError,
    rankCurrentEvent,
} from "@/services/currentEventRanker/client";
import type {
    CurrentEventModelDescriptor,
    CurrentEventRankResult,
    CurrentEventTransportError,
} from "@/services/currentEventRanker/types";
import {
    DEFAULT_CURRENT_EVENT_MODEL_ID,
    migrateCurrentEventModelId,
} from "@/services/currentEventRanker/types";

const MODEL_STORAGE_KEY = "crossdating.current-event.active-model.v1";

const readStoredModelId = () => {
    try {
        const stored = globalThis.localStorage?.getItem(MODEL_STORAGE_KEY);
        return migrateCurrentEventModelId(stored);
    } catch {
        return DEFAULT_CURRENT_EVENT_MODEL_ID;
    }
};

const storeModelId = (modelId: string) => {
    try {
        globalThis.localStorage?.setItem(MODEL_STORAGE_KEY, modelId);
    } catch {
        // Storage failure must not prevent diagnostic model use.
    }
};

export type CurrentEventSessionStatus =
    | "idle"
    | "running"
    | "advice"
    | "range_advice"
    | "insufficient"
    | "stale"
    | "cancelled"
    | "error";

export const currentEventResultStatusToSessionStatus = (
    status: string,
): CurrentEventSessionStatus => {
    if (status === "advice" || status === "range_advice") return status;
    if (status === "evidence_insufficient") return "insufficient";
    return "error";
};

export type CurrentEventSessionContext = {
    rwlPath: string;
    targetSeriesId: string;
    sourceHash: string;
};

export type CurrentEventRankerSession = {
    modelId: string;
    status: CurrentEventSessionStatus;
    requestId: string | null;
    context: CurrentEventSessionContext | null;
    confirmedYears: number[];
    result: CurrentEventRankResult | null;
    error: CurrentEventTransportError | null;
    staleReason: string | null;
};

export const createEmptyCurrentEventSession = (): CurrentEventRankerSession => ({
    modelId: readStoredModelId(),
    status: "idle",
    requestId: null,
    context: null,
    confirmedYears: [],
    result: null,
    error: null,
    staleReason: null,
});

const normalizeConfirmedYears = (years: readonly number[]) => (
    Array.from(new Set(years))
);

type QueuedRankRequest = {
    modelId: string;
    generation: number;
    requestId: string;
    context: CurrentEventSessionContext;
    confirmedYears: number[];
};

type UseCurrentEventRankerOptions = {
    enabled?: boolean;
};

export function useCurrentEventRanker({ enabled = true }: UseCurrentEventRankerOptions = {}) {
    const generationRef = useRef(0);
    const inFlightRef = useRef(false);
    const pendingRef = useRef<QueuedRankRequest | null>(null);
    const [models, setModels] = useState<CurrentEventModelDescriptor[]>([]);
    const [modelCatalogError, setModelCatalogError] = useState<CurrentEventTransportError | null>(null);
    const [activeModelId, setActiveModelId] = useState(readStoredModelId);
    const activeModelIdRef = useRef(activeModelId);
    const [session, setSession] = useState<CurrentEventRankerSession>(
        createEmptyCurrentEventSession,
    );

    useEffect(() => {
        if (!enabled) return undefined;
        let active = true;
        void listCurrentEventModels()
            .then((catalog) => {
                if (!active) return;
                setModels(catalog.models);
                setModelCatalogError(null);
                const selected = catalog.models.some((model) => model.id === activeModelIdRef.current)
                    ? activeModelIdRef.current
                    : catalog.defaultModelId;
                activeModelIdRef.current = selected;
                setActiveModelId(selected);
                storeModelId(selected);
                setSession((previous) => (
                    previous.status === "idle" ? { ...previous, modelId: selected } : previous
                ));
            })
            .catch((error) => {
                if (active) setModelCatalogError(normalizeCurrentEventTransportError(error));
            });
        return () => {
            active = false;
        };
    }, [enabled]);

    const runQueue = useCallback(async (initialRequest: QueuedRankRequest) => {
        let current: QueuedRankRequest | null = initialRequest;
        while (current) {
            const {
                modelId,
                generation,
                requestId,
                context,
                confirmedYears,
            } = current;
            try {
                const response = await rankCurrentEvent({
                    modelId,
                    rwlPath: context.rwlPath,
                    targetSeriesId: context.targetSeriesId,
                    confirmedYears,
                    requestId,
                });
                if (generation !== generationRef.current) {
                    current = pendingRef.current;
                    pendingRef.current = null;
                    continue;
                }
                if (response.requestId !== requestId) {
                    setSession((previous) => ({
                        ...previous,
                        status: "error",
                        error: {
                            code: "REQUEST_ID_MISMATCH",
                            message: "模型响应与当前请求不匹配，结果已丢弃",
                            retryable: true,
                        },
                    }));
                    current = pendingRef.current;
                    pendingRef.current = null;
                    continue;
                }
                if (!response.ok || response.error) {
                    const protocolError = response.error ?? {
                        code: "INVALID_SIDECAR_RESPONSE",
                        message: "模型返回了不完整的错误响应",
                        retryable: true,
                        details: {},
                    };
                    console.warn("[current-event V1] protocol error", protocolError);
                    setSession((previous) => ({
                        ...previous,
                        status: "error",
                        error: protocolError,
                        result: null,
                    }));
                    current = pendingRef.current;
                    pendingRef.current = null;
                    continue;
                }
                if (!response.result) {
                    setSession((previous) => ({
                        ...previous,
                        status: "error",
                        error: {
                            code: "INVALID_SIDECAR_RESPONSE",
                            message: "模型响应缺少 result",
                            retryable: true,
                        },
                        result: null,
                    }));
                    current = pendingRef.current;
                    pendingRef.current = null;
                    continue;
                }
                const nextStatus = currentEventResultStatusToSessionStatus(response.result.status);
                console.groupCollapsed(
                    `[current-event V1][${modelId}][diagnostic-only] ${context.targetSeriesId} · ${response.result.status}`,
                );
                console.info("rankingScore 仅表示本轮相对排序，不是概率。");
                console.info({
                    modelId,
                    requestId,
                    confirmedYears,
                    reliability: response.result.reliability,
                    rangeReliability: response.result.rangeReliability,
                    yearReliability: response.result.yearReliability,
                    state: response.result.state,
                    diagnostics: response.result.diagnostics,
                    elapsedMs: response.result.elapsedMs,
                });
                console.table(response.result.suggestions);
                console.groupEnd();
                setSession((previous) => ({
                    ...previous,
                    status: nextStatus,
                    result: response.result ?? null,
                    error: nextStatus === "error"
                        ? {
                            code: "UNEXPECTED_RESULT_STATUS",
                            message: `未知模型状态：${response.result?.status}`,
                            retryable: true,
                        }
                        : null,
                }));
            } catch (error) {
                if (generation === generationRef.current) {
                    const normalized = normalizeCurrentEventTransportError(error);
                    console.warn("[current-event V1] transport error", normalized);
                    setSession((previous) => ({
                        ...previous,
                        status: "error",
                        error: normalized,
                    }));
                }
            }
            current = pendingRef.current;
            pendingRef.current = null;
        }
        inFlightRef.current = false;
    }, []);

    const execute = useCallback((
        context: CurrentEventSessionContext,
        confirmedYears: readonly number[],
    ) => {
        if (!enabled) return;
        const generation = ++generationRef.current;
        const requestId = crypto.randomUUID();
        const normalizedYears = normalizeConfirmedYears(confirmedYears);
        const modelId = activeModelIdRef.current;

        setSession((previous) => ({
            modelId,
            status: "running",
            requestId,
            context,
            confirmedYears: normalizedYears,
            result: previous.context?.rwlPath === context.rwlPath
                && previous.context.targetSeriesId === context.targetSeriesId
                ? previous.result
                : null,
            error: null,
            staleReason: null,
        }));

        const queuedRequest = {
            modelId,
            generation,
            requestId,
            context,
            confirmedYears: normalizedYears,
        };
        if (inFlightRef.current) {
            pendingRef.current = queuedRequest;
            return;
        }
        inFlightRef.current = true;
        void runQueue(queuedRequest);
    }, [enabled, runQueue]);

    const start = useCallback((
        context: CurrentEventSessionContext,
        confirmedYears: readonly number[] = [],
    ) => {
        void execute(context, confirmedYears);
    }, [execute]);

    const confirmYear = useCallback((year: number) => {
        if (!session.context || session.status === "running") {
            return;
        }
        const confirmedYears = normalizeConfirmedYears([...session.confirmedYears, year]);
        const maxConfirmations = models.find((model) => model.id === session.modelId)
            ?.maxConfirmations ?? 6;
        if (confirmedYears.length > maxConfirmations) {
            setSession((previous) => ({
                ...previous,
                status: "error",
                error: {
                    code: "CONFIRMATION_LIMIT_REACHED",
                    message: `当前模型会话最多确认 ${maxConfirmations} 个插年，请先应用并保存`,
                    retryable: false,
                },
            }));
            return;
        }
        void execute(session.context, confirmedYears);
    }, [execute, models, session.confirmedYears, session.context, session.modelId, session.status]);

    const undoLastConfirmation = useCallback(() => {
        if (!session.context || session.status === "running" || session.confirmedYears.length === 0) {
            return;
        }
        void execute(session.context, session.confirmedYears.slice(0, -1));
    }, [execute, session.confirmedYears, session.context, session.status]);

    const retry = useCallback(() => {
        if (!session.context || session.status === "running") {
            return;
        }
        void execute(session.context, session.confirmedYears);
    }, [execute, session.confirmedYears, session.context, session.status]);

    const cancel = useCallback(() => {
        generationRef.current += 1;
        pendingRef.current = null;
        setSession((previous) => ({
            ...previous,
            status: "cancelled",
            requestId: null,
            staleReason: "已取消显示；旁路进程中的当前计算可能仍会自然结束",
        }));
    }, []);

    const selectModel = useCallback((modelId: string) => {
        if (modelId === activeModelIdRef.current || !models.some((model) => model.id === modelId)) {
            return;
        }
        generationRef.current += 1;
        pendingRef.current = null;
        activeModelIdRef.current = modelId;
        setActiveModelId(modelId);
        storeModelId(modelId);
        const selectedModel = models.find((model) => model.id === modelId);
        setSession((previous) => ({
            ...previous,
            modelId,
            status: previous.status === "idle" ? "idle" : "stale",
            requestId: null,
            confirmedYears: [],
            result: null,
            error: null,
            staleReason: previous.status === "idle"
                ? null
                : selectedModel?.manualOnly
                    ? "模型已切换；该专家路线不会因保存自动启动，请点击“分析当前序列”。"
                    : "模型已切换；请重新分析或保存，以相同输入生成新模型建议。",
        }));
    }, [models]);

    const markStale = useCallback((reason: string) => {
        generationRef.current += 1;
        pendingRef.current = null;
        setSession((previous) => (
            previous.status === "idle"
                ? previous
                : {
                    ...previous,
                    status: "stale",
                    requestId: null,
                    staleReason: reason,
                }
        ));
    }, []);

    const reset = useCallback(() => {
        generationRef.current += 1;
        pendingRef.current = null;
        setSession({
            ...createEmptyCurrentEventSession(),
            modelId: activeModelIdRef.current,
        });
    }, []);

    return {
        session,
        models,
        activeModelId,
        modelCatalogError,
        selectModel,
        start,
        confirmYear,
        undoLastConfirmation,
        retry,
        cancel,
        markStale,
        reset,
    };
}
