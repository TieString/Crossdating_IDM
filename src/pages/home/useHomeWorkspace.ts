import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractPart6FlaggedASeriesIds, parseCofechaResult, splitReportByParts } from "@/features/cofecha/formatter";
import {
    type CrossdatingDiagnosis,
    getDiagnosisCandidateLabel,
    isNegativePartialShift,
    markCandidatesStale,
    markDiagnosisEventsStale,
    planDiagnosisEventEdit,
    selectSafeDiagnosisCandidateBatch,
    type DiagnosisBatchApplyResult,
    type DiagnosisBatchCandidateResult,
    type DiagnosisCandidateOperation,
    type DiagnosisEvent,
    type LocalSimulationApplyRequest,
} from "@/features/crossdating/diagnosis";
import { buildCrossdatingValidationSummary } from "@/features/crossdating/validation";
import {
    createCofechaMasterReferenceConfig,
    hashRwlSiteData,
    normalizeReferenceSeriesConfig,
    type ReferenceSeriesConfig,
} from "@/features/crossdating/reference";
import type { ICofechaResult } from "@/features/cofecha/types";
import { detectPrecision, readRwlString } from "@/features/rwl";
import { rebuildTreeDataFromStartYear, type BayesianDatingCandidate, type BayesianMcmcDatingResult } from "@/features/rwl/bayesianDating";
import {
    RwlEditor,
    RwlMoveConflictError,
    registerChangeYearWidth,
} from "@/features/rwl/edit";
import type { DeleteMode, DeleteShift, RwlDeletionMarkers, RwlHistoryAnimation, RwlHistoryStatus, RwlOperationLogEntry } from "@/features/rwl/edit";
import type { RwlSiteData } from "@/features/rwl/types";
import { runCofecha } from "@/services/cofecha/runner";
import { readRwlFile, saveFile } from "@/services/fs/io";
import {
    RRF_CURRENT_EVENT_MODEL_ID,
    shouldRunCurrentEventAfterSave,
} from "@/services/currentEventRanker/types";
import { rebuildCurrentEventRrfTree } from "@/services/currentEventRanker/rebuild";
import { stopMarker } from "@/shared/constants";
import { CURRENT_EVENT_PYTHON_MODELS_ENABLED } from "@/shared/featureFlags";
import { useSettings } from "@/features/settings/SettingsContext";
import { ALL_OPTION_VALUE, CofechaVersion, formatTitle } from "./homeShared";
import type { DiagnosisWorkerRequest, DiagnosisWorkerResponse } from "./diagnosisWorker";
import { createSerialTaskQueue } from "./serialTaskQueue";
import { useCurrentEventRanker } from "./useCurrentEventRanker";
import {
    deserializeCofechaResult,
    loadPersistedCofechaState,
    loadPersistedHistorySnapshot,
    loadPersistedReferenceState,
    persistCofechaState,
    persistHistorySnapshot,
    persistReferenceState,
} from "./workspacePersistence";
import {
    createEmptyCrossdatingDiagnosis,
    createReferenceOperationLogEntry,
    MAX_REFERENCE_OPERATION_LOG_ENTRIES,
    normalizeWorkspaceOperationLogEntry,
    rwlDataEquals,
    stringArraysEqual,
} from "./workspaceState";

export type WidthHistoryAnimation = RwlHistoryAnimation & { id: number };

const HISTORY_SNAPSHOT_PERSIST_DELAY_MS = 250;
const DIAGNOSIS_DEBOUNCE_MS = 40;

type DiagnosisResultCache = {
    siteData: RwlSiteData;
    referenceConfig: ReferenceSeriesConfig | null;
    cofechaText: string | undefined;
    results: Map<string, CrossdatingDiagnosis>;
};

type RunCofechaApplyOptions = {
    version?: CofechaVersion;
    selectedPart?: string;
    inputData?: RwlSiteData;
    workspaceGuard?: {
        editor: RwlEditor;
        filePath: string;
        inputHash: string;
    };
};

const calculatePearsonCorrelation = (pairs: Array<[number, number]>): number | null => {
    if (pairs.length < 3) return null;

    const meanA = pairs.reduce((sum, [a]) => sum + a, 0) / pairs.length;
    const meanB = pairs.reduce((sum, [, b]) => sum + b, 0) / pairs.length;
    let numerator = 0;
    let denominatorA = 0;
    let denominatorB = 0;

    pairs.forEach(([a, b]) => {
        const da = a - meanA;
        const db = b - meanB;
        numerator += da * db;
        denominatorA += da * da;
        denominatorB += db * db;
    });

    const denominator = Math.sqrt(denominatorA * denominatorB);
    return denominator > 0 ? numerator / denominator : null;
};

const summarizeSeriesRange = (values: readonly number[]) => {
    if (values.length === 0) return null;
    return {
        min: Math.min(...values),
        max: Math.max(...values),
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    };
};

const logCofechaReferenceComparison = (
    cofechaMaster: Map<number, number>,
    dynamicReferenceConfig: ReferenceSeriesConfig,
) => {
    const dynamicReference = dynamicReferenceConfig.cofechaPassReference;
    if (!dynamicReference || dynamicReference.points.length === 0 || cofechaMaster.size === 0) {
        console.info("[COFECHA reference comparison] skipped", {
            cofechaMasterPoints: cofechaMaster.size,
            dynamicReferencePoints: dynamicReference?.points.length ?? 0,
        });
        return;
    }

    const dynamicByYear = new Map(dynamicReference.points.map((point) => [point.year, point.value]));
    const replicationByYear = new Map(dynamicReference.points.map((point) => [point.year, point.replication]));
    const rows = Array.from(cofechaMaster.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([year, cofechaValue]) => {
            const dynamicValue = dynamicByYear.get(year);
            return dynamicValue === undefined
                ? null
                : {
                    year,
                    cofechaMaster: cofechaValue,
                    dynamicReference: dynamicValue,
                    delta: dynamicValue - cofechaValue,
                    replication: replicationByYear.get(year) ?? null,
                };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);
    const pairs = rows.map((row) => [row.cofechaMaster, row.dynamicReference] as [number, number]);
    const correlation = calculatePearsonCorrelation(pairs);

    console.groupCollapsed("[COFECHA reference comparison]");
    console.info({
        overlapYears: pairs.length,
        pearsonR: correlation,
        cofechaMasterRange: summarizeSeriesRange(rows.map((row) => row.cofechaMaster)),
        dynamicReferenceRange: summarizeSeriesRange(rows.map((row) => row.dynamicReference)),
        cofechaMasterTotalPoints: cofechaMaster.size,
        dynamicReferenceTotalPoints: dynamicReference.points.length,
        includedSeries: dynamicReference.includedSeriesIds.length,
        candidateSeries: dynamicReference.candidateSeriesIds.length,
    });
    console.table(rows);
    console.groupEnd();
};

export function useHomeWorkspace() {
    const rwlEditorRef = useRef<RwlEditor>(new RwlEditor(new Map()));
    const originalDataRef = useRef<RwlSiteData>(new Map());
    const filePathRef = useRef<string | null>(null);
    const selectedTreeRef = useRef(ALL_OPTION_VALUE);
    const saveQueueRef = useRef(createSerialTaskQueue());
    const cofechaQueueRef = useRef(createSerialTaskQueue());
    const cofechaRequestIdRef = useRef(0);
    const isFileLoadingRef = useRef(false);
    const workspaceEpochRef = useRef(0);
    const historyAnimationIdRef = useRef(0);
    const historyPersistTimerRef = useRef<number | null>(null);
    const diagnosisRequestIdRef = useRef(0);
    const diagnosisWorkerRef = useRef<Worker | null>(null);
    const diagnosisResultCacheRef = useRef<DiagnosisResultCache | null>(null);
    const referenceOperationCounterRef = useRef(0);
    // COFECHA .OUT 对应数据的签名 + 引擎版本。用于判断当前 .OUT 是否仍与编辑数据匹配（新鲜）。
    const lastCofechaValidationRef = useRef<{ inputSignature: string; version: CofechaVersion } | null>(null);
    const latestDiagnosisCandidatesRef = useRef<DiagnosisCandidateOperation[]>([]);
    const latestDynamicReferenceConfigRef = useRef<ReferenceSeriesConfig | null>(null);

    const [siteData, setSiteData] = useState<RwlSiteData>(() => rwlEditorRef.current.getData());
    const siteDataSignature = useMemo(() => hashRwlSiteData(siteData), [siteData]);
    const [deletionMarkers, setDeletionMarkers] = useState<RwlDeletionMarkers>(() => rwlEditorRef.current.getDeletionMarkers());
    const [operationLog, setOperationLog] = useState<RwlOperationLogEntry[]>(() => rwlEditorRef.current.getOperationLog());
    const [referenceConfig, setReferenceConfig] = useState<ReferenceSeriesConfig | null>(null);
    const [referenceOperationLog, setReferenceOperationLog] = useState<RwlOperationLogEntry[]>([]);
    const [historyStatus, setHistoryStatus] = useState<RwlHistoryStatus>(() => rwlEditorRef.current.getHistoryStatus());
    const [treeOptions, setTreeOptions] = useState<string[]>([]);
    const [selectedTree, setSelectedTree] = useState<string>(ALL_OPTION_VALUE);
    const [historyAnimation, setHistoryAnimation] = useState<WidthHistoryAnimation | null>(null);
    const [crossdatingDiagnosis, setCrossdatingDiagnosis] = useState<CrossdatingDiagnosis>(() => createEmptyCrossdatingDiagnosis());
    const markCurrentDiagnosisStale = useCallback(() => {
        setCrossdatingDiagnosis((previous) => {
            if (previous.candidates.length === 0 && previous.events.length === 0) {
                return previous;
            }

            const staleCandidates = markCandidatesStale(previous.candidates);
            const staleEvents = markDiagnosisEventsStale(previous.events);
            return {
                ...previous,
                candidateCount: staleCandidates.length,
                eventCount: staleEvents.length,
                candidates: staleCandidates,
                events: staleEvents,
            };
        });
    }, []);
    const [fileName, setFileName] = useState<string | null>(null);
    const [isModified, setIsModified] = useState(false);

    const [outFileContent, setOutFileContent] = useState("");
    const [cofechaResult, setCofechaResult] = useState<ICofechaResult>();
    const [possibleProblemsDetail, setPossibleProblemsDetail] = useState<Map<string, string>>(new Map());
    const [cofechaParts, setCofechaParts] = useState<Map<string, string>>(new Map());
    const [selectedPart, setSelectedPart] = useState<string>(ALL_OPTION_VALUE);
    // COFECHA 引擎是全局设置（运行菜单与设置窗口共享同一来源），不再随工作区局部保存。
    const { settings, updateCofechaSettings } = useSettings();
    const cofechaVersion = settings.cofecha.engine;
    const setCofechaVersion = useCallback((version: CofechaVersion) => {
        updateCofechaSettings({ engine: version });
    }, [updateCofechaSettings]);
    const [isFileLoading, setIsFileLoading] = useState(false);
    const [isCofechaRunning, setIsCofechaRunning] = useState(false);
    const [isEventDiagnosisRunning, setIsEventDiagnosisRunning] = useState(false);
    const [diagnosisBatchResult, setDiagnosisBatchResult] = useState<DiagnosisBatchApplyResult | null>(null);

    const [dynamicReferenceConfig, setDynamicReferenceConfig] = useState<ReferenceSeriesConfig | null>(null);
    const {
        session: currentEventRankerSession,
        models: currentEventModels,
        activeModelId: activeCurrentEventModelId,
        modelCatalogError: currentEventModelCatalogError,
        selectModel: selectCurrentEventModel,
        start: startCurrentEventRanker,
        confirmYear: confirmCurrentEventYear,
        undoLastConfirmation: undoCurrentEventConfirmation,
        retry: retryCurrentEventRanker,
        cancel: cancelCurrentEventRanker,
        markStale: markCurrentEventRankerStale,
        reset: resetCurrentEventRanker,
    } = useCurrentEventRanker({ enabled: CURRENT_EVENT_PYTHON_MODELS_ENABLED });

    useEffect(() => {
        if (dynamicReferenceConfig?.mode === "dynamic") {
            latestDynamicReferenceConfigRef.current = dynamicReferenceConfig;
        }
    }, [dynamicReferenceConfig]);

    useEffect(() => {
        selectedTreeRef.current = selectedTree;
    }, [selectedTree]);

    const scheduleHistorySnapshotPersist = useCallback((filePath: string, editor: RwlEditor) => {
        if (historyPersistTimerRef.current !== null) {
            window.clearTimeout(historyPersistTimerRef.current);
        }

        historyPersistTimerRef.current = window.setTimeout(() => {
            historyPersistTimerRef.current = null;
            persistHistorySnapshot(filePath, editor);
        }, HISTORY_SNAPSHOT_PERSIST_DELAY_MS);
    }, []);

    useEffect(() => () => {
        if (historyPersistTimerRef.current !== null) {
            window.clearTimeout(historyPersistTimerRef.current);
        }
    }, []);

    useEffect(() => () => {
        diagnosisWorkerRef.current?.terminate();
        diagnosisWorkerRef.current = null;
    }, []);

    const syncEditor = useCallback((editor: RwlEditor) => {
        editor.registerChangeCallback(() => {
            const nextData = editor.getData();
            setIsModified(!rwlDataEquals(originalDataRef.current, nextData));
            setSiteData(nextData);
            const nextTreeOptions = Array.from(nextData.keys());
            setTreeOptions((previous) => (
                stringArraysEqual(previous, nextTreeOptions) ? previous : nextTreeOptions
            ));
            setDeletionMarkers(editor.getDeletionMarkers());
            setOperationLog(editor.getOperationLog());
            setHistoryStatus(editor.getHistoryStatus());
            setDynamicReferenceConfig((previous) => (
                previous?.mode === "dynamic" && !previous.isStale
                    ? { ...previous, isStale: true }
                    : previous
            ));
            markCurrentEventRankerStale("工作区数据已修改；旧模型结果不再对应当前 RWL。");
            if (filePathRef.current) {
                scheduleHistorySnapshotPersist(filePathRef.current, editor);
            }
        });
    }, [markCurrentEventRankerStale, scheduleHistorySnapshotPersist]);

    useEffect(() => {
        syncEditor(rwlEditorRef.current);
    }, [syncEditor]);

    const triggerHistoryAnimation = useCallback((animation: RwlHistoryAnimation | null) => {
        if (!animation) {
            return;
        }

        historyAnimationIdRef.current += 1;
        setHistoryAnimation({
            ...animation,
            id: historyAnimationIdRef.current,
        });
    }, []);

    useEffect(() => {
        registerChangeYearWidth((tree, nextYear, width) => {
            rwlEditorRef.current.changeYearWidth(tree, nextYear, width);
        });
    }, []);

    useEffect(() => {
        if (selectedTree !== ALL_OPTION_VALUE && !treeOptions.includes(selectedTree)) {
            selectedTreeRef.current = ALL_OPTION_VALUE;
            setSelectedTree(ALL_OPTION_VALUE);
        }
    }, [selectedTree, treeOptions]);

    useEffect(() => {
        setReferenceConfig((previous) => {
            const normalized = normalizeReferenceSeriesConfig(previous, siteData);
            const manualOnly = normalized?.mode === "dynamic" ? null : normalized;
            if (JSON.stringify(previous) === JSON.stringify(manualOnly)) {
                return previous;
            }
            return manualOnly;
        });
        setDynamicReferenceConfig((previous) => {
            const normalized = normalizeReferenceSeriesConfig(previous, siteData);
            const dynamicOnly = normalized?.mode === "dynamic" ? normalized : null;
            if (JSON.stringify(previous) === JSON.stringify(dynamicOnly)) {
                return previous;
            }
            return dynamicOnly;
        });
    }, [siteData]);

    useEffect(() => {
        if (!filePathRef.current) return;
        persistReferenceState(
            filePathRef.current,
            referenceConfig,
            dynamicReferenceConfig,
            referenceOperationLog,
            referenceOperationCounterRef.current,
        );
    }, [dynamicReferenceConfig, referenceConfig, referenceOperationLog]);

    useEffect(() => {
        if (!filePathRef.current || (!outFileContent && !cofechaResult)) return;
        persistCofechaState(
            filePathRef.current,
            outFileContent,
            cofechaResult,
            cofechaVersion,
            selectedPart,
            lastCofechaValidationRef.current?.inputSignature,
        );
    }, [cofechaResult, cofechaVersion, outFileContent, selectedPart]);

    // savedBaseline：磁盘上真正保存的数据。恢复 localStorage 草稿后，工作数据可能与磁盘不一致，
    // 此时用磁盘数据当基线，让 isModified（标题的 *）如实反映"草稿未写盘"。不传则以工作数据为基线（视为已保存）。
    const replaceEditor = useCallback((
        nextEditor: RwlEditor,
        savedBaseline?: RwlSiteData,
        projectPath = filePathRef.current,
    ) => {
        nextEditor.setProjectId(projectPath);
        rwlEditorRef.current = nextEditor;
        syncEditor(nextEditor);
        const nextData = nextEditor.getData();
        const baseline = savedBaseline ?? nextData;
        originalDataRef.current = baseline;
        setSiteData(nextData);
        setDeletionMarkers(nextEditor.getDeletionMarkers());
        setOperationLog(nextEditor.getOperationLog());
        setHistoryStatus(nextEditor.getHistoryStatus());
        setHistoryAnimation(null);
        setCrossdatingDiagnosis(createEmptyCrossdatingDiagnosis());
        setIsModified(!rwlDataEquals(baseline, nextData));
    }, [syncEditor]);

    const runCofechaAndApplyResult = useCallback(async (
        input: string,
        sourcePath: string,
        options?: CofechaVersion | RunCofechaApplyOptions,
    ) => {
        const resolvedOptions = typeof options === "object" ? options : undefined;
        const version = typeof options === "string" ? options : options?.version ?? cofechaVersion;
        const selectedPartForPersistence = resolvedOptions?.selectedPart ?? selectedPart;
        const inputData = resolvedOptions?.inputData ?? rwlEditorRef.current.getData();
        const inputSignature = hashRwlSiteData(inputData);
        const workspaceGuard = resolvedOptions?.workspaceGuard;
        const requestId = ++cofechaRequestIdRef.current;

        setIsCofechaRunning(true);

        try {
            const baseName = sourcePath.split(/\\|\//).pop() || "INPUT.RWL";
            const nextOutText = await cofechaQueueRef.current.enqueue(async () => {
                if (requestId !== cofechaRequestIdRef.current) {
                    return null;
                }
                return runCofecha(input, baseName, sourcePath, version);
            });
            if (nextOutText === null) {
                return;
            }
            const nextResult = parseCofechaResult(nextOutText);
            const nextParts = splitReportByParts(nextOutText);
            const cofechaRunId = `cofecha-${Date.now()}`;
            const flaggedAIds = extractPart6FlaggedASeriesIds(nextParts.get("PART 6") ?? "");
            // Temporary experiment: drive automatic crossdating from COFECHA's
            // own PART 3 master dating series instead of our anchor-pass rebuild.
            const dynamicReferenceConfig = createCofechaMasterReferenceConfig({
                siteData: inputData,
                flaggedAIds,
                cofechaRunId,
                rwlHash: inputSignature,
                masterDatingSeries: nextResult.masterDatingSeries,
            });
            logCofechaReferenceComparison(nextResult.masterDatingSeries, dynamicReferenceConfig);

            const isLatestRequest = requestId === cofechaRequestIdRef.current;
            const matchesWorkspace = !workspaceGuard || (
                rwlEditorRef.current === workspaceGuard.editor
                && filePathRef.current === workspaceGuard.filePath
                && hashRwlSiteData(rwlEditorRef.current.getData()) === workspaceGuard.inputHash
            );
            if (!isLatestRequest || !matchesWorkspace) {
                return;
            }
            lastCofechaValidationRef.current = {
                inputSignature,
                version,
            };
            latestDynamicReferenceConfigRef.current = dynamicReferenceConfig;
            setDynamicReferenceConfig(dynamicReferenceConfig);
            setOutFileContent(nextOutText);
            setCofechaResult(nextResult);
            setPossibleProblemsDetail(nextResult.possibleProblemsDetail);
            setCofechaParts(nextParts);
            persistCofechaState(
                sourcePath,
                nextOutText,
                nextResult,
                version,
                selectedPartForPersistence,
                inputSignature,
            );
        } finally {
            if (requestId === cofechaRequestIdRef.current) {
                setIsCofechaRunning(false);
            }
        }
    }, [cofechaVersion, selectedPart]);

    const handleLoad = useCallback(async () => {
        if (isFileLoadingRef.current) {
            return;
        }
        isFileLoadingRef.current = true;
        try {
            const filePath = await open({
                filters: [
                    { name: "Tucson Files", extensions: ["rwl"] },
                    { name: "所有文件", extensions: ["*"] },
                ],
                multiple: false,
            });

            if (!filePath) {
                return;
            }

            setIsFileLoading(true);
            workspaceEpochRef.current += 1;
            cofechaRequestIdRef.current += 1;
            setIsCofechaRunning(false);
            resetCurrentEventRanker();

            const rwlData = await readRwlFile(filePath);
            let nextEditor = new RwlEditor(rwlData.data, rwlData.readOptions, rwlData.format);
            // 在恢复草稿前抓取磁盘内容快照，作为"已保存基线"。
            const diskBaseline = nextEditor.getData();
            const persistedReference = loadPersistedReferenceState(filePath);
            const persistedCofecha = loadPersistedCofechaState(filePath);

            // 恢复本地缓存草稿（操作日志快照）。草稿可能因未保存的编辑、或磁盘文件被外部
            // 改动而与磁盘内容不一致；不一致时弹框让用户选择载入哪一个，而不是默默套用草稿。
            const persistedHistory = loadPersistedHistorySnapshot(filePath);
            if (persistedHistory) {
                nextEditor.restorePersistedHistory(persistedHistory);
                if (!rwlDataEquals(diskBaseline, nextEditor.getData())) {
                    const baseName = filePath.split(/\\|\//).pop() || filePath;
                    const keepCachedDraft = await ask(
                        `“${baseName}” 存在未保存的本地编辑缓存，且与磁盘文件内容不一致。\n\n要载入哪一个版本？`,
                        {
                            title: "本地缓存与磁盘文件不一致",
                            kind: "warning",
                            okLabel: "本地缓存（保留未保存的编辑）",
                            cancelLabel: "磁盘文件（放弃缓存）",
                        },
                    );
                    if (!keepCachedDraft) {
                        // 放弃草稿：用磁盘内容重建编辑器（保留原始格式/读取选项），不恢复历史。
                        nextEditor = new RwlEditor(rwlData.data, rwlData.readOptions, rwlData.format);
                    }
                }
            }
            replaceEditor(nextEditor, diskBaseline, filePath);
            filePathRef.current = filePath;
            const restoredReferenceConfig = normalizeReferenceSeriesConfig(
                persistedReference?.referenceConfig ?? null,
                nextEditor.getData(),
            );
            const restoredDynamicReferenceConfig = normalizeReferenceSeriesConfig(
                persistedReference?.dynamicReferenceConfig
                    ?? (restoredReferenceConfig?.mode === "dynamic" ? restoredReferenceConfig : null),
                nextEditor.getData(),
            );
            const manualReferenceConfig = restoredReferenceConfig?.mode === "dynamic"
                ? null
                : restoredReferenceConfig;
            const dynamicReferenceConfig = restoredDynamicReferenceConfig?.mode === "dynamic"
                ? restoredDynamicReferenceConfig
                : null;
            setReferenceConfig(manualReferenceConfig);
            setDynamicReferenceConfig(dynamicReferenceConfig);
            latestDynamicReferenceConfigRef.current = dynamicReferenceConfig;
            setReferenceOperationLog((persistedReference?.referenceOperationLog ?? []).map((entry) => (
                normalizeWorkspaceOperationLogEntry(entry, filePath)
            )));
            referenceOperationCounterRef.current = persistedReference?.referenceOperationCounter
                ?? Math.max(...(persistedReference?.referenceOperationLog ?? []).map((entry) => entry.sequence), 0);
            lastCofechaValidationRef.current = null;
            // 引擎为全局设置，载入工作区时不再覆盖；沿用当前设置中的引擎重新运行。
            let restoredSelectedPart = ALL_OPTION_VALUE;
            if (persistedCofecha) {
                const restoredResult = persistedCofecha.cofechaResult
                    ? deserializeCofechaResult(persistedCofecha.cofechaResult)
                    : undefined;
                restoredSelectedPart = persistedCofecha.selectedPart || ALL_OPTION_VALUE;
                setOutFileContent(persistedCofecha.outFileContent);
                setCofechaResult(restoredResult);
                setPossibleProblemsDetail(restoredResult?.possibleProblemsDetail ?? new Map());
                setCofechaParts(splitReportByParts(persistedCofecha.outFileContent));
                setSelectedPart(restoredSelectedPart);
                // 恢复 .OUT 对应数据的签名：使打开已定年文件时，若 .OUT 仍匹配当前数据，
                // 诊断可立即用上 COFECHA（无需先重跑一次）。
                if (persistedCofecha.cofechaInputSignature) {
                    lastCofechaValidationRef.current = {
                        inputSignature: persistedCofecha.cofechaInputSignature,
                        version: persistedCofecha.cofechaVersion,
                    };
                }
            } else {
                setOutFileContent("");
                setCofechaResult(undefined);
                setPossibleProblemsDetail(new Map());
                setCofechaParts(new Map());
            }
            setTreeOptions(Array.from(nextEditor.getData().keys()));
            selectedTreeRef.current = ALL_OPTION_VALUE;
            setSelectedTree(ALL_OPTION_VALUE);
            setFileName(filePath);
            setDiagnosisBatchResult(null);

            try {
                const loadedData = nextEditor.getData();
                const loadedHash = hashRwlSiteData(loadedData);
                await runCofechaAndApplyResult(nextEditor.exportAsRwlString(), filePath, {
                    selectedPart: restoredSelectedPart,
                    inputData: loadedData,
                    workspaceGuard: {
                        editor: nextEditor,
                        filePath,
                        inputHash: loadedHash,
                    },
                });
            } catch (error) {
                console.error("cofecha 执行失败", error);
            }
        } catch (error) {
            console.error("读取文件时出错:", error);
        } finally {
            isFileLoadingRef.current = false;
            setIsFileLoading(false);
        }
    }, [replaceEditor, resetCurrentEventRanker, runCofechaAndApplyResult]);

    const enqueueSave = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
        return saveQueueRef.current.enqueue(operation);
    }, []);

    const markDataSnapshotAsSaved = useCallback((savedData: RwlSiteData) => {
        const currentData = rwlEditorRef.current.getData();
        const matchesSavedSnapshot = rwlDataEquals(savedData, currentData);
        originalDataRef.current = savedData;
        setSiteData(currentData);
        setIsModified(!matchesSavedSnapshot);
        if (!matchesSavedSnapshot) {
            markCurrentEventRankerStale(
                "保存期间工作区又发生了修改；磁盘已保存旧快照，请再次保存后重新分析。",
            );
        }
        return matchesSavedSnapshot;
    }, [markCurrentEventRankerStale]);

    const runCurrentEventRankerForSavedFile = useCallback((
        filePath: string,
        seriesId: string,
        sourceHash: string,
        trigger: "after_save" | "manual",
    ) => {
        if (!CURRENT_EVENT_PYTHON_MODELS_ENABLED) return;
        if (!seriesId || seriesId === ALL_OPTION_VALUE) {
            resetCurrentEventRanker();
            return;
        }
        if (
            trigger === "after_save"
            && !shouldRunCurrentEventAfterSave(activeCurrentEventModelId, currentEventModels)
        ) {
            return;
        }
        startCurrentEventRanker({
            rwlPath: filePath,
            targetSeriesId: seriesId,
            sourceHash,
        });
    }, [
        activeCurrentEventModelId,
        currentEventModels,
        resetCurrentEventRanker,
        startCurrentEventRanker,
    ]);

    const getCurrentRwlText = useCallback((tree?: string) => (
        rwlEditorRef.current.exportAsRwlString(tree)
    ), []);

    const applyParsedRwlText = useCallback(async (rawText: string) => {
        stopMarker.value = await detectPrecision(rawText);
        const rwlData = await readRwlString(rawText);
        const nextTreeOptions = Array.from(rwlData.data.keys());

        rwlEditorRef.current.replaceAllData(rwlData.data, rwlData.readOptions, rwlData.format);
        setTreeOptions(nextTreeOptions);
        setSelectedTree((previous) => {
            const nextSelectedTree = previous !== ALL_OPTION_VALUE && !nextTreeOptions.includes(previous)
                ? ALL_OPTION_VALUE
                : previous;
            selectedTreeRef.current = nextSelectedTree;
            return nextSelectedTree;
        });

        return rwlData;
    }, []);

    const applyRawRwlText = useCallback(async (rawText: string): Promise<RwlSiteData> => {
        const rwlData = await applyParsedRwlText(rawText);
        return rwlData.data;
    }, [applyParsedRwlText]);

    // 单序列文本编辑：只解析这段文本并把结果合并回指定序列，其余序列保持不变。
    const applyRawRwlTextForTree = useCallback(async (rawText: string, tree: string): Promise<RwlSiteData> => {
        const rwlData = await readRwlString(rawText);
        const parsedTreeData = rwlData.data.get(tree) ?? rwlData.data.values().next().value;
        if (parsedTreeData) {
            rwlEditorRef.current.replaceTreeData(tree, parsedTreeData);
        }
        return rwlEditorRef.current.getData();
    }, []);

    const handleSave = useCallback(async () => {
        if (isFileLoadingRef.current) {
            return;
        }
        const filePath = filePathRef.current;
        if (!filePath) {
            console.log("请先打开一个文件");
            return;
        }

        try {
            const editor = rwlEditorRef.current;
            const rwlString = editor.exportAsRwlString();
            const savedData = editor.getData();
            const sourceHash = hashRwlSiteData(savedData);
            const targetSeriesId = selectedTreeRef.current;
            const workspaceEpoch = workspaceEpochRef.current;
            const matchesSavedSnapshot = await enqueueSave(async () => {
                await saveFile(filePath, rwlString);
                if (
                    workspaceEpochRef.current !== workspaceEpoch
                    || rwlEditorRef.current !== editor
                    || filePathRef.current !== filePath
                ) {
                    return false;
                }
                return markDataSnapshotAsSaved(savedData);
            });
            if (!matchesSavedSnapshot) {
                return;
            }
            if (selectedTreeRef.current === targetSeriesId) {
                runCurrentEventRankerForSavedFile(filePath, targetSeriesId, sourceHash, "after_save");
            }

            try {
                await runCofechaAndApplyResult(rwlString, filePath, {
                    inputData: savedData,
                    workspaceGuard: {
                        editor,
                        filePath,
                        inputHash: sourceHash,
                    },
                });
            } catch (error) {
                console.error("cofecha 执行失败", error);
            }
        } catch (error) {
            console.error("写入文件时出错:", error);
        }
    }, [enqueueSave, markDataSnapshotAsSaved, runCofechaAndApplyResult, runCurrentEventRankerForSavedFile]);

    const handleRunCofechaValidation = useCallback(async () => {
        const filePath = filePathRef.current;
        if (!filePath || isCofechaRunning || isFileLoadingRef.current) {
            return;
        }

        try {
            const editor = rwlEditorRef.current;
            const inputData = editor.getData();
            const inputHash = hashRwlSiteData(inputData);
            await runCofechaAndApplyResult(
                editor.exportAsRwlString(),
                filePath,
                {
                    version: cofechaVersion,
                    inputData,
                    workspaceGuard: {
                        editor,
                        filePath,
                        inputHash,
                    },
                },
            );
        } catch (error) {
            console.error("cofecha 执行失败", error);
        }
    }, [cofechaVersion, isCofechaRunning, runCofechaAndApplyResult]);

    const handleSaveRawText = useCallback(async (rawText: string) => {
        if (isFileLoadingRef.current) {
            return;
        }
        const filePath = filePathRef.current;
        if (!filePath) {
            console.log("请先打开一个文件");
            return;
        }

        try {
            await applyParsedRwlText(rawText);
            const editor = rwlEditorRef.current;
            const savedData = editor.getData();
            const sourceHash = hashRwlSiteData(savedData);
            const targetSeriesId = selectedTreeRef.current;
            const workspaceEpoch = workspaceEpochRef.current;
            const matchesSavedSnapshot = await enqueueSave(async () => {
                await saveFile(filePath, rawText);
                if (
                    workspaceEpochRef.current !== workspaceEpoch
                    || rwlEditorRef.current !== editor
                    || filePathRef.current !== filePath
                ) {
                    return false;
                }
                return markDataSnapshotAsSaved(savedData);
            });
            if (!matchesSavedSnapshot) {
                return;
            }
            if (selectedTreeRef.current === targetSeriesId) {
                runCurrentEventRankerForSavedFile(filePath, targetSeriesId, sourceHash, "after_save");
            }

            try {
                await runCofechaAndApplyResult(rawText, filePath, {
                    inputData: savedData,
                    workspaceGuard: {
                        editor,
                        filePath,
                        inputHash: sourceHash,
                    },
                });
            } catch (error) {
                console.error("cofecha 执行失败", error);
            }
        } catch (error) {
            console.error("写入文本编辑内容时出错:", error);
            throw error;
        }
    }, [applyParsedRwlText, enqueueSave, markDataSnapshotAsSaved, runCofechaAndApplyResult, runCurrentEventRankerForSavedFile]);

    const handleSaveAs = useCallback(async () => {
        if (isFileLoadingRef.current) {
            return;
        }
        if (!filePathRef.current) {
            console.log("请先打开一个文件");
            return;
        }

        try {
            const filePathToSave = await save({
                filters: [{ name: "Tucson Files", extensions: ["rwl"] }],
            });

            if (!filePathToSave) {
                return;
            }
            if (isFileLoadingRef.current) {
                return;
            }

            const sourcePath = filePathRef.current;
            const editor = rwlEditorRef.current;
            const rwlString = editor.exportAsRwlString();
            const savedData = editor.getData();
            const sourceHash = hashRwlSiteData(savedData);
            const targetSeriesId = selectedTreeRef.current;
            const workspaceEpoch = workspaceEpochRef.current;
            const matchesSavedSnapshot = await enqueueSave(async () => {
                await saveFile(filePathToSave, rwlString);
                if (
                    workspaceEpochRef.current !== workspaceEpoch
                    || rwlEditorRef.current !== editor
                    || filePathRef.current !== sourcePath
                ) {
                    return false;
                }
                workspaceEpochRef.current += 1;
                filePathRef.current = filePathToSave;
                setFileName(filePathToSave);
                editor.setProjectId(filePathToSave);
                editor.commitCurrentDataAsRawBaseline(savedData);
                persistHistorySnapshot(filePathToSave, editor);
                persistReferenceState(
                    filePathToSave,
                    referenceConfig,
                    dynamicReferenceConfig,
                    referenceOperationLog,
                    referenceOperationCounterRef.current,
                );
                resetCurrentEventRanker();
                return markDataSnapshotAsSaved(savedData);
            });
            if (!matchesSavedSnapshot) {
                return;
            }
            if (selectedTreeRef.current === targetSeriesId) {
                runCurrentEventRankerForSavedFile(filePathToSave, targetSeriesId, sourceHash, "after_save");
            }

            try {
                await runCofechaAndApplyResult(rwlString, filePathToSave, {
                    inputData: savedData,
                    workspaceGuard: {
                        editor,
                        filePath: filePathToSave,
                        inputHash: sourceHash,
                    },
                });
            } catch (error) {
                console.error("cofecha 执行失败", error);
            }
        } catch (error) {
            console.error("写入文件时出错:", error);
        }
    }, [dynamicReferenceConfig, enqueueSave, markDataSnapshotAsSaved, referenceConfig, referenceOperationLog, resetCurrentEventRanker, runCofechaAndApplyResult, runCurrentEventRankerForSavedFile]);

    const handleSaveRawTextAs = useCallback(async (rawText: string) => {
        if (isFileLoadingRef.current) {
            return;
        }
        if (!filePathRef.current) {
            console.log("请先打开一个文件");
            return;
        }

        try {
            const filePathToSave = await save({
                filters: [{ name: "Tucson Files", extensions: ["rwl"] }],
            });

            if (!filePathToSave) {
                return;
            }
            if (isFileLoadingRef.current) {
                return;
            }

            await applyParsedRwlText(rawText);
            const sourcePath = filePathRef.current;
            const editor = rwlEditorRef.current;
            const savedData = editor.getData();
            const sourceHash = hashRwlSiteData(savedData);
            const targetSeriesId = selectedTreeRef.current;
            const workspaceEpoch = workspaceEpochRef.current;
            const matchesSavedSnapshot = await enqueueSave(async () => {
                await saveFile(filePathToSave, rawText);
                if (
                    workspaceEpochRef.current !== workspaceEpoch
                    || rwlEditorRef.current !== editor
                    || filePathRef.current !== sourcePath
                ) {
                    return false;
                }
                workspaceEpochRef.current += 1;
                filePathRef.current = filePathToSave;
                setFileName(filePathToSave);
                editor.setProjectId(filePathToSave);
                editor.commitCurrentDataAsRawBaseline(savedData);
                persistHistorySnapshot(filePathToSave, editor);
                persistReferenceState(
                    filePathToSave,
                    referenceConfig,
                    dynamicReferenceConfig,
                    referenceOperationLog,
                    referenceOperationCounterRef.current,
                );
                resetCurrentEventRanker();
                return markDataSnapshotAsSaved(savedData);
            });
            if (!matchesSavedSnapshot) {
                return;
            }
            if (selectedTreeRef.current === targetSeriesId) {
                runCurrentEventRankerForSavedFile(filePathToSave, targetSeriesId, sourceHash, "after_save");
            }

            try {
                await runCofechaAndApplyResult(rawText, filePathToSave, {
                    inputData: savedData,
                    workspaceGuard: {
                        editor,
                        filePath: filePathToSave,
                        inputHash: sourceHash,
                    },
                });
            } catch (error) {
                console.error("cofecha 执行失败", error);
            }
        } catch (error) {
            console.error("写入文本编辑内容时出错:", error);
            throw error;
        }
    }, [applyParsedRwlText, dynamicReferenceConfig, enqueueSave, markDataSnapshotAsSaved, referenceConfig, referenceOperationLog, resetCurrentEventRanker, runCofechaAndApplyResult, runCurrentEventRankerForSavedFile]);

    const handleUndo = useCallback(() => {
        triggerHistoryAnimation(rwlEditorRef.current.undo());
    }, [triggerHistoryAnimation]);

    const handleRedo = useCallback(() => {
        triggerHistoryAnimation(rwlEditorRef.current.redo());
    }, [triggerHistoryAnimation]);

    const handleUndoOperationLogEntry = useCallback((entryId: string) => {
        triggerHistoryAnimation(rwlEditorRef.current.undoOperationLogEntry(entryId));
    }, [triggerHistoryAnimation]);

    const handleResetToRawData = useCallback(() => {
        triggerHistoryAnimation(rwlEditorRef.current.resetToRawData());
    }, [triggerHistoryAnimation]);

    const handleInsertMissingYearAtSide = useCallback((tree: string, nextYear: number, side: "left" | "right") => {
        rwlEditorRef.current.insertMissingYearAtSide(tree, nextYear, side);
    }, []);

    const handleMoveSeriesTailByOffset = useCallback((tree: string, selectedStartYear: number, selectedEndYear: number, yearOffset: number) => {
        try {
            rwlEditorRef.current.moveSeriesTailByOffset(
                tree,
                selectedStartYear,
                selectedEndYear,
                yearOffset,
            );
        } catch (error) {
            if (error instanceof RwlMoveConflictError) {
                window.alert(error.message);
                return;
            }
            throw error;
        }
    }, []);

    const applyDiagnosisCandidate = useCallback((candidate: DiagnosisCandidateOperation, batchId?: string, batchIndex?: number) => {
        if (candidate.operationType === "MARK_SUSPICIOUS") {
            return false;
        }

        const logMetadata = {
            operationType: "APPLY_SUGGESTION",
            source: "auto-suggested" as const,
            reason: candidate.reason,
            batchId,
            targetIndex: batchIndex,
            metricsBefore: {
                localCorrelation: candidate.currentCorrelation,
                segmentStartYear: candidate.segmentStartYear,
                segmentEndYear: candidate.segmentEndYear,
                candidateYear: candidate.targetYear ?? null,
            },
            metricsAfter: {
                expectedCorrelation: candidate.expectedCorrelation,
                delta: candidate.delta ?? null,
                suggestedLag: candidate.suggestedLag,
                confidence: candidate.confidence,
                operation: candidate.operationType,
            },
        };

        if (candidate.operationType === "SHIFT_RANGE") {
            const shift = candidate.deltaYears ?? candidate.shift ?? candidate.suggestedLag;
            if (shift === 0) return false;
            if (candidate.mode === "partialRangeMove"
                && !isNegativePartialShift(shift)) return false;
            const selectedRange = candidate.selectedRange ?? {
                startYear: candidate.targetYear ?? candidate.segmentStartYear,
                endYear: candidate.segmentEndYear,
            };
            rwlEditorRef.current.moveSeriesTailByOffset(
                candidate.targetTree,
                selectedRange.startYear,
                selectedRange.endYear,
                shift,
                logMetadata,
            );
            triggerHistoryAnimation({
                type: "move-selection",
                tree: candidate.targetTree,
                selectedStartYear: selectedRange.startYear,
                selectedEndYear: selectedRange.endYear,
                yearOffset: shift,
                direction: "redo",
            });
            return true;
        }

        if (candidate.operationType === "INSERT_MISSING_RING" && candidate.targetYear !== undefined && candidate.side) {
            rwlEditorRef.current.insertMissingYearAtSide(
                candidate.targetTree,
                candidate.targetYear,
                candidate.side,
                logMetadata,
            );
            triggerHistoryAnimation({
                type: "insert-missing",
                tree: candidate.targetTree,
                year: candidate.targetYear,
                side: candidate.side,
                direction: "redo",
            });
            return true;
        }

        if (candidate.operationType === "DELETE_FALSE_RING" && candidate.targetYear !== undefined && candidate.side) {
            rwlEditorRef.current.deleteYearWithMode(
                candidate.targetTree,
                candidate.targetYear,
                "direct",
                candidate.side,
                logMetadata,
            );
            triggerHistoryAnimation({
                type: "delete-year",
                tree: candidate.targetTree,
                year: candidate.targetYear,
                mode: "direct",
                shift: candidate.side,
                direction: "redo",
            });
            return true;
        }

        return false;
    }, [triggerHistoryAnimation]);

    const handleApplyDiagnosisCandidate = useCallback((candidate: DiagnosisCandidateOperation) => {
        const applied = applyDiagnosisCandidate(candidate);
        const staleCandidates = markCandidatesStale(latestDiagnosisCandidatesRef.current);

        if (applied) {
            markCurrentDiagnosisStale();
        }

        setDiagnosisBatchResult({
            batchId: `single-suggestion-${Date.now()}`,
            createdAt: new Date().toISOString(),
            requestedCount: 1,
            appliedCount: applied ? 1 : 0,
            skippedCount: applied ? 0 : 1,
            failedCount: 0,
            results: [{
                candidateId: candidate.id,
                targetTree: candidate.targetTree,
                label: getDiagnosisCandidateLabel(candidate),
                status: applied ? "applied" : "skipped",
                reason: applied
                    ? `已应用；${staleCandidates.length} 个旧候选在内存中标记为 stale，诊断会随当前工作序列重新计算。`
                    : "当前候选未产生可应用编辑。",
            }],
        });
    }, [applyDiagnosisCandidate, markCurrentDiagnosisStale]);

    const handleApplyDiagnosisEvent = useCallback((event: DiagnosisEvent, selectedYear: number) => {
        if (event.stale) return false;
        if (event.eventType === "wholeSeriesMove") {
            const candidate = latestDiagnosisCandidatesRef.current.find((item) => (
                event.evidence.candidateIds.includes(item.id)
                && item.operationType === "SHIFT_RANGE"
                && item.mode === "wholeSeriesMove"
            ));
            const applied = candidate ? applyDiagnosisCandidate(candidate) : false;
            if (applied) markCurrentDiagnosisStale();
            return applied;
        }

        const treeData = rwlEditorRef.current.getData().get(event.seriesId);
        if (!treeData) return false;
        const editableYears = Array.from(treeData.entries())
            .filter(([, value]) => value !== stopMarker.value)
            .map(([year]) => year);
        if (editableYears.length === 0) return false;
        const plan = planDiagnosisEventEdit(
            event,
            selectedYear,
            Math.min(...editableYears),
            Math.max(...editableYears),
        );
        if (!plan) return false;

        const selectedRank = event.rankedYears.find((row) => row.year === selectedYear)?.rank ?? null;
        const logMetadata = {
            operationType: "APPLY_SUGGESTION",
            source: "auto-suggested" as const,
            reason: `事件级诊断 ${event.eventType}；用户选择年份 ${selectedYear}`,
            metricsBefore: {
                eventId: event.id,
                eventStartYear: event.startYear,
                eventEndYear: event.endYear,
                selectedYear,
                selectedRank,
                ...(plan.operationType === "SHIFT_RANGE" ? {
                    firstFixedYear: plan.firstFixedYear,
                    lastMovedYear: plan.lastMovedYear,
                    movedRange: `${plan.startYear}-${plan.endYear}`,
                } : {}),
                confidence: event.confidenceLevel,
                score: event.evidence.score,
            },
            metricsAfter: {
                operation: plan.operationType,
                shiftYears: plan.operationType === "SHIFT_RANGE" ? plan.shiftYears : null,
                shiftSide: event.shiftSide ?? "older",
                ...(plan.operationType === "SHIFT_RANGE" ? {
                    fixedRange: `${plan.firstFixedYear}-${Math.max(...editableYears)}`,
                    missingRange:
                        `${plan.missingRange.startYear}-${plan.missingRange.endYear}`,
                } : {}),
            },
        };

        if (plan.operationType === "INSERT_MISSING_RING") {
            if (!treeData.has(plan.targetYear)) return false;
            rwlEditorRef.current.insertMissingYearAtSide(
                plan.targetTree,
                plan.targetYear,
                plan.side,
                logMetadata,
            );
            triggerHistoryAnimation({
                type: "insert-missing",
                tree: plan.targetTree,
                year: plan.targetYear,
                side: plan.side,
                direction: "redo",
            });
        } else if (plan.operationType === "DELETE_FALSE_RING") {
            rwlEditorRef.current.deleteYearWithMode(
                plan.targetTree,
                plan.targetYear,
                "direct",
                plan.shift,
                logMetadata,
            );
            triggerHistoryAnimation({
                type: "delete-year",
                tree: plan.targetTree,
                year: plan.targetYear,
                mode: "direct",
                shift: plan.shift,
                direction: "redo",
            });
        } else {
            rwlEditorRef.current.moveSeriesTailByOffset(
                plan.targetTree,
                plan.startYear,
                plan.endYear,
                plan.shiftYears,
                logMetadata,
            );
            triggerHistoryAnimation({
                type: "move-selection",
                tree: plan.targetTree,
                selectedStartYear: plan.startYear,
                selectedEndYear: plan.endYear,
                yearOffset: plan.shiftYears,
                direction: "redo",
            });
        }
        markCurrentDiagnosisStale();
        return true;
    }, [applyDiagnosisCandidate, markCurrentDiagnosisStale, triggerHistoryAnimation]);

    const handleApplyDiagnosisCandidateBatch = useCallback((candidates: DiagnosisCandidateOperation[]): DiagnosisBatchApplyResult => {
        const batchId = `suggestion-batch-${Date.now()}-${candidates.length}`;
        const selection = selectSafeDiagnosisCandidateBatch(candidates);
        const appliedResults: DiagnosisBatchCandidateResult[] = selection.selected.map((candidate, index) => {

            try {
                const applied = applyDiagnosisCandidate(candidate, batchId, index + 1);
                return {
                    candidateId: candidate.id,
                    targetTree: candidate.targetTree,
                    label: getDiagnosisCandidateLabel(candidate),
                    status: applied ? "applied" : "skipped",
                    reason: applied ? undefined : "当前候选未产生可应用编辑，已跳过。",
                };
            } catch (error) {
                return {
                    candidateId: candidate.id,
                    targetTree: candidate.targetTree,
                    label: getDiagnosisCandidateLabel(candidate),
                    status: "failed",
                    reason: error instanceof Error ? error.message : String(error),
                };
            }
        });
        const results = [...appliedResults, ...selection.skipped];

        const nextResult: DiagnosisBatchApplyResult = {
            batchId,
            createdAt: new Date().toISOString(),
            requestedCount: candidates.length,
            appliedCount: results.filter((result) => result.status === "applied").length,
            skippedCount: results.filter((result) => result.status === "skipped").length,
            failedCount: results.filter((result) => result.status === "failed").length,
            results,
        };

        if (nextResult.appliedCount > 0) {
            markCurrentDiagnosisStale();
        }
        setDiagnosisBatchResult(nextResult);
        return nextResult;
    }, [applyDiagnosisCandidate, markCurrentDiagnosisStale]);

    const handleApplyLocalSimulation = useCallback((request: LocalSimulationApplyRequest) => {
        const { simulation, option } = request;
        if (option.operationType === "NO_ACTION") {
            return;
        }
        if (simulation.sourceEventId) {
            const sourceEvent = crossdatingDiagnosis?.events.find(
                (event) => event.id === simulation.sourceEventId && !event.stale,
            );
            if (sourceEvent) {
                handleApplyDiagnosisEvent(sourceEvent, simulation.year);
            }
            return;
        }

        const logMetadata = {
            operationType: "APPLY_SUGGESTION",
            source: "auto-suggested" as const,
            reason: option.reason,
            metricsBefore: {
                localCorrelation: option.currentCorrelation,
                segmentStartYear: simulation.segmentStartYear,
                segmentEndYear: simulation.segmentEndYear,
                selectedYear: simulation.year,
                displayYear: simulation.displayYear,
                selectedStartYear: simulation.selectedStartYear,
                selectedEndYear: simulation.selectedEndYear,
            },
            metricsAfter: {
                expectedCorrelation: option.simulatedCorrelation,
                delta: option.delta,
                confidence: option.confidence,
                operation: option.operationType,
            },
        };

        if (option.operationType === "INSERT_MISSING_RING" && option.side) {
            rwlEditorRef.current.insertMissingYearAtSide(
                simulation.targetTree,
                simulation.year,
                option.side,
                logMetadata,
            );
            triggerHistoryAnimation({
                type: "insert-missing",
                tree: simulation.targetTree,
                year: simulation.year,
                side: option.side,
                direction: "redo",
            });
            markCurrentDiagnosisStale();
            return;
        }

        if (option.operationType === "DELETE_FALSE_RING" && option.side) {
            rwlEditorRef.current.deleteYearWithMode(
                simulation.targetTree,
                simulation.year,
                "direct",
                option.side,
                logMetadata,
            );
            triggerHistoryAnimation({
                type: "delete-year",
                tree: simulation.targetTree,
                year: simulation.year,
                mode: "direct",
                shift: option.side,
                direction: "redo",
            });
            markCurrentDiagnosisStale();
            return;
        }

        if (option.operationType === "SHIFT_RANGE" && option.shift) {
            try {
                rwlEditorRef.current.moveSeriesTailByOffset(
                    simulation.targetTree,
                    simulation.selectedStartYear,
                    simulation.selectedEndYear,
                    option.shift,
                    logMetadata,
                );
            } catch (error) {
                if (error instanceof RwlMoveConflictError) {
                    window.alert(error.message);
                    return;
                }
                throw error;
            }
            triggerHistoryAnimation({
                type: "move-selection",
                tree: simulation.targetTree,
                selectedStartYear: simulation.selectedStartYear,
                selectedEndYear: simulation.selectedEndYear,
                yearOffset: option.shift,
                direction: "redo",
            });
            markCurrentDiagnosisStale();
        }
    }, [
        crossdatingDiagnosis,
        handleApplyDiagnosisEvent,
        markCurrentDiagnosisStale,
        triggerHistoryAnimation,
    ]);

    const handleDeleteYearWithMode = useCallback((tree: string, nextYear: number, mode: DeleteMode, shift: DeleteShift = "right") => {
        rwlEditorRef.current.deleteYearWithMode(tree, nextYear, mode, shift);
    }, []);

    const handleMarkYearRangeAsMissing = useCallback((tree: string, startYear: number, endYear: number) => {
        rwlEditorRef.current.markYearRangeAsMissing(tree, startYear, endYear);
    }, []);

    const handleRestoreDeletion = useCallback((tree: string, markerYear: number, index: number) => {
        rwlEditorRef.current.restoreDeletion(tree, markerYear, index);
    }, []);

    const handleDeleteSeries = useCallback((tree: string) => {
        rwlEditorRef.current.deleteSeries(tree);
    }, []);

    const handleReferenceConfigChange = useCallback((nextConfig: ReferenceSeriesConfig | null) => {
        const normalized = normalizeReferenceSeriesConfig(nextConfig, rwlEditorRef.current.getData());
        const manualOnly = normalized?.mode === "dynamic" ? null : normalized;
        referenceOperationCounterRef.current += 1;
        setReferenceConfig(manualOnly);
        setReferenceOperationLog((previous) => [
            ...previous,
            createReferenceOperationLogEntry(manualOnly, referenceOperationCounterRef.current, filePathRef.current),
        ].slice(-MAX_REFERENCE_OPERATION_LOG_ENTRIES));
    }, []);

    const handleResetReferenceToDynamic = useCallback(() => {
        const currentData = rwlEditorRef.current.getData();
        const currentHash = hashRwlSiteData(currentData);
        const latestDynamic = latestDynamicReferenceConfigRef.current;
        const nextDynamic = latestDynamic
            ? {
                ...latestDynamic,
                isStale: latestDynamic.isStale || latestDynamic.rwlHash !== currentHash,
            }
            : null;

        setDynamicReferenceConfig(nextDynamic);
        if (nextDynamic?.mode === "dynamic") {
            latestDynamicReferenceConfigRef.current = nextDynamic;
        }
    }, []);

    const handleReplaceTreeData = useCallback((tree: string, data: Map<number, number | null>) => {
        rwlEditorRef.current.replaceTreeData(tree, data);
    }, []);

 const handleApplyBayesianStartYear = useCallback((
        tree: string,
        startYear: number,
        result: BayesianMcmcDatingResult,
        candidate: BayesianDatingCandidate,
    ) => {
        const currentSeries = rwlEditorRef.current.getData().get(tree);
        if (!currentSeries) {
            return;
        }

        const oldYears = Array.from(currentSeries.keys()).sort((a, b) => a - b);
        const oldStartYear = oldYears[0];
        const newData = rebuildTreeDataFromStartYear(currentSeries, startYear);
        const best = candidate;
        const second = result.secondBest;

        rwlEditorRef.current.replaceTreeData(tree, newData, {
            operationType: "BAYESIAN_DATE_SERIES",
            source: "auto-suggested",
            reason: `Bayesian MCMC dating applied ${best.startYear}-${best.endYear} with posterior ${(best.posterior * 100).toFixed(1)}%.`,
            oldYear: oldStartYear,
            newYear: startYear,
            metricsBefore: {
                originalStartYear: oldStartYear ?? null,
                originalEndYear: oldYears[oldYears.length - 1] ?? null,
                targetLength: result.targetLength,
            },
            metricsAfter: {
                bestStartYear: best.startYear,
                bestEndYear: best.endYear,
                bestPosterior: best.posterior,
                secondStartYear: second?.startYear ?? null,
                secondPosterior: second?.posterior ?? null,
                hpd95Count: result.hpd95.length,
                candidateCount: result.candidateCount,
                overlap: best.overlap,
                correlation: best.correlation ?? null,
                tValue: best.tValue ?? null,
                decision: result.decision.status,
            },
        });
        triggerHistoryAnimation({
            type: "replace-tree-data",
            tree,
            direction: "redo",
        });
    }, [triggerHistoryAnimation]);

    const handleInsertMissingYearAtSideFromChart = useCallback((tree: string, nextYear: number, side: "left" | "right") => {
        rwlEditorRef.current.insertMissingYearAtSide(tree, nextYear, side);
        triggerHistoryAnimation({ type: "insert-missing", tree, year: nextYear, side, direction: "redo" });
    }, [triggerHistoryAnimation]);

    const handleDeleteYearWithModeFromChart = useCallback((tree: string, nextYear: number, mode: DeleteMode, shift: DeleteShift = "right") => {
        rwlEditorRef.current.deleteYearWithMode(tree, nextYear, mode, shift);
        triggerHistoryAnimation({ type: "delete-year", tree, year: nextYear, mode, shift, direction: "redo" });
    }, [triggerHistoryAnimation]);

    const handleRunCurrentEventRanker = useCallback(() => {
        if (
            !filePathRef.current
            || selectedTree === ALL_OPTION_VALUE
            || isModified
            || isFileLoadingRef.current
        ) {
            return;
        }
        runCurrentEventRankerForSavedFile(
            filePathRef.current,
            selectedTree,
            hashRwlSiteData(rwlEditorRef.current.getData()),
            "manual",
        );
    }, [isModified, runCurrentEventRankerForSavedFile, selectedTree]);

    const handleApplyCurrentEventConfirmedYears = useCallback(() => {
        const context = currentEventRankerSession.context;
        if (
            !context
            || context.rwlPath !== filePathRef.current
            || context.targetSeriesId !== selectedTree
            || currentEventRankerSession.confirmedYears.length === 0
            || currentEventRankerSession.status === "running"
            || currentEventRankerSession.status === "stale"
            || isFileLoadingRef.current
        ) {
            return;
        }

        const years = [...currentEventRankerSession.confirmedYears].sort((a, b) => b - a);
        const batchId = `current-event-${currentEventRankerSession.requestId ?? Date.now()}`;
        const isRrfRebuild = currentEventRankerSession.modelId === RRF_CURRENT_EVENT_MODEL_ID;
        let appliedCount = 0;
        let removedExistingZeroCount = 0;

        if (isRrfRebuild) {
            const currentTree = rwlEditorRef.current.getData().get(context.targetSeriesId);
            if (!currentTree) {
                return;
            }
            let rebuilt;
            try {
                rebuilt = rebuildCurrentEventRrfTree(currentTree, years);
            } catch (error) {
                console.warn("[current-event RRF] confirmed session cannot be rebuilt", error);
                return;
            }
            rwlEditorRef.current.replaceTreeData(
                context.targetSeriesId,
                rebuilt.data,
                {
                    operationType: "APPLY_CURRENT_EVENT_RRF_SESSION",
                    source: "auto-suggested",
                    reason: "Diagnostic-only 缺轮 RRF 会话由专家确认；先移除既有 0，再从新到旧重建确认年份",
                    batchId,
                    metricsBefore: {
                        existingZeroCount: rebuilt.removedExistingZeroYears.length,
                        confirmedRoundCount: currentEventRankerSession.confirmedYears.length,
                    },
                    metricsAfter: {
                        operation: "REBUILD_CONFIRMED_MISSING_RINGS",
                        existingZeroPolicy: "remove",
                        side: "right",
                        automaticWriteback: "false",
                    },
                },
            );
            triggerHistoryAnimation({
                type: "replace-tree-data",
                tree: context.targetSeriesId,
                direction: "redo",
            });
            removedExistingZeroCount = rebuilt.removedExistingZeroYears.length;
            appliedCount = rebuilt.confirmedYears.length;
        } else {
            years.forEach((year, index) => {
                const currentTree = rwlEditorRef.current.getData().get(context.targetSeriesId);
                if (!currentTree?.has(year) || currentTree.get(year) === 0) {
                    return;
                }
                rwlEditorRef.current.insertMissingYearAtSide(
                    context.targetSeriesId,
                    year,
                    "right",
                    {
                        operationType: "APPLY_SUGGESTION",
                        source: "auto-suggested",
                        reason: `Current-event V1 diagnostic-only 模型 ${currentEventRankerSession.modelId} 会话中由用户人工确认`,
                        batchId,
                        targetIndex: index + 1,
                        metricsBefore: {
                            candidateYear: year,
                            confirmedRoundCount: currentEventRankerSession.confirmedYears.length,
                        },
                        metricsAfter: {
                            operation: "INSERT_MISSING_RING",
                            side: "right",
                            automaticWriteback: "false",
                        },
                    },
                );
                appliedCount += 1;
                triggerHistoryAnimation({
                    type: "insert-missing",
                    tree: context.targetSeriesId,
                    year,
                    side: "right",
                    direction: "redo",
                });
            });
        }

        if (appliedCount > 0) {
            markCurrentEventRankerStale(
                isRrfRebuild
                    ? `已移除 ${removedExistingZeroCount} 个既有 0，并从新到旧重建 ${appliedCount} 个人工确认年份；请检查后保存。`
                    : `已把 ${appliedCount} 个人工确认年份应用到工作区；请检查后保存，模型不会自动写盘。`,
            );
        }
    }, [
        currentEventRankerSession,
        markCurrentEventRankerStale,
        selectedTree,
        triggerHistoryAnimation,
    ]);

    const handleTreeSelectionChange = useCallback((nextTree: string) => {
        if (nextTree !== selectedTree) {
            resetCurrentEventRanker();
        }
        selectedTreeRef.current = nextTree;
        setSelectedTree(nextTree);
    }, [resetCurrentEventRanker, selectedTree]);

    const selectedProblemText = possibleProblemsDetail.get(selectedTree);
    const workspaceOperationLog = useMemo(() => (
        operationLog
            .map((entry) => normalizeWorkspaceOperationLogEntry(entry, filePathRef.current))
            .sort((a, b) => (
                new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            ))
    ), [fileName, operationLog]);
    useEffect(() => {
        let cancelled = false;
        let startTimer: number | null = null;
        let workerForRequest: Worker | null = null;
        const requestId = ++diagnosisRequestIdRef.current;
        const targetTree = selectedTree !== ALL_OPTION_VALUE && siteData.has(selectedTree)
            ? selectedTree
            : null;

        if (!targetTree) {
            diagnosisWorkerRef.current?.terminate();
            diagnosisWorkerRef.current = null;
            setIsEventDiagnosisRunning(false);
            startTransition(() => setCrossdatingDiagnosis(createEmptyCrossdatingDiagnosis()));
            return undefined;
        }

        const lastValidation = lastCofechaValidationRef.current;
        const cofechaFresh = Boolean(outFileContent)
            && lastValidation !== null
            && lastValidation.inputSignature === siteDataSignature;
        const diagnosisCofechaText = cofechaFresh ? outFileContent : undefined;
        let resultCache = diagnosisResultCacheRef.current;
        if (resultCache?.siteData !== siteData
            || resultCache.referenceConfig !== dynamicReferenceConfig
            || resultCache.cofechaText !== diagnosisCofechaText) {
            resultCache = {
                siteData,
                referenceConfig: dynamicReferenceConfig,
                cofechaText: diagnosisCofechaText,
                results: new Map(),
            };
            diagnosisResultCacheRef.current = resultCache;
        }
        const cachedDiagnosis = resultCache.results.get(targetTree);
        if (cachedDiagnosis) {
            setIsEventDiagnosisRunning(false);
            startTransition(() => setCrossdatingDiagnosis(cachedDiagnosis));
            return undefined;
        }

        setIsEventDiagnosisRunning(true);
        startTransition(() => {
            markCurrentDiagnosisStale();
        });

        const runDiagnosis = () => {
            if (cancelled) return;

            // Vite cannot replace code inside an already-running module worker. Recreate it for
            // each development diagnosis so edits to the event engine are reflected immediately.
            if (import.meta.env.DEV && diagnosisWorkerRef.current) {
                diagnosisWorkerRef.current.terminate();
                diagnosisWorkerRef.current = null;
            }
            const worker = diagnosisWorkerRef.current
                ?? new Worker(new URL("./diagnosisWorker.ts", import.meta.url), { type: "module" });
            workerForRequest = worker;
            diagnosisWorkerRef.current = worker;

            worker.onmessage = (event: MessageEvent<DiagnosisWorkerResponse>) => {
                const response = event.data;
                if (
                    cancelled
                    || response.id !== diagnosisRequestIdRef.current
                    || diagnosisWorkerRef.current !== worker
                ) {
                    return;
                }

                workerForRequest = null;

                if ("error" in response) {
                    setIsEventDiagnosisRunning(false);
                    console.warn("内部诊断计算失败:", response.error);
                    return;
                }

                setIsEventDiagnosisRunning(false);
                console.info(`[JS 事件诊断] ${targetTree} · ${Math.round(response.elapsedMs)} ms`);
                resultCache.results.set(targetTree, response.diagnosis);
                startTransition(() => {
                    setCrossdatingDiagnosis(response.diagnosis);
                });
            };

            worker.onerror = (event) => {
                if (diagnosisWorkerRef.current === worker) {
                    worker.terminate();
                    diagnosisWorkerRef.current = null;
                    workerForRequest = null;
                }
                setIsEventDiagnosisRunning(false);
                console.warn("内部诊断 worker 运行失败:", event.message);
            };

            // COFECHA 新鲜度门控：仅当 .OUT 对应的输入与当前编辑数据一致时，才把 COFECHA 文本传给诊断
            // （驱动 [A] 段级 lag 候选）。编辑中、COFECHA 尚未重跑时不用过期的 .OUT，回退到内部诊断。
            worker.postMessage({
                id: requestId,
                siteData,
                referenceConfig: dynamicReferenceConfig,
                targetTree,
                cofechaText: diagnosisCofechaText,
            } satisfies DiagnosisWorkerRequest);
        };

        startTimer = window.setTimeout(() => {
            startTimer = null;
            // The expensive work runs in a dedicated worker, so an extra idle-callback wait only
            // adds visible latency without protecting the UI thread.
            runDiagnosis();
        }, DIAGNOSIS_DEBOUNCE_MS);

        return () => {
            cancelled = true;
            if (startTimer !== null) {
                window.clearTimeout(startTimer);
            }
            if (workerForRequest && diagnosisWorkerRef.current === workerForRequest) {
                workerForRequest.terminate();
                diagnosisWorkerRef.current = null;
            }
        };
        // outFileContent 加入依赖：COFECHA 重跑（保存后）更新 .OUT 时重新诊断，使 COFECHA 驱动候选与
        // 逐个（bark-to-pith）迭代工作流生效。
    }, [dynamicReferenceConfig, historyAnimation?.id, markCurrentDiagnosisStale, outFileContent, selectedTree, siteData, siteDataSignature]);

    useEffect(() => {
        latestDiagnosisCandidatesRef.current = crossdatingDiagnosis.candidates;
    }, [crossdatingDiagnosis.candidates]);
    const canResetToRawData = useMemo(() => (
        rwlEditorRef.current.hasRawDataChanges()
    ), [deletionMarkers, siteData]);
    const isCofechaOutdated = useMemo(() => {
        if (!cofechaResult) {
            return false;
        }

        const lastValidation = lastCofechaValidationRef.current;
        if (!lastValidation) {
            return true;
        }

        return lastValidation.version !== cofechaVersion
            || lastValidation.inputSignature !== siteDataSignature;
    }, [cofechaResult, cofechaVersion, deletionMarkers, siteData]);
    const crossdatingValidationSummary = useMemo(() => (
        buildCrossdatingValidationSummary({
            hasData: siteData.size > 0,
            isCofechaRunning,
            isCofechaOutdated,
            cofechaPossibleProblemsCount: cofechaResult?.possibleProblemsCount,
            cofechaProblemSeries: cofechaResult
                ? Array.from(cofechaResult.possibleProblemsDetail.keys()).sort()
                : [],
            internalProblemSegmentCount: crossdatingDiagnosis.problemSegmentCount,
            internalCandidateCount: crossdatingDiagnosis.candidateCount,
            batchResult: diagnosisBatchResult,
        })
    ), [cofechaResult, crossdatingDiagnosis, diagnosisBatchResult, isCofechaOutdated, isCofechaRunning, siteData]);
     const hasProblems = Boolean(selectedProblemText);
    const hasChart = siteData.size > 0;
    const shouldShowWelcome = !fileName && !isFileLoading;
    const shouldShowProcessing = isFileLoading || isCofechaRunning;
    const processingText = isFileLoading ? "正在读取并解析 RWL..." : "正在运行 COFECHA...";
    const problemTextColor = cofechaResult?.possibleProblemsCount !== undefined && cofechaResult.possibleProblemsCount >= 100
        ? "red"
        : "black";
    const reportText = selectedPart === ALL_OPTION_VALUE
        ? outFileContent
        : cofechaParts.get(selectedPart);
    const cofechaPart6Text = cofechaParts.get("PART 6");
    const windowTitle = formatTitle(fileName, isModified);

    return {
        cofechaResult,
        cofechaVersion,
        crossdatingValidationSummary,
        canResetToRawData,
        crossdatingDiagnosis,
        currentEventRankerSession,
        currentEventModels,
        activeCurrentEventModelId,
        currentEventModelCatalogError,
        deletionMarkers,
        diagnosisBatchResult,
        dynamicReferenceConfig,
        fileName,
        historyStatus,
        handleDeleteSeries,
        handleDeleteYearWithMode,
        handleDeleteYearWithModeFromChart,
        handleInsertMissingYearAtSide,
        handleInsertMissingYearAtSideFromChart,
        handleLoad,
        handleMarkYearRangeAsMissing,
        handleMoveSeriesTailByOffset,
        handleApplyDiagnosisCandidate,
        handleApplyDiagnosisCandidateBatch,
        handleApplyDiagnosisEvent,
        handleApplyCurrentEventConfirmedYears,
        handleApplyBayesianStartYear,
        handleApplyLocalSimulation,
        handleConfirmCurrentEventYear: confirmCurrentEventYear,
        handleReferenceConfigChange,
        handleResetReferenceToDynamic,
        handleRedo,
        handleReplaceTreeData,
        handleResetToRawData,
        handleRestoreDeletion,
        handleRunCofechaValidation,
        handleRunCurrentEventRanker,
        handleSaveRawText,
        handleSaveRawTextAs,
        handleSave,
        handleSaveAs,
        handleTreeSelectionChange,
        handleUndoCurrentEventConfirmation: undoCurrentEventConfirmation,
        handleUndo,
        handleUndoOperationLogEntry,
        applyRawRwlText,
        applyRawRwlTextForTree,
        getCurrentRwlText,
        hasChart,
        hasProblems,
        historyAnimation,
        isCofechaOutdated,
        isCofechaRunning,
        isEventDiagnosisRunning,
        isFileLoading,
        isModified,
        operationLog: workspaceOperationLog,
        possibleProblemsDetail,
        problemTextColor,
        referenceConfig,
        processingText,
        reportText,
        cofechaPart6Text,
        selectedPart,
        selectedProblemText,
        selectedTree,
        setCofechaVersion,
        setSelectedPart,
        selectCurrentEventModel,
        cancelCurrentEventRanker,
        retryCurrentEventRanker,
        shouldShowProcessing,
        shouldShowWelcome,
        siteData,
        treeOptions,
        windowTitle,
    };
}
