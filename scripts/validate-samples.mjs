import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

const strictInternal = process.argv.includes("--strict-internal");
const explicitRoot = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const defaultSampleRoots = [
  process.env.CROSSDATING_SAMPLE_ROOT,
  "D:/软件测试/数据",
  path.join(process.cwd(), "笔记", "数据"),
].filter(Boolean);
const sampleRoot = explicitRoot
  ? path.resolve(process.cwd(), explicitRoot)
  : defaultSampleRoots.find((candidate) => existsSync(candidate))
    ?? defaultSampleRoots[defaultSampleRoots.length - 1];

const formatCount = (value) => String(value).padStart(4, " ");

async function listSamplePairs(root) {
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
    .filter((sample) => existsSync(sample.rawPath) || existsSync(sample.crossdatedPath))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function analyzeFile(filePath, modules) {
  const text = await readFile(filePath, "utf8");
  const result = await modules.readRwlString(text);
  const diagnosis = modules.diagnoseCrossdating(result.data);
  const summary = modules.buildCrossdatingValidationSummary({
    hasData: result.data.size > 0,
    isCofechaRunning: false,
    isCofechaOutdated: false,
    cofechaPossibleProblemsCount: undefined,
    internalProblemSegmentCount: diagnosis.problemSegmentCount,
    internalCandidateCount: diagnosis.candidateCount,
    batchResult: null,
  });

  return {
    seriesCount: result.data.size,
    format: result.format,
    problemSegmentCount: diagnosis.problemSegmentCount,
    candidateCount: diagnosis.candidateCount,
    problemTrees: diagnosis.summaries
      .filter((summary) => summary.flaggedSegmentCount > 0)
      .sort((a, b) => b.flaggedSegmentCount - a.flaggedSegmentCount)
      .slice(0, 5)
      .map((summary) => ({
        tree: summary.tree,
        flaggedSegmentCount: summary.flaggedSegmentCount,
        candidateCount: summary.candidateCount,
        worstCorrelation: summary.worstCorrelation,
      })),
    status: summary.status,
    title: summary.title,
  };
}

async function main() {
  if (!existsSync(sampleRoot)) {
    throw new Error(`Sample root not found: ${sampleRoot}`);
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
    const diagnosisModule = await server.ssrLoadModule("/src/features/crossdating/diagnosis.ts");
    const validationModule = await server.ssrLoadModule("/src/features/crossdating/validation.ts");
    const modules = {
      readRwlString: rwlModule.readRwlString,
      diagnoseCrossdating: diagnosisModule.diagnoseCrossdating,
      buildCrossdatingValidationSummary: validationModule.buildCrossdatingValidationSummary,
    };

    const samples = await listSamplePairs(sampleRoot);
    if (samples.length === 0) {
      throw new Error(`No RAW/crossdated RWL sample pairs found under ${sampleRoot}`);
    }

    const failures = [];
    const rows = [];

    for (const sample of samples) {
      const raw = existsSync(sample.rawPath)
        ? await analyzeFile(sample.rawPath, modules)
        : null;
      const crossdated = existsSync(sample.crossdatedPath)
        ? await analyzeFile(sample.crossdatedPath, modules)
        : null;

      if (!raw && !crossdated) {
        failures.push(`${sample.name}: no readable RAW.rwl or crossdated.rwl`);
        continue;
      }

      if (strictInternal && crossdated && crossdated.problemSegmentCount > 0) {
        const problemTrees = crossdated.problemTrees
          .map((tree) => {
            const worst = tree.worstCorrelation === null ? "n/a" : tree.worstCorrelation.toFixed(2);
            return `${tree.tree}(${tree.flaggedSegmentCount}段,候选${tree.candidateCount},worst ${worst})`;
          })
          .join("; ");
        failures.push(`${sample.name}: crossdated internal problems=${crossdated.problemSegmentCount}${problemTrees ? `; ${problemTrees}` : ""}`);
      }

      rows.push({ sample, raw, crossdated });
    }

    console.log(`Sample root: ${sampleRoot}`);
    console.log(`Strict internal gate: ${strictInternal ? "on" : "off"}`);
    console.log("");
    console.log("site  raw problems/candidates  crossdated problems/candidates  delta");
    console.log("----  -----------------------  ------------------------------  -----");

    for (const { sample, raw, crossdated } of rows) {
      const rawText = raw
        ? `${formatCount(raw.problemSegmentCount)} / ${formatCount(raw.candidateCount)}`
        : "missing";
      const crossdatedText = crossdated
        ? `${formatCount(crossdated.problemSegmentCount)} / ${formatCount(crossdated.candidateCount)}`
        : "missing";
      const delta = raw && crossdated
        ? crossdated.problemSegmentCount - raw.problemSegmentCount
        : null;
      console.log(
        `${sample.name.padEnd(4)}  ${rawText.padEnd(23)}  ${crossdatedText.padEnd(30)}  ${delta === null ? "-" : delta}`,
      );
    }

    if (failures.length > 0) {
      console.log("");
      console.error("Validation failures:");
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
