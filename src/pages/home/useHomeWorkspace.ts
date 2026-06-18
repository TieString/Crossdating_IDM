import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseCofechaResult, splitReportByParts } from "@/features/cofecha/formatter";
import {
    type CrossdatingDiagnosis,
    getDiagnosisCandidateLabel,
    markCandidatesStale,
    selectSafeDiagnosisCandidateBatch,
    type DiagnosisBatchApplyResult,
    type DiagnosisBatchCandidateResult,
    type DiagnosisCandidateOperation,
    type LocalSimulationApplyRequest,
} from "@/features/crossdating/diagnosis";
import { buildCrossdatingValidationSummary } from "@/features/crossdating/validation";
import { normalizeReferenceSeriesConfig, type ReferenceSeriesConfig } from "@/features/crossdating/reference";
import type { ICofechaResult } from "@/features/cofecha/types";
import { detectPrecision, readRwlString } from "@/features/rwl";
import { RwlEditor, registerChangeYearWidth } from "@/features/rwl/edit";
import type { DeleteMode, DeleteShift, RwlDeletionMarkers, RwlHistoryAnimation, RwlHistoryStatus, RwlOperationLogEntry, RwlPersistedHistorySnapshot } from "@/features/rwl/edit";
import type { RwlSiteData } from "@/features/rwl/types";
import { runCofecha } from "@/services/cofecha/runner";
import { readRwlFile, saveFile } from "@/services/fs/io";
import { stopMarker } from "@/shared/constants";
import { ALL_OPTION_VALUE, CofechaVersion, DEFAULT_HOME_TITLE } from "./constants";
import type { DiagnosisWorkerRequest, DiagnosisWorkerResponse } from "./diagnosisWorker";

export type WidthHistoryAnimation = RwlHistoryAnimation & { id: number };

const HISTORY_STORAGE_PREFIX = "crossdating:rwl-operation-journal:v1:";
const REFERENCE_STORAGE_PREFIX = "crossdating:reference-state:v1:";
const COFECHA_STORAGE_PREFIX = "crossdating:cofecha-state:v1:";
const MAX_REFERENCE_OPERATION_LOG_ENTRIES = 200;
const HISTORY_SNAPSHOT_PERSIST_DELAY_MS = 250;
const DIAGNOSIS_DEBOUNCE_MS = 120;

type PersistedReferenceState = {
    version: 1;
    savedAt: string;
    referenceConfig: ReferenceSeriesConfig | null;
    referenceOperationLog: RwlOperationLogEntry[];
    referenceOperationCounter: number;
};

type SerializedCofechaResult = Omit<ICofechaResult, "masterDatingSeries" | "masterCorrelations" | "seriesProblemCounts" | "possibleProblemsDetail"> & {
    masterDatingSeries: Array<[number, number]>;
    masterCorrelations: Array<[string, number]>;
    seriesProblemCounts: Array<[string, number]>;
    possibleProblemsDetail: Array<[string, string]>;
};

type PersistedCofechaState = {
    version: 1;
    savedAt: string;
    outFileContent: string;
    cofechaResult?: SerializedCofechaResult;
    cofechaVersion: CofechaVersion;
    selectedPart: string;
};

type RunCofechaApplyOptions = {
    version?: CofechaVersion;
    selectedPart?: string;
};

const formatTitle = (fileName: string | null, isModified: boolean) => (
    fileName ? `${fileName}${isModified ? " *" : ""}` : DEFAULT_HOME_TITLE
);

const rwlDataEquals = (a: RwlSiteData, b: RwlSiteData) => {
    if (a.size !== b.size) {
        return false;
    }

    for (const [tree, mapA] of a) {
        const mapB = b.get(tree);
        if (!mapB || mapA.size !== mapB.size) {
            return false;
        }

        for (const [year, widthA] of mapA) {
            if (widthA !== mapB.get(year)) {
                return false;
            }
        }
    }

    return true;
};

const stringArraysEqual = (a: string[], b: string[]) => (
    a.length === b.length && a.every((value, index) => value === b[index])
);

const getHistoryStorageKey = (filePath: string) => `${HISTORY_STORAGE_PREFIX}${filePath}`;
const getReferenceStorageKey = (filePath: string) => `${REFERENCE_STORAGE_PREFIX}${filePath}`;
const getCofechaStorageKey = (filePath: string) => `${COFECHA_STORAGE_PREFIX}${filePath}`;

const isPersistedReferenceState = (value: unknown): value is PersistedReferenceState => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<PersistedReferenceState>;
    return candidate.version === 1
        && Array.isArray(candidate.referenceOperationLog);
};

const isPersistedCofechaState = (value: unknown): value is PersistedCofechaState => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<PersistedCofechaState>;
    return candidate.version === 1
        && typeof candidate.outFileContent === "string";
};

const loadPersistedHistorySnapshot = (filePath: string): RwlPersistedHistorySnapshot | null => {
    try {
        const raw = window.localStorage.getItem(getHistoryStorageKey(filePath));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        return RwlEditor.isPersistedHistorySnapshot(parsed) ? parsed : null;
    } catch (error) {
        console.warn("读取操作日志失败:", error);
        return null;
    }
};

const persistHistorySnapshot = (filePath: string, editor: RwlEditor) => {
    try {
        window.localStorage.setItem(
            getHistoryStorageKey(filePath),
            JSON.stringify(editor.toHistorySnapshot()),
        );
    } catch (error) {
        console.warn("保存操作日志失败:", error);
    }
};

const createEmptyCrossdatingDiagnosis = (): CrossdatingDiagnosis => ({
    createdAt: new Date().toISOString(),
    seriesCount: 0,
    problemSegmentCount: 0,
    candidateCount: 0,
    segmentLength: 0,
    overlap: 0,
    lagRange: { min: 0, max: 0 },
    lowCorrelationThreshold: 0,
    summaries: [],
    segments: [],
    propagationPatterns: [],
    globalSlidingMatches: [],
    masterNarrowYears: [],
    candidates: [],
});

const loadPersistedReferenceState = (filePath: string): PersistedReferenceState | null => {
    try {
        const raw = window.localStorage.getItem(getReferenceStorageKey(filePath));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        return isPersistedReferenceState(parsed) ? parsed : null;
    } catch (error) {
        console.warn("读取参考序列状态失败:", error);
        return null;
    }
};

const persistReferenceState = (
    filePath: string,
    referenceConfig: ReferenceSeriesConfig | null,
    referenceOperationLog: RwlOperationLogEntry[],
    referenceOperationCounter: number,
) => {
    try {
        window.localStorage.setItem(
            getReferenceStorageKey(filePath),
            JSON.stringify({
                version: 1,
                savedAt: new Date().toISOString(),
                referenceConfig,
                referenceOperationLog,
                referenceOperationCounter,
            } satisfies PersistedReferenceState),
        );
    } catch (error) {
        console.warn("保存参考序列状态失败:", error);
    }
};

const serializeCofechaResult = (result: ICofechaResult): SerializedCofechaResult => ({
    ...result,
    masterDatingSeries: Array.from(result.masterDatingSeries.entries()),
    masterCorrelations: Array.from(result.masterCorrelations.entries()),
    seriesProblemCounts: Array.from(result.seriesProblemCounts.entries()),
    possibleProblemsDetail: Array.from(result.possibleProblemsDetail.entries()),
});

const deserializeCofechaResult = (result: SerializedCofechaResult): ICofechaResult => ({
    ...result,
    masterDatingSeries: new Map(result.masterDatingSeries),
    masterCorrelations: new Map(result.masterCorrelations ?? []),
    seriesProblemCounts: new Map(result.seriesProblemCounts ?? []),
    possibleProblemsDetail: new Map(result.possibleProblemsDetail),
});

const loadPersistedCofechaState = (filePath: string): PersistedCofechaState | null => {
    try {
        const raw = window.localStorage.getItem(getCofechaStorageKey(filePath));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        return isPersistedCofechaState(parsed) ? parsed : null;
    } catch (error) {
        console.warn("读取 COFECHA 状态失败:", error);
        return null;
    }
};

const persistCofechaState = (
    filePath: string,
    outFileContent: string,
    cofechaResult: ICofechaResult | undefined,
    cofechaVersion: CofechaVersion,
    selectedPart: string,
) => {
    try {
        window.localStorage.setItem(
            getCofechaStorageKey(filePath),
            JSON.stringify({
                version: 1,
                savedAt: new Date().toISOString(),
                outFileContent,
                cofechaResult: cofechaResult ? serializeCofechaResult(cofechaResult) : undefined,
                cofechaVersion,
                selectedPart,
            } satisfies PersistedCofechaState),
        );
    } catch (error) {
        console.warn("保存 COFECHA 状态失败:", error);
    }
};

const createReferenceOperationLogEntry = (
    config: ReferenceSeriesConfig | null,
    sequence: number,
    projectId?: string | null,
): RwlOperationLogEntry => {
    const selectedCount = config?.selectedTrees.length ?? 0;
    const id = `reference-${Date.now()}-${sequence}`;
    const timestamp = new Date().toISOString();

    return {
        id,
        operationId: id,
        projectId: projectId || undefined,
        seriesId: "Reference",
        sequence,
        timestamp,
        createdAt: timestamp,
        createdBy: "user",
        action: "apply",
        operationType: config ? "SET_REFERENCE_SERIES" : "CLEAR_REFERENCE_SERIES",
        source: "reference-assisted",
        summary: config ? "设置参考序列" : "关闭参考序列",
        detail: config
            ? `${selectedCount} 条序列 · ${config.method} · min n=${config.minSampleDepth}`
            : "移除当前 reference / master-like series",
        tree: "Reference",
        reason: config ? "用户选择可靠序列生成视觉参考线" : "用户关闭参考线",
        undone: false,
        isApplied: true,
        isReverted: false,
        canUndo: false,
        canRedo: false,
        undoDepth: 0,
        redoDepth: 0,
    };
};

const normalizeWorkspaceOperationLogEntry = (
    entry: RwlOperationLogEntry,
    projectId?: string | null,
): RwlOperationLogEntry => {
    const isReverted = entry.isReverted ?? Boolean(entry.undone);
    const isApplied = entry.isApplied ?? !isReverted;
    return {
        ...entry,
        operationId: entry.operationId ?? entry.id,
        projectId: entry.projectId ?? projectId ?? undefined,
        seriesId: entry.seriesId ?? entry.tree,
        createdAt: entry.createdAt ?? entry.timestamp,
        createdBy: entry.createdBy ?? (entry.source === "system" ? "system" : "user"),
        isApplied,
        isReverted,
    };
};

export function useHomeWorkspace() {
    const rwlEditorRef = useRef<RwlEditor>(new RwlEditor(new Map()));
    const originalDataRef = useRef<RwlSiteData>(new Map());
    const filePathRef = useRef<string | null>(null);
    const historyAnimationIdRef = useRef(0);
    const historyPersistTimerRef = useRef<number | null>(null);
    const diagnosisRequestIdRef = useRef(0);
    const diagnosisWorkerRef = useRef<Worker | null>(null);
    const referenceOperationCounterRef = useRef(0);
    const lastCofechaValidationRef = useRef<{ input: string; version: CofechaVersion } | null>(null);
    const latestDiagnosisCandidatesRef = useRef<DiagnosisCandidateOperation[]>([]);

    const [siteData, setSiteData] = useState<RwlSiteData>(() => rwlEditorRef.current.getData());
    const [deletionMarkers, setDeletionMarkers] = useState<RwlDeletionMarkers>(() => rwlEditorRef.current.getDeletionMarkers());
    const [operationLog, setOperationLog] = useState<RwlOperationLogEntry[]>(() => rwlEditorRef.current.getOperationLog());
    const [referenceConfig, setReferenceConfig] = useState<ReferenceSeriesConfig | null>(null);
    const [referenceOperationLog, setReferenceOperationLog] = useState<RwlOperationLogEntry[]>([]);
    const [historyStatus, setHistoryStatus] = useState<RwlHistoryStatus>(() => rwlEditorRef.current.getHistoryStatus());
    const [treeOptions, setTreeOptions] = useState<string[]>([]);
    const [selectedTree, setSelectedTree] = useState<string>(ALL_OPTION_VALUE);
    const [historyAnimation, setHistoryAnimation] = useState<WidthHistoryAnimation | null>(null);
    const [crossdatingDiagnosis, setCrossdatingDiagnosis] = useState<CrossdatingDiagnosis>(() => createEmptyCrossdatingDiagnosis());
    const [fileName, setFileName] = useState<string | null>(null);
    const [isModified, setIsModified] = useState(false);

    const [outFileContent, setOutFileContent] = useState("");
    const [cofechaResult, setCofechaResult] = useState<ICofechaResult>();
    const [possibleProblemsDetail, setPossibleProblemsDetail] = useState<Map<string, string>>(new Map());
    const [cofechaParts, setCofechaParts] = useState<Map<string, string>>(new Map());
    const [selectedPart, setSelectedPart] = useState<string>(ALL_OPTION_VALUE);
    const [cofechaVersion, setCofechaVersion] = useState<CofechaVersion>("cofecha");
    const [isFileLoading, setIsFileLoading] = useState(false);
    const [isCofechaRunning, setIsCofechaRunning] = useState(false);
    const [diagnosisBatchResult, setDiagnosisBatchResult] = useState<DiagnosisBatchApplyResult | null>(null);

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
            if (filePathRef.current) {
                scheduleHistorySnapshotPersist(filePathRef.current, editor);
            }
        });
    }, [scheduleHistorySnapshotPersist]);

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
            setSelectedTree(ALL_OPTION_VALUE);
        }
    }, [selectedTree, treeOptions]);

    useEffect(() => {
        setReferenceConfig((previous) => {
            const normalized = normalizeReferenceSeriesConfig(previous, siteData);
            if (JSON.stringify(previous) === JSON.stringify(normalized)) {
                return previous;
            }
            return normalized;
        });
    }, [siteData]);

    useEffect(() => {
        if (!filePathRef.current) return;
        persistReferenceState(
            filePathRef.current,
            referenceConfig,
            referenceOperationLog,
            referenceOperationCounterRef.current,
        );
    }, [referenceConfig, referenceOperationLog]);

    useEffect(() => {
        if (!filePathRef.current || (!outFileContent && !cofechaResult)) return;
        persistCofechaState(
            filePathRef.current,
            outFileContent,
            cofechaResult,
            cofechaVersion,
            selectedPart,
        );
    }, [cofechaResult, cofechaVersion, outFileContent, selectedPart]);

    // savedBaseline：磁盘上真正保存的数据。恢复 localStorage 草稿后，工作数据可能与磁盘不一致，
    // 此时用磁盘数据当基线，让 isModified（标题的 *）如实反映"草稿未写盘"。不传则以工作数据为基线（视为已保存）。
    const replaceEditor = useCallback((nextEditor: RwlEditor, savedBaseline?: RwlSiteData) => {
        nextEditor.setProjectId(filePathRef.current);
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
        const version = typeof options === "string"
            ? options
            : options?.version ?? cofechaVersion;
        const selectedPartForPersistence = typeof options === "object" && options.selectedPart
            ? options.selectedPart
            : selectedPart;

        setIsCofechaRunning(true);

        try {
            const baseName = sourcePath.split(/\\|\//).pop() || "INPUT.RWL";
            const nextOutText = await runCofecha(input, baseName, sourcePath, version);
            const nextResult = parseCofechaResult(nextOutText);

            lastCofechaValidationRef.current = {
                input: rwlEditorRef.current.exportAsRwlString(),
                version,
            };
            setOutFileContent(nextOutText);
            setCofechaResult(nextResult);
            setPossibleProblemsDetail(nextResult.possibleProblemsDetail);
            setCofechaParts(splitReportByParts(nextOutText));
            persistCofechaState(
                sourcePath,
                nextOutText,
                nextResult,
                version,
                selectedPartForPersistence,
            );
        } finally {
            setIsCofechaRunning(false);
        }
    }, [cofechaVersion, selectedPart]);

    const handleLoad = useCallback(async () => {
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
            filePathRef.current = filePath;

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
            replaceEditor(nextEditor, diskBaseline);
            setReferenceConfig(normalizeReferenceSeriesConfig(
                persistedReference?.referenceConfig ?? null,
                nextEditor.getData(),
            ));
            setReferenceOperationLog((persistedReference?.referenceOperationLog ?? []).map((entry) => (
                normalizeWorkspaceOperationLogEntry(entry, filePath)
            )));
            referenceOperationCounterRef.current = persistedReference?.referenceOperationCounter
                ?? Math.max(...(persistedReference?.referenceOperationLog ?? []).map((entry) => entry.sequence), 0);
            lastCofechaValidationRef.current = null;
            const restoredCofechaVersion = persistedCofecha?.cofechaVersion ?? "cofecha";
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
                setCofechaVersion(restoredCofechaVersion);
            } else {
                setOutFileContent("");
                setCofechaResult(undefined);
                setPossibleProblemsDetail(new Map());
                setCofechaParts(new Map());
                setCofechaVersion(restoredCofechaVersion);
            }
            setTreeOptions(Array.from(nextEditor.getData().keys()));
            setSelectedTree(ALL_OPTION_VALUE);
            setFileName(filePath);
            setDiagnosisBatchResult(null);

            try {
                await runCofechaAndApplyResult(nextEditor.exportAsRwlString(), filePath, {
                    version: restoredCofechaVersion,
                    selectedPart: restoredSelectedPart,
                });
            } catch (error) {
                console.error("cofecha 执行失败", error);
            }
        } catch (error) {
            console.error("读取文件时出错:", error);
        } finally {
            setIsFileLoading(false);
        }
    }, [replaceEditor, runCofechaAndApplyResult]);

    const markCurrentDataAsSaved = useCallback(() => {
        const nextData = rwlEditorRef.current.getData();
        originalDataRef.current = nextData;
        setSiteData(nextData);
        setIsModified(false);
    }, []);

    const getCurrentRwlText = useCallback((tree?: string) => (
        rwlEditorRef.current.exportAsRwlString(tree)
    ), []);

    const applyParsedRwlText = useCallback(async (rawText: string) => {
        stopMarker.value = await detectPrecision(rawText);
        const rwlData = await readRwlString(rawText);
        const nextTreeOptions = Array.from(rwlData.data.keys());

        rwlEditorRef.current.replaceAllData(rwlData.data, rwlData.readOptions, rwlData.format);
        setTreeOptions(nextTreeOptions);
        setSelectedTree((previous) => (
            previous !== ALL_OPTION_VALUE && !nextTreeOptions.includes(previous)
                ? ALL_OPTION_VALUE
                : previous
        ));

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
        if (!filePathRef.current) {
            console.log("请先打开一个文件");
            return;
        }

        try {
            const rwlString = rwlEditorRef.current.exportAsRwlString();
            await saveFile(filePathRef.current, rwlString);
            markCurrentDataAsSaved();

            try {
                await runCofechaAndApplyResult(rwlString, filePathRef.current);
            } catch (error) {
                console.error("cofecha 执行失败", error);
            }
        } catch (error) {
            console.error("写入文件时出错:", error);
        }
    }, [markCurrentDataAsSaved, runCofechaAndApplyResult]);

    const handleRunCofechaValidation = useCallback(async () => {
        if (!filePathRef.current || isCofechaRunning) {
            return;
        }

        try {
            await runCofechaAndApplyResult(
                rwlEditorRef.current.exportAsRwlString(),
                filePathRef.current,
                cofechaVersion,
            );
        } catch (error) {
            console.error("cofecha 执行失败", error);
        }
    }, [cofechaVersion, isCofechaRunning, runCofechaAndApplyResult]);

    const handleSaveRawText = useCallback(async (rawText: string) => {
        if (!filePathRef.current) {
            console.log("请先打开一个文件");
            return;
        }

        try {
            await applyParsedRwlText(rawText);
            await saveFile(filePathRef.current, rawText);
            markCurrentDataAsSaved();

            try {
                await runCofechaAndApplyResult(rawText, filePathRef.current);
            } catch (error) {
                console.error("cofecha 执行失败", error);
            }
        } catch (error) {
            console.error("写入文本编辑内容时出错:", error);
            throw error;
        }
    }, [applyParsedRwlText, markCurrentDataAsSaved, runCofechaAndApplyResult]);

    const handleSaveAs = useCallback(async () => {
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

            const rwlString = rwlEditorRef.current.exportAsRwlString();
            await saveFile(filePathToSave, rwlString);
            filePathRef.current = filePathToSave;
            setFileName(filePathToSave);
            rwlEditorRef.current.setProjectId(filePathToSave);
            rwlEditorRef.current.commitCurrentDataAsRawBaseline();
            persistHistorySnapshot(filePathToSave, rwlEditorRef.current);
            persistReferenceState(
                filePathToSave,
                referenceConfig,
                referenceOperationLog,
                referenceOperationCounterRef.current,
            );
            markCurrentDataAsSaved();

            try {
                await runCofechaAndApplyResult(rwlString, filePathToSave);
            } catch (error) {
                console.error("cofecha 执行失败", error);
            }
        } catch (error) {
            console.error("写入文件时出错:", error);
        }
    }, [markCurrentDataAsSaved, referenceConfig, referenceOperationLog, runCofechaAndApplyResult]);

    const handleSaveRawTextAs = useCallback(async (rawText: string) => {
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

            await applyParsedRwlText(rawText);
            await saveFile(filePathToSave, rawText);
            filePathRef.current = filePathToSave;
            setFileName(filePathToSave);
            rwlEditorRef.current.setProjectId(filePathToSave);
            rwlEditorRef.current.commitCurrentDataAsRawBaseline();
            persistHistorySnapshot(filePathToSave, rwlEditorRef.current);
            persistReferenceState(
                filePathToSave,
                referenceConfig,
                referenceOperationLog,
                referenceOperationCounterRef.current,
            );
            markCurrentDataAsSaved();

            try {
                await runCofechaAndApplyResult(rawText, filePathToSave);
            } catch (error) {
                console.error("cofecha 执行失败", error);
            }
        } catch (error) {
            console.error("写入文本编辑内容时出错:", error);
            throw error;
        }
    }, [applyParsedRwlText, markCurrentDataAsSaved, referenceConfig, referenceOperationLog, runCofechaAndApplyResult]);

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
        rwlEditorRef.current.moveSeriesTailByOffset(tree, selectedStartYear, selectedEndYear, yearOffset);
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
    }, [applyDiagnosisCandidate]);

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

        setDiagnosisBatchResult(nextResult);
        return nextResult;
    }, [applyDiagnosisCandidate]);

    const handleApplyLocalSimulation = useCallback((request: LocalSimulationApplyRequest) => {
        const { simulation, option } = request;
        if (option.operationType === "NO_ACTION" || option.delta === null || option.delta <= 0) {
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
                hoverYear: simulation.year,
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
            return;
        }

        if (option.operationType === "SHIFT_RANGE" && option.shift) {
            rwlEditorRef.current.moveSeriesTailByOffset(
                simulation.targetTree,
                simulation.year,
                simulation.segmentEndYear,
                option.shift,
                logMetadata,
            );
            triggerHistoryAnimation({
                type: "move-selection",
                tree: simulation.targetTree,
                selectedStartYear: simulation.year,
                selectedEndYear: simulation.segmentEndYear,
                yearOffset: option.shift,
                direction: "redo",
            });
        }
    }, [triggerHistoryAnimation]);

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
        referenceOperationCounterRef.current += 1;
        setReferenceConfig(normalized);
        setReferenceOperationLog((previous) => [
            ...previous,
            createReferenceOperationLogEntry(normalized, referenceOperationCounterRef.current, filePathRef.current),
        ].slice(-MAX_REFERENCE_OPERATION_LOG_ENTRIES));
    }, []);

    const handleReplaceTreeData = useCallback((tree: string, data: Map<number, number | null>) => {
        rwlEditorRef.current.replaceTreeData(tree, data);
    }, []);

    const handleInsertMissingYearAtSideFromChart = useCallback((tree: string, nextYear: number, side: "left" | "right") => {
        rwlEditorRef.current.insertMissingYearAtSide(tree, nextYear, side);
        triggerHistoryAnimation({ type: "insert-missing", tree, year: nextYear, side, direction: "redo" });
    }, [triggerHistoryAnimation]);

    const handleDeleteYearWithModeFromChart = useCallback((tree: string, nextYear: number, mode: DeleteMode, shift: DeleteShift = "right") => {
        rwlEditorRef.current.deleteYearWithMode(tree, nextYear, mode, shift);
        triggerHistoryAnimation({ type: "delete-year", tree, year: nextYear, mode, shift, direction: "redo" });
    }, [triggerHistoryAnimation]);

    const handleTreeSelectionChange = useCallback((nextTree: string) => {
        setSelectedTree(nextTree);
    }, []);

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
        let idleHandle: number | null = null;
        let workerForRequest: Worker | null = null;
        const requestId = ++diagnosisRequestIdRef.current;

        startTransition(() => {
            setCrossdatingDiagnosis((previous) => {
                if (previous.candidates.length === 0) {
                    return previous;
                }

                const staleCandidates = markCandidatesStale(previous.candidates);
                return {
                    ...previous,
                    candidateCount: staleCandidates.length,
                    candidates: staleCandidates,
                };
            });
        });

        const runDiagnosis = () => {
            if (cancelled) return;

            diagnosisWorkerRef.current?.terminate();
            const worker = new Worker(new URL("./diagnosisWorker.ts", import.meta.url), { type: "module" });
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

                worker.terminate();
                diagnosisWorkerRef.current = null;
                workerForRequest = null;

                if ("error" in response) {
                    console.warn("内部诊断计算失败:", response.error);
                    return;
                }

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
                console.warn("内部诊断 worker 运行失败:", event.message);
            };

            worker.postMessage({
                id: requestId,
                siteData,
                referenceConfig,
            } satisfies DiagnosisWorkerRequest);
        };

        const scheduleDiagnosis = () => {
            if ("requestIdleCallback" in window) {
                idleHandle = window.requestIdleCallback(runDiagnosis, { timeout: 700 });
                return;
            }
            runDiagnosis();
        };

        startTimer = window.setTimeout(() => {
            startTimer = null;
            scheduleDiagnosis();
        }, DIAGNOSIS_DEBOUNCE_MS);

        return () => {
            cancelled = true;
            if (startTimer !== null) {
                window.clearTimeout(startTimer);
            }
            if (idleHandle !== null && "cancelIdleCallback" in window) {
                window.cancelIdleCallback(idleHandle);
            }
            if (workerForRequest && diagnosisWorkerRef.current === workerForRequest) {
                workerForRequest.terminate();
                diagnosisWorkerRef.current = null;
            }
        };
    }, [historyAnimation?.id, referenceConfig, siteData]);

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
            || lastValidation.input !== rwlEditorRef.current.exportAsRwlString();
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
        deletionMarkers,
        diagnosisBatchResult,
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
        handleApplyLocalSimulation,
        handleReferenceConfigChange,
        handleRedo,
        handleReplaceTreeData,
        handleResetToRawData,
        handleRestoreDeletion,
        handleRunCofechaValidation,
        handleSaveRawText,
        handleSaveRawTextAs,
        handleSave,
        handleSaveAs,
        handleTreeSelectionChange,
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
        shouldShowProcessing,
        shouldShowWelcome,
        siteData,
        treeOptions,
        windowTitle,
    };
}
