import type { CofechaEngine } from "@/features/cofecha/types";
import { runCofechaJs } from "./jsRunner";
import { runOfficialCofecha } from "./runner";

export type RunCofechaReportOptions = {
  engine: CofechaEngine;
  rwlText: string;
  inputFileName?: string;
  executablePath?: string;
};

/** Runs the selected report engine and normalizes both implementations to one OUT contract. */
export async function runCofechaReport({
  engine,
  rwlText,
  inputFileName,
  executablePath,
}: RunCofechaReportOptions): Promise<string> {
  if (engine === "javascript") {
    return runCofechaJs(rwlText, inputFileName);
  }
  return runOfficialCofecha(rwlText, inputFileName, executablePath);
}

export { runCofechaJs, runCofechaJsInline } from "./jsRunner";
export { runOfficialCofecha } from "./runner";
