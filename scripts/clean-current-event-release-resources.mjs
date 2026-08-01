import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const releaseRoot = path.resolve(repositoryRoot, "src-tauri", "target", "release");
const resourceTarget = path.resolve(releaseRoot, "current_event_ranker");
const supersededSidecar = path.resolve(
  releaseRoot,
  "current-event-single-range-sidecar.exe",
);

if (
  path.dirname(resourceTarget) !== releaseRoot
  || path.basename(resourceTarget) !== "current_event_ranker"
  || path.dirname(supersededSidecar) !== releaseRoot
) {
  throw new Error("refusing to clean current-event artifacts outside the Tauri release directory");
}

await rm(resourceTarget, { recursive: true, force: true, maxRetries: 3 });
await rm(supersededSidecar, { force: true, maxRetries: 3 });
console.log(`Cleaned stale current-event release artifacts under ${releaseRoot}`);
