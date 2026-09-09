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

/** Both engines return the same complete, in-memory OUT text contract. */
export async function runCofechaReport(options: RunCofechaReportOptions): Promise<string> {
  if (options.engine === "javascript") {
    return runCofechaJs(options.rwlText, options.inputFileName, options.undated);
  }
  return runOfficialCofecha(options.rwlText, options.inputFileName, options.executablePath, options.undated);
}

export { COFECHA_JS_VERSION, COFECHA_RUNTIME_REVISION, runCofechaJs, runCofechaJsInline } from "./jsRunner";
export { runOfficialCofecha } from "./runner";
