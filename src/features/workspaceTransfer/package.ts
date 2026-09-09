import { strFromU8, strToU8, unzipSync, zip } from "fflate";
import { RwlEditor, type RwlPersistedHistorySnapshot, type SerializedRwlSiteData } from "@/features/rwl/edit";
import { parseTucson, formatTucson } from "@/features/rwl/parsers/tucson";
import type { ReferenceSeriesConfig } from "@/features/crossdating/reference";
import { createEmptyTreeRingScanState, isPersistedTreeRingScanState, type PersistedTreeRingScanState } from "@/features/treeRingScans";
import { check, validateHistory } from "./validation";
import { version as appVersion } from "../../../package.json";

export type PortableWorkspace = { version: 1; history: RwlPersistedHistorySnapshot;
    reference: Pick<ReferenceSeriesConfig, "selectedTrees" | "minSampleDepth" | "method"> | null;
    scans: PersistedTreeRingScanState };
export type WorkspaceManifest = { format: "CrossdatingWorkspace"; version: 1; appVersion: string; exportedAt: string;
    fileName: string; workspaceSha256: string; currentRwlSha256: string; baselineRwlSha256: string;
    currentIdentitySha256: string; baselineIdentitySha256: string };
export type ValidatedWorkspace = { manifest: WorkspaceManifest; workspace: PortableWorkspace };
const MAX_JSON_BYTES = 256 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((value) => value.toString(16).padStart(2, "0")).join("");
const hashText = (text: string) => sha256(strToU8(text));
const mapSite = (data: SerializedRwlSiteData) => new Map(data.map(([id, entries]) => [id, new Map(entries)]));
export function workspaceRwl(history: RwlPersistedHistorySnapshot, baseline = false): string {
    const source = baseline ? history.comparisonBaseline! : { data: history.workingData!, readOptions: history.readOptions };
    return formatTucson(mapSite(source.data), source.readOptions?.tucsonLong ?? false, undefined, source.readOptions);
}
async function rwlIdentity(text: string): Promise<string> {
    // Fixed fine unit makes identity independent of whitespace, record order,
    // source path, and lossless coarse/fine formatting changes.
    const parsed = parseTucson(text, { stopMarker: -9999 });
    const canonical = [...parsed.data].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([id, tree]) => [id, [...tree].filter(([, value]) => value !== -9999 && value !== null).sort(([a], [b]) => a - b)]);
    return hashText(JSON.stringify(canonical));
}
export async function matchWorkspaceRwl(bundle: ValidatedWorkspace, text: string): Promise<"current" | "baseline" | "both" | "mismatch"> {
    const id = await rwlIdentity(text);
    const current = id === bundle.manifest.currentIdentitySha256, baseline = id === bundle.manifest.baselineIdentitySha256;
    return current && baseline ? "both" : current ? "current" : baseline ? "baseline" : "mismatch";
}

function portableScans(source: PersistedTreeRingScanState): PersistedTreeRingScanState {
    const result = structuredClone(source);
    result.folderPath = null;
    result.filesBySeries = {};
    for (const value of Object.values(result.series)) { delete value.imagePath; value.mode = "generated"; }
    return result;
}
function validateWorkspace(value: unknown): asserts value is PortableWorkspace {
    check(value && typeof value === "object", "工作区内容错误");
    const payload = value as PortableWorkspace;
    check(payload.version === 1, "不支持的工作区内容版本");
    validateHistory(payload.history);
    check(payload.history.workspaceContext === undefined, "包内工作区上下文必须使用顶层唯一来源");
    check(payload.reference === null || (typeof payload.reference === "object" && Array.isArray(payload.reference.selectedTrees)
        && payload.reference.selectedTrees.every((id) => typeof id === "string") && Number.isInteger(payload.reference.minSampleDepth)
        && payload.reference.minSampleDepth > 0 && payload.reference.method === "mean"), "参考配置错误");
    check(isPersistedTreeRingScanState(payload.scans), "扫描标注结构错误");
    check(payload.scans.folderPath === null && Object.keys(payload.scans.filesBySeries).length === 0, "包不能携带可执行的扫描路径");
    for (const state of Object.values(payload.scans.series)) {
        check(state.imagePath === undefined && state.mode === "generated", "扫描影像必须在目标电脑重新关联");
        check(state.imageSha256 === undefined || /^[a-f0-9]{64}$/.test(state.imageSha256), "扫描影像指纹错误");
        check(state.anchors.length === 0 || state.imageSha256 !== undefined, "扫描标注缺少可验证的原图指纹");
        for (const key of ["baselineStartYear", "baselineEndYear", "baselineOperationSequence"] as const)
            check(state[key] === undefined || Number.isSafeInteger(state[key]), "扫描校准基线错误");
        check(state.baselineOperationSequence === undefined || state.baselineOperationSequence <= payload.history.operationLogCounter, "扫描基线超出日志");
        check(state.baselineWidths === undefined || (Array.isArray(state.baselineWidths) && state.baselineWidths.every((row) =>
            Array.isArray(row) && row.length === 2 && Number.isSafeInteger(row[0]) && Number.isSafeInteger(row[1]))), "扫描基线轮宽错误");
        for (const anchor of state.anchors) check(Number.isSafeInteger(anchor.originalYear) && anchor.xRatio >= 0 && anchor.xRatio <= 1
            && anchor.yRatio >= 0 && anchor.yRatio <= 1, "扫描标注坐标错误");
        if (state.crop) check(state.crop.xRatio >= 0 && state.crop.yRatio >= 0 && state.crop.widthRatio <= 1
            && state.crop.heightRatio <= 1 && state.crop.xRatio + state.crop.widthRatio <= 1.000001
            && state.crop.yRatio + state.crop.heightRatio <= 1.000001, "扫描截面超出原图");
    }
}

export async function exportWorkspacePackage(input: { fileName: string; editor: RwlEditor; reference: ReferenceSeriesConfig | null;
    scans?: PersistedTreeRingScanState }): Promise<Uint8Array> {
    const history = input.editor.toHistorySnapshot();
    delete history.workspaceContext;
    // Fill explicit precision for legacy single-unit snapshots; never infer it
    // from the number of digits in measurements.
    const markerOf = (data: SerializedRwlSiteData) => data.some(([, entries]) => entries.some(([, v]) => v === -9999)) ? -9999 : 999;
    history.readOptions = { ...history.readOptions, stopMarkerValue: history.readOptions?.stopMarkerValue ?? markerOf(history.rawData!) };
    history.rawReadOptions = { ...history.rawReadOptions, stopMarkerValue: history.rawReadOptions?.stopMarkerValue ?? markerOf(history.rawData!) };
    const base = history.comparisonBaseline!;
    base.readOptions = { ...base.readOptions, stopMarkerValue: base.readOptions?.stopMarkerValue ?? markerOf(base.data) };
    for (const [, entries] of history.operationLogBySeries!) for (const entry of entries) delete entry.projectId;
    const workspace: PortableWorkspace = { version: 1, history,
        reference: input.reference?.mode !== "dynamic" && input.reference ? { selectedTrees: [...input.reference.selectedTrees],
            minSampleDepth: input.reference.minSampleDepth, method: "mean" } : null,
        scans: portableScans(input.scans ?? createEmptyTreeRingScanState()) };
    validateWorkspace(workspace);
    const content = strToU8(JSON.stringify(workspace));
    check(content.byteLength <= MAX_JSON_BYTES, "工作区超过256 MiB，请缩小工作区");
    const current = workspaceRwl(history), baseline = workspaceRwl(history, true);
    const manifest: WorkspaceManifest = { format: "CrossdatingWorkspace", version: 1, appVersion, exportedAt: new Date().toISOString(),
        fileName: input.fileName.split(/[\\/]/).pop() || "workspace.rwl", workspaceSha256: await sha256(content),
        currentRwlSha256: await hashText(current), baselineRwlSha256: await hashText(baseline),
        currentIdentitySha256: await rwlIdentity(current), baselineIdentitySha256: await rwlIdentity(baseline) };
    return new Promise((resolve, reject) => zip({ "manifest.json": strToU8(JSON.stringify(manifest)), "workspace.json": content },
        { level: 6 }, (error, data) => error ? reject(error) : data.byteLength > MAX_PACKAGE_BYTES
            ? reject(new Error("压缩工作区超过64 MiB")) : resolve(data)));
}

export async function importWorkspacePackage(bytes: Uint8Array): Promise<ValidatedWorkspace> {
    check(bytes.length <= MAX_PACKAGE_BYTES, "压缩包超过64 MiB");
    const names = new Set<string>();
    const entries = unzipSync(bytes, { filter: (entry) => {
        check(["manifest.json", "workspace.json"].includes(entry.name) && !names.has(entry.name), "ZIP条目未知、重复或包含路径");
        names.add(entry.name);
        check(entry.originalSize <= (entry.name === "manifest.json" ? 16384 : MAX_JSON_BYTES), "ZIP解压大小超限");
        return true;
    } });
    check(names.size === 2, "ZIP必须包含manifest.json及workspace.json");
    const manifest = JSON.parse(strFromU8(entries["manifest.json"])) as WorkspaceManifest;
    check(manifest?.format === "CrossdatingWorkspace" && manifest.version === 1, "不支持的工作区包版本");
    check(typeof manifest.fileName === "string" && !/[\\/]/.test(manifest.fileName), "文件名无效");
    check(typeof manifest.appVersion === "string" && typeof manifest.exportedAt === "string", "包元数据缺失");
    check(await sha256(entries["workspace.json"]) === manifest.workspaceSha256, "工作区SHA-256校验失败");
    const workspace: unknown = JSON.parse(strFromU8(entries["workspace.json"]));
    validateWorkspace(workspace);
    const current = workspaceRwl(workspace.history), baseline = workspaceRwl(workspace.history, true);
    check(await hashText(current) === manifest.currentRwlSha256 && await hashText(baseline) === manifest.baselineRwlSha256,
        "RWL文件内容校验失败");
    check(await rwlIdentity(current) === manifest.currentIdentitySha256 && await rwlIdentity(baseline) === manifest.baselineIdentitySha256,
        "基线或当前数据身份不一致");
    return { manifest, workspace };
}

export function restoredWorkspaceEditor(bundle: ValidatedWorkspace, targetPath: string): RwlEditor {
    // Revalidate even when called outside the file import entry point.
    validateWorkspace(bundle.workspace);
    const snapshot = structuredClone(bundle.workspace.history);
    for (const [, entries] of snapshot.operationLogBySeries!) for (const entry of entries) entry.projectId = targetPath;
    const editor = new RwlEditor(new Map());
    editor.restorePersistedHistory(snapshot);
    editor.setProjectId(targetPath);
    editor.setWorkspaceContext({ referenceConfig: bundle.workspace.reference
        ? { ...bundle.workspace.reference, mode: "manual", updatedAt: new Date().toISOString() } : null, scans: bundle.workspace.scans });
    return editor;
}
