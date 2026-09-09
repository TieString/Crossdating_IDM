import { RwlEditor, type RwlPersistedHistorySnapshot } from "@/features/rwl/edit";
import { persistHistorySnapshot } from "./workspacePersistence";
import { rwlDataEquals } from "./workspaceState";

/** Commit a disk/draft choice to both the editor and its per-file cache.
 * The caller must flush pending edits before reading the persisted snapshot.
 */
export async function resolveWorkspaceDraft(
    filePath: string,
    diskEditor: RwlEditor,
    snapshot: RwlPersistedHistorySnapshot,
    chooseCachedDraft: () => Promise<boolean>,
): Promise<RwlEditor> {
    const restored = new RwlEditor(diskEditor.getData(), diskEditor.getReadOptions(), diskEditor.getFormat());
    restored.restorePersistedHistory(snapshot);
    if (rwlDataEquals(diskEditor.getData(), restored.getData()) || await chooseCachedDraft()) {
        return restored;
    }

    // No editor change event fires when replacing an editor. Persist now, not
    // after the user's next edit/save, so reopening cannot resurrect the draft.
    diskEditor.setProjectId(filePath);
    await persistHistorySnapshot(filePath, diskEditor);
    return diskEditor;
}
