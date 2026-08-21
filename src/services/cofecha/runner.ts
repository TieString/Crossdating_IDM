import { invoke } from "@tauri-apps/api/core";
import { readTextFile, exists, remove } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { clearWorkDir, getCofechaWorkDir } from "@/services/fs";
import { saveFile } from "../fs/io";

interface CofechaProcessOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs whichever COFECHA executable the user selected; the executable is never copied. */

export async function runCofecha(
  rwlText: string,
  inputFileName?: string,
  executablePath?: string,
): Promise<string> {
  const normalizedExecutablePath = executablePath?.trim() ?? "";
  if (!normalizedExecutablePath) {
    throw new Error("尚未配置 COFECHA 可执行文件");
  }

  const cleanResult = await clearWorkDir();
  if (cleanResult.failedPaths.length > 0) {
    console.warn("workspace cleanup had failures:", cleanResult.failedPaths);
  }

  const workDir = await getCofechaWorkDir();
  const defaultInputName = "INPUT.RWL";

  const requestedName =
    inputFileName && inputFileName.trim().length > 0 ? inputFileName : defaultInputName;
  const hasNonAsciiName = /[^\x00-\x7F]/.test(requestedName);
  // 当前集成下，COFECHA 对非 ASCII 文件名不稳定，因此这里统一降级。
  const runtimeInputName = hasNonAsciiName ? defaultInputName : requestedName;
  const inputPath = await join(workDir, runtimeInputName);

  await saveFile(inputPath, rwlText);

  const processOutput = await invoke<CofechaProcessOutput>("run_external_cofecha", {
    executablePath: normalizedExecutablePath,
    runtimeInputName,
  });
  const outPath = await join(workDir, "VERYCOF.OUT");

  if (!(await exists(outPath))) {
    const detail = processOutput.stderr.trim() || processOutput.stdout.trim();
    const exitCode = processOutput.exitCode === null ? "unknown" : String(processOutput.exitCode);
    throw new Error(
      `COFECHA 未生成 VERYCOF.OUT（退出码 ${exitCode}）${detail ? `: ${detail}` : ""}`,
    );
  }

  const outRawText = await readTextFile(outPath);
  const outText = runtimeInputName !== requestedName
    ? outRawText.split(runtimeInputName).join(requestedName)
    : outRawText;

  try {
    if (runtimeInputName !== defaultInputName && (await exists(inputPath))) {
      await remove(inputPath);
    }
  } catch (error) {
    console.warn("failed to remove temporary input file:", error);
  }

  return outText;
}
