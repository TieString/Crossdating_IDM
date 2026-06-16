import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";

const args = process.argv.slice(2);
const includeRaw = args.includes("--include-raw");
const keepWorkDirs = args.includes("--keep-workdirs");
const versionArg = args.find((arg) => arg.startsWith("--version="));
const version = versionArg?.split("=")[1] === "cofecha12k" ? "cofecha12k" : "cofecha";
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

async function listSamples(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const folder = path.join(root, entry.name);
      return {
        name: entry.name,
        rawPath: path.join(folder, "RAW.rwl"),
        crossdatedPath: path.join(folder, "crossdated.rwl"),
      };
    })
    .filter((sample) => existsSync(sample.crossdatedPath) || (includeRaw && existsSync(sample.rawPath)))
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

async function runCofechaForFile(filePath, sampleName, label, parseCofechaResult) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), `crossdating-cofecha-${sampleName}-${label}-`));
  const inputName = "INPUT.RWL";
  const inputPath = path.join(workDir, inputName);
  const outPath = path.join(workDir, "VERYCOF.OUT");

  try {
    await cp(filePath, inputPath);
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
      label,
      workDir,
      possibleProblemsCount: result.possibleProblemsCount,
      seriesIntercorrelation: result.seriesIntercorrelation,
      meanLength: result.meanLength,
      problemSeries: Array.from(result.possibleProblemsDetail.keys()).sort(),
    };
  } finally {
    if (!keepWorkDirs) {
      await rm(workDir, { force: true, recursive: true });
    } else {
      await writeFile(path.join(workDir, "SOURCE.txt"), filePath, "utf8");
    }
  }
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
    const formatter = await server.ssrLoadModule("/src/features/cofecha/formatter.ts");
    const samples = await listSamples(sampleRoot);
    const failures = [];
    const rows = [];

    for (const sample of samples) {
      const targets = [
        includeRaw && existsSync(sample.rawPath) ? { label: "RAW", path: sample.rawPath } : null,
        existsSync(sample.crossdatedPath) ? { label: "crossdated", path: sample.crossdatedPath } : null,
      ].filter(Boolean);

      for (const target of targets) {
        const result = await runCofechaForFile(target.path, sample.name, target.label, formatter.parseCofechaResult);
        rows.push({ sample: sample.name, ...result });
        if (target.label === "crossdated" && result.possibleProblemsCount !== 0) {
          failures.push(`${sample.name}: A/problem=${result.possibleProblemsCount}; series=${result.problemSeries.join(", ") || "n/a"}`);
        }
      }
    }

    console.log(`Sample root: ${sampleRoot}`);
    console.log(`COFECHA version: ${version}`);
    console.log(`Targets: ${includeRaw ? "RAW + crossdated" : "crossdated"}`);
    console.log("");
    console.log("site  target       A/problem  intercorr.  mean length  problem series");
    console.log("----  -----------  ---------  ---------  -----------  --------------");
    for (const row of rows) {
      console.log(
        `${row.sample.padEnd(4)}  ${row.label.padEnd(11)}  ${String(row.possibleProblemsCount).padStart(9)}  ${String(row.seriesIntercorrelation).padStart(9)}  ${String(row.meanLength).padStart(11)}  ${row.problemSeries.join(", ") || "-"}`,
      );
    }

    if (failures.length > 0) {
      console.log("");
      console.error("COFECHA validation failures:");
      failures.forEach((failure) => console.error(`- ${failure}`));
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
