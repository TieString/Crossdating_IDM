import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, readFile, writeFile, exists, lstat } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { effectiveChangesCsv } from "@/features/rwl/effectiveChanges";
import { buildRwlDisplayUnits } from "@/features/rwl/displayUnits";
import { exportWorkspacePackage, importWorkspacePackage, matchWorkspaceRwl,
    workspaceRwl, MAX_PACKAGE_BYTES } from "@/features/workspaceTransfer/package";
import { commitWorkspaceImport } from "./workspaceImport";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractPart6FlaggedASeriesIds, parseCofechaResult, splitReportByParts } from "@/features/cofecha/formatter";
import { getCofechaSeriesMapValue } from "@/features/cofecha/seriesId";
import {
    type CrossdatingDiagnosis,
    getDisplayedDiagnosisEvents,
    getDiagnosisCandidateLabel,
    isNegativePartialShift,
    markCandidatesStale,
    markDiagnosisEventsStale,
    planManuallyConfirmedDiagnosisEventEdit,
    selectSafeDiagnosisCandidateBatch,
    type DiagnosisBatchApplyResult,
    type DiagnosisBatchCandidateResult,
    type DiagnosisCandidateOperation,
    type DiagnosisEvent,
    type LocalSimulationApplyRequest,
} from "@/features/crossdating/diagnosis";
import { buildCrossdatingValidationSummary } from "@/features/crossdating/validation";
import { createPairwiseBootstrapReferenceConfig } from "@/features/crossdating/pairwiseBootstrap";
import {
    classifyCofechaPart6Series,
    createCofechaMasterReferenceConfig,
    hashRwlSiteData,
    normalizeReferenceSeriesConfig,
    type ReferenceSeriesConfig,
} from "@/features/crossdating/reference";
import type { CofechaEngine, CofechaUndatedInput, CofechaUndatedSort, ICofechaResult } from "@/features/cofecha/types";
import { detectPrecision, readRwlString } from "@/features/rwl";
import {
    RwlBatchMoveConflictError,
    RwlEditor,
    RwlMoveConflictError,
    registerChangeYearWidth,
} from "@/features/rwl/edit";
import type { DeleteMode, DeleteRangeFill, DeleteShift, RwlDeletionMarkers, RwlHistoryAnimation, RwlHistoryStatus, RwlMoveConflictPolicy, RwlOperationLogEntry } from "@/features/rwl/edit";
import type { RwlFormat, RwlSiteData } from "@/features/rwl/types";
import {
    createEmptyTreeRingScanState,
    clearTreeRingScanImageCache,
    indexTreeRingScanFolder,
    normalizeTreeRingScanSeriesKey,
    type PersistedTreeRingScanState,
    type TreeRingScanSeriesState,
} from "@/features/treeRingScans";
import { COFECHA_RUNTIME_REVISION as COFECHA_JS_VERSION, runCofechaReport } from "@/services/cofecha";
import { readRwlFile, saveFile } from "@/services/fs/io";
import { stopMarker } from "@/shared/constants";
import { useSettings } from "@/features/settings/SettingsContext";
import { ALL_OPTION_VALUE, formatTitle } from "./homeShared";
import type { DiagnosisWorkerRequest, DiagnosisWorkerResponse } from "./diagnosisWorker";
import { selectAutomaticDiagnosisReferenceConfig } from "./diagnosisReferencePolicy";
import { planWholeSeriesDiagnosisMove } from "@/features/crossdating/diagnosis/eventApply";
import { canReuseValidation, hashValidationText, refreshReusedReference, shouldScheduleAutomaticValidation, type ValidationInput } from "./validationReuse";
import { UNIFIED_V5_RUNTIME_VERSION } from "@/features/crossdating/diagnosis/unifiedV5Model";
import {
    createBreadthDiagnosisSuggestion,
    createEmptyBreadthDiagnosisNavigator,
    orderBreadthScanTargets,
    sortBreadthDiagnosisSuggestions,
    type BreadthDiagnosisNavigatorState,
    type BreadthDiagnosisSuggestion,
    type BreadthScanPauseReason,
} from "./breadthDiagnosis";
import { createSerialTaskQueue } from "./serialTaskQueue";
import {
    deserializeCofechaResult,
    getPersistedCofechaEngine,
    loadPersistedCofechaState,
    loadPersistedHistorySnapshot,
    loadPersistedReferenceState,
    loadPersistedTreeRingScanState,
    migrateLegacyWorkspaceStorage,
    persistCofechaState,
    persistHistorySnapshot,
    persistImportedHistorySnapshot,
    persistReferenceState,
    persistTreeRingScanState,
} from "./workspacePersistence";
import {
    createEmptyCrossdatingDiagnosis,
    createReferenceOperationLogEntry,
    MAX_REFERENCE_OPERATION_LOG_ENTRIES,
    normalizeWorkspaceOperationLogEntry,
    rwlDataEquals,
    stringArraysEqual,
} from "./workspaceState";
import { resolveWorkspaceDraft } from "./workspaceDraft";
import { showRwlReadError } from "./rwlReadError";

function syncStopMarkerFromSiteData(data: RwlSiteData): void {
    const trailingValues = Array.from(data.values()).flatMap((treeData) => {
        const lastEntry = Array.from(treeData.entries()).sort(([left], [right]) => right - left)[0];
        return lastEntry ? [lastEntry[1]] : [];
    });
    if (trailingValues.includes(-9999)) {
        stopMarker.value = -9999;
    } else if (trailingValues.includes(999)) {
        stopMarker.value = 999;
    }
}

export type WidthHistoryAnimation = RwlHistoryAnimation & { id: number };

const HISTORY_SNAPSHOT_PERSIST_DELAY_MS = 250;
const DIAGNOSIS_DEBOUNCE_MS = 40;
const COFECHA_AUTO_REFRESH_DELAY_MS = 300;
const BREADTH_SCAN_DELAY_MS = 140;

type DiagnosisResultCache = {
    siteData: RwlSiteData;
    sourceStopMarker: number;
    referenceConfig: ReferenceSeriesConfig | null;
    cofechaText: string | undefined;
    results: Map<string, CrossdatingDiagnosis>;
    reviewResults: Map<string, CrossdatingDiagnosis>;
};

type BreadthScanContext = {
    generation: number;
    siteData: RwlSiteData;
    referenceConfig: ReferenceSeriesConfig | null;
    cofechaText: string | undefined;
    pending: string[];
    targets: Set<string>;
    scanned: Set<string>;
    suggestions: Map<string, BreadthDiagnosisSuggestion>;
    attempts: Map<string, number>;
    totalCount: number;
};

type BreadthScanRequest = {
    id: number;
    filePath: string;
    dataSignature: string;
};

type RunCofechaApplyOptions = {
    reuseUnchanged?: boolean;
    engine?: CofechaEngine;
    selectedPart?: string;
    inputData?: RwlSiteData;
    undated?: CofechaUndatedSource | null;
    workspaceGuard?: {
        editor: RwlEditor;
        filePath: string;
        inputHash: string;
    };
};

type CofechaUndatedSource = {
    filePath: string;
    fileName: string;
    rwlText: string;
    inputSignature: string;
    sort: CofechaUndatedSort;
};

const validationMatchesCurrentInputs = (validation: ({ inputSignature: string } & ValidationInput) | null,
    inputSignature: string, sourcePath: string | null, engine: CofechaEngine, executablePath: string,
    undated: CofechaUndatedSource | null) => Boolean(validation
        && validation.inputSignature === inputSignature
        && validation.sourcePath === sourcePath
        && validation.engine === engine
        && validation.executablePath === (engine === "official" ? executablePath.trim() : null)
        && validation.cofechaJsVersion === COFECHA_JS_VERSION
        && validation.undatedInputText === (undated?.rwlText ?? null)
        && validation.undatedSourcePath === (undated?.filePath ?? null)
        && validation.undatedSort === (undated?.sort ?? null));

const reportEngineIdentity = (engine: CofechaEngine, executablePath: string) => engine === "official"
    ? `official:${executablePath.trim()}` : `javascript:${COFECHA_JS_VERSION}`;

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
    const breadthDiagnosisRequestIdRef = useRef(0);
    const breadthDiagnosisWorkerRef = useRef<Worker | null>(null);
    const breadthScanContextRef = useRef<BreadthScanContext | null>(null);
    const breadthGenerationCounterRef = useRef(0);
    const breadthScanRequestCounterRef = useRef(0);
    const breadthConsumedScanRequestRef = useRef(0);
    const breadthFirstSeenOrderRef = useRef(0);
    const breadthLastSuggestionBySeriesRef = useRef(new Map<string, BreadthDiagnosisSuggestion>());
    const breadthFileNameRef = useRef<string | null>(null);
    const saveOperationCountRef = useRef(0);
    const diagnosisResultCacheRef = useRef<DiagnosisResultCache | null>(null);
    const referenceOperationCounterRef = useRef(0);
    // COFECHA .OUT 对应数据的签名 + 引擎版本。用于判断当前 .OUT 是否仍与编辑数据匹配（新鲜）。
    const lastCofechaValidationRef = useRef<({ inputSignature: string } & ValidationInput) | null>(null);
    const pendingValidationRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
    const latestDiagnosisCandidatesRef = useRef<DiagnosisCandidateOperation[]>([]);
    const latestDynamicReferenceConfigRef = useRef<ReferenceSeriesConfig | null>(null);

    const [siteData, setSiteData] = useState<RwlSiteData>(() => rwlEditorRef.current.getData());
    const siteDataSignature = useMemo(() => hashRwlSiteData(siteData), [siteData]);
    const [deletionMarkers, setDeletionMarkers] = useState<RwlDeletionMarkers>(() => rwlEditorRef.current.getDeletionMarkers());
    const [operationLog, setOperationLog] = useState<RwlOperationLogEntry[]>(() => rwlEditorRef.current.getOperationLog());
    const [allRwlOperationLog, setAllRwlOperationLog] = useState<RwlOperationLogEntry[]>(
        () => rwlEditorRef.current.getAllAppliedOperationLogEntries(false),
    );
    const [treeRingScanState, setTreeRingScanState] = useState<PersistedTreeRingScanState>(
        createEmptyTreeRingScanState,
    );
    const [referenceConfig, setReferenceConfig] = useState<ReferenceSeriesConfig | null>(null);
    const transferRunningRef = useRef(false);
    const [referenceOperationLog, setReferenceOperationLog] = useState<RwlOperationLogEntry[]>([]);
    const [historyStatus, setHistoryStatus] = useState<RwlHistoryStatus>(() => rwlEditorRef.current.getHistoryStatus());
    const [treeOptions, setTreeOptions] = useState<string[]>([]);
    const [selectedTree, setSelectedTree] = useState<string>(ALL_OPTION_VALUE);
    const [historyAnimation, setHistoryAnimation] = useState<WidthHistoryAnimation | null>(null);
    const [crossdatingDiagnosis, setCrossdatingDiagnosis] = useState<CrossdatingDiagnosis>(() => createEmptyCrossdatingDiagnosis());
    const markCurrentDiagnosisStale = useCallback(() => {
        setCrossdatingDiagnosis((previous) => {
            if (previous.candidates.length === 0
                && previous.events.length === 0
                && (previous.reviewEvents?.length ?? 0) === 0) {
                return previous;
            }

            const staleCandidates = markCandidatesStale(previous.candidates);
            const staleEvents = markDiagnosisEventsStale(previous.events);
            const staleReviewEvents = previous.reviewEvents
                ? markDiagnosisEventsStale(previous.reviewEvents)
                : undefined;
            return {
                ...previous,
                candidateCount: staleCandidates.length,
                eventCount: staleEvents.length,
                candidates: staleCandidates,
                events: staleEvents,
                ...(staleReviewEvents ? { reviewEvents: staleReviewEvents } : {}),
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
    const { settings } = useSettings();
    const activeCofechaEngineRef = useRef(reportEngineIdentity(settings.cofecha.engine, settings.cofecha.executablePath));
    const [cofechaUndatedSource, setCofechaUndatedSource] = useState<CofechaUndatedSource | null>(null);
    const [isFileLoading, setIsFileLoading] = useState(false);
    const [isCofechaRunning, setIsCofechaRunning] = useState(false);
    const [isEventDiagnosisRunning, setIsEventDiagnosisRunning] = useState(false);
    const [isSaveRunning, setIsSaveRunning] = useState(false);
    const [breadthScanGeneration, setBreadthScanGeneration] = useState(0);
    const [breadthScanRequest, setBreadthScanRequest] = useState<BreadthScanRequest | null>(null);
    const [breadthDiagnosisNavigator, setBreadthDiagnosisNavigator] = useState<BreadthDiagnosisNavigatorState>(
        () => createEmptyBreadthDiagnosisNavigator(),
    );
    const [diagnosisBatchResult, setDiagnosisBatchResult] = useState<DiagnosisBatchApplyResult | null>(null);

    const [dynamicReferenceConfig, setDynamicReferenceConfig] = useState<ReferenceSeriesConfig | null>(null);

    useEffect(() => {
        void migrateLegacyWorkspaceStorage();
    }, []);

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
            void persistHistorySnapshot(filePath, editor);
        }, HISTORY_SNAPSHOT_PERSIST_DELAY_MS);
    }, []);

    const scheduleTreeRingScanPersist = useCallback((filePath: string, state: PersistedTreeRingScanState) => {
        // Anchor clicks and mode switches are sparse, so persist immediately; this also
        // preserves the last point if the application closes directly after annotation.
        void persistTreeRingScanState(filePath, state);
    }, []);

    useEffect(() => {
        if (!filePathRef.current || isFileLoadingRef.current) return;
        rwlEditorRef.current.setWorkspaceContext({ referenceConfig, scans: treeRingScanState });
        scheduleHistorySnapshotPersist(filePathRef.current, rwlEditorRef.current);
    }, [referenceConfig, treeRingScanState, scheduleHistorySnapshotPersist]);

    useEffect(() => () => {
        if (historyPersistTimerRef.current !== null) {
            window.clearTimeout(historyPersistTimerRef.current);
        }
    }, []);

    useEffect(() => () => {
        diagnosisWorkerRef.current?.terminate();
        diagnosisWorkerRef.current = null;
        breadthDiagnosisWorkerRef.current?.terminate();
        breadthDiagnosisWorkerRef.current = null;
    }, []);

    const syncEditor = useCallback((editor: RwlEditor) => {
        editor.registerChangeCallback(() => {
            const nextData = editor.getData();
            setIsModified(!rwlDataEquals(originalDataRef.current, nextData));
            setSiteData(previous => rwlDataEquals(previous, nextData) ? previous : nextData);
            const nextTreeOptions = Array.from(nextData.keys());
            setTreeOptions((previous) => (
                stringArraysEqual(previous, nextTreeOptions) ? previous : nextTreeOptions
            ));
            setDeletionMarkers(editor.getDeletionMarkers());
            setOperationLog(editor.getOperationLog());
            setAllRwlOperationLog(editor.getAllAppliedOperationLogEntries(false));
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
        void persistReferenceState(
            filePathRef.current,
            referenceConfig,
            dynamicReferenceConfig,
            referenceOperationLog,
            referenceOperationCounterRef.current,
        );
    }, [dynamicReferenceConfig, referenceConfig, referenceOperationLog]);

    useEffect(() => {
        if (!filePathRef.current || (!outFileContent && !cofechaResult)) return;
        const validation = lastCofechaValidationRef.current;
        const reportIsStale = !validationMatchesCurrentInputs(validation, siteDataSignature,
            filePathRef.current, settings.cofecha.engine, settings.cofecha.executablePath,
            cofechaUndatedSource);
        void persistCofechaState(
            filePathRef.current,
            outFileContent,
            cofechaResult,
            validation?.engine ?? settings.cofecha.engine,
            selectedPart,
            validation?.inputSignature,
            cofechaUndatedSource ? { filePath: cofechaUndatedSource.filePath, fileName: cofechaUndatedSource.fileName, sort: cofechaUndatedSource.sort } : undefined,
            cofechaUndatedSource?.inputSignature,
            { cofechaJsVersion: validation?.cofechaJsVersion ?? COFECHA_JS_VERSION,
                reportExecutablePath: validation?.executablePath ?? null, reportIsStale },
        );
    }, [cofechaResult, cofechaUndatedSource, outFileContent, selectedPart, settings.cofecha.engine,
        settings.cofecha.executablePath, siteDataSignature]);

    // savedBaseline：磁盘上真正保存的数据。恢复 localStorage 草稿后，工作数据可能与磁盘不一致，
    // 此时用磁盘数据当基线，让 isModified（标题的 *）如实反映"草稿未写盘"。不传则以工作数据为基线（视为已保存）。
    const replaceEditor = useCallback((
        nextEditor: RwlEditor,
        savedBaseline?: RwlSiteData,
        projectPath = filePathRef.current,
    ) => {
        nextEditor.setProjectId(projectPath);
        // Only the editor actually installed as active may change global units.
        // Temporary editors used to validate imports/drafts stay side-effect free.
        const marker = nextEditor.getReadOptions()?.stopMarkerValue;
        if (marker === 999 || marker === -9999) stopMarker.value = marker;
        else syncStopMarkerFromSiteData(nextEditor.getData());
        rwlEditorRef.current = nextEditor;
        syncEditor(nextEditor);
        const nextData = nextEditor.getData();
        const baseline = savedBaseline ?? nextData;
        originalDataRef.current = baseline;
        setSiteData(nextData);
        setDeletionMarkers(nextEditor.getDeletionMarkers());
        setOperationLog(nextEditor.getOperationLog());
        setAllRwlOperationLog(nextEditor.getAllAppliedOperationLogEntries(false));
        setHistoryStatus(nextEditor.getHistoryStatus());
        setHistoryAnimation(null);
        setCrossdatingDiagnosis(createEmptyCrossdatingDiagnosis());
        setIsModified(!rwlDataEquals(baseline, nextData));
    }, [syncEditor]);

    const commitTreeRingScanState = useCallback((
        updater: (previous: PersistedTreeRingScanState) => PersistedTreeRingScanState,
    ) => {
        setTreeRingScanState((previous) => {
            const next = {
                ...updater(previous),
                version: 1 as const,
                savedAt: new Date().toISOString(),
            };
            if (filePathRef.current) {
                scheduleTreeRingScanPersist(filePathRef.current, next);
            }
            return next;
        });
    }, [scheduleTreeRingScanPersist]);

    const handleLoadTreeRingScanFolder = useCallback(async (): Promise<number> => {
        const folderPath = await open({
            directory: true,
            multiple: false,
            title: "选择树轮扫描影像文件夹",
        });
        if (!folderPath || typeof folderPath !== "string") return 0;

        const seriesIds = Array.from(rwlEditorRef.current.getData().keys());
        clearTreeRingScanImageCache();
        const filesBySeries = await indexTreeRingScanFolder(folderPath, seriesIds);
        const verified = new Set<string>();
        for (const [seriesKey, file] of Object.entries(filesBySeries)) {
            const previous = treeRingScanState.series[seriesKey];
            if (!previous?.imagePath && previous?.imageSha256) {
                const fingerprint = await invoke<string>("workspace_file_sha256", { path: file.path });
                if (fingerprint === previous.imageSha256) verified.add(seriesKey);
            }
        }
        commitTreeRingScanState((previous) => {
            const series: Record<string, TreeRingScanSeriesState> = { ...previous.series };
            Object.entries(filesBySeries).forEach(([seriesKey, file]) => {
                const existing = previous.series[seriesKey];
                series[seriesKey] = existing?.imagePath === file.path || verified.has(seriesKey)
                    ? { ...existing, imagePath: file.path }
                    : existing?.imageSha256 && !existing.imagePath ? existing
                    : { mode: "generated", anchors: [], imagePath: file.path };
                if (existing?.imageSha256 && !existing.imagePath && !verified.has(seriesKey)) delete filesBySeries[seriesKey];
            });
            return {
                ...previous,
                folderPath,
                filesBySeries,
                series,
            };
        });
        return Object.keys(filesBySeries).length;
    }, [commitTreeRingScanState, treeRingScanState]);

    const handleTreeRingScanSeriesChange = useCallback((
        seriesId: string,
        nextSeriesState: TreeRingScanSeriesState,
    ) => {
        const seriesKey = normalizeTreeRingScanSeriesKey(seriesId);
        commitTreeRingScanState((previous) => ({
            ...previous,
            series: {
                ...previous.series,
                [seriesKey]: nextSeriesState,
            },
        }));
    }, [commitTreeRingScanState]);

    const runCofechaAndApplyResult = useCallback(async (
        input: string,
        sourcePath: string,
        options?: RunCofechaApplyOptions,
    ) => {
        const engine = options?.engine ?? settings.cofecha.engine;
        const executablePath = engine === "official" ? settings.cofecha.executablePath.trim() : null;
        if (engine === "official" && !executablePath) throw new Error("尚未配置 COFECHA 可执行文件");
        const undatedSource = options?.undated === undefined ? cofechaUndatedSource : options.undated;
        const undatedInput: CofechaUndatedInput | undefined = undatedSource ? {
            rwlText: undatedSource.rwlText,
            inputFileName: undatedSource.fileName,
            sort: undatedSource.sort,
        } : undefined;
        const selectedPartForPersistence = options?.selectedPart ?? selectedPart;
        const inputData = options?.inputData ?? rwlEditorRef.current.getData();
        const inputSignature = hashRwlSiteData(inputData);
        const workspaceGuard = options?.workspaceGuard;
        const validationInput: ValidationInput = {
            inputText: input,
            sourcePath,
            engine,
            executablePath,
            cofechaJsVersion: COFECHA_JS_VERSION,
            undatedInputText: undatedSource?.rwlText ?? null,
            undatedSourcePath: undatedSource?.filePath ?? null,
            undatedSort: undatedSource?.sort ?? null,
        };
        if (options?.reuseUnchanged && canReuseValidation(lastCofechaValidationRef.current, validationInput)) {
            setDynamicReferenceConfig(previous => refreshReusedReference(previous, inputSignature));
            console.info("[COFECHA耗时] 同一输入已有有效结果，本次保存复用校验。");
            return;
        }
        const validationKey = JSON.stringify([workspaceEpochRef.current, validationInput]);
        if (pendingValidationRef.current?.key === validationKey) return pendingValidationRef.current.promise;
        const perform = async () => {
            const requestId = ++cofechaRequestIdRef.current;
            const validationStarted = performance.now();

            setIsCofechaRunning(true);

            try {
                const baseName = sourcePath.split(/\\|\//).pop() || "INPUT.RWL";
                const nextOutText = await cofechaQueueRef.current.enqueue(async () => {
                    if (requestId !== cofechaRequestIdRef.current) {
                        return null;
                    }
                    return runCofechaReport({ engine, rwlText: input, inputFileName: baseName,
                        executablePath: executablePath ?? undefined, undated: undatedInput });
                });
                if (nextOutText === null) {
                    return;
                }
                const executionFinished = performance.now();
                const nextResult = parseCofechaResult(nextOutText);
                const nextParts = splitReportByParts(nextOutText);
                const cofechaRunId = `cofecha-${Date.now()}`;
                const flaggedAIds = extractPart6FlaggedASeriesIds(nextParts.get("PART 6") ?? "");
                const classification = classifyCofechaPart6Series(
                    Array.from(inputData.keys()),
                    flaggedAIds,
                    cofechaRunId,
                );
                const pairwiseBootstrapReference = classification.anchorPassIds.length < 3
                    ? createPairwiseBootstrapReferenceConfig({
                        siteData: inputData,
                        flaggedAIds,
                        cofechaRunId,
                        rwlHash: inputSignature,
                    })
                    : null;
                // Preserve the current PART 3 master path when COFECHA has a usable pass group.
                // A pairwise zero-lag cluster is used only for the all-flagged cold start.
                const dynamicReferenceConfig = pairwiseBootstrapReference
                    ?? createCofechaMasterReferenceConfig({
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
                    ...validationInput,
                };
                latestDynamicReferenceConfigRef.current = dynamicReferenceConfig;
                setDynamicReferenceConfig(dynamicReferenceConfig);
                setOutFileContent(nextOutText);
                setCofechaResult(nextResult);
                setPossibleProblemsDetail(nextResult.possibleProblemsDetail);
                setCofechaParts(nextParts);
                await persistCofechaState(
                    sourcePath,
                    nextOutText,
                    nextResult,
                    engine,
                    selectedPartForPersistence,
                    inputSignature,
                    undatedSource ? { filePath: undatedSource.filePath, fileName: undatedSource.fileName, sort: undatedSource.sort } : undefined,
                    undatedSource?.inputSignature,
                    { cofechaJsVersion: COFECHA_JS_VERSION, reportExecutablePath: executablePath, reportIsStale: false },
                );
                console.info("[COFECHA耗时]", { executionAndQueueMs: Math.round(executionFinished - validationStarted),
                    parseReferenceAndPersistMs: Math.round(performance.now() - executionFinished), totalMs: Math.round(performance.now() - validationStarted) });
            } finally {
                if (requestId === cofechaRequestIdRef.current) {
                    setIsCofechaRunning(false);
                }
            }
        };
        const promise = perform();
        pendingValidationRef.current = { key: validationKey, promise };
        try { await promise; }
        finally { if (pendingValidationRef.current?.promise === promise) pendingValidationRef.current = null; }
    }, [cofechaUndatedSource, selectedPart, settings.cofecha.engine, settings.cofecha.executablePath]);

    // Editing invalidates the report/reference immediately. Rebuild from the current
    // working RWL after a short debounce so suggestions return without saving the file.
    // The existing identity/in-flight guards collapse duplicate save, switch and edit runs.
    useEffect(() => {
        const filePath = filePathRef.current;
        if (!filePath) return undefined;
        const validationCurrent = validationMatchesCurrentInputs(lastCofechaValidationRef.current,
            siteDataSignature, filePath, settings.cofecha.engine, settings.cofecha.executablePath,
            cofechaUndatedSource);
        if (!shouldScheduleAutomaticValidation({ filePath, siteSize: siteData.size,
            isLoading: isFileLoadingRef.current, engine: settings.cofecha.engine,
            executablePath: settings.cofecha.executablePath, validationCurrent })) return undefined;

        const timer = window.setTimeout(() => {
            const editor = rwlEditorRef.current;
            if (filePathRef.current !== filePath) return;
            const inputData = editor.getData();
            const inputHash = hashRwlSiteData(inputData);
            if (inputHash !== siteDataSignature) return;
            void runCofechaAndApplyResult(editor.exportAsRwlString(), filePath, {
                engine: settings.cofecha.engine,
                inputData,
                undated: cofechaUndatedSource,
                workspaceGuard: { editor, filePath, inputHash },
            }).catch((error) => console.error("编辑后自动刷新 COFECHA 报告失败", error));
        }, COFECHA_AUTO_REFRESH_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [cofechaUndatedSource, runCofechaAndApplyResult, settings.cofecha.engine,
        settings.cofecha.executablePath, siteData, siteDataSignature]);

    const handleLoad = useCallback(async () => {
        if (isFileLoadingRef.current) {
            return;
        }
        isFileLoadingRef.current = true;
        let loadingPath: string | undefined;
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
            loadingPath = filePath;

            setIsFileLoading(true);
            // Flush the previous file's debounced journal before reading any
            // draft. An old timer must not overwrite a later "use disk" choice.
            if (historyPersistTimerRef.current !== null) {
                window.clearTimeout(historyPersistTimerRef.current);
                historyPersistTimerRef.current = null;
                if (filePathRef.current) {
                    await persistHistorySnapshot(filePathRef.current, rwlEditorRef.current);
                }
            }
            workspaceEpochRef.current += 1;
            cofechaRequestIdRef.current += 1;
            setIsCofechaRunning(false);

            const rwlData = await readRwlFile(filePath);
            let nextEditor = new RwlEditor(rwlData.data, rwlData.readOptions, rwlData.format);
            // 在恢复草稿前抓取磁盘内容快照，作为"已保存基线"。
            const diskBaseline = nextEditor.getData();
            const [persistedReference, persistedCofecha, persistedHistory, persistedTreeRingScans] = await Promise.all([
                loadPersistedReferenceState(filePath),
                loadPersistedCofechaState(filePath),
                loadPersistedHistorySnapshot(filePath),
                loadPersistedTreeRingScanState(filePath),
            ]);
            let restoredUndatedSource: CofechaUndatedSource | null = null;
            if (persistedCofecha?.undated?.filePath) {
                try {
                    const rwlText = await readTextFile(persistedCofecha.undated.filePath);
                    const inputSignature = hashValidationText(rwlText);
                    if (inputSignature === persistedCofecha.cofechaUndatedInputSignature) {
                        restoredUndatedSource = { ...persistedCofecha.undated, rwlText, inputSignature };
                    }
                } catch (error) {
                    console.warn("无法恢复未定年 COFECHA 输入:", error);
                }
            }

            // 恢复本地缓存草稿（操作日志快照）。草稿可能因未保存的编辑、或磁盘文件被外部
            // 改动而与磁盘内容不一致；不一致时弹框让用户选择载入哪一个，而不是默默套用草稿。
            if (persistedHistory) {
                nextEditor = await resolveWorkspaceDraft(filePath, nextEditor, persistedHistory, async () => {
                    const baseName = filePath.split(/\\|\//).pop() || filePath;
                    return ask(
                        `“${baseName}” 存在未保存的本地编辑缓存，且与磁盘文件内容不一致。\n\n要载入哪一个版本？`,
                        {
                            title: "本地缓存与磁盘文件不一致",
                            kind: "warning",
                            okLabel: "本地缓存（保留未保存的编辑）",
                            cancelLabel: "磁盘文件（放弃缓存）",
                        },
                    );
                });
            }
            replaceEditor(nextEditor, diskBaseline, filePath);
            filePathRef.current = filePath;
            const restoredContext = nextEditor.toHistorySnapshot().workspaceContext;
            const restoredReferenceConfig = normalizeReferenceSeriesConfig(
                restoredContext ? restoredContext.referenceConfig : persistedReference?.referenceConfig ?? null,
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
            const loadedData = nextEditor.getData();
            const loadedHash = hashRwlSiteData(loadedData);
            const loadedText = nextEditor.exportAsRwlString();
            const persistedEngine = persistedCofecha ? getPersistedCofechaEngine(persistedCofecha) : null;
            const persistedReportFresh = Boolean(persistedCofecha?.outFileContent)
                && persistedCofecha?.reportIsStale !== true
                && persistedCofecha?.cofechaInputSignature === loadedHash
                && persistedEngine === settings.cofecha.engine
                && persistedCofecha?.cofechaJsVersion === COFECHA_JS_VERSION
                && (persistedEngine !== "official" || (persistedCofecha?.reportExecutablePath ?? "") === settings.cofecha.executablePath.trim())
                && (persistedCofecha?.undated?.filePath ?? null) === (restoredUndatedSource?.filePath ?? null)
                && (persistedCofecha?.undated?.sort ?? null) === (restoredUndatedSource?.sort ?? null);
            const dynamicReferenceConfig = restoredDynamicReferenceConfig?.mode === "dynamic"
                ? persistedReportFresh ? restoredDynamicReferenceConfig : { ...restoredDynamicReferenceConfig, isStale: true }
                : null;
            setReferenceConfig(manualReferenceConfig);
            setDynamicReferenceConfig(dynamicReferenceConfig);
            setCofechaUndatedSource(restoredUndatedSource);
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
                if (restoredSelectedPart === "PART 8" && !restoredUndatedSource) restoredSelectedPart = ALL_OPTION_VALUE;
                setOutFileContent(persistedCofecha.outFileContent);
                setCofechaResult(restoredResult);
                setPossibleProblemsDetail(restoredResult?.possibleProblemsDetail ?? new Map());
                setCofechaParts(splitReportByParts(persistedCofecha.outFileContent));
                setSelectedPart(restoredSelectedPart);
                // 恢复 .OUT 对应数据的签名：使打开已定年文件时，若 .OUT 仍匹配当前数据，
                // 诊断可立即用上 COFECHA（无需先重跑一次）。
                if (persistedReportFresh) {
                    lastCofechaValidationRef.current = {
                        inputSignature: loadedHash,
                        inputText: loadedText,
                        sourcePath: filePath,
                        engine: settings.cofecha.engine,
                        executablePath: settings.cofecha.engine === "official" ? settings.cofecha.executablePath.trim() : null,
                        cofechaJsVersion: COFECHA_JS_VERSION,
                        undatedInputText: restoredUndatedSource?.rwlText ?? null,
                        undatedSourcePath: restoredUndatedSource?.filePath ?? null,
                        undatedSort: restoredUndatedSource?.sort ?? null,
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
            setTreeRingScanState(restoredContext?.scans ?? persistedTreeRingScans ?? createEmptyTreeRingScanState());
            setDiagnosisBatchResult(null);

            try {
                await runCofechaAndApplyResult(loadedText, filePath, {
                    reuseUnchanged: true,
                    selectedPart: restoredSelectedPart,
                    inputData: loadedData,
                    undated: restoredUndatedSource,
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
            await showRwlReadError(error, loadingPath);
        } finally {
            isFileLoadingRef.current = false;
            setIsFileLoading(false);
        }
    }, [replaceEditor, runCofechaAndApplyResult]);

    const enqueueSave = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
        return saveQueueRef.current.enqueue(async () => {
            saveOperationCountRef.current += 1;
            setIsSaveRunning(true);
            try {
                return await operation();
            } finally {
                saveOperationCountRef.current -= 1;
                if (saveOperationCountRef.current === 0) {
                    setIsSaveRunning(false);
                }
            }
        });
    }, []);

    const handleRunBreadthDiagnosis = useCallback(() => {
        const filePath = filePathRef.current;
        const currentData = rwlEditorRef.current.getData();
        const automaticReference = selectAutomaticDiagnosisReferenceConfig(
            latestDynamicReferenceConfigRef.current,
        );
        if (!filePath
            || currentData.size === 0
            || isFileLoadingRef.current
            || !automaticReference) return;
        const flaggedTargets = orderBreadthScanTargets(
            Array.from(currentData.keys()),
            automaticReference.classification?.candidateFlaggedIds ?? [],
        );
        if (flaggedTargets.length === 0) return;
        setBreadthScanRequest({
            id: ++breadthScanRequestCounterRef.current,
            filePath,
            dataSignature: hashRwlSiteData(currentData),
        });
    }, []);

    const markDataSnapshotAsSaved = useCallback((savedData: RwlSiteData) => {
        const currentData = rwlEditorRef.current.getData();
        const matchesSavedSnapshot = rwlDataEquals(savedData, currentData);
        originalDataRef.current = savedData;
        setSiteData(previous => rwlDataEquals(previous, currentData) ? previous : currentData);
        setIsModified(!matchesSavedSnapshot);
        return matchesSavedSnapshot;
    }, []);

    const getCurrentRwlText = useCallback((tree?: string) => (
        rwlEditorRef.current.exportAsRwlString(tree)
    ), []);

    const applyParsedRwlText = useCallback(async (rawText: string) => {
        const sourceMarker = await detectPrecision(rawText);
        const rwlData = await readRwlString(rawText, { stopMarker: sourceMarker });
        syncStopMarkerFromSiteData(rwlData.data);
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
        if (rwlData.readOptions?.stopMarkerValue !== undefined && rwlData.readOptions.stopMarkerValue !== stopMarker.value) {
            throw new Error("当前是旧精度工作区，请先保留工作进度并重新导入RWL，再使用单序列文本编辑，避免混用工作单位。");
        }
        const parsedTreeData = rwlData.data.get(tree) ?? rwlData.data.values().next().value;
        if (parsedTreeData) {
            rwlEditorRef.current.replaceTreeData(tree, parsedTreeData);
        }
        return rwlEditorRef.current.getData();
    }, []);

    const commitChartOffsetsForSave = useCallback((
        editor: RwlEditor,
        pendingOffsets: ReadonlyMap<string, number>,
        onCommitted?: (offsets: ReadonlyMap<string, number>) => void,
    ): boolean => {
        if (pendingOffsets.size === 0) return true;
        try {
            editor.applyWholeSeriesOffsets(pendingOffsets);
            markCurrentDiagnosisStale();
            onCommitted?.(new Map(pendingOffsets));
            return true;
        } catch (error) {
            const detail = error instanceof RwlBatchMoveConflictError
                ? error.message
                : error instanceof Error
                    ? error.message
                    : String(error);
            window.alert(`无法应用图表偏移，保存已取消：\n${detail}`);
            return false;
        }
    }, [markCurrentDiagnosisStale]);

    const handleSave = useCallback(async (
        pendingOffsets: ReadonlyMap<string, number> = new Map(),
        onOffsetsCommitted?: (offsets: ReadonlyMap<string, number>) => void,
    ) => {
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
            if (!commitChartOffsetsForSave(editor, pendingOffsets, onOffsetsCommitted)) return;
            const rwlString = editor.exportAsRwlString();
            const savedData = editor.getData();
            const sourceHash = hashRwlSiteData(savedData);
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

            try {
                await runCofechaAndApplyResult(rwlString, filePath, {
                    reuseUnchanged: true,
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
    }, [commitChartOffsetsForSave, enqueueSave, markDataSnapshotAsSaved, runCofechaAndApplyResult]);

    const handleRunCofechaValidation = useCallback(async () => {
        const filePath = filePathRef.current;
        if (!filePath || isCofechaRunning || isFileLoadingRef.current) {
            return;
        }
        if (settings.cofecha.engine === "official" && !settings.cofecha.executablePath.trim()) {
            await message("请先通过“运行 > 加载 COFECHA...”或“设置 > COFECHA”选择从 LTRR 获取的 EXE 文件。", {
                title: "需要加载 COFECHA",
                kind: "info",
            });
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
                    engine: settings.cofecha.engine,
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
            await message(error instanceof Error ? error.message : String(error), {
                title: "COFECHA 运行失败",
                kind: "error",
            });
        }
    }, [isCofechaRunning, runCofechaAndApplyResult, settings.cofecha.engine, settings.cofecha.executablePath]);

    useEffect(() => {
        const identity = reportEngineIdentity(settings.cofecha.engine, settings.cofecha.executablePath);
        if (activeCofechaEngineRef.current === identity) return;
        activeCofechaEngineRef.current = identity;
        cofechaRequestIdRef.current += 1;
        setIsCofechaRunning(false);
        lastCofechaValidationRef.current = null;
        setDynamicReferenceConfig((previous) => {
            const stale = previous?.mode === "dynamic" ? { ...previous, isStale: true } : previous;
            latestDynamicReferenceConfigRef.current = stale;
            return stale;
        });

        const filePath = filePathRef.current;
        if (!filePath || isFileLoadingRef.current) return;
        if (settings.cofecha.engine === "official" && !settings.cofecha.executablePath.trim()) return;
        const editor = rwlEditorRef.current;
        const inputData = editor.getData();
        const inputHash = hashRwlSiteData(inputData);
        void runCofechaAndApplyResult(editor.exportAsRwlString(), filePath, {
            engine: settings.cofecha.engine,
            inputData,
            undated: cofechaUndatedSource,
            workspaceGuard: { editor, filePath, inputHash },
        }).catch((error) => console.error("切换 COFECHA 报告引擎失败", error));
    }, [cofechaUndatedSource, runCofechaAndApplyResult, settings.cofecha.engine, settings.cofecha.executablePath]);

    const runCurrentCofechaWithUndated = useCallback(async (undated: CofechaUndatedSource | null,
        nextSelectedPart: string) => {
        const filePath = filePathRef.current;
        if (!filePath || isFileLoadingRef.current || isCofechaRunning) return false;
        if (settings.cofecha.engine === "official" && !settings.cofecha.executablePath.trim()) {
            await message("请先在设置中选择官方 COFECHA EXE，或切换到 JavaScript 引擎。", {
                title: "需要 COFECHA 引擎", kind: "info",
            });
            return false;
        }
        const editor = rwlEditorRef.current;
        const inputData = editor.getData();
        const inputHash = hashRwlSiteData(inputData);
        await runCofechaAndApplyResult(editor.exportAsRwlString(), filePath, {
            engine: settings.cofecha.engine,
            selectedPart: nextSelectedPart,
            inputData,
            undated,
            workspaceGuard: { editor, filePath, inputHash },
        });
        return true;
    }, [isCofechaRunning, runCofechaAndApplyResult, settings.cofecha.engine, settings.cofecha.executablePath]);

    const markCofechaInputsStale = useCallback(() => {
        setDynamicReferenceConfig((previous) => {
            const stale = previous?.mode === "dynamic" ? { ...previous, isStale: true } : previous;
            latestDynamicReferenceConfigRef.current = stale;
            return stale;
        });
    }, []);

    const handleLoadCofechaUndated = useCallback(async () => {
        if (!filePathRef.current || isCofechaRunning) return;
        const selected = await open({ title: "加载未定年 RWL", multiple: false, directory: false,
            filters: [{ name: "Tucson RWL", extensions: ["rwl"] }, { name: "所有文件", extensions: ["*"] }] });
        if (typeof selected !== "string") return;
        if (selected.toLowerCase() === filePathRef.current.toLowerCase()) {
            await message("未定年输入不能与当前dated工作区使用同一文件。", { title: "请选择另一份 RWL", kind: "info" });
            return;
        }
        try {
            const rwlText = await readTextFile(selected);
            const source: CofechaUndatedSource = { filePath: selected,
                fileName: selected.split(/[\\/]/).pop() || "UNDATED.RWL", rwlText,
                inputSignature: hashValidationText(rwlText), sort: cofechaUndatedSource?.sort ?? "correlation" };
            setCofechaUndatedSource(source);
            markCofechaInputsStale();
            if (await runCurrentCofechaWithUndated(source, "PART 8")) {
                setSelectedPart("PART 8");
            }
        } catch (error) {
            await message(error instanceof Error ? error.message : String(error), { title: "未定年分析失败", kind: "error" });
        }
    }, [cofechaUndatedSource?.sort, isCofechaRunning, markCofechaInputsStale, runCurrentCofechaWithUndated]);

    const handleClearCofechaUndated = useCallback(async () => {
        if (!cofechaUndatedSource || isCofechaRunning) return;
        setCofechaUndatedSource(null);
        markCofechaInputsStale();
        if (await runCurrentCofechaWithUndated(null, ALL_OPTION_VALUE)) {
            setSelectedPart(ALL_OPTION_VALUE);
        }
    }, [cofechaUndatedSource, isCofechaRunning, markCofechaInputsStale, runCurrentCofechaWithUndated]);

    const handleCofechaUndatedSortChange = useCallback(async (sort: CofechaUndatedSort) => {
        if (!cofechaUndatedSource || cofechaUndatedSource.sort === sort || isCofechaRunning) return;
        const next = { ...cofechaUndatedSource, sort };
        setCofechaUndatedSource(next);
        markCofechaInputsStale();
        if (await runCurrentCofechaWithUndated(next, "PART 8")) {
            setSelectedPart("PART 8");
        }
    }, [cofechaUndatedSource, isCofechaRunning, markCofechaInputsStale, runCurrentCofechaWithUndated]);

    const handleExportCofechaOut = useCallback(async (): Promise<string | null> => {
        if (!outFileContent) return null;
        const sourceName = filePathRef.current?.split(/[\\/]/).pop() ?? "VERYCOF.OUT";
        const sourceStem = sourceName.replace(/\.[^.]+$/, "") || "VERYCOF";
        try {
            const exportPath = await save({
                title: "导出 COFECHA OUT",
                defaultPath: `${sourceStem}.OUT`,
                filters: [{ name: "COFECHA OUT", extensions: ["out"] }],
            });
            if (!exportPath) return null;
            await saveFile(exportPath, outFileContent);
            return exportPath;
        } catch (error) {
            console.error("导出 COFECHA OUT 失败:", error);
            window.alert(`导出 COFECHA OUT 失败：${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }, [outFileContent]);

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

            try {
                await runCofechaAndApplyResult(rawText, filePath, {
                    reuseUnchanged: true,
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
    }, [applyParsedRwlText, enqueueSave, markDataSnapshotAsSaved, runCofechaAndApplyResult]);

    const handleSaveAs = useCallback(async (
        pendingOffsets: ReadonlyMap<string, number> = new Map(),
        onOffsetsCommitted?: (offsets: ReadonlyMap<string, number>) => void,
    ) => {
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
            if (!commitChartOffsetsForSave(editor, pendingOffsets, onOffsetsCommitted)) return;
            const rwlString = editor.exportAsRwlString();
            const savedData = editor.getData();
            const sourceHash = hashRwlSiteData(savedData);
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
                await Promise.all([
                    persistHistorySnapshot(filePathToSave, editor),
                    persistReferenceState(
                        filePathToSave,
                        referenceConfig,
                        dynamicReferenceConfig,
                        referenceOperationLog,
                        referenceOperationCounterRef.current,
                    ),
                    persistTreeRingScanState(filePathToSave, treeRingScanState),
                ]);
                return markDataSnapshotAsSaved(savedData);
            });
            if (!matchesSavedSnapshot) {
                return;
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
    }, [commitChartOffsetsForSave, dynamicReferenceConfig, enqueueSave, markDataSnapshotAsSaved, referenceConfig, referenceOperationLog, runCofechaAndApplyResult, treeRingScanState]);

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
                await Promise.all([
                    persistHistorySnapshot(filePathToSave, editor),
                    persistReferenceState(
                        filePathToSave,
                        referenceConfig,
                        dynamicReferenceConfig,
                        referenceOperationLog,
                        referenceOperationCounterRef.current,
                    ),
                    persistTreeRingScanState(filePathToSave, treeRingScanState),
                ]);
                return markDataSnapshotAsSaved(savedData);
            });
            if (!matchesSavedSnapshot) {
                return;
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
    }, [applyParsedRwlText, dynamicReferenceConfig, enqueueSave, markDataSnapshotAsSaved, referenceConfig, referenceOperationLog, runCofechaAndApplyResult, treeRingScanState]);

    const handleUndo = useCallback(() => {
        triggerHistoryAnimation(rwlEditorRef.current.undo());
        syncStopMarkerFromSiteData(rwlEditorRef.current.getData());
    }, [triggerHistoryAnimation]);

    const handleRedo = useCallback(() => {
        triggerHistoryAnimation(rwlEditorRef.current.redo());
        syncStopMarkerFromSiteData(rwlEditorRef.current.getData());
    }, [triggerHistoryAnimation]);

    const handleUndoOperationLogEntry = useCallback((entryId: string) => {
        triggerHistoryAnimation(rwlEditorRef.current.undoOperationLogEntry(entryId));
        syncStopMarkerFromSiteData(rwlEditorRef.current.getData());
    }, [triggerHistoryAnimation]);

    const handleResetToRawData = useCallback(() => {
        triggerHistoryAnimation(rwlEditorRef.current.resetToRawData());
        syncStopMarkerFromSiteData(rwlEditorRef.current.getData());
    }, [triggerHistoryAnimation]);

    const handleInsertMissingYearAtSide = useCallback((tree: string, nextYear: number, side: "left" | "right") => {
        rwlEditorRef.current.insertMissingYearAtSide(tree, nextYear, side);
    }, []);

    const handleMoveSeriesTailByOffset = useCallback((
        tree: string,
        selectedStartYear: number,
        selectedEndYear: number,
        yearOffset: number,
        conflictPolicy: RwlMoveConflictPolicy = "reject",
    ) => {
        try {
            rwlEditorRef.current.moveSeriesTailByOffset(
                tree,
                selectedStartYear,
                selectedEndYear,
                yearOffset,
                undefined,
                conflictPolicy,
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
            if (candidate) {
                const applied = applyDiagnosisCandidate(candidate);
                if (applied) markCurrentDiagnosisStale();
                return applied;
            }
            const treeData = rwlEditorRef.current.getData().get(event.seriesId);
            if (!treeData) return false;
            const plan = planWholeSeriesDiagnosisMove(event, treeData, stopMarker.value);
            if (!plan) return false;
            const { startYear, endYear, shiftYears } = plan;
            rwlEditorRef.current.moveSeriesTailByOffset(
                event.seriesId,
                startYear,
                endYear,
                shiftYears,
                {
                    operationType: "APPLY_SUGGESTION",
                    source: "auto-suggested",
                    reason: `统一诊断模型整体移动 ${shiftYears} 年`,
                    metricsBefore: { eventId: event.id, startYear, endYear },
                    metricsAfter: { operation: "SHIFT_RANGE", shiftYears },
                },
            );
            triggerHistoryAnimation({
                type: "move-selection",
                tree: event.seriesId,
                selectedStartYear: startYear,
                selectedEndYear: endYear,
                yearOffset: shiftYears,
                direction: "redo",
            });
            const applied = true;
            if (applied) markCurrentDiagnosisStale();
            return applied;
        }

        const treeData = rwlEditorRef.current.getData().get(event.seriesId);
        if (!treeData) return false;
        const editableYears = Array.from(treeData.entries())
            .filter(([, value]) => value !== stopMarker.value)
            .map(([year]) => year);
        if (editableYears.length === 0) return false;
        const plan = planManuallyConfirmedDiagnosisEventEdit(
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
            const sourceEvent = getDisplayedDiagnosisEvents(crossdatingDiagnosis).find(
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

    const handleDeleteYearRange = useCallback((
        tree: string,
        startYear: number,
        endYear: number,
        fill: DeleteRangeFill,
    ) => {
        rwlEditorRef.current.deleteYearRange(tree, startYear, endYear, fill);
    }, []);

    const handleRestoreDeletion = useCallback((tree: string, markerYear: number, index: number) => {
        rwlEditorRef.current.restoreDeletion(tree, markerYear, index);
    }, []);

    const handleRemoveDeletionMarker = useCallback((tree: string, markerYear: number) => {
        rwlEditorRef.current.removeDeletionMarker(tree, markerYear);
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

    const handleReplaceTreeData = useCallback((tree: string, data: Map<number, number | null>) => {
        rwlEditorRef.current.replaceTreeData(tree, data);
    }, []);

    const handleReplaceSiteData = useCallback((data: RwlSiteData, nextStopMarkerValue?: number, nextDisplayMarkerValue?: number) => {
        const editor = rwlEditorRef.current;
        const previousTrees = Array.from(editor.getData().keys());
        const nextTrees = Array.from(data.keys());
        const treeKeyMap = new Map<string, string>();
        previousTrees.forEach((tree, index) => {
            const nextTree = nextTrees[index];
            if (nextTree) treeKeyMap.set(tree, nextTree);
        });
        if (nextStopMarkerValue === 999 || nextStopMarkerValue === -9999) {
            stopMarker.value = nextStopMarkerValue;
        }
        const previousReadOptions = editor.getReadOptions();
        const precisionChanged = nextStopMarkerValue === 999 || nextStopMarkerValue === -9999;
        const nextReadOptions = previousReadOptions ? {
            ...previousReadOptions,
            stopMarkerValue: precisionChanged ? nextStopMarkerValue : previousReadOptions.stopMarkerValue,
            // Explicit whole-file precision replacement overrides source markers;
            // ordinary renaming carries the source precision to the new ID.
            tucsonSegments: previousReadOptions.tucsonSegments?.map(s => ({ ...s, id: treeKeyMap.get(s.id) ?? s.id,
                marker: nextDisplayMarkerValue === 999 || nextDisplayMarkerValue === -9999 ? nextDisplayMarkerValue : s.marker })),
            tucsonOutputMarkers: nextDisplayMarkerValue === 999 || nextDisplayMarkerValue === -9999
                ? Object.fromEntries(nextTrees.map(id => [id,nextDisplayMarkerValue])) : precisionChanged ? undefined : previousReadOptions.tucsonOutputMarkers
                ? Object.fromEntries(Object.entries(previousReadOptions.tucsonOutputMarkers)
                    .map(([id, marker]) => [treeKeyMap.get(id) ?? id, marker])) : undefined,
        } : undefined;
        editor.replaceAllData(
            data,
            nextReadOptions,
            editor.getFormat() as RwlFormat,
            { preserveDeletionMarkers: true, treeKeyMap },
        );
        setSelectedTree((previous) => {
            const nextSelectedTree = previous !== ALL_OPTION_VALUE && !data.has(previous)
                ? ALL_OPTION_VALUE
                : previous;
            selectedTreeRef.current = nextSelectedTree;
            return nextSelectedTree;
        });
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
        selectedTreeRef.current = nextTree;
        setSelectedTree(nextTree);
    }, []);

    const selectedProblemText = getCofechaSeriesMapValue(possibleProblemsDetail, selectedTree);
    const workspaceOperationLog = useMemo(() => (
        operationLog
            .map((entry) => normalizeWorkspaceOperationLogEntry(entry, filePathRef.current))
            .sort((a, b) => (
                new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            ))
    ), [fileName, operationLog]);
    const diagnosisReferenceConfig = selectAutomaticDiagnosisReferenceConfig(dynamicReferenceConfig);
    const diagnosisReferenceReady = diagnosisReferenceConfig !== null;
    const diagnosisSourceMarker = stopMarker.value;
    useEffect(() => {
        let cancelled = false;
        let startTimer: number | null = null;
        const requestId = ++diagnosisRequestIdRef.current;
        const targetTree = selectedTree !== ALL_OPTION_VALUE && siteData.has(selectedTree)
            ? selectedTree
            : null;

        if (!settings.diagnosis.enabled || !targetTree) {
            diagnosisWorkerRef.current?.terminate();
            diagnosisWorkerRef.current = null;
            setIsEventDiagnosisRunning(false);
            startTransition(() => setCrossdatingDiagnosis(createEmptyCrossdatingDiagnosis()));
            return undefined;
        }

        if (!diagnosisReferenceReady) {
            diagnosisWorkerRef.current?.terminate();
            diagnosisWorkerRef.current = null;
            setIsEventDiagnosisRunning(false);
            startTransition(() => setCrossdatingDiagnosis(createEmptyCrossdatingDiagnosis()));
            return undefined;
        }

        const lastValidation = lastCofechaValidationRef.current;
        const cofechaFresh = Boolean(outFileContent) && validationMatchesCurrentInputs(lastValidation,
            siteDataSignature, filePathRef.current, settings.cofecha.engine,
            settings.cofecha.executablePath, cofechaUndatedSource);
        const diagnosisCofechaText = cofechaFresh ? outFileContent : undefined;
        let resultCache = diagnosisResultCacheRef.current;
        if (resultCache?.siteData !== siteData
            || resultCache.sourceStopMarker !== diagnosisSourceMarker) {
            resultCache = {
                siteData,
                sourceStopMarker: diagnosisSourceMarker,
                referenceConfig: diagnosisReferenceConfig,
                cofechaText: diagnosisCofechaText,
                results: new Map(),
                reviewResults: new Map(),
            };
            diagnosisResultCacheRef.current = resultCache;
        } else if (!resultCache.reviewResults) {
            resultCache.reviewResults = new Map();
        }
        const cachedDiagnosis = resultCache.results.get(targetTree);
        if (cachedDiagnosis?.authoritativeModelDecision?.modelVersion === UNIFIED_V5_RUNTIME_VERSION) {
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

            // Keep the module worker warm across diagnoses. Recreating it in development reloads
            // the full diagnosis bundle and makes every series switch pay worker startup again.
            const worker = diagnosisWorkerRef.current
                ?? new Worker(new URL("./diagnosisWorker.ts", import.meta.url), { type: "module" });
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


                if ("error" in response) {
                    setIsEventDiagnosisRunning(false);
                    console.warn("内部诊断计算失败:", response.error);
                    return;
                }

                setIsEventDiagnosisRunning(false);
                console.info(
                    `[统一模型诊断] ${targetTree}`
                    + ` · JS证据 ${Math.round(response.evidenceElapsedMs)} ms`
                    + ` · 构包 ${Math.round(response.packageElapsedMs)} ms`
                    + ` · 模型 ${Math.round(response.modelElapsedMs)} ms`
                    + ` · 总计 ${Math.round(response.elapsedMs)} ms`
                    + ` · ${response.diagnosis.authoritativeModelDecision?.status ?? "error"}`,
                );
                resultCache.results.set(targetTree, response.diagnosis);
                resultCache.reviewResults.set(targetTree, response.diagnosis);
                startTransition(() => {
                    setCrossdatingDiagnosis(response.diagnosis);
                });
            };

            worker.onerror = (event) => {
                if (diagnosisWorkerRef.current === worker) {
                    worker.terminate();
                    diagnosisWorkerRef.current = null;
                }
                setIsEventDiagnosisRunning(false);
                console.warn("内部诊断 worker 运行失败:", event.message);
            };

            // v5 reads the current RWL only; the report supplies availability,
            // not model features, so an OUT-only refresh cannot change this input.
            worker.postMessage({
                id: requestId,
                siteData,
                sourceStopMarker: diagnosisSourceMarker,
                referenceReady: diagnosisReferenceReady,
                targetTree,
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
            // Keep preprocessing/model caches warm. The worker coalesces newer
            // requests; request IDs above discard superseded responses.
        };
        // v5 rebuilds its own evidence from RWL values. OUT/reference refreshes
        // alone do not change inference inputs or invalidate the cached answer.
    }, [cofechaUndatedSource, diagnosisReferenceReady, diagnosisSourceMarker, markCurrentDiagnosisStale,
        outFileContent, selectedTree, settings.cofecha.engine, settings.cofecha.executablePath,
        settings.diagnosis.enabled, siteData, siteDataSignature]);

    const breadthScanTargets = useMemo(() => orderBreadthScanTargets(
        Array.from(siteData.keys()),
        diagnosisReferenceConfig?.classification?.candidateFlaggedIds ?? [],
    ), [diagnosisReferenceConfig, siteData]);

    // Data or evidence changes invalidate the A-flag-only view immediately. Only an explicit
    // click on the breadth navigator creates a new scan request.
    useEffect(() => {
        breadthDiagnosisWorkerRef.current?.terminate();
        breadthDiagnosisWorkerRef.current = null;
        breadthScanContextRef.current = null;

        if (breadthFileNameRef.current !== fileName) {
            breadthFileNameRef.current = fileName;
            breadthFirstSeenOrderRef.current = 0;
            breadthLastSuggestionBySeriesRef.current.clear();
        }

        const generation = ++breadthGenerationCounterRef.current;
        setBreadthScanGeneration(generation);
        setBreadthDiagnosisNavigator(siteData.size > 0
            ? {
                status: diagnosisReferenceConfig && breadthScanTargets.length === 0
                    ? "complete"
                    : "stale",
                scannedCount: 0,
                totalCount: breadthScanTargets.length,
                suggestions: [],
            }
            : createEmptyBreadthDiagnosisNavigator());
    }, [breadthScanTargets, diagnosisReferenceConfig, fileName, outFileContent, possibleProblemsDetail, siteData, siteDataSignature]);

    useEffect(() => {
        if (!breadthScanRequest
            || breadthConsumedScanRequestRef.current >= breadthScanRequest.id) {
            return;
        }
        breadthConsumedScanRequestRef.current = breadthScanRequest.id;

        if (filePathRef.current !== breadthScanRequest.filePath
            || siteDataSignature !== breadthScanRequest.dataSignature
            || siteData.size === 0) {
            return;
        }

        const lastValidation = lastCofechaValidationRef.current;
        const cofechaFresh = Boolean(outFileContent) && validationMatchesCurrentInputs(lastValidation,
            siteDataSignature, filePathRef.current, settings.cofecha.engine,
            settings.cofecha.executablePath, cofechaUndatedSource);
        const diagnosisCofechaText = cofechaFresh ? outFileContent : undefined;
        const flaggedTrees = diagnosisReferenceConfig?.classification?.candidateFlaggedIds ?? [];
        const previousPriorityTrees = sortBreadthDiagnosisSuggestions(
            breadthLastSuggestionBySeriesRef.current.values(),
        ).map((suggestion) => suggestion.seriesId);
        const generation = ++breadthGenerationCounterRef.current;
        const pending = orderBreadthScanTargets(
            Array.from(siteData.keys()),
            flaggedTrees,
            previousPriorityTrees,
        );

        breadthScanContextRef.current = {
            generation,
            siteData,
            referenceConfig: diagnosisReferenceConfig,
            cofechaText: diagnosisCofechaText,
            pending,
            targets: new Set(pending),
            scanned: new Set(),
            suggestions: new Map(),
            attempts: new Map(),
            totalCount: pending.length,
        };
        setBreadthDiagnosisNavigator(siteData.size > 0
            ? {
                status: pending.length > 0 ? "stale" : "complete",
                scannedCount: 0,
                totalCount: pending.length,
                suggestions: [],
            }
            : createEmptyBreadthDiagnosisNavigator());
        setBreadthScanGeneration(generation);
    }, [
        breadthScanRequest,
        cofechaUndatedSource,
        diagnosisReferenceConfig,
        outFileContent,
        settings.cofecha.engine,
        settings.cofecha.executablePath,
        siteData,
        siteDataSignature,
    ]);

    useEffect(() => {
        const context = breadthScanContextRef.current;
        if (!context || context.generation !== breadthScanGeneration || context.totalCount === 0) {
            return undefined;
        }

        const pauseReason: BreadthScanPauseReason | undefined = isFileLoading
            ? "file-load"
            : isSaveRunning
                ? "save"
                : isCofechaRunning
                    ? "cofecha"
                    : isEventDiagnosisRunning
                        ? "selected-diagnosis"
                        : undefined;
        const visibleSuggestions = () => sortBreadthDiagnosisSuggestions(
            Array.from(context.suggestions.values()).filter((suggestion) => (
                suggestion.seriesId !== selectedTree
            )),
        );
        const scannedCount = () => {
            const selectedDelegated = selectedTree !== ALL_OPTION_VALUE
                && context.targets.has(selectedTree)
                && !context.scanned.has(selectedTree)
                ? 1
                : 0;
            return Math.min(context.totalCount, context.scanned.size + selectedDelegated);
        };
        const publish = (
            status: BreadthDiagnosisNavigatorState["status"],
            nextPauseReason?: BreadthScanPauseReason,
        ) => {
            setBreadthDiagnosisNavigator({
                status,
                ...(nextPauseReason ? { pauseReason: nextPauseReason } : {}),
                scannedCount: scannedCount(),
                totalCount: context.totalCount,
                suggestions: visibleSuggestions(),
            });
        };

        const hasRunnableTarget = context.pending.some((tree) => tree !== selectedTree);
        if (!hasRunnableTarget) {
            publish("complete");
            return undefined;
        }

        if (pauseReason) {
            publish("paused", pauseReason);
            return undefined;
        }

        let cancelled = false;
        let nextTimer: number | null = null;
        let activeTarget: string | null = null;
        let activeRequestId: number | null = null;

        const processDiagnosis = (targetTree: string, diagnosis: CrossdatingDiagnosis) => {
            context.scanned.add(targetTree);
            const reviewEvent = diagnosis.reviewEvents?.find((event) => (
                event.seriesId === targetTree && !event.stale
            ));
            if (reviewEvent) {
                const previous = context.suggestions.get(targetTree)
                    ?? breadthLastSuggestionBySeriesRef.current.get(targetTree);
                const suggestion = createBreadthDiagnosisSuggestion(
                    reviewEvent,
                    previous,
                    ++breadthFirstSeenOrderRef.current,
                    Date.now(),
                    context.siteData,
                );
                context.suggestions.set(targetTree, suggestion);
                breadthLastSuggestionBySeriesRef.current.set(targetTree, suggestion);
            } else {
                context.suggestions.delete(targetTree);
                breadthLastSuggestionBySeriesRef.current.delete(targetTree);
            }
            publish("scanning");
        };

        const scheduleNext = (callback: () => void, delay = BREADTH_SCAN_DELAY_MS) => {
            nextTimer = window.setTimeout(() => {
                nextTimer = null;
                callback();
            }, delay);
        };

        const scanNext = () => {
            if (cancelled || breadthScanContextRef.current !== context) return;

            const targetIndex = context.pending.findIndex((tree) => tree !== selectedTree);
            if (targetIndex < 0) {
                publish("complete");
                console.info(
                    `[JS A 标记诊断] 完成 ${scannedCount()}/${context.totalCount} · 待复核 ${visibleSuggestions().length}`,
                );
                return;
            }

            const [targetTree] = context.pending.splice(targetIndex, 1);
            activeTarget = targetTree;
            const currentCache = diagnosisResultCacheRef.current;
            const cacheMatches = currentCache?.siteData === context.siteData
                && currentCache.sourceStopMarker === stopMarker.value;
            const cachedDiagnosis = cacheMatches
                ? currentCache.reviewResults?.get(targetTree)
                : undefined;
            if (cachedDiagnosis?.authoritativeModelDecision?.modelVersion === UNIFIED_V5_RUNTIME_VERSION) {
                activeTarget = null;
                processDiagnosis(targetTree, cachedDiagnosis);
                scheduleNext(scanNext, 0);
                return;
            }

            const worker = breadthDiagnosisWorkerRef.current
                ?? new Worker(new URL("./diagnosisWorker.ts", import.meta.url), { type: "module" });
            breadthDiagnosisWorkerRef.current = worker;
            const requestId = ++breadthDiagnosisRequestIdRef.current;
            activeRequestId = requestId;

            worker.onmessage = (event: MessageEvent<DiagnosisWorkerResponse>) => {
                const response = event.data;
                if (cancelled
                    || breadthScanContextRef.current !== context
                    || response.id !== activeRequestId
                    || response.id !== breadthDiagnosisRequestIdRef.current) {
                    return;
                }

                if ("error" in response) {
                    activeTarget = null;
                    activeRequestId = null;
                    const attempts = (context.attempts.get(targetTree) ?? 0) + 1;
                    context.attempts.set(targetTree, attempts);
                    if (attempts < 2) {
                        context.pending.push(targetTree);
                    } else {
                        context.scanned.add(targetTree);
                        console.warn(`[JS 广度诊断] ${targetTree} 计算失败:`, response.error);
                    }
                    worker.terminate();
                    if (breadthDiagnosisWorkerRef.current === worker) {
                        breadthDiagnosisWorkerRef.current = null;
                    }
                    publish("scanning");
                    scheduleNext(scanNext);
                    return;
                }

                activeTarget = null;
                activeRequestId = null;

                let resultCache = diagnosisResultCacheRef.current;
                if (resultCache?.siteData !== context.siteData
                    || resultCache.sourceStopMarker !== stopMarker.value) {
                    resultCache = {
                        siteData: context.siteData,
                        sourceStopMarker: stopMarker.value,
                        referenceConfig: context.referenceConfig,
                        cofechaText: context.cofechaText,
                        results: new Map(),
                        reviewResults: new Map(),
                    };
                    diagnosisResultCacheRef.current = resultCache;
                }
                resultCache.reviewResults ??= new Map();
                resultCache.reviewResults.set(targetTree, response.diagnosis);
                resultCache.results.set(targetTree, response.diagnosis);
                processDiagnosis(targetTree, response.diagnosis);
                scheduleNext(scanNext);
            };

            worker.onerror = (event) => {
                if (cancelled || breadthScanContextRef.current !== context) return;
                const attempts = (context.attempts.get(targetTree) ?? 0) + 1;
                context.attempts.set(targetTree, attempts);
                activeTarget = null;
                activeRequestId = null;
                if (attempts < 2) {
                    context.pending.push(targetTree);
                } else {
                    context.scanned.add(targetTree);
                    console.warn(`[JS 广度诊断] ${targetTree} worker 失败:`, event.message);
                }
                worker.terminate();
                if (breadthDiagnosisWorkerRef.current === worker) {
                    breadthDiagnosisWorkerRef.current = null;
                }
                publish("scanning");
                scheduleNext(scanNext);
            };

            publish("scanning");
            worker.postMessage({
                id: requestId,
                siteData: context.siteData,
                sourceStopMarker: stopMarker.value,
                referenceReady: context.referenceConfig !== null,
                targetTree,
            } satisfies DiagnosisWorkerRequest);
        };

        scanNext();
        return () => {
            cancelled = true;
            if (nextTimer !== null) {
                window.clearTimeout(nextTimer);
            }
            if (activeTarget && !context.scanned.has(activeTarget)) {
                context.pending.unshift(activeTarget);
            }
            const worker = breadthDiagnosisWorkerRef.current;
            if (worker) {
                worker.terminate();
                breadthDiagnosisWorkerRef.current = null;
            }
        };
    }, [
        breadthScanGeneration,
        isCofechaRunning,
        isEventDiagnosisRunning,
        isFileLoading,
        isSaveRunning,
        selectedTree,
    ]);

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

        return !validationMatchesCurrentInputs(lastValidation, siteDataSignature, filePathRef.current,
            settings.cofecha.engine, settings.cofecha.executablePath, cofechaUndatedSource);
    }, [cofechaResult, cofechaUndatedSource, settings.cofecha.engine, settings.cofecha.executablePath, siteDataSignature]);
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
    const canRunBreadthDiagnosis = diagnosisReferenceConfig !== null && siteData.size > 0;

    const exportCurrentWorkspace = useCallback(async (): Promise<boolean> => {
        const path = filePathRef.current;
        if (!path) throw new Error("请先在主窗口打开RWL文件");
        const frozen = new RwlEditor(new Map());
        frozen.restorePersistedHistory(rwlEditorRef.current.toHistorySnapshot());
        const scans = structuredClone(treeRingScanState);
        const reference = referenceConfig ? structuredClone(referenceConfig) : null;
        const chosen = await save({ title: "导出当前文件工作区", defaultPath: (path.split(/[\\/]/).pop() ?? "workspace.rwl").replace(/\.rwl$/i, ".cdworkspace"),
            filters: [{ name: "Crossdating 工作区", extensions: ["cdworkspace"] }] });
        if (!chosen) return false;
        const destination = chosen.toLowerCase().endsWith(".cdworkspace") ? chosen : `${chosen}.cdworkspace`;
        const hashes = new Map<string, string>();
        for (const [key, state] of Object.entries(scans.series)) {
            if (!state.anchors.length) continue;
            const original = scans.filesBySeries[key]?.path;
            if (original && state.imagePath === original) {
                if (!hashes.has(original)) hashes.set(original, await invoke<string>("workspace_file_sha256", { path: original }));
                if (state.imageSha256 && state.imageSha256 !== hashes.get(original)) throw new Error("扫描原图内容已改变，不能将旧标注绑定到新图；请重新校准该影像");
                state.imageSha256 = hashes.get(original)!;
            } else if (!state.imageSha256) throw new Error("扫描标注缺少原图校验信息，请先重新关联扫描文件夹");
        }
        const bytes = await exportWorkspacePackage({ fileName: path, editor: frozen, reference, scans });
        await writeFile(destination, bytes);
        return true;
    }, [referenceConfig, treeRingScanState]);

    const handleExportWorkspace = useCallback(async () => {
        if (transferRunningRef.current || isFileLoadingRef.current) return;
        transferRunningRef.current = true;
        try { if (await exportCurrentWorkspace()) await message("工作区已导出，包含当前未保存修改及原始对比基线。", { title: "导出完成" }); }
        catch (error) { await message(String(error), { title: "工作区导出失败", kind: "error" }); }
        finally { transferRunningRef.current = false; }
    }, [exportCurrentWorkspace]);

    const handleExportEffectiveChanges = useCallback(async () => {
        if (transferRunningRef.current || isFileLoadingRef.current) return;
        transferRunningRef.current = true;
        try {
            if (!filePathRef.current) throw new Error("请先打开RWL文件");
            const csv = effectiveChangesCsv(rwlEditorRef.current.toHistorySnapshot());
            const path = await save({ title: "导出有效修改记录", defaultPath: "有效修改记录.csv",
                filters: [{ name: "CSV（UTF-8，Excel兼容）", extensions: ["csv"] }] });
            if (path) await saveFile(path.toLowerCase().endsWith(".csv") ? path : `${path}.csv`, csv);
        } catch (error) { await message(String(error), { title: "导出失败", kind: "error" }); }
        finally { transferRunningRef.current = false; }
    }, []);

    const handleImportWorkspace = useCallback(async (): Promise<boolean> => {
        if (transferRunningRef.current || isFileLoadingRef.current || saveOperationCountRef.current > 0) return false;
        transferRunningRef.current = true;
        const originalEpoch = workspaceEpochRef.current;
        try {
            const selected = await open({ title: "导入工作区", multiple: false, filters: [{ name: "Crossdating 工作区", extensions: ["cdworkspace"] }] });
            if (typeof selected !== "string") return false;
            if ((await lstat(selected)).size > MAX_PACKAGE_BYTES) throw new Error("工作区包超过64 MiB");
            const bundle = await importWorkspacePackage(await readFile(selected));
            const fingerprint = () => JSON.stringify({ ...rwlEditorRef.current.toHistorySnapshot(), savedAt: undefined });
            const protectedState = fingerprint();
            // Validation has completed; only now ask the user to protect/replace work.
            if (filePathRef.current && !rwlDataEquals(originalDataRef.current, rwlEditorRef.current.getData())) {
                if (!await ask("当前文件存在未保存修改。先导出当前工作区备份，再继续导入？", {
                    title: "保护当前工作", okLabel: "导出备份并继续", cancelLabel: "取消导入", kind: "warning" })) return false;
                if (!await exportCurrentWorkspace()) return false;
            }
            let targetPath: string | null = null;
            let matches: "current" | "baseline" | "both" | "mismatch" = "mismatch";
            let newFile = false;
            while (!targetPath) {
                const chosen = await open({ title: "选择原始基线或当前版本RWL（取消可将包内数据另存）", multiple: false,
                    filters: [{ name: "RWL", extensions: ["rwl"] }] });
                if (typeof chosen === "string") {
                    matches = await matchWorkspaceRwl(bundle, await readTextFile(chosen));
                    if (matches !== "mismatch") { targetPath = chosen; break; }
                    if (await ask("该文件的内容既不是包内原始基线，也不是包内当前版本。重新选择RWL文件？", {
                        title: "文件内容不匹配", okLabel: "重新选择", cancelLabel: "使用包内版本", kind: "warning" })) continue;
                }
                if (!await ask("将包内当前版本另存为一个新的RWL文件，并恢复完整工作区？", {
                    title: "打开包内版本", okLabel: "选择新文件位置", cancelLabel: "取消导入" })) return false;
                const location = await save({ title: "为包内当前版本选择新RWL文件", defaultPath: bundle.manifest.fileName,
                    filters: [{ name: "RWL", extensions: ["rwl"] }] });
                if (!location) return false;
                targetPath = location.toLowerCase().endsWith(".rwl") ? location : `${location}.rwl`;
                if (await exists(targetPath)) throw new Error("为保护原始文件，请为包内版本选择尚不存在的新文件名");
                matches = "current"; newFile = true;
            }
            if (!await ask(`将工作区导入到“${targetPath.split(/[\\/]/).pop()}”。匹配版本：${matches === "baseline" ? "原始基线" : matches === "both" ? "原始与当前版本一致" : "当前版本"}。\n将替换该文件的本地草稿、操作记录和标注；已有RWL文件不会修改。继续？`, {
                title: "确认工作区导入", okLabel: "导入完整状态", cancelLabel: "取消", kind: "warning" })) return false;
            if (workspaceEpochRef.current !== originalEpoch || fingerprint() !== protectedState) throw new Error("确认期间当前工作区发生变化，请重新导入以保护最新修改");
            isFileLoadingRef.current = true; setIsFileLoading(true);
            if (historyPersistTimerRef.current !== null) {
                window.clearTimeout(historyPersistTimerRef.current); historyPersistTimerRef.current = null;
            }
            if (filePathRef.current) {
                rwlEditorRef.current.setWorkspaceContext({ referenceConfig, scans: treeRingScanState });
                await persistImportedHistorySnapshot(filePathRef.current, rwlEditorRef.current);
            }
            if (newFile) await saveFile(targetPath, workspaceRwl(bundle.workspace.history));
            const editor = await commitWorkspaceImport(bundle, targetPath);
            // From here the imported editor is committed as one complete state.
            const baselineData = matches === "baseline" ? bundle.workspace.history.comparisonBaseline!.data : bundle.workspace.history.workingData!;
            const baseline = new Map(baselineData.map(([id, entries]) => [id, new Map(entries)]));
            workspaceEpochRef.current++; cofechaRequestIdRef.current++;
            lastCofechaValidationRef.current = null; pendingValidationRef.current = null;
            filePathRef.current = targetPath;
            stopMarker.value = bundle.workspace.history.readOptions!.stopMarkerValue!;
            clearTreeRingScanImageCache();
            replaceEditor(editor, baseline, targetPath);
            setFileName(targetPath); setTreeOptions([...editor.getData().keys()]);
            selectedTreeRef.current = ALL_OPTION_VALUE; setSelectedTree(ALL_OPTION_VALUE);
            const context = editor.toHistorySnapshot().workspaceContext!;
            setReferenceConfig(context.referenceConfig); setReferenceOperationLog([]); referenceOperationCounterRef.current = 0;
            setTreeRingScanState(context.scans); setDynamicReferenceConfig(null); latestDynamicReferenceConfigRef.current = null;
            setOutFileContent(""); setCofechaResult(undefined); setCofechaParts(new Map()); setPossibleProblemsDetail(new Map());
            setCofechaUndatedSource(null); setSelectedPart(ALL_OPTION_VALUE); setDiagnosisBatchResult(null); setIsCofechaRunning(false);
            isFileLoadingRef.current = false; setIsFileLoading(false);
            try { await runCofechaAndApplyResult(editor.exportAsRwlString(), targetPath, { inputData: editor.getData(), undated: null,
                workspaceGuard: { editor, filePath: targetPath, inputHash: hashRwlSiteData(editor.getData()) } }); }
            catch (error) { await message(`工作区已导入；报告需重新验证：${String(error)}`, { title: "工作区已恢复", kind: "warning" }); }
            return true;
        } catch (error) { await message(String(error), { title: "工作区导入失败", kind: "error" }); return false; }
        finally { transferRunningRef.current = false; isFileLoadingRef.current = false; setIsFileLoading(false); }
    }, [exportCurrentWorkspace, referenceConfig, treeRingScanState, replaceEditor, runCofechaAndApplyResult]);

    const displayUnits = useMemo(() => buildRwlDisplayUnits(siteData, rwlEditorRef.current.getReadOptions()), [siteData, operationLog]);
    return {
        displayUnits,
        handleExportEffectiveChanges,
        handleExportWorkspace,
        handleImportWorkspace,
        cofechaResult,
        cofechaEngine: settings.cofecha.engine,
        cofechaUndatedFileName: cofechaUndatedSource?.fileName ?? null,
        cofechaUndatedSort: cofechaUndatedSource?.sort ?? "correlation",
        hasCofechaPart8: cofechaParts.has("PART 8"),
        breadthDiagnosisNavigator,
        canRunBreadthDiagnosis,
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
        handleLoadTreeRingScanFolder,
        handleDeleteYearRange,
        handleMoveSeriesTailByOffset,
        handleApplyDiagnosisCandidate,
        handleApplyDiagnosisCandidateBatch,
        handleApplyDiagnosisEvent,
        handleApplyLocalSimulation,
        handleReferenceConfigChange,
        handleRedo,
        handleReplaceSiteData,
        handleReplaceTreeData,
        handleResetToRawData,
        handleRemoveDeletionMarker,
        handleRestoreDeletion,
        handleExportCofechaOut,
        handleLoadCofechaUndated,
        handleClearCofechaUndated,
        handleCofechaUndatedSortChange,
        handleRunCofechaValidation,
        handleRunBreadthDiagnosis,
        handleSaveRawText,
        handleSaveRawTextAs,
        handleSave,
        handleSaveAs,
        handleTreeSelectionChange,
        handleTreeRingScanSeriesChange,
        handleUndo,
        handleUndoOperationLogEntry,
        applyRawRwlText,
        applyRawRwlTextForTree,
        getCurrentRwlText,
        hasChart,
        hasProblems,
        historyAnimation,
        isCofechaOutdated,
        canExportCofechaOut: Boolean(outFileContent),
        isCofechaRunning,
        isEventDiagnosisRunning,
        isFileLoading,
        isModified,
        operationLog: workspaceOperationLog,
        rwlOperationLog: allRwlOperationLog,
        possibleProblemsDetail,
        problemTextColor,
        referenceConfig,
        processingText,
        reportText,
        cofechaPart6Text,
        selectedPart,
        selectedProblemText,
        selectedTree,
        setSelectedPart,
        shouldShowProcessing,
        shouldShowWelcome,
        siteData,
        treeRingScanState,
        treeOptions,
        windowTitle,
    };
}
