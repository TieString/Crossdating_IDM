import { runCofecha, type CofechaArtifacts, type CofechaReport, type RunCofechaRequest } from "cofecha-js";
import type { CofechaJsWorkerRequest, CofechaJsWorkerResponse } from "./jsWorkerProtocol";

let nextWorkerRequestId = 0;

const jobNameFromFileName = (fileName: string) => {
  const stem = fileName.replace(/\.[^.]+$/, "");
  return stem.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8) || "CROSSDAT";
};

export const createCofechaJsRequest = (
  rwlText: string,
  inputFileName = "INPUT.RWL",
): RunCofechaRequest => ({
  input: {
    format: "tucson-rwl",
    text: rwlText,
    fileName: inputFileName,
  },
  options: { masterOutput: "N" },
  metadata: {
    jobName: jobNameFromFileName(inputFileName),
    runAt: new Date().toISOString(),
    title: inputFileName,
  },
});

export const runCofechaJsInline = (
  rwlText: string,
  inputFileName?: string,
): CofechaArtifacts<CofechaReport> => runCofecha(createCofechaJsRequest(rwlText, inputFileName));

export const runCofechaJs = (
  rwlText: string,
  inputFileName?: string,
): Promise<string> => {
  if (typeof Worker === "undefined") {
    return Promise.resolve(runCofechaJsInline(rwlText, inputFileName).outText);
  }

  const id = ++nextWorkerRequestId;
  const worker = new Worker(new URL("./cofechaJs.worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    const finish = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<CofechaJsWorkerResponse>) => {
      if (event.data.id !== id) return;
      finish();
      if (event.data.ok) {
        resolve(event.data.outText);
      } else {
        reject(Object.assign(new Error(event.data.error.message), { name: event.data.error.name }));
      }
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "cofecha-js worker failed"));
    };
    worker.postMessage({
      id,
      request: createCofechaJsRequest(rwlText, inputFileName),
    } satisfies CofechaJsWorkerRequest);
  });
};
