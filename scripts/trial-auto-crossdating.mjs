import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";

const args = process.argv.slice(2);
const keepWorkDirs = args.includes("--keep-workdirs");
const versionArg = args.find((arg) => arg.startsWith("--version="));
const version = versionArg?.split("=")[1] === "cofecha12k" ? "cofecha12k" : "cofecha";
const maxCandidatesArg = args.find((arg) => arg.startsWith("--max-candidates="));
const maxCandidates = Math.max(1, Number(maxCandidatesArg?.split("=")[1] ?? 8));
const siteArg = args.find((arg) => arg.startsWith("--site="));
const siteFilter = siteArg?.split("=")[1]?.toLowerCase();
const explicitRoot = args.find((arg) => !arg.startsWith("--"));
const sampleRoot = explicitRoot
  ? path.resolve(process.cwd(), explicitRoot)
  : path.join(process.cwd(), "笔记", "数据");

const sidecarPath = path.join(
  process.cwd(),
  "src-tauri",
  "bin",
  `${version}-x86_64-pc-windows-msvc.exe`,
);

const isActionableCandidate = (candidate) => {
  if (candidate.operationType === "SHIFT_RANGE") {
    return candidate.suggestedLag !== 0 || Boolean(candidate.shift);
  }
  if (candidate.operationType === "INSERT_MISSING_RING" || candidate.operationType === "DELETE_FALSE_RING") {
    return candidate.targetYear !== undefined && Boolean(candidate.side);
  }
  return false;
};

const candidateLabel = (candidate) => {
  if (candidate.label) return candidate.label;
  if (candidate.operationType === "INSERT_MISSING_RING") return "insert-missing";
  if (candidate.operationType === "DELETE_FALSE_RING") return "delete-false";
  if (candidate.operationType === "SHIFT_RANGE") {
    const shift = candidate.shift ?? candidate.suggestedLag;
    return `shift ${shift > 0 ? "+" : ""}${shift}`;
  }
  return "mark";
};

async function listRawSamples(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      rawPath: path.join(root, entry.name, "RAW.rwl"),
    }))
    .filter((sample) => existsSync(sample.rawPath))
    .filter((sample) => !siteFilter || sample.name.toLowerCase() === siteFilter)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function runExecutable(executable, cwd, inputLines, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`COFECHA timed out after ${timeoutMs}ms in ${cwd}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`COFECHA exited with code=${code} signal=${signal ?? ""}\n${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.write(inputLines.join("\n"));
    child.stdin.end();
  });
}

async function runCofechaForText(rwlText, sampleName, label, parseCofechaResult) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), `crossdating-auto-${sampleName}-${label}-`));
  const inputName = "INPUT.RWL";
  const inputPath = path.join(workDir, inputName);
  const outPath = path.join(workDir, "VERYCOF.OUT");

  try {
    await writeFile(inputPath, rwlText, "utf8");
    await runExecutable(sidecarPath, workDir, [
      "very",
      inputName,
      "",
      "",
      "",
      "",
      "",
      "",
    ]);

    if (!existsSync(outPath)) {
      throw new Error(`VERYCOF.OUT not found in ${workDir}`);
    }

    const outText = await readFile(outPath, "utf8");
    const result = parseCofechaResult(outText);
    return {
      workDir,
      possibleProblemsCount: result.possibleProblemsCount,
      seriesIntercorrelation: result.seriesIntercorrelation,
      problemSeries: Array.from(result.possibleProblemsDetail.keys()).sort(),
    };
  } finally {
    if (!keepWorkDirs) {
      await rm(workDir, { force: true, recursive: true });
    }
  }
}

function applyCandidate(editor, candidate, batchId, index) {
  if (candidate.operationType === "MARK_SUSPICIOUS") {
    return { applied: false, reason: "mark-only" };
  }

  const metadata = {
    operationType: "APPLY_SUGGESTION",
    source: "auto-suggested",
    reason: candidate.reason,
    batchId,
    targetIndex: index,
    metricsBefore: {
      localCorrelation: candidate.currentCorrelation,
      segmentStartYear: candidate.segmentStartYear,
      segmentEndYear: candidate.segmentEndYear,
      candidateYear: candidate.targetYear ?? null,
    },
    metricsAfter: {
      expectedCorrelation: candidate.expectedCorrelation,
      delta: candidate.delta ?? null,
      suggestedLag: candidate.suggestedLag,
      confidence: candidate.confidence,
      operation: candidate.operationType,
    },
  };

  if (candidate.operationType === "SHIFT_RANGE") {
    const shift = candidate.shift ?? candidate.suggestedLag;
    if (shift === 0) return { applied: false, reason: "zero-shift" };
    const startYear = candidate.targetYear ?? candidate.segmentStartYear;
    editor.moveSeriesTailByOffset(candidate.targetTree, startYear, candidate.segmentEndYear, shift, metadata);
    return { applied: true };
  }

  if (candidate.operationType === "INSERT_MISSING_RING" && candidate.targetYear !== undefined && candidate.side) {
    editor.insertMissingYearAtSide(candidate.targetTree, candidate.targetYear, candidate.side, metadata);
    return { applied: true };
  }

  if (candidate.operationType === "DELETE_FALSE_RING" && candidate.targetYear !== undefined && candidate.side) {
    editor.deleteYearWithMode(candidate.targetTree, candidate.targetYear, "direct", candidate.side, metadata);
    return { applied: true };
  }

  return { applied: false, reason: "incomplete-candidate" };
}

async function main() {
  if (!existsSync(sampleRoot)) {
    throw new Error(`Sample root not found: ${sampleRoot}`);
  }
  if (!existsSync(sidecarPath)) {
    throw new Error(`COFECHA sidecar not found: ${sidecarPath}`);
  }

  const server = await createServer({
    configFile: false,
    appType: "custom",
    logLevel: "error",
    resolve: {
      alias: {
        "@": path.join(process.cwd(), "src"),
      },
    },
    optimizeDeps: { noDiscovery: true },
    server: { hmr: { port: 20_000 + Math.floor(Math.random() * 20_000) }, middlewareMode: true },
  });

  try {
    const rwlModule = await server.ssrLoadModule("/src/features/rwl/index.ts");
    const editModule = await server.ssrLoadModule("/src/features/rwl/edit.ts");
    const diagnosisModule = await server.ssrLoadModule("/src/features/crossdating/diagnosis.ts");
    const formatter = await server.ssrLoadModule("/src/features/cofecha/formatter.ts");

    const samples = await listRawSamples(sampleRoot);
    if (samples.length === 0) {
      throw new Error(`No RAW.rwl samples found under ${sampleRoot}`);
    }

    const rows = [];
    for (const sample of samples) {
      const rawText = await readFile(sample.rawPath, "utf8");
      const baseline = await runCofechaForText(rawText, sample.name, "baseline", formatter.parseCofechaResult);
      const readResult = await rwlModule.readRwlString(rawText);
      const editor = new editModule.RwlEditor(readResult.data, readResult.readOptions, readResult.format);
      const beforeDiagnosis = diagnosisModule.diagnoseCrossdating(editor.getData());
      const actionableCandidate = diagnosisModule.isActionableDiagnosisCandidate ?? isActionableCandidate;
      const requestedCandidates = beforeDiagnosis.candidates
        .filter(actionableCandidate)
        .slice(0, maxCandidates);
      const batchSelection = diagnosisModule.selectSafeDiagnosisCandidateBatch(requestedCandidates);
      const candidates = batchSelection.selected;

      const batchId = `auto-trial-${sample.name}-${Date.now()}`;
      const applied = [];
      const skipped = batchSelection.skipped.map((result) => ({
        result,
        reason: result.reason ?? "skipped",
      }));
      candidates.forEach((candidate, index) => {
        const result = applyCandidate(editor, candidate, batchId, index + 1);
        if (result.applied) {
          applied.push(candidate);
        } else {
          skipped.push({ candidate, reason: result.reason });
        }
      });

      const afterDiagnosis = diagnosisModule.diagnoseCrossdating(editor.getData());
      const trialText = editor.exportAsRwlString();
      const trial = await runCofechaForText(trialText, sample.name, "trial", formatter.parseCofechaResult);

      rows.push({
        sample: sample.name,
        baseline,
        trial,
        beforeDiagnosis,
        afterDiagnosis,
        selected: requestedCandidates.length,
        safeSelected: candidates.length,
        applied,
        skipped,
      });
    }

    console.log(`Sample root: ${sampleRoot}`);
    console.log(`COFECHA version: ${version}`);
    console.log(`Max candidates per site: ${maxCandidates}`);
    console.log("Safe batch mode: one candidate per series per pass.");
    console.log("");
    console.log("site  base A  trial A  delta  internal before->after  applied/requested  top applied");
    console.log("----  ------  -------  -----  ----------------------  ----------------  -----------");
    rows.forEach((row) => {
      const delta = row.trial.possibleProblemsCount - row.baseline.possibleProblemsCount;
      const topApplied = row.applied
        .slice(0, 3)
        .map((candidate) => `${candidate.targetTree}:${candidateLabel(candidate)}`)
        .join("; ") || "-";
      console.log(
        `${row.sample.padEnd(4)}  ${String(row.baseline.possibleProblemsCount).padStart(6)}  ${String(row.trial.possibleProblemsCount).padStart(7)}  ${String(delta).padStart(5)}  ${String(row.beforeDiagnosis.problemSegmentCount).padStart(4)} -> ${String(row.afterDiagnosis.problemSegmentCount).padEnd(4)}          ${String(row.applied.length).padStart(2)} / ${String(row.selected).padEnd(2)}          ${topApplied}`,
      );
    });

    const improved = rows.filter((row) => row.trial.possibleProblemsCount < row.baseline.possibleProblemsCount).length;
    const worsened = rows.filter((row) => row.trial.possibleProblemsCount > row.baseline.possibleProblemsCount).length;
    console.log("");
    console.log(`COFECHA A/problem improved on ${improved}/${rows.length}, worsened on ${worsened}/${rows.length}.`);
    if (worsened > 0) {
      console.log("This trial is advisory only; source RWL files were not modified.");
      process.exitCode = 1;
    }
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
