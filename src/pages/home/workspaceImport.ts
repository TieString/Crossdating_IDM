import { type ValidatedWorkspace, restoredWorkspaceEditor } from "@/features/workspaceTransfer/package";
import { persistImportedHistorySnapshot } from "./workspacePersistence";

/** Returns a new editor only after its complete snapshot is atomically durable.
 * Callers replace UI state with this editor; repeated imports never append logs.
 */
export async function commitWorkspaceImport(bundle: ValidatedWorkspace, targetPath: string) {
    const editor = restoredWorkspaceEditor(bundle, targetPath);
    await persistImportedHistorySnapshot(targetPath, editor);
    return editor;
}
