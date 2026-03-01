import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, remove } from "@tauri-apps/plugin-fs";

const COFECHA_WORK_DIR_NAME = "cofecha-work";

export interface ClearWorkDirResult {
  dir: string;
  removedPaths: string[];
  failedPaths: Array<{ path: string; reason: string }>;
}

async function ensureDir(dir: string): Promise<string> {
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Returns app data directory, creating it when needed.
 */
export async function getWorkDir(): Promise<string> {
  return ensureDir(await appDataDir());
}

/**
 * Returns the dedicated COFECHA workspace directory under app data.
 */
export async function getCofechaWorkDir(): Promise<string> {
  const baseDir = await getWorkDir();
  return ensureDir(await join(baseDir, COFECHA_WORK_DIR_NAME));
}

/**
 * Clears all files/subdirectories under `cofecha-work`, while preserving the root directory.
 */
export async function clearWorkDir(): Promise<ClearWorkDirResult> {
  const dir = await getCofechaWorkDir();
  const removedPaths: string[] = [];
  const failedPaths: Array<{ path: string; reason: string }> = [];

  const entries = await readDir(dir);
  for (const entry of entries) {
    if (!entry.name) {
      continue;
    }

    const entryPath = await join(dir, entry.name);
    try {
      await remove(entryPath, { recursive: true });
      removedPaths.push(entryPath);
    } catch (error) {
      failedPaths.push({ path: entryPath, reason: getErrorMessage(error) });
    }
  }

  await ensureDir(dir);
  return { dir, removedPaths, failedPaths };
}
