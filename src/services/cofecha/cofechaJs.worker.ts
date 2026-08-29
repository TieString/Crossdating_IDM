import { runCofecha } from "cofecha-js";
import type { CofechaJsWorkerRequest, CofechaJsWorkerResponse } from "./jsWorkerProtocol";

globalThis.addEventListener("message", (event: MessageEvent<CofechaJsWorkerRequest>) => {
  const { id, request } = event.data;
  try {
    const { outText } = runCofecha(request);
    globalThis.postMessage({ id, ok: true, outText } satisfies CofechaJsWorkerResponse);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    globalThis.postMessage({
      id,
      ok: false,
      error: { name: normalized.name, message: normalized.message },
    } satisfies CofechaJsWorkerResponse);
  }
});
