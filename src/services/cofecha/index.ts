import type { CofechaEngine, CofechaUndatedInput } from "@/features/cofecha/types";
import { runCofechaJs } from "./jsRunner";
import { runOfficialCofecha } from "./runner";

export type RunCofechaReportOptions = {
  engine: CofechaEngine;
  rwlText: string;
  inputFileName?: string;
  executablePath?: string;
  undated?: CofechaUndatedInput;
};

/** Runs the selected report engine and normalizes both implementations to one OUT contract. */
export async function runCofechaReport({
  engine,
  rwlText,
  inputFileName,
  executablePath,
  undated,
}: RunCofechaReportOptions): Promise<string> {
  if (engine === "javascript") {
    return runCofechaJs(rwlText, inputFileName, undated);
  }
  return runOfficialCofecha(rwlText, inputFileName, executablePath, undated);
}

export { runCofechaJs, runCofechaJsInline } from "./jsRunner";
export { runOfficialCofecha } from "./runner";
