import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseCofechaResult, splitReportByParts } from "@/features/cofecha/formatter";
import type { ICofechaResult } from "@/features/cofecha/types";
import { detectPrecision, readRwlString } from "@/features/rwl";
import { RwlEditor, registerChangeYearWidth } from "@/features/rwl/edit";
import type { DeleteMode, DeleteShift, RwlDeletionMarkers, RwlHistoryAnimation, RwlHistoryStatus, RwlOperationLogEntry, RwlPersistedHistorySnapshot } from "@/features/rwl/edit";
import type { RwlSiteData } from "@/features/rwl/types";
import { runCofecha } from "@/services/cofecha/runner";
import { readRwlFile, saveFile } from "@/services/fs/io";
import { stopMarker } from "@/shared/constants";
import { ALL_OPTION_VALUE, CofechaVersion, DEFAULT_HOME_TITLE } from "./constants";

export type WidthHistoryAnimation = RwlHistoryAnimation & { id: number };

const HISTORY_STORAGE_PREFIX = "crossdating:rwl-operation-journal:v1:";

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

const getHistoryStorageKey = (filePath: string) => `${HISTORY_STORAGE_PREFIX}${filePath}`;

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

const hydratePersistedHistory = (editor: RwlEditor, filePath: string) => {
    const snapshot = loadPersistedHistorySnapshot(filePath);
    if (!snapshot) return;

    editor.restoreOperationLog(snapshot.operationLog);
};

export function useHomeWorkspace() {
    const rwlEditorRef = useRef<RwlEditor>(new RwlEditor(new Map()));
    const originalDataRef = useRef<RwlSiteData>(new Map());
    const filePathRef = useRef<string | null>(null);
    const historyAnimationIdRef = useRef(0);

    const [siteData, setSiteData] = useState<RwlSiteData>(() => rwlEditorRef.current.getData());
    const [deletionMarkers, setDeletionMarkers] = useState<RwlDeletionMarkers>(() => rwlEditorRef.current.getDeletionMarkers());
    const [operationLog, setOperationLog] = useState<RwlOperationLogEntry[]>(() => rwlEditorRef.current.getOperationLog());
    const [historyStatus, setHistoryStatus] = useState<RwlHistoryStatus>(() => rwlEditorRef.current.getHistoryStatus());
    const [treeOptions, setTreeOptions] = useState<string[]>([]);
    const [selectedTree, setSelectedTree] = useState<string>(ALL_OPTION_VALUE);
    const [historyAnimation, setHistoryAnimation] = useState<WidthHistoryAnimation | null>(null);
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

    const syncEditor = useCallback((editor: RwlEditor) => {
        editor.registerChangeCallback(() => {
            const nextData = editor.getData();
            setIsModified(!rwlDataEquals(originalDataRef.current, nextData));
            setSiteData(nextData);
            setTreeOptions(Array.from(nextData.keys()));
            setDeletionMarkers(editor.getDeletionMarkers());
            setOperationLog(editor.getOperationLog());
            setHistoryStatus(editor.getHistoryStatus());
            if (filePathRef.current) {
                persistHistorySnapshot(filePathRef.current, editor);
            }
        });
    }, []);

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

    const replaceEditor = useCallback((nextEditor: RwlEditor) => {
        rwlEditorRef.current = nextEditor;
        syncEditor(nextEditor);
        const nextData = nextEditor.getData();
        originalDataRef.current = nextData;
        setSiteData(nextData);
        setDeletionMarkers(nextEditor.getDeletionMarkers());
        setOperationLog(nextEditor.getOperationLog());
        setHistoryStatus(nextEditor.getHistoryStatus());
        setHistoryAnimation(null);
        setIsModified(false);
    }, [syncEditor]);

    const runCofechaAndApplyResult = useCallback(async (input: string, sourcePath: string) => {
        setIsCofechaRunning(true);

        try {
            const baseName = sourcePath.split(/\\|\//).pop() || "INPUT.RWL";
            const nextOutText = await runCofecha(input, baseName, sourcePath, cofechaVersion);
            const nextResult = parseCofechaResult(nextOutText);

            setOutFileContent(nextOutText);
            setCofechaResult(nextResult);
            setPossibleProblemsDetail(nextResult.possibleProblemsDetail);
            setCofechaParts(splitReportByParts(nextOutText));
        } finally {
            setIsCofechaRunning(false);
        }
    }, [cofechaVersion]);

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

            const content = await readTextFile(filePath);
            const rwlData = await readRwlFile(filePath);
            const nextEditor = new RwlEditor(rwlData.data, rwlData.readOptions, rwlData.format);

            hydratePersistedHistory(nextEditor, filePath);
            replaceEditor(nextEditor);
            setTreeOptions(Array.from(nextEditor.getData().keys()));
            setSelectedTree(ALL_OPTION_VALUE);
            setSelectedPart(ALL_OPTION_VALUE);
            setFileName(filePath);

            try {
                await runCofechaAndApplyResult(content, filePath);
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
            markCurrentDataAsSaved();
        } catch (error) {
            console.error("写入文件时出错:", error);
        }
    }, [markCurrentDataAsSaved]);

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
            markCurrentDataAsSaved();
        } catch (error) {
            console.error("写入文本编辑内容时出错:", error);
            throw error;
        }
    }, [applyParsedRwlText, markCurrentDataAsSaved]);

    const handleUndo = useCallback(() => {
        triggerHistoryAnimation(rwlEditorRef.current.undo());
    }, [triggerHistoryAnimation]);

    const handleRedo = useCallback(() => {
        triggerHistoryAnimation(rwlEditorRef.current.redo());
    }, [triggerHistoryAnimation]);

    const handleUndoOperationLogEntry = useCallback((entryId: string) => {
        triggerHistoryAnimation(rwlEditorRef.current.undoOperationLogEntry(entryId));
    }, [triggerHistoryAnimation]);

    const handleRedoOperationLogEntry = useCallback((entryId: string) => {
        triggerHistoryAnimation(rwlEditorRef.current.redoOperationLogEntry(entryId));
    }, [triggerHistoryAnimation]);

    const handleInsertMissingYearAtSide = useCallback((tree: string, nextYear: number, side: "left" | "right") => {
        rwlEditorRef.current.insertMissingYearAtSide(tree, nextYear, side);
    }, []);

    const handleMoveSeriesTailByOffset = useCallback((tree: string, selectedStartYear: number, selectedEndYear: number, yearOffset: number) => {
        rwlEditorRef.current.moveSeriesTailByOffset(tree, selectedStartYear, selectedEndYear, yearOffset);
    }, []);

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
    const windowTitle = formatTitle(fileName, isModified);

    return {
        cofechaResult,
        cofechaVersion,
        deletionMarkers,
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
        handleRedo,
        handleReplaceTreeData,
        handleRedoOperationLogEntry,
        handleRestoreDeletion,
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
        isFileLoading,
        isModified,
        operationLog,
        possibleProblemsDetail,
        problemTextColor,
        processingText,
        reportText,
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
