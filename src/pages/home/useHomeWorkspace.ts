import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractPart6FlaggedASeriesIds, parseCofechaResult, splitReportByParts } from "@/features/cofecha/formatter";
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
import {
    createCofechaMasterReferenceConfig,
    hashRwlSiteData,
    normalizeReferenceSeriesConfig,
    type ReferenceSeriesConfig,
} from "@/features/crossdating/reference";
import type { ICofechaResult } from "@/features/cofecha/types";
import { detectPrecision, readRwlString } from "@/features/rwl";
import type { AlphaEditCandidate, AlphaEditSuggestionResult } from "@/features/rwl/alphaEditSuggestions";
import { rebuildTreeDataFromStartYear, type BayesianDatingCandidate, type BayesianMcmcDatingResult } from "@/features/rwl/bayesianDating";
import { RwlEditor, registerChangeYearWidth } from "@/features/rwl/edit";
import type { DeleteMode, DeleteShift, RwlDeletionMarkers, RwlHistoryAnimation, RwlHistoryStatus, RwlOperationLogEntry } from "@/features/rwl/edit";
import type { RwlSiteData } from "@/features/rwl/types";
import { runCofecha } from "@/services/cofecha/runner";
import { readRwlFile, saveFile } from "@/services/fs/io";
import { stopMarker } from "@/shared/constants";
import { useSettings } from "@/features/settings/SettingsContext";
import { ALL_OPTION_VALUE, CofechaVersion, formatTitle } from "./homeShared";
import type { DiagnosisWorkerRequest, DiagnosisWorkerResponse } from "./diagnosisWorker";
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
const DIAGNOSIS_DEBOUNCE_MS = 120;

type RunCofechaApplyOptions = {
    version?: CofechaVersion;
    selectedPart?: string;
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
    const historyAnimationIdRef = useRef(0);
    const historyPersistTimerRef = useRef<number | null>(null);
    const diagnosisRequestIdRef = useRef(0);
    const diagnosisWorkerRef = useRef<Worker | null>(null);
    const referenceOperationCounterRef = useRef(0);
    const lastCofechaValidationRef = useRef<{ input: string; version: CofechaVersion } | null>(null);
    const latestDiagnosisCandidatesRef = useRef<DiagnosisCandidateOperation[]>([]);
    const latestDynamicReferenceConfigRef = useRef<ReferenceSeriesConfig | null>(null);

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
    // COFECHA 引擎是全局设置（运行菜单与设置窗口共享同一来源），不再随工作区局部保存。
    const { settings, updateCofechaSettings } = useSettings();
    const cofechaVersion = settings.cofecha.engine;
    const setCofechaVersion = useCallback((version: CofechaVersion) => {
        updateCofechaSettings({ engine: version });
    }, [updateCofechaSettings]);
    const [isFileLoading, setIsFileLoading] = useState(false);
    const [isCofechaRunning, setIsCofechaRunning] = useState(false);
    const [diagnosisBatchResult, setDiagnosisBatchResult] = useState<DiagnosisBatchApplyResult | null>(null);

    const [dynamicReferenceConfig, setDynamicReferenceConfig] = useState<ReferenceSeriesConfig | null>(null);

    useEffect(() => {
        if (dynamicReferenceConfig?.mode === "dynamic") {
            latestDynamicReferenceConfigRef.current = dynamicReferenceConfig;
        }
    }, [dynamicReferenceConfig]);

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
            const nextParts = splitReportByParts(nextOutText);
            const cofechaRunId = `cofecha-${Date.now()}`;
            const flaggedAIds = extractPart6FlaggedASeriesIds(nextParts.get("PART 6") ?? "");
            // Temporary experiment: drive automatic crossdating from COFECHA's
            // own PART 3 master dating series instead of our anchor-pass rebuild.
            const dynamicReferenceConfig = createCofechaMasterReferenceConfig({
                siteData: rwlEditorRef.current.getData(),
                flaggedAIds,
                cofechaRunId,
                rwlHash: hashRwlSiteData(rwlEditorRef.current.getData()),
                masterDatingSeries: nextResult.masterDatingSeries,
            });
            logCofechaReferenceComparison(nextResult.masterDatingSeries, dynamicReferenceConfig);

            lastCofechaValidationRef.current = {
                input: rwlEditorRef.current.exportAsRwlString(),
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
            } else {
                setOutFileContent("");
                setCofechaResult(undefined);
                setPossibleProblemsDetail(new Map());
                setCofechaParts(new Map());
            }
            setTreeOptions(Array.from(nextEditor.getData().keys()));
            setSelectedTree(ALL_OPTION_VALUE);
            setFileName(filePath);
            setDiagnosisBatchResult(null);

            try {
                await runCofechaAndApplyResult(nextEditor.exportAsRwlString(), filePath, {
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
                dynamicReferenceConfig,
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
    }, [dynamicReferenceConfig, markCurrentDataAsSaved, referenceConfig, referenceOperationLog, runCofechaAndApplyResult]);

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
                dynamicReferenceConfig,
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
    }, [applyParsedRwlText, dynamicReferenceConfig, markCurrentDataAsSaved, referenceConfig, referenceOperationLog, runCofechaAndApplyResult]);

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

    const getCurrentBarkToPithRings = useCallback((tree: string) => (
        Array.from(rwlEditorRef.current.getData().get(tree)?.entries() ?? [])
            .filter((entry): entry is [number, number] => {
                const [, value] = entry;
                return typeof value === "number"
                    && Number.isFinite(value)
                    && value !== stopMarker.value;
            })
            .sort((a, b) => b[0] - a[0])
            .map(([year, value], ringIndex) => ({ ringIndex, year, value }))
    ), []);

    const handleApplyAlphaEditCandidate = useCallback((
        tree: string,
        result: AlphaEditSuggestionResult,
        candidate: AlphaEditCandidate,
    ) => {
        if (candidate.operations.length === 0) {
            return;
        }

        const batchId = `wenk-alpha-edit-${Date.now()}-${candidate.operations.length}`;
        const sortedOperations = [...candidate.operations].sort((a, b) => {
            const indexA = a.recommendedDeleteIndex ?? a.targetBoundaryIndex ?? -1;
            const indexB = b.recommendedDeleteIndex ?? b.targetBoundaryIndex ?? -1;
            return indexB - indexA || b.operationOrder - a.operationOrder;
        });

        sortedOperations.forEach((operation, operationIndex) => {
            const currentRings = getCurrentBarkToPithRings(tree);
            const targetIndex = operation.operationType === "insert_missing_ring_suggestion"
                ? (operation.targetBoundaryIndex === null || operation.targetBoundaryIndex === undefined
                    ? undefined
                    : operation.targetBoundaryIndex + 1)
                : operation.recommendedDeleteIndex;
            if (targetIndex === null || targetIndex === undefined) {
                return;
            }
            const targetRing = currentRings[targetIndex];
            if (!targetRing) {
                return;
            }

            const logMetadata = {
                operationType: "WENK_2003_ALPHA_EDIT_SUGGESTION",
                source: "auto-suggested" as const,
                reason: operation.operationType === "insert_missing_ring_suggestion"
                    ? "Wenk 2003 alpha-edit suggested missing ring"
                    : "Wenk 2003 alpha-edit suggested double/false ring",
                batchId,
                targetIndex,
                oldYear: targetRing.year,
                metricsBefore: {
                    candidateId: candidate.id,
                    candidateRank: candidate.rank,
                    alpha: candidate.alpha,
                    editCount: candidate.editCount,
                    insertCount: candidate.insertCount,
                    mergeCount: candidate.mergeCount,
                    operationIndex: operationIndex + 1,
                    referenceYear: operation.referenceYear,
                    suggestedOuterYear: candidate.suggestedOuterYear,
                    suggestedInnerYear: candidate.suggestedInnerYear,
                },
                metricsAfter: {
                    tValue: candidate.tValue ?? null,
                    correlation: candidate.correlation ?? null,
                    normalizedEditDistance: candidate.normalizedEditDistance,
                    sumSquaredError: candidate.sumSquaredError,
                    overlap: candidate.overlap,
                    costContribution: operation.costContribution,
                    candidateCount: result.candidateCount,
                },
            };

            if (operation.operationType === "insert_missing_ring_suggestion") {
                rwlEditorRef.current.insertMissingYearAtSide(tree, targetRing.year, "right", logMetadata);
                triggerHistoryAnimation({
                    type: "insert-missing",
                    tree,
                    year: targetRing.year,
                    side: "right",
                    direction: "redo",
                });
                return;
            }

            rwlEditorRef.current.deleteYearWithMode(tree, targetRing.year, "right", "right", logMetadata);
            triggerHistoryAnimation({
                type: "delete-year",
                tree,
                year: targetRing.year,
                mode: "right",
                shift: "right",
                direction: "redo",
            });
        });
    }, [getCurrentBarkToPithRings, triggerHistoryAnimation]);

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
                referenceConfig: dynamicReferenceConfig,
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
    }, [dynamicReferenceConfig, historyAnimation?.id, siteData]);

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
        handleApplyBayesianStartYear,
        handleApplyAlphaEditCandidate,
        handleApplyLocalSimulation,
        handleReferenceConfigChange,
        handleResetReferenceToDynamic,
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
